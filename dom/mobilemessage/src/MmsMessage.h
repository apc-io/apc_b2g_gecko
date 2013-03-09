/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_mobilemessage_MmsMessage_h
#define mozilla_dom_mobilemessage_MmsMessage_h

#include "nsIDOMMozMmsMessage.h"
#include "nsString.h"
#include "jspubtd.h"
#include "mozilla/dom/mobilemessage/Types.h"
#include "mozilla/Attributes.h"
#include "DictionaryHelpers.h"

namespace mozilla {
namespace dom {

class MmsMessage MOZ_FINAL : public nsIDOMMozMmsMessage
{
public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIDOMMOZMMSMESSAGE

  MmsMessage(int32_t aId,
             mobilemessage::DeliveryState                   aState,
             const nsTArray<mobilemessage::DeliveryStatus>& aDeliveryStatus,
             const nsAString&                               aSender,
             const nsTArray<nsString>&                      aReceivers,
             uint64_t                                       aTimestamp,
             bool                                           aRead,
             const nsAString&                               aSubject,
             const nsAString&                               aSmil,
             const nsTArray<idl::MmsAttachment>&            aAttachments);

  static nsresult Create(int32_t               aId,
                         const nsAString&      aState,
                         const JS::Value&      aDeliveryStatus,
                         const nsAString&      aSender,
                         const JS::Value&      aReceivers,
                         const JS::Value&      aTimestamp,
                         bool                  aRead,
                         const nsAString&      aSubject,
                         const nsAString&      aSmil,
                         const JS::Value&      aAttachments,
                         JSContext*            aCx,
                         nsIDOMMozMmsMessage** aMessage);

private:

  int32_t                                 mId;
  mobilemessage::DeliveryState            mState;
  nsTArray<mobilemessage::DeliveryStatus> mDeliveryStatus;
  nsString                                mSender;
  nsTArray<nsString>                      mReceivers;
  uint64_t                                mTimestamp;
  bool                                    mRead;
  nsString                                mSubject;
  nsString                                mSmil;
  nsTArray<idl::MmsAttachment>            mAttachments;
};

} // namespace dom
} // namespace mozilla

#endif // mozilla_dom_mobilemessage_MmsMessage_h
