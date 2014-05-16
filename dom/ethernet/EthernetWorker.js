/*
 * trungnt
 */

"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/EthernetUtil.jsm");
Cu.import("resource://gre/modules/EthernetConstants.jsm");

var DEBUG = false; // set to true to show debug messages

const ETHERNETWORKER_CONTRACTID = "@mozilla.org/ethernet/worker;1";
const ETHERNETWORKER_CID        = Components.ID("{e67531d8-db78-4909-b9cb-ff9e497eec17}");

var EthernetWorker = (function() {
  debug(this.name);

  // setting up message listeners
  this._mm = Cc["@mozilla.org/parentprocessmessagemanager;1"]
             .getService(Ci.nsIMessageListenerManager);
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
                    EthernetMessage.ONSTATICCONFIGUPDATED,
                    "child-process-shutdown"];

  messages.forEach((function(msgName) {
    this._mm.addMessageListener(msgName, this);
  }).bind(this));

  EthernetUtil.setCallbackObject(this);
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
  _domManagers: [],
  _fireEvent: function(message, data) {
    debug(">>>>>>>>> Sending message: " + message);
    this._domManagers.forEach(function(manager) {
      debug(">>>>>>>>> Sending message: " + message + " to the manager " + manager);
      // Note: We should never have a dead message manager here because we
      // observe our child message managers shutting down, below.
      manager.sendAsyncMessage(message, data);
    });
  },

  receiveMessage: function MessageManager_receiveMessage(aMessage) {
    debug("receiveMessage: " + aMessage.data + " with target : " + aMessage.target);
    let msg = aMessage.data || {};
    msg.manager = aMessage.target;

    // Note: By the time we receive child-process-shutdown, the child process
    // has already forgotten its permissions so we do this before the
    // permissions check.
    if (aMessage.name === "child-process-shutdown") {
      let i;
      if ((i = this._domManagers.indexOf(msg.manager)) != -1) {
        this._domManagers.splice(i, 1);
      }
      return;
    }
    for (let k in aMessage) {
      debug(",,,,,,,, aMessage." + k + ": " + aMessage[k]);
    }

    debug("And here we go with the details of the data");
    for (let k in msg) {
      debug("......data." + k + ": " + msg[k]);
    }
    switch (aMessage.name) {
      case EthernetMessage.GETSTATS: {
        // init the manager for this worker :)
        if (this._domManagers.indexOf(msg.manager) === -1) {
          this._domManagers.push(msg.manager);
        }
        debug("Ok, we gonna get stats!");
        var stats = {
          present: true,
          enabled: EthernetUtil.getEnabled(),
          connected: EthernetUtil.getConnected(),
          dhcp: EthernetUtil.getDhcp(),
          connection: EthernetUtil.getConnection(),
          staticconfig: EthernetUtil.getStaticConfig()
        };

        return stats;
      }
      case EthernetMessage.GETENABLED: {
        debug("ok, let's getEnabled");
        return this.getEnabled();
      }
      case EthernetMessage.GETCONNECTED: {
        return this.getConnected();
      }
      case EthernetMessage.ENABLE: {
        debug("ok, let's enable");
        EthernetUtil.enable();
      }
      break;
      case EthernetMessage.DISABLE: {
        debug("Ok, let's disable");
        EthernetUtil.disable();
      }
      break;
      case EthernetMessage.SETDHCP: {
        debug(EthernetMessage.SETDHCP);
        EthernetUtil.setdhcp(msg.data);
      }
      break;
      case EthernetMessage.RECONNECT: {
        debug(EthernetManager.RECONNECT + " We not gonna to support this !");
      }
      break;
      case EthernetMessage.SETADDR: {
        debug(EthernetMessage.SETADDR + " - " + msg.data);
        EthernetUtil.setIpAddr(msg.data);
      }
      break;
      case EthernetMessage.SETGATEWAY: {
        debug(EthernetMessage.SETGATEWAY + " - " + msg.data);
        EthernetUtil.setGateway(msg.data);
      }
      break;
      case EthernetMessage.SETMASK: {
        debug(EthernetMessage.SETMASK + " - " + msg.data);
        EthernetUtil.setNetmask(msg.data);
      }
      break;
      case EthernetMessage.SETDNS1: {
        debug(EthernetMessage.SETDNS1 + " - " + msg.data);
        EthernetUtil.setDNS1(msg.data);
      }
      break;
      case EthernetMessage.SETDNS2: {
        debug(EthernetMessage.SETDNS2 + " + " + msg.data);
        EthernetUtil.setDNS2(msg.data);
      }
      break;
      default:
        debug("Well, ok: " + aMessage.name);
    }
    debug("Well, after: " + aMessage.name);
  },

  shutdown: function nsIEthernet_shutdown() {
    debug("This is the nsIEthernet_shutdown function");
    EthernetUtil.shutdown();
  },

  getEnabled: function() {
    debug("getEnabled");
    return EthernetUtil.getEnabled();
  },
  
  getConnected: function() {
    return EthernetUtil.getConnected();
  },

  onEnabledChanged: function(enabled) {
    debug("Ok, enabled is changed to: " + enabled);
    if (enabled) {
      this._fireEvent(EthernetMessage.ONENABLED, {});
    } else {
      this._fireEvent(EthernetMessage.ONDISABLED, {});
    }
  },

  onConnectedChanged: function(connected) {
    debug("---- ok connected is changed to " + connected);
    if (connected) {
      this._fireEvent(EthernetMessage.ONCONNECTED, {});
    } else {
      this._fireEvent(EthernetMessage.ONDISCONNECTED, {});
    }
  },

  onDhcpChanged: function(dhcp) {
    debug("--- ok, dhcp is changed to " + dhcp);
    this._fireEvent(EthernetMessage.ONDHCPCHANGED, dhcp);
  },

  onConnectionUpdated: function(connection) {
    debug("------- ok, connection is updated " + connection);
    this._fireEvent(EthernetMessage.ONCONNECTIONUPDATED, connection);
  },

  onStaticConfigUpdated: function(config) {
    debug("----- ok, static config is updated " + config);
    this._fireEvent(EthernetMessage.ONSTATICCONFIGUPDATED, config);
  }
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([EthernetWorker]);

let debug;
if (DEBUG) {
  debug = function (s) {
    dump("-*- EthernetWorker.js component: " + s + "\n");
  };
} else {
  debug = function (s) {};
}
