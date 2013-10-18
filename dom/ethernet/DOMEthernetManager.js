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
                                         Ci.nsIMessageListener,
                                         Ci.nsISupportsWeakReference]),

  // nsIDOMGlobalPropertyInitializer implementation
  init: function(aWindow) {
    debug("Init() with " + aWindow);
    let principal = aWindow.document.nodePrincipal;
    // let secMan = Cc["@mozilla.org/scriptsecuritymanager;1"].getService(Ci.nsIScriptSecurityManager);

    // let perm = principal == secMan.getSystemPrincipal()
    //              ? Ci.nsIPermissionManager.ALLOW_ACTION
    //              : Services.perms.testExactPermissionFromPrincipal(principal, "wifi-manage");

    // Only pages with perm set can use the wifi manager.
    // this._hasPrivileges = perm == Ci.nsIPermissionManager.ALLOW_ACTION;

    // Maintain this state for synchronous APIs.
    this._currentNetwork = null;
    this._connectionStatus = "disconnected";
    this._enabled = false;
    this._lastConnectionInfo = null;
    this._connected = false;

    const messages = ["EthernetManager:getEnabled:Return:OK", "EthernetManager:getConnected:Return:OK"
                      ];
    this.initHelper(aWindow, messages);
    // this._mm = Cc["@mozilla.org/childprocessmessagemanager;1"].getService(Ci.nsISyncMessageSender);

    // var state = this._mm.sendSyncMessage("WifiManager:getState")[0];
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
    return this._connected;
  }

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
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([DOMEthernetManager]);

let debug;
if (DEBUG) {
  debug = function (s) {
    dump("-*- DOMEthernetManager component: " + s + "\n");
  };
} else {
  debug = function (s) {};
}
