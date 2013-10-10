/*
 * trungnt
 */

#ifndef NS_HW_KEYBOARD_OBSERVER_H
#define NS_HW_KEYBOARD_OBSERVER_H

#include "nsISupports.h"
#include "nsIHWKeyboardObserver.h"

class nsHWKeyboardObserver : public nsIHWKeyboardObserver
{
public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIHWKEYBOARDOBSERVER

  nsHWKeyboardObserver();

private:
  ~nsHWKeyboardObserver();

protected:
  /* additional members */
  bool mPresent;
};

#endif