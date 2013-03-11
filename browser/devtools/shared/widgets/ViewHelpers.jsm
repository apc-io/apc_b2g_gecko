/* -*- Mode: javascript; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ft=javascript ts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

const Ci = Components.interfaces;
const Cu = Components.utils;

this.EXPORTED_SYMBOLS = ["ViewHelpers", "MenuItem", "MenuContainer"];

/**
 * Helpers for creating and messaging between UI components.
 */
this.ViewHelpers = {
  /**
   * Sugar for prototypal inheritance using Object.create.
   * Creates a new object with the specified prototype object and properties.
   *
   * @param object aObject
   *        An object containing the following properties:
   *          - constructor: the function to configure the prototype for
   *          - proto: the prototype to extend
   * @param object aProperties
   *        The properties extending the prototype.
   */
  create: function VH_create({ constructor, proto }, aProperties = {}) {
    let descriptors = {
      constructor: { value: constructor }
    };
    for (let name in aProperties) {
      descriptors[name] = Object.getOwnPropertyDescriptor(aProperties, name);
    }
    constructor.prototype = Object.create(proto, descriptors);
  },

  /**
   * Convenience method, dispatching a custom event.
   *
   * @param nsIDOMNode aTarget
   *        A custom target element to dispatch the event from.
   * @param string aType
   *        The name of the event.
   * @param any aDetail
   *        The data passed when initializing the event.
   * @return boolean
   *         True if the event was cancelled or a registered handler
   *         called preventDefault.
   */
  dispatchEvent: function VH_dispatchEvent(aTarget, aType, aDetail) {
    if (!aTarget) {
      return true; // Event cancelled.
    }
    let document = aTarget.ownerDocument || aTarget;
    let dispatcher = aTarget.ownerDocument ? aTarget : document.documentElement;

    let event = document.createEvent("CustomEvent");
    event.initCustomEvent(aType, true, true, aDetail);
    return dispatcher.dispatchEvent(event);
  },

  /**
   * Helper delegating some of the DOM attribute methods of a node to a widget.
   * @see MenuContainer constructor
   *
   * @param object aWidget
   *        The widget to assign the methods to.
   * @param nsIDOMNode aNode
   *        A node to delegate the methods to.
   */
  delegateWidgetAttributeMethods: function MC_delegateWidgetAttributeMethods(aWidget, aNode) {
    aWidget.getAttribute = aNode.getAttribute.bind(aNode);
    aWidget.setAttribute = aNode.setAttribute.bind(aNode);
    aWidget.removeAttribute = aNode.removeAttribute.bind(aNode);
  },

  /**
   * Helper delegating some of the DOM event methods of a node to a widget.
   * @see MenuContainer constructor
   *
   * @param object aWidget
   *        The widget to assign the methods to.
   * @param nsIDOMNode aNode
   *        A node to delegate the methods to.
   */
  delegateWidgetEventMethods: function MC_delegateWidgetEventMethods(aWidget, aNode) {
    aWidget.addEventListener = aNode.addEventListener.bind(aNode);
    aWidget.removeEventListener = aNode.removeEventListener.bind(aNode);
  }
};

/**
 * A generic MenuItem is used to describe elements present in a MenuContainer.
 * The label, value and description properties are necessarily strings.
 * Iterable via "for (let childItem in parentItem) { }".
 *
 * @param any aAttachment
 *        Some attached primitive/object.
 * @param string aLabel
 *        The label displayed in the container.
 * @param string aValue
 *        The actual internal value of the item.
 * @param string aDescription [optional]
 *        An optional description of the item.
 */
this.MenuItem = function MenuItem(aAttachment, aLabel, aValue, aDescription) {
  this.attachment = aAttachment;
  this._label = aLabel + "";
  this._value = aValue + "";
  this._description = (aDescription || "") + "";
};

