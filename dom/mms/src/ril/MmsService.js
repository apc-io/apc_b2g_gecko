/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*-
 * vim: sw=2 ts=2 sts=2 et filetype=javascript
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");

Cu.import("resource://gre/modules/NetUtil.jsm");

const RIL_MMSSERVICE_CONTRACTID = "@mozilla.org/mms/rilmmsservice;1";
const RIL_MMSSERVICE_CID = Components.ID("{217ddd76-75db-4210-955d-8806cd8d87f9}");

const DEBUG = false;

const kNetworkInterfaceStateChangedTopic = "network-interface-state-changed";
const kXpcomShutdownObserverTopic        = "xpcom-shutdown";
const kPrefenceChangedObserverTopic      = "nsPref:changed";

// HTTP status codes:
// @see http://tools.ietf.org/html/rfc2616#page-39
const HTTP_STATUS_OK = 200;

const CONFIG_SEND_REPORT_NEVER       = 0;
const CONFIG_SEND_REPORT_DEFAULT_NO  = 1;
const CONFIG_SEND_REPORT_DEFAULT_YES = 2;
const CONFIG_SEND_REPORT_ALWAYS      = 3;

const TIME_TO_BUFFER_MMS_REQUESTS    = 30000;
const TIME_TO_RELEASE_MMS_CONNECTION = 30000;

XPCOMUtils.defineLazyServiceGetter(this, "gpps",
                                   "@mozilla.org/network/protocol-proxy-service;1",
                                   "nsIProtocolProxyService");

XPCOMUtils.defineLazyServiceGetter(this, "gUUIDGenerator",
                                   "@mozilla.org/uuid-generator;1",
                                   "nsIUUIDGenerator");

XPCOMUtils.defineLazyServiceGetter(this, "gRIL",
                                   "@mozilla.org/ril;1",
                                   "nsIRadioInterfaceLayer");

XPCOMUtils.defineLazyGetter(this, "MMS", function () {
  let MMS = {};
  Cu.import("resource://gre/modules/MmsPduHelper.jsm", MMS);
  return MMS;
});

