/* -*- Mode: Java; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");

var DEBUG = true; // set to true to show debug messages

const ETHERNETWORKER_CONTRACTID = "@mozilla.org/ethernet/worker;1";
const ETHERNETWORKER_CID        = Components.ID("{e67531d8-db78-4909-b9cb-ff9e497eec17}");

const ETHERNETWORKER_WORKER     = "resource://gre/modules/ethernet_worker.js";

const kNetworkInterfaceStateChangedTopic = "network-interface-state-changed";
const kMozSettingsChangedObserverTopic   = "mozsettings-changed";

const MAX_RETRIES_ON_AUTHENTICATION_FAILURE = 2;
const MAX_SUPPLICANT_LOOP_ITERATIONS = 4;

// Settings DB path for ETHERNET
const SETTINGS_ETHERNET_ENABLED            = "ethernet.enabled";
const SETTINGS_ETHERNET_DEBUG_ENABLED      = "ethernet.debugging.enabled";

// Default value for ETHERNET tethering.
const DEFAULT_ETHERNET_IP                  = "192.168.1.1";
const DEFAULT_ETHERNET_PREFIX              = "24";
const DEFAULT_ETHERNET_DHCPSERVER_STARTIP  = "192.168.1.10";
const DEFAULT_ETHERNET_DHCPSERVER_ENDIP    = "192.168.1.30";
const DEFAULT_ETHERNET_SSID                = "FirefoxHotspot";
const DEFAULT_DNS1                     = "8.8.8.8";
const DEFAULT_DNS2                     = "8.8.4.4";

const NETWORK_INTERFACE_UP   = "up";
const NETWORK_INTERFACE_DOWN = "down";

const DEFAULT_ETHERNET_NETWORK_IFACE = "eth0";

const TOPIC_NETD_INTEFACE_CHANGED    = "netd-interface-change";
const TOPIC_INTERFACE_STATE_CHANGED  = "network-interface-state-changed";
const TOPIC_INTERFACE_REGISTERED     = "network-interface-registered";
const TOPIC_INTERFACE_UNREGISTERED   = "network-interface-unregistered";
const TOPIC_ACTIVE_CHANGED           = "network-active-changed";

XPCOMUtils.defineLazyServiceGetter(this, "gNetworkManager",
                                   "@mozilla.org/network/manager;1",
                                   "nsINetworkManager");

XPCOMUtils.defineLazyServiceGetter(this, "gSettingsService",
                                   "@mozilla.org/settingsService;1",
                                   "nsISettingsService");

var EthernetWorker = (function() {
	debug("Ok, we will just start it here");

	var controlWorker = new ChromeWorker(ETHERNETWORKER_WORKER);
    controlWorker.onmessage = function(e) {
      debug("we got the message from controlWorker: " + e.data);
    }

    controlWorker.onerror = function(e) {
      debug("eo`, error: " + e);
    }

    controlWorker.postMessage("Say hello from EthernetWorker.js");

    gNetworkManager.getEthernetStats(DEFAULT_ETHERNET_NETWORK_IFACE, this);

    var _enabled = true;
    var _connected = false;
    var _cableConnected = false;
    var _ipaddress = null;
    var _hwaddress = null;
    var _gw = null;
    var _dns1 = null;
    var _dns2 = null;

    this._mm = Cc["@mozilla.org/parentprocessmessagemanager;1"]
               .getService(Ci.nsIMessageListenerManager);
    const messages = ["EthernetManager:getState", "WifiManager:getKnownNetworks",
                    "WifiManager:associate", "WifiManager:forget",
                    "WifiManager:wps", "WifiManager:getState",
                    "WifiManager:setPowerSavingMode",
                    "child-process-shutdown"];

    messages.forEach((function(msgName) {
      this._mm.addMessageListener(msgName, this);
    }).bind(this));
});

EthernetWorker.prototype = {
  classID:   ETHERNETWORKER_CID,
  classInfo: XPCOMUtils.generateCI({classID: ETHERNETWORKER_CID,
                                    contractID: ETHERNETWORKER_CONTRACTID,
                                    classDescription: "EthernetWorker",
                                    interfaces: [Ci.nsIWorkerHolder,
                                                 Ci.nsIEthernet,
                                                 Ci.nsIObserver]}),

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIWorkerHolder,
  	                                     Ci.nsIObserver,
                                         Ci.nsIMessageListener,
                                         Ci.nsIEthernet,
                                         Ci.nsISettingsServiceCallback]),

  observe: function observe(subject, topic, data) {
  	debug("observer function :)");
  },

  receiveMessage: function MessageManager_receiveMessage(aMessage) {
    debug("receiveMessage: " + aMessage.data + " with target : " + aMessage.target);
    for (let k in aMessage) {
      debug(",,,,,,,, aMessage." + k + ": " + aMessage[k]);
    }
  },

  shutdown: function nsIEthernet_shutdown() {
    debug("This is the nsIEthernet_shutdown function");
  },

    /**
   * function must be called whenever one of:
   *  - enabled
   *  - cableConnected
   *  - ipaddress
   * changed
   */
  _checkConnection: function() {
  	debug("So, here we'll _checkConnection");
    let ret = this._enabled && this._cableConnected && this._ipaddress != "";
    if (this._connected != ret) {
      this._connected = ret;
      if (this._onconnectedchange) {
        // trigger event
        this._onconnectedchange();
      }
    }

    if (this._connected) {
      EthernetNetworkInterface.state = EthernetNetworkInterface.NETWORK_STATE_CONNECTED;
    } else {
      EthernetNetworkInterface.state = EthernetNetworkInterface.NETWORK_STATE_DISCONNECTED;
    }

    gNetworkManager.overrideActive(EthernetNetworkInterface);
  },

  ethernetStatsAvailable: function nsIEthernetStatsCallback_ethernetStatsAvailable(
    result, connected, details, date
    ) {
    // TODO: we also need to get current ip address to determined if the network is connected
    debug("The request result is: " + result);
    debug("The connected state is: " + connected);
    // debug("time of request is: " + date);
    if (result) {
      this._cableConnected = connected;
      // debug("We got the ipaddress: " + details.ip);
      for (let k in details) {
        debug("______ details." + k + ": " + details[k]);
      }
      this._hwaddress = details.hwaddress;
      this._ipaddress = details.ip.trim();
      this._gw = details.gw;
      this._dns1 = details.dns1;
      this._dns2 = details.dns2;
      this._checkConnection();
      EthernetNetworkInterface.ip = details.ip.trim();
      EthernetNetworkInterface.broadcast = "";
      EthernetNetworkInterface.netmask = "";
      EthernetNetworkInterface.dns1 = details.dns1;
      EthernetNetworkInterface.dns2 = details.dns2;
    }
  },
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([EthernetWorker]);

