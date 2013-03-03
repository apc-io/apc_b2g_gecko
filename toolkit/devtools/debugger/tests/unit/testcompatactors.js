/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

var gTestGlobals = [];

function createRootActor()
{
  let actor = {
    sayHello: function() {
      this._tabActors = [];
      for each (let g in gTestGlobals) {
        let actor = new BrowserTabActor(this.conn);
        actor.thread = new ThreadActor({});
        actor.thread.addDebuggee(g);
        actor.thread.global = g;
        actor.json = function() {
          return { actor: actor.actorID,
                   url: "http://www.example.com/",
                   title: actor.thread.global.__name };
        };
        actor.requestTypes["attach"] = function (aRequest) {
          dump("actor.thread.actorID = " + actor.thread.actorID + "\n");
          return {
            from: actor.actorID,
            type: "tabAttached",
            threadActor: actor.thread.actorID
          };
        };
        this.conn.addActor(actor);
        this.conn.addActor(actor.thread);
        this._tabActors.push(actor);
      }

      this.conn.send = (function (aOldSend) {
        return function (aPacket) {
          if (aPacket.type === "newSource") {
            // Don't send newSource Packets b/c we are an old version of the
            // RDP!
            return undefined;
          } else {
            return aOldSend.call(this, aPacket);
          }
        };
      }(this.conn.send));

      return { from: "root",
               applicationType: "xpcshell-tests",
               traits: {} };
    },

    listTabs: function(aRequest) {
      return {
        from: "root",
        selected: 0,
        tabs: [ actor.json() for (actor of this._tabActors) ]
      };
    },
  };

  actor.requestTypes = {
    "listTabs": actor.listTabs,
    "echo": function(aRequest) { return aRequest; },
    // Pretend that we do not know about the "sources" packet to force the
    // client to go into its backwards compatibility mode.
    "sources": function () {
      return {
        error: "unrecognizedPacketType"
      }
    },
  };
  return actor;
}

DebuggerServer.addTestGlobal = function addTestGlobal(aGlobal)
{
  gTestGlobals.push(aGlobal);
}
