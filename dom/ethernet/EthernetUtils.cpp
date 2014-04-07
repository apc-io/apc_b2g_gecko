/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//Slacker LOG

#define SSLOG_ENABLED
#ifdef SSLOG_ENABLED

#ifdef __cplusplus
#include <cstdio>
#else
#include <stdio.h>
#endif

#include <android/log.h>

#define SSLOG_TAG_WARNING "W"
#define SSLOG_TAG_INFO "I"
#define SSLOG_TAG_DEBUG "D"

#ifdef __cplusplus
#define SSLOG(tag, args...) \
{ \
  std::printf("[%s] %s:%s", tag, __FILE__, __PRETTY_FUNCTION__); \
  std::printf(args); \
  std::printf("\n"); \
}
#else
#define SSLOG(tag, args...) \
{ \
  printf("[%s] %s:%s", tag, __FILE__, __PRETTY_FUNCTION__); \
  printf(args); \
  printf("\n"); \
}
#endif

#define ANDRTAG __PRETTY_FUNCTION__

#define SSLOGI(...) { \
  SSLOG(SSLOG_TAG_INFO, __VA_ARGS__); \
  __android_log_print(ANDROID_LOG_INFO, ANDRTAG, __VA_ARGS__); \
}

#define SSLOGW(...) {\
  SSLOG(SSLOG_TAG_WARNING, __VA_ARGS__); \
  __android_log_print(ANDROID_LOG_WARN, ANDRTAG, __VA_ARGS__);\
}

#define SSLOGD(...) {\
  SSLOG(SSLOG_TAG_DEBUG, __VA_ARGS__); \
  __android_log_print(ANDROID_LOG_DEBUG, ANDRTAG, __VA_ARGS__);\
}

// just print the function signature and the file name
#define SSLOGF() {\
  SSLOG(SSLOG_TAG_INFO, " "); \
  __android_log_print(ANDROID_LOG_INFO, __FILE__, "%s", __PRETTY_FUNCTION__); \
}

#else

#define SSLOGI(...)
#define SSLOGW(...)
#define SSLOGD(...)
#define SSLOGF(...)

#endif


#include "EthernetUtils.h"

#include <cutils/properties.h>

/*
 * static stuff
 */

EthernetBackendImpl::EthernetBackendImpl()
{
	SSLOGF();
}

int32_t
EthernetBackendImpl::getEthernetStats(const char *ifname, mozilla::dom::EthernetResultOptions& result)
{
	SSLOGI("%s", ifname);
	//
	return 0;
}

//====================================

EthernetBackend::EthernetBackend()
{
	SSLOGF();
	mImpl = new EthernetBackendImpl();
  mNetUtils = new NetUtils();
}

#define GET_CHAR(prop) NS_ConvertUTF16toUTF8(aOptions.prop).get()

bool
EthernetBackend::ExecuteCommand(CommandOptions aOptions,
                      			mozilla::dom::EthernetResultOptions& aResult,
                      			const nsCString& aInterface)
{
	SSLOGF();
  if (!mNetUtils->GetSharedLibrary()) {
    SSLOGI("Could not get shared library");
    return false;
  }

  SSLOGI("Ok, start ...");

  // Always correlate the opaque ids.
  aResult.mId = aOptions.mId;

  if (aOptions.mCmd.EqualsLiteral("get_ethernet_stats")) {
    mImpl->getEthernetStats(aInterface.get(), aResult);
  } else if (aOptions.mCmd.EqualsLiteral("ifc_enable")) {
    SSLOGI("do_ifc_enable");
    aResult.mStatus = mNetUtils->do_ifc_enable(aInterface.get());
  } else if (aOptions.mCmd.EqualsLiteral("ifc_disable")) {
    SSLOGI("do_ifc_disable");
    aResult.mStatus = mNetUtils->do_ifc_disable(aInterface.get());
  } else if (aOptions.mCmd.EqualsLiteral("dhcp_do_request")) {
    SSLOGI("dhcp_do_request");
    // aResult.mStatus = mNetUtils->dhcp_do_request()
    char ipaddr[PROPERTY_VALUE_MAX];
    char gateway[PROPERTY_VALUE_MAX];
    uint32_t prefixLength;
    char dns1[PROPERTY_VALUE_MAX];
    char dns2[PROPERTY_VALUE_MAX];
    char server[PROPERTY_VALUE_MAX];
    uint32_t lease;
    char vendorinfo[PROPERTY_VALUE_MAX];
    aResult.mStatus =
      mNetUtils->do_dhcp_do_request(GET_CHAR(mIfname),
                                    ipaddr,
                                    gateway,
                                    &prefixLength,
                                    dns1,
                                    dns2,
                                    server,
                                    &lease,
                                    vendorinfo);

    if (aResult.mStatus == -1) {
      // Early return since we failed.
      return true;
    }

    aResult.mIpaddr_str = NS_ConvertUTF8toUTF16(ipaddr);
    aResult.mGateway_str = NS_ConvertUTF8toUTF16(gateway);
    aResult.mDns1_str = NS_ConvertUTF8toUTF16(dns1);
    aResult.mDns2_str = NS_ConvertUTF8toUTF16(dns2);
    aResult.mServer_str = NS_ConvertUTF8toUTF16(server);
    aResult.mVendor_str = NS_ConvertUTF8toUTF16(vendorinfo);
    aResult.mLease = lease;
    aResult.mMask = MakeMask(prefixLength);

    uint32_t inet4; // only support IPv4 for now.

#define INET_PTON(var, field)                                                 \
  PR_BEGIN_MACRO                                                              \
    inet_pton(AF_INET, var, &inet4);                                          \
    aResult.field = inet4;                                                    \
  PR_END_MACRO

    INET_PTON(ipaddr, mIpaddr);
    INET_PTON(gateway, mGateway);

    if (dns1[0] != '\0') {
      INET_PTON(dns1, mDns1);
    }

    if (dns2[0] != '\0') {
      INET_PTON(dns2, mDns2);
    }

    INET_PTON(server, mServer);

    //aResult.mask_str = netHelpers.ipToString(obj.mask);
    char inet_str[64];
    if (inet_ntop(AF_INET, &aResult.mMask, inet_str, sizeof(inet_str))) {
      aResult.mMask_str = NS_ConvertUTF8toUTF16(inet_str);
    }

    uint32_t broadcast = (aResult.mIpaddr & aResult.mMask) + ~aResult.mMask;
    if (inet_ntop(AF_INET, &broadcast, inet_str, sizeof(inet_str))) {
      aResult.mBroadcast_str = NS_ConvertUTF8toUTF16(inet_str);
    }
  } else if (aOptions.mCmd.EqualsLiteral("dhcp_stop")) {
    SSLOGI("dhcp_stop");
    aResult.mStatus = mNetUtils->do_dhcp_stop(aInterface.get());
  } else {
    SSLOGI("Unknown command");
    NS_WARNING("EthernetBackend::ExecuteCommand : Unknown command");
    printf_stderr("EthernetBackend::ExecuteCommand : Unknown command: %s",
      NS_ConvertUTF16toUTF8(aOptions.mCmd).get());
    return false;
  }

  SSLOGI("Done :)");
	return true;
}

/**
 * Make a subnet mask.
 */
uint32_t EthernetBackend::MakeMask(uint32_t len) {
  uint32_t mask = 0;
  for (uint32_t i = 0; i < len; ++i) {
    mask |= (0x80000000 >> i);
  }
  return ntohl(mask);
}
