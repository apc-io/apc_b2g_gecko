"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/DOMRequestHelper.jsm");
Cu.import("resource://gre/modules/HotkeyServiceConstants.jsm");

XPCOMUtils.defineLazyServiceGetter(this, "gSettingsService",
                                   "@mozilla.org/settingsService;1",
                                   "nsISettingsService");

const HOTKEYSERVICE_CONTRACTID = "@mozilla.org/hotkeyservice;1";
const HOTKEYSERVICE_CID         = Components.ID("{beed013c-eb25-48bd-ad23-bce25923876c}");

const DOM_VK_META           = 0xE0;
const DOM_VK_END            = 0x23;
const DOM_VK_PAGE_UP        = 0x21;
const DOM_VK_PAGE_DOWN      = 0x22;

const NO_KEY = -1; // we used to use 0, but if a key is not map by gecko, its code is 0, too -> must use -1

const kHomeKey = "hotkey.home";
const kMuteKey = "hotkey.mute";
const kVolumeUpKey = "hotkey.volumeUp";
const kVolumeDownKey = "hotkey.volumeDown";

const DEBUG = false; // set to false to suppress debug messages

function HotkeyService() {
    // setting up message listeners
  this._mm = Cc["@mozilla.org/parentprocessmessagemanager;1"]
             .getService(Ci.nsIMessageListenerManager);
  const messages = [HotkeyServiceMessage.GETHOTKEYS,
                    // HotkeyServiceMessage.GETHOMEKEY,      HotkeyServiceMessage.GETMUTEKEY,
                    // HotkeyServiceMessage.GETVOLUMEUPKEY,  HotkeyServiceMessage.GETVOLUMEDOWNKEY,
                    HotkeyServiceMessage.BEGINEDIT,       HotkeyServiceMessage.ENDEDIT,
                    HotkeyServiceMessage.SETHOMEKEY,      HotkeyServiceMessage.SETMUTEKEY,
                    HotkeyServiceMessage.SETVOLUMEUPKEY,  HotkeyServiceMessage.SETVOLUMEDOWNKEY,
                    HotkeyServiceMessage.SETKEYRESULT,    "child-process-shutdown"];

  messages.forEach((function(msgName) {
    this._mm.addMessageListener(msgName, this);
  }).bind(this));
}

