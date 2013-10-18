/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "EthernetUtils.h"

#include <cutils/properties.h>

/*
 * static stuff
 */

EthernetBackendImpl::EthernetBackendImpl()
{
}

int32_t
EthernetBackendImpl::getEthernetStats(const char *ifname, mozilla::dom::EthernetResultOptions& result)
{
  // nothing here right now
	return 0;
}

//====================================

EthernetBackend::EthernetBackend()
{
	mImpl = new EthernetBackendImpl();
  mNetUtils = new NetUtils();
}

#define GET_CHAR(prop) NS_ConvertUTF16toUTF8(aOptions.prop).get()

bool
EthernetBackend::ExecuteCommand(CommandOptions aOptions,
                      			mozilla::dom::EthernetResultOptions& aResult,
                      			const nsCString& aInterface)
{
  if (!mNetUtils->GetSharedLibrary()) {
    return false;
  }

  // Always correlate the opaque ids.
  aResult.mId = aOptions.mId;

  if (aOptions.mCmd.EqualsLiteral("get_ethernet_stats")) {
    mImpl->getEthernetStats(aInterface.get(), aResult);
  } else if (aOptions.mCmd.EqualsLiteral("ifc_enable")) {
    aResult.mStatus = mNetUtils->do_ifc_enable(aInterface.get());
  } else if (aOptions.mCmd.EqualsLiteral("ifc_disable")) {
    aResult.mStatus = mNetUtils->do_ifc_disable(aInterface.get());
  } else if (aOptions.mCmd.EqualsLiteral("dhcp_do_request")) {
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
    aResult.mStatus = mNetUtils->do_dhcp_stop(aInterface.get());
  } else {
    NS_WARNING("EthernetBackend::ExecuteCommand : Unknown command");
    printf_stderr("EthernetBackend::ExecuteCommand : Unknown command: %s",
      NS_ConvertUTF16toUTF8(aOptions.mCmd).get());
    return false;
  }

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
