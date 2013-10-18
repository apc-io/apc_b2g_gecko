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

  	// this.controlWorker = null;
  	this.networkInterfaces = {};
  	this.currentIfname = null;
  	this.idgen = 0;
  	this.controlCallbacks = {};
    this.commandParamas = {};
  	this.settingEnabled = false;
  	this._isConnected = false;
    this.callbackObj = null;
    this.enabled = false;

    // preferences
    this.getStartupPreferences();

    // // setup worker(s)
    // this.controlWorker = new ChromeWorker(kEthernetWorkerWorkerPath);
    // this.controlWorker.onmessage = this.onmessage;
    // this.controlWorker.onerror = this.onerror;

    this.initServices();

    // setup interfaces
    this._onInterfaceAdded = function(iface) {
      if (this.settingEnabled && !iface.up) {
        debug("The interface is down, make it up then: " + iface.name);
        iface.needRenew = true;
        this.enableInterface(iface.name);

        return true; // no way it is connected to go further
      } else {
        this._setEnabled(true);
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

  initServices: function EthernetUtil_initServices() {
    this.ethernetListener = {
      onWaitEvent: function(event, iface) {
        debug("...onWaitEvent");
      },

      onCommand: function(event, iface) {
        debug("....onCommand() - " + iface);
        let id = event.id;
        let callback = EthernetUtil.controlCallbacks[id];
        if (callback) {
          let params = EthernetUtil.commandParamas[id];
          if (params) {
            if (!event.ifname) {
              event.ifname = params.ifname; // some callback require ifname to process
            }
            delete EthernetUtil.commandParamas[id];
          }
          callback(event);
          delete EthernetUtil.controlCallbacks[id];
        }
      }
    }

    debug("=========== Getting ethernetService");
    this.ethernetService = Cc["@mozilla.org/ethernet/service;1"];
    if (this.ethernetService) {
      this.ethernetService = this.ethernetService.getService(Ci.nsIEthernetProxyService);
      let interfaces = [kDefaultEthernetNetworkIface];
      this.ethernetService.start(this.ethernetListener, interfaces, interfaces.length);
    } else {
      debug("No Ethernet service component available!");
    }
  },

  shutdown: function EthernetUtil_shutdown() {
    debug("shutdown");
    for (ifname in this.networkInterfaces) {
      let iface = this.networkInterfaces[ifname];
      debug("Iface for " + ifname + " = " + iface);
      // gNetworkManager.unregisterNetworkInterface(iface);
      this.disableInterface(ifname);
      // delete this.networkInterfaces[ifname];
    }
    // how to stop controlWorker?
  },

  enable: function EthernetUtil_enable() {
    return this.initInterface(kDefaultEthernetNetworkIface);
  },

  disable: function EthernetUtil_disable() {
    return this.shutdown();
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

  controlMessage: function EthernetUtil_controlMessage(params, callback) {
    let id = this.idgen++;
    params.id = id;
    if (callback) {
      this.controlCallbacks[id] = callback;
    }
    this.commandParamas[id] = params;
    this.ethernetService.sendCommand(params, params.ifname);
  },
  // callback object, this is called by EthernetWorker
  setCallbackObject: function EthernetUtil_setCallbackObject(obj) {
    this.callbackObj = obj;
  },

  // preferences
  getStartupPreferences: function EthernetUtil_getStartupPerferences() {
    debug("EthernetUtil_getStartupPerferences");
    this.settingEnabled = true;
  },

  getInterfacePreferences: function EthernetUtil_getInterfacePreferences(ifname) {
    let pref = {
      useDhcp: true,
    };

    // do some query here
    // ...
    return pref;
  },

  // enable/disable status
  getEnabled: function EthernetUtil_getEnabled() {
    debug("getEnabled, this.enabled = " + this.enabled);
    return this.enabled;
  },

  _setEnabled: function EthernetUtil_setEnabled(enabled) {
    this.enabled = enabled;
    this.callbackObj.onEnabledChanged(enabled);
  },

  // network interface related
  initInterface: function EthernetUtil_initInterface(ifname) {
  	debug("EthernetUtil_initInterface: " + ifname);
  	EthernetBackend.getEthernetStats(ifname, this);
  },

  addInterface: function EthernetUtil_addInterface(iface) {
    debug("Well, the board has only one ethernet interface, but just prepare this for the advance case :)");
    if (!iface || !iface.name) {
    	debug("EthernetUtil_addInterface: invalid interface");
      dumpObj(iface);
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

  getInterface: function EthernetUtil_getInterface(ifname) {
    debug("EthernetUtil_getInterface: " + ifname);
    return this.networkInterfaces[ifname];
  },

  removeInterface: function EthernetUtil_removeInterface(ifname) {
    debug("EthernetUtil_removeInterface: " + ifname);
    if (ifname in this.networkInterfaces) {
      delete this.networkInterfaces[ifname];
    }
  },

  getCurrentInterface: function EthernetUtil_getCurrentInterface() {
    debug("EthernetUtil_getCurrentInterface");
    return this.getInterface(this.currentIfname);
  },
  
  setConnected: function EthernetUtil_setConnected(isConnected) {
    this._isConnected = isConnected;
    this.callbackObj.onConnectedChanged(isConnected);
  },
  
  getConnected: function EthernetUtil_getConnected() {
    debug("get connected== " + this._isConnected);
    return this._isConnected;
  },

  enableInterface: function EthernetUtil_enableInterface(ifname) {
    debug("EthernetUtil_enableInterface: " + ifname);

    let workParams = {
      cmd: "ifc_enable",
      ifname: ifname
    };

    this.controlMessage(workParams, NetUtilsCallbacks.onIfcEnableResult);
  },

  disableInterface: function EthernetUtil_disableInterface(ifname) {
    debug("EthernetUtil_disableInterface: " + ifname);

    let workParams = {
      cmd: "ifc_disable",
      ifname: ifname
    };

    this.controlMessage(workParams, NetUtilsCallbacks.onIfcDisableResult);
  },

  connectInterface: function EthernetUtil_connect(ifname) {
    debug("EthernetUtil_connect: " + ifname);
    let iface = this.getInterface(ifname);
    if (!iface) {
      debug("Unknown interface: " + ifname);
      return false;
    }

    iface.needRenew = false;

    if (iface.useDhcp) {
      this.dhcpDoRequest(ifname, NetUtilsCallbacks.onDhcpConnected);
    } else {
      debug("EthernetUtil_connect: we do not support static ip for now");
    }

    return true;
  },

  disconnectInterface: function EthernetUtil_disconnect(ifname) {
    debug("EthernetUtil_disconnect: " + ifname);
    let iface = this.getInterface(ifname);
    if (!iface) {
      debug("Unknown interface: " + ifname);
      return false;
    }

    iface.needRenew = false; // to prevent renew

    if (iface.useDhcp) {
      this.dhcpStop(ifname, NetUtilsCallbacks.onDhcpDisconnected);
    } else {
      debug("EthernetUtil_disconnect: we do not support static ip for now");
    }

    return true;
  },

  renewInterface: function EthernetUtil_renew(ifname) {
    debug("EthernetUtil_renew: " + ifname);
    let iface = this.getInterface(ifname);
    if (!iface) {
      debug("Unknown interface: " + ifname);
      return false;
    }

    iface.needRenew = false;

    if (iface.useDhcp) {
      this.dhcpDoRenew(ifname, NetUtilsCallbacks.onDhcpConnected);
    } else {
      debug("EthernetUtil_renew: we do not support static ip for now. Btw, do we need renew for static ip?");
    }

    return true;
  },

  dhcpDoRequest: function EthernetUtil_dhcpDoRequest(ifname, callback) {
    debug("EthernetUtil_dhcpDoRequest: " + ifname);
    let workParams = {
      cmd: "dhcp_do_request",
      ifname: ifname
    };

    this.controlMessage(workParams, callback);
  },

  dhcpStop: function EthernetUtil_dhcpStop(ifname, callback) {
    debug("EthernetUtil_dhcpStop: " + ifname);
    let workParams = {
      cmd: "dhcp_stop",
      ifname: ifname
    };

    this.controlMessage(workParams, callback);
  },

  dhcpDoRenew: function EthernetUtil_dhcpDoRenew(ifname, callback) {
    debug("EthernetUtil_dhcpDoRenew: " + ifname);
    this.dhcpStop(ifname, function(data) {
      debug("EthernetUtil_dhcpDoRenew: " + ifname + " - stop step");
      // TODO: should we validate status here?
      if (Utils.validateStatus(data)) {
        EthernetUtil.dhcpDoRequest(ifname, callback);
      }
    });
  },

  /* process network interface data */
  updateInterface: function EthernetUtil_updateInterface(ifname, data) {
    if (!data) {
      debug("EthernetUtil_updateInterface - invalid data");
      return;
    }

    let iface = this.getInterface(ifname);
    if (!iface) {
      debug("EthernetUtil_updateInterface: unknown interface: " + ifname);
      return false;
    }

    updateProperty = function(targetProp, srcProp) {
      if (srcProp in data) {
        debug("EthernetUtil_updateInterface: updating iface." + targetProp + " with data." + srcProp);
        iface[targetProp] = data[srcProp];
        return true;
      }

      debug("EthernetUtil_updateInterface: no new data for iface." + targetProp);
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

  createInterface: function EthernetUtil_createInterface(ifname, data) {
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
  onInterfaceLinkStateChanged: function EthernetUtil_onInterfaceLinkstateChanged(data) {
    debug("EthernetUtil_onInterfaceLinkstateChanged: " + data);
    if (data.indexOf(kNetdIfaceLinkStateMsg) < 0) {
      debug("Invalid message format");
      return false;
    }

    let paramStr = data.replace(kNetdIfaceLinkStateMsg, "").trim();
    debug("We got paramStr: " + paramStr);
    let params = paramStr.split(" ");
    if (params.length != 2) {
      debug("EthernetUtil_onInterfaceLinkstateChanged - I don't know these param format: " + paramStr);
      return false;
    }

    let ifname = params[0];
    let iface = this.getInterface(ifname);
    debug("Ok, so we got the ifname: " + ifname + ", and inteface object is: " + iface);
    if (!iface) {
      debug("EthernetUtil_onInterfaceLinkstateChanged - unknown interface: " + ifname);
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
    details.state = (details.up == true && details.cableConnected == true && details.ip && details.ip.trim() != "")
                        ? Ci.nsINetworkInterface.NETWORK_STATE_CONNECTED
                        : Ci.nsINetworkInterface.NETWORK_STATE_DISCONNECTED;
    // TODO: integrate this with nsINetworkInterface so that we can register this with the NetworkManager
    debug("here, we have the state = " + details.state);
  	var iface = this.createInterface(details.ifname, details);

    this.addInterface(iface);
  },
};

this.EthernetBackend = {
  getEthernetStats: function getEthernetStats(ifname, callback) {
    if (!ifname || !callback) {
      debug("Invalid parameters");
      return false;
    }

    let params = {
      cmd: "getEthernetStats",
      ifname: ifname,
      up: false, // operstate
      cableConnected: false, // carrier
      config: "",
      hwaddr: "",
      ip: "",
      gateway_str: "",
      dns1_str: "",
      dns2_str: "",
      date: new Date(),
      resultCode: -1,
    };

    this._getCarrier(params, callback, this);

    return true;
  },

  _getCarrier: function(params, callback) {
    let carrierFile = "/sys/class/net/" + params.ifname + "/carrier";
    debug("Let's open file " + carrierFile);
    let file = new FileUtils.File(carrierFile);

    if (!file) {
      debug("Unable to open file " + carrierFile);
      callback.ethernetStatsAvailable(false, params);
      return false;
    }

    NetUtil.asyncFetch(file, function(inputStream, status) {
      debug("==== this is NetUtil.asyncFetch(status = " + status + ")")
      if (Components.isSuccessCode(status)) {
        let data = NetUtil.readInputStreamToString(inputStream, inputStream.available()).trim();
        debug("We got the data ===== " + data + " ======");
        if (data == "1") {
          params.cableConnected = true;
        } else {
          params.cableConnected = false;
        }
      } else {
        debug("isSuccessCode is " + status + ", this mean, cableConnected = false");
        params.cableConnected = false;
      }

      // call to network service to get the config
      gNetworkService.getNetworkInterfaceCfg(params.ifname, {
        params: params,
        callback: callback,
        interfaceCfgAvailable: function(success, details) {
          debug("interfaceCfgAvailable - " + success);
          resultReason = details.resultReason;
          params.up = resultReason.indexOf("up") >= 0;
          if (params.up) {
            EthernetBackend._getIpAddress(params, callback);
          } else {
            callback.ethernetStatsAvailable(true, params);
          }
        }
      });
    });
  },

  interfaceCfgAvailable: function(success, details) {
    
  },

  _getIpAddress: function(params, callback) {
    let propertyName = "dhcp." + params.ifname + ".ipaddress";
    params.ip = libcutils.property_get(propertyName, "");
    callback.ethernetStatsAvailable(true, params);
  }
};

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
// we can not access EthernetUtil as this => safe to move them outside
// to make stuff clear
this.NetUtilsCallbacks = {
  /* process return result from ethernet_worker */
  onIfcEnableResult: function NetUtilsCallbacks_onIfcEnableResult(result) {
    debug("NetUtilsCallbacks_onIfcEnableResult: " + result.ifname);
    if (!Utils.validateStatus(result)) {
      debug("Well, error when enabling interface: " + result.ifname);
      EthernetUtil.removeInterface(result.ifname);
      return;
    }

    EthernetUtil._setEnabled(true);
  },

  onIfcDisableResult: function NetUtilsCallbacks_onIfcDisableResult(result) {
    debug("NetUtilsCallbacks_onIfcDisableResult: " + result.ifname);
    if (Utils.validateStatus(result)) {
      debug("Ok, interface is disabled: " + result.ifname);
      // EthernetUtil.removeInterface(result.ifname); // need this line?
      EthernetUtil._setEnabled(false);
    }
  },

  onDhcpConnected: function NetUtilsCallbacks_onDhcpConnected(result) {
    dumpObj(result);
    if (Utils.validateStatus(result)) {
      debug("NetUtilsCallbacks_onDhcpConnected: good, we got the connection of " + result.ifname);
      result.state = result.ipaddr_str != ""
                     ? Ci.nsINetworkInterface.NETWORK_STATE_CONNECTED
                     : Ci.nsINetworkInterface.NETWORK_STATE_DISCONNECTED;
      EthernetUtil.updateInterface(result.ifname, result);

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
      EthernetUtil.currentIfname = ifname;
      let iface = EthernetUtil.getCurrentInterface();
      gNetworkManager.registerNetworkInterface(iface);
      // gNetworkManager.overrideActive(iface);
    } else {
      if (EthernetUtil.currentIfname == null) {
        EthernetUtil.currentIfname = ifname;
      }
    }
    EthernetUtil.setConnected(true);
  },

  onDhcpDisconnected: function NetUtilsCallbacks_onDhcpDisconnected(result) {
    dumpObj(result);
    if (Utils.validateStatus(result)) {
      debug("NetUtilsCallbacks_onDhcpDisconnected: good, got disconnect for: " + result.ifname);
      result.state = Ci.nsINetworkInterface.NETWORK_STATE_DISCONNECTED;
      EthernetUtil.updateInterface(result.ifname, result);
      // dumpObj(iface);
      NetUtilsCallbacks.onDisconnected(result.ifname);
    } else {
      debug("NetUtilsCallbacks_onDhcpDisconnected: bad, unable to stop dhcp for " + result.ifname);
    }
  },

  onDisconnected: function NetUtilsCallbacks_onDisconnected(ifname) {
    if (ifname == EthernetUtil.currentIfname) {
      EthernetUtil.currentIfname = null; // should we?
    }

    if (ifname == kDefaultEthernetNetworkIface) {
      debug("Ok, onDisconnected, prepare xxx ================");
      let iface = EthernetUtil.getInterface(ifname);
      gNetworkManager.unregisterNetworkInterface(iface);
      // gNetworkManager.overrideActive(null); // ok, assume that only us using this feature
    }
    EthernetUtil.setConnected(false);
  },
};

this.EthernetUtil.init();
