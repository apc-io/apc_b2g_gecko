/*
 * trungnt
 */
// "use strict";

this.EXPORTED_SYMBOLS = ["EthernetUtil"];

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/systemlibs.js");
Cu.import("resource://gre/modules/NetUtil.jsm");
Cu.import("resource://gre/modules/FileUtils.jsm");

Cu.import("resource://gre/modules/EthernetIPConfig.jsm");
Cu.import("resource://gre/modules/EthernetSettings.jsm");
Cu.import("resource://gre/modules/EthernetUtilPrivate.jsm");

// const kNetdInterfaceChangedTopic         = "netd-interface-change";
// const kNetworkInterfaceStateChangedTopic = "network-interface-state-changed";
// const kNetworkInterfaceRegisteredTopic   = "network-interface-registered";
// const kNetworkInterfaceUnregisteredTopic = "network-interface-unregistered";
// const kNetworkActiveChangedTopic         = "network-active-changed";


// const kNetworkInterfaceUp   = "up";
// const kNetworkInterfaceDown = "down";

const kDefaultEthernetNetworkIface = "eth0";

// const kNetdIfaceLinkStateMsg  = "Iface linkstate";
// const kInvalidHWAddr = "00:00:00:00:00:00";

var DEBUG = true; // set to true to show debug messages

let debug;
if (DEBUG) {
  debug = function (s) {
    dump("-*- EthernetUtil.js component: " + s + "\n");
  };
} else {
  debug = function (s) {};
}

let dumpObj = function(obj) {
  debug("-- DUmping Object --: " + obj);
  for (let k in obj) {
    debug("[DUMP] obj." + k + ": " + obj[k]);
  }
}

// we'll use EthernetUtil to manage thing
this.EthernetUtil = {
  init: function EthernetUtil_init() {
  	debug("EthernetUtil_init");

    EthernetSettings.setCallbackObject(EthernetSettingsCallBack);
    EthernetSettings.loadStartupPreferences();
    EthernetServiceCommunicator.initService();
    EthernetOBSObserver.init();
    debug(" TAKE ME TO THE WIND :)");
    // EthernetServiceCommunicator.initService();
    // EthernetBackend.initInterface(kDefaultEthernetNetworkIface);
    // EthernetOBSObserver.init();
  },

  // public interface

  enable: function EthernetUtil_enable() {
    EthernetSettings.saveEnabled(true);
    return EthernetBackend.initInterface(kDefaultEthernetNetworkIface);
  },

  disable: function EthernetUtil_disable() {
    EthernetSettings.saveEnabled(false);
    return EthernetBackend.shutdown();
  },

  connect: function EthernetUtil_connect() {
    return EthernetBackend.connectInterface(kDefaultEthernetNetworkIface);
  },

  disconnect: function EthernetUtil_disconnect() {
    return EthernetBackend.disconnectInterface(kDefaultEthernetNetworkIface);
  },

  setdhcpcd: function EthernetUtil_setdhcpcd(enabled) {
    if (enabled == EthernetBackend.useDhcpcd) {
      return; // nothing to do
    }
    // this.disconnect();
    // FIXME: What if enabled == false and there's no static ip settings? Let's connect() function do that
    // EthernetBackend.useDhcpcd = enabled;
    // // EthernetIfUtils.updateUseDhcp(enabled, kDefaultEthernetNetworkIface);
    // // this.connect();
    EthernetSettings.saveUseDhcp(enabled);
    EthernetBackend.renewInterface(kDefaultEthernetNetworkIface);
  },

  setstaticipconfig: function EthernetUtil_setstaticipconfig(config) {
    
  },

  setIpAddr: function EthernetUtil_setipaddr(ip) {
    debug("EthernetUtil_setipaddr " + ip);
    if (StaticIPConfig.setAddrStr(ip)) {
      debug("Ok, we'll have the addr is " + StaticIPConfig.addr);
      EthernetSettings.saveAddr(StaticIPConfig.addr);
      EthernetBackend.updateIpConfig(kDefaultEthernetNetworkIface);
    } else {
      debug("Is the ip invalid?");
    }
  },

  setGateway: function EthernetUtil_setGateway(gw) {
    debug("EthernetUtil_setGateway " + gw);
    if (StaticIPConfig.setGatewayStr(gw)) {
      EthernetSettings.saveGateway(StaticIPConfig.gateway);
      EthernetBackend.updateIpConfig(kDefaultEthernetNetworkIface);
    }
  },

  setNetmask: function EthernetUtil_setNetmask(mask) {
    debug("EthernetUtil_setNetmask " + mask);
    if (StaticIPConfig.setNetmaskStr(mask)) {
      EthernetSettings.saveNetmask(StaticIPConfig.mask);
      EthernetBackend.updateIpConfig(kDefaultEthernetNetworkIface);
    }
  },

  setDNS1: function EthernetUtil_setDNS1(dns1) {
    debug("EthernetUtil_setDNS1 " + dns1);
    if (StaticIPConfig.setDNS1Str(dns1)) {
      EthernetSettings.saveDNS1(StaticIPConfig.dns1);
      EthernetBackend.updateIpConfig(kDefaultEthernetNetworkIface);
    }
  },

  setDNS2: function EthernetUtil_setDNS2(dns2) {
    debug("EthernetUtil_setDNS2 " + dns2);
    if (StaticIPConfig.setDNS2Str(dns2)) {
      EthernetSettings.saveDNS2(StaticIPConfig.dns2);
      EthernetBackend.updateIpConfig(kDefaultEthernetNetworkIface);
    }
  },

  // enable/disable status
  getEnabled: function EthernetUtil_getEnabled() {
    debug("getEnabled, this.enabled = " + EthernetBackend.enabled);
    return EthernetBackend.enabled;
  },
  
  getConnected: function EthernetUtil_getConnected() {
    debug("get connected== " + EthernetBackend.connected);
    return EthernetBackend.connected;
  },

  getDhcp: function EthernetUtil_getDhcp() {
    debug("get dhcp = " + EthernetSettings.useDhcp);
    return EthernetSettings.useDhcp;
  },

  getConnection: function EthernetUtil_getConnection() {
    return EthernetIfUtils.getInterface(kDefaultEthernetNetworkIface);
  },

  getStaticConfig: function EthernetUtil_getStaticConfig() {
    debug("get static config" + StaticIPConfig);
    return StaticIPConfig;
  },

  setCallbackObject: function EthernetUtil_setCallbackObject(obj) {
    EthernetBackend.callbackObj = obj;
  },

};

// var EthernetSettingsCallBack = {
//   handleEthernetEnabled: function(enabled) {
//     if (enabled) {
//       EthernetBackend.initInterface(kDefaultEthernetNetworkIface);
//     } else {
//       EthernetBackend.shutdown();
//     }
//   },

//   handleUseDhcp: function(dhcp) {
//     debug("This is handle use dhcp");
//   },

//   handleStaticIpConfigReady: function(config) {
//     debug("So, we got the static Ip config!");
//     debug(config);
//   },
// }


// testing stuff
// StaticIPConfig.setAddrStr("192.168.0.111");
// StaticIPConfig.setNetmaskStr("255.255.255.0");
// StaticIPConfig.setGatewayStr("192.168.0.1");
// StaticIPConfig.setDNS1Str("8.8.8.8");
// StaticIPConfig.setDNS2Str("8.8.8.8");
this.EthernetUtil.init();
