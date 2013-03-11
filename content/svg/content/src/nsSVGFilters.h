/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef __NS_SVGFILTERSELEMENT_H__
#define __NS_SVGFILTERSELEMENT_H__

#include "gfxImageSurface.h"
#include "gfxRect.h"
#include "nsIDOMSVGFilters.h"
#include "nsIFrame.h"
#include "nsImageLoadingContent.h"
#include "nsSVGLength2.h"
#include "nsSVGString.h"
#include "nsSVGElement.h"
#include "SVGAnimatedPreserveAspectRatio.h"

class nsSVGFilterInstance;
class nsSVGFilterResource;
class nsSVGNumberPair;

struct nsSVGStringInfo {
  nsSVGStringInfo(const nsSVGString* aString,
                  nsSVGElement *aElement) :
    mString(aString), mElement(aElement) {}

  const nsSVGString* mString;
  nsSVGElement* mElement;
};

typedef nsSVGElement nsSVGFEBase;

#define NS_SVG_FE_CID \
{ 0x60483958, 0xd229, 0x4a77, \
  { 0x96, 0xb2, 0x62, 0x3e, 0x69, 0x95, 0x1e, 0x0e } }

/**
 * Base class for filter primitive elements
 * Children of those elements e.g. feMergeNode
 * derive from SVGFEUnstyledElement instead
 */
class nsSVGFE : public nsSVGFEBase
//, public nsIDOMSVGFilterPrimitiveStandardAttributes
{
  friend class nsSVGFilterInstance;

public:
  class ColorModel {
  public:
    enum ColorSpace { SRGB, LINEAR_RGB };
    enum AlphaChannel { UNPREMULTIPLIED, PREMULTIPLIED };

    ColorModel(ColorSpace aColorSpace, AlphaChannel aAlphaChannel) :
      mColorSpace(aColorSpace), mAlphaChannel(aAlphaChannel) {}
    ColorModel() :
      mColorSpace(SRGB), mAlphaChannel(PREMULTIPLIED) {}
    bool operator==(const ColorModel& aOther) const {
      return mColorSpace == aOther.mColorSpace &&
             mAlphaChannel == aOther.mAlphaChannel;
    }
    ColorSpace   mColorSpace;
    AlphaChannel mAlphaChannel;
  };

  struct Image {
    // The device offset of mImage makes it relative to filter space
    nsRefPtr<gfxImageSurface> mImage;
    // The filter primitive subregion bounding this image, in filter space
    gfxRect                   mFilterPrimitiveSubregion;
    ColorModel                mColorModel;
    // When true, the RGB values are the same for all pixels in mImage
    bool                      mConstantColorChannels;
    
    Image() : mConstantColorChannels(false) {}
  };

protected:
  nsSVGFE(already_AddRefed<nsINodeInfo> aNodeInfo) : nsSVGFEBase(aNodeInfo) {}

  struct ScaleInfo {
    nsRefPtr<gfxImageSurface> mRealTarget;
    nsRefPtr<gfxImageSurface> mSource;
    nsRefPtr<gfxImageSurface> mTarget;
    nsIntRect mDataRect; // rect in mSource and mTarget to operate on
    bool mRescaling;
  };

  ScaleInfo SetupScalingFilter(nsSVGFilterInstance *aInstance,
                               const Image *aSource,
                               const Image *aTarget,
                               const nsIntRect& aDataRect,
                               nsSVGNumberPair *aUnit);

  void FinishScalingFilter(ScaleInfo *aScaleInfo);

public:
  ColorModel
  GetInputColorModel(nsSVGFilterInstance* aInstance, int32_t aInputIndex,
                     Image* aImage) {
    return ColorModel(
          (OperatesOnSRGB(aInstance, aInputIndex, aImage) ?
             ColorModel::SRGB : ColorModel::LINEAR_RGB),
          (OperatesOnPremultipledAlpha(aInputIndex) ?
             ColorModel::PREMULTIPLIED : ColorModel::UNPREMULTIPLIED));
  }

  ColorModel
  GetOutputColorModel(nsSVGFilterInstance* aInstance) {
    return ColorModel(
          (OperatesOnSRGB(aInstance, -1, nullptr) ?
             ColorModel::SRGB : ColorModel::LINEAR_RGB),
          (OperatesOnPremultipledAlpha(-1) ?
             ColorModel::PREMULTIPLIED : ColorModel::UNPREMULTIPLIED));
  }

  // See http://www.w3.org/TR/SVG/filters.html#FilterPrimitiveSubRegion
  virtual bool SubregionIsUnionOfRegions() { return true; }

  NS_DECLARE_STATIC_IID_ACCESSOR(NS_SVG_FE_CID)
  
  // interfaces:
  NS_DECL_ISUPPORTS_INHERITED
  NS_DECL_NSIDOMSVGFILTERPRIMITIVESTANDARDATTRIBUTES

  // nsIContent interface
  NS_IMETHOD_(bool) IsAttributeMapped(const nsIAtom* aAttribute) const;

  // nsSVGElement interface
  virtual bool HasValidDimensions() const;

  bool IsNodeOfType(uint32_t aFlags) const
    { return !(aFlags & ~(eCONTENT | eFILTER)); }

  virtual nsSVGString& GetResultImageName() = 0;
  // Return a list of all image names used as sources. Default is to
  // return no sources.
  virtual void GetSourceImageNames(nsTArray<nsSVGStringInfo>& aSources);
  // Compute the bounding box of the filter output. The default is just the
  // union of the source bounding boxes. The caller is
  // responsible for clipping this to the filter primitive subregion, so
  // if the filter fills its filter primitive subregion, it can just
  // return GetMaxRect() here.
  // The source bounding boxes are ordered corresponding to GetSourceImageNames.
  virtual nsIntRect ComputeTargetBBox(const nsTArray<nsIntRect>& aSourceBBoxes,
          const nsSVGFilterInstance& aInstance);
  // Given a bounding box for what we need to compute in the target,
  // compute which regions of the inputs are needed. On input
  // aSourceBBoxes contains the bounding box of what's rendered by
  // each source; this function should change those boxes to indicate
  // which region of the source's output it needs.
  // The default implementation sets all the source bboxes to the
  // target bbox.
  virtual void ComputeNeededSourceBBoxes(const nsIntRect& aTargetBBox,
          nsTArray<nsIntRect>& aSourceBBoxes, const nsSVGFilterInstance& aInstance);
  // Given the bounding boxes for the pixels that have changed in the inputs,
  // compute the bounding box of the changes in this primitive's output.
  // The result will be clipped by the caller to the result of ComputeTargetBBox
  // since there's no way anything outside that can change.
  // The default implementation returns the union of the source change boxes.
  virtual nsIntRect ComputeChangeBBox(const nsTArray<nsIntRect>& aSourceChangeBoxes,
          const nsSVGFilterInstance& aInstance);
  
  // Perform the actual filter operation.
  // We guarantee that every mImage from aSources and aTarget has the
  // same width, height, stride and device offset.
  // aTarget is already filled in. This function just needs to fill in the
  // pixels of aTarget->mImage (which have already been cleared).
  // @param aDataRect the destination rectangle that needs to be painted,
  // relative to aTarget's surface data. This is the intersection of the
  // filter primitive subregion for this filter element and the
  // temporary surface area. Output need not be clipped to this rect but
  // it must be clipped to aTarget->mFilterPrimitiveSubregion.
  virtual nsresult Filter(nsSVGFilterInstance* aInstance,
                          const nsTArray<const Image*>& aSources,
                          const Image* aTarget,
                          const nsIntRect& aDataRect) = 0;

  // returns true if changes to the attribute should cause us to
  // repaint the filter
  virtual bool AttributeAffectsRendering(
          int32_t aNameSpaceID, nsIAtom* aAttribute) const;

  static nsIntRect GetMaxRect() {
    // Try to avoid overflow errors dealing with this rect. It will
    // be intersected with some other reasonable-sized rect eventually.
    return nsIntRect(INT32_MIN/2, INT32_MIN/2, INT32_MAX, INT32_MAX);
  }

  operator nsISupports*() { return static_cast<nsIContent*>(this); }

  // WebIDL
  already_AddRefed<mozilla::dom::SVGAnimatedLength> X();
  already_AddRefed<mozilla::dom::SVGAnimatedLength> Y();
  already_AddRefed<mozilla::dom::SVGAnimatedLength> Width();
  already_AddRefed<mozilla::dom::SVGAnimatedLength> Height();
  already_AddRefed<nsIDOMSVGAnimatedString> Result();

protected:
  virtual bool OperatesOnPremultipledAlpha(int32_t) { return true; }

  // Called either with aInputIndex >=0 in which case this is
  // testing whether the input 'aInputIndex' should be SRGB, or
  // if aInputIndex is -1 returns true if the output will be SRGB
  virtual bool OperatesOnSRGB(nsSVGFilterInstance* aInstance,
                                int32_t aInputIndex, Image* aImage) {
    nsIFrame* frame = GetPrimaryFrame();
    if (!frame) return false;

    nsStyleContext* style = frame->StyleContext();
    return style->StyleSVG()->mColorInterpolationFilters ==
             NS_STYLE_COLOR_INTERPOLATION_SRGB;
  }

  // nsSVGElement specializations:
  virtual LengthAttributesInfo GetLengthInfo();

  // nsIDOMSVGFitlerPrimitiveStandardAttributes values
  enum { ATTR_X, ATTR_Y, ATTR_WIDTH, ATTR_HEIGHT };
  nsSVGLength2 mLengthAttributes[4];
  static LengthInfo sLengthInfo[4];
};

