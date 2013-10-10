/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#include <limits>
#include "mozilla/Hal.h"
#include "mozilla/HalTypes.h"
#include "HardwareKeyboardManager.h"
#include "nsIDOMClassInfo.h"
#include "nsDOMEvent.h"
#include "mozilla/Preferences.h"
#include "nsDOMEventTargetHelper.h"
#include "android/log.h"
#define LOG(args...)                                            \
    __android_log_print(ANDROID_LOG_INFO, "Gonk" , ## args)


DOMCI_DATA(HardwareKeyboardManager, mozilla::dom::hardwarekeyboard::HardwareKeyboardManager)

namespace mozilla {
namespace dom {
namespace hardwarekeyboard {

NS_IMPL_CYCLE_COLLECTION_CLASS(HardwareKeyboardManager)

NS_IMPL_CYCLE_COLLECTION_TRAVERSE_BEGIN_INHERITED(HardwareKeyboardManager,
                                                  nsDOMEventTargetHelper)
NS_IMPL_CYCLE_COLLECTION_TRAVERSE_END

NS_IMPL_CYCLE_COLLECTION_UNLINK_BEGIN_INHERITED(HardwareKeyboardManager,
                                                nsDOMEventTargetHelper)
NS_IMPL_CYCLE_COLLECTION_UNLINK_END

NS_IMPL_ADDREF_INHERITED(HardwareKeyboardManager, nsDOMEventTargetHelper)
NS_IMPL_RELEASE_INHERITED(HardwareKeyboardManager, nsDOMEventTargetHelper)

NS_INTERFACE_MAP_BEGIN_CYCLE_COLLECTION_INHERITED(HardwareKeyboardManager)
  NS_INTERFACE_MAP_ENTRY(nsIDOMHardwareKeyboardManager)
  NS_DOM_INTERFACE_MAP_ENTRY_CLASSINFO(HardwareKeyboardManager)
NS_INTERFACE_MAP_END_INHERITING(nsDOMEventTargetHelper)

NS_IMPL_EVENT_HANDLER(HardwareKeyboardManager, hardwarekeyboardconnected)
NS_IMPL_EVENT_HANDLER(HardwareKeyboardManager, hardwarekeyboarddisconnected)

HardwareKeyboardManager::HardwareKeyboardManager()
  : mIsPlugged(false)
{
  //hal::RegisterHardwareKeyboardObserver(this);
  LOG("object created");
}

HardwareKeyboardManager::~HardwareKeyboardManager()
{
  //hal::UnregisterHardwareKeyboardObserver(this);
}

void
HardwareKeyboardManager::Init(nsPIDOMWindow* aWindow)
{
  LOG("object init");
  BindToOwner(aWindow->IsOuterWindow() ?
    aWindow->GetCurrentInnerWindow() : aWindow);
  LOG("object init done");
  
  //hal::HardwareHardwareKeyboardManagerInformation keyboardInfo;
  //hal::GetCurrentHardwareKeyboardInformation(&keyboardInfo);
  //mIsPlugged = keyboardInfo.isPlugged();
}

NS_IMETHODIMP
HardwareKeyboardManager::GetIsPlugged(bool* aIsPlugged)
{
  *aIsPlugged = mIsPlugged;

  return NS_OK;
}


void
//HardwareKeyboardManager::Notify(const hal::HardwareKeyboardInformation& aEvent)
HardwareKeyboardManager::Notify()
{
  //if (aEvent.status() == HARDWARE_KEYBOARD_PLUG_IN) {
  //  isPlugged = true;
  //} else {
  //  isPlugged = false;
  //}

  DispatchTrustedEvent(NS_LITERAL_STRING("hardwarekeyboardconnected"));
}

} // namespace system
} // namespace dom
} // namespace mozilla
