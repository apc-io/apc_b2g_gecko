"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/DOMRequestHelper.jsm");
Cu.import("resource://gre/modules/HotkeyServiceConstants.jsm");

XPCOMUtils.defineLazyServiceGetter(this, "gSettingsService",
                                   "@mozilla.org/settingsService;1",
                                   "nsISettingsService");

const DOMHOTKEYMANAGER_CONTRACTID = "@mozilla.org/hotkeymanager;1";
const DOMHOTKEYMANAGER_CID        = Components.ID("{f0616ef4-ee47-47d7-affe-904bcb06e381}");

const DEBUG = false; // set to false to suppress debug messages


function DOMHotkeyManager() {
}

DOMHotkeyManager.prototype = {
  __proto__: DOMRequestIpcHelper.prototype,
  _xpcom_factory: XPCOMUtils.generateSingletonFactory(DOMHotkeyManager),

  classID:   DOMHOTKEYMANAGER_CID,
  classInfo: XPCOMUtils.generateCI({classID: DOMHOTKEYMANAGER_CID,
                                    contractID: DOMHOTKEYMANAGER_CONTRACTID,
                                    classDescription: "DOM Hotkey Manager",
                                    interfaces: [Ci.nsIDOMHotkeyManager],
                                    flags: Ci.nsIClassInfo.DOM_OBJECT}),

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIDOMHotkeyManager,
                                         Ci.nsIDOMGlobalPropertyInitializer,
                                         Ci.nsIObserver,
                                         Ci.nsIMessageListener,
                                         Ci.nsISupportsWeakReference]),

  init: function(aWindow) {
    const messages = [HotkeyServiceMessage.GETHOTKEYS,
                      // HotkeyServiceMessage.GETHOMEKEY,      HotkeyServiceMessage.GETMUTEKEY,
                      // HotkeyServiceMessage.GETVOLUMEUPKEY,  HotkeyServiceMessage.GETVOLUMEDOWNKEY,
                      HotkeyServiceMessage.BEGINEDIT,       HotkeyServiceMessage.ENDEDIT,
                      HotkeyServiceMessage.SETHOMEKEY,      HotkeyServiceMessage.SETMUTEKEY,
                      HotkeyServiceMessage.SETVOLUMEUPKEY,  HotkeyServiceMessage.SETVOLUMEDOWNKEY,
                      HotkeyServiceMessage.SETKEYRESULT];

    this.initDOMRequestHelper(aWindow, messages);

    this._mm = Cc["@mozilla.org/childprocessmessagemanager;1"].getService(Ci.nsISyncMessageSender);
    let hotkeys = this._mm.sendSyncMessage(HotkeyServiceMessage.GETHOTKEYS);
    if (0 in hotkeys) {
      hotkeys = hotkeys[0];
    }
    for (let k in hotkeys) {
      debug("Hotkeys." + k + " = " + hotkeys[k]);
    }
    this._home = hotkeys.home;
    this._mute = hotkeys.mute;
    this._volumeUp = hotkeys.volumeUp;
    this._volumeDown = hotkeys.volumeDown;
    this._onHotkeySetResult = null;
  },

  receiveMessage: function(aMessage) {
    debug("receiveMessage: " + aMessage.name);
    let msg = aMessage.json;
    if (msg.mid && msg.mid != this._id)
      return;
    let result = aMessage.data || {};
    switch (aMessage.name) {
      case HotkeyServiceMessage.SETKEYRESULT:
        debug("Ok, got the result of sethotkey");
        if (result.errCode == 0) { // ok
          switch (result.message) {
          case HotkeyServiceMessage.SETHOMEKEY:
            this._home = result.key;
            break;
          case HotkeyServiceMessage.SETMUTEKEY:
            this._mute = result.key;
            break;
          case HotkeyServiceMessage.SETVOLUMEUPKEY:
            this._volumeUp = result.key;
            break;
          case HotkeyServiceMessage.SETVOLUMEDOWNKEY:
            this._volumeDown = result.key;
            break;
          default:
            debug("Invalid message");
          }
        } else {
          // error
        }

        if (this._onHotkeySetResult) {
          var evt = new this._window.Event(this._createEventType(result));
          this._onHotkeySetResult.handleEvent(evt);
        }
        break;
      default:
        debug("We don't handle this kind of message: " + aMessage.name);
    }
  },

  get homeKey() {
  	this._checkPermission();
  	return this._home;
  },

  get muteKey() {
  	this._checkPermission();
  	return this._mute;
  },

  get volumeUpKey() {
  	this._checkPermission();
  	return this._volumeUp;
  },

  get volumeDownKey() {
  	this._checkPermission();
  	return this._volumeDown;
  },

  beginEditHotkey: function() {
  	this._checkPermission();
    this._sendRequest(HotkeyServiceMessage.BEGINEDIT, null);
  },
  
  endEditHotkey: function() {
  	this._checkPermission();
  	this._sendRequest(HotkeyServiceMessage.ENDEDIT, null);
  },

  setHomeKey: function(key) {
  	debug("We gonna set homekey to " + key);
  	this._checkPermission();
    this._sendRequest(HotkeyServiceMessage.SETHOMEKEY, key);
  },

  setMuteKey: function(key) {
  	this._checkPermission();
  	this._sendRequest(HotkeyServiceMessage.SETMUTEKEY, key);
  },
  
  setVolumeUpKey: function(key) {
    debug("We gonna set volumeUp key to " + key);
  	this._checkPermission();
  	this._sendRequest(HotkeyServiceMessage.SETVOLUMEUPKEY, key);
  },

  setVolumeDownKey: function(key) {
  	this._checkPermission();
    this._sendRequest(HotkeyServiceMessage.SETVOLUMEDOWNKEY, key);
  },

  set onHotkeySetResult(callback) {
    this._checkPermission();
    debug("Well, settings the callback for onHotkeySetResult: " + callback);
    this._onHotkeySetResult = callback;
  },

  _checkPermission: function() {
  	// do we need this kind of function?, may be no!
  	return true;
  },

  _sendRequest: function(msg, data) {
    var request = this.createRequest();
    debug("_sendMessageForRequest()" + msg + "," + data + "," + request);
    let id = this.getRequestId(request);
    this._mm.sendAsyncMessage(msg, { data: data, rid: id, mid: this._id });
    return request;
  },

  _createEventType: function(result) {
    var type = "hotkeySetResult:" + result.errCode;
    return type;
  },
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([DOMHotkeyManager]);

let debug;
if (DEBUG) {
  debug = function (s) {
    dump("-*- DOMHotkeyManager component: " + s + "\n");
  };
} else {
  debug = function (s) {};
}