XPCOMUtils.defineLazyGetter(this, "gMmsConnection", function () {
  let conn = {
    QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver]),

    /** MMS proxy settings. */
    mmsc: null,
    proxy: null,
    port: null,

    proxyInfo: null,
    settings: ["ril.mms.mmsc",
               "ril.mms.mmsproxy",
               "ril.mms.mmsport"],
    connected: false,

    //A queue to buffer the MMS HTTP requests when the MMS network
    //is not yet connected. The buffered requests will be cleared
    //if the MMS network fails to be connected within a timer.
    pendingCallbacks: [],

    /** MMS network connection reference count. */
    refCount: 0,

    connectTimer: Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer),

    disconnectTimer: Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer),

    /**
     * Callback when |connectTimer| is timeout or cancelled by shutdown.
     */
    onConnectTimerTimeout: function onConnectTimerTimeout() {
      debug("onConnectTimerTimeout: " + this.pendingCallbacks.length
            + " pending callbacks");
      while (this.pendingCallbacks.length) {
        let callback = this.pendingCallbacks.shift();
        callback(false);
      }
    },

    /**
     * Callback when |disconnectTimer| is timeout or cancelled by shutdown.
     */
    onDisconnectTimerTimeout: function onDisconnectTimerTimeout() {
      debug("onDisconnectTimerTimeout: deactivate the MMS data call.");
      if (this.connected) {
        gRIL.deactivateDataCallByType("mms");
      }
    },

    init: function init() {
      Services.obs.addObserver(this, kNetworkInterfaceStateChangedTopic,
                               false);
      Services.obs.addObserver(this, kXpcomShutdownObserverTopic, false);
      this.settings.forEach(function(name) {
        Services.prefs.addObserver(name, this, false);
      }, this);

      try {
        this.mmsc = Services.prefs.getCharPref("ril.mms.mmsc");
        this.proxy = Services.prefs.getCharPref("ril.mms.mmsproxy");
        this.port = Services.prefs.getIntPref("ril.mms.mmsport");
        this.updateProxyInfo();
      } catch (e) {
        debug("Unable to initialize the MMS proxy settings from the" +
              "preference. This could happen at the first-run. Should be" +
              "available later.");
        this.clearMmsProxySettings();
      }
    },

    /**
     * Acquire the MMS network connection.
     *
     * @param callback
     *        Callback function when either the connection setup is done,
     *        timeout, or failed. Accepts a boolean value that indicates
     *        whether the connection is ready.
     *
     * @return true if the MMS network connection is already acquired and the
     *              callback is done; false otherwise.
     */
    acquire: function acquire(callback) {
      this.connectTimer.cancel();

      // If the MMS network is not yet connected, buffer the
      // MMS request and try to setup the MMS network first.
      if (!this.connected) {
        debug("acquire: buffer the MMS request and setup the MMS data call.");
        this.pendingCallbacks.push(callback);
        gRIL.setupDataCallByType("mms");

        // Set a timer to clear the buffered MMS requests if the
        // MMS network fails to be connected within a time period.
        this.connectTimer.
          initWithCallback(this.onConnectTimerTimeout.bind(this),
                           TIME_TO_BUFFER_MMS_REQUESTS,
                           Ci.nsITimer.TYPE_ONE_SHOT);
        return false;
      }

      this.refCount++;

      callback(true);
      return true;
    },

    /**
     * Release the MMS network connection.
     */
    release: function release() {
      this.refCount--;
      if (this.refCount <= 0) {
        this.refCount = 0;

        // Set a timer to delay the release of MMS network connection,
        // since the MMS requests often come consecutively in a short time.
        this.disconnectTimer.
          initWithCallback(this.onDisconnectTimerTimeout.bind(this),
                           TIME_TO_RELEASE_MMS_CONNECTION,
                           Ci.nsITimer.TYPE_ONE_SHOT);
      }
    },

    /**
     * Update the MMS proxy info.
     */
    updateProxyInfo: function updateProxyInfo() {
      if (this.proxy === null || this.port === null) {
        debug("updateProxyInfo: proxy or port is not yet decided." );
        return;
      }

      this.proxyInfo =
        gpps.newProxyInfo("http", this.proxy, this.port,
                          Ci.nsIProxyInfo.TRANSPARENT_PROXY_RESOLVES_HOST,
                          -1, null);
      debug("updateProxyInfo: " + JSON.stringify(this.proxyInfo));
    },

    /**
     * Clear the MMS proxy settings.
     */
    clearMmsProxySettings: function clearMmsProxySettings() {
      this.mmsc = null;
      this.proxy = null;
      this.port = null;
      this.proxyInfo = null;
    },

    shutdown: function shutdown() {
      Services.obs.removeObserver(this, kNetworkInterfaceStateChangedTopic);
      this.settings.forEach(function(name) {
        Services.prefs.removeObserver(name, this);
      }, this);
      this.connectTimer.cancel();
      this.onConnectTimerTimeout();
      this.disconnectTimer.cancel();
      this.onDisconnectTimerTimeout();
    },

    // nsIObserver

    observe: function observe(subject, topic, data) {
      switch (topic) {
        case kNetworkInterfaceStateChangedTopic: {
          this.connected =
            gRIL.getDataCallStateByType("mms") ==
              Ci.nsINetworkInterface.NETWORK_STATE_CONNECTED;

          if (!this.connected) {
            return;
          }

          debug("Got the MMS network connected! Resend the buffered " +
                "MMS requests: number: " + this.pendingCallbacks.length);
          this.connectTimer.cancel();
          while (this.pendingCallbacks.length) {
            let callback = this.pendingCallbacks.shift();
            callback(true);
          }
          break;
        }
        case kPrefenceChangedObserverTopic: {
          try {
            switch (data) {
              case "ril.mms.mmsc":
                this.mmsc = Services.prefs.getCharPref("ril.mms.mmsc");
                break;
              case "ril.mms.mmsproxy":
                this.proxy = Services.prefs.getCharPref("ril.mms.mmsproxy");
                this.updateProxyInfo();
                break;
              case "ril.mms.mmsport":
                this.port = Services.prefs.getIntPref("ril.mms.mmsport");
                this.updateProxyInfo();
                break;
              default:
                break;
            }
          } catch (e) {
            debug("Failed to update the MMS proxy settings from the" +
                  "preference.");
            this.clearMmsProxySettings();
          }
          break;
        }
        case kXpcomShutdownObserverTopic: {
          Services.obs.removeObserver(this, kXpcomShutdownObserverTopic);
          this.shutdown();
        }
      }
    }
  };
  conn.init();

  return conn;
});

