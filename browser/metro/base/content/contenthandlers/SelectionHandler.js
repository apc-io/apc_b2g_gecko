/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

dump("### SelectionHandler.js loaded\n");

/*
  http://mxr.mozilla.org/mozilla-central/source/docshell/base/nsIDocShell.idl
  http://mxr.mozilla.org/mozilla-central/source/content/base/public/nsISelectionDisplay.idl
  http://mxr.mozilla.org/mozilla-central/source/content/base/public/nsISelectionListener.idl
  http://mxr.mozilla.org/mozilla-central/source/content/base/public/nsISelectionPrivate.idl
  http://mxr.mozilla.org/mozilla-central/source/content/base/public/nsISelectionController.idl
  http://mxr.mozilla.org/mozilla-central/source/content/base/public/nsISelection.idl
    rangeCount
    getRangeAt
    containsNode
  http://www.w3.org/TR/DOM-Level-2-Traversal-Range/ranges.html
  http://mxr.mozilla.org/mozilla-central/source/dom/interfaces/range/nsIDOMRange.idl
  http://mxr.mozilla.org/mozilla-central/source/dom/interfaces/core/nsIDOMDocument.idl#80
    content.document.createRange()
    getBoundingClientRect
    isPointInRange
  http://mxr.mozilla.org/mozilla-central/source/dom/interfaces/core/nsIDOMNode.idl
  http://mxr.mozilla.org/mozilla-central/source/dom/interfaces/base/nsIDOMWindowUtils.idl
    setSelectionAtPoint
  http://mxr.mozilla.org/mozilla-central/source/dom/interfaces/core/nsIDOMElement.idl
    getClientRect
  http://mxr.mozilla.org/mozilla-central/source/layout/generic/nsFrameSelection.h
  http://mxr.mozilla.org/mozilla-central/source/editor/idl/nsIEditor.idl

  nsIDOMCaretPosition - not implemented

  TODO:
  - window resize
  - typing with selection in text input
  - magnetic monocles should snap to sentence start/end
  - sub frames:
    1) general testing
    2) sub frames scroll

*/

