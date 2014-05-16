/*
 * trungnt
 */
// "use strict";

this.EXPORTED_SYMBOLS = ["EthernetSettings"];

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");

XPCOMUtils.defineLazyServiceGetter(this, "gSettingsService",
                                   "@mozilla.org/settingsService;1",
                                   "nsISettingsService");

// Settings DB path for ETHERNET
const kSettingsEthernetEnabled      = "ethernet.enabled";
const kSettingsEthernetDebugEnabled = "ethernet.debugging.enabled";
const kSettingsEthernetUseDhcp      = "ethernet.usedhcp";
const kSettingsEthernetAddr         = "ethernet.ip";
const kSettingsEthernetMask         = "ethernet.mask";
const kSettingsEthernetGateway      = "ethernet.gateway";
const kSettingsEthernetDNS1         = "ethernet.dns1";
const kSettingsEthernetDNS2         = "ethernet.dns2";

// common constants
const kDefaultEthernetNetworkIface = "eth0";

const kDefaultStaticIpConfig = {
  addr: 0,
  mask: 24,
  gateway: 0,
  dns1: 0,
  dns2: 0,
};

var getEthernetEnableCb = {
  handle: function handle(aName, aResult) {
    if (aName !== kSettingsEthernetEnabled)
      return;
    if (aResult === null)
      aResult = true;
    EthernetSettings._handleEthernetEnabled(aResult);
  },
  handleError: function handleError(aErrorMessage) {
    debug("Error reading the 'ethernet.enabled' setting. Default to ethernet on.");
    EthernetSettings._handleEthernetEnabled(true);
  }
};

var getUseDhcpCb = {
  handle: function(name, result) {
    if (name !== kSettingsEthernetUseDhcp) {
      return;
    }
    if (result == null) {
      result = true;
    }

    EthernetSettings._handleUseDhcp(result);
  },
  handleError: function(message) {
    debug("Error reading 'ethernet.usedhcp' settings. Default to dhcp on.");
    EthernetSettings._handleUseDhcp(true);
  }
};

var saveSettingsCb = {
  handle: function(name, result) {
    debug("Saving " + name + " done!");
  },
  handleError: function(msg) {
    debug("O_o, error " + msg);
  }
};

var lock = gSettingsService.createLock();

this.EthernetSettings = {
  enabled: false,
  useDhcp: null,
  staticIpConfig: kDefaultStaticIpConfig,

  _callBackObj: null,
  _staticFields: 0,

  setCallbackObject: function(obj) {
    debug("=-==-=-=-= set _callBackObj to " + obj);
    this._callBackObj = obj;
  },

  loadStartupPreferences: function() {
    debug("Ethernet settings integration");
    lock.get(kSettingsEthernetEnabled, getEthernetEnableCb);
    lock.get(kSettingsEthernetUseDhcp, getUseDhcpCb);
    lock.get(kSettingsEthernetAddr, this);
    lock.get(kSettingsEthernetMask, this);
    lock.get(kSettingsEthernetGateway, this);
    lock.get(kSettingsEthernetDNS1, this);
    lock.get(kSettingsEthernetDNS2, this);
  },

  saveEnabled: function(val) {
    if (this.enabled != val) {
      this.enabled = val;
      this._setSettings(kSettingsEthernetEnabled, val);
    }
  },

  saveUseDhcp: function(val) {
    debug("saveUseDhcp to " + val);
    if (this.useDhcp != val) {
      debug("Ok, let's update it!");
      this.useDhcp = val;
      this._setSettings(kSettingsEthernetUseDhcp, val);
      this._handleUseDhcp(val);
    } else {
      debug("well, no need to update useDhcp");
    }
  },

  saveAddr: function(val) {
    if (this.staticIpConfig.addr != val) {
      this.staticIpConfig.addr = val;
      this._setSettings(kSettingsEthernetAddr, val);
    }
  },

  saveNetmask: function(val) {
    if (this.staticIpConfig.mask != val) {
      this.staticIpConfig.mask = val;
      this._setSettings(kSettingsEthernetMask, val);
    }
  },

  saveGateway: function(val) {
    if (this.staticIpConfig.gateway != val) {
      this.staticIpConfig.gateway = val;
      this._setSettings(kSettingsEthernetGateway, val);
    }
  },

  saveDNS1: function(val) {
    if (this.staticIpConfig.dns1 != val) {
      this.staticIpConfig.dns1 = val;
      this._setSettings(kSettingsEthernetDNS1, val);
    }
  },

  saveDNS2: function(val) {
    if (this.staticIpConfig.dns2 != val) {
      this.staticIpConfig.dns2 = val;
      this._setSettings(kSettingsEthernetDNS2, val);
    }
  },

  _setSettings: function(settingVar, val) {
    gSettingsService.createLock().set(settingVar, val, saveSettingsCb, "EthernetSettings");
  },

  _handleEthernetEnabled: function(val) {
    this.enabled = val;
    if (this._callBackObj.handleEthernetEnabled) {
      this._callBackObj.handleEthernetEnabled(val);
    }
  },

  _handleUseDhcp: function(val) {
    this.useDhcp = val;
    if (this._callBackObj.handleUseDhcp) {
      this._callBackObj.handleUseDhcp(val);
    }
  },

  handle: function SettingsGetHandle(name, result) {
    debug("-------- got " + name + " = " + result);
    if (result == null) {
      result = 0;
    }
    switch (name) {
      case kSettingsEthernetAddr:
        this.staticIpConfig.addr = result;
        this._staticFields += 1;
        break;
      case kSettingsEthernetMask:
        this.staticIpConfig.mask = result;
        this._staticFields += 1;
        break;
      case kSettingsEthernetGateway:
        this.staticIpConfig.gateway = result;
        this._staticFields += 1;
        break;
      case kSettingsEthernetDNS1:
        this.staticIpConfig.dns1 = result;
        this._staticFields += 1;
        break;
      case kSettingsEthernetDNS2:
        this.staticIpConfig.dns2 = result;
        this._staticFields += 1;
        break;
      default:
        debug("Unknow setting " + name);
    }
    if (this._staticFields == 5) {
      if (this._callBackObj.handleStaticIpConfigReady) {
        this._callBackObj.handleStaticIpConfigReady(this.staticIpConfig);
      }
    }
  },

  handleError: function SettingsGetHandleError(msg) {
    debug("Got error " + msg);
    this.staticIpConfig = kDefaultStaticIpConfig;
    this._callBackObj.handleStaticIpConfigReady(this.staticIpConfig);
  },

};

var DEBUG = false;
let debug;
if (DEBUG) {
  debug = function(msg) {
    dump("++ * ++ EthernetSettings.jsm: " + msg);
  }
} else {
  debug = function(msg) {}
}