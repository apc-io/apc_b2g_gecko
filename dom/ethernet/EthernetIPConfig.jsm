//
// trungnt

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/systemlibs.js");

this.EXPORTED_SYMBOLS = ["StaticIPConfig"];

this.StaticIPConfig = {
  addr: 0,
  addrStr: "",
  mask: 0,
  maskStr: "",
  prefixLength: 0,
  gateway: 0,
  gatewayStr: "",
  dns1: 0,
  dns1Str: "",
  dns2: 0,
  dns2Str: "",

  initWithData: function(data) {
  	this.setAddr(data.addr);
  	this.setNetmask(data.mask);
  	this.setGateway(data.gateway);
  	this.setDNS1(data.dns1);
  	this.setDNS2(data.dns2);
  },

  setAddr: function(val) {
    return this._setVal(val, "addr", "addrStr");
  },

  setAddrStr: function(str) {
    return this._setStr(str, "addr", "addrStr");
  },

  setNetmask: function(val) {
    if (this._setVal(val, "mask", "maskStr")) {
      this._calPrefixLength();
      return true;
    }
    return false;
  },

  setNetmaskStr: function(str) {
    if (this._setStr(str, "mask", "maskStr")) {
      this._calPrefixLength();
      return true;
    }
    return false;
  },

  setGateway: function(val) {
    return this._setVal(val, "gateway", "gatewayStr");
  },

  setGatewayStr: function(str) {
    return this._setStr(str, "gateway", "gatewayStr");
  },

  setDNS1: function(val) {
    return this._setVal(val, "dns1", "dns1Str");
  },

  setDNS1Str: function(str) {
    return this._setStr(str, "dns1", "dns1Str");
  },

  setDNS2: function(val) {
    return this._setVal(val, "dns2", "dns2Str");
  },

  setDNS2Str: function(str) {
    return this._setStr(str, "dns2", "dns2Str");
  },

  convertIpsToStrings: function(data) {
    data.ipaddr_str = netHelpers.ipToString(data.ipaddr);
    data.gateway_str = netHelpers.ipToString(data.gateway);
    data.mask_str = netHelpers.ipToString(data.mask);
    data.dns1_str = netHelpers.ipToString(data.dns1);
    data.dns2_str = netHelpers.ipToString(data.dns2);
  },

  _convertValToStr: function(val) {
    return undefined;
  },

  _convertStrToVal: function(str) {
    return -1;
  },

  _setVal: function(val, valVar, strVar) {
    debug("_setVal " + valVar + " to " + val);
    let str = netHelpers.ipToString(val);
    StaticIPConfig[valVar] = val;
    StaticIPConfig[strVar] = str;
    debug("So the str value is " + str);
    // if (str != undefined) {
    //   // StaticIPConfig[valVar] = val;
    //   // StaticIPConfig[strVar] = str;
    //   return true;
    // }
    // debug("Error with _setVal " + valVar);
    return true;
  },

  _setStr: function(str, valVar, strVar) {
    debug("_setStr " + strVar + " to " + str);
    let val = netHelpers.stringToIP(str);
    StaticIPConfig[valVar] = val;
    StaticIPConfig[strVar] = str;
    debug("So the number value is " + val + " test : " + netHelpers.ipToString(val));
    // if (val > -1) {
    //   // StaticIPConfig[valVar] = val;
    //   // StaticIPConfig[strVar] = str;
    //   return true;
    // }
    // debug("Error with _setStr " + strVar);
    return true;
  },

  _calPrefixLength: function() {
    // just return 0 for now
    this.prefixLength = netHelpers.getMaskLength(this.mask);
  },
};

var DEBUG = true; // set to true to show debug messages

let debug;
if (DEBUG) {
  debug = function (s) {
    dump("-*- EthernetUtil.js component: " + s + "\n");
  };
} else {
  debug = function (s) {};
}