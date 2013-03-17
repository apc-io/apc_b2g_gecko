/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "VectorImage.h"

#include <algorithm>

#include "gfxContext.h"
#include "gfxDrawable.h"
#include "gfxPlatform.h"
#include "gfxUtils.h"
#include "imgDecoderObserver.h"
#include "mozilla/AutoRestore.h"
#include "mozilla/dom/SVGSVGElement.h"
#include "nsComponentManagerUtils.h"
#include "nsIObserverService.h"
#include "nsIPresShell.h"
#include "nsIStreamListener.h"
#include "nsMimeTypes.h"
#include "nsPresContext.h"
#include "nsRect.h"
#include "nsServiceManagerUtils.h"
#include "nsStubDocumentObserver.h"
#include "nsSVGEffects.h" // for nsSVGRenderingObserver
#include "nsSVGUtils.h"  // for nsSVGUtils::ConvertToSurfaceSize
#include "SVGDocumentWrapper.h"

namespace mozilla {

using namespace dom;
using namespace layers;

namespace image {

// Helper-class: SVGRootRenderingObserver
class SVGRootRenderingObserver MOZ_FINAL : public nsSVGRenderingObserver {
public:
  SVGRootRenderingObserver(SVGDocumentWrapper* aDocWrapper,
                           VectorImage*        aVectorImage)
    : nsSVGRenderingObserver(),
      mDocWrapper(aDocWrapper),
      mVectorImage(aVectorImage)
  {
    MOZ_ASSERT(mDocWrapper, "Need a non-null SVG document wrapper");
    MOZ_ASSERT(mVectorImage, "Need a non-null VectorImage");

    StartListening();
    Element* elem = GetTarget();
    MOZ_ASSERT(elem, "no root SVG node for us to observe");

    nsSVGEffects::AddRenderingObserver(elem, this);
    mInObserverList = true;
  }

  void ResumeListening()
  {
    // GetReferencedElement adds us back to our target's observer list.
    GetReferencedElement();
  }

  virtual ~SVGRootRenderingObserver()
  {
    StopListening();
  }

protected:
  virtual Element* GetTarget() MOZ_OVERRIDE
  {
    return mDocWrapper->GetRootSVGElem();
  }

  virtual void DoUpdate() MOZ_OVERRIDE
  {
    Element* elem = GetTarget();
    MOZ_ASSERT(elem, "missing root SVG node");

    if (!mDocWrapper->ShouldIgnoreInvalidation()) {
      nsIFrame* frame = elem->GetPrimaryFrame();
      if (!frame || frame->PresContext()->PresShell()->IsDestroying()) {
        // We're being destroyed. Bail out.
        return;
      }

      mVectorImage->InvalidateObserver();
    }

    // We may have been removed from the observer list by our caller. Rather
    // than add ourselves back here, we wait until Draw gets called, ensuring
    // that we coalesce invalidations between Draw calls.
  }

  // Private data
  const nsRefPtr<SVGDocumentWrapper> mDocWrapper;
  VectorImage* const mVectorImage;   // Raw pointer because it owns me.
};

class SVGParseCompleteListener MOZ_FINAL : public nsStubDocumentObserver {
public:
  NS_DECL_ISUPPORTS

  SVGParseCompleteListener(nsIDocument* aDocument,
                           VectorImage* aImage)
    : mDocument(aDocument)
    , mImage(aImage)
  {
    MOZ_ASSERT(mDocument, "Need an SVG document");
    MOZ_ASSERT(mImage, "Need an image");

    mDocument->AddObserver(this);
  }

  ~SVGParseCompleteListener()
  { 
    if (mDocument) {
      // The document must have been destroyed before we got our event.
      // Otherwise this can't happen, since documents hold strong references to
      // their observers.
      Cancel();
    }
  }

  void EndLoad(nsIDocument* aDocument) MOZ_OVERRIDE
  {
    MOZ_ASSERT(aDocument == mDocument, "Got EndLoad for wrong document?");

    // OnSVGDocumentParsed will release our owner's reference to us, so ensure
    // we stick around long enough to complete our work.
    nsRefPtr<SVGParseCompleteListener> kungFuDeathGroup(this);

    mImage->OnSVGDocumentParsed();
  }

