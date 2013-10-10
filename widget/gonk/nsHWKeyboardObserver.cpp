/*
 * trungnt
 */

#include "nsHWKeyboardObserver.h"
#include "nsIObserverService.h"
#include "mozilla/Services.h"
#include <nsThreadUtils.h>

static nsCOMPtr<nsIObserverService> obsService = mozilla::services::GetObserverService();

class HWKeyboardPresentChangedEvent: public nsRunnable
{
  NS_IMETHOD Run()
  {
    if (!obsService) {
      obsService = mozilla::services::GetObserverService();
    }
    if (obsService) {
      // well, we don't really need the value in this case, because we can use GetPresent for that
      obsService->NotifyObservers(nullptr, "hardware-keyboard-present-changed", nullptr);
    } else {
      // do something here?
    }

    return NS_OK;
  }
};

static  nsRefPtr<HWKeyboardPresentChangedEvent> hwKbEvent = new HWKeyboardPresentChangedEvent();

NS_IMPL_ISUPPORTS1(nsHWKeyboardObserver, nsIHWKeyboardObserver)


nsHWKeyboardObserver::nsHWKeyboardObserver():
	mPresent(false)
{
  /* member initializers and constructor code */
}

nsHWKeyboardObserver::~nsHWKeyboardObserver()
{
  /* destructor code */
}

/* readonly attribute bool present; */
NS_IMETHODIMP nsHWKeyboardObserver::GetPresent(bool *aPresent)
{
	if (aPresent == 0) {
		return NS_ERROR_NULL_POINTER;
	}

	*aPresent = mPresent;
  return NS_OK;
}

/* void notifyState (in bool present); */
NS_IMETHODIMP nsHWKeyboardObserver::NotifyPresentChanged(bool present)
{
	bool needNotify = (present != mPresent);
	mPresent = present;

  if (needNotify) {
    NS_DispatchToMainThread(hwKbEvent);
  }
  
  return NS_OK;
}

/* End of implementation class template. */