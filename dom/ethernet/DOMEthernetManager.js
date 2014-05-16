/*
 * trungnt
 */

"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/DOMRequestHelper.jsm");
Cu.import("resource://gre/modules/EthernetConstants.jsm");

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

    // TODO: fix the permission

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
    this._present = true;
    this._enabled = true;
    this._connected = false;
    this._connection = null;
    this._onEnabledChanged = null;
    this._onConnectedChanged = null;
    this._onConnectionUpdated = null;

    // this is the messages we used to communicate between this DOM Element and EthernetWorker (the manager backend)
    const messages = [EthernetMessage.GETPRESENT,         EthernetMessage.GETSTATS,
                      EthernetMessage.ENABLE,             EthernetMessage.DISABLE,
                      EthernetMessage.CONNECT,            EthernetMessage.DISCONNECT,
                      EthernetMessage.RECONNECT,          EthernetMessage.SETDHCPCD,
                      EthernetMessage.SETSTATICIPCONFIG,  EthernetMessage.SETADDR,
                      EthernetMessage.SETMASK,            EthernetMessage.SETGATEWAY,
                      EthernetMessage.SETDNS1,            EthernetMessage.SETDNS2,
                      EthernetMessage.GETENABLED,         EthernetMessage.GETCONNECTED,
                      EthernetMessage.ONENABLED,          EthernetMessage.ONDISABLED,
                      EthernetMessage.ONCONNECTED,        EthernetMessage.ONDISCONNECTED,
                      EthernetMessage.ONDHCPCHANGED,      EthernetMessage.GETCONNECTION];
    this.initDOMRequestHelper(aWindow, messages);

    this._mm = Cc["@mozilla.org/childprocessmessagemanager;1"].getService(Ci.nsISyncMessageSender);
    // messages.forEach((function(msgName) {
    //   this._mm.addMessageListener(msgName, this);
    // }).bind(this));

    // this._present = this._mm.sendSyncMessage(EthernetMessage.GETPRESENT);

    // this._enabled = this._mm.sendSyncMessage(EthernetMessage.GETENABLED);
    // debug("---- so, got the getEnabled: " + this._enabled);
    // for (let k in this._enabled) {
    //   debug("----- enabled." + k + ": " + this._enabled[k]);
    // }
    // if (this._enabled) {
    //   // this._connection = this._mm.sendSyncMessage("EthernetManager:getConnection");
    //   this._connected = (this._mm.sendSyncMessage(EthernetMessage.GETCONNECTED) == "true") ? true : false;
    //   debug("now connected == " + this._connected);
    // }
    let stats = this._mm.sendSyncMessage(EthernetMessage.GETSTATS);
    if (0 in stats) {
      stats = stats[0];
    }
    this._present = stats.present;
    this._enabled = stats.enabled;
    this._connected = stats.connected;
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
  },

  receiveMessage: function(aMessage) {
    debug("receiveMessage: " + aMessage.name);
    let msg = aMessage.json;
    if (msg.mid && msg.mid != this._id)
      return;
    switch (aMessage.name) {
      case EthernetMessage.ONCONNECTED:
        this._connected = true;
        var evt = new this._window.Event("EthernetConnected");
        this._onConnectedChanged.handleEvent(evt);
        break;
      case EthernetMessage.ONDISCONNECTED:
        this._connected = false;
        var evt = new this._window.Event("EthernetDisconnected");
        this._onConnectedChanged.handleEvent(evt);
        break;
      case EthernetMessage.ONENABLED:
        this._enabled = true;
        var evt = new this._window.Event("EthernetEnabled");
        this._onEnabledChanged.handleEvent(evt);
        break;
      case EthernetMessage.ONDISABLED:
        this._enabled = false;
        var evt = new this._window.Event("EthernetDisabled");
        this._onEnabledChanged.handleEvent(evt);
        break;
    }
  },

  _checkPermission: function() {
    debug("Checking permission");
    if (!this._hasPrivileges)
      throw new Components.Exception("Denied", Cr.NS_ERROR_FAILURE);
    return true;
  },

  _sendMessageForRequest: function(name, data, request) {
    debug("_sendMessageForRequest()" + name + "," + data + "," + request);
    let id = this.getRequestId(request);
    this._mm.sendAsyncMessage(name, { data: data, rid: id, mid: this._id });
  },

  _createAndSendRequest: function(name, data) {
    var request = this.createRequest();
    this._sendMessageForRequest(name, data, request);
    return request;
  },

  enable: function nsIDOMEthernetManager_enable() {
    debug(EthernetMessage.ENABLE);
    this._checkPermission();
    return this._createAndSendRequest(EthernetMessage.ENABLE, null);
  },

  disable: function nsIDOMEthernetManager_disable() {
    debug(EthernetMessage.DISABLE);
    this._checkPermission();
    return this._createAndSendRequest(EthernetMessage.DISABLE, null);
  },

  // connect: function nsIDOMEthernetManager_connect() {
  //   debug(EthernetMessage.CONNECT);
  //   this._checkPermission();
  //   return this._createAndSendRequest(EthernetMessage.CONNECT, null);
  // },

  // disconnect: function nsIDOMEthernetManager_disconnect() {
  //   debug(EthernetMessage.DISCONNECT);
  //   this._checkPermission();    
  //   return this._createAndSendRequest(EthernetMessage.DISCONNECT, null);
  // },

  // reconnect: function nsIDOMEthernetManager_reconnect() {
  //   debug(EthernetMessage.RECONNECT);
  //   this._checkPermission();
  //   return this._createAndSendRequest(EthernetMessage.RECONNECT, null);
  // },

  setdhcp: function nsIDOMEthernetManager_setdhcp(enabled) {
    debug(EthernetMessage.SETDHCPCD + " -> " + enabled);
    this._checkPermission();
    return this._createAndSendRequest(EthernetMessage.SETDHCPCD, enabled);
  },

  setstaticipconfig: function nsIDOMEthernetManager_setstaticipconfig(config) {
    debug("Set static ip config to: " + config.ip + " - " + config.netmask + " - " + config.gateway + " - " + config.dns1 + " - " + config.dns2);
    this._checkPermission();
    return this._createAndSendRequest(EthernetMessage.SETSTATICIPCONFIG, config);
  },

  setaddr: function nsIDOMEthernetManager_setaddr(ip) {
    debug("Set static ip address to : " + ip);
    this._checkPermission();
    return this._createAndSendRequest(EthernetMessage.SETADDR, ip);
  },

  setnetmask: function nsIDOMEthernetManager_setnetmask(mask) {
    debug("Set static netmask to: " + mask);
    this._checkPermission();
    return this._createAndSendRequest(EthernetMessage.SETMASK, mask);
  },

  setgateway: function nsIDOMEthernetManager_setgateway(gw) {
    debug("Set gateway to: " + gw);
    this._checkPermission();
    return this._createAndSendRequest(EthernetMessage.SETGATEWAY, gw);
  },

  setdns1: function nsIDOMEthernetManager_setdns1(dns1) {
    debug("Set dns1 to: " + dns1);
    this._checkPermission();
    return this._createAndSendRequest(EthernetMessage.SETDNS1, dns1);
  },

  setdns2: function nsIDOMEthernetManager_setdns2(dns2) {
    debug("Set dns2 to: " + dns2);
    this._checkPermission();
    return this._createAndSendRequest(EthernetMessage.SETDNS2, dns2);
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
    debug("get connected = " + this._connected);
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

  get present() {
    debug("Get present");
    if (!this._hasPrivileges)
      throw new Components.Exception("Denied", Cr.NS_ERROR_FAILURE);
    return this._present;
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