let EthernetNetworkInterface = {

  QueryInterface: XPCOMUtils.generateQI([Ci.nsINetworkInterface]),

  registered: false,

  // nsINetworkInterface

  NETWORK_STATE_UNKNOWN:       Ci.nsINetworkInterface.NETWORK_STATE_UNKNOWN,
  NETWORK_STATE_CONNECTING:    Ci.nsINetworkInterface.CONNECTING,
  NETWORK_STATE_CONNECTED:     Ci.nsINetworkInterface.CONNECTED,
  NETWORK_STATE_DISCONNECTING: Ci.nsINetworkInterface.DISCONNECTING,
  NETWORK_STATE_DISCONNECTED:  Ci.nsINetworkInterface.DISCONNECTED,

  state: Ci.nsINetworkInterface.NETWORK_STATE_UNKNOWN,

  NETWORK_TYPE_WIFI:        Ci.nsINetworkInterface.NETWORK_TYPE_WIFI,
  NETWORK_TYPE_MOBILE:      Ci.nsINetworkInterface.NETWORK_TYPE_MOBILE,
  NETWORK_TYPE_MOBILE_MMS:  Ci.nsINetworkInterface.NETWORK_TYPE_MOBILE_MMS,
  NETWORK_TYPE_MOBILE_SUPL: Ci.nsINetworkInterface.NETWORK_TYPE_MOBILE_SUPL,
  NETWORK_TYPE_ETHERNET:    Ci.nsINetworkInterface.NETWORK_TYPE_ETHERNET,

  type: Ci.nsINetworkInterface.NETWORK_TYPE_ETHERNET,

  name: null,

  // For now we do our own DHCP. In the future this should be handed off
  // to the Network Manager.
  dhcp: false,

  ip: null,

  netmask: null,

  broadcast: null,

  dns1: null,

  dns2: null,

  httpProxyHost: null,

  httpProxyPort: null,

};

let debug;
if (DEBUG) {
  debug = function (s) {
    dump("-*- EthernetWorker.js component: " + s + "\n");
  };
} else {
  debug = function (s) {};
}