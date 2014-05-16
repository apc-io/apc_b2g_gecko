/*
 * trungnt
 */
// "use strict";

this.EXPORTED_SYMBOLS = ["EthernetMessage"];

this.EthernetMessage = {
  GETPRESENT: "EthernetManager:getpresent",
  GETSTATS: "EthernetManager:getstats",
  ENABLE: "EthernetManager:enable",
  DISABLE: "EthernetManager:disable",
  CONNECT: "EthernetManager:connect",
  DISCONNECT: "EthernetManager:disconnect",
  RECONNECT: "EthernetManager:reconnect",
  SETDHCPCD: "EthernetManager:setdhcp",
  SETSTATICIPCONFIG: "EthernetManager:setstaticipconfig",
  SETADDR: "EthernetManager:setaddr",
  SETMASK: "EthernetManager:setmask",
  SETGATEWAY: "EthernetManager:setgateway",
  SETDNS1: "EthernetManager:setdns1",
  SETDNS2: "EthernetManager:setdns2",
  GETENABLED: "EthernetManager:getenabled",
  GETCONNECTED: "EthernetManager:getconnected",
  ONENABLED: "EthernetManager:onenabled",
  ONDISABLED: "EthernetManager:ondisabled",
  ONCONNECTED: "EthernetManager:onconnected",
  ONDISCONNECTED: "EthernetManager:ondisconnected",
  ONDHCPCHANGED: "EthernetManager:ondhcpchanged",
  GETCONNECTION: "EthernetManager:getconnection"
};