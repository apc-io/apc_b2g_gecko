/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Is the currently opened tab focused?
function isTabFocused() {
  let tabb = gBrowser.getBrowserForTab(gBrowser.selectedTab);
  return Services.focus.focusedWindow == tabb.contentWindow;
}

function isChatFocused(chat) {
  return SocialChatBar.chatbar._isChatFocused(chat);
}

function openChatViaUser() {
  let sidebarDoc = document.getElementById("social-sidebar-browser").contentDocument;
  let button = sidebarDoc.getElementById("chat-opener");
  // Note we must use synthesizeMouseAtCenter() rather than calling
  // .click() directly as this causes nsIDOMWindowUtils.isHandlingUserInput
  // to be true.
  EventUtils.synthesizeMouseAtCenter(button, {}, sidebarDoc.defaultView);
}

function openChatViaSidebarMessage(port, data, callback) {
  port.onmessage = function (e) {
    if (e.data.topic == "chatbox-opened")
      callback();
  }
  port.postMessage({topic: "test-chatbox-open", data: data});
}

function openChatViaWorkerMessage(port, data, callback) {
  // sadly there is no message coming back to tell us when the chat has
  // been opened, so we wait until one appears.
  let chatbar = SocialChatBar.chatbar;
  let numExpected = chatbar.childElementCount + 1;
  port.postMessage({topic: "test-worker-chat", data: data});
  waitForCondition(function() chatbar.childElementCount == numExpected,
                   function() {
                      // so the child has been added, but we don't know if it
                      // has been intialized - re-request it and the callback
                      // means it's done.  Minimized, same as the worker.
                      SocialChatBar.openChat(Social.provider,
                                             data,
                                             function() {
                                                callback();
                                             },
                                             "minimized");
                   },
                   "No new chat appeared");
}


let isSidebarLoaded = false;

function startTestAndWaitForSidebar(callback) {
  let doneCallback;
  let port = Social.provider.getWorkerPort();
  function maybeCallback() {
    if (!doneCallback)
      callback(port);
    doneCallback = true;
  }
  port.onmessage = function(e) {
    let topic = e.data.topic;
    switch (topic) {
      case "got-sidebar-message":
        isSidebarLoaded = true;
        maybeCallback();
        break;
      case "test-init-done":
        if (isSidebarLoaded)
          maybeCallback();
        break;
    }
  }
  port.postMessage({topic: "test-init"});
}

let manifest = { // normal provider
  name: "provider 1",
  origin: "https://example.com",
  sidebarURL: "https://example.com/browser/browser/base/content/test/social/social_sidebar.html",
  workerURL: "https://example.com/browser/browser/base/content/test/social/social_worker.js",
  iconURL: "https://example.com/browser/browser/base/content/test/moz.png"
};

function test() {
  waitForExplicitFinish();

  // Note that (probably) due to bug 604289, if a tab is focused but the
  // focused element is null, our chat windows can "steal" focus.  This is
  // avoided if we explicitly focus an element in the tab.
  // So we load a page with an <input> field and focus that before testing.
  let url = "data:text/html;charset=utf-8," + encodeURI('<input id="theinput">');
  let tab = gBrowser.selectedTab = gBrowser.addTab(url, {skipAnimation: true});
  tab.linkedBrowser.addEventListener("load", function tabLoad(event) {
    tab.linkedBrowser.removeEventListener("load", tabLoad, true);
    // before every test we focus the input field.
    let preSubTest = function(cb) {
      // XXX - when bug 604289 is fixed it should be possible to just do:
      // tab.linkedBrowser.contentWindow.focus()
      // but instead we must do:
      tab.linkedBrowser.contentDocument.getElementById("theinput").focus();
      cb();
    }
    let postSubTest = function(cb) {
      window.SocialChatBar.chatbar.removeAll();
      cb();
    }
    // and run the tests.
    runSocialTestWithProvider(manifest, function (finishcb) {
      runSocialTests(tests, preSubTest, postSubTest, function () {
        finishcb();
      });
    });
  }, true);
  registerCleanupFunction(function() {
    gBrowser.removeTab(tab);
  });

}

