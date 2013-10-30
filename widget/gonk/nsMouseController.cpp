/* Copyright 2012 Mozilla Foundation and Mozilla contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#include <nsMouseController.h>
#include "nsIObserverService.h"
#include "mozilla/Services.h"
#include <nsThreadUtils.h>
#include <nsArray.h>

#define MOUSE_VISIBLE_CHANGE_EVENT "mouse-cursor-visible-changed"

static nsCOMPtr<nsIObserverService> obsService = mozilla::services::GetObserverService();
static nsTArray<int32_t> mouseDevices;
static bool sVisible = false;

class MouseVisibleChangedEvent: public nsRunnable
{
  NS_IMETHOD Run()
  {
    if (!obsService) {
      obsService = mozilla::services::GetObserverService();
    }
    if (obsService) {
      // we don't really need the value in this case, because we can use visible property for that
      obsService->NotifyObservers(nullptr, MOUSE_VISIBLE_CHANGE_EVENT, nullptr);
    }

    return NS_OK;
  }
};

static  nsRefPtr<MouseVisibleChangedEvent> mouseEvent = new MouseVisibleChangedEvent();

NS_IMPL_ISUPPORTS1(nsMouseController, nsIMouseController)

nsMouseController::nsMouseController()
{
    /* member initializers and constructor code */
}

nsMouseController::~nsMouseController()
{
    /* destructor code */
}

/* readonly attribute bool present; */
NS_IMETHODIMP nsMouseController::GetPresent(bool *aPresent)
{
  if (aPresent == 0) {
    return NS_ERROR_NULL_POINTER;
  }
  *aPresent = ((mouseDevices.Capacity() > 0));
  return NS_OK;
}

/* readonly attribute bool visible; */
NS_IMETHODIMP nsMouseController::GetVisible(bool *aVisible)
{
  if (aVisible == 0) {
    return NS_ERROR_NULL_POINTER;
  }
  *aVisible = ((mouseDevices.Capacity() > 0) && sVisible);
  return NS_OK;
}

/* void notifyPresentChanged (in boolean present); */
NS_IMETHODIMP nsMouseController::NotifyPresentChanged(int32_t deviceId, bool present)
{
  bool inList = mouseDevices.Contains(deviceId);
  if ((inList && present) || !(inList || present)) {
    // do nothing
    return NS_OK;
  }
  bool oldPresent = (mouseDevices.Capacity() > 0);

  if (present) {
    mouseDevices.AppendElement(deviceId);
  } else {
    mouseDevices.RemoveElement(deviceId);
  }

  // let's trigger an event
  bool newPresent = (mouseDevices.Capacity() > 0);
  if (oldPresent != newPresent) {
    // sVisible = false;
    NS_DispatchToMainThread(mouseEvent);
  }
  return NS_OK;
}

/* void SetVisible (in boolean visible); */
NS_IMETHODIMP nsMouseController::SetVisible(bool visible)
{
  if (mouseDevices.Capacity() <= 0 || visible == sVisible) {
    return NS_OK;
  }

  sVisible = visible;

  NS_DispatchToMainThread(mouseEvent);
  return NS_OK;
}
