#include "nsHWKeyboardObserver.h"
#include "nsIObserverService.h"
#include "mozilla/Services.h"
#include <nsThreadUtils.h>

#define LOG(args...)                                            \
    __android_log_print(ANDROID_LOG_INFO, "Gonk" , ## args)


static nsCOMPtr<nsIObserverService> obsService = mozilla::services::GetObserverService();

NS_IMPL_ISUPPORTS1(nsHWKeyboardObserver, nsIHWKeyboardObserver)


nsHWKeyboardObserver::nsHWKeyboardObserver():
	mCount(0)
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
	*aPresent = (mCount > 0);
  return NS_OK;
}

/* void notifyHWKeyboardChanged (in bool isAdded); */
NS_IMETHODIMP nsHWKeyboardObserver::NotifyHWKeyboardChanged(bool isAdded)
{
  LOG("nsHWKeyboardObserver::notifyHWKeyboardChanged:: %d", mCount);
  if (isAdded) {
    mCount++;
  } else {
    mCount--;
  }
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

/* End of implementation class template. */
