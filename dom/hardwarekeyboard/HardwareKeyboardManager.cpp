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

/**
 * We have to use macros here because our leak analysis tool things we are
 * leaking strings when we have |static const nsString|. Sad :(
 */
#define HW_KEYBOARD_CONNECTED_EVENT_NAME           NS_LITERAL_STRING("hardwarekeyboardconnected")
#define HW_KEYBOARD_DISCONNECTED_EVENT_NAME        NS_LITERAL_STRING("hardwarekeyboarddisconnected")

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
  : mNumHWKeyboards(0)
{
}

void
HardwareKeyboardManager::Init(nsPIDOMWindow* aWindow)
{
  BindToOwner(aWindow);

  hal::RegisterHardwareKeyboardObserver(this);

  hal::HardwareKeyboardInformation keyboardInfo;
  hal::GetCurrentHardwareKeyboardInformation(&keyboardInfo);

  mNumHWKeyboards = keyboardInfo.numHWKeyboards();
}

void
HardwareKeyboardManager::Shutdown()
{
  hal::UnregisterHardwareKeyboardObserver(this);
}

NS_IMETHODIMP
HardwareKeyboardManager::GetHardwareKeyboardPresent(bool* aIsHWKeyboardPresent)
{
  *aIsHWKeyboardPresent = mNumHWKeyboards;
  return NS_OK;
}


void
HardwareKeyboardManager::Notify(const hal::HardwareKeyboardInformation& aHardwareKeyboardInfo)
{
  uint32_t newNumHWKeyboards = aHardwareKeyboardInfo.numHWKeyboards();
  if ((newNumHWKeyboards > mNumHWKeyboards) && !mNumHWKeyboards) {
    DispatchTrustedEvent(HW_KEYBOARD_CONNECTED_EVENT_NAME);
  } else if ((newNumHWKeyboards < mNumHWKeyboards) && !newNumHWKeyboards) {
    DispatchTrustedEvent(HW_KEYBOARD_DISCONNECTED_EVENT_NAME);
  }
  mNumHWKeyboards = newNumHWKeyboards;
}

} // namespace hardwarekeyboard
} // namespace dom
} // namespace mozilla
