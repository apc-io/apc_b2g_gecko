this.EXPORTED_SYMBOLS = ["EthernetBackend", "EthernetServiceCommunicator",
                         "EthernetIfUtils", "EthernetOBSObserver",
                         "EthernetSettingsCallBack"];

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/systemlibs.js");
Cu.import("resource://gre/modules/NetUtil.jsm");
Cu.import("resource://gre/modules/FileUtils.jsm");

Cu.import("resource://gre/modules/EthernetSettings.jsm");
Cu.import("resource://gre/modules/EthernetIPConfig.jsm");

// common constants
const kDefaultEthernetNetworkIface = "eth0";
const kInvalidHWAddr = "00:00:00:00:00:00";

const kNetdInterfaceChangedTopic         = "netd-interface-change";
const kNetworkInterfaceStateChangedTopic = "network-interface-state-changed";

const kNetworkInterfaceUp   = "up";
const kNetworkInterfaceDown = "down";

const kNetdIfaceLinkStateMsg  = "Iface linkstate";

XPCOMUtils.defineLazyServiceGetter(this, "gNetworkManager",
                                   "@mozilla.org/network/manager;1",
                                   "nsINetworkManager");


XPCOMUtils.defineLazyServiceGetter(this, "gNetworkService",
                                   "@mozilla.org/network/service;1",
                                   "nsINetworkService");

