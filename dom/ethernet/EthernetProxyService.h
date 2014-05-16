/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef EthernetProxyService_h
#define EthernetProxyService_h

#include "nsIEthernetService.h"
#include "nsCOMPtr.h"
#include "nsThread.h"
#include "mozilla/dom/EthernetOptionsBinding.h"
#include "nsTArray.h"

namespace mozilla {

class EthernetProxyService MOZ_FINAL : public nsIEthernetProxyService
{
private:
  struct EventThreadListEntry
  {
    nsCOMPtr<nsIThread> mThread;
    nsCString mInterface;
  };

public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIETHERNETPROXYSERVICE

  static already_AddRefed<EthernetProxyService>
  FactoryCreate();

  void DispatchEthernetResult(const mozilla::dom::EthernetResultOptions& aOptions,
                          const nsACString& aInterface);

private:
  EthernetProxyService();
  ~EthernetProxyService();

  nsTArray<EventThreadListEntry> mEventThreadList;
  nsCOMPtr<nsIThread> mControlThread;
  nsCOMPtr<nsIEthernetEventListener> mListener;
};

} // namespace mozilla

#endif // EthernetProxyService_h