typedef nsSVGElement SVGFEUnstyledElementBase;

class SVGFEUnstyledElement : public SVGFEUnstyledElementBase
{
protected:
  SVGFEUnstyledElement(already_AddRefed<nsINodeInfo> aNodeInfo)
    : SVGFEUnstyledElementBase(aNodeInfo) {}

public:
  // returns true if changes to the attribute should cause us to
  // repaint the filter
  virtual bool AttributeAffectsRendering(
          int32_t aNameSpaceID, nsIAtom* aAttribute) const = 0;
};

void
CopyDataRect(uint8_t *aDest, const uint8_t *aSrc, uint32_t aStride,
             const nsIntRect& aDataRect);

inline void
CopyRect(const nsSVGFE::Image* aDest, const nsSVGFE::Image* aSrc, const nsIntRect& aDataRect)
{
  NS_ASSERTION(aDest->mImage->Stride() == aSrc->mImage->Stride(), "stride mismatch");
  NS_ASSERTION(aDest->mImage->GetSize() == aSrc->mImage->GetSize(), "size mismatch");
  NS_ASSERTION(nsIntRect(0, 0, aDest->mImage->Width(), aDest->mImage->Height()).Contains(aDataRect),
               "aDataRect out of bounds");

  CopyDataRect(aDest->mImage->Data(), aSrc->mImage->Data(),
               aSrc->mImage->Stride(), aDataRect);
}

#endif