this.EthernetBackend = {
  // data
  ifname: "",
  ethInterface: null,
  callbackObj: null,
  enabled: false,
  connected: false,

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
          params.resultReason = resultReason;
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
    debug("This is _getIpAddress ==================");
    // first get static ip
    let parts = params.resultReason.split(" ");
    if (1 in parts) {
      params.ip = parts[1];
    } else {
      // get ip from dhcp config
      let propertyName = "dhcp." + params.ifname + ".ipaddress";
      params.ip = libcutils.property_get(propertyName, "");
    }
    callback.ethernetStatsAvailable(true, params);
  },

  shutdown: function EthernetUtil_shutdown() {
    debug("shutdown");
    for (ifname in EthernetIfUtils.networkInterfaces) {
      let iface = EthernetIfUtils.networkInterfaces[ifname];
      debug("Iface for " + ifname + " = " + iface);
      // gNetworkManager.unregisterNetworkInterface(iface);
      EthernetBackend.disableInterface(ifname);
      // delete this.networkInterfaces[ifname];
    }
    // how to stop controlWorker?
  },


  // private data handling
  setEnabled: function EthernetBackend_setEnabled(val) {
    if (this.enabled == val) {
      return;
    }
    this.enabled = val;
    this.callbackObj.onEnabledChanged(val);
  },

  setConnected: function EthernetBackend_setConnected(val) {
    debug("===== set connected to " + val);
    if (this.connected == val) {
      // should we do this?
      return;
    }
    this.connected = val;
    debug("==== now call the callback: " + this.callbackObj);
    this.callbackObj.onConnectedChanged(val);
  },

  // init Ethernet interface
  initInterface: function EthernetBackend_initInterface(ifname) {
    debug("EthernetUtil_initInterface: " + ifname);
    EthernetBackend.getEthernetStats(ifname, EthernetBackend);
  },

  enableInterface: function EthernetUtil_enableInterface(ifname) {
    debug("EthernetUtil_enableInterface: " + ifname);

    let workParams = {
      cmd: "ifc_enable",
      ifname: ifname
    };

    EthernetServiceCommunicator.controlMessage(workParams, NetUtilsCallbacks.onIfcEnableResult);
  },

  disableInterface: function EthernetUtil_disableInterface(ifname) {
    debug("EthernetUtil_disableInterface: " + ifname);

    let workParams = {
      cmd: "ifc_disable",
      ifname: ifname
    };

    EthernetServiceCommunicator.controlMessage(workParams, NetUtilsCallbacks.onIfcDisableResult);
  },

  connectInterface: function EthernetUtil_connect(ifname) {
    debug("EthernetUtil_connect: " + ifname);
    let iface = EthernetIfUtils.getInterface(ifname);
    if (!iface) {
      debug("Unknown interface: " + ifname);
      return false;
    }

    iface.needRenew = false;

    if (iface.useDhcp) {
      EthernetDHCPHelper.dhcpDoRequest(ifname, NetUtilsCallbacks.onDhcpConnected);
    } else {
      debug("EthernetUtil_connect: we do support static ip for now");
      EthernetStaticIPHelper.configure(ifname, NetUtilsCallbacks.onStaticIpConfigured);
    }

    return true;
  },

  disconnectInterface: function EthernetUtil_disconnect(ifname) {
    debug("EthernetUtil_disconnect: " + ifname);
    let iface = EthernetIfUtils.getInterface(ifname);
    if (!iface) {
      debug("Unknown interface: " + ifname);
      return false;
    }

    iface.needRenew = false; // to prevent renew

    // we'll need to disable interface to let it disconnect, no, noneed, there's no disconnect here!
    if (iface.useDhcp) {
      EthernetDHCPHelper.dhcpStop(ifname, NetUtilsCallbacks.onDhcpDisconnected);
      // the callback will disable the interface
    } else {
      // debug("EthernetUtil_disconnect: we do not support static ip for now");
      NetUtilsCallbacks.onDisconnected(ifname);
      // nothing to do with static ip config in this case
      // this.disableInterface(ifname);
    }

    return true;
  },

  renewInterface: function EthernetUtil_renew(ifname) {
    debug("EthernetUtil_renew: " + ifname);
    let iface = EthernetIfUtils.getInterface(ifname);
    if (!iface) {
      debug("Unknown interface: " + ifname);
      return false;
    }

    iface.needRenew = false;

    if (EthernetSettings.useDhcp) {
      EthernetDHCPHelper.dhcpDoRenew(ifname, NetUtilsCallbacks.onDhcpConnected);
    } else {
      EthernetDHCPHelper.dhcpStop(ifname, NetUtilsCallbacks.onStaticIpDoRenew);
      debug("EthernetUtil_renew: we do renew for static ip");
      // EthernetStaticIPHelper.configure(ifname, function() { dump("===== this is the callback of staticIp.configure")});
    }

    return true;
  },

  updateIpConfig: function EthernetBackend_updateIpConfig(ifname) {
    debug("EthernetBackend_updateIpConfig: " + ifname);
    EthernetStaticIPHelper.configure(ifname, NetUtilsCallbacks.onStaticIpConfigured);
  },

  // switchNetworkMode: function EthernetBackend_switchNetworkMode() {
  //   if (EthernetSettings.useDhcp) {
  //     EthernetDHCPHelper.dhcpDoRenew()
  //   }
  // },

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
    var iface = EthernetIfUtils.createInterface(details.ifname, details);

    EthernetIfUtils.addInterface(iface);
  },

  _onInterfaceAdded: function(iface) {
    debug("_onInterfaceAdded");
    dumpObj(iface);
    debug("====================");
    if (/*EthernetSettings.enabled && */!iface.up) {
      debug("The interface is down, make it up then: " + iface.name);
      iface.needRenew = true;
      EthernetBackend.enableInterface(iface.name);

      return true; // no way it is connected to go further
    } else {
      debug("Interface is already enabled, mark it as enabled!");
      EthernetBackend.setEnabled(true);
    }

    if (iface.name == kDefaultEthernetNetworkIface &&
        iface.state == Ci.nsINetworkInterface.NETWORK_STATE_CONNECTED) {
      debug("Well, we got default network and it is connected");
      NetUtilsCallbacks.onConnected(iface.name);
    } else {
      debug("------------so something wrong, iface.name " + iface.name);
      debug("------------so iface.state " + iface.state + " : connected state " + Ci.nsINetworkInterface.NETWORK_STATE_CONNECTED);
    }

    return true;
  },
};

