/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "SVGPreserveAspectRatio.h"
#include "SVGAnimatedPreserveAspectRatio.h"
#include "mozilla/dom/SVGPreserveAspectRatioBinding.h"

using namespace mozilla;
using namespace dom;

NS_IMPL_CYCLE_COLLECTION_CLASS(DOMSVGPreserveAspectRatio)
NS_IMPL_CYCLE_COLLECTION_UNLINK_BEGIN(DOMSVGPreserveAspectRatio)
// No unlinking mElement, we'd need to null out the value pointer (the object it
// points to is held by the element) and null-check it everywhere.
NS_IMPL_CYCLE_COLLECTION_UNLINK_PRESERVED_WRAPPER
NS_IMPL_CYCLE_COLLECTION_UNLINK_END

NS_IMPL_CYCLE_COLLECTION_TRAVERSE_BEGIN(DOMSVGPreserveAspectRatio)
NS_IMPL_CYCLE_COLLECTION_TRAVERSE(mSVGElement)
NS_IMPL_CYCLE_COLLECTION_TRAVERSE_SCRIPT_OBJECTS
NS_IMPL_CYCLE_COLLECTION_TRAVERSE_END

NS_IMPL_CYCLE_COLLECTION_TRACE_BEGIN(DOMSVGPreserveAspectRatio)
NS_IMPL_CYCLE_COLLECTION_TRACE_PRESERVED_WRAPPER
NS_IMPL_CYCLE_COLLECTION_TRACE_END

NS_IMPL_CYCLE_COLLECTING_ADDREF(DOMSVGPreserveAspectRatio)
NS_IMPL_CYCLE_COLLECTING_RELEASE(DOMSVGPreserveAspectRatio)

DOMCI_DATA(SVGPreserveAspectRatio, DOMSVGPreserveAspectRatio)

NS_INTERFACE_MAP_BEGIN_CYCLE_COLLECTION(DOMSVGPreserveAspectRatio)
  NS_WRAPPERCACHE_INTERFACE_MAP_ENTRY
  NS_INTERFACE_MAP_ENTRY(nsIDOMSVGPreserveAspectRatio)
  NS_INTERFACE_MAP_ENTRY(nsISupports)
  NS_DOM_INTERFACE_MAP_ENTRY_CLASSINFO(SVGPreserveAspectRatio)
NS_INTERFACE_MAP_END

bool
SVGPreserveAspectRatio::operator==(const SVGPreserveAspectRatio& aOther) const
{
  return mAlign == aOther.mAlign &&
    mMeetOrSlice == aOther.mMeetOrSlice &&
    mDefer == aOther.mDefer;
}

JSObject*
DOMSVGPreserveAspectRatio::WrapObject(JSContext* aCx, JSObject* aScope, bool* aTriedToWrap)
{
  return mozilla::dom::SVGPreserveAspectRatioBinding::Wrap(aCx, aScope, this, aTriedToWrap);
}

uint16_t
DOMSVGPreserveAspectRatio::Align()
{
  if (mIsBaseValue) {
    return mVal->GetBaseValue().GetAlign();
  }

  mSVGElement->FlushAnimations();
  return mVal->GetAnimValue().GetAlign();
}

void
DOMSVGPreserveAspectRatio::SetAlign(uint16_t aAlign, ErrorResult& rv)
{
  if (!mIsBaseValue) {
    rv.Throw(NS_ERROR_DOM_NO_MODIFICATION_ALLOWED_ERR);
    return;
  }
  rv = mVal->SetBaseAlign(aAlign, mSVGElement);
}

uint16_t
DOMSVGPreserveAspectRatio::MeetOrSlice()
{
  if (mIsBaseValue) {
    return mVal->GetBaseValue().GetMeetOrSlice();
  }

  mSVGElement->FlushAnimations();
  return mVal->GetAnimValue().GetMeetOrSlice();
}

void
DOMSVGPreserveAspectRatio::SetMeetOrSlice(uint16_t aMeetOrSlice, ErrorResult& rv)
{
  if (!mIsBaseValue) {
    rv.Throw(NS_ERROR_DOM_NO_MODIFICATION_ALLOWED_ERR);
    return;
  }
  rv = mVal->SetBaseMeetOrSlice(aMeetOrSlice, mSVGElement);
}