HotkeyService.prototype = {
  // __proto__: DOMRequestIpcHelper.prototype,
  _xpcom_factory: XPCOMUtils.generateSingletonFactory(HotkeyService),

  classID:   HOTKEYSERVICE_CID ,
  classInfo: XPCOMUtils.generateCI({classID: HOTKEYSERVICE_CID ,
                                    contractID: HOTKEYSERVICE_CONTRACTID,
                                    classDescription: "Hotkey Service",
                                    interfaces: [Ci.nsIHotkeyService],
                                    flags: Ci.nsIClassInfo.DOM_OBJECT}),

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIHotkeyService,
                                         // Ci.nsIDOMGlobalPropertyInitializer,
                                         Ci.nsIObserver,
                                         Ci.nsIMessageListener,
                                         Ci.nsISupportsWeakReference]),

  _domManagers: [],
  _sendMessage: function(message, data) {
    this._domManagers.forEach(function(manager) {
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
    switch (aMessage.name) {
      case HotkeyServiceMessage.GETHOTKEYS:
      {
        if (this._domManagers.indexOf(msg.manager) == -1) {
          this._domManagers.push(msg.manager);
        }
        let result = {
          home: this._home,
          mute: this._mute,
          volumeUp: this._volumeUp,
          volumeDown: this._volumeDown,
        };
        debug("ok, let's getHotkeys");
        return result;
      }
      // here, we return to the DOMHotkeyManager to display on the ux, so no need to check for this._editing
      case HotkeyServiceMessage.GETHOMEKEY:
        return this._home;
      case HotkeyServiceMessage.GETMUTEKEY:
        return this._mute;
      case HotkeyServiceMessage.GETVOLUMEUPKEY:
        return this._volumeUp;
      case HotkeyServiceMessage.GETVOLUMEDOWNKEY:
        return this._volumeDown;
      case HotkeyServiceMessage.BEGINEDIT:
        this.beginEditHotkey();
        break;
      case HotkeyServiceMessage.ENDEDIT:
        this.endEditHotkey();
        break;
      case HotkeyServiceMessage.SETHOMEKEY:
        debug(HotkeyServiceMessage.SETHOMEKEY + " - data = " + msg.data);
        this.setHomeKey(msg.data);
        break;
      case HotkeyServiceMessage.SETMUTEKEY:
        debug(HotkeyServiceMessage.SETMUTEKEY + " - data = " + msg.data);
        this.setMuteKey(msg.data);
        break;
      case HotkeyServiceMessage.SETVOLUMEUPKEY:
        debug(HotkeyServiceMessage.SETVOLUMEUPKEY + " - data = " + msg.data);
        this.setVolumeUpKey(msg.data);
        break;
      case HotkeyServiceMessage.SETVOLUMEDOWNKEY:
        debug(HotkeyServiceMessage.SETVOLUMEDOWNKEY + " - data = " + msg.data);
        this.setVolumeDownKey(msg.data);
        break;
      default:
        debug("Well, we do not support: " + aMessage.name);
    }
    debug("Well, after: " + aMessage.name);
  },

  init: function() {
  	debug("Well, nothing to do in this init function?");
  	// read from settings
  	this._init();
  },

  get homeKey() {
  	debug("home key is the function to get the homekey: " + this._home + " and editing status is " + this._editing);
  	this._checkPermission();
    return this._returnKey(this._home);
  },

  get muteKey() {
    debug("muteKey - isEditing " + this._editing);
  	this._checkPermission();
    return this._returnKey(this._mute);
  },

  get volumeUpKey() {
  	debug("volumeUpKey - isEditing " + this._editing);
  	this._checkPermission();
    return this._returnKey(this._volumeUp);
  },

  get volumeDownKey() {
  	debug("_volumeDownKey - isEditing " + this._editing + " _ " + this._volumeDown);
  	this._checkPermission();
    return this._returnKey(this._volumeDown);
  },

  beginEditHotkey: function() {
  	this._checkPermission();
  	debug("Mark editing state to true");
  	this._editing = true;
  },
  
  endEditHotkey: function() {
  	this._checkPermission();
  	this._editing = false;
  },

  setHomeKey: function(key) {
  	this._checkPermission();
    let result = this._validateKey(HotkeyServiceMessage.SETHOMEKEY, key);
    if (result.errCode == 0) {
  	  this._home = result.key;
  	  this._saveSettings(kHomeKey, result.key);
    }
  	this._sendMessage(HotkeyServiceMessage.SETKEYRESULT, result);
  },

  setMuteKey: function(key) {
  	this._checkPermission();
  	let result = this._validateKey(HotkeyServiceMessage.SETMUTEKEY, key);
    if (result.errCode == 0) {
  	  this._mute = result.key;
  	  this._saveSettings(kMuteKey, result.key);
    }
    this._sendMessage(HotkeyServiceMessage.SETKEYRESULT, result);
  },
  
  setVolumeUpKey: function(key) {
  	this._checkPermission();
    let result = this._validateKey(HotkeyServiceMessage.SETVOLUMEUPKEY, key);
    if (result.errCode == 0) {
  	  this._volumeUp = result.key;
  	  this._saveSettings(kVolumeUpKey, result.key);
    }
    this._sendMessage(HotkeyServiceMessage.SETKEYRESULT, result);
  },

  setVolumeDownKey: function(key) {
  	this._checkPermission();
  	let result = this._validateKey(HotkeyServiceMessage.SETVOLUMEDOWNKEY, key);
    if (result.errCode == 0) {
  	  this._volumeDown = result.key;
  	  this._saveSettings(kVolumeDownKey, result.key);
    }
    this._sendMessage(HotkeyServiceMessage.SETKEYRESULT, result);
  },

  _init: function() {
  	if (this.isInit) {
  		return;
  	}
  	debug("Here is the _init() function");
  	this._home = DOM_VK_META;
  	this._mute = DOM_VK_END;
  	this._volumeUp = DOM_VK_PAGE_UP;
  	this._volumeDown = DOM_VK_PAGE_DOWN;
  	this._editing = false;

  	var self = this;
  	
  	this.readHotkeysCb = {
  		handle: function handle(aName, aResult) {
  			if (aResult == null) {
  				debug("Key for " + aName + " is null, the default value is used!");
  				return;
  			} else if (aResult == 0) {
          // this mean no key is set, because value 0 will be emitted if unmap key is pressed
          aResult = -1;
          debug("Well, no key is set for " + aName);
        } else {
  				debug("Value for " + aName + " is " + aResult);
  			}
  			switch (aName) {
  			case kHomeKey:
  				self._home = aResult;
  				break;
  			case kMuteKey:
  				self._mute = aResult;
  				break;
  			case kVolumeUpKey:
  				self._volumeUp = aResult;
  				break;
  			case kVolumeDownKey:
  				self._volumeDown = aResult;
  				break;
  			default:
  				debug("Invalid settings!");
  			}
  		},
  		handleError: function handleError(aErrorMessage) {
    		debug("Error reading settings: " + aErrorMessage);
  		}
	  };

	  this.writeSettingsCb = {
  		handle: function(name, result) {
    		debug("Saving " + name + " done!");
  		},
  		handleError: function(msg) {
    		debug("O_o, error " + msg);
  		}
	  };

  	var lock = gSettingsService.createLock();
	  debug("Reading hotkey settings");
	  lock.get(kHomeKey, this.readHotkeysCb);
	  lock.get(kMuteKey, this.readHotkeysCb);
	  lock.get(kVolumeUpKey, this.readHotkeysCb);
	  lock.get(kVolumeDownKey, this.readHotkeysCb);
	  this.isInit = true;
  },

  _checkPermission: function() {
  	// do we need this kind of function?, may be no!
  	return true;
  },

  _validateKey: function(msg, key) {
    debug("Ok, doing validation!");
    if (key == 0) {
      key = -1;
    }

    let result = {
      errCode: 0, // ok
      errMsg: "",
      message: msg,
      key: key,
    };

    if (key == -1) {
      return result;
    }

    // not smart but good enough for just a small number of keys :)
    if (key == this._home || key == this._mute || key == this._volumeUp || key == this._volumeDown) {
      result.errCode = -1;
      result.errMsg = HotkeyErrorMessage.KEYINUSED;
    }

    return result;
  },

  _saveSettings: function(varName, varVal) {
  	debug("Saving settings " + varName + " => " + varVal);
  	gSettingsService.createLock().set(varName, varVal, this.writeSettingsCb, "HotkeysService");
  },

  _returnKey: function(key) {
    return this._editing ? NO_KEY : key;
  }
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([HotkeyService]);

let debug;
if (DEBUG) {
  debug = function (s) {
    dump("-*- HotkeyService component: " + s + "\n");
  };
} else {
  debug = function (s) {};
}