this.EthernetServiceCommunicator = {
  ethernetService: null,
  ethernetListener: null,
  controlCallbacks: {},
  commandParams: {},
  idgen: 0,

  initService: function EthernetUtil_initService() {
    this.ethernetListener = {
      onWaitEvent: function(event, iface) {
        debug("...onWaitEvent");
      },

      onCommand: function(event, iface) {
        debug("....onCommand() - " + iface);
        let id = event.id;
        let callback = EthernetServiceCommunicator.controlCallbacks[id];
        if (callback) {
          let params = EthernetServiceCommunicator.commandParams[id];
          if (params) {
            if (!event.ifname) {
              event.ifname = params.ifname; // some callback require ifname to process
            }
            delete EthernetServiceCommunicator.commandParams[id];
          }
          callback(event);
          delete EthernetServiceCommunicator.controlCallbacks[id];
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

  controlMessage: function EthernetUtil_controlMessage(params, callback) {
    let id = this.idgen++;
    params.id = id;
    if (callback) {
      this.controlCallbacks[id] = callback;
    }
    this.commandParams[id] = params;
    this.ethernetService.sendCommand(params, params.ifname);
  },
};

this.EthernetIfUtils = {
  networkInterfaces: {},
  currentIfname: null,

  addInterface: function EthernetIfUtil_addInterface(iface) {
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

      // ifaceSettings = this.getInterfacePreferences(iface.name);
      // iface.useDhcp = ifaceSettings.useDhcp;
      iface.useDhcp = EthernetSettings.useDhcp;

      if (EthernetBackend._onInterfaceAdded) { // this is only used for callback
        EthernetBackend._onInterfaceAdded(iface);
      }

      Services.obs.notifyObservers(iface,
                                   kNetworkInterfaceStateChangedTopic,
                                   false);

      return true;
    }

    debug("Well, invalid interface info, we need a name here");
    return false;
  },

  getInterface: function EthernetIfUtil_getInterface(ifname) {
    debug("EthernetUtil_getInterface: " + ifname);
    return this.networkInterfaces[ifname];
  },

  removeInterface: function EthernetIfUtil_removeInterface(ifname) {
    debug("EthernetUtil_removeInterface: " + ifname);
    if (ifname in this.networkInterfaces) {
      delete this.networkInterfaces[ifname];
    }
  },

  getCurrentInterface: function EthernetIfUtil_getCurrentInterface() {
    debug("EthernetUtil_getCurrentInterface");
    return this.getInterface(this.currentIfname);
  },

  createInterface: function EthernetIfUtil_createInterface(ifname, data) {
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
      // dhcp: false, // should be removed
      hwaddress: data ? data.hwaddr : null, // no need
      ip: data ? data.ip : null,
      prefixLength: 24, // will replace netmask
      gateway: data ? data.gateway_str : null,
      netmask: data ? data.mask_str : null, // should be removed!
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

  /* process network interface data */
  updateInterface: function EthernetIfUtil_updateInterface(ifname, data) {
    if (!data) {
      debug("EthernetUtil_updateInterface - invalid data");
      return;
    }

    let iface = this.getInterface(ifname);
    if (!iface) {
      debug("EthernetUtil_updateInterface: unknown interface: " + ifname);
      return false;
    }

    this._updateProperty(iface, data, "up", "up");
    this._updateProperty(iface, data, "cableConnected", "cableConnected");
    let stateChanged = this._updateProperty(iface, data, "state", "state");
    this._updateProperty(iface, data, "hwaddress", "hwaddress");
    this._updateProperty(iface, data, "ip", "ip", "ipaddr_str");
    this._updateProperty(iface, data, "gateway", "gateway_str");
    this._updateProperty(iface, data, "netmask", "mask_str");
    this._updateProperty(iface, data, "broadcast", "broadcast_str");
    this._updateProperty(iface, data, "dns1", "dns1_str");
    this._updateProperty(iface, data, "dns2", "dns2_str");

    if (stateChanged) {
      Services.obs.notifyObservers(iface,
                                   kNetworkInterfaceStateChangedTopic,
                                   false);
    }

    return true;
  },

  _updateProperty: function(iface, data, targetProp, srcProp) {
    if (srcProp in data) {
      debug("EthernetUtil_updateInterface: updating iface." + targetProp + " with data." + srcProp);
      iface[targetProp] = data[srcProp];
      return true;
    }

    debug("EthernetUtil_updateInterface: no new data for iface." + targetProp);
    false;
  },
};

this.EthernetDHCPHelper = {
  dhcpDoRequest: function EthernetDHCPHelper_dhcpDoRequest(ifname, callback) {
    debug("EthernetUtil_dhcpDoRequest: " + ifname);
    let workParams = {
      cmd: "dhcp_do_request",
      ifname: ifname
    };

    EthernetServiceCommunicator.controlMessage(workParams, callback);
  },

  dhcpStop: function EthernetDHCPHelper_dhcpStop(ifname, callback) {
    debug("EthernetUtil_dhcpStop: " + ifname);
    let workParams = {
      cmd: "dhcp_stop",
      ifname: ifname
    };

    EthernetServiceCommunicator.controlMessage(workParams, callback);
  },

  dhcpDoRenew: function EthernetDHCPHelper_dhcpDoRenew(ifname, callback) {
    debug("EthernetUtil_dhcpDoRenew: " + ifname);
    this.dhcpStop(ifname, function(data) {
      debug("EthernetUtil_dhcpDoRenew: " + ifname + " - stop step");
      // TODO: should we validate status here?
      if (Utils.validateStatus(data)) {
        EthernetDHCPHelper.dhcpDoRequest(ifname, callback);
      }
    });
  },
};

this.EthernetStaticIPHelper = {
  config: {},
  changed: false,

  setConfig: function EthernetStaticIPHelper_setConfig(config) {
    this.changed |= StaticIPConfig.setAddrStr(config.ip);
    this.changed |= StaticIPConfig.setNetmaskStr(config.netmask);
    this.changed |= StaticIPConfig.setGatewayStr(config.gateway);
    this.changed |= StaticIPConfig.setDNS1Str(config.dns1);
    this.changed |= StaticIPConfig.setDNS2Str(config.dns2);

    if (this.changed) {
      // do the process here
      // this.changed = false; // this should be put in a callback
    }
  },

  configure: function EthernetStaticIPHelper_configure(ifname, callback) {
    dump("This is EthernetStaticIPHelper_configure");
    let workParams = {
      cmd: "ifc_configure",
      ifname: ifname,
      ipaddr: StaticIPConfig.addr,
      prefixLength: StaticIPConfig.prefixLength,
      gateway: StaticIPConfig.gateway,
      dns1: StaticIPConfig.dns1,
      dns2: StaticIPConfig.dns2
    };

    // let myCallback = function(result) {
    //   dump("This is myCallback for ifc_configure");
    //   callback(result);
    //   EthernetStaticIPHelper.changed = false;
    // };

    EthernetServiceCommunicator.controlMessage(workParams, callback);
  },

  _saveConfig: function EthernetStaticIPHelper_saveConfig(config) {

  },
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
      EthernetIfUtils.removeInterface(result.ifname);
      return;
    }

    EthernetBackend.setEnabled(true);
  },

  onIfcDisableResult: function NetUtilsCallbacks_onIfcDisableResult(result) {
    debug("NetUtilsCallbacks_onIfcDisableResult: " + result.ifname);
    if (Utils.validateStatus(result)) {
      debug("Ok, interface is disabled: " + result.ifname);
      // EthernetUtil.removeInterface(result.ifname); // need this line?
      EthernetBackend.setEnabled(false);
    }
  },

  onDhcpConnected: function NetUtilsCallbacks_onDhcpConnected(result) {
    dumpObj(result);
    if (Utils.validateStatus(result)) {
      debug("NetUtilsCallbacks_onDhcpConnected: good, we got the connection of " + result.ifname);
      result.state = result.ipaddr_str != ""
                     ? Ci.nsINetworkInterface.NETWORK_STATE_CONNECTED
                     : Ci.nsINetworkInterface.NETWORK_STATE_DISCONNECTED;
      EthernetIfUtils.updateInterface(result.ifname, result);

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
      EthernetIfUtils.currentIfname = ifname;
      let iface = EthernetIfUtils.getCurrentInterface();
      gNetworkManager.registerNetworkInterface(iface);
      // gNetworkManager.overrideActive(iface);
    } else {
      if (EthernetIfUtils.currentIfname == null) {
        EthernetIfUtils.currentIfname = ifname;
      }
    }
    EthernetBackend.setConnected(true);
  },

  onDhcpDisconnected: function NetUtilsCallbacks_onDhcpDisconnected(result) {
    dumpObj(result);
    if (Utils.validateStatus(result)) {
      debug("NetUtilsCallbacks_onDhcpDisconnected: good, got disconnect for: " + result.ifname);
      result.state = Ci.nsINetworkInterface.NETWORK_STATE_DISCONNECTED;
      EthernetIfUtils.updateInterface(result.ifname, result);
      // dumpObj(iface);
      NetUtilsCallbacks.onDisconnected(result.ifname);
    } else {
      debug("NetUtilsCallbacks_onDhcpDisconnected: bad, unable to stop dhcp for " + result.ifname);
    }
  },

  onDisconnected: function NetUtilsCallbacks_onDisconnected(ifname) {
    if (ifname == EthernetIfUtils.currentIfname) {
      EthernetIfUtils.currentIfname = null; // should we?
    }

    if (ifname == kDefaultEthernetNetworkIface) {
      debug("Ok, onDisconnected, prepare xxx ================");
      let iface = EthernetIfUtils.getInterface(ifname);
      // we have to unregister the interface, but if it is not connected before (i.e: having error), an error will happens, that is ok!
      gNetworkManager.unregisterNetworkInterface(iface);
    }
    EthernetBackend.setConnected(false);
  },

  onDhcpDoRenew: function NetUtilsCallbacks_onDhcpDoRenew(result) {

  },

  onStaticIpDoRenew: function NetUtilsCallbacks_onStaticIpDoRenew(result) {
    if (Utils.validateStatus(result)) {
      debug("NetUtilsCallbacks_onStaticIpDoRenew: good, will configure static IP");
      // dumpObj(result);
      EthernetStaticIPHelper.configure(result.ifname, NetUtilsCallbacks.onStaticIpConfigured);
    } else {
      debug("NetUtilsCallbacks_onStaticIpDoRenew: bad result from dhcpStop");
      // should we call disconnect here?
    }
  },

  onStaticIpConfigured: function NetUtilsCallbacks_onStaticIpConfigured(result) {
    if (Utils.validateStatus(result)) {
      debug("NetUtilsCallbacks_onStaticIpConfigured done! ===============");
      StaticIPConfig.convertIpsToStrings(result);
      dumpObj(result);
      result.state = result.ipaddr_str != ""
                     ? Ci.nsINetworkInterface.NETWORK_STATE_CONNECTED
                     : Ci.nsINetworkInterface.NETWORK_STATE_DISCONNECTED;
      EthernetIfUtils.updateInterface(result.ifname, result);

      if (result.state == Ci.nsINetworkInterface.NETWORK_STATE_CONNECTED) {
        NetUtilsCallbacks.onConnected(result.ifname);
      } else {
        NetUtilsCallbacks.onDisconnected(result.ifname);
      }
    } else {
      debug("NetUtilsCallbacks_onStaticIpConfigured failed");
      // should we notify disconnected here?
      NetUtilsCallbacks.onDisconnected(result.ifname);
    }
    // dumpObj(result);
  }
};

this.EthernetOBSObserver = {

  init: function EthernetOBSObserver_init() {
    Services.obs.addObserver(this, kNetdInterfaceChangedTopic, false);
  },

  observe: function EthernetOBSObserver_observe(subject, topic, data) {
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

  /* process netd message */
  onInterfaceLinkStateChanged: function EthernetOBSObserver_onInterfaceLinkstateChanged(data) {
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
    let iface = EthernetIfUtils.getInterface(ifname);
    debug("Ok, so we got the ifname: " + ifname + ", and inteface object is: " + iface);
    if (!iface) {
      debug("EthernetUtil_onInterfaceLinkstateChanged - unknown interface: " + ifname);
      return false;
    }

    let state = params[1];
    debug("the state is: " + state);
    if (state == kNetworkInterfaceUp) {
      if (iface.needRenew) {
        EthernetBackend.renewInterface(ifname);
      } else {
        EthernetBackend.connectInterface(ifname);
      }
    } else {
      EthernetBackend.disconnectInterface(ifname);
    }
  },
};

this.EthernetSettingsCallBack = {
  _handledEnabled: false,
  _handledStaticIpConfig: false,

  handleEthernetEnabled: function(enabled) {
    if (EthernetSettings.useDhcp != null) {
      this._doHandleEthernetEnabled(enabled);
    }
    // else, wait for dhcp
  },

  handleUseDhcp: function(dhcp) {
    debug("This is handle use dhcp " + dhcp);
    if (dhcp == false && !this._handledStaticIpConfig) {
      // wait for static ip config
      return;
    }
    if (!this._handledEnabled) {
      this._doHandleEthernetEnabled(EthernetSettings.enabled);
    }
    this._doHandleUseDhcp(EthernetSettings.useDhcp);
  },

  handleStaticIpConfigReady: function(config) {
    debug("So, we got the static Ip config!");
    this._doHandleStaticIpConfigReady(config);
    if (EthernetSettings.useDhcp == false) {
      this.handleUseDhcp(false);
    }
  },

  _doHandleEthernetEnabled: function(enabled) {
    this._handledEnabled = true;
    if (enabled) {
      EthernetBackend.initInterface(kDefaultEthernetNetworkIface);
    } else {
      EthernetBackend.shutdown();
    }
  },

  _doHandleUseDhcp: function(dhcp) {
    debug("This handle use dhcp: seem we do not need to do anything?, may be some trigger is needed!");
    debug("======= btw, dhcp = " + dhcp);
    EthernetBackend.callbackObj.onDhcpChanged(dhcp);
  },

  _doHandleStaticIpConfigReady: function(config) {
    debug("So, we got the static Ip config!");
    debug(config);
    this._handledStaticIpConfig = true;
    StaticIPConfig.initWithData(config);
  },
}

var DEBUG = true; // set to true to show debug messages

let debug;
if (DEBUG) {
  debug = function (s) {
    dump("-*- EthernetUtilPrivate.js component: " + s + "\n");
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