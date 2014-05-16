/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Abstraction on top of the Ethernet support from libnetutils & other low level stuff
 * that we use to work with Ethernet
 */

#ifndef ETHERNET_UTILS_H
#define ETHERNET_UTILS_H

#include "nsString.h"
#include "nsAutoPtr.h"
#include "mozilla/dom/EthernetOptionsBinding.h"
#include "mozilla/dom/network/NetUtils.h"
#include "nsCxPusher.h"

// Needed to add a copy constructor to EthernetCommandOptions.
struct CommandOptions
{
public:
  CommandOptions(const CommandOptions& aOther) {
    mId = aOther.mId;
    mCmd = aOther.mCmd;
    mRequest = aOther.mRequest;
    mIfname = aOther.mIfname;
    mRoute = aOther.mRoute;
    mIpaddr = aOther.mIpaddr;
    mPrefixLength = aOther.mPrefixLength;
    mGateway = aOther.mGateway;
    mDns1 = aOther.mDns1;
    mDns2 = aOther.mDns2;
    mKey = aOther.mKey;
    mValue = aOther.mValue;
    mDefaultValue = aOther.mDefaultValue;
  }

  CommandOptions(const mozilla::dom::EthernetCommandOptions& aOther) {

#define COPY_OPT_FIELD(prop, defaultValue)            \
    if (aOther.prop.WasPassed()) {                    \
      prop = aOther.prop.Value();                     \
    } else {                                          \
      prop = defaultValue;                            \
    }

#define COPY_FIELD(prop) prop = aOther.prop;
    COPY_FIELD(mId)
    COPY_FIELD(mCmd)
    COPY_OPT_FIELD(mRequest, EmptyString())
    COPY_OPT_FIELD(mIfname, EmptyString())
    COPY_OPT_FIELD(mIpaddr, 0)
    COPY_OPT_FIELD(mRoute, 0)
    COPY_OPT_FIELD(mPrefixLength, 0)
    COPY_OPT_FIELD(mGateway, 0)
    COPY_OPT_FIELD(mDns1, 0)
    COPY_OPT_FIELD(mDns2, 0)
    COPY_OPT_FIELD(mKey, EmptyString())
    COPY_OPT_FIELD(mValue, EmptyString())
    COPY_OPT_FIELD(mDefaultValue, EmptyString())

#undef COPY_OPT_FIELD
#undef COPY_FIELD
  }

  // All the fields, not Optional<> anymore to get copy constructors.
  nsString mCmd;
  nsString mDefaultValue;
  int32_t mDns1;
  int32_t mDns2;
  int32_t mGateway;
  int32_t mId;
  nsString mIfname;
  int32_t mIpaddr;
  nsString mKey;
  int32_t mPrefixLength;
  nsString mRequest;
  int32_t mRoute;
  nsString mValue;
};

class EthernetBackendImpl
{
public:
  EthernetBackendImpl();
  virtual ~EthernetBackendImpl() {};

  virtual int32_t
  getEthernetStats(const char *ifname, mozilla::dom::EthernetResultOptions& result); // not this kind of result :|

};

// Concrete class to use to access the EthernetBackend
class EthernetBackend MOZ_FINAL
{
public:
  EthernetBackend();

  // Use nsCString as the type of aInterface to guarantee it's
  // null-terminated so that we can pass it to c API without
  // conversion
  // void WaitForEvent(nsAString& aEvent, const nsCString& aInterface);
  bool ExecuteCommand(CommandOptions aOptions,
                      mozilla::dom::EthernetResultOptions& result,
                      const nsCString& aInterface);

private:
  nsAutoPtr<EthernetBackendImpl> mImpl;
  nsAutoPtr<NetUtils> mNetUtils;

protected:
  // void CheckBuffer(char* buffer, int32_t length, nsAString& aEvent);
  uint32_t MakeMask(uint32_t len);
};

#endif