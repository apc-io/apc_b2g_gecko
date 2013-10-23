/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_hardwarekeyboard_HardwareKeyboardManager_h
#define mozilla_dom_hardwarekeyboard_HardwareKeyboardManager_h

#include "nsIDOMHardwareKeyboardManager.h"
#include "nsDOMEventTargetHelper.h"
#include "nsCycleCollectionParticipant.h"
#include "mozilla/Observer.h"
#include "Types.h"

class nsPIDOMWindow;
class nsIScriptContext;

namespace mozilla {

namespace hal {
class HardwareKeyboardInformation;
} // namespace hal

namespace dom {
namespace hardwarekeyboard {

class HardwareKeyboardManager : public nsDOMEventTargetHelper
                     , public nsIDOMHardwareKeyboardManager
                     , public HardwareKeyboardObserver
{
public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIDOMHARDWAREKEYBOARDMANAGER
  NS_FORWARD_NSIDOMEVENTTARGET(nsDOMEventTargetHelper::)

  HardwareKeyboardManager();

  void Shutdown();
  void Init(nsPIDOMWindow *aWindow);

  // For IObserver.
  void Notify(const hal::HardwareKeyboardInformation& aHardwareKeyboardInfo);

  NS_DECL_CYCLE_COLLECTION_CLASS_INHERITED(HardwareKeyboardManager,
                                           nsDOMEventTargetHelper)
private:
  uint32_t   mNumHWKeyboards;
};

} // namespace hardwarekeyboard
} // namespace dom
} // namespace mozilla

#endif // mozilla_dom_keyboard_HardwareKeyboardManager_h