function MmsProxyFilter(url) {
  this.url = url;
}
MmsProxyFilter.prototype = {

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIProtocolProxyFilter]),

  // nsIProtocolProxyFilter

  applyFilter: function applyFilter(proxyService, uri, proxyInfo) {
    let url = uri.prePath + uri.path;
    if (url.endsWith("/")) {
      url = url.substr(0, url.length - 1);
    }

    if (this.url != url) {
      debug("applyFilter: content uri = " + this.url +
            " is not matched url = " + url + " .");
      return proxyInfo;
    }
    // Fall-through, reutrn the MMS proxy info.
    debug("applyFilter: MMSC is matched: " +
          JSON.stringify({ url: this.url,
                           proxyInfo: gMmsConnection.proxyInfo }));
    return gMmsConnection.proxyInfo ? gMmsConnection.proxyInfo : proxyInfo;
  }
};

XPCOMUtils.defineLazyGetter(this, "gMmsTransactionHelper", function () {
  return {
    /**
     * Send MMS request to MMSC.
     *
     * @param method
     *        "GET" or "POST".
     * @param url
     *        Target url string.
     * @param istream
     *        An nsIInputStream instance as data source to be sent or null.
     * @param callback
     *        A callback function that takes two arguments: one for http
     *        status, the other for wrapped PDU data for further parsing.
     */
    sendRequest: function sendRequest(method, url, istream, callback) {
      // TODO: bug 810226 - Support of GPRS bearer for MMS transmission and
      //                     reception

      gMmsConnection.acquire((function (method, url, istream, callback,
                                        connected) {
        if (!connected) {
          // Connection timeout or failed. Report error.
          gMmsConnection.release();
          if (callback) {
            callback(0, null);
          }
          return;
        }

        debug("sendRequest: register proxy filter to " + url);
        let proxyFilter = new MmsProxyFilter(url);
        gpps.registerFilter(proxyFilter, 0);

        let releaseMmsConnectionAndCallback = (function (httpStatus, data) {
          gpps.unregisterFilter(proxyFilter);
          // Always release the MMS network connection before callback.
          gMmsConnection.release();
          if (callback) {
            callback(httpStatus, data);
          }
        }).bind(this);

        try {
          let xhr = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                    .createInstance(Ci.nsIXMLHttpRequest);

          // Basic setups
          xhr.open(method, url, true);
          xhr.responseType = "arraybuffer";
          if (istream) {
            xhr.setRequestHeader("Content-Type",
                                 "application/vnd.wap.mms-message");
            xhr.setRequestHeader("Content-Length", istream.available());
          } else {
            xhr.setRequestHeader("Content-Length", 0);
          }

          // UAProf headers.
          let uaProfUrl, uaProfTagname = "x-wap-profile";
          try {
            uaProfUrl = Services.prefs.getCharPref('wap.UAProf.url');
            uaProfTagname = Services.prefs.getCharPref('wap.UAProf.tagname');
          } catch (e) {}

          if (uaProfUrl) {
            xhr.setRequestHeader(uaProfTagname, uaProfUrl);
          }

          // Setup event listeners
          xhr.onerror = function () {
            debug("xhr error, response headers: " +
                  xhr.getAllResponseHeaders());
            releaseMmsConnectionAndCallback(xhr.status, null);
          };
          xhr.onreadystatechange = function () {
            if (xhr.readyState != Ci.nsIXMLHttpRequest.DONE) {
              return;
            }

            let data = null;
            switch (xhr.status) {
              case HTTP_STATUS_OK: {
                debug("xhr success, response headers: "
                      + xhr.getAllResponseHeaders());

                let array = new Uint8Array(xhr.response);
                if (false) {
                  for (let begin = 0; begin < array.length; begin += 20) {
                    let partial = array.subarray(begin, begin + 20);
                    debug("res: " + JSON.stringify(partial));
                  }
                }

                data = {array: array, offset: 0};
                break;
              }
              default: {
                debug("xhr done, but status = " + xhr.status);
                break;
              }
            }

            releaseMmsConnectionAndCallback(xhr.status, data);
          }

          // Send request
          xhr.send(istream);
        } catch (e) {
          debug("xhr error, can't send: " + e.message);
          releaseMmsConnectionAndCallback(0, null);
        }
      }).bind(this, method, url, istream, callback));
    }
  };
});

