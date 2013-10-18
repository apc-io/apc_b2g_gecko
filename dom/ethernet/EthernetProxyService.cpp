/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "EthernetProxyService.h"
#include "nsServiceManagerUtils.h"
#include "mozilla/ModuleUtils.h"
#include "mozilla/ClearOnShutdown.h"
#include "nsXULAppAPI.h"
#include "EthernetUtils.h"
#include "nsCxPusher.h"

#define NS_ETHERNETPROXYSERVICE_CID \
  { 0x45d74081, 0x950a, 0x49c2, {0xbb, 0xf1, 0x3b, 0xbd, 0xcf, 0xe7, 0xfa, 0x62} }

using namespace mozilla;
using namespace mozilla::dom;

namespace mozilla {

// The singleton Ethernet service, to be used on the main thread.
static StaticRefPtr<EthernetProxyService> gEthernetProxyService;

// The singleton supplicant class, that can be used on any thread.
static nsAutoPtr<EthernetBackend> gEthernetBackend;

/**
 * Command executor & result dispatcher
 */
//Runnable used dispatch the Command result on the main thread.
class EthernetResultDispatcher : public nsRunnable
{
public:
  EthernetResultDispatcher(EthernetResultOptions& aResult, const nsACString& aInterface)
    : mInterface(aInterface)
  {
    MOZ_ASSERT(!NS_IsMainThread());

    // XXX: is there a better way to copy webidl dictionnaries?
    // the copy constructor is private.
#define COPY_FIELD(prop) mResult.prop = aResult.prop;

    COPY_FIELD(mId)
    COPY_FIELD(mStatus)
    COPY_FIELD(mReply)
    COPY_FIELD(mRoute)
    COPY_FIELD(mError)
    COPY_FIELD(mValue)
    COPY_FIELD(mIpaddr_str)
    COPY_FIELD(mGateway_str)
    COPY_FIELD(mBroadcast_str)
    COPY_FIELD(mDns1_str)
    COPY_FIELD(mDns2_str)
    COPY_FIELD(mMask_str)
    COPY_FIELD(mServer_str)
    COPY_FIELD(mVendor_str)
    COPY_FIELD(mLease)
    COPY_FIELD(mMask)
    COPY_FIELD(mIpaddr)
    COPY_FIELD(mGateway)
    COPY_FIELD(mDns1)
    COPY_FIELD(mDns2)
    COPY_FIELD(mServer)
    COPY_FIELD(mCableConnected)
    COPY_FIELD(mUp)

#undef COPY_FIELD
  }

  NS_IMETHOD Run()
  {
    MOZ_ASSERT(NS_IsMainThread());
    gEthernetProxyService->DispatchEthernetResult(mResult, mInterface);
    return NS_OK;
  }

private:
  EthernetResultOptions mResult;
  nsCString mInterface;
};

// Runnable used to call SendCommand on the control thread.
class EthernetControlRunnable : public nsRunnable
{
public:
  EthernetControlRunnable(CommandOptions aOptions, const nsACString& aInterface)
    : mOptions(aOptions)
    , mInterface(aInterface)
  {
    MOZ_ASSERT(NS_IsMainThread());
  }