  void Cancel()
  {
    MOZ_ASSERT(mDocument, "Duplicate call to Cancel");
    if (mDocument) {
      mDocument->RemoveObserver(this);
      mDocument = nullptr;
    }
  }

private:
  nsCOMPtr<nsIDocument> mDocument;
  VectorImage* const mImage; // Raw pointer to owner.
};

NS_IMPL_ISUPPORTS1(SVGParseCompleteListener, nsIDocumentObserver)

class SVGLoadEventListener MOZ_FINAL : public nsIDOMEventListener {
public:
  NS_DECL_ISUPPORTS

  SVGLoadEventListener(nsIDocument* aDocument,
                       VectorImage* aImage)
    : mDocument(aDocument)
    , mImage(aImage)
  {
    MOZ_ASSERT(mDocument, "Need an SVG document");
    MOZ_ASSERT(mImage, "Need an image");

    mDocument->AddEventListener(NS_LITERAL_STRING("MozSVGAsImageDocumentLoad"), this, true, false);
    mDocument->AddEventListener(NS_LITERAL_STRING("SVGAbort"), this, true, false);
    mDocument->AddEventListener(NS_LITERAL_STRING("SVGError"), this, true, false);
  }

  ~SVGLoadEventListener()
  {
    if (mDocument) {
      // The document must have been destroyed before we got our event.
      // Otherwise this can't happen, since documents hold strong references to
      // their observers.
      Cancel();
    }
  }

  NS_IMETHOD HandleEvent(nsIDOMEvent* aEvent) MOZ_OVERRIDE
  {
    MOZ_ASSERT(mDocument, "Need an SVG document. Received multiple events?");

    // OnSVGDocumentLoaded/OnSVGDocumentError will release our owner's reference
    // to us, so ensure we stick around long enough to complete our work.
    nsRefPtr<SVGLoadEventListener> kungFuDeathGroup(this);

    nsAutoString eventType;
    aEvent->GetType(eventType);
    MOZ_ASSERT(eventType.EqualsLiteral("MozSVGAsImageDocumentLoad")  ||
               eventType.EqualsLiteral("SVGAbort")                   ||
               eventType.EqualsLiteral("SVGError"),
               "Received unexpected event");

    if (eventType.EqualsLiteral("MozSVGAsImageDocumentLoad")) {
      mImage->OnSVGDocumentLoaded();
    } else {
      mImage->OnSVGDocumentError();
    }

    return NS_OK;
  }