/**
 * Send M-NotifyResp.ind back to MMSC.
 *
 * @param transactionId
 *        X-Mms-Transaction-ID of the message.
 * @param status
 *        X-Mms-Status of the response.
 * @param reportAllowed
 *        X-Mms-Report-Allowed of the response.
 *
 * @see OMA-TS-MMS_ENC-V1_3-20110913-A section 6.2
 */
function NotifyResponseTransaction(transactionId, status, reportAllowed) {
  let headers = {};

  // Mandatory fields
  headers["x-mms-message-type"] = MMS.MMS_PDU_TYPE_NOTIFYRESP_IND;
  headers["x-mms-transaction-id"] = transactionId;
  headers["x-mms-mms-version"] = MMS.MMS_VERSION;
  headers["x-mms-status"] = status;
  // Optional fields
  headers["x-mms-report-allowed"] = reportAllowed;

  this.istream = MMS.PduHelper.compose(null, {headers: headers});
}
NotifyResponseTransaction.prototype = {
  /**
   * @param callback [optional]
   *        A callback function that takes one argument -- the http status.
   */
  run: function run(callback) {
    let requestCallback;
    if (callback) {
      requestCallback = function (httpStatus, data) {
        // `The MMS Client SHOULD ignore the associated HTTP POST response
        // from the MMS Proxy-Relay.` ~ OMA-TS-MMS_CTR-V1_3-20110913-A
        // section 8.2.2 "Notification".
        callback(httpStatus);
      };
    }
    gMmsTransactionHelper.sendRequest("POST", gMmsConnection.mmsc,
                                      this.istream, requestCallback);
  }
};

/**
 * Retrieve message back from MMSC.
 *
 * @param contentLocation
 *        X-Mms-Content-Location of the message.
 */
