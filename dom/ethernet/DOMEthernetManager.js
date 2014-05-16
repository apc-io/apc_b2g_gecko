/*
 * trungnt
 */

"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/DOMRequestHelper.jsm");
Cu.import("resource://gre/modules/EthernetConstants.jsm");

const DEBUG = false; // set to false to suppress debug messages

const DOMETHERNETMANAGER_CONTRACTID = "@mozilla.org/ethernetmanager;1";
const DOMETHERNETMANAGER_CID        = Components.ID("{c7c75ca2-ab41-4507-8293-77ed56a66cd6}");

const DEFAULT_ETHERNET_NETWORK_IFACE = "eth0";

const TOPIC_NETD_INTEFACE_CHANGED    = "netd-interface-change";
const TOPIC_INTERFACE_STATE_CHANGED  = "network-interface-state-changed";
const TOPIC_INTERFACE_REGISTERED     = "network-interface-registered";
const TOPIC_INTERFACE_UNREGISTERED   = "network-interface-unregistered";
const TOPIC_ACTIVE_CHANGED           = "network-active-changed";

const ETHERNET_WORKER = "resource://gre/modules/ethernet_worker.js";

function DOMEthernetManager() {
}

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
  _xpcom_factory: XPCOMUtils.generateSingletonFactory(DOMEthernetManager),

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
    Services.obs.addObserver(this, TOPIC_INTERFACE_STATE_CHANGED, false);
    Services.obs.addObserver(this, TOPIC_INTERFACE_REGISTERED, false);
    Services.obs.addObserver(this, TOPIC_INTERFACE_UNREGISTERED, false);
    debug("Init() with " + aWindow);

    // TODO: simply use wifi-manage permission for ethernet, now :)
    let principal = aWindow.document.nodePrincipal;
    let secMan = Cc["@mozilla.org/scriptsecuritymanager;1"].getService(Ci.nsIScriptSecurityManager);

    let perm = principal == secMan.getSystemPrincipal()
                 ? Ci.nsIPermissionManager.ALLOW_ACTION
                 : Services.perms.testExactPermissionFromPrincipal(principal, "wifi-manage");

    // Only pages with perm set can use the wifi manager.
    this._hasPrivileges = perm == Ci.nsIPermissionManager.ALLOW_ACTION;
    // this._hasPrivileges = true; // just allow anyone for now

    this._present = true;
    this._enabled = true;
    this._connected = false;
    this._connection = null;
    this._onEnabledChanged = null;
    this._onConnectedChanged = null;
    this._onConnectionUpdated = null;
    this._onDhcpChanged = null;
    this._onStaticConfigUpdated = null;

    // this is the messages we used to communicate between this DOM Element and EthernetWorker (the manager backend)
    const messages = [EthernetMessage.GETPRESENT,         EthernetMessage.GETSTATS,
                      EthernetMessage.GETENABLED,         EthernetMessage.GETCONNECTED,
                      EthernetMessage.GETCONNECTION,
                      EthernetMessage.ENABLE,             EthernetMessage.DISABLE,
                      EthernetMessage.CONNECT,            EthernetMessage.DISCONNECT,
                      EthernetMessage.SETDHCP,
                      EthernetMessage.SETSTATICIPCONFIG,  EthernetMessage.SETADDR,
                      EthernetMessage.SETMASK,            EthernetMessage.SETGATEWAY,
                      EthernetMessage.SETDNS1,            EthernetMessage.SETDNS2,
                      EthernetMessage.ONENABLED,          EthernetMessage.ONDISABLED,
                      EthernetMessage.ONCONNECTED,        EthernetMessage.ONDISCONNECTED,
                      EthernetMessage.ONDHCPCHANGED,      EthernetMessage.ONCONNECTIONUPDATED,
                      EthernetMessage.ONSTATICCONFIGUPDATED];
    this.initDOMRequestHelper(aWindow, messages);

    this._mm = Cc["@mozilla.org/childprocessmessagemanager;1"].getService(Ci.nsISyncMessageSender);

    let stats = this._mm.sendSyncMessage(EthernetMessage.GETSTATS);
    if (0 in stats) {
      stats = stats[0];
    }
    this._present = stats.present;
    this._enabled = stats.enabled;
    this._dhcp = stats.dhcp;
    this._connected = stats.connected;
    this._connection = stats.connection;
    this._staticconfig = stats.staticconfig;
    // must do this to export value to gaia
    if (this._connection) {
      exposeReadOnly(this._connection);
    }
    if (this._staticconfig) {
      exposeReadOnly(this._staticconfig);
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
  },

  receiveMessage: function(aMessage) {
    debug("receiveMessage: " + aMessage.name);
    let msg = aMessage.json;
    if (msg.mid && msg.mid != this._id)
      return;
    let data = aMessage.data;
    switch (aMessage.name) {
      case EthernetMessage.ONCONNECTED:
        this._connected = true;
        if (this._onConnectedChanged) {
          var evt = new this._window.Event("EthernetConnected");
          this._onConnectedChanged.handleEvent(evt);
        }
        break;
      case EthernetMessage.ONDISCONNECTED:
        this._connected = false;
        if (this._onConnectedChanged) {
          var evt = new this._window.Event("EthernetDisconnected");
          this._onConnectedChanged.handleEvent(evt);
        }
        break;
      case EthernetMessage.ONENABLED:
        this._enabled = true;
        if (this._onEnabledChanged) {
          var evt = new this._window.Event("EthernetEnabled");
          this._onEnabledChanged.handleEvent(evt);
        }
        break;
      case EthernetMessage.ONDISABLED:
        this._enabled = false;
        if (this._onEnabledChanged) {
          var evt = new this._window.Event("EthernetDisabled");
          this._onEnabledChanged.handleEvent(evt);
        }
        break;
      case EthernetMessage.ONDHCPCHANGED:
        debug("________________ OK, TIME FOR DHCP CHANGED " + data);
        this._dhcp = data;
        if (this._onDhcpChanged) {
          var evt = new this._window.Event("EthernetDhcpChanged");
          this._onDhcpChanged.handleEvent(evt);
        }
        break;
      case EthernetMessage.ONCONNECTIONUPDATED:
        debug("Ok, connection updated !!!!!!!!");
        this._connection = exposeReadOnly(data);
        if (this._onConnectionUpdated) {
          var evt = new this._window.Event("EthernetConnectionUpdated");
          this._onConnectionUpdated.handleEvent(evt);
        }
        break;
      case EthernetMessage.ONSTATICCONFIGUPDATED:
        debug("______ OK static config is updated!!!1");
        this._staticconfig = exposeReadOnly(data);
        // for now, nothing is emitted to Gaia
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

  setdhcp: function nsIDOMEthernetManager_setdhcp(enabled) {
    debug(EthernetMessage.SETDHCP + " -> " + enabled);
    this._checkPermission();
    return this._createAndSendRequest(EthernetMessage.SETDHCP, enabled);
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

  get enabled() {
    debug("get enabled");
    this._checkPermission();
    return this._enabled;
  },

  get dhcp() {
    debug("get dhcp");
    this._checkPermission();
    return this._dhcp;
  },

  get connected() {
    this._checkPermission();
    debug("get connected = " + this._connected);
    return this._connected;
  },

  get connection() {
    debug("Get connection");
    this._checkPermission();
    return this._connection;
  },

  get present() {
    debug("Get present");
    this._checkPermission();
    return this._present;
  },

  get staticconfig() {
    debug("Get staticconfig");
    this._checkPermission();
    return this._staticconfig;
  },

  set onenabledchanged(callback) {
    this._checkPermission();
    debug("Well, setting  the callback for onenabledchanged: " + callback);
    this._onEnabledChanged = callback;
  },

  set onconnectedchanged(callback) {
    this._checkPermission();
    debug("Well, setting the callback for onconnectedchanged: " + callback);
    this._onConnectedChanged = callback;
  },

  set onconnectionupdated(callback) {
    this._checkPermission();
    debug("Well, settings the callback for onconnectionupdated: " + callback);
    this._onConnectionUpdated = callback;
  },

  set ondhcpchanged(callback) {
    debug("Setting callback for ondhcpchanged");
    this._checkPermission();
    this._onDhcpChanged = callback;
  },

  set onstaticconfigupdated(callback) {
    debug("Setting callback for onstaticconfigupdated");
    this._checkPermission();
    this._onStaticConfigUpdated = callback;
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
