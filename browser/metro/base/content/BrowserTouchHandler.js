/*
 * BrowserTouchHandler
 *
 * Receives touch events from our input event capturing in input.js
 * and relays appropriate events to content. Also handles requests
 * from content for UI.
 */

const BrowserTouchHandler = {
  _debugEvents: false,

  init: function init() {
    // Misc. events we catch during the bubbling phase
    document.addEventListener("PopupChanged", this, false);
    document.addEventListener("CancelTouchSequence", this, false);

    // Messages sent from content.js
    messageManager.addMessageListener("Content:ContextMenu", this);
  },

  // Content forwarding the contextmenu command
  onContentContextMenu: function onContentContextMenu(aMessage) {
    let contextInfo = { name: aMessage.name,
                        json: aMessage.json,
                        target: aMessage.target };
    // Touch input selection handling
    if (!InputSourceHelper.isPrecise) {
      if (SelectionHelperUI.isActive()) {
        // Selection handler is active.
        if (aMessage.json.types.indexOf("selected-text") != -1) {
          // long tap on existing selection. The incoming message has the
          // string data, so reset the selection handler and invoke the
          // context menu.
          SelectionHelperUI.closeEditSession();
        } else {
          // Weird, context menu request with no selected text and
          // SelectionHelperUI is active? Might be a bug, warn. Fall
          // through anyway, the context menu handler will look in the
          // incoming message for content types it knows how to handle.
          Util.dumpLn("long tap on empty selection with SelectionHelperUI active?"); 
          SelectionHelperUI.closeEditSession();
        }
      } else if (SelectionHelperUI.canHandle(aMessage)) {
        SelectionHelperUI.openEditSession(aMessage);
        return;
      }
    }

    // Check to see if we have context menu item(s) that apply to what
    // was clicked on.
    if (ContextMenuUI.showContextMenu(contextInfo)) {
      let event = document.createEvent("Events");
      event.initEvent("CancelTouchSequence", true, false);
      document.dispatchEvent(event);
    } else {
      // Send the MozEdgeUIGesture to input.js to
      // toggle the context ui.
      let event = document.createEvent("Events");
      event.initEvent("MozEdgeUIGesture", true, false);
      window.dispatchEvent(event);
    }
  },

  /*
   * Events
   */

  handleEvent: function handleEvent(aEvent) {
    // ignore content events we generate
    if (this._debugEvents)
      Util.dumpLn("BrowserTouchHandler:", aEvent.type);

    switch (aEvent.type) {
      case "PopupChanged":
      case "CancelTouchSequence":
        if (!aEvent.detail)
          ContextMenuUI.reset();
        break;
    }
  },

  receiveMessage: function receiveMessage(aMessage) {
    if (this._debugEvents) Util.dumpLn("BrowserTouchHandler:", aMessage.name);
    switch (aMessage.name) {
      // Content forwarding the contextmenu command
      case "Content:ContextMenu":
        this.onContentContextMenu(aMessage);
        break;
    }
  },
};