function RetrieveTransaction(contentLocation) {
  this.contentLocation = contentLocation;
}
RetrieveTransaction.prototype = {
  /**
   * @param callback [optional]
   *        A callback function that takes two arguments: one for X-Mms-Status,
   *        the other for the parsed M-Retrieve.conf message.
   */
  run: function run(callback) {
    let callbackIfValid = function callbackIfValid(status, msg) {
      if (callback) {
        callback(status, msg);
      }
    }

    gMmsTransactionHelper.sendRequest("GET", this.contentLocation, null,
                                      (function (httpStatus, data) {
      if ((httpStatus != HTTP_STATUS_OK) || !data) {
        callbackIfValid(MMS.MMS_PDU_STATUS_DEFERRED, null);
        return;
      }

      let retrieved = MMS.PduHelper.parse(data, null);
      if (!retrieved || (retrieved.type != MMS.MMS_PDU_TYPE_RETRIEVE_CONF)) {
        callbackIfValid(MMS.MMS_PDU_STATUS_UNRECOGNISED, null);
        return;
      }

      // Fix default header field values.
      if (retrieved.headers["x-mms-delivery-report"] == null) {
        retrieved.headers["x-mms-delivery-report"] = false;
      }

      let retrieveStatus = retrieved.headers["x-mms-retrieve-status"];
      if ((retrieveStatus != null) &&
          (retrieveStatus != MMS.MMS_PDU_ERROR_OK)) {
        callbackIfValid(MMS.translatePduErrorToStatus(retrieveStatus),
                        retrieved);
        return;
      }

      callbackIfValid(MMS.MMS_PDU_STATUS_RETRIEVED, retrieved);
    }).bind(this));
  }
};

/**
 * SendTransaction.
 *   Class for sending M-Send.req to MMSC
 */