  void Cancel()
  {
    MOZ_ASSERT(mDocument, "Duplicate call to Cancel");
    if (mDocument) {
      mDocument->RemoveEventListener(NS_LITERAL_STRING("MozSVGAsImageDocumentLoad"), this, true);
      mDocument->RemoveEventListener(NS_LITERAL_STRING("SVGAbort"), this, true);
      mDocument->RemoveEventListener(NS_LITERAL_STRING("SVGError"), this, true);
      mDocument = nullptr;
    }
  }

private:
  nsCOMPtr<nsIDocument> mDocument;
  VectorImage* const mImage; // Raw pointer to owner.
};

NS_IMPL_ISUPPORTS1(SVGLoadEventListener, nsIDOMEventListener)

// Helper-class: SVGDrawingCallback
class SVGDrawingCallback : public gfxDrawingCallback {
public:
  SVGDrawingCallback(SVGDocumentWrapper* aSVGDocumentWrapper,
                     const nsIntRect& aViewport,
                     uint32_t aImageFlags) :
    mSVGDocumentWrapper(aSVGDocumentWrapper),
    mViewport(aViewport),
    mImageFlags(aImageFlags)
  {}
  virtual bool operator()(gfxContext* aContext,
                            const gfxRect& aFillRect,
                            const gfxPattern::GraphicsFilter& aFilter,
                            const gfxMatrix& aTransform);
private:
  nsRefPtr<SVGDocumentWrapper> mSVGDocumentWrapper;
  const nsIntRect mViewport;
  uint32_t        mImageFlags;
};

// Based loosely on nsSVGIntegrationUtils' PaintFrameCallback::operator()
bool
SVGDrawingCallback::operator()(gfxContext* aContext,
                               const gfxRect& aFillRect,
                               const gfxPattern::GraphicsFilter& aFilter,
                               const gfxMatrix& aTransform)
{
  MOZ_ASSERT(mSVGDocumentWrapper, "need an SVGDocumentWrapper");

  // Get (& sanity-check) the helper-doc's presShell
  nsCOMPtr<nsIPresShell> presShell;
  if (NS_FAILED(mSVGDocumentWrapper->GetPresShell(getter_AddRefs(presShell)))) {
    NS_WARNING("Unable to draw -- presShell lookup failed");
    return false;
  }
  MOZ_ASSERT(presShell, "GetPresShell succeeded but returned null");

  gfxContextAutoSaveRestore contextRestorer(aContext);

  // Clip to aFillRect so that we don't paint outside.
  aContext->NewPath();
  aContext->Rectangle(aFillRect);
  aContext->Clip();

  gfxContextMatrixAutoSaveRestore contextMatrixRestorer(aContext);
  aContext->Multiply(gfxMatrix(aTransform).Invert());

  nsPresContext* presContext = presShell->GetPresContext();
  MOZ_ASSERT(presContext, "pres shell w/out pres context");

  nsRect svgRect(presContext->DevPixelsToAppUnits(mViewport.x),
                 presContext->DevPixelsToAppUnits(mViewport.y),
                 presContext->DevPixelsToAppUnits(mViewport.width),
                 presContext->DevPixelsToAppUnits(mViewport.height));

  uint32_t renderDocFlags = nsIPresShell::RENDER_IGNORE_VIEWPORT_SCROLLING;
  if (!(mImageFlags & imgIContainer::FLAG_SYNC_DECODE)) {
    renderDocFlags |= nsIPresShell::RENDER_ASYNC_DECODE_IMAGES;
  }

  presShell->RenderDocument(svgRect, renderDocFlags,
                            NS_RGBA(0, 0, 0, 0), // transparent
                            aContext);

  return true;
}

// Implement VectorImage's nsISupports-inherited methods
NS_IMPL_ISUPPORTS3(VectorImage,
                   imgIContainer,
                   nsIStreamListener,
                   nsIRequestObserver)

//------------------------------------------------------------------------------
// Constructor / Destructor

VectorImage::VectorImage(imgStatusTracker* aStatusTracker,
                         nsIURI* aURI /* = nullptr */) :
  ImageResource(aStatusTracker, aURI), // invoke superclass's constructor
  mRestrictedRegion(0, 0, 0, 0),
  mIsInitialized(false),
  mIsFullyLoaded(false),
  mIsDrawing(false),
  mHaveAnimations(false),
  mHaveRestrictedRegion(false)
{
}

VectorImage::~VectorImage()
{
  CancelAllListeners();
}

//------------------------------------------------------------------------------
// Methods inherited from Image.h

nsresult
VectorImage::Init(const char* aMimeType,
                  uint32_t aFlags)
{
  // We don't support re-initialization
  if (mIsInitialized)
    return NS_ERROR_ILLEGAL_VALUE;

  MOZ_ASSERT(!mIsFullyLoaded && !mHaveAnimations &&
             !mHaveRestrictedRegion && !mError,
             "Flags unexpectedly set before initialization");
  MOZ_ASSERT(!strcmp(aMimeType, IMAGE_SVG_XML), "Unexpected mimetype");

  mIsInitialized = true;
  return NS_OK;
}

nsIntRect
VectorImage::FrameRect(uint32_t aWhichFrame)
{
  return nsIntRect::GetMaxSizedIntRect();
}

size_t
VectorImage::HeapSizeOfSourceWithComputedFallback(nsMallocSizeOfFun aMallocSizeOf) const
{
  // We're not storing the source data -- we just feed that directly to
  // our helper SVG document as we receive it, for it to parse.
  // So 0 is an appropriate return value here.
  return 0;
}

size_t
VectorImage::HeapSizeOfDecodedWithComputedFallback(nsMallocSizeOfFun aMallocSizeOf) const
{
  // XXXdholbert TODO: return num bytes used by helper SVG doc. (bug 590790)
  return 0;
}

size_t
VectorImage::NonHeapSizeOfDecoded() const
{
  return 0;
}

size_t
VectorImage::OutOfProcessSizeOfDecoded() const
{
  return 0;
}

nsresult
VectorImage::OnImageDataComplete(nsIRequest* aRequest,
                                 nsISupports* aContext,
                                 nsresult aStatus,
                                 bool aLastPart)
{
  // Call our internal OnStopRequest method, which only talks to our embedded
  // SVG document. This won't have any effect on our imgStatusTracker.
  nsresult finalStatus = OnStopRequest(aRequest, aContext, aStatus);

  // Give precedence to Necko failure codes.
  if (NS_FAILED(aStatus))
    finalStatus = aStatus;

  // Actually fire OnStopRequest.
  GetStatusTracker().OnStopRequest(aLastPart, finalStatus);
  return finalStatus;
}

nsresult
VectorImage::OnImageDataAvailable(nsIRequest* aRequest,
                                  nsISupports* aContext,
                                  nsIInputStream* aInStr,
                                  uint64_t aSourceOffset,
                                  uint32_t aCount)
{
  return OnDataAvailable(aRequest, aContext, aInStr, aSourceOffset, aCount);
}

nsresult
VectorImage::OnNewSourceData()
{
  return NS_OK;
}

nsresult
VectorImage::StartAnimation()
{
  if (mError)
    return NS_ERROR_FAILURE;

  MOZ_ASSERT(ShouldAnimate(), "Should not animate!");

  mSVGDocumentWrapper->StartAnimation();
  return NS_OK;
}

nsresult
VectorImage::StopAnimation()
{
  if (mError)
    return NS_ERROR_FAILURE;

  MOZ_ASSERT(mIsFullyLoaded && mHaveAnimations,
             "Should not have been animating!");

  mSVGDocumentWrapper->StopAnimation();
  return NS_OK;
}

bool
VectorImage::ShouldAnimate()
{
  return ImageResource::ShouldAnimate() && mIsFullyLoaded && mHaveAnimations;
}

//------------------------------------------------------------------------------
// imgIContainer methods

//******************************************************************************
/* readonly attribute int32_t width; */
NS_IMETHODIMP
VectorImage::GetWidth(int32_t* aWidth)
{
  if (mError || !mIsFullyLoaded) {
    *aWidth = 0;
    return NS_ERROR_FAILURE;
  }

  if (!mSVGDocumentWrapper->GetWidthOrHeight(SVGDocumentWrapper::eWidth,
                                             *aWidth)) {
    *aWidth = 0;
    return NS_ERROR_FAILURE;
  }

  return NS_OK;
}

//******************************************************************************
/* [notxpcom] void requestRefresh ([const] in TimeStamp aTime); */
NS_IMETHODIMP_(void)
VectorImage::RequestRefresh(const mozilla::TimeStamp& aTime)
{
  // TODO: Implement for b666446.
}

//******************************************************************************
/* readonly attribute int32_t height; */
NS_IMETHODIMP
VectorImage::GetHeight(int32_t* aHeight)
{
  if (mError || !mIsFullyLoaded) {
    *aHeight = 0;
    return NS_ERROR_FAILURE;
  }

  if (!mSVGDocumentWrapper->GetWidthOrHeight(SVGDocumentWrapper::eHeight,
                                             *aHeight)) {
    *aHeight = 0;
    return NS_ERROR_FAILURE;
  }

  return NS_OK;
}

//******************************************************************************
/* [noscript] readonly attribute nsSize intrinsicSize; */
NS_IMETHODIMP
VectorImage::GetIntrinsicSize(nsSize* aSize)
{
  if (mError || !mIsFullyLoaded)
    return NS_ERROR_FAILURE;

  nsIFrame* rootFrame = mSVGDocumentWrapper->GetRootLayoutFrame();
  *aSize = nsSize(-1, -1);
  nsIFrame::IntrinsicSize rfSize = rootFrame->GetIntrinsicSize();
  if (rfSize.width.GetUnit() == eStyleUnit_Coord)
    aSize->width = rfSize.width.GetCoordValue();
  if (rfSize.height.GetUnit() == eStyleUnit_Coord)
    aSize->height = rfSize.height.GetCoordValue();

  return NS_OK;
}

//******************************************************************************
/* [noscript] readonly attribute nsSize intrinsicRatio; */
NS_IMETHODIMP
VectorImage::GetIntrinsicRatio(nsSize* aRatio)
{
  if (mError || !mIsFullyLoaded)
    return NS_ERROR_FAILURE;

  nsIFrame* rootFrame = mSVGDocumentWrapper->GetRootLayoutFrame();
  *aRatio = rootFrame->GetIntrinsicRatio();
  return NS_OK;
}

//******************************************************************************
/* readonly attribute unsigned short type; */
NS_IMETHODIMP
VectorImage::GetType(uint16_t* aType)
{
  NS_ENSURE_ARG_POINTER(aType);

  *aType = GetType();
  return NS_OK;
}

//******************************************************************************
/* [noscript, notxpcom] uint16_t GetType(); */
NS_IMETHODIMP_(uint16_t)
VectorImage::GetType()
{
  return imgIContainer::TYPE_VECTOR;
}

//******************************************************************************
/* readonly attribute boolean animated; */
NS_IMETHODIMP
VectorImage::GetAnimated(bool* aAnimated)
{
  if (mError || !mIsFullyLoaded)
    return NS_ERROR_FAILURE;

  *aAnimated = mSVGDocumentWrapper->IsAnimated();
  return NS_OK;
}

//******************************************************************************
/* [notxpcom] boolean frameIsOpaque(in uint32_t aWhichFrame); */
NS_IMETHODIMP_(bool)
VectorImage::FrameIsOpaque(uint32_t aWhichFrame)
{
  if (aWhichFrame > FRAME_MAX_VALUE)
    NS_WARNING("aWhichFrame outside valid range!");

  return false; // In general, SVG content is not opaque.
}

//******************************************************************************
/* [noscript] gfxASurface getFrame(in uint32_t aWhichFrame,
 *                                 in uint32_t aFlags; */
NS_IMETHODIMP
VectorImage::GetFrame(uint32_t aWhichFrame,
                      uint32_t aFlags,
                      gfxASurface** _retval)
{
  NS_ENSURE_ARG_POINTER(_retval);

  if (aWhichFrame > FRAME_MAX_VALUE)
    return NS_ERROR_INVALID_ARG;

  if (mError)
    return NS_ERROR_FAILURE;

  // Look up height & width
  // ----------------------
  nsIntSize imageIntSize;
  if (!mSVGDocumentWrapper->GetWidthOrHeight(SVGDocumentWrapper::eWidth,
                                             imageIntSize.width) ||
      !mSVGDocumentWrapper->GetWidthOrHeight(SVGDocumentWrapper::eHeight,
                                             imageIntSize.height)) {
    // We'll get here if our SVG doc has a percent-valued width or height.
    return NS_ERROR_FAILURE;
  }

  // Create a surface that we'll ultimately return
  // ---------------------------------------------
  // Make our surface the size of what will ultimately be drawn to it.
  // (either the full image size, or the restricted region)
  gfxIntSize surfaceSize;
  if (mHaveRestrictedRegion) {
    surfaceSize.width = mRestrictedRegion.width;
    surfaceSize.height = mRestrictedRegion.height;
  } else {
    surfaceSize.width = imageIntSize.width;
    surfaceSize.height = imageIntSize.height;
  }

  nsRefPtr<gfxImageSurface> surface =
    new gfxImageSurface(surfaceSize, gfxASurface::ImageFormatARGB32);
  nsRefPtr<gfxContext> context = new gfxContext(surface);

  // Draw to our surface!
  // --------------------
  nsresult rv = Draw(context, gfxPattern::FILTER_NEAREST, gfxMatrix(),
                     gfxRect(gfxPoint(0,0), gfxIntSize(imageIntSize.width,
                                                       imageIntSize.height)),
                     nsIntRect(nsIntPoint(0,0), imageIntSize),
                     imageIntSize, nullptr, aWhichFrame, aFlags);

  NS_ENSURE_SUCCESS(rv, rv);
  *_retval = surface.forget().get();
  return rv;
}

//******************************************************************************
/* [noscript] ImageContainer getImageContainer(); */
NS_IMETHODIMP
VectorImage::GetImageContainer(LayerManager* aManager,
                               mozilla::layers::ImageContainer** _retval)
{
  *_retval = nullptr;
  return NS_OK;
}

//******************************************************************************
/* [noscript] imgIContainer extractFrame(uint32_t aWhichFrame,
 *                                       [const] in nsIntRect aRegion,
 *                                       in uint32_t aFlags); */
NS_IMETHODIMP
VectorImage::ExtractFrame(uint32_t aWhichFrame,
                          const nsIntRect& aRegion,
                          uint32_t aFlags,
                          imgIContainer** _retval)
{
  NS_ENSURE_ARG_POINTER(_retval);
  if (mError || !mIsFullyLoaded)
    return NS_ERROR_FAILURE;

  // XXXdholbert NOTE: This method assumes FRAME_CURRENT (not FRAME_FIRST)
  // right now, because mozilla doesn't actually contain any clients of this
  // method that use FRAME_FIRST.  If it's needed, we *could* handle
  // FRAME_FIRST by saving the helper-doc's current SMIL time, seeking it to
  // time 0, rendering to a RasterImage, and then restoring our saved time.
  if (aWhichFrame != FRAME_CURRENT) {
    NS_WARNING("VectorImage::ExtractFrame with something other than "
               "FRAME_CURRENT isn't supported yet. Assuming FRAME_CURRENT.");
  }

  // XXXdholbert This method also doesn't actually freeze animation in the
  // returned imgIContainer, because it shares our helper-document. To
  // get a true snapshot, we need to clone the document - see bug 590792.

  // Make a new container with same SVG document.
  nsRefPtr<VectorImage> extractedImg = new VectorImage();
  extractedImg->mSVGDocumentWrapper = mSVGDocumentWrapper;
  extractedImg->mAnimationMode = kDontAnimMode;

  extractedImg->mRestrictedRegion.x = aRegion.x;
  extractedImg->mRestrictedRegion.y = aRegion.y;

  // (disallow negative width/height on our restricted region)
  extractedImg->mRestrictedRegion.width  = std::max(aRegion.width,  0);
  extractedImg->mRestrictedRegion.height = std::max(aRegion.height, 0);

  extractedImg->mIsInitialized = true;
  extractedImg->mIsFullyLoaded = true;
  extractedImg->mHaveRestrictedRegion = true;

  *_retval = extractedImg.forget().get();
  return NS_OK;
}

//******************************************************************************
/* [noscript] void draw(in gfxContext aContext,
 *                      in gfxGraphicsFilter aFilter,
 *                      [const] in gfxMatrix aUserSpaceToImageSpace,
 *                      [const] in gfxRect aFill,
 *                      [const] in nsIntRect aSubimage,
 *                      [const] in nsIntSize aViewportSize,
 *                      [const] in SVGImageContext aSVGContext,
 *                      in uint32_t aWhichFrame,
 *                      in uint32_t aFlags); */
NS_IMETHODIMP
VectorImage::Draw(gfxContext* aContext,
                  gfxPattern::GraphicsFilter aFilter,
                  const gfxMatrix& aUserSpaceToImageSpace,
                  const gfxRect& aFill,
                  const nsIntRect& aSubimage,
                  const nsIntSize& aViewportSize,
                  const SVGImageContext* aSVGContext,
                  uint32_t aWhichFrame,
                  uint32_t aFlags)
{
  if (aWhichFrame > FRAME_MAX_VALUE)
    return NS_ERROR_INVALID_ARG;

  NS_ENSURE_ARG_POINTER(aContext);
  if (mError || !mIsFullyLoaded)
    return NS_ERROR_FAILURE;

  if (mIsDrawing) {
    NS_WARNING("Refusing to make re-entrant call to VectorImage::Draw");
    return NS_ERROR_FAILURE;
  }
  AutoRestore<bool> autoRestoreIsDrawing(mIsDrawing);
  mIsDrawing = true;

  float time = aWhichFrame == FRAME_FIRST ? 0.0f
                                          : mSVGDocumentWrapper->GetCurrentTime();
  AutoSVGRenderingState autoSVGState(aSVGContext,
                                     time,
                                     mSVGDocumentWrapper->GetRootSVGElem());
  mSVGDocumentWrapper->UpdateViewportBounds(aViewportSize);
  mSVGDocumentWrapper->FlushImageTransformInvalidation();

  nsIntSize imageSize = mHaveRestrictedRegion ?
    mRestrictedRegion.Size() : aViewportSize;

  // XXXdholbert Do we need to convert image size from
  // CSS pixels to dev pixels here? (is gfxCallbackDrawable's 2nd arg in dev
  // pixels?)
  gfxIntSize imageSizeGfx(imageSize.width, imageSize.height);

  // Based on imgFrame::Draw
  gfxRect sourceRect = aUserSpaceToImageSpace.Transform(aFill);
  gfxRect imageRect(0, 0, imageSize.width, imageSize.height);
  gfxRect subimage(aSubimage.x, aSubimage.y, aSubimage.width, aSubimage.height);


  nsRefPtr<gfxDrawingCallback> cb =
    new SVGDrawingCallback(mSVGDocumentWrapper,
                           mHaveRestrictedRegion ?
                           mRestrictedRegion :
                           nsIntRect(nsIntPoint(0, 0), aViewportSize),
                           aFlags);

  nsRefPtr<gfxDrawable> drawable = new gfxCallbackDrawable(cb, imageSizeGfx);

  gfxUtils::DrawPixelSnapped(aContext, drawable,
                             aUserSpaceToImageSpace,
                             subimage, sourceRect, imageRect, aFill,
                             gfxASurface::ImageFormatARGB32, aFilter);

  MOZ_ASSERT(mRenderingObserver || mHaveRestrictedRegion, 
      "Should have a rendering observer by now unless ExtractFrame created us");
  if (mRenderingObserver) {
    // Allow ourselves to fire FrameChanged and OnStopFrame again.
    mRenderingObserver->ResumeListening();
  }

  return NS_OK;
}

//******************************************************************************
/* void requestDecode() */
NS_IMETHODIMP
VectorImage::RequestDecode()
{
  // Nothing to do for SVG images
  return NS_OK;
}

NS_IMETHODIMP
VectorImage::StartDecoding()
{
  // Nothing to do for SVG images
  return NS_OK;
}


//******************************************************************************
/* void lockImage() */
NS_IMETHODIMP
VectorImage::LockImage()
{
  // This method is for image-discarding, which only applies to RasterImages.
  return NS_OK;
}

//******************************************************************************
/* void unlockImage() */
NS_IMETHODIMP
VectorImage::UnlockImage()
{
  // This method is for image-discarding, which only applies to RasterImages.
  return NS_OK;
}

//******************************************************************************
/* void requestDiscard() */
NS_IMETHODIMP
VectorImage::RequestDiscard()
{
  // This method is for image-discarding, which only applies to RasterImages.
  return NS_OK;
}

//******************************************************************************
/* void resetAnimation (); */
NS_IMETHODIMP
VectorImage::ResetAnimation()
{
  if (mError)
    return NS_ERROR_FAILURE;

  if (!mIsFullyLoaded || !mHaveAnimations) {
    return NS_OK; // There are no animations to be reset.
  }

  mSVGDocumentWrapper->ResetAnimation();

  return NS_OK;
}

//------------------------------------------------------------------------------
// nsIRequestObserver methods

//******************************************************************************
/* void onStartRequest(in nsIRequest request, in nsISupports ctxt); */
NS_IMETHODIMP
VectorImage::OnStartRequest(nsIRequest* aRequest, nsISupports* aCtxt)
{
  MOZ_ASSERT(!mSVGDocumentWrapper,
             "Repeated call to OnStartRequest -- can this happen?");

  mSVGDocumentWrapper = new SVGDocumentWrapper();
  nsresult rv = mSVGDocumentWrapper->OnStartRequest(aRequest, aCtxt);
  if (NS_FAILED(rv)) {
    mSVGDocumentWrapper = nullptr;
    mError = true;
    return rv;
  }

  // Sending StartDecode will block page load until the document's ready.  (We
  // unblock it by sending StopDecode in OnSVGDocumentLoaded or
  // OnSVGDocumentError.)
  if (mStatusTracker) {
    mStatusTracker->GetDecoderObserver()->OnStartDecode();
  }

  // Create a listener to wait until the SVG document is fully loaded, which
  // will signal that this image is ready to render. Certain error conditions
  // will prevent us from ever getting this notification, so we also create a
  // listener that waits for parsing to complete and cancels the
  // SVGLoadEventListener if needed. The listeners are automatically attached
  // to the document by their constructors.
  nsIDocument* document = mSVGDocumentWrapper->GetDocument();
  mLoadEventListener = new SVGLoadEventListener(document, this);
  mParseCompleteListener = new SVGParseCompleteListener(document, this);

  return NS_OK;
}

//******************************************************************************
/* void onStopRequest(in nsIRequest request, in nsISupports ctxt,
                      in nsresult status); */
NS_IMETHODIMP
VectorImage::OnStopRequest(nsIRequest* aRequest, nsISupports* aCtxt,
                           nsresult aStatus)
{
  if (mError)
    return NS_ERROR_FAILURE;

  return mSVGDocumentWrapper->OnStopRequest(aRequest, aCtxt, aStatus);
}

void
VectorImage::OnSVGDocumentParsed()
{
  MOZ_ASSERT(mParseCompleteListener, "Should have the parse complete listener");
  MOZ_ASSERT(mLoadEventListener, "Should have the load event listener");

  if (!mSVGDocumentWrapper->GetRootSVGElem()) {
    // This is an invalid SVG document. It may have failed to parse, or it may
    // be missing the <svg> root element, or the <svg> root element may not
    // declare the correct namespace. In any of these cases, we'll never be
    // notified that the SVG finished loading, so we need to treat this as an error.
    OnSVGDocumentError();
  }
}

void
VectorImage::CancelAllListeners()
{
  if (mParseCompleteListener) {
    mParseCompleteListener->Cancel();
    mParseCompleteListener = nullptr;
  }
  if (mLoadEventListener) {
    mLoadEventListener->Cancel();
    mLoadEventListener = nullptr;
  }
}

void
VectorImage::OnSVGDocumentLoaded()
{
  MOZ_ASSERT(mSVGDocumentWrapper->GetRootSVGElem(),
             "Should have parsed successfully");
  MOZ_ASSERT(!mIsFullyLoaded && !mHaveAnimations,
             "These flags shouldn't get set until OnSVGDocumentLoaded. "
             "Duplicate calls to OnSVGDocumentLoaded?");

  CancelAllListeners();

  // XXX Flushing is wasteful if embedding frame hasn't had initial reflow.
  mSVGDocumentWrapper->FlushLayout();

  mIsFullyLoaded = true;
  mHaveAnimations = mSVGDocumentWrapper->IsAnimated();

  // Start listening to our image for rendering updates.
  mRenderingObserver = new SVGRootRenderingObserver(mSVGDocumentWrapper, this);

  // Tell *our* observers that we're done loading.
  if (mStatusTracker) {
    imgDecoderObserver* observer = mStatusTracker->GetDecoderObserver();

    observer->OnStartContainer(); // Signal that width/height are available.
    observer->FrameChanged(&nsIntRect::GetMaxSizedIntRect());
    observer->OnStopFrame();
    observer->OnStopDecode(NS_OK); // Unblock page load.
  }

  EvaluateAnimation();
}

void
VectorImage::OnSVGDocumentError()
{
  CancelAllListeners();

  // XXXdholbert Need to do something more for the parsing failed case -- right
  // now, this just makes us draw the "object" icon, rather than the (jagged)
  // "broken image" icon.  See bug 594505.
  mError = true;

  if (mStatusTracker) {
    // Unblock page load.
    mStatusTracker->GetDecoderObserver()->OnStopDecode(NS_ERROR_FAILURE);
  }
}

//------------------------------------------------------------------------------
// nsIStreamListener method

//******************************************************************************
/* void onDataAvailable(in nsIRequest request, in nsISupports ctxt,
                        in nsIInputStream inStr, in unsigned long sourceOffset,
                        in unsigned long count); */
NS_IMETHODIMP
VectorImage::OnDataAvailable(nsIRequest* aRequest, nsISupports* aCtxt,
                             nsIInputStream* aInStr, uint64_t aSourceOffset,
                             uint32_t aCount)
{
  if (mError)
    return NS_ERROR_FAILURE;

  return mSVGDocumentWrapper->OnDataAvailable(aRequest, aCtxt, aInStr,
                                              aSourceOffset, aCount);
}

// --------------------------
// Invalidation helper method

void
VectorImage::InvalidateObserver()
{
  if (mStatusTracker) {
    imgDecoderObserver* observer = mStatusTracker->GetDecoderObserver();
    observer->FrameChanged(&nsIntRect::GetMaxSizedIntRect());
    observer->OnStopFrame();
  }
}

} // namespace image
} // namespace mozilla
