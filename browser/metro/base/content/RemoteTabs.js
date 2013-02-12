// -*- Mode: js2; tab-width: 2; indent-tabs-mode: nil; js2-basic-offset: 2; js2-skip-preprocessor-directives: t; -*-
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';
Components.utils.import("resource://services-sync/main.js");

/**
 * Wraps a list/grid control implementing nsIDOMXULSelectControlElement and
 * fills it with the user's synced tabs.
 *
 * @param    aSet         Control implementing nsIDOMXULSelectControlElement.
 * @param    aSetUIAccess The UI element that should be hidden when Sync is
 *                          disabled. Must sanely support 'hidden' attribute.
 *                          You may only have one UI access point at this time.
 */
function RemoteTabsView(aSet, aSetUIAccess) {
  this._set = aSet;
  this._set.controller = this;
  this._uiAccessElement = aSetUIAccess;

  // Sync uses special voodoo observers.
  // If you want to change this code, talk to the fx-si team
  Weave.Svc.Obs.add("weave:service:setup-complete", this);
  Weave.Svc.Obs.add("weave:service:sync:finish", this);
  Weave.Svc.Obs.add("weave:service:start-over", this);
  if (this.isSyncEnabled() ) {
    this.populateTabs();
    this.populateGrid();
    this.setUIAccessVisible(true);
  }
  else {
    this.setUIAccessVisible(false);
  }
}

RemoteTabsView.prototype = {
  _set: null,
  _uiAccessElement: null,

  handleItemClick: function tabview_handleItemClick(aItem) {
    let url = aItem.getAttribute("value");
    BrowserUI.goToURI(url);
  },

  observe: function(subject, topic, data) {
    switch (topic) {
      case "weave:service:setup-complete":
        this.populateTabs();
        this.setUIAccessVisible(true);
        break;
      case "weave:service:sync:finish":
        this.populateGrid();
        break;
      case "weave:service:start-over":
        this.setUIAccessVisible(false);
        break;
    }
  },

  setUIAccessVisible: function setUIAccessVisible(aVisible) {
    this._uiAccessElement.hidden = !aVisible;
  },

  populateGrid: function populateGrid() {

    let tabsEngine = Weave.Service.engineManager.get("tabs");
    let list = this._set;
    let seenURLs = new Set();

    for (let [guid, client] in Iterator(tabsEngine.getAllClients())) {
      client.tabs.forEach(function({title, urlHistory, icon}) {
        let url = urlHistory[0];
        if (tabsEngine.locallyOpenTabMatchesURL(url) || seenURLs.has(url)) {
          return;
        }
        seenURLs.add(url);

        // If we wish to group tabs by client, we should be looking for records
        //  of {type:client, clientName, class:{mobile, desktop}} and will
        //  need to readd logic to reset seenURLs for each client.

        let item = this._set.appendItem((title || url), url);
        item.setAttribute("iconURI", Weave.Utils.getIcon(icon));

      }, this);
    }
  },

  populateTabs: function populateTabs() {
    Weave.Service.scheduler.scheduleNextSync(0);
  },

  destruct: function destruct() {
    Weave.Svc.Obs.remove("weave:service:setup-complete", this);
    Weave.Svc.Obs.remove("weave:engine:sync:finish", this);
    Weave.Svc.Obs.remove("weave:service:logout:start-over", this);
  },

  isSyncEnabled: function isSyncEnabled() {
    return (Weave.Status.checkSetup() != Weave.CLIENT_NOT_CONFIGURED);
  }

};

let RemoteTabsStartView = {
  _view: null,
  get _grid() { return document.getElementById("start-remotetabs-grid"); },

  init: function init() {
    let vbox = document.getElementById("start-remotetabs");
    this._view = new RemoteTabsView(this._grid, vbox);
  },

  uninit: function uninit() {
    this._view.destruct();
  },

  show: function show() {
    this._grid.arrangeItems();
  }
};

let RemoteTabsPanelView = {
  _view: null,

  get _grid() { return document.getElementById("remotetabs-list"); },
  get visible() { return PanelUI.isPaneVisible("remotetabs-container"); },

  init: function init() {
    //decks are fragile, don't hide the tab panel(bad things happen), hide link.
    let menuEntry = document.getElementById("menuitem-remotetabs");
    this._view = new RemoteTabsView(this._grid, menuEntry);
  },

  show: function show() {
    this._grid.arrangeItems();
  },

  uninit: function uninit() {
    this._view.destruct();
  }
};
