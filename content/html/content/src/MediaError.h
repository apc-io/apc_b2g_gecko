/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim:set ts=2 sw=2 sts=2 et cindent: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_MediaError_h
#define mozilla_dom_MediaError_h

#include "nsIDOMMediaError.h"
#include "nsHTMLMediaElement.h"
#include "nsWrapperCache.h"
#include "nsISupports.h"
#include "mozilla/Attributes.h"

namespace mozilla {
namespace dom {

class MediaError MOZ_FINAL : public nsIDOMMediaError,
                             public nsWrapperCache
{
public:
  MediaError(nsHTMLMediaElement* aParent, uint16_t aCode);

  // nsISupports
  NS_DECL_CYCLE_COLLECTING_ISUPPORTS
  NS_DECL_CYCLE_COLLECTION_SCRIPT_HOLDER_CLASS(MediaError)

  // nsIDOMMediaError
  NS_DECL_NSIDOMMEDIAERROR

  nsHTMLMediaElement* GetParentObject() const
  {
    return mParent;
  }

  virtual JSObject* WrapObject(JSContext* aCx, JSObject* aScope, bool* aTriedToWrap);

  uint16_t Code() const
  {
    return mCode;
  }

private:
  nsRefPtr<nsHTMLMediaElement> mParent;

  // Error code
  const uint16_t mCode;
};

} // namespace dom
} // namespace mozilla

#endif // mozilla_dom_MediaError_h
