const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/DOMRequestHelper.jsm");

const HELLO_CID = Components.ID("{f329acd2-f28b-48f1-995f-a5a915239fcb}");
const HELLO_CONTRACTID = "@mozilla.org/helloworld;1";

function HelloWorld() { }

HelloWorld.prototype = {
  __proto__: DOMRequestIpcHelper.prototype,
  __exposedProps__: { hello: 'r'},
  classID: HELLO_CID,
  QueryInterface: XPCOMUtils.generateQI([Components.interfaces.nsIHelloWorld]),
  classInfo: XPCOMUtils.generateCI({classID: HELLO_CID,
                                    contractID: HELLO_CONTRACTID,
                                    classDescription: "DOM Hello World",
                                    interfaces: [Components.interfaces.nsIHelloWorld],
                                    flags: Components.interfaces.nsIClassInfo.DOM_OBJECT}),
  hello: function() { return "Hello World!"; },

  init: function(window) {
  	dump("____________ ok, this is HelloWorld::init() with the window " + window);
  	dump("this.hello = " + this.hello);
  }
};
var components = [HelloWorld];
this.NSGetFactory = XPCOMUtils.generateNSGetFactory(components);  // Firefox 4.0 and higher