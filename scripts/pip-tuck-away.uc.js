// PiP Tuck Away: browser-window half.
//
// Watches for picture-in-picture player windows and loads the player half into
// each one, then owns the keyboard toggle that has to work while the browser
// window has focus.
//
// Loaded by Sine as a .uc.js script into chrome://browser/content/browser.xhtml.
// Player half: scripts/pip-player.uc.js, reachable through the profile's
// `content sine ../sine-mods/` manifest entry.
(() => {
  "use strict";

  if (window.__pipTuckAwayBrowser) {
    return;
  }
  window.__pipTuckAwayBrowser = true;

  const PLAYER_URL = "chrome://global/content/pictureinpicture/player.xhtml";
  const PLAYER_SCRIPT = "chrome://sine/content/pip-tuck-away/scripts/pip-player.uc.js";
  const SHORTCUT_PREF = "pip-tuck-away.shortcut";
  const AUTO_TUCK_PREF = "pip-tuck-away.auto-tuck";
  const INLINE_PREF = "pip-tuck-away.inline-in-zen";
  const PIP_MODULE = "moz-src:///toolkit/components/pictureinpicture/PictureInPicture.sys.mjs";

  const pref = (name, fallback) => {
    try {
      if (Services.prefs.getPrefType(name) === 0) {
        return fallback;
      }
      return Services.prefs.getBoolPref(name);
    } catch (err) {
      return fallback;
    }
  };

  const log = (message, err) => console.error(`[PiP Tuck Away] ${message}`, err ?? "");

  // ---------- keyboard toggle, on every Zen window
  //
  // The chord has to work from whatever window has focus: the main window, a
  // second browser window, or the player itself. A listener goes on each of
  // them, and the player is found through the window mediator rather than
  // through the window that saw the key, so one code path covers every case.

  const REQUEST_COOLDOWN = 1500; // ms between asking the same tab for a player
  const CHORD_CODE = "KeyT";
  const CHORD_KEY = "t";
  const KEYS_FLAG = "__pipTuckAwayKeys";

  const playerWindow = () => Services.wm.getMostRecentWindow("Toolkit:PictureInPicture");

  const editable = (node) => {
    if (!node || node.nodeType !== 1) {
      return false;
    }
    const tag = node.localName;
    return tag === "input" || tag === "textarea" || tag === "select" || node.isContentEditable;
  };

  const togglePlayer = () => {
    const api = playerWindow()?.__pipTuckAway;
    if (!api) {
      return false;
    }
    api.toggle();
    return true;
  };

  const onKeyDown = (event) => {
    // Ctrl+Shift+T, the chord this mod shipped with before the shortcut was
    // ever taken outside the browser.
    if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) {
      return;
    }
    if (event.code !== CHORD_CODE && event.key?.toLowerCase() !== CHORD_KEY) {
      return;
    }
    if (!pref(SHORTCUT_PREF, true) || event.repeat) {
      return;
    }
    if (editable(event.originalTarget ?? event.target)) {
      return;
    }
    // Nothing playing: leave the chord alone, so Ctrl+Shift+T still reopens a
    // closed tab when there is no player to act on.
    if (!togglePlayer()) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const detachKeys = (win) => {
    try {
      win.removeEventListener("keydown", onKeyDown, true);
      delete win[KEYS_FLAG];
    } catch (err) {
      // A window that is already gone needs no cleanup.
    }
  };

  const attachKeys = (win) => {
    try {
      if (!win || win.closed || win[KEYS_FLAG]) {
        return;
      }
      if (!String(win.location?.href ?? "").startsWith("chrome://")) {
        return;
      }
      win.addEventListener("keydown", onKeyDown, true);
      win[KEYS_FLAG] = true;
      win.addEventListener("unload", () => detachKeys(win), { once: true });
    } catch (err) {
      log("could not add the keyboard listener to a window", err);
    }
  };

  const attachAllWindows = () => {
    attachKeys(window);
    for (const win of Services.wm.getEnumerator(null)) {
      attachKeys(win);
    }
  };

  attachAllWindows();

  // ---------- attach the player half

  const decorate = (win) => {
    try {
      if (!win || win.__pipTuckAway) {
        return;
      }
      // A window opened a moment ago still reports about:blank, so this is the
      // first point where the chord can be attached reliably.
      attachKeys(win);
      if (win.location?.href !== PLAYER_URL) {
        return;
      }
      Services.scriptloader.loadSubScript(PLAYER_SCRIPT, win);
    } catch (err) {
      log("could not set up the player window", err);
    }
  };

  const existing = () => {
    for (const win of Services.wm.getEnumerator("Toolkit:PictureInPicture")) {
      decorate(win);
    }
  };

  /**
   * Attach before the player document has finished loading, polling briefly
   * for the moment the window holds the player page. Used only when auto tuck
   * is on, where the point is to beat the first painted frame.
   */
  const earlyLoad = (win) => {
    const started = Date.now();
    const tick = () => {
      try {
        if (!win || win.closed) {
          return;
        }
        if (win.location?.href === PLAYER_URL && win.document?.documentElement) {
          decorate(win);
          return;
        }
      } catch (err) {
        // A window mid-navigation can throw on location access; keep polling.
      }
      if (Date.now() - started > 1500) {
        return;
      }
      setTimeout(tick, 16);
    };
    setTimeout(tick, 0);
  };

  const observer = {
    observe(subject, topic) {
      if (topic !== "domwindowopened" || !subject) {
        return;
      }
      // Every new chrome window gets the chord too, so it works from a second
      // browser window or from the player itself.
      attachKeys(subject);
      // The window is about:blank at this point, so the chord is attached once
      // its real document has loaded.
      subject.addEventListener(
        "load",
        () => {
          attachKeys(subject);
          setTimeout(() => decorate(subject), 0);
        },
        { once: true }
      );
      // With auto tuck on, the player should never be seen in its normal
      // place, so get in as soon as the player document exists.
      if (pref(AUTO_TUCK_PREF, false)) {
        earlyLoad(subject);
      }
    },
  };

  Services.ww.registerNotification(observer);
  existing();

  // A player window created before this script ran is covered by existing();
  // re-check once in case it was still loading.
  setTimeout(existing, 1000);



  // ---------- keep playback inside Zen until the browser is left
  //
  // Firefox opens the player window in two ways: the user asks for it, or its
  // own auto toggle fires when a playing tab is hidden by a tab switch. Only
  // the second one is redirected, and Zen's media card in the sidebar already
  // shows the same video with its own controls while the tab is in the
  // background. The card hides itself whenever the player is in PiP mode, so
  // staying inline is what keeps it visible.

  let suppressed = null; // the request kept in the page
  let lastRequest = null; // the request we floated last, to float it again
  let requestCooldownUntil = 0; // two focus blurs in a row must not ask twice
  let floatedWindow = null; // the player opened because Zen lost focus
  let trueOriginal = null; // the unwrapped request handler

  const pipApi = () => {
    try {
      return ChromeUtils.importESModule(PIP_MODULE).PictureInPicture;
    } catch (err) {
      log("could not reach the picture-in-picture module", err);
      return null;
    }
  };

  /**
   * Mozilla's own marker for the automatic path: the docshell is inactive only
   * when the player was requested by the auto toggle for a hidden tab.
   */
  const requestedByTabSwitch = (wgp) => {
    try {
      const browser = wgp?.browsingContext?.top?.embedderElement;
      if (!browser) {
        return false;
      }
      if (!browser.docShellIsActive) {
        return true;
      }
      // Once a player has been floated the platform keeps the docshell active
      // on purpose, so the marker above stops meaning anything. A request from
      // a tab that is not the selected one is still the automatic path.
      const tabbrowser = browser.getTabBrowser?.();
      return !!tabbrowser && tabbrowser.selectedBrowser !== browser;
    } catch (err) {
      return false;
    }
  };

  /** Judge the window the request came from, so a second Zen window is not misread. */
  const requestingWindowFocused = (wgp) => {
    try {
      const parentWin = wgp?.browsingContext?.top?.embedderElement?.documentGlobal;
      if (parentWin?.document?.hasFocus) {
        return parentWin.document.hasFocus();
      }
    } catch (err) {
      // fall through to this window
    }
    return window.document.hasFocus();
  };

  const installPipHook = () => {
    const api = pipApi();
    if (!api || api.handlePictureInPictureRequest.__pipTuckAway) {
      return;
    }
    trueOriginal = api.handlePictureInPictureRequest.bind(api);
    const wrapped = async (wgp, videoData) => {
      const keepInline =
        pref(INLINE_PREF, false) && requestedByTabSwitch(wgp) && requestingWindowFocused(wgp);
      if (keepInline) {
        suppressed = { wgp, videoData };
        lastRequest = suppressed;
        return undefined;
      }
      return trueOriginal(wgp, videoData);
    };
    wrapped.__pipTuckAway = true;
    api.handlePictureInPictureRequest = wrapped;
  };

  /** Zen lost focus: hand the suppressed video to the real player window. */
  const floatSuppressed = () => {
    if (!suppressed || !trueOriginal || (floatedWindow && !floatedWindow.closed)) {
      return;
    }
    const { wgp, videoData } = suppressed;
    suppressed = null;
    Promise.resolve(trueOriginal(wgp, videoData))
      .then(() => {
        const win = Services.wm.getMostRecentWindow("Toolkit:PictureInPicture");
        if (!win) {
          return;
        }
        floatedWindow = win;
        win.addEventListener(
          "unload",
          () => {
            if (floatedWindow === win) {
              floatedWindow = null;
            }
          },
          { once: true }
        );
      })
      .catch((err) => {
        log("could not float the player after leaving Zen", err);
        lastRequest = null;
        suppressed = null;
        requestCooldownUntil = 0;
        requestFromSelectedTab();
      });
  };

  /**
   * Floating a player makes the platform mark the browser as auto-pipped and
   * force its docshell active, so the tab keeps running while it is hidden.
   * Both marks are cleared by the platform's own foreground close, and not by
   * a bare window close: leaving them behind means the tab never reports
   * itself hidden again and no player is ever requested a second time.
   */
  const releaseDocShell = (api, browser) => {
    if (!browser) {
      return;
    }
    try {
      const tabbrowser = browser.getTabBrowser?.();
      // Only the tabbrowser can say whether this tab is meant to run. Guessing
      // false for the visible tab would freeze the page.
      if (!tabbrowser?.shouldActivateDocShell) {
        return;
      }
      if (!tabbrowser.shouldActivateDocShell(browser)) {
        browser.docShellIsActive = false;
      }
    } catch (err) {
      // A closed or discarded tab needs nothing.
    }
  };

  /**
   * Leaving Zen while the video's own tab is selected produces no automatic
   * request at all: the platform only pips a tab that got hidden, and its
   * handler skips the selected tab on purpose. Ask the browser's own launcher
   * for that tab, which is the same toggle the platform uses.
   */
  const requestFromSelectedTab = () => {
    if (!pref(INLINE_PREF, false) || suppressed) {
      return;
    }
    if (Services.wm.getMostRecentWindow("Toolkit:PictureInPicture")) {
      return;
    }
    if (Date.now() < requestCooldownUntil) {
      return;
    }
    requestCooldownUntil = Date.now() + REQUEST_COOLDOWN;
    try {
      const browser = window.gBrowser?.selectedBrowser;
      if (!browser || browser.audioMuted) {
        return;
      }
      const actor = browser.browsingContext?.currentWindowGlobal?.getActor(
        "PictureInPictureLauncher"
      );
      actor?.sendAsyncMessage?.("PictureInPicture:AutoToggle");
    } catch (err) {
      log("could not ask for a player on leaving Zen", err);
    }
  };

  /** The window lost focus: float what we kept, or ask for what is playing. */
  const onLeftZen = () => {
    if (suppressed) {
      floatSuppressed();
      return;
    }
    requestFromSelectedTab();
  };

  /** Close the player without the platform's bookkeeping, then do the bookkeeping. */
  const plainClose = (win, api, browser) => {
    Promise.resolve(api?.closePipWindow?.(win))
      .catch((err) => log("could not close the floated player", err))
      .finally(() => {
        // The plain close leaves the browser counted as pip'd, which would keep
        // its docshell active for good. Do what the platform's own close does
        // with that count.
        try {
          if (browser && api?.browserWeakMap?.has?.(browser)) {
            api.removePiPBrowserFromWeakMap?.(browser);
          }
          api?.weakAutoPipBrowserToParent?.delete?.(browser);
        } catch (err) {
          // A closed tab needs no bookkeeping.
        }
        releaseDocShell(api, browser);
      });
  };

  const closeFloated = (win) => {
    const api = pipApi();
    const browser = api?.weakWinToBrowser?.get?.(win) ?? null;
    const actorRef = browser ? api?.weakAutoPipBrowserToParent?.get?.(browser) ?? null : null;
    try {
      if (actorRef && api.closeSinglePipWindow) {
        // The same path the platform takes when the auto-pipped tab comes back
        // to the foreground: it clears the browser's PiP bookkeeping with it.
        Promise.resolve(api.closeSinglePipWindow({ reason: "Foregrounded", actorRef }))
          .then(() => {
            // A stale actor leaves that close a silent no-op, and the window
            // would then sit there with the video still piped.
            if (!win.closed) {
              plainClose(win, api, browser);
            }
          })
          .catch(() => plainClose(win, api, browser));
        return;
      }
    } catch (err) {
      log("could not close the floated player", err);
    }
    plainClose(win, api, browser);
  };

  // ms to let the platform close the player first. Its own return-to-tab path
  // focuses Zen before it closes the window, so this handler always runs first.
  const FOLD_DELAY = 80;

  /** Is the tab that owns this player the one the window is showing? */
  const isForegroundTab = (browser) => {
    try {
      const tabbrowser = browser?.getTabBrowser?.();
      if (!tabbrowser?.selectedBrowser) {
        return true; // cannot tell: fold, which is what this hook is for
      }
      return tabbrowser.selectedBrowser === browser;
    } catch (err) {
      return true;
    }
  };

  /**
   * Zen has focus again: close the player we opened, leaving the card in charge.
   *
   * Only when the tab that owns it is the tab on screen. Coming back to Zen on
   * some other tab is not coming back to the video, and the player is still the
   * window being watched; closing it there is how a player disappeared from a
   * tab that had nothing to do with it. The window stays marked, so arriving at
   * the video's own tab still folds it away.
   */
  const foldBack = () => {
    const win = floatedWindow;
    if (!win || win.closed) {
      floatedWindow = null;
      return;
    }
    let owner = null;
    try {
      owner = pipApi()?.weakWinToBrowser?.get?.(win) ?? null;
    } catch (err) {
      owner = null;
    }
    if (owner && !isForegroundTab(owner)) {
      return;
    }
    floatedWindow = null;
    setTimeout(() => {
      if (win.closed) {
        // Closed by the player itself: return to tab, the close button, the
        // chord. Nothing is waiting to be piped, so drop the kept request
        // instead of floating a video the user just sent back to the page.
        suppressed = null;
        lastRequest = null;
        return;
      }
      closeFloated(win);
      // The video is still the same video, so a second departure can float it
      // again without waiting for another tab switch to ask for it.
      const request = lastRequest;
      suppressed = request?.wgp?.browsingContext ? request : null;
      if (!suppressed) {
        lastRequest = null;
      }
    }, FOLD_DELAY);
  };

  installPipHook();
  // Firefox fires "activate" on chrome windows. Older builds and some paths
  // only give "focus"/"blur", so both pairs are wired and each handler is
  // idempotent.
  for (const type of ["deactivate", "blur"]) {
    window.addEventListener(type, onLeftZen);
  }
  for (const type of ["activate", "focus"]) {
    window.addEventListener(type, foldBack);
  }

  // ---------- teardown (Sine calls this when the mod is disabled or updated)

  const unload = () => {
    try {
      Services.ww.unregisterNotification(observer);
    } catch (err) {
      log("could not unregister the window observer", err);
    }
    detachKeys(window);
    for (const win of Services.wm.getEnumerator(null)) {
      detachKeys(win);
    }
    for (const type of ["deactivate", "blur"]) {
      window.removeEventListener(type, onLeftZen);
    }
    for (const type of ["activate", "focus"]) {
      window.removeEventListener(type, foldBack);
    }
    const api = pipApi();
    if (api && trueOriginal && api.handlePictureInPictureRequest.__pipTuckAway) {
      api.handlePictureInPictureRequest = trueOriginal;
    }
    for (const win of Services.wm.getEnumerator("Toolkit:PictureInPicture")) {
      win.__pipTuckAway?.destroy?.();
    }
  };

  if (typeof window.addUnloadListener === "function") {
    window.addUnloadListener(unload);
  } else {
    window.addEventListener("unload", unload, { once: true });
  }
})();
