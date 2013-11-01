/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#include <limits>
#include "mozilla/Hal.h"
#include "mozilla/HalTypes.h"
#include "HardwareKeyboardManager.h"
#include "nsIDOMClassInfo.h"
#include "mozilla/Preferences.h"
#include "nsDOMEventTargetHelper.h"
#include "mozilla/dom/HardwareKeyboardManagerBinding.h"

#include "android/log.h"
#define LOG(args...)                                            \
    __android_log_print(ANDROID_LOG_INFO, "HardwareKeyboardManager" , ## args)

/**
 * We have to use macros here because our leak analysis tool things we are
 * leaking strings when we have |static const nsString|. Sad :(
 */
#define HW_KEYBOARD_PRESENT_CHANGE_EVENT_NAME           NS_LITERAL_STRING("hwkeyboardpresentchange")

DOMCI_DATA(HardwareKeyboardManager, mozilla::dom::hardwarekeyboard::HardwareKeyboardManager)

namespace mozilla {
namespace dom {
namespace hardwarekeyboard {

HardwareKeyboardManager::HardwareKeyboardManager() : mNumHWKeyboards(0)
{
  SetIsDOMBinding();
}

void
HardwareKeyboardManager::Init(nsPIDOMWindow* aWindow)
{
  BindToOwner(aWindow);
  hal::RegisterHardwareKeyboardObserver(this);
  hal::HardwareKeyboardList aHWKeyboardList;
  hal::GetCurrentHardwareKeyboardList(&aHWKeyboardList);
  mNumHWKeyboards = aHWKeyboardList.hwKeyboards().Capacity();
}

void
HardwareKeyboardManager::Shutdown()
{
  hal::UnregisterHardwareKeyboardObserver(this);
}

JSObject*
HardwareKeyboardManager::WrapObject(JSContext* aCx, JS::Handle<JSObject*> aScope)
{
  return HardwareKeyboardManagerBinding::Wrap(aCx, aScope, this);
}

bool
HardwareKeyboardManager::IsPresent() const
{
  return (mNumHWKeyboards > 0);
}

void
HardwareKeyboardManager::Notify(const hal::HardwareKeyboardList& aHardwareKeyboardList)
{
  uint32_t oldNumHWKeyboards = mNumHWKeyboards;
  mNumHWKeyboards = aHardwareKeyboardList.hwKeyboards().Length();
  if ((mNumHWKeyboards > 0 && (oldNumHWKeyboards == 0)) ||
      (mNumHWKeyboards == 0 && oldNumHWKeyboards > 0)) {
    DispatchTrustedEvent(HW_KEYBOARD_PRESENT_CHANGE_EVENT_NAME);
  }
}

} // namespace hardwarekeyboard
} // namespace dom
} // namespace mozilla
