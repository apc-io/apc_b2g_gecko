/*
 * trungnt
 */

"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
// Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/EthernetManager.js");

var DEBUG = true; // set to true to show debug messages

const ETHERNETWORKER_CONTRACTID = "@mozilla.org/ethernet/worker;1";
const ETHERNETWORKER_CID        = Components.ID("{e67531d8-db78-4909-b9cb-ff9e497eec17}");

var EthernetWorker = (function() {
  debug(this.name);

  // setting up message listeners
  this._mm = Cc["@mozilla.org/parentprocessmessagemanager;1"]
             .getService(Ci.nsIMessageListenerManager);
  const messages = ["EthernetManager:enable", "EthernetManager:disable",
                    "EthernetManager:connect", "EthernetManager:disconnect",
                    "EthernetManager:getEnabled", "EthernetManager:getConnected",
                    "EthernetManager:getConnection"];
                    // "child-process-shutdown"];

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

  receiveMessage: function MessageManager_receiveMessage(aMessage) {
    debug("receiveMessage: " + aMessage.data + " with target : " + aMessage.target);
    for (let k in aMessage) {
      debug(",,,,,,,, aMessage." + k + ": " + aMessage[k]);
    }
    switch (aMessage.name) {
      case "EthernetManager:getEnabled":
        return this.getEnabled();
    }
  },

  shutdown: function nsIEthernet_shutdown() {
    debug("This is the nsIEthernet_shutdown function");
    EthernetManager.shutdown();
  },

  getEnabled: function() {
    return true;
  }
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([EthernetWorker]);

// let EthernetNetworkInterface = {

//   QueryInterface: XPCOMUtils.generateQI([Ci.nsINetworkInterface]),

//   registered: false,

//   // nsINetworkInterface

//   NETWORK_STATE_UNKNOWN:       Ci.nsINetworkInterface.NETWORK_STATE_UNKNOWN,
//   NETWORK_STATE_CONNECTING:    Ci.nsINetworkInterface.CONNECTING,
//   NETWORK_STATE_CONNECTED:     Ci.nsINetworkInterface.CONNECTED,
//   NETWORK_STATE_DISCONNECTING: Ci.nsINetworkInterface.DISCONNECTING,
//   NETWORK_STATE_DISCONNECTED:  Ci.nsINetworkInterface.DISCONNECTED,

//   state: Ci.nsINetworkInterface.NETWORK_STATE_UNKNOWN,

//   NETWORK_TYPE_WIFI:        Ci.nsINetworkInterface.NETWORK_TYPE_WIFI,
//   NETWORK_TYPE_MOBILE:      Ci.nsINetworkInterface.NETWORK_TYPE_MOBILE,
//   NETWORK_TYPE_MOBILE_MMS:  Ci.nsINetworkInterface.NETWORK_TYPE_MOBILE_MMS,
//   NETWORK_TYPE_MOBILE_SUPL: Ci.nsINetworkInterface.NETWORK_TYPE_MOBILE_SUPL,
//   NETWORK_TYPE_ETHERNET:    Ci.nsINetworkInterface.NETWORK_TYPE_ETHERNET,

//   type: Ci.nsINetworkInterface.NETWORK_TYPE_ETHERNET,

//   name: null,

//   // For now we do our own DHCP. In the future this should be handed off
//   // to the Network Manager.
//   dhcp: false,

//   ip: null,

//   netmask: null,

//   broadcast: null,

//   dns1: null,

//   dns2: null,

//   httpProxyHost: null,

//   httpProxyPort: null,

// };

let debug;
if (DEBUG) {
  debug = function (s) {
    dump("-*- EthernetWorker.js component: " + s + "\n");
  };
} else {
  debug = function (s) {};
}