function SendTransaction(msg) {
  msg.headers["x-mms-message-type"] = MMS.MMS_PDU_TYPE_SEND_REQ;
  if (!msg.headers["x-mms-transaction-id"]) {
    // Create an unique transaction id
    let tid = gUUIDGenerator.generateUUID().toString();
    msg.headers["x-mms-transaction-id"] = tid;
  }
  msg.headers["x-mms-mms-version"] = MMS.MMS_VERSION;

  // Let MMS Proxy Relay insert from address automatically for us
  msg.headers["from"] = null;

  msg.headers["date"] = new Date();
  msg.headers["x-mms-message-class"] = "personal";
  msg.headers["x-mms-expiry"] = 7 * 24 * 60 * 60;
  msg.headers["x-mms-priority"] = 129;
  msg.headers["x-mms-read-report"] = true;
  msg.headers["x-mms-delivery-report"] = true;

  // TODO: bug 792321 - MMSCONF-GEN-C-003: Support for maximum values for MMS
  //                                        parameters

  let messageSize = 0;

  if (msg.content) {
    messageSize = msg.content.length;
  } else if (msg.parts) {
    for (let i = 0; i < msg.parts.length; i++) {
      if (msg.parts[i].content.size) {
        messageSize += msg.parts[i].content.size;
      } else {
        messageSize += msg.parts[i].content.length;
      }
    }

    let contentType = {
      params: {
        // `The type parameter must be specified and its value is the MIME
        // media type of the "root" body part.` ~ RFC 2387 clause 3.1
        type: msg.parts[0].headers["content-type"].media,
      },
    };

    // `The Content-Type in M-Send.req and M-Retrieve.conf SHALL be
    // application/vnd.wap.multipart.mixed when there is no presentation, and
    // application/vnd.wap.multipart.related SHALL be used when there is SMIL
    // presentation available.` ~ OMA-TS-MMS_CONF-V1_3-20110913-A clause 10.2.1
    if (contentType.params.type === "application/smil") {
      contentType.media = "application/vnd.wap.multipart.related";

      // `The start parameter, if given, is the content-ID of the compound
      // object's "root".` ~ RFC 2387 clause 3.2
      contentType.params.start = msg.parts[0].headers["content-id"];
    } else {
      contentType.media = "application/vnd.wap.multipart.mixed";
    }

    // Assign to Content-Type
    msg.headers["content-type"] = contentType;
  }

  // Assign to X-Mms-Message-Size
  msg.headers["x-mms-message-size"] = messageSize;
  // TODO: bug 809832 - support customizable max incoming/outgoing message size

  debug("msg: " + JSON.stringify(msg));

  this.msg = msg;
}
SendTransaction.prototype = {
  istreamComposed: false,

  /**
   * @param parts
   *        'parts' property of a parsed MMS message.
   * @param callback [optional]
   *        A callback function that takes zero argument.
   */
  loadBlobs: function loadBlobs(parts, callback) {
    let callbackIfValid = function callbackIfValid() {
      debug("All parts loaded: " + JSON.stringify(parts));
      if (callback) {
        callback();
      }
    }

    if (!parts || !parts.length) {
      callbackIfValid();
      return;
    }

    let numPartsToLoad = parts.length;
    for each (let part in parts) {
      if (!(part.content instanceof Ci.nsIDOMBlob)) {
        numPartsToLoad--;
        if (!numPartsToLoad) {
          callbackIfValid();
          return;
        }
        continue;
      }
      let fileReader = Cc["@mozilla.org/files/filereader;1"]
                       .createInstance(Ci.nsIDOMFileReader);
      fileReader.addEventListener("loadend",
        (function onloadend(part, event) {
        let arrayBuffer = event.target.result;
        part.content = new Uint8Array(arrayBuffer);
        numPartsToLoad--;
        if (!numPartsToLoad) {
          callbackIfValid();
        }
      }).bind(null, part));
      fileReader.readAsArrayBuffer(part.content);
    };
  },

  /**
   * @param callback [optional]
   *        A callback function that takes two arguments: one for
   *        X-Mms-Response-Status, the other for the parsed M-Send.conf message.
   */
  run: function run(callback) {
    if (!this.istreamComposed) {
      this.loadBlobs(this.msg.parts, (function () {
        this.istream = MMS.PduHelper.compose(null, this.msg);
        this.istreamComposed = true;
        this.run(callback);
      }).bind(this));
      return;
    }

    let callbackIfValid = function callbackIfValid(mmsStatus, msg) {
      if (callback) {
        callback(mmsStatus, msg);
      }
    }

    if (!this.istream) {
      callbackIfValid(MMS.MMS_PDU_ERROR_PERMANENT_FAILURE, null);
      return;
    }

    gMmsTransactionHelper.sendRequest("POST", gMmsConnection.mmsc, this.istream,
                                      function (httpStatus, data) {
      if (httpStatus != HTTP_STATUS_OK) {
        callbackIfValid(MMS.MMS_PDU_ERROR_TRANSIENT_FAILURE, null);
        return;
      }

      if (!data) {
        callbackIfValid(MMS.MMS_PDU_ERROR_PERMANENT_FAILURE, null);
        return;
      }

      let response = MMS.PduHelper.parse(data, null);
      if (!response || (response.type != MMS.MMS_PDU_TYPE_SEND_CONF)) {
        callbackIfValid(MMS.MMS_PDU_RESPONSE_ERROR_UNSUPPORTED_MESSAGE, null);
        return;
      }

      let responseStatus = response.headers["x-mms-response-status"];
      callbackIfValid(responseStatus, response);
    });
  }
};

/**
 * MmsService
 */
