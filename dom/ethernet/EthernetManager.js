/*
 * trungnt
 */
// "use strict";

this.EXPORTED_SYMBOLS = ["EthernetManager"];

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");

const kEthernetWorkerWorkerPath = "resource://gre/modules/ethernet_worker.js";

const kNetdInterfaceChangedTopic         = "netd-interface-change";
const kNetworkInterfaceStateChangedTopic = "network-interface-state-changed";
const kNetworkInterfaceRegisteredTopic   = "network-interface-registered";
const kNetworkInterfaceUnregisteredTopic = "network-interface-unregistered";
const kNetworkActiveChangedTopic         = "network-active-changed";

// Settings DB path for ETHERNET
const kSettingsEthernetEnabled      = "ethernet.enabled";
const kSettingsEthernetDebugEnabled = "ethernet.debugging.enabled";

const kNetworkInterfaceUp   = "up";
const kNetworkInterfaceDown = "down";

const kDefaultEthernetNetworkIface = "eth0";

const kNetdIfaceLinkStateMsg  = "Iface linkstate";
const kInvalidHWAddr = "00:00:00:00:00:00";

XPCOMUtils.defineLazyServiceGetter(this, "gNetworkManager",
                                   "@mozilla.org/network/manager;1",
                                   "nsINetworkManager");

XPCOMUtils.defineLazyServiceGetter(this, "gNetworkService",
                                   "@mozilla.org/network/service;1",
                                   "nsINetworkService");

XPCOMUtils.defineLazyServiceGetter(this, "gSettingsService",
                                   "@mozilla.org/settingsService;1",
                                   "nsISettingsService");

var DEBUG = true; // set to true to show debug messages

