/* -*- Mode: Java; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/DOMRequestHelper.jsm");

const DEBUG = true; // set to false to suppress debug messages

const DOMETHERNETMANAGER_CONTRACTID = "@mozilla.org/ethernetmanager;1";
const DOMETHERNETMANAGER_CID        = Components.ID("{c7c75ca2-ab41-4507-8293-77ed56a66cd6}");

XPCOMUtils.defineLazyServiceGetter(this, "gNetworkManager",
                                   "@mozilla.org/network/manager;1",
                                   "nsINetworkManager");

const DEFAULT_ETHERNET_NETWORK_IFACE = "eth0";

const TOPIC_NETD_INTEFACE_CHANGED    = "netd-interface-change";
const TOPIC_INTERFACE_STATE_CHANGED  = "network-interface-state-changed";
const TOPIC_INTERFACE_REGISTERED     = "network-interface-registered";
const TOPIC_INTERFACE_UNREGISTERED   = "network-interface-unregistered";
const TOPIC_ACTIVE_CHANGED           = "network-active-changed";

const ETHERNET_WORKER = "resource://gre/modules/ethernet_worker.js";

function DOMEthernetManager() {
}

function exposeCurrentNetwork(currentNetwork) {
  currentNetwork.__exposedProps__ = exposeCurrentNetwork.currentNetworkApi;
}

exposeCurrentNetwork.currentNetworkApi = {
  ssid: "r",
  capabilities: "r",
  known: "r"
};

// For smaller, read-only APIs, we expose any property that doesn't begin with
// an underscore.
function exposeReadOnly(obj) {
  var exposedProps = {};
  for (let i in obj) {
    if (i[0] === "_")
      continue;
    exposedProps[i] = "r";
  }

  obj.__exposedProps__ = exposedProps;
  return obj;
}

DOMEthernetManager.prototype = {
  __proto__: DOMRequestIpcHelper.prototype,

  classID:   DOMETHERNETMANAGER_CID,
  classInfo: XPCOMUtils.generateCI({classID: DOMETHERNETMANAGER_CID,
                                    contractID: DOMETHERNETMANAGER_CONTRACTID,
                                    classDescription: "DOM Ethernet Manager",
                                    interfaces: [Ci.nsIDOMEthernetManager],
                                    flags: Ci.nsIClassInfo.DOM_OBJECT}),

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIDOMEthernetManager,
                                         Ci.nsIDOMGlobalPropertyInitializer,
                                         Ci.nsIObserver,
                                         Ci.nsIMessageListener,
                                         Ci.nsISupportsWeakReference]),

  // nsIDOMGlobalPropertyInitializer implementation
  init: function(aWindow) {
    Services.obs.addObserver(this, TOPIC_NETD_INTEFACE_CHANGED, false);
    Services.obs.addObserver(this, TOPIC_INTERFACE_STATE_CHANGED, false);
    Services.obs.addObserver(this, TOPIC_INTERFACE_REGISTERED, false);
    Services.obs.addObserver(this, TOPIC_INTERFACE_UNREGISTERED, false);
    // Services.obs.addObserver(this, TOPIC_ACTIVE_CHANGED, false);
    debug("Init() with " + aWindow);
    let principal = aWindow.document.nodePrincipal;
    // let secMan = Cc["@mozilla.org/scriptsecuritymanager;1"].getService(Ci.nsIScriptSecurityManager);

    // let perm = principal == secMan.getSystemPrincipal()
    //              ? Ci.nsIPermissionManager.ALLOW_ACTION
    //              : Services.perms.testExactPermissionFromPrincipal(principal, "wifi-manage");

    // Only pages with perm set can use the wifi manager.
    // this._hasPrivileges = perm == Ci.nsIPermissionManager.ALLOW_ACTION;

    // Maintain this state for synchronous APIs.
    // this._connectionStatus = "disconnected";
    this._cableConnected = false;
    this._enabled = true;
    this._hwaddress = "";
    this._ipaddress = "";
    this._gw = "";
    this._dns1 = "";
    this._dns2 = "";
    this._lastConnectionInfo = null;
    this._connected = false;
    this._onenabledchange = null;
    this._onconnectedchange = null;

    const messages = ["EthernetManager:enable", "EthernetManager:disable",
                      "EthernetManager:connect", "EthernetManager:disconnect",
                      "EthernetManager:getState"];
    this.initHelper(aWindow, messages);

    this._mm = Cc["@mozilla.org/childprocessmessagemanager;1"].getService(Ci.nsISyncMessageSender);

    this.enable();

    gNetworkManager.getEthernetStats(DEFAULT_ETHERNET_NETWORK_IFACE, this);

    this._mm.sendSyncMessage("EthernetManager:getState");
    // if (state) {
    //   this._currentNetwork = state.network;
    //   if (this._currentNetwork)
    //     exposeCurrentNetwork(this._currentNetwork);
    //   this._lastConnectionInfo = state.connectionInfo;
    //   this._enabled = state.enabled;
    //   this._connectionStatus = state.status;
    //   this._macAddress = state.macAddress;
    // } else {
    //   this._currentNetwork = null;
    //   this._lastConnectionInfo = null;
    //   this._enabled = false;
    //   this._connectionStatus = "disconnected";
    //   this._macAddress = "";
    // }
  },

  uninit: function() {
    debug("uninit()");
  },

  observe: function observe(subject, topic, data) {
    let interfaceName = "[No Interface]";
    if (subject) {
      interfaceName = subject.name;
    }
    debug("We got the message from " + subject + "(" + interfaceName + ") with topic " + topic + " and the data " + data);
    // switch (topic) {
    // }
  },

  _sendMessageForRequest: function(name, data, request) {
    debug("_sendMessageForRequest()" + name + "," + data + "," + request);
    let id = this.getRequestId(request);
    this._mm.sendAsyncMessage(name, { data: data, rid: id, mid: this._id });
  },

  receiveMessage: function(aMessage) {
    debug("receiveMessage: " + aMessage);
    let msg = aMessage.json;
    if (msg.mid && msg.mid != this._id)
      return;
  },

  /**
   * function must be called whenever one of:
   *  - enabled
   *  - cableConnected
   *  - ipaddress
   * changed
   */
  _checkConnection: function() {
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
    // debug("The request result is: " + result);
    // debug("The connected state is: " + connected);
    // debug("time of request is: " + date);
    if (result) {
      this._cableConnected = connected;
      // debug("We got the ipaddress: " + details.ip);
      // for (let k in details) {
      //   debug("______ details." + k + ": " + details[k]);
      // }
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

  // _fireStatusChangeEvent: function StatusChangeEvent() {
  // },

  // _fireConnectionInfoUpdate: function connectionInfoUpdate(info) {
  // },

  // _fireEnabledOrDisabled: function enabledDisabled(enabled) {
  //   // var handler = enabled ? this._onEnabled : this._onDisabled;
  //   // if (handler) {
  //   //   var evt = new this._window.Event("WifiEnabled");
  //   //   handler.handleEvent(evt);
  //   // }
  // },

  // nsIDOMWifiManager
  // getEnabled: function nsIDOMEthernetManager_getEnabled() {
  //   debug("getEnabled");
  //   var request = this.createRequest();
  //   this._sendMessageForRequest("EthernetManager:getConnected", null, request);
  //   return request;
  // },

  // getConnected: function nsIDOMEthernetManager_getConnected() {
  //   debug("getConnected");
  //   var request = this.createRequest();
  //   this._sendMessageForRequest("EthernetManager:getConnected", null, request);
  //   return request;
  // },

  enable: function nsIDOMEthernetManager_enable() {
    debug("enable");
    if (!EthernetNetworkInterface.registered) {
      EthernetNetworkInterface.name = DEFAULT_ETHERNET_NETWORK_IFACE;
      gNetworkManager.registerNetworkInterface(EthernetNetworkInterface);
      EthernetNetworkInterface.registered = false;
    }
    var request = this.createRequest();
    this._sendMessageForRequest("EthernetManager:enable", null, request);
    return request;
  },

  disable: function nsIDOMEthernetManager_disable() {
    debug("disable");
    var request = this.createRequest();
    this._sendMessageForRequest("EthernetManager:disable", null, request);
    return request;
  },

  connect: function nsIDOMEthernetManager_connect() {
    debug("connect");
    var request = this.createRequest();
    this._sendMessageForRequest("EthernetManager:connect", null, request);
    return request;
  },

  disconnect: function nsIDOMEthernetManager_disconnect() {
    debug("disconnect");
    // if (!this._hasPrivileges)
    //   throw new Components.Exception("Denied", Cr.NS_ERROR_FAILURE);
    var request = this.createRequest();
    this._sendMessageForRequest("EthernetManager:disconnect", null, request);
    return request;
  },

  // enabled: true,
  // connected: true
  get enabled() {
    debug("get enabled");
    return this._enabled;
    // if (!this._hasPrivileges)
    //   throw new Components.Exception("Denied", Cr.NS_ERROR_FAILURE);
    // return this._enabled;
  },

  get connected() {
    debug("get connected");
    // TODO: better method for validating ip address
    return this._connected;
  },

  // get macAddress() {
  //   if (!this._hasPrivileges)
  //     throw new Components.Exception("Denied", Cr.NS_ERROR_FAILURE);
  //   return this._macAddress;
  // },

  // get connection() {
  //   if (!this._hasPrivileges)
  //     throw new Components.Exception("Denied", Cr.NS_ERROR_FAILURE);
  //   return exposeReadOnly({ status: this._connectionStatus,
  //                           network: this._currentNetwork });
  // },

  // get connectionInformation() {
  //   if (!this._hasPrivileges)
  //     throw new Components.Exception("Denied", Cr.NS_ERROR_FAILURE);
  //   return this._lastConnectionInfo
  //          ? exposeReadOnly(this._lastConnectionInfo)
  //          : null;
  // },

  // set onstatuschange(callback) {
  //   if (!this._hasPrivileges)
  //     throw new Components.Exception("Denied", Cr.NS_ERROR_FAILURE);
  //   this._onStatusChange = callback;
  // },

  // set connectionInfoUpdate(callback) {
  //   if (!this._hasPrivileges)
  //     throw new Components.Exception("Denied", Cr.NS_ERROR_FAILURE);
  //   this._onConnectionInfoUpdate = callback;
  // },

  // set onenabled(callback) {
  //   if (!this._hasPrivileges)
  //     throw new Components.Exception("Denied", Cr.NS_ERROR_FAILURE);
  //   this._onEnabled = callback;
  // },

  // set ondisabled(callback) {
  //   if (!this._hasPrivileges)
  //     throw new Components.Exception("Denied", Cr.NS_ERROR_FAILURE);
  //   this._onDisabled = callback;
  // }
  set onenabledchange(callback) {
    debug("Well, setting  the callback for onenabledchange: " + callback);
  },

  set onconnectedchange(callback) {
    debug("Well, setting the callback for onconnectedchange: " + callback);
  }
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([DOMEthernetManager]);

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
    dump("-*- DOMEthernetManager component: " + s + "\n");
  };
} else {
  debug = function (s) {};
}