MenuItem.prototype = {
  /**
   * Gets the label set for this item.
   * @return string
   */
  get label() this._label,

  /**
   * Gets the value set for this item.
   * @return string
   */
  get value() this._value,

  /**
   * Gets the description set for this item.
   * @return string
   */
  get description() this._description,

  /**
   * Immediately appends a child item to this menu item.
   *
   * @param nsIDOMNode
   *        An nsIDOMNode representing the child element to append.
   * @param object aOptions [optional]
   *        Additional options or flags supported by this operation:
   *          - attachment: some attached primitive/object for the item
   *          - attributes: a batch of attributes set to the displayed element
   *          - finalize: function called when the child node is removed
   * @return MenuItem
   *         The item associated with the displayed element.
   */
  append: function MI_append(aElement, aOptions = {}) {
    let item = new MenuItem(aOptions.attachment);

    // Handle any additional options before appending the child node.
    if (aOptions.attributes) {
      this.setAttributes(aOptions.attributes);
    }
    if (aOptions.finalize) {
      item.finalize = aOptions.finalize;
    }

    // Entangle the item with the newly inserted child node.
    this._entangleItem(item, this.target.appendChild(aElement));

    // Return the item associated with the displayed element.
    return item;
  },

  /**
   * Immediately removes the specified child item from this menu item.
   *
   * @param MenuItem aItem
   *        The item associated with the element to remove.
   */
  remove: function MI_remove(aItem) {
    if (!aItem) {
      return;
    }
    this.target.removeChild(aItem.target);
    this._untangleItem(aItem);
  },

  /**
   * Visually marks this menu item as selected.
   */
  markSelected: function MI_markSelected() {
    if (!this.target) {
      return;
    }
    this.target.classList.add("selected");
  },

  /**
   * Visually marks this menu item as deselected.
   */
  markDeselected: function MI_markDeselected() {
    if (!this.target) {
      return;
    }
    this.target.classList.remove("selected");
  },

  /**
   * Batch sets attributes on an element.
   *
   * @param array aAttributes
   *        An array of [name, value] tuples representing the attributes.
   * @param nsIDOMNode aElement [optional]
   *        A custom element to set the attributes to.
   */
  setAttributes: function MI_setAttributes(aAttributes, aElement = this.target) {
    for (let [name, value] of aAttributes) {
      aElement.setAttribute(name, value);
    }
  },

  /**
   * Entangles an item (model) with a displayed node element (view).
   *
   * @param MenuItem aItem
   *        The item describing the element.
   * @param nsIDOMNode aElement
   *        The element displaying the item.
   */
  _entangleItem: function MI__entangleItem(aItem, aElement) {
    if (!this._itemsByElement) {
      this._itemsByElement = new Map();
    }

    this._itemsByElement.set(aElement, aItem);
    aItem.target = aElement;
  },

  /**
   * Untangles an item (model) from a displayed node element (view).
   *
   * @param MenuItem aItem
   *        The item describing the element.
   */
  _untangleItem: function MI__untangleItem(aItem) {
    if (aItem.finalize) {
      aItem.finalize(aItem);
    }
    for (let childItem in aItem) {
      aItem.remove(childItem);
    }

    this._itemsByElement.delete(aItem.target);
    aItem.target = null;
  },

  /**
   * Returns a string representing the object.
   * @return string
   */
  toString: function MI_toString() {
    return this._label + " -> " + this._value;
  },

  _label: "",
  _value: "",
  _description: "",
  target: null,
  finalize: null,
  attachment: null
};

/**
 * A generic MenuContainer is used for displaying MenuItem instances.
 * Iterable via "for (let item in menuContainer) { }".
 *
 * Language:
 *   - An "item" is an instance (or compatible interface) of a MenuItem.
 *   - An "element" or "node" is a nsIDOMNode.
 *
 * The element node or widget supplied to all instances of this container
 * can either be a <menulist>, or any other object interfacing the following
 * methods:
 *   - function:nsIDOMNode insertItemAt(aIndex:number, aLabel:string, aValue:string)
 *   - function:nsIDOMNode getItemAtIndex(aIndex:number)
 *   - function removeChild(aChild:nsIDOMNode)
 *   - function removeAllItems()
 *   - get:nsIDOMNode selectedItem()
 *   - set selectedItem(aChild:nsIDOMNode)
 *   - function getAttribute(aName:string)
 *   - function setAttribute(aName:string, aValue:string)
 *   - function removeAttribute(aName:string)
 *   - function addEventListener(aName:string, aCallback:function, aBubbleFlag:boolean)
 *   - function removeEventListener(aName:string, aCallback:function, aBubbleFlag:boolean)
 */
this.MenuContainer = function MenuContainer() {
};

