// -*- Mode: Java; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*-
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

let Cc = Components.classes;
let Ci = Components.interfaces;

Components.utils.import("resource://gre/modules/Services.jsm");

function dump(a) {
  Cc["@mozilla.org/consoleservice;1"].getService(Ci.nsIConsoleService).logStringMessage(a);
}

function sendMessageToJava(aMessage) {
  return Cc["@mozilla.org/android/bridge;1"]
           .getService(Ci.nsIAndroidBridge)
           .handleGeckoMessage(JSON.stringify(aMessage));
}

this.EXPORTED_SYMBOLS = ["Sanitizer"];

let downloads = {
  dlmgr: Cc["@mozilla.org/download-manager;1"].getService(Ci.nsIDownloadManager),

  iterate: function (aCallback) {
    let dlmgr = downloads.dlmgr;
    let dbConn = dlmgr.DBConnection;
    let stmt = dbConn.createStatement("SELECT id FROM moz_downloads WHERE " +
        "state = ? OR state = ? OR state = ? OR state = ? OR state = ? OR state = ?");
    stmt.bindInt32Parameter(0, Ci.nsIDownloadManager.DOWNLOAD_FINISHED);
    stmt.bindInt32Parameter(1, Ci.nsIDownloadManager.DOWNLOAD_FAILED);
    stmt.bindInt32Parameter(2, Ci.nsIDownloadManager.DOWNLOAD_CANCELED);
    stmt.bindInt32Parameter(3, Ci.nsIDownloadManager.DOWNLOAD_BLOCKED_PARENTAL);
    stmt.bindInt32Parameter(4, Ci.nsIDownloadManager.DOWNLOAD_BLOCKED_POLICY);
    stmt.bindInt32Parameter(5, Ci.nsIDownloadManager.DOWNLOAD_DIRTY);
    while (stmt.executeStep()) {
      aCallback(dlmgr.getDownload(stmt.row.id));
    }
    stmt.finalize();
  },

  get canClear() {
    return this.dlmgr.canCleanUp;
  }
};

function Sanitizer() {}
Sanitizer.prototype = {
  clearItem: function (aItemName)
  {
    if (this.items[aItemName].canClear)
      this.items[aItemName].clear();
  },

  items: {
    cache: {
      clear: function ()
      {
        var cacheService = Cc["@mozilla.org/network/cache-service;1"].getService(Ci.nsICacheService);
        try {
          cacheService.evictEntries(Ci.nsICache.STORE_ANYWHERE);
        } catch(er) {}

        let imageCache = Cc["@mozilla.org/image/tools;1"].getService(Ci.imgITools)
                                                         .getImgCacheForDocument(null);
        try {
          imageCache.clearCache(false); // true=chrome, false=content
        } catch(er) {}
      },

      get canClear()
      {
        return true;
      }
    },

    cookies: {
      clear: function ()
      {
        Services.cookies.removeAll();

        // clear any network geolocation provider sessions
        try {
          var branch = Services.prefs.getBranch("geo.wifi.access_token.");
          branch.deleteBranch("");
        } catch (e) {dump(e);}
      },

      get canClear()
      {
        return true;
      }
    },

    siteSettings: {
      clear: function ()
      {
        // Clear site-specific permissions like "Allow this site to open popups"
        Services.perms.removeAll();

        // Clear site-specific settings like page-zoom level
        Cc["@mozilla.org/content-pref/service;1"]
          .getService(Ci.nsIContentPrefService2)
          .removeAllDomains(null);

        // Clear "Never remember passwords for this site", which is not handled by
        // the permission manager
        var hosts = Services.logins.getAllDisabledHosts({})
        for each (var host in hosts) {
          Services.logins.setLoginSavingEnabled(host, true);
        }
      },

      get canClear()
      {
        return true;
      }
    },

    offlineApps: {
      clear: function ()
      {
        var cacheService = Cc["@mozilla.org/network/cache-service;1"].getService(Ci.nsICacheService);
        try {
          cacheService.evictEntries(Ci.nsICache.STORE_OFFLINE);
        } catch(er) {}
      },

      get canClear()
      {
          return true;
      }
    },

    history: {
      clear: function ()
      {
        sendMessageToJava({ type: "Sanitize:ClearHistory" });

        try {
          Services.obs.notifyObservers(null, "browser:purge-session-history", "");
        }
        catch (e) { }

        // Clear last URL of the Open Web Location dialog
        try {
          Services.prefs.clearUserPref("general.open_location.last_url");
        }
        catch (e) { }
      },

      get canClear()
      {
        // bug 347231: Always allow clearing history due to dependencies on
        // the browser:purge-session-history notification. (like error console)
        return true;
      }
    },

    formdata: {
      clear: function ()
      {
        //Clear undo history of all searchBars
        var windows = Services.wm.getEnumerator("navigator:browser");
        while (windows.hasMoreElements()) {
          var searchBar = windows.getNext().document.getElementById("searchbar");
          if (searchBar) {
            searchBar.value = "";
            searchBar.textbox.editor.transactionManager.clear();
          }
        }

        var formHistory = Cc["@mozilla.org/satchel/form-history;1"].getService(Ci.nsIFormHistory2);
        formHistory.removeAllEntries();
      },

      get canClear()
      {
        var formHistory = Cc["@mozilla.org/satchel/form-history;1"].getService(Ci.nsIFormHistory2);
        return formHistory.hasEntries;
      }
    },

    downloads: {
      clear: function ()
      {
        downloads.iterate(function (dl) {
          dl.remove();
        });
      },

      get canClear()
      {
        return downloads.canClear;
      }
    },

    downloadFiles: {
      clear: function ()
      {
        downloads.iterate(function (dl) {
          // Delete the downloaded files themselves
          let f = dl.targetFile;
          if (f.exists()) {
            f.remove(false);
          }

          // Also delete downloads from history
          dl.remove();
        });
      },

      get canClear()
      {
        return downloads.canClear;
      }
    },

    passwords: {
      clear: function ()
      {
        Services.logins.removeAllLogins();
      },

      get canClear()
      {
        let count = Services.logins.countLogins("", "", ""); // count all logins
        return (count > 0);
      }
    },

    sessions: {
      clear: function ()
      {
        // clear all auth tokens
        var sdr = Cc["@mozilla.org/security/sdr;1"].getService(Ci.nsISecretDecoderRing);
        sdr.logoutAndTeardown();

        // clear FTP and plain HTTP auth sessions
        Services.obs.notifyObservers(null, "net:clear-active-logins", null);
      },

      get canClear()
      {
        return true;
      }
    }
  }
};

this.Sanitizer = new Sanitizer();
