/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/dom/SVGPolylineElement.h"
#include "mozilla/dom/SVGPolylineElementBinding.h"

NS_IMPL_NS_NEW_NAMESPACED_SVG_ELEMENT(Polyline)

namespace mozilla {
namespace dom {

JSObject*
SVGPolylineElement::WrapNode(JSContext *aCx, JSObject *aScope, bool *aTriedToWrap)
{
  return SVGPolylineElementBinding::Wrap(aCx, aScope, this, aTriedToWrap);
}

//----------------------------------------------------------------------
// nsISupports methods

NS_IMPL_ISUPPORTS_INHERITED3(SVGPolylineElement, SVGPolylineElementBase,
                             nsIDOMNode, nsIDOMElement,
                             nsIDOMSVGElement)

//----------------------------------------------------------------------
// Implementation

SVGPolylineElement::SVGPolylineElement(already_AddRefed<nsINodeInfo> aNodeInfo)
  : SVGPolylineElementBase(aNodeInfo)
{

}

//----------------------------------------------------------------------
// nsIDOMNode methods

NS_IMPL_ELEMENT_CLONE_WITH_INIT(SVGPolylineElement)

} // namespace dom
} // namespace mozilla
