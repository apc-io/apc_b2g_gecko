/*
 * trungnt
 */

"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/DOMRequestHelper.jsm");

const DEBUG = true; // set to false to suppress debug messages

const DOMETHERNETMANAGER_CONTRACTID = "@mozilla.org/ethernetmanager;1";
const DOMETHERNETMANAGER_CID        = Components.ID("{c7c75ca2-ab41-4507-8293-77ed56a66cd6}");

// XPCOMUtils.defineLazyServiceGetter(this, "gNetworkManager",
//                                    "@mozilla.org/network/manager;1",
//                                    "nsINetworkManager");

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
    // Services.obs.addObserver(this, TOPIC_NETD_INTEFACE_CHANGED, false);
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
    this._hasPrivileges = true; // just allow anyone for now

    // Maintain this state for synchronous APIs.
    // this._connectionStatus = "disconnected";
    this._enabled = true;
    this._connected = true;
    this._connection = null;
    this._onEnabledChanged = null;
    this._onConnectedChanged = null;
    this._onConnectionUpdated = null;

    // this is the messages we used to communicate between this DOM Element and EthernetWorker (the manager backend)
    const messages = ["EthernetManager:enable", "EthernetManager:disable",
                      "EthernetManager:connect", "EthernetManager:disconnect",
                      "EthernetManager:getEnabled", "EthernetManager:getConnected",
                      "EthernetManager:getConnection"];
    this.initDOMRequestHelper(aWindow, messages);

    this._mm = Cc["@mozilla.org/childprocessmessagemanager;1"].getService(Ci.nsISyncMessageSender);

    this._enabled = this._mm.sendSyncMessage("EthernetManager:getEnabled");
    debug("---- so, got the getEnabled: " + this._enabled);
    for (let k in this._enabled) {
      debug("----- enabled." + k + ": " + this._enabled[k]);
    }
    if (this._enabled) {
      // this._connection = this._mm.sendSyncMessage("EthernetManager:getConnection");
    }
  },

  uninit: function() {
    debug("uninit()");
  },

  observe: function observe(subject, topic, data) {
    let interfaceName = "[No Interface]";
    if (subject && subject.name) {
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
    if (!this._hasPrivileges)
      throw new Components.Exception("Denied", Cr.NS_ERROR_FAILURE);
    return this._enabled;
    // if (!this._hasPrivileges)
    //   throw new Components.Exception("Denied", Cr.NS_ERROR_FAILURE);
    // return this._enabled;
  },

  get connected() {
    debug("get connected");
    if (!this._hasPrivileges)
      throw new Components.Exception("Denied", Cr.NS_ERROR_FAILURE);
    // TODO: better method for validating ip address
    return this._connected;
  },

  get connection() {
    debug("Get connection");
    if (!this._hasPrivileges)
      throw new Components.Exception("Denied", Cr.NS_ERROR_FAILURE);
    return this._connection;
  },

  set onenabledchanged(callback) {
    if (!this._hasPrivileges)
      throw new Components.Exception("Denied", Cr.NS_ERROR_FAILURE);
    debug("Well, setting  the callback for onenabledchanged: " + callback);
    this._onEnabledChanged = callback;
  },

  set onconnectedchanged(callback) {
    if (!this._hasPrivileges)
      throw new Components.Exception("Denied", Cr.NS_ERROR_FAILURE);
    debug("Well, setting the callback for onconnectedchanged: " + callback);
    this._onConnectedChanged = callback;
  },

  set onconnectionupdated(callback) {
    if (!this._hasPrivileges)
      throw new Components.Exception("Denied", Cr.NS_ERROR_FAILURE);
    debug("Well, settings the callback for onconnectionupdated: " + callback);
    this._onConnectionUpdated = callback;
  }
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