let debug;
if (DEBUG) {
  debug = function (s) {
    dump("-*- EthernetManager.js component: " + s + "\n");
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

// we'll use EthernetManager to manage thing
this.EthernetManager = {
  init: function EthernetManager_init() {
  	debug("EthernetManager_init");

  	this.controlWorker = null;
  	this.networkInterfaces = {};
  	this.currentIfname = null;
  	this.idgen = 0;
  	this.controlCallbacks = {};
  	this.settingEnabled = false;
  	this._isConnected = false;
    this.callbackObj = null;

    // preferences
    this.getStartupPreferences();

    // setup worker(s)
    this.controlWorker = new ChromeWorker(kEthernetWorkerWorkerPath);
    this.controlWorker.onmessage = this.onmessage;
    this.controlWorker.onerror = this.onerror;

    // setup interfaces
    this._onInterfaceAdded = function(iface) {
      if (this.settingEnabled && !iface.up) {
        debug("The interface is down, make it up then: " + iface.name);
        iface.needRenew = true;
        this.enableInterface(iface.name);

        return true; // no way it is connected to go further
      }

      if (iface.name == kDefaultEthernetNetworkIface &&
          iface.state == Ci.nsINetworkInterface.NETWORK_STATE_CONNECTED) {
        debug("Well, we got default network and it is connected");
        NetUtilsCallbacks.onConnected(iface.name);
      }

      return true;
    }

    this.initInterface(kDefaultEthernetNetworkIface);

    // setup observer
    Services.obs.addObserver(this, kNetdInterfaceChangedTopic, false);
  },

  shutdown: function EthernetManager_shutdown() {
    debug("shutdown");
    for (ifname in this.networkInterfaces) {
      let iface = this.networkInterfaces[ifname];
      gNetworkManager.unregisterNetworkInterface(iface);
      delete this.networkInterfaces[ifname];
    }
    // how to stop controlWorker?
  },

  // nsIObserver
  observe: function nsIObserver_observe(subject, topic, data) {
  	debug("observer function :)");
    debug("_____ subject: " + subject);
    debug("_____ topic: " + topic);
    debug("_____ data: " + data);
    switch (topic) {
      case kNetdInterfaceChangedTopic:
        this.onInterfaceLinkStateChanged(data);
        break;
    }
  },

  // worker related
  // OK, a note here, with onmessage and onerror, this will be the worker
  // => this must be specific as EthernetManager or other kind of id
  onmessage: function ControlWorker_onmessage(e) {
    debug("ControlWorker_onmessage");
    let data = e.data;
    let id = data.id;
    let callback = EthernetManager.controlCallbacks[id];
    if (callback) {
      callback(data);
      delete EthernetManager.controlCallbacks[id];
    }
  },

  onerror: function ControlWorker_onerror(e) {
    debug("eo`, error: " + e.data);
    e.preventDefault();
  },

  controlMessage: function ControlWorker_controlMessage(params, callback) {
    // debug("Let's make our worker do the work then: "+ this.controlWorker);
    let id = this.idgen++;
    params.id = id;
    if (callback) {
      this.controlCallbacks[id] = callback;
    }
    this.controlWorker.postMessage(params);
  },
  // callback object, this is called by EthernetWorker
  setCallbackObject: function EthernetManager_setCallbackObject(obj) {
    this.callbackObj = obj;
  },

  // preferences
  getStartupPreferences: function EthernetManager_getStartupPerferences() {
    debug("EthernetManager_getStartupPerferences");
    this.settingEnabled = true;
  },

  getInterfacePreferences: function EthernetManager_getInterfacePreferences(ifname) {
    let pref = {
      useDhcp: true,
    };

    // do some query here
    // ...
    return pref;
  },

  // network interface related
  initInterface: function EthernetManager_initInterface(ifname) {
  	debug("EthernetManager_initInterface: " + ifname);
  	gNetworkService.getEthernetStats(ifname, this);
  },

  // checkEthernetState: function EthernetManager_checkEthernetStats(ifname) {
  //   debug("EthernetManager_checkEthernetStats: " + ifname);
  // },

  addInterface: function EthernetManager_addInterface(iface) {
    debug("Well, the board has only one ethernet interface, but just prepare this for the advance case :)");
    if (!iface || !iface.name) {
    	debug("EthernetManager_addInterface: invalid interface");
    	return false;
    }

    if ('name' in iface) {
    	if (iface.name in this.networkInterfaces) {
    		debug("Well, already there, overwrite then");
    	}
    	this.networkInterfaces[iface.name] = iface;

      ifaceSettings = this.getInterfacePreferences(iface.name);
      iface.useDhcp = ifaceSettings.useDhcp;

      if (this._onInterfaceAdded) { // this is only used for callback
        this._onInterfaceAdded(iface);
      }

      Services.obs.notifyObservers(iface,
                                   kNetworkInterfaceStateChangedTopic,
                                   false);

    	return true;
    }

    debug("Well, invalid interface info, we need a name here");
    return false;
  },

  getInterface: function EthernetManager_getInterface(ifname) {
    debug("EthernetManager_getInterface: " + ifname);
    return this.networkInterfaces[ifname];
  },

  removeInterface: function EthernetManager_removeInterface(ifname) {
    debug("EthernetManager_removeInterface: " + ifname);
    if (ifname in this.networkInterfaces) {
      delete this.networkInterfaces[ifname];
    }
  },

  getCurrentInterface: function EthernetManager_getCurrentInterface() {
    debug("EthernetManager_getCurrentInterface");
    return this.getInterface(this.currentIfname);
  },
  
  setConnected: function EthernetManager_setConnected(isConnected) {
    this._isConnected = isConnected;
    this.callbackObj.onConnectedChanged(isConnected);
  },
  
  getConnected: function EthernetManager_getConnected() {
    debug("get connected== " + this._isConnected);
    return this._isConnected;
  },

  enableInterface: function EthernetManager_enableInterface(ifname) {
    debug("EthernetManager_enableInterface: " + ifname);

    let workParams = {
      cmd: "ifc_enable",
      ifname: ifname
    };

    this.controlMessage(workParams, this.onIfcEnableResult);
  },

  connectInterface: function EthernetManager_connect(ifname) {
    debug("EthernetManager_connect: " + ifname);
    let iface = this.getInterface(ifname);
    if (!iface) {
      debug("Unknown interface: " + ifname);
      return false;
    }

    iface.needRenew = false;

    if (iface.useDhcp) {
      this.dhcpDoRequest(ifname, NetUtilsCallbacks.onDhcpConnected);
    } else {
      debug("EthernetManager_connect: we do not support static ip for now");
    }

    return true;
  },

  disconnectInterface: function EthernetManager_disconnect(ifname) {
    debug("EthernetManager_disconnect: " + ifname);
    let iface = this.getInterface(ifname);
    if (!iface) {
      debug("Unknown interface: " + ifname);
      return false;
    }

    iface.needRenew = false; // to prevent renew

    if (iface.useDhcp) {
      this.dhcpStop(ifname, NetUtilsCallbacks.onDhcpDisconnected);
    } else {
      debug("EthernetManager_disconnect: we do not support static ip for now");
    }

    return true;
  },

  renewInterface: function EthernetManager_renew(ifname) {
    debug("EthernetManager_renew: " + ifname);
    let iface = this.getInterface(ifname);
    if (!iface) {
      debug("Unknown interface: " + ifname);
      return false;
    }

    iface.needRenew = false;

    if (iface.useDhcp) {
      this.dhcpDoRenew(ifname, NetUtilsCallbacks.onDhcpConnected);
    } else {
      debug("EthernetManager_renew: we do not support static ip for now. Btw, do we need renew for static ip?");
    }

    return true;
  },

  dhcpDoRequest: function EthernetManager_dhcpDoRequest(ifname, callback) {
    debug("EthernetManager_dhcpDoRequest: " + ifname);
    let workParams = {
      cmd: "dhcp_do_request",
      ifname: ifname
    };

    this.controlMessage(workParams, callback);
  },

  dhcpStop: function EthernetManager_dhcpStop(ifname, callback) {
    debug("EthernetManager_dhcpStop: " + ifname);
    let workParams = {
      cmd: "dhcp_stop",
      ifname: ifname
    };

    this.controlMessage(workParams, callback);
  },

  dhcpDoRenew: function EthernetManager_dhcpDoRenew(ifname, callback) {
    debug("EthernetManager_dhcpDoRenew: " + ifname);
    this.dhcpStop(ifname, function(data) {
      debug("EthernetManager_dhcpDoRenew: " + ifname + " - stop step");
      // TODO: should we validate status here?
      if (Utils.validateStatus(data)) {
        EthernetManager.dhcpDoRequest(ifname, callback);
      }
    });
  },

  /* process network interface data */
  updateInterface: function EthernetManager_updateInterface(ifname, data) {
    if (!data) {
      debug("EthernetManager_updateInterface - invalid data");
      return;
    }

    let iface = this.getInterface(ifname);
    if (!iface) {
      debug("EthernetManager_updateInterface: unknown interface: " + ifname);
      return false;
    }

    updateProperty = function(targetProp, srcProp) {
      if (srcProp in data) {
        debug("EthernetManager_updateInterface: updating iface." + targetProp + " with data." + srcProp);
        iface[targetProp] = data[srcProp];
        return true;
      }

      debug("EthernetManager_updateInterface: no new data for iface." + targetProp);
      false;
    }

    updateProperty("up", "up");
    updateProperty("cableConnected", "cableConnected");
    let stateChanged = updateProperty("state", "state");
    updateProperty("hwaddress", "hwaddress");
    updateProperty("ip", "ip", "ipaddr_str");
    updateProperty("gateway", "gateway_str");
    updateProperty("netmask", "mask_str");
    updateProperty("broadcast", "broadcast_str");
    updateProperty("dns1", "dns1_str");
    updateProperty("dns2", "dns2_str");

    if (stateChanged) {
      Services.obs.notifyObservers(iface,
                                   kNetworkInterfaceStateChangedTopic,
                                   false);
    }

    return true;
  },

  createInterface: function EthernetManager_createInterface(ifname, data) {
    let iface = {
      QueryInterface: XPCOMUtils.generateQI([Ci.nsINetworkInterface]),
      type: Ci.nsINetworkInterface.NETWORK_TYPE_ETHERNET,
      name: ifname,
      up: (data && data.up != null) ? data.up : false,
      cableConnected: data ? data.cableConnected : false,
      state: data && data.state ? data.state : Ci.nsINetworkInterface.NETWORK_STATE_UNKNOWN,
      // connected: data ? data.connected : false, // the state managed by this Manager // let's change this to state
      //   // For now we do our own DHCP. In the future this should be handed off
      //   // to the Network Manager. this is copied from WifiManager.
      dhcp: false,
      hwaddress: data ? data.hwaddr : null,
      ip: data ? data.ip : null,
      gateway: data ? data.gateway_str : null,
      netmask: data ? data.mask_str : null,
      broadcast: data ? data.broadcast_str : null,
      dns1: data ? data.dns1_str : null,
      dns2: data ? data.dns2_str : null,
      httpProxyHost: null,
      httpProxyPort: null,
      // other property,
      useDhcp: true, // don't misunderstand this with nsINetworkInterface.dhcp. Can we group them?
      needRenew: false // if the inteface is just up => need a special treat
    };

    return iface;
  },

  /* process netd message */
  onInterfaceLinkStateChanged: function EthernetManager_onInterfaceLinkstateChanged(data) {
    debug("EthernetManager_onInterfaceLinkstateChanged: " + data);
    if (data.indexOf(kNetdIfaceLinkStateMsg) < 0) {
      debug("Invalid message format");
      return false;
    }

    let paramStr = data.replace(kNetdIfaceLinkStateMsg, "").trim();
    debug("We got paramStr: " + paramStr);
    let params = paramStr.split(" ");
    if (params.length != 2) {
      debug("EthernetManager_onInterfaceLinkstateChanged - I don't know these param format: " + paramStr);
      return false;
    }

    let ifname = params[0];
    let iface = this.getInterface(ifname);
    debug("Ok, so we got the ifname: " + ifname + ", and inteface object is: " + iface);
    if (!iface) {
      debug("EthernetManager_onInterfaceLinkstateChanged - unknown interface: " + ifname);
      return false;
    }

    let state = params[1];
    debug("the state is: " + state);
    if (state == kNetworkInterfaceUp) {
      if (iface.needRenew) {
        this.renewInterface(ifname);
      } else {
        this.connectInterface(ifname);
      }
    } else {
      this.disconnectInterface(ifname);
    }
  },

  // NetworkManager commnunication
  ethernetStatsAvailable: function nsIEthernetStatsCallback_ethernetStatsAvailable(
    result, details) {
  	debug("Ok, good, got result");

  	if (details.hwaddress == kInvalidHWAddr) {
  	  debug("Well, the device " + details.ifname + " is not available");
  	}
    details.state = (details.up == true && details.cableConnected == true && details.ip)
                        ? Ci.nsINetworkInterface.NETWORK_STATE_CONNECTED
                        : Ci.nsINetworkInterface.NETWORK_STATE_DISCONNECTED;
    // TODO: integrate this with nsINetworkInterface so that we can register this with the NetworkManager
  	var iface = this.createInterface(details.ifname, details);

    this.addInterface(iface);
  },
};

this.EthernetManager.init();

this.Utils = {
  /* the status is return from C function => 0 means Ok */
  validateStatus: function(result) {
    return result.status == 0;
  },

  needRenew: function(iface) {
    return false;
  }
};

// Ok, so we separate these functions to a new Obj because inside them,
// we can not access EthernetManager as this => safe to move them outside
// to make stuff clear
this.NetUtilsCallbacks = {
  /* process return result from ethernet_worker */
  onIfcEnableResult: function NetUtilsCallbacks_onIfcEnableResult(result) {
    debug("NetUtilsCallbacks_onIfcEnableResult: " + result.ifname);
    if (!Utils.validateStatus(result)) {
      debug("Well, error when enabling interface: " + result.ifname);
      EthernetManager.removeInterface(result.ifname);
    }
  },

  onDhcpConnected: function NetUtilsCallbacks_onDhcpConnected(result) {
    dumpObj(result);
    if (Utils.validateStatus(result)) {
      debug("NetUtilsCallbacks_onDhcpConnected: good, we got the connection of " + result.ifname);
      result.state = result.ipaddr_str != ""
                     ? Ci.nsINetworkInterface.NETWORK_STATE_CONNECTED
                     : Ci.nsINetworkInterface.NETWORK_STATE_DISCONNECTED;
      EthernetManager.updateInterface(result.ifname, result);

      if (result.state == Ci.nsINetworkInterface.NETWORK_STATE_CONNECTED) {
        NetUtilsCallbacks.onConnected(result.ifname);
      } else {
        NetUtilsCallbacks.onDisconnected(result.ifname);
      }
    } else {
      debug("NetUtilsCallbacks_onDhcpConnected: bad, unable to start dhcp on: " + result.ifname);
    }
  },

  onConnected: function NetUtilsCallbacks_onConnected(ifname) {
    debug("~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~");
    if (ifname == kDefaultEthernetNetworkIface) {
      debug("Ok, onConnected, prepare xxx ============");
      EthernetManager.currentIfname = ifname;
      let iface = EthernetManager.getCurrentInterface();
      gNetworkManager.registerNetworkInterface(iface);
      // gNetworkManager.overrideActive(iface);
    } else {
      if (EthernetManager.currentIfname == null) {
        EthernetManager.currentIfname = ifname;
      }
    }
    EthernetManager.setConnected(true);
  },

  onDhcpDisconnected: function NetUtilsCallbacks_onDhcpDisconnected(result) {
    dumpObj(result);
    if (Utils.validateStatus(result)) {
      debug("NetUtilsCallbacks_onDhcpDisconnected: good, got disconnect for: " + result.ifname);
      result.state = Ci.nsINetworkInterface.NETWORK_STATE_DISCONNECTED;
      EthernetManager.updateInterface(result.ifname, result);
      // dumpObj(iface);
      NetUtilsCallbacks.onDisconnected(result.ifname);
    } else {
      debug("NetUtilsCallbacks_onDhcpDisconnected: bad, unable to stop dhcp for " + result.ifname);
    }
  },

  onDisconnected: function NetUtilsCallbacks_onDisconnected(ifname) {
    if (ifname == EthernetManager.currentIfname) {
      EthernetManager.currentIfname = null; // should we?
    }

    if (ifname == kDefaultEthernetNetworkIface) {
      debug("Ok, onDisconnected, prepare xxx ================");
      let iface = EthernetManager.getInterface(ifname);
      gNetworkManager.unregisterNetworkInterface(iface);
      // gNetworkManager.overrideActive(null); // ok, assume that only us using this feature
    }
    EthernetManager.setConnected(false);
  },
};