MenuContainer.prototype = {
  /**
   * Sets the element node or widget associated with this container.
   * @param nsIDOMNode | object aWidget
   */
  set node(aWidget) {
    this._container = aWidget;
    this._itemsByLabel = new Map();   // Can't use a WeakMap for itemsByLabel or
    this._itemsByValue = new Map();   // itemsByValue because keys are strings,
    this._itemsByElement = new Map(); // and itemsByElement needs to be iterable.
    this._stagedItems = [];
  },

  /**
   * Gets the element node or widget associated with this container.
   * @return nsIDOMNode | object
   */
  get node() this._container,

  /**
   * Prepares an item to be added to this container. This allows for a large
   * number of items to be batched up before alphabetically sorted and added.
   *
   * If the "staged" flag is not set to true, the item will be immediately
   * inserted at the correct position in this container, so that all the items
   * remain sorted. This can (possibly) be much slower than batching up
   * multiple items.
   *
   * By default, this container assumes that all the items should be displayed
   * sorted by their label. This can be overridden with the "index" flag,
   * specifying on which position should an item be appended.
   *
   * Furthermore, this container makes sure that all the items are unique
   * (two items with the same label or value are not allowed) and non-degenerate
   * (items with "undefined" or "null" labels/values). This can, as well, be
   * overridden via the "relaxed" flag.
   *
   * @param nsIDOMNode | object aContents
   *        An nsIDOMNode, or an array containing the following properties:
   *          - label: the label displayed in the container
   *          - value: the actual internal value of the item
   *          - description: an optional description of the item
   * @param object aOptions [optional]
   *        Additional options or flags supported by this operation:
   *          - staged: true to stage the item to be appended later
   *          - index: specifies on which position should the item be appended
   *          - relaxed: true if this container should allow dupes & degenerates
   *          - attachment: some attached primitive/object for the item
   *          - attributes: a batch of attributes set to the displayed element
   *          - finalize: function called when the item is untangled (removed)
   * @return MenuItem
   *         The item associated with the displayed element if an unstaged push,
   *         undefined if the item was staged for a later commit.
   */
  push: function MC_push(aContents, aOptions = {}) {
    if (aContents instanceof Ci.nsIDOMNode ||
        aContents instanceof Ci.nsIDOMElement) {
      // Allow the insertion of prebuilt nodes.
      aOptions.node = aContents;
      aContents = [];
    }

    let [label, value, description] = aContents;
    let item = new MenuItem(aOptions.attachment, label, value, description);

    // Batch the item to be added later.
    if (aOptions.staged) {
      return void this._stagedItems.push({ item: item, options: aOptions });
    }
    // Find the target position in this container and insert the item there.
    if (!("index" in aOptions)) {
      return this._insertItemAt(this._findExpectedIndex(label), item, aOptions);
    }
    // Insert the item at the specified index. If negative or out of bounds,
    // the item will be simply appended.
    return this._insertItemAt(aOptions.index, item, aOptions);
  },

  /**
   * Flushes all the prepared items into this container.
   *
   * @param object aOptions [optional]
   *        Additional options or flags supported by this operation:
   *          - sorted: true to sort all the items before adding them
   */
  commit: function MC_commit(aOptions = {}) {
    let stagedItems = this._stagedItems;

    // Sort the items before adding them to this container, if preferred.
    if (aOptions.sorted) {
      stagedItems.sort(function(a, b) a.item._label.toLowerCase() >
                                      b.item._label.toLowerCase());
    }
    // Append the prepared items to this container.
    for (let { item, options } of stagedItems) {
      this._insertItemAt(-1, item, options);
    }
    // Recreate the temporary items list for ulterior pushes.
    this._stagedItems.length = 0;
  },

  /**
   * Updates this container to reflect the information provided by the
   * currently selected item.
   *
   * @return boolean
   *         True if a selected item was available, false otherwise.
   */
  refresh: function MC_refresh() {
    let selectedValue = this.selectedValue;
    if (!selectedValue) {
      return false;
    }
    let entangledLabel = this.getItemByValue(selectedValue)._label;
    this._container.removeAttribute("notice");
    this._container.setAttribute("label", entangledLabel);
    this._container.setAttribute("tooltiptext", selectedValue);
    return true;
  },

  /**
   * Immediately removes the specified item from this container.
   *
   * @param MenuItem aItem
   *        The item associated with the element to remove.
   */
  remove: function MC_remove(aItem) {
    if (!aItem) {
      return;
    }
    this._container.removeChild(aItem.target);
    this._untangleItem(aItem);
  },

  /**
   * Removes all items from this container.
   */
  empty: function MC_empty() {
    this._preferredValue = this.selectedValue;
    this._container.selectedItem = null;
    this._container.removeAllItems();
    this._container.setAttribute("notice", this.emptyText);
    this._container.setAttribute("label", this.emptyText);
    this._container.removeAttribute("tooltiptext");

    for (let [, item] of this._itemsByElement) {
      this._untangleItem(item);
    }

    this._itemsByLabel = new Map();
    this._itemsByValue = new Map();
    this._itemsByElement = new Map();
    this._stagedItems.length = 0;
  },

  /**
   * Does not remove any item in this container. Instead, it overrides the
   * current label to signal that it is unavailable and removes the tooltip.
   */
  setUnavailable: function MC_setUnavailable() {
    this._container.setAttribute("notice", this.unavailableText);
    this._container.setAttribute("label", this.unavailableText);
    this._container.removeAttribute("tooltiptext");
  },

  /**
   * The label string automatically added to this container when there are
   * no child nodes present.
   */
  emptyText: "",

  /**
   * The label string added to this container when it is marked as unavailable.
   */
  unavailableText: "",

  /**
   * Toggles all the items in this container hidden or visible.
   *
   * @param boolean aVisibleFlag
   *        Specifies the intended visibility.
   */
  toggleContents: function MC_toggleContents(aVisibleFlag) {
    for (let [, item] of this._itemsByElement) {
      item.target.hidden = !aVisibleFlag;
    }
  },

  /**
   * Checks whether an item with the specified label is among the elements
   * shown in this container.
   *
   * @param string aLabel
   *        The item's label.
   * @return boolean
   *         True if the label is known, false otherwise.
   */
  containsLabel: function MC_containsLabel(aLabel) {
    return this._itemsByLabel.has(aLabel) ||
           this._stagedItems.some(function({item}) item._label == aLabel);
  },

  /**
   * Checks whether an item with the specified value is among the elements
   * shown in this container.
   *
   * @param string aValue
   *        The item's value.
   * @return boolean
   *         True if the value is known, false otherwise.
   */
  containsValue: function MC_containsValue(aValue) {
    return this._itemsByValue.has(aValue) ||
           this._stagedItems.some(function({item}) item._value == aValue);
  },

  /**
   * Gets the preferred selected value to be displayed in this container.
   * @return string
   */
  get preferredValue() this._preferredValue,

  /**
   * Retrieves the item associated with the selected element.
   * @return MenuItem
   */
  get selectedItem() {
    let selectedElement = this._container.selectedItem;
    if (selectedElement) {
      return this._itemsByElement.get(selectedElement);
    }
    return -1;
  },

  /**
   * Retrieves the selected element's index in this container.
   * @return number
   */
  get selectedIndex() {
    let selectedElement = this._container.selectedItem;
    if (selectedElement) {
      return this._indexOfElement(selectedElement);
    }
    return -1;
  },

  /**
   * Retrieves the label of the selected element.
   * @return string
   */
  get selectedLabel() {
    let selectedElement = this._container.selectedItem;
    if (selectedElement) {
      return this._itemsByElement.get(selectedElement)._label;
    }
    return "";
  },

  /**
   * Retrieves the value of the selected element.
   * @return string
   */
  get selectedValue() {
    let selectedElement = this._container.selectedItem;
    if (selectedElement) {
      return this._itemsByElement.get(selectedElement)._value;
    }
    return "";
  },

  /**
   * Selects the element with the entangled item in this container.
   * @param MenuItem aItem
   */
  set selectedItem(aItem) {
    // A falsy item is allowed to invalidate the current selection.
    let targetNode = aItem ? aItem.target : null;

    // Prevent selecting the same item again, so return early.
    if (this._container.selectedItem == targetNode) {
      return;
    }
    this._container.selectedItem = targetNode;
    ViewHelpers.dispatchEvent(targetNode, "select", aItem);
  },

  /**
   * Selects the element at the specified index in this container.
   * @param number aIndex
   */
  set selectedIndex(aIndex) {
    let targetElement = this._container.getItemAtIndex(aIndex);
    if (targetElement) {
      this.selectedItem = this._itemsByElement.get(targetElement);
      return;
    }
    this.selectedItem = null;
  },

  /**
   * Selects the element with the specified label in this container.
   * @param string aLabel
   */
  set selectedLabel(aLabel)
    this.selectedItem = this._itemsByLabel.get(aLabel),

  /**
   * Selects the element with the specified value in this container.
   * @param string aValue
   */
  set selectedValue(aValue)
    this.selectedItem = this._itemsByValue.get(aValue),

  /**
   * Gets the item in the container having the specified index.
   *
   * @param number aIndex
   *        The index used to identify the element.
   * @return MenuItem
   *         The matched item, or null if nothing is found.
   */
  getItemAtIndex: function MC_getItemAtIndex(aIndex) {
    return this.getItemForElement(this._container.getItemAtIndex(aIndex));
  },

  /**
   * Gets the item in the container having the specified label.
   *
   * @param string aLabel
   *        The label used to identify the element.
   * @return MenuItem
   *         The matched item, or null if nothing is found.
   */
  getItemByLabel: function MC_getItemByLabel(aLabel) {
    return this._itemsByLabel.get(aLabel);
  },

  /**
   * Gets the item in the container having the specified value.
   *
   * @param string aValue
   *        The value used to identify the element.
   * @return MenuItem
   *         The matched item, or null if nothing is found.
   */
  getItemByValue: function MC_getItemByValue(aValue) {
    return this._itemsByValue.get(aValue);
  },

  /**
   * Gets the item in the container associated with the specified element.
   *
   * @param nsIDOMNode aElement
   *        The element used to identify the item.
   * @return MenuItem
   *         The matched item, or null if nothing is found.
   */
  getItemForElement: function MC_getItemForElement(aElement) {
    while (aElement) {
      let item = this._itemsByElement.get(aElement);
      if (item) {
        return item;
      }
      aElement = aElement.parentNode;
    }
    return null;
  },

  /**
   * Finds the index of an item in the container.
   *
   * @param MenuItem aItem
   *        The item get the index for.
   * @return number
   *         The index of the matched item, or -1 if nothing is found.
   */
  indexOfItem: function MC_indexOfItem(aItem) {
    return this._indexOfElement(aItem.target);
  },

  /**
   * Finds the index of an element in the container.
   *
   * @param nsIDOMNode aElement
   *        The element get the index for.
   * @return number
   *         The index of the matched element, or -1 if nothing is found.
   */
  _indexOfElement: function MC__indexOfElement(aElement) {
    let container = this._container;
    let itemCount = this._itemsByElement.size;

    for (let i = 0; i < itemCount; i++) {
      if (container.getItemAtIndex(i) == aElement) {
        return i;
      }
    }
    return -1;
  },

  /**
   * Returns the list of labels in this container.
   * @return array
   */
  get labels() {
    let labels = [];
    for (let [label] of this._itemsByLabel) {
      labels.push(label);
    }
    return labels;
  },

  /**
   * Returns the list of values in this container.
   * @return array
   */
  get values() {
    let values = [];
    for (let [value] of this._itemsByValue) {
      values.push(value);
    }
    return values;
  },

  /**
   * Gets the total number of items in this container.
   * @return number
   */
  get itemCount() this._itemsByElement.size,

  /**
   * Returns a list of all the visible (non-hidden) items in this container.
   * @return array
   */
  get visibleItems() {
    let items = [];
    for (let [element, item] of this._itemsByElement) {
      if (!element.hidden) {
        items.push(item);
      }
    }
    return items;
  },

  /**
   * Specifies the required conditions for an item to be considered unique.
   * Possible values:
   *   - 1: label AND value are different from all other items
   *   - 2: label OR value are different from all other items
   *   - 3: only label is required to be different
   *   - 4: only value is required to be different
   */
  uniquenessQualifier: 1,

  /**
   * Checks if an item is unique in this container.
   *
   * @param MenuItem aItem
   *        An object containing a label and a value property (at least).
   * @return boolean
   *         True if the element is unique, false otherwise.
   */
  isUnique: function MC_isUnique(aItem) {
    switch (this.uniquenessQualifier) {
      case 1:
        return !this._itemsByLabel.has(aItem._label) &&
               !this._itemsByValue.has(aItem._value);
      case 2:
        return !this._itemsByLabel.has(aItem._label) ||
               !this._itemsByValue.has(aItem._value);
      case 3:
        return !this._itemsByLabel.has(aItem._label);
      case 4:
        return !this._itemsByValue.has(aItem._value);
    }
    return false;
  },

  /**
   * Checks if an item's label and value are eligible for this container.
   *
   * @param MenuItem aItem
   *        An object containing a label and a value property (at least).
   * @return boolean
   *         True if the element is eligible, false otherwise.
   */
  isEligible: function MC_isEligible(aItem) {
    return this.isUnique(aItem) &&
           aItem._label != "undefined" && aItem._label != "null" &&
           aItem._value != "undefined" && aItem._value != "null";
  },

  /**
   * Finds the expected item index in this container based on its label.
   *
   * @param string aLabel
   *        The label used to identify the element.
   * @return number
   *         The expected item index.
   */
  _findExpectedIndex: function MC__findExpectedIndex(aLabel) {
    let container = this._container;
    let itemCount = this.itemCount;

    for (let i = 0; i < itemCount; i++) {
      if (this.getItemAtIndex(i)._label > aLabel) {
        return i;
      }
    }
    return itemCount;
  },

  /**
   * Immediately inserts an item in this container at the specified index.
   *
   * @param number aIndex
   *        The position in the container intended for this item.
   * @param MenuItem aItem
   *        An object containing a label and a value property (at least).
   * @param object aOptions [optional]
   *        Additional options or flags supported by this operation:
   *          - node: allows the insertion of prebuilt nodes instead of labels
   *          - relaxed: true if this container should allow dupes & degenerates
   *          - attributes: a batch of attributes set to the displayed element
   *          - finalize: function called when the item is untangled (removed)
   * @return MenuItem
   *         The item associated with the displayed element, null if rejected.
   */
  _insertItemAt: function MC__insertItemAt(aIndex, aItem, aOptions) {
    // Relaxed nodes may be appended without verifying their eligibility.
    if (!aOptions.relaxed && !this.isEligible(aItem)) {
      return null;
    }

    // Entangle the item with the newly inserted node.
    this._entangleItem(aItem, this._container.insertItemAt(aIndex,
      aOptions.node || aItem._label,
      aItem._value,
      aItem._description,
      aOptions.attachment));

    // Handle any additional options after entangling the item.
    if (aOptions.attributes) {
      aItem.setAttributes(aOptions.attributes, aItem.target);
    }
    if (aOptions.finalize) {
      aItem.finalize = aOptions.finalize;
    }

    // Return the item associated with the displayed element.
    return aItem;
  },

  /**
   * Entangles an item (model) with a displayed node element (view).
   *
   * @param MenuItem aItem
   *        The item describing the element.
   * @param nsIDOMNode aElement
   *        The element displaying the item.
   */
  _entangleItem: function MC__entangleItem(aItem, aElement) {
    this._itemsByLabel.set(aItem._label, aItem);
    this._itemsByValue.set(aItem._value, aItem);
    this._itemsByElement.set(aElement, aItem);
    aItem.target = aElement;
  },

  /**
   * Untangles an item (model) from a displayed node element (view).
   *
   * @param MenuItem aItem
   *        The item describing the element.
   */
  _untangleItem: function MC__untangleItem(aItem) {
    if (aItem.finalize) {
      aItem.finalize(aItem);
    }
    for (let childItem in aItem) {
      aItem.remove(childItem);
    }

    this._itemsByLabel.delete(aItem._label);
    this._itemsByValue.delete(aItem._value);
    this._itemsByElement.delete(aItem.target);
    aItem.target = null;
  },

  _container: null,
  _stagedItems: null,
  _itemsByLabel: null,
  _itemsByValue: null,
  _itemsByElement: null,
  _preferredValue: null
};

/**
 * A generator-iterator over all the items in this container.
 */
MenuItem.prototype.__iterator__ =
MenuContainer.prototype.__iterator__ = function VH_iterator() {
  if (!this._itemsByElement) {
    return;
  }
  for (let [, item] of this._itemsByElement) {
    yield item;
  }
};