var tests = {
  // In this test the worker asks the sidebar to open a chat.  As that means
  // we aren't handling user-input we will not focus the chatbar.
  // Then we do it again - should still not be focused.
  // Then we perform a user-initiated request - it should get focus.
  testNoFocusWhenViaWorker: function(next) {
    startTestAndWaitForSidebar(function(port) {
      openChatViaSidebarMessage(port, {stealFocus: 1}, function() {
        ok(true, "got chatbox message");
        is(SocialChatBar.chatbar.childElementCount, 1, "exactly 1 chat open");
        ok(isTabFocused(), "tab should still be focused");
        // re-request the same chat via a message.
        openChatViaSidebarMessage(port, {stealFocus: 1}, function() {
          is(SocialChatBar.chatbar.childElementCount, 1, "still exactly 1 chat open");
          ok(isTabFocused(), "tab should still be focused");
          // re-request the same chat via user event.
          openChatViaUser();
          is(SocialChatBar.chatbar.childElementCount, 1, "still exactly 1 chat open");
          // should now be focused
          ok(isChatFocused(SocialChatBar.chatbar.firstElementChild), "chat should be focused");
          next();
        });
      });
    });
  },

  // In this test we arrange for the sidebar to open the chat via a simulated
  // click.  This should cause the new chat to be opened and focused.
  testFocusWhenViaUser: function(next) {
    startTestAndWaitForSidebar(function(port) {
      openChatViaUser();
      ok(SocialChatBar.chatbar.firstElementChild, "chat opened");
      ok(isChatFocused(SocialChatBar.chatbar.firstElementChild), "chat should be focused");
      next();
    });
  },

  // Open a chat via the worker - it will open minimized and not have focus.
  // Then open the same chat via a sidebar message - it will be restored but
  // should still not have grabbed focus.
  testNoFocusOnAutoRestore: function(next) {
    const chatUrl = "https://example.com/browser/browser/base/content/test/social/social_chat.html?id=1";
    let chatbar = SocialChatBar.chatbar;
    startTestAndWaitForSidebar(function(port) {
      openChatViaWorkerMessage(port, chatUrl, function() {
        is(chatbar.childElementCount, 1, "exactly 1 chat open");
        ok(chatbar.firstElementChild.minimized, "chat is minimized");
        ok(isTabFocused(), "tab should be focused");
        openChatViaSidebarMessage(port, {stealFocus: 1, id: 1}, function() {
          is(chatbar.childElementCount, 1, "still 1 chat open");
          ok(!chatbar.firstElementChild.minimized, "chat no longer minimized");
          ok(isTabFocused(), "tab should still be focused");
          next();
        });
      });
    });
  },

  // Here we open a chat, which will not be focused.  Then we minimize it and
  // restore it via a titlebar clock - it should get focus at that point.
  testFocusOnExplicitRestore: function(next) {
    startTestAndWaitForSidebar(function(port) {
      openChatViaSidebarMessage(port, {stealFocus: 1}, function() {
        ok(true, "got chatbox message");
        ok(isTabFocused(), "tab should still be focused");
        let chatbox = SocialChatBar.chatbar.firstElementChild;
        ok(chatbox, "chat opened");
        chatbox.minimized = true;
        ok(isTabFocused(), "tab should still be focused");
        // pretend we clicked on the titlebar
        chatbox.onTitlebarClick({button: 0});
        ok(!chatbox.minimized, "chat should have been restored");
        ok(isChatFocused(chatbox), "chat should be focused");
        next();
      });
    });
  },

  // Open 2 chats and give 1 focus.  Minimize the focused one - the second
  // should get focus.
  testMinimizeFocused: function(next) {
    let chatbar = SocialChatBar.chatbar;
    startTestAndWaitForSidebar(function(port) {
      openChatViaSidebarMessage(port, {stealFocus: 1, id: 1}, function() {
        let chat1 = chatbar.firstElementChild;
        openChatViaSidebarMessage(port, {stealFocus: 1, id: 2}, function() {
          is(chatbar.childElementCount, 2, "exactly 2 chats open");
          let chat2 = chat1.nextElementSibling || chat1.previousElementSibling;
          chatbar.selectedChat = chat1;
          chatbar.focus();
          ok(isChatFocused(chat1), "first chat should be focused");
          chat1.minimized = true;
          // minimizing the chat with focus should give it to another.
          ok(isChatFocused(chat2), "second chat should be focused");
          next();
        });
      });
    });
  },

  // Open 2 chats, select (but not focus) one, then re-request it be
  // opened via a message.  Focus should not move.
  testReopenNonFocused: function(next) {
    let chatbar = SocialChatBar.chatbar;
    startTestAndWaitForSidebar(function(port) {
      openChatViaSidebarMessage(port, {id: 1}, function() {
        let chat1 = chatbar.firstElementChild;
        openChatViaSidebarMessage(port, {id: 2}, function() {
          let chat2 = chat1.nextElementSibling || chat1.previousElementSibling;
          chatbar.selectedChat = chat2;
          // tab still has focus
          ok(isTabFocused(), "tab should still be focused");
          // re-request the first.
          openChatViaSidebarMessage(port, {id: 1}, function() {
            is(chatbar.selectedChat, chat1, "chat1 now selected");
            ok(isTabFocused(), "tab should still be focused");
            next();
          });
        });
      });
    });
  },

  // Open 2 chats, select and focus the second.  Pressing the TAB key should
  // cause focus to move between all elements in our chat window before moving
  // to the next chat window.
  testTab: function(next) {
    let chatbar = SocialChatBar.chatbar;
    startTestAndWaitForSidebar(function(port) {
      openChatViaSidebarMessage(port, {id: 1}, function() {
        let chat1 = chatbar.firstElementChild;
        openChatViaSidebarMessage(port, {id: 2}, function() {
          let chat2 = chat1.nextElementSibling || chat1.previousElementSibling;
          chatbar.selectedChat = chat2;
          chatbar.focus();
          ok(isChatFocused(chat2), "new chat is focused");
          // Our chats have 3 focusable elements, so it takes 4 TABs to move
          // to the new chat.
          EventUtils.sendKey("tab");
          ok(isChatFocused(chat2), "new chat still focused after first tab");
          is(chat2.iframe.contentDocument.activeElement.getAttribute("id"), "input1",
             "first input field has focus");
          EventUtils.sendKey("tab");
          ok(isChatFocused(chat2), "new chat still focused after tab");
          is(chat2.iframe.contentDocument.activeElement.getAttribute("id"), "input2",
             "second input field has focus");
          EventUtils.sendKey("tab");
          ok(isChatFocused(chat2), "new chat still focused after tab");
          is(chat2.iframe.contentDocument.activeElement.getAttribute("id"), "iframe",
             "iframe has focus");
          // this tab now should move to the next chat.
          EventUtils.sendKey("tab");
          ok(isChatFocused(chat1), "first chat is focused");
          next();
        });
      });
    });
  },

  // Open a chat and focus an element other than the first. Move focus to some
  // other item (the tab itself in this case), then focus the chatbar - the
  // same element that was previously focused should still have focus.
  testFocusedElement: function(next) {
    let chatbar = SocialChatBar.chatbar;
    startTestAndWaitForSidebar(function(port) {
      openChatViaUser();
      let chat = chatbar.firstElementChild;
      // need to wait for the content to load before we can focus it.
      chat.addEventListener("DOMContentLoaded", function DOMContentLoaded() {
        chat.removeEventListener("DOMContentLoaded", DOMContentLoaded);
        chat.iframe.contentDocument.getElementById("input2").focus();
        is(chat.iframe.contentDocument.activeElement.getAttribute("id"), "input2",
           "correct input field has focus");
        // set focus to the tab.
        let tabb = gBrowser.getBrowserForTab(gBrowser.selectedTab);
        Services.focus.moveFocus(tabb.contentWindow, null, Services.focus.MOVEFOCUS_ROOT, 0);
        ok(isTabFocused(), "tab took focus");
        chatbar.focus();
        ok(isChatFocused(chat), "chat took focus");
        is(chat.iframe.contentDocument.activeElement.getAttribute("id"), "input2",
           "correct input field still has focus");
        next();
      });
    });
  },
};