var SelectionHandler = {
  _debugEvents: false,
  _cache: {},
  _targetElement: null,
  _targetIsEditable: false,
  _contentWindow: null,
  _contentOffset: { x:0, y:0 },
  _frameOffset: { x:0, y:0 },
  _domWinUtils: null,
  _selectionMoveActive: false,
  _lastMarker: "",
  _debugOptions: { dumpRanges: false, displayRanges: false },

  init: function init() {
    addMessageListener("Browser:SelectionStart", this);
    addMessageListener("Browser:SelectionEnd", this);
    addMessageListener("Browser:SelectionMoveStart", this);
    addMessageListener("Browser:SelectionMove", this);
    addMessageListener("Browser:SelectionMoveEnd", this);
    addMessageListener("Browser:SelectionUpdate", this);
    addMessageListener("Browser:SelectionClose", this);
    addMessageListener("Browser:SelectionClear", this);
    addMessageListener("Browser:SelectionCopy", this);
    addMessageListener("Browser:SelectionDebug", this);
  },

  shutdown: function shutdown() {
    removeMessageListener("Browser:SelectionStart", this);
    removeMessageListener("Browser:SelectionEnd", this);
    removeMessageListener("Browser:SelectionMoveStart", this);
    removeMessageListener("Browser:SelectionMove", this);
    removeMessageListener("Browser:SelectionMoveEnd", this);
    removeMessageListener("Browser:SelectionUpdate", this);
    removeMessageListener("Browser:SelectionClose", this);
    removeMessageListener("Browser:SelectionClear", this);
    removeMessageListener("Browser:SelectionCopy", this);
    removeMessageListener("Browser:SelectionDebug", this);
  },

  isActive: function isActive() {
    return (this._contentWindow != null);
  },

  /*************************************************
   * Browser event handlers
   */

  /*
   * Selection start event handler
   */
  _onSelectionStart: function _onSelectionStart(aX, aY) {
    // Init content window information
    if (!this._initTargetInfo(aX, aY)) {
      this._onFail("failed to get frame offset");
      return;
    }

    // Clear any existing selection from the document
    let selection = this._contentWindow.getSelection();
    selection.removeAllRanges();

    Util.dumpLn(this._targetElement);

    // Set our initial selection, aX and aY should be in client coordinates.
    if (!this._domWinUtils.selectAtPoint(aX, aY, Ci.nsIDOMWindowUtils
                                                   .SELECT_WORDNOSPACE)) {
      this._onFail("failed to set selection at point");
      return;
    }

    // Update the position of our selection monocles
    this._updateSelectionUI(true, true);
  },

  /*
   * Selection monocle start move event handler
   */
  _onSelectionMoveStart: function _onSelectionMoveStart(aMsg) {
    if (!this._contentWindow) {
      this._onFail("_onSelectionMoveStart was called without proper view set up");
      return;
    }

    if (this._selectionMoveActive) {
      this._onFail("mouse is already down on drag start?");
      return;
    }

    // We bail if things get out of sync here implying we missed a message.
    this._selectionMoveActive = true;

    // Update the position of our selection monocles
    this._updateSelectionUI(true, true);
  },
  
  /*
   * Selection monocle move event handler
   */
  _onSelectionMove: function _onSelectionMove(aMsg) {
    if (!this._contentWindow) {
      this._onFail("_onSelectionMove was called without proper view set up");
      return;
    }

    if (!this._selectionMoveActive) {
      this._onFail("mouse isn't down for drag move?");
      return;
    }

    // Update selection in the doc
    let pos = null;
    if (aMsg.change == "start") {
      pos = aMsg.start;
    } else {
      pos = aMsg.end;
    }

    this._handleSelectionPoint(aMsg.change, pos);
  },

  /*
   * Selection monocle move finished event handler
   */
  _onSelectionMoveEnd: function _onSelectionMoveComplete(aMsg) {
    if (!this._contentWindow) {
      this._onFail("_onSelectionMove was called without proper view set up");
      return;
    }

    if (!this._selectionMoveActive) {
      this._onFail("mouse isn't down for drag move?");
      return;
    }

    // Update selection in the doc
    let pos = null;
    if (aMsg.change == "start") {
      pos = aMsg.start;
    } else {
      pos = aMsg.end;
    }

    this._handleSelectionPoint(aMsg.change, pos);
    this._selectionMoveActive = false;
    
    // _handleSelectionPoint may set a scroll timer, so this must
    // be reset after the last call.
    this.clearTimers();

    // Update the position of our selection monocles
    this._updateSelectionUI(true, true);
  },

  /*
   * Selection copy event handler
   *
   * Check to see if the incoming click was on our selection rect.
   * if it was, copy to the clipboard. Incoming coordinates are
   * content values.
   */
  _onSelectionCopy: function _onSelectionCopy(aMsg) {
    let tap = {
      xPos: aMsg.xPos, // + this._contentOffset.x,
      yPos: aMsg.yPos, // + this._contentOffset.y,
    };

    let tapInSelection = (tap.xPos > this._cache.rect.left &&
                          tap.xPos < this._cache.rect.right) &&
                         (tap.yPos > this._cache.rect.top &&
                          tap.yPos < this._cache.rect.bottom);
    // Util.dumpLn(tap.xPos, tap.yPos, "|", this._cache.rect.left,
    //             this._cache.rect.right, this._cache.rect.top,
    //             this._cache.rect.bottom);
    let success = false;
    let selectedText = this._getSelectedText();
    if (tapInSelection && selectedText.length) {
      let clipboard = Cc["@mozilla.org/widget/clipboardhelper;1"]
                        .getService(Ci.nsIClipboardHelper);
      clipboard.copyString(selectedText, this._contentWindow.document);
      success = true;
    }
    sendSyncMessage("Content:SelectionCopied", { succeeded: success });
  },

  /*
   * Selection close event handler
   */
  _onSelectionClose: function _onSelectionClose() {
    this._closeSelection();
  },

  /*
   * Selection clear event handler
   */
  _onSelectionClear: function _onSelectionClear() {
    this._clearSelection();
  },

  /*
   * Called any time SelectionHelperUI would like us to
   * recalculate the selection bounds.
   */
  _onSelectionUpdate: function _onSelectionUpdate() {
    if (!this._contentWindow) {
      this._onFail("_onSelectionUpdate was called without proper view set up");
      return;
    }

    // Update the position of our selection monocles
    this._updateSelectionUI(true, true);
  },

  /*
   * Called if for any reason we fail during the selection
   * process. Cancels the selection.
   */
  _onFail: function _onFail(aDbgMessage) {
    if (aDbgMessage && aDbgMessage.length > 0)
      Util.dumpLn(aDbgMessage);
    sendAsyncMessage("Content:SelectionFail");
    this._clearSelection();
    this._closeSelection();
  },

  /*
   * Turning on or off various debug featues.
   */
  _onSelectionDebug: function _onSelectionDebug(aMsg) {
    this._debugOptions = aMsg;
    this._debugEvents = aMsg.dumpEvents;
  },

  /*************************************************
   * Selection helpers
   */

  /*
   * _clearSelection
   *
   * Clear existing selection if it exists and reset our internla state.
   */
  _clearSelection: function _clearSelection() {
    this.clearTimers();
    if (this._contentWindow) {
      let selection = this._getSelection();
      if (selection)
        selection.removeAllRanges();
    } else {
      let selection = content.getSelection();
      if (selection)
        selection.removeAllRanges();
    }
    this.selectedText = "";
  },

  /*
   * _closeSelection
   *
   * Shuts SelectionHandler down.
   */
  _closeSelection: function _closeSelection() {
    this.clearTimers();
    this._cache = null;
    this._contentWindow = null;
    this.selectedText = "";
    this._selectionMoveActive = false;
  },

  /*
   * Informs SelectionHelperUI of the current selection start and end position
   * so that our selection monocles can be positioned properly.
   */
  _updateSelectionUI: function _updateSelectionUI(aUpdateStart, aUpdateEnd) {
    let selection = this._getSelection();

    // If the range didn't have any text, let's bail
    if (!selection.toString().trim().length) {
      this._onFail("no text was present in the current selection");
      return;
    }

    // Updates this._cache content selection position data which we send over
    // to SelectionHelperUI.
    this._updateUIMarkerRects(selection);

    this._cache.updateStart = aUpdateStart;
    this._cache.updateEnd = aUpdateEnd;

    // Get monocles positioned correctly
    sendAsyncMessage("Content:SelectionRange", this._cache);
  },

  /*
   * Find content within frames - cache the target nsIDOMWindow,
   * client coordinate offset, target element, and dom utils interface.
   */
  _initTargetInfo: function _initTargetInfo(aX, aY) {
    // getCurrentWindowAndOffset takes client coordinates
    let { element: element,
          contentWindow: contentWindow,
          offset: offset,
          frameOffset: frameOffset,
          utils: utils } =
      this.getCurrentWindowAndOffset(aX, aY);
    if (!contentWindow) {
      return false;
    }
    this._targetElement = element;
    this._contentWindow = contentWindow;
    this._contentOffset = offset;
    this._frameOffset = frameOffset;
    this._domWinUtils = utils;
    this._targetIsEditable = false;
    if (this._isTextInput(this._targetElement)) {
      this._targetIsEditable = true;
      // Since we have an overlay, focus will not get set, so set it. There
      // are ways around this if this causes trouble - we have the selection
      // controller, so we can turn selection display on manually. (Selection
      // display is setup on edits when focus changes.) I think web pages will
      // prefer that focus be set when we are interacting with selection in
      // the element.
      this._targetElement.focus();
    }
    return true;
  },

  /*
   * _updateUIMarkerRects(aSelection)
   *
   * Extracts the rects of the current selection, clips them to any text
   * input bounds, and stores them in the cache table we send over to
   * SelectionHelperUI.
   */
  _updateUIMarkerRects: function _updateUIMarkerRects(aSelection) {
    // Extract the information we'll send over to the ui - cache holds content
    // coordinate oriented start and end position data. Note the coordinates
    // of the range passed in are relative the sub frame the range sits in.
    // SelectionHelperUI calls transformBrowserToClient to get client coords.
    this._cache = this._extractContentRectFromRange(aSelection.getRangeAt(0),
                                                    this._contentOffset);
    if (this. _debugOptions.dumpRanges)  {
       Util.dumpLn("start:", "(" + this._cache.start.xPos + "," +
                   this._cache.start.yPos + ")");
       Util.dumpLn("end:", "(" + this._cache.end.xPos + "," +
                   this._cache.end.yPos + ")");
    }
    this._restrictSelectionRectToEditBounds();
  },

  /*
   * Selection bounds will fall outside the bound of a control if the control
   * can scroll. Clip UI cache data to the bounds of the target so monocles
   * don't draw outside the control.
   */
  _restrictSelectionRectToEditBounds: function _restrictSelectionRectToEditBounds() {
    if (!this._targetIsEditable)
      return;
    let bounds = this._getTargetContentRect();
    if (this._cache.start.xPos < bounds.left)
      this._cache.start.xPos = bounds.left;
    if (this._cache.end.xPos < bounds.left)
      this._cache.end.xPos = bounds.left;
    if (this._cache.start.xPos > bounds.right)
      this._cache.start.xPos = bounds.right;
    if (this._cache.end.xPos > bounds.right)
      this._cache.end.xPos = bounds.right;

    if (this._cache.start.yPos < bounds.top)
      this._cache.start.yPos = bounds.top;
    if (this._cache.end.yPos < bounds.top)
      this._cache.end.yPos = bounds.top;
    if (this._cache.start.yPos > bounds.bottom)
      this._cache.start.yPos = bounds.bottom;
    if (this._cache.end.yPos > bounds.bottom)
      this._cache.end.yPos = bounds.bottom;
  },

  /*
   * _handleSelectionPoint(aMarker, aPoint) 
   *
   * After a monocle moves to a new point in the document, determintes
   * what the target is and acts on its selection accordingly. If the
   * monocle is within the bounds of the target, adds or subtracts selection
   * at the monocle coordinates appropriately and then merges selection ranges
   * into a single continuous selection. If the monocle is outside the bounds
   * of the target and the underlying target is editable, uses the selection
   * controller to advance selection and visibility within the control.
   */
  _handleSelectionPoint: function _handleSelectionPoint(aMarker, aClientPoint) {
    let selection = this._getSelection();

    let clientPoint = { xPos: aClientPoint.xPos, yPos: aClientPoint.yPos };

    if (selection.rangeCount == 0 || selection.rangeCount > 1) {
      Util.dumpLn("warning, unexpected selection state.");
      this._setContinuousSelection();
      return;
    }

    // Adjust our y position up such that we are sending coordinates on
    // the text line vs. below it where the monocle is positioned. This
    // applies to free floating text areas. For text inputs we'll constrain
    // coordinates further below.
    let halfLineHeight = this._queryHalfLineHeight(aMarker, selection);
    clientPoint.yPos -= halfLineHeight;

    if (this._targetIsEditable) {
      // Check to see if we are beyond the bounds of selection in a input
      // control. If we are we want to add selection and scroll the added
      // selection into view.
      let result = this.updateTextEditSelection(clientPoint);

      // If we're targeting a text input of any kind, make sure clientPoint
      // is contained within the bounds of the text control. For example, if
      // a user drags up too close to an upper bounds, selectAtPoint might
      // select the content above the control. This looks crappy and breaks
      // our selection rect management.
      clientPoint =
       this._constrainPointWithinControl(clientPoint, halfLineHeight);

      // If result.trigger is true, the monocle is outside the bounds of the
      // control. If it's false, fall through to our additive text selection
      // below.
      if (result.trigger) {
        // _handleSelectionPoint is triggered by input movement, so if we've
        // tested positive for out-of-bounds scrolling here, we need to set a
        // recurring timer to keep the expected selection behavior going as
        // long as the user keeps the monocle out of bounds.
        if (!this._scrollTimer)
          this._scrollTimer = new Util.Timeout();
        this._setTextEditUpdateInterval(result.speed);

        // Smooth the selection
        this._setContinuousSelection();

        // Update the other monocle's position if we've dragged off to one side
        if (result.start)
          this._updateSelectionUI(true, false);
        if (result.end)
          this._updateSelectionUI(false, true);

        return;
      }
    }

    this._lastMarker = aMarker;

    // If we aren't out-of-bounds, clear the scroll timer if it exists.
    this.clearTimers();

    // Adjusts the selection based on monocle movement
    this._adjustSelection(aMarker, clientPoint);

    // Update the other monocle's position. We do this because the dragging
    // monocle may reset the static monocle to a new position if the dragging
    // monocle drags ahead or behind the other.
    if (aMarker == "start") {
      this._updateSelectionUI(false, true);
    } else {
      this._updateSelectionUI(true, false);
    }
  },

  /*
   * _handleSelectionPoint helper methods
   */

  /*
   * Based on a monocle marker and position, adds or subtracts from the
   * existing selection.
   *
   * @param the marker currently being manipulated
   * @param aClientPoint the point designating the new start or end
   * position for the selection.
   */
  _adjustSelection: function _adjustSelection(aMarker, aClientPoint) {
    // Make a copy of the existing range, we may need to reset it.
    this._backupRangeList();

    // shrinkSelectionFromPoint takes sub-frame relative coordinates.
    let framePoint = this._clientPointToFramePoint(aClientPoint);

    // Tests to see if the user is trying to shrink the selection, and if so
    // collapses it down to the appropriate side such that our calls below
    // will reset the selection to the proper range.
    this._shrinkSelectionFromPoint(aMarker, framePoint);

    let selectResult = false;
    try {
      // Select a character at the point.
      selectResult = 
        this._domWinUtils.selectAtPoint(aClientPoint.xPos,
                                        aClientPoint.yPos,
                                        Ci.nsIDOMWindowUtils.SELECT_CHARACTER);
    } catch (ex) {
    }

    // If selectAtPoint failed (which can happen if there's nothing to select)
    // reset our range back before we shrunk it.
    if (!selectResult) {
      this._restoreRangeList();
    }

    this._freeRangeList();

    // Smooth over the selection between all existing ranges.
    this._setContinuousSelection();
  },

  /*
   * _backupRangeList, _restoreRangeList, and _freeRangeList
   *
   * Utilities that manage a cloned copy of the existing selection.
   */

  _backupRangeList: function _backupRangeList() {
    this._rangeBackup = new Array();
    for (let idx = 0; idx < this._getSelection().rangeCount; idx++) {
      this._rangeBackup.push(this._getSelection().getRangeAt(idx).cloneRange());
    }
  },

  _restoreRangeList: function _restoreRangeList() {
    if (this._rangeBackup == null)
      return;
    for (let idx = 0; idx < this._rangeBackup.length; idx++) {
      this._getSelection().addRange(this._rangeBackup[idx]);
    }
    this._freeRangeList();
  },

  _freeRangeList: function _restoreRangeList() {
    this._rangeBackup = null;
  },

  /*
   * Constrains a selection point within a text input control bounds.
   *
   * @param aPoint - client coordinate point
   * @param aHalfLineHeight - half the line height at the point
   * @return new constrained point struct
   */
  _constrainPointWithinControl: function _cpwc(aPoint, aHalfLineHeight) {
    let bounds = this._getTargetClientRect();
    let point = { xPos: aPoint.xPos, yPos: aPoint.yPos };
    if (point.xPos <= bounds.left)
      point.xPos = bounds.left + 2;
    if (point.xPos >= bounds.right)
      point.xPos = bounds.right - 2;
    if (point.yPos <= (bounds.top + aHalfLineHeight))
      point.yPos = (bounds.top + aHalfLineHeight);
    if (point.yPos >= (bounds.bottom - aHalfLineHeight))
      point.yPos = (bounds.bottom - aHalfLineHeight);
    return point;
  },

  /*
   * _pointOrientationToRect(aPoint, aRect)
   *
   * Returns a table representing which sides of target aPoint is offset
   * from: { left: offset, top: offset, right: offset, bottom: offset }
   * Works on client coordinates.
   */
  _pointOrientationToRect: function _pointOrientationToRect(aPoint) {
    let bounds = this._targetElement.getBoundingClientRect();
    let result = { left: 0, right: 0, top: 0, bottom: 0 };
    if (aPoint.xPos <= bounds.left)
      result.left = bounds.left - aPoint.xPos;
    if (aPoint.xPos >= bounds.right)
      result.right = aPoint.xPos - bounds.right;
    if (aPoint.yPos <= bounds.top)
      result.top = bounds.top - aPoint.yPos;
    if (aPoint.yPos >= bounds.bottom)
      result.bottom = aPoint.yPos - bounds.bottom;
    return result;
  },

  /*
   * updateTextEditSelection(aPoint, aClientPoint)
   *
   * Checks to see if the monocle point is outside the bounds of the
   * target edit. If so, use the selection controller to select and
   * scroll the edit appropriately.
   *
   * @param aClientPoint raw pointer position
   * @return { speed: 0.0 -> 1.0,
   *           trigger: true/false if out of bounds,
   *           start: true/false if updated position,
   *           end: true/false if updated position }
   */
  updateTextEditSelection: function updateTextEditSelection(aClientPoint) {
    if (aClientPoint == undefined) {
      aClientPoint = this._rawSelectionPoint;
    }
    this._rawSelectionPoint = aClientPoint;

    let orientation = this._pointOrientationToRect(aClientPoint);
    let result = { speed: 1, trigger: false, start: false, end: false };

    if (orientation.left || orientation.top) {
      this._addEditStartSelection();
      result.speed = orientation.left + orientation.top;
      result.trigger = true;
      result.end = true;
    } else if (orientation.right || orientation.bottom) {
      this._addEditEndSelection();
      result.speed = orientation.right + orientation.bottom;
      result.trigger = true;
      result.start = true;
    }

    // 'speed' is just total pixels offset, so clamp it to something
    // reasonable callers can work with.
    if (result.speed > 100)
      result.speed = 100;
    if (result.speed < 1)
      result.speed = 1;
    result.speed /= 100;
    return result;
  },

  _setTextEditUpdateInterval: function _setTextEditUpdateInterval(aSpeedValue) {
    let timeout = (75 - (aSpeedValue * 75));
    this._scrollTimer.interval(timeout, this.scrollTimerCallback);
  },

  /*
   * Selection control call wrapper
   */
  _addEditStartSelection: function _addEditStartSelection() {
    let selCtrl = this._getSelectController();
    let selection = this._getSelection();
    try {
      this._backupRangeList();
      selection.collapseToStart();
      // State: focus = anchor
      // Only step back if we can, otherwise selCtrl will exception:
      if (selection.getRangeAt(0).startOffset > 0) {
        selCtrl.characterMove(false, true);
      }
      // State: focus = (anchor - 1)
      selection.collapseToStart();
      // State: focus = anchor and both are -1 from the original offset
      selCtrl.characterMove(true, true);
      // State: focus = anchor + 1, both have been moved back one char
      // Restore the rest of the selection:
      this._restoreRangeList();
      selCtrl.scrollSelectionIntoView(Ci.nsISelectionController.SELECTION_NORMAL,
                                      Ci.nsISelectionController.SELECTION_ANCHOR_REGION,
                                      Ci.nsISelectionController.SCROLL_SYNCHRONOUS);
    } catch (ex) { Util.dumpLn(ex.message);}
  },

  /*
   * Selection control call wrapper
   */
  _addEditEndSelection: function _addEditEndSelection() {
    try {
      let selCtrl = this._getSelectController();
      selCtrl.characterMove(true, true);
      selCtrl.scrollSelectionIntoView(Ci.nsISelectionController.SELECTION_NORMAL,
                                      Ci.nsISelectionController.SELECTION_FOCUS_REGION,
                                      Ci.nsISelectionController.SCROLL_SYNCHRONOUS);
    } catch (ex) {}
  },

  /*
   * _queryHalfLineHeight(aMarker, aSelection)
   *
   * Y offset applied to the coordinates of the selection position we send
   * to dom utils. The selection marker sits below text, but we want the
   * selection position to be on the text above the monocle. Since text
   * height can vary across the entire selection range, we need the correct
   * height based on the line the marker in question is moving on.
   */
  _queryHalfLineHeight: function _queryHalfLineHeight(aMarker, aSelection) {
    let rects = aSelection.getRangeAt(0).getClientRects();
    if (!rects.length) {
      return 0;
    }

    // We are assuming here that these rects are ordered correctly.
    // From looking at the range code it appears they will be.
    let height = 0;
    if (aMarker == "start") {
      // height of the first rect corresponding to the start marker:
      height = rects[0].bottom - rects[0].top;
    } else {
      // height of the last rect corresponding to the end marker:
      let len = rects.length - 1;
      height = rects[len].bottom - rects[len].top;
    }
    return height / 2;
  },

  _findBetterLowerTextRangePoint: function _findBetterLowerTextRangePoint(aClientPoint, aHalfLineHeight) {
    let range = this._getSelection().getRangeAt(0);
    let clientRect = range.getBoundingClientRect();
    if (aClientPoint.y > clientRect.bottom && clientRect.right < aClientPoint.x) {
      aClientPoint.y = (clientRect.bottom - aHalfLineHeight);
      this._setDebugPoint(aClientPoint, "red");
    }
  },

  /*
   * _setContinuousSelection()
   *
   * Smoothes a selection with multiple ranges into a single
   * continuous range.
   */
  _setContinuousSelection: function _setContinuousSelection() {
    let selection = this._getSelection();
    try {
      if (selection.rangeCount > 1) {
        let startRange = selection.getRangeAt(0);
        if (this. _debugOptions.displayRanges) {
          let clientRect = startRange.getBoundingClientRect();
          this._setDebugRect(clientRect, "red", false);
        }
        let newStartNode = null;
        let newStartOffset = 0;
        let newEndNode = null;
        let newEndOffset = 0;
        for (let idx = 1; idx < selection.rangeCount; idx++) {
          let range = selection.getRangeAt(idx);
          switch (startRange.compareBoundaryPoints(Ci.nsIDOMRange.START_TO_START, range)) {
            case -1: // startRange is before
              newStartNode = startRange.startContainer;
              newStartOffset = startRange.startOffset;
              break;
            case 0: // startRange is equal
              newStartNode = startRange.startContainer;
              newStartOffset = startRange.startOffset;
              break;
            case 1: // startRange is after
              newStartNode = range.startContainer;
              newStartOffset = range.startOffset;
              break;
          }
          switch (startRange.compareBoundaryPoints(Ci.nsIDOMRange.END_TO_END, range)) {
            case -1: // startRange is before
              newEndNode = range.endContainer;
              newEndOffset = range.endOffset;
              break;
            case 0: // startRange is equal
              newEndNode = startNode.endContainer;
              newEndOffset = startNode.endOffset;
              break;
            case 1: // startRange is after
              newEndNode = startRange.endContainer;
              newEndOffset = startRange.endOffset;
              break;
          }
          if (this. _debugOptions.displayRanges) {
            let clientRect = range.getBoundingClientRect();
            this._setDebugRect(clientRect, "orange", false);
          }
        }
        let range = content.document.createRange();
        range.setStart(newStartNode, newStartOffset);
        range.setEnd(newEndNode, newEndOffset);
        selection.addRange(range);
      }
    } catch (ex) {
      Util.dumpLn("exception while modifying selection:", ex.message);
      this._onFail("_handleSelectionPoint failed.");
      return false;
    }
    return true;
  },

  /*
   * _shrinkSelectionFromPoint(aMarker, aFramePoint)
   *
   * Tests to see if aFramePoint intersects the current selection and if so,
   * collapses selection down to the opposite start or end point leaving a
   * character of selection at the collapse point.
   *
   * @param aMarker the marker that is being relocated. ("start" or "end")
   * @param aFramePoint position of the marker. Should be relative to the
   * inner frame so that it matches selection range coordinates.
   */
  _shrinkSelectionFromPoint: function _shrinkSelectionFromPoint(aMarker, aFramePoint) {
    try {
      let selection = this._getSelection();
      let rects = selection.getRangeAt(0).getClientRects();
      for (let idx = 0; idx < rects.length; idx++) {
        if (Util.pointWithinDOMRect(aFramePoint.xPos, aFramePoint.yPos, rects[idx])) {
          if (aMarker == "start") {
            selection.collapseToEnd();
          } else {
            selection.collapseToStart();
          }
          // collapseToStart and collapseToEnd leave an empty range in the
          // selection at the collapse point. Therefore we need to add some
          // selection such that the selection added by selectAtPoint and
          // the current empty range will get merged properly when we smooth
          // the selection rnages out.
          let selCtrl = this._getSelectController();
          // Expand the collapsed range such that it occupies a little space.
          if (aMarker == "start") {
            // State: focus = anchor (collapseToEnd does this)
            selCtrl.characterMove(false, true);
            // State: focus = (anchor - 1)
            selection.collapseToStart();
            // State: focus = anchor and both are -1 from the original offset
            selCtrl.characterMove(true, true);
            // State: focus = anchor + 1, both have been moved back one char
          } else {
            selCtrl.characterMove(true, true);
          }
          break;
        }
      }
    } catch (ex) {
      Util.dumpLn("error shrinking selection:", ex.message);
    }
  },

  /*
   * Scroll + selection advancement timer when the monocle is
   * outside the bounds of an input control.
   */
  scrollTimerCallback: function scrollTimerCallback() {
    let result = SelectionHandler.updateTextEditSelection();
    // Update monocle position and speed if we've dragged off to one side
    if (result.trigger) {
      if (result.start)
        SelectionHandler._updateSelectionUI(true, false);
      if (result.end)
        SelectionHandler._updateSelectionUI(false, true);
    }
  },

  clearTimers: function clearTimers() {
    if (this._scrollTimer) {
      this._scrollTimer.clear();
    }
  },

  /*
   * Events
   */

  receiveMessage: function sh_receiveMessage(aMessage) {
    if (this._debugEvents && aMessage.name != "Browser:SelectionMove") {
      Util.dumpLn("SelectionHandler:", aMessage.name);
    }
    let json = aMessage.json;
    switch (aMessage.name) {
      case "Browser:SelectionStart":
        this._onSelectionStart(json.xPos, json.yPos);
        break;

      case "Browser:SelectionClose":
        this._onSelectionClose();
        break;

      case "Browser:SelectionMoveStart":
        this._onSelectionMoveStart(json);
        break;

      case "Browser:SelectionMove":
        this._onSelectionMove(json);
        break;

      case "Browser:SelectionMoveEnd":
        this._onSelectionMoveEnd(json);
        break;

      case "Browser:SelectionCopy":
        this._onSelectionCopy(json);
        break;

      case "Browser:SelectionClear":
        this._onSelectionClear();
        break;

      case "Browser:SelectionDebug":
        this._onSelectionDebug(json);
        break;

      case "Browser:SelectionUpdate":
        this._onSelectionUpdate();
        break;
    }
  },

  /*
   * Utilities
   */

  /*
   * Returns data on the position of a selection using the relative
   * coordinates in a range extracted from any sub frames. If aRange
   * is in the root frame offset should be zero. 
   */
  _extractContentRectFromRange: function _extractContentRectFromRange(aRange, aOffset) {
    let cache = {
      start: {}, end: {},
      rect: { left: 0, top: 0, right: 0, bottom: 0 }
    };

    // When in an iframe, aRange coordinates are relative to the frame origin.
    let rects = aRange.getClientRects();

    let startSet = false;
    for (let idx = 0; idx < rects.length; idx++) {
      if (this. _debugOptions.dumpRanges) Util.dumpDOMRect(idx, rects[idx]);
      if (!startSet && !Util.isEmptyDOMRect(rects[idx])) {
        cache.start.xPos = rects[idx].left + aOffset.x;
        cache.start.yPos = rects[idx].bottom + aOffset.y;
        startSet = true;
        if (this. _debugOptions.dumpRanges) Util.dumpLn("start set");
      }
      if (!Util.isEmptyDOMRect(rects[idx])) {
        cache.end.xPos = rects[idx].right + aOffset.x;
        cache.end.yPos = rects[idx].bottom + aOffset.y;
        if (this. _debugOptions.dumpRanges) Util.dumpLn("end set");
      }
    }

    let r = aRange.getBoundingClientRect();
    cache.rect.left = r.left + aOffset.x;
    cache.rect.top = r.top + aOffset.y;
    cache.rect.right = r.right + aOffset.x;
    cache.rect.bottom = r.bottom + aOffset.y;

    if (!rects.length) {
      Util.dumpLn("no rects in selection range. unexpected.");
    }

    return cache;
  },

  _getTargetContentRect: function _getTargetContentRect() {
    let client = this._targetElement.getBoundingClientRect();
    let rect = {};
    rect.left = client.left + this._contentOffset.x;
    rect.top = client.top + this._contentOffset.y;
    rect.right = client.right + this._contentOffset.x;
    rect.bottom = client.bottom + this._contentOffset.y;

    return rect;
  },

  _getTargetClientRect: function _getTargetClientRect() {
    return this._targetElement.getBoundingClientRect();
  },

   /*
    * Translate a top level client point to frame relative client point.
    */
  _clientPointToFramePoint: function _clientPointToFramePoint(aClientPoint) {
    let point = {
      xPos: aClientPoint.xPos - this._frameOffset.x,
      yPos: aClientPoint.yPos - this._frameOffset.y
    };
    return point;
  },

  /*
   * Retrieve the total offset from the window's origin to the sub frame
   * element including frame and scroll offsets. The resulting offset is
   * such that:
   * sub frame coords + offset = root frame position
   */
  getCurrentWindowAndOffset: function(x, y) {
    // elementFromPoint: If the element at the given point belongs to another
    // document (such as an iframe's subdocument), the element in the calling
    // document's DOM (e.g. the iframe) is returned.
    let utils = Util.getWindowUtils(content);
    let element = utils.elementFromPoint(x, y, true, false);

    let offset = { x:0, y:0 };
    let frameOffset = { x:0, y:0 };
    let scrollOffset = ContentScroll.getScrollOffset(content);
    offset.x += scrollOffset.x;
    offset.y += scrollOffset.y;

    while (element && (element instanceof HTMLIFrameElement ||
                       element instanceof HTMLFrameElement)) {
      //Util.dumpLn("found child frame:", element.contentDocument.location);

      // Get the content scroll offset in the child frame
      scrollOffset = ContentScroll.getScrollOffset(element.contentDocument.defaultView);
      // get the child frame position in client coordinates
      let rect = element.getBoundingClientRect();

      // subtract frame offset from our elementFromPoint coordinates
      x -= rect.left;
      // subtract frame and scroll offset and from elementFromPoint coordinates
      y -= rect.top + scrollOffset.y;

      // add frame client offset to our total offset result
      offset.x += rect.left;
      // add the frame's y offset + scroll offset to our total offset result
      offset.y += rect.top + scrollOffset.y;

      // Track the offset to the origin of the sub-frame as well
      frameOffset.x += rect.left;
      frameOffset.y += rect.top

      // get the frame's nsIDOMWindowUtils
      utils = element.contentDocument
                     .defaultView
                     .QueryInterface(Ci.nsIInterfaceRequestor)
                     .getInterface(Ci.nsIDOMWindowUtils);

      // retrieve the target element in the sub frame at x, y
      element = utils.elementFromPoint(x, y, true, false);
    }

    if (!element)
      return {};

    return {
      element: element,
      contentWindow: element.ownerDocument.defaultView,
      offset: offset,
      frameOffset: frameOffset,
      utils: utils
    };
  },

  _isTextInput: function _isTextInput(aElement) {
    return ((aElement instanceof Ci.nsIDOMHTMLInputElement &&
             aElement.mozIsTextField(false)) ||
            aElement instanceof Ci.nsIDOMHTMLTextAreaElement);
  },

  _getDocShell: function _getDocShell(aWindow) {
    if (aWindow == null)
      return null;
    return aWindow.QueryInterface(Ci.nsIInterfaceRequestor)
                  .getInterface(Ci.nsIWebNavigation)
                  .QueryInterface(Ci.nsIDocShell);
  },

  _getSelectedText: function _getSelectedText() {
    let selection = this._getSelection();
    return selection.toString();
  },

  _getSelection: function _getSelection() {
    if (this._targetElement instanceof Ci.nsIDOMNSEditableElement)
      return this._targetElement
                 .QueryInterface(Ci.nsIDOMNSEditableElement)
                 .editor.selection;
    else
      return this._contentWindow.getSelection();
  },

  _getSelectController: function _getSelectController() {
    if (this._targetElement instanceof Ci.nsIDOMNSEditableElement) {
      return this._targetElement
                 .QueryInterface(Ci.nsIDOMNSEditableElement)
                 .editor.selectionController;
    } else {
      let docShell = this._getDocShell(this._contentWindow);
      if (docShell == null)
        return null;
      return docShell.QueryInterface(Ci.nsIInterfaceRequestor)
                     .getInterface(Ci.nsISelectionDisplay)
                     .QueryInterface(Ci.nsISelectionController);
    }
  },

  /*
   * Debug routines
   */

  _debugDumpSelection: function _debugDumpSelection(aNote, aSel) {
    Util.dumpLn("--" + aNote + "--");
    Util.dumpLn("anchor:", aSel.anchorNode, aSel.anchorOffset);
    Util.dumpLn("focus:", aSel.focusNode, aSel.focusOffset);
  },

  _debugDumpChildNodes: function _dumpChildNodes(aNode, aSpacing) {
    for (let idx = 0; idx < aNode.childNodes.length; idx++) {
      let node = aNode.childNodes.item(idx);
      for (let spaceIdx = 0; spaceIdx < aSpacing; spaceIdx++) dump(" ");
      Util.dumpLn("[" + idx + "]", node);
      this._debugDumpChildNodes(node, aSpacing + 1);
    }
  },

  _setDebugElementRect: function _setDebugElementRect(e, aScrollOffset, aColor) {
    try {
      if (e == null) {
        Util.dumpLn("SelectionHandler _setDebugElementRect(): passed in null element");
        return;
      }
      if (e.offsetWidth == 0 || e.offsetHeight== 0) {
        Util.dumpLn("SelectionHandler _setDebugElementRect(): passed in flat rect");
        return;
      }
      // e.offset values are positioned relative to the view.
      sendAsyncMessage("Content:SelectionDebugRect",
        { left:e.offsetLeft - aScrollOffset.x,
          top:e.offsetTop - aScrollOffset.y,
          right:e.offsetLeft + e.offsetWidth - aScrollOffset.x,
          bottom:e.offsetTop + e.offsetHeight - aScrollOffset.y,
          color:aColor, id: e.id });
    } catch(ex) {
      Util.dumpLn("SelectionHandler _setDebugElementRect():", ex.message);
    }
  },

  /*
   * Adds a debug rect to the selection overlay, useful in identifying
   * locations for points and rects. Params are in client coordinates.
   *
   * Example:
   * let rect = { left: aPoint.xPos - 1, top: aPoint.yPos - 1,
   *              right: aPoint.xPos + 1, bottom: aPoint.yPos + 1 };
   * this._setDebugRect(rect, "red");
   *
   * In SelectionHelperUI, you'll need to turn on displayDebugLayer
   * in init().
   */
  _setDebugRect: function _setDebugRect(aRect, aColor, aFill, aId) {
    sendAsyncMessage("Content:SelectionDebugRect",
      { left:aRect.left, top:aRect.top,
        right:aRect.right, bottom:aRect.bottom,
        color:aColor, fill: aFill, id: aId });
  },

  /*
   * Adds a small debug rect at the point specified. Params are in
   * client coordinates.
   *
   * In SelectionHelperUI, you'll need to turn on displayDebugLayer
   * in init().
   */
  _setDebugPoint: function _setDebugPoint(aX, aY, aColor) {
    let rect = { left: aX - 2, top: aY - 2,
                 right: aX + 2, bottom: aY + 2 };
    this._setDebugRect(rect, aColor, true);
  },
};

SelectionHandler.init();