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
  // postMessage("Here is what I return to you!");
  var data = e.data;
  var id = data.id;
  var cmd = data.cmd;

  for (let k in data) {
  	debug(">>>>>>> data." + k + ": " + data[k]);
  }

  switch (cmd) {
  case "ifc_enable":
  case "dhcp_stop":
  case "dhcp_release_lease":
    var ret = libnetutils[cmd](data.ifname);
    postMessage({ id: id, status: ret, ifname: data.ifname });
    break;
  case "dhcp_do_request":
    debug("Setting up dhcp then :), with iface: " + data.ifname);
    var out = libnetutils[cmd](data.ifname);
    out.id = id;
    out.status = out.ret;
    out.ifname = data.ifname;
    postMessage(out);
    break;
  }
}