function MmsService() {
  // TODO: bug 810084 - support application identifier
}
MmsService.prototype = {

  classID:   RIL_MMSSERVICE_CID,
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIMmsService,
                                         Ci.nsIWapPushApplication]),
  /*
   * Whether or not should we enable X-Mms-Report-Allowed in M-NotifyResp.ind
   * and M-Acknowledge.ind PDU.
   */
  confSendDeliveryReport: CONFIG_SEND_REPORT_DEFAULT_YES,

  /**
   * @param status
   *        The MMS error type.
   *
   * @return true if it's a type of transient error; false otherwise.
   */
  isTransientError: function isTransientError(status) {
    return (status >= MMS.MMS_PDU_ERROR_TRANSIENT_FAILURE &&
            status < MMS.MMS_PDU_ERROR_PERMANENT_FAILURE);
  },

  /**
   * Calculate Whether or not should we enable X-Mms-Report-Allowed.
   *
   * @param config
   *        Current configure value.
   * @param wish
   *        Sender wish. Could be undefined, false, or true.
   */
  getReportAllowed: function getReportAllowed(config, wish) {
    if ((config == CONFIG_SEND_REPORT_DEFAULT_NO)
        || (config == CONFIG_SEND_REPORT_DEFAULT_YES)) {
      if (wish != null) {
        config += (wish ? 1 : -1);
      }
    }
    return config >= CONFIG_SEND_REPORT_DEFAULT_YES;
  },

  /**
   * @param contentLocation
   *        X-Mms-Content-Location of the message.
   * @param callback [optional]
   *        A callback function that takes two arguments: one for X-Mms-Status,
   *        the other parsed MMS message.
   */
  retrieveMessage: function retrieveMessage(contentLocation, callback) {
    // TODO: bug 839436 - make DB be able to save MMS messages
    // TODO: bug 810099 - support onretrieving event
    // TODO: bug 810097 - Retry retrieval on error
    // TODO: bug 809832 - support customizable max incoming/outgoing message
    //                     size.

    let transaction = new RetrieveTransaction(contentLocation);
    transaction.run(callback);
  },

  /**
   * Handle incoming M-Notification.ind PDU.
   *
   * @param notification
   *        The parsed MMS message object.
   */
  handleNotificationIndication: function handleNotificationIndication(notification) {
    // TODO: bug 839436 - make DB be able to save MMS messages
    // TODO: bug 810067 - support automatic/manual/never retrieval modes

    let url = notification.headers["x-mms-content-location"].uri;
    // TODO: bug 810091 - don't download message twice on receiving duplicated
    //                     notification
    this.retrieveMessage(url, (function (mmsStatus, retrievedMsg) {
      debug("retrievedMsg = " + JSON.stringify(retrievedMsg));
      if (this.isTransientError(mmsStatus)) {
        // TODO: remove this check after bug 810097 is landed.
        return;
      }

      let transactionId = notification.headers["x-mms-transaction-id"];

      // For X-Mms-Report-Allowed
      let wish = notification.headers["x-mms-delivery-report"];
      // `The absence of the field does not indicate any default value.`
      // So we go checking the same field in retrieved message instead.
      if ((wish == null) && retrievedMsg) {
        wish = retrievedMsg.headers["x-mms-delivery-report"];
      }
      let reportAllowed =
        this.getReportAllowed(this.confSendDeliveryReport, wish);

      let transaction =
        new NotifyResponseTransaction(transactionId, mmsStatus, reportAllowed);
      transaction.run();
    }).bind(this));
  },

  /**
   * Handle incoming M-Delivery.ind PDU.
   *
   * @param msg
   *        The MMS message object.
   */
  handleDeliveryIndication: function handleDeliveryIndication(msg) {
    // TODO: bug 811252 - implement MMS database
    let messageId = msg.headers["message-id"];
    debug("handleDeliveryIndication: got delivery report for " + messageId);
  },

  // nsIMmsService

  hasSupport: function hasSupport() {
    return true;
  },

  // nsIWapPushApplication

  receiveWapPush: function receiveWapPush(array, length, offset, options) {
    let data = {array: array, offset: offset};
    let msg = MMS.PduHelper.parse(data, null);
    if (!msg) {
      return false;
    }
    debug("receiveWapPush: msg = " + JSON.stringify(msg));

    switch (msg.type) {
      case MMS.MMS_PDU_TYPE_NOTIFICATION_IND:
        this.handleNotificationIndication(msg);
        break;
      case MMS.MMS_PDU_TYPE_DELIVERY_IND:
        this.handleDeliveryIndication(msg);
        break;
      default:
        debug("Unsupported X-MMS-Message-Type: " + msg.type);
        break;
    }
  },
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([MmsService]);

let debug;
if (DEBUG) {
  debug = function (s) {
    dump("-@- MmsService: " + s + "\n");
  };
} else {
  debug = function (s) {};
}