  NS_IMETHOD Run()
  {
    EthernetResultOptions result;
    if (gEthernetBackend->ExecuteCommand(mOptions, result, mInterface)) {
      nsCOMPtr<nsIRunnable> runnable = new EthernetResultDispatcher(result, mInterface);
      NS_DispatchToMainThread(runnable);
    }
    return NS_OK;
  }
private:
   CommandOptions mOptions;
   nsCString mInterface;
};

NS_IMPL_ISUPPORTS1(EthernetProxyService, nsIEthernetProxyService)

EthernetProxyService::EthernetProxyService()
{
  /* member initializers and constructor code */
  MOZ_ASSERT(NS_IsMainThread());
  MOZ_ASSERT(!gEthernetProxyService);
}

EthernetProxyService::~EthernetProxyService()
{
  /* destructor code */
  MOZ_ASSERT(!gEthernetProxyService);
}

already_AddRefed<EthernetProxyService>
EthernetProxyService::FactoryCreate()
{
  if (XRE_GetProcessType() != GeckoProcessType_Default) {
    return nullptr;
  }

  MOZ_ASSERT(NS_IsMainThread());

  if (!gEthernetProxyService) {
    gEthernetProxyService = new EthernetProxyService();
    ClearOnShutdown(&gEthernetProxyService);

    gEthernetBackend = new EthernetBackend();
    ClearOnShutdown(&gEthernetBackend);
  }

  nsRefPtr<EthernetProxyService> service = gEthernetProxyService.get();
  return service.forget();
}


/* void start (in nsIEthernetEventListener listener, [array, size_is (aNumOfInterface)] in string aInterfaces, in unsigned long aNumOfInterface); */
NS_IMETHODIMP EthernetProxyService::Start(nsIEthernetEventListener *aListener,
                                          const char * *aInterfaces,
                                          uint32_t aNumOfInterfaces)
{
  MOZ_ASSERT(NS_IsMainThread());
  MOZ_ASSERT(aListener);

  nsresult rv;

  // Since EventRunnable runs in the manner of blocking, we have to
  // spin a thread for each interface.
  // (See the WpaSupplicant::WaitForEvent)
  mEventThreadList.SetLength(aNumOfInterfaces);
  for (uint32_t i = 0; i < aNumOfInterfaces; i++) {
    mEventThreadList[i].mInterface = aInterfaces[i];
    rv = NS_NewThread(getter_AddRefs(mEventThreadList[i].mThread));
    if (NS_FAILED(rv)) {
      NS_WARNING("Can't create wifi event thread");
      Shutdown();
      return NS_ERROR_FAILURE;
    }
  }

  rv = NS_NewThread(getter_AddRefs(mControlThread));
  if (NS_FAILED(rv)) {
    NS_WARNING("Can't create wifi control thread");
    Shutdown();
    return NS_ERROR_FAILURE;
  }

  mListener = aListener;

  return NS_OK;
}

/* void shutdown (); */
NS_IMETHODIMP EthernetProxyService::Shutdown()
{
    return NS_OK;
}

/* [implicit_jscontext] void sendCommand (in jsval parameters, in ACString aInterface); */
NS_IMETHODIMP EthernetProxyService::SendCommand(JS::HandleValue aParameters,
                                                const nsACString & aInterface,
                                                JSContext* aCx)
{
  MOZ_ASSERT(NS_IsMainThread());
  EthernetCommandOptions options;

  if (!options.Init(aCx, aParameters)) {
    NS_WARNING("Bad dictionary passed to EthernetProxyService::SendCommand");
    return NS_ERROR_FAILURE;
  }

  // Dispatch the command to the control thread.
  CommandOptions commandOptions(options);
  nsCOMPtr<nsIRunnable> runnable = new EthernetControlRunnable(commandOptions, aInterface);
  mControlThread->Dispatch(runnable, nsIEventTarget::DISPATCH_NORMAL);
  return NS_OK;
}

/* void waitForEvent (in ACString aInterface); */
NS_IMETHODIMP EthernetProxyService::WaitForEvent(const nsACString & aInterface)
{
    return NS_OK;
}

void
EthernetProxyService::DispatchEthernetResult(const EthernetResultOptions& aOptions, const nsACString& aInterface)
{
  MOZ_ASSERT(NS_IsMainThread());

  mozilla::AutoSafeJSContext cx;
  JS::Rooted<JS::Value> val(cx);

  if (!aOptions.ToObject(cx, JS::NullPtr(), &val)) {
    return;
  }

  // Call the listener with a JS value.
  mListener->OnCommand(val, aInterface);
}

NS_GENERIC_FACTORY_SINGLETON_CONSTRUCTOR(EthernetProxyService,
                                         EthernetProxyService::FactoryCreate)

NS_DEFINE_NAMED_CID(NS_ETHERNETPROXYSERVICE_CID);

static const mozilla::Module::CIDEntry kEthernetProxyServiceCIDs[] = {
  { &kNS_ETHERNETPROXYSERVICE_CID, false, nullptr, EthernetProxyServiceConstructor },
  { nullptr }
};

static const mozilla::Module::ContractIDEntry kEthernetProxyServiceContracts[] = {
  { "@mozilla.org/ethernet/service;1", &kNS_ETHERNETPROXYSERVICE_CID },
  { nullptr }
};

static const mozilla::Module kEthernetProxyServiceModule = {
  mozilla::Module::kVersion,
  kEthernetProxyServiceCIDs,
  kEthernetProxyServiceContracts,
  nullptr
};

} // namespace mozilla

NSMODULE_DEFN(EthernetProxyServiceModule) = &kEthernetProxyServiceModule;