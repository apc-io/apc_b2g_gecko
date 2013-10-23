/*
 * trungnt
 */

"use strict";

importScripts("systemlibs.js");

let DEBUG = true;

let debug;
if (DEBUG) {
  debug = function (s) {
    dump("-*- ethernet_worker.js component: " + s + "\n");
  };
} else {
  debug = function (s) {};
}

self.onmessage = function(e) {
	debug("Ok, we got the message: " + e.data);
	postMessage("Here is what I return to you!");
}