/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "gfxDrawable.h"
#include "gfxPlatform.h"
#include "gfxUtils.h"

#include "ClippedImage.h"

using mozilla::layers::LayerManager;
using mozilla::layers::ImageContainer;

namespace mozilla {
namespace image {

class DrawSingleTileCallback : public gfxDrawingCallback
{
public:
  DrawSingleTileCallback(ClippedImage* aImage,
                         const nsIntRect& aClip,
                         const nsIntSize& aViewportSize,
                         const SVGImageContext* aSVGContext,
                         uint32_t aWhichFrame,
                         uint32_t aFlags)
    : mImage(aImage)
    , mClip(aClip)
    , mViewportSize(aViewportSize)
    , mSVGContext(aSVGContext)
    , mWhichFrame(aWhichFrame)
    , mFlags(aFlags)
  {
    MOZ_ASSERT(mImage, "Must have an image to clip");
  }

  virtual bool operator()(gfxContext* aContext,
                          const gfxRect& aFillRect,
                          const gfxPattern::GraphicsFilter& aFilter,
                          const gfxMatrix& aTransform)
  {
    // Draw the image. |gfxCallbackDrawable| always calls this function with
    // arguments that guarantee we never tile.
    mImage->DrawSingleTile(aContext, aFilter, aTransform, aFillRect, mClip,
                           mViewportSize, mSVGContext, mWhichFrame, mFlags);

    return true;
  }

private:
  nsRefPtr<ClippedImage> mImage;
  const nsIntRect        mClip;
  const nsIntSize        mViewportSize;
  const SVGImageContext* mSVGContext;
  const uint32_t         mWhichFrame;
  const uint32_t         mFlags;
};

ClippedImage::ClippedImage(Image* aImage,
                           nsIntRect aClip)
  : ImageWrapper(aImage)
  , mClip(aClip)
{
  MOZ_ASSERT(aImage != nullptr, "ClippedImage requires an existing Image");
}

bool
ClippedImage::ShouldClip()
{
  // We need to evaluate the clipping region against the image's width and height
  // once they're available to determine if it's valid and whether we actually
  // need to do any work. We may fail if the image's width and height aren't
  // available yet, in which case we'll try again later.
  if (mShouldClip.empty()) {
    int32_t width, height;
    if (InnerImage()->HasError()) {
      // If there's a problem with the inner image we'll let it handle everything.
      mShouldClip.construct(false);
    } else if (NS_SUCCEEDED(InnerImage()->GetWidth(&width)) && width > 0 &&
               NS_SUCCEEDED(InnerImage()->GetHeight(&height)) && height > 0) {
      // Clamp the clipping region to the size of the underlying image.
      mClip = mClip.Intersect(nsIntRect(0, 0, width, height));

      // If the clipping region is the same size as the underlying image we
      // don't have to do anything.
      mShouldClip.construct(!mClip.IsEqualInterior(nsIntRect(0, 0, width, height)));
    } else if (InnerImage()->GetStatusTracker().IsLoading()) {
      // The image just hasn't finished loading yet. We don't yet know whether
      // clipping with be needed or not for now. Just return without memoizing
      // anything.
      return false;
    } else {
      // We have a fully loaded image without a clearly defined width and
      // height. This can happen with SVG images.
      mShouldClip.construct(false);
    }
  }

  MOZ_ASSERT(!mShouldClip.empty(), "Should have computed a result");
  return mShouldClip.ref();
}

NS_IMPL_ISUPPORTS1(ClippedImage, imgIContainer)

nsIntRect
ClippedImage::FrameRect(uint32_t aWhichFrame)
{
  if (!ShouldClip()) {
    return InnerImage()->FrameRect(aWhichFrame);
  }

  return nsIntRect(0, 0, mClip.width, mClip.height);
}

NS_IMETHODIMP
ClippedImage::GetWidth(int32_t* aWidth)
{
  if (!ShouldClip()) {
    return InnerImage()->GetWidth(aWidth);
  }

  *aWidth = mClip.width;
  return NS_OK;
}

NS_IMETHODIMP
ClippedImage::GetHeight(int32_t* aHeight)
{
  if (!ShouldClip()) {
    return InnerImage()->GetHeight(aHeight);
  }

  *aHeight = mClip.height;
  return NS_OK;
}

NS_IMETHODIMP
ClippedImage::GetIntrinsicSize(nsSize* aSize)
{
  if (!ShouldClip()) {
    return InnerImage()->GetIntrinsicSize(aSize);
  }

  *aSize = nsSize(mClip.width, mClip.height);
  return NS_OK;
}

NS_IMETHODIMP
ClippedImage::GetIntrinsicRatio(nsSize* aRatio)
{
  if (!ShouldClip()) {
    return InnerImage()->GetIntrinsicRatio(aRatio);
  }

  *aRatio = nsSize(mClip.width, mClip.height);
  return NS_OK;
}

NS_IMETHODIMP
ClippedImage::GetFrame(uint32_t aWhichFrame,
                       uint32_t aFlags,
                       gfxASurface** _retval)
{
  if (!ShouldClip()) {
    return InnerImage()->GetFrame(aWhichFrame, aFlags, _retval);
  }

  // Create a surface to draw into.
  gfxImageSurface::gfxImageFormat format = gfxASurface::ImageFormatARGB32;
  nsRefPtr<gfxASurface> surface = gfxPlatform::GetPlatform()
    ->CreateOffscreenSurface(gfxIntSize(mClip.width, mClip.height),
                             gfxImageSurface::ContentFromFormat(format));
  // Create our callback.
  nsRefPtr<gfxDrawingCallback> drawTileCallback =
    new DrawSingleTileCallback(this, mClip, mClip.Size(), nullptr, aWhichFrame, aFlags);
  nsRefPtr<gfxDrawable> drawable =
    new gfxCallbackDrawable(drawTileCallback, mClip.Size());

  // Actually draw. The callback will end up invoking DrawSingleTile.
  nsRefPtr<gfxContext> ctx = new gfxContext(surface);
  gfxRect imageRect(0, 0, mClip.width, mClip.height);
  gfxUtils::DrawPixelSnapped(ctx, drawable, gfxMatrix(),
                             imageRect, imageRect, imageRect, imageRect,
                             gfxASurface::ImageFormatARGB32, gfxPattern::FILTER_FAST);

  *_retval = surface.forget().get();
  return NS_OK;
}

NS_IMETHODIMP
ClippedImage::GetImageContainer(LayerManager* aManager, ImageContainer** _retval)
{
  // XXX(seth): We currently don't have a way of clipping the result of
  // GetImageContainer. We work around this by always returning null, but if it
  // ever turns out that ClippedImage is widely used on codepaths that can
  // actually benefit from GetImageContainer, it would be a good idea to fix
  // that method for performance reasons.

  *_retval = nullptr;
  return NS_OK;
}

NS_IMETHODIMP
ClippedImage::ExtractFrame(uint32_t /* aWhichFrame */,
                           const nsIntRect& /* aRegion */,
                           uint32_t /* aFlags */,
                           imgIContainer** /* _retval */)
{
  // XXX(seth): This method has to be present in this patch because we haven't
  // gotten to the point where we can remove ExtractFrame yet, but implementing
  // it would be a waste of effort.
  MOZ_ASSERT(false, "ClippedImage::ExtractFrame shouldn't be called");
  return NS_ERROR_NOT_AVAILABLE;
}

bool
ClippedImage::WillTile(const gfxRect& aSourceRect,
                       const uint32_t aFlags) const
{
  return !gfxRect(0, 0, mClip.width, mClip.height).Contains(aSourceRect) &&
         !(aFlags & imgIContainer::FLAG_CLAMP);
}

NS_IMETHODIMP
ClippedImage::Draw(gfxContext* aContext,
                   gfxPattern::GraphicsFilter aFilter,
                   const gfxMatrix& aUserSpaceToImageSpace,
                   const gfxRect& aFill,
                   const nsIntRect& aSubimage,
                   const nsIntSize& aViewportSize,
                   const SVGImageContext* aSVGContext,
                   uint32_t aWhichFrame,
                   uint32_t aFlags)
{
  if (!ShouldClip()) {
    return InnerImage()->Draw(aContext, aFilter, aUserSpaceToImageSpace,
                              aFill, aSubimage, aViewportSize, aSVGContext,
                              aWhichFrame, aFlags);
  }

  // Check for tiling. If we need to tile then we need to create a
  // gfxCallbackDrawable to handle drawing for us.
  gfxRect sourceRect = aUserSpaceToImageSpace.Transform(aFill);
  if (WillTile(sourceRect, aFlags)) {
    // Create a temporary surface containing a single tile of this image.
    // GetFrame will call DrawSingleTile internally.
    nsRefPtr<gfxASurface> surface;
    GetFrame(aWhichFrame, aFlags, getter_AddRefs(surface));
    NS_ENSURE_TRUE(surface, NS_ERROR_FAILURE);

    // Create a drawable from that surface.
    nsRefPtr<gfxSurfaceDrawable> drawable =
      new gfxSurfaceDrawable(surface, gfxIntSize(mClip.width, mClip.height));

    // Draw.
    gfxRect imageRect(0, 0, mClip.width, mClip.height);
    gfxRect subimage(aSubimage.x, aSubimage.y, aSubimage.width, aSubimage.height);
    gfxUtils::DrawPixelSnapped(aContext, drawable, aUserSpaceToImageSpace,
                               subimage, sourceRect, imageRect, aFill,
                               gfxASurface::ImageFormatARGB32, aFilter);

    return NS_OK;
  }

  nsIntRect subimage(aSubimage);
  subimage.MoveBy(mClip.x, mClip.y);
  subimage.Intersect(mClip);

  return DrawSingleTile(aContext, aFilter, aUserSpaceToImageSpace, aFill, subimage,
                        aViewportSize, aSVGContext, aWhichFrame, aFlags);
}

gfxFloat
ClippedImage::ClampFactor(const gfxFloat aToClamp, const int aReference) const
{
  return aToClamp > aReference ? aReference / aToClamp
                               : 1.0;
}

nsresult
ClippedImage::DrawSingleTile(gfxContext* aContext,
                             gfxPattern::GraphicsFilter aFilter,
                             const gfxMatrix& aUserSpaceToImageSpace,
                             const gfxRect& aFill,
                             const nsIntRect& aSubimage,
                             const nsIntSize& aViewportSize,
                             const SVGImageContext* aSVGContext,
                             uint32_t aWhichFrame,
                             uint32_t aFlags)
{
  MOZ_ASSERT(!WillTile(aUserSpaceToImageSpace.Transform(aFill), aFlags),
             "DrawSingleTile shouldn't get a transform requiring tiling");

  // Make the viewport reflect the original image's size.
  nsIntSize viewportSize(aViewportSize);
  int32_t imgWidth, imgHeight;
  if (NS_SUCCEEDED(InnerImage()->GetWidth(&imgWidth)) &&
      NS_SUCCEEDED(InnerImage()->GetHeight(&imgHeight))) {
    viewportSize = nsIntSize(imgWidth, imgHeight);
  } else {
    MOZ_ASSERT(false, "If ShouldClip() led us to draw then we should never get here");
  }

  // Add a translation to the transform to reflect the clipping region.
  gfxMatrix transform(aUserSpaceToImageSpace);
  transform.Multiply(gfxMatrix().Translate(gfxPoint(mClip.x, mClip.y)));

  // "Clamp the source rectangle" to the clipping region's width and height.
  // Really, this means modifying the transform to get the results we want.
  gfxRect sourceRect = transform.Transform(aFill);
  if (sourceRect.width > mClip.width || sourceRect.height > mClip.height) {
    gfxMatrix clampSource;
    clampSource.Translate(gfxPoint(sourceRect.x, sourceRect.y));
    clampSource.Scale(ClampFactor(sourceRect.width, mClip.width),
                      ClampFactor(sourceRect.height, mClip.height));
    clampSource.Translate(gfxPoint(-sourceRect.x, -sourceRect.y));
    transform.Multiply(clampSource);
  }

  return InnerImage()->Draw(aContext, aFilter, transform, aFill, aSubimage,
                            viewportSize, aSVGContext, aWhichFrame, aFlags);
}

} // namespace image
} // namespace mozilla
