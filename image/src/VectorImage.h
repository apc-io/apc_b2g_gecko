/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_imagelib_VectorImage_h_
#define mozilla_imagelib_VectorImage_h_

#include "Image.h"
#include "nsIStreamListener.h"
#include "nsIRequest.h"
#include "mozilla/TimeStamp.h"
#include "mozilla/WeakPtr.h"

class imgDecoderObserver;

namespace mozilla {
namespace layers {
class LayerManager;
class ImageContainer;
}
namespace image {

class SVGDocumentWrapper;
class SVGRootRenderingObserver;
class SVGLoadEventListener;
class SVGParseCompleteListener;

class VectorImage : public ImageResource,
                    public nsIStreamListener
{
public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIREQUESTOBSERVER
  NS_DECL_NSISTREAMLISTENER
  NS_DECL_IMGICONTAINER

  // (no public constructor - use ImageFactory)
  virtual ~VectorImage();

  // Methods inherited from Image
  nsresult Init(const char* aMimeType,
                uint32_t aFlags);
  virtual nsIntRect FrameRect(uint32_t aWhichFrame) MOZ_OVERRIDE;

  virtual size_t HeapSizeOfSourceWithComputedFallback(nsMallocSizeOfFun aMallocSizeOf) const;
  virtual size_t HeapSizeOfDecodedWithComputedFallback(nsMallocSizeOfFun aMallocSizeOf) const;
  virtual size_t NonHeapSizeOfDecoded() const;
  virtual size_t OutOfProcessSizeOfDecoded() const;

  virtual nsresult OnImageDataAvailable(nsIRequest* aRequest,
                                        nsISupports* aContext,
                                        nsIInputStream* aInStr,
                                        uint64_t aSourceOffset,
                                        uint32_t aCount) MOZ_OVERRIDE;
  virtual nsresult OnImageDataComplete(nsIRequest* aRequest,
                                       nsISupports* aContext,
                                       nsresult aResult,
                                       bool aLastPart) MOZ_OVERRIDE;
  virtual nsresult OnNewSourceData() MOZ_OVERRIDE;

  // Callback for SVGRootRenderingObserver.
  void InvalidateObserver();

  // Callback for SVGParseCompleteListener.
  void OnSVGDocumentParsed();

  // Callbacks for SVGLoadEventListener.
  void OnSVGDocumentLoaded();
  void OnSVGDocumentError();

protected:
  VectorImage(imgStatusTracker* aStatusTracker = nullptr, nsIURI* aURI = nullptr);

  virtual nsresult StartAnimation();
  virtual nsresult StopAnimation();
  virtual bool     ShouldAnimate();

private:
  void CancelAllListeners();

  // A private structure used for storing the arguments to
  // imgStatusTracker::OnStopRequest until we're ready to call it.
  struct StopRequest
  {
    StopRequest(bool aLastPart = true, nsresult aStatus = NS_OK)
      : lastPart(aLastPart)
      , status(aStatus)
    { }

    bool lastPart;
    nsresult status;
  };

  nsRefPtr<SVGDocumentWrapper>       mSVGDocumentWrapper;
  nsRefPtr<SVGRootRenderingObserver> mRenderingObserver;
  nsRefPtr<SVGLoadEventListener>     mLoadEventListener;
  nsRefPtr<SVGParseCompleteListener> mParseCompleteListener;

  // If we need to fire OnStopRequest, this stores the parameters we got when
  // OnImageDataComplete was called.
  Maybe<StopRequest> mStopRequest;       

  nsIntRect      mRestrictedRegion;       // If we were created by
                                          // ExtractFrame, this is the region
                                          // that we're restricted to using.
                                          // Otherwise, this is ignored.

  bool           mIsInitialized:1;        // Have we been initalized?
  bool           mIsFullyLoaded:1;        // Has the SVG document finished loading?
  bool           mIsDrawing:1;            // Are we currently drawing?
  bool           mHaveAnimations:1;       // Is our SVG content SMIL-animated?
                                          // (Only set after mIsFullyLoaded.)
  bool           mHaveRestrictedRegion:1; // Are we a restricted-region clone
                                          // created via ExtractFrame?

  friend class ImageFactory;
};

inline NS_IMETHODIMP VectorImage::GetAnimationMode(uint16_t *aAnimationMode) {
  return GetAnimationModeInternal(aAnimationMode);
}

inline NS_IMETHODIMP VectorImage::SetAnimationMode(uint16_t aAnimationMode) {
  return SetAnimationModeInternal(aAnimationMode);
}

} // namespace image
} // namespace mozilla

#endif // mozilla_imagelib_VectorImage_h_
