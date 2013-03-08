/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_mobilemessage_MobileMessageManager_h
#define mozilla_dom_mobilemessage_MobileMessageManager_h

#include "nsIDOMMobileMessageManager.h"
#include "nsIObserver.h"
#include "nsDOMEventTargetHelper.h"

class nsIDOMMozSmsMessage;
class nsIDOMMozMmsMessage;

namespace mozilla {
namespace dom {

class MobileMessageManager : public nsDOMEventTargetHelper
                           , public nsIDOMMozMobileMessageManager
                           , public nsIObserver
{
public:
  NS_DECL_ISUPPORTS_INHERITED
  NS_DECL_NSIOBSERVER
  NS_DECL_NSIDOMMOZMOBILEMESSAGEMANAGER

  NS_FORWARD_NSIDOMEVENTTARGET(nsDOMEventTargetHelper::)

  void Init(nsPIDOMWindow *aWindow);
  void Shutdown();

private:
  /**
   * Internal Send() method used to send one message.
   */
  nsresult Send(JSContext* aCx, JSObject* aGlobal, JSString* aNumber,
                const nsAString& aMessage, jsval* aRequest);

  /**
   * Internal Delete() method used to delete a message.
   */
  nsresult Delete(int32_t aId, nsIDOMDOMRequest** aRequest);

  nsresult DispatchTrustedSmsEventToSelf(const nsAString& aEventName,
                                         nsIDOMMozSmsMessage* aMessage);

  nsresult DispatchTrustedMmsEventToSelf(const nsAString& aEventName,
                                         nsIDOMMozMmsMessage* aMessage);
};

} // namespace dom
} // namespace mozilla

#endif // mozilla_dom_mobilemessage_MobileMessageManager_h
