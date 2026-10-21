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

  // ---------- attach the player half

  const decorate = (win) => {
    try {
      if (!win || win.__pipTuckAway) {
        return;
      }
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
      // The player fills in its controls on load, so wait for it.
      subject.addEventListener("load", () => setTimeout(() => decorate(subject), 0), { once: true });
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

  // ---------- keyboard toggle, on every Zen window
  //
  // The chord has to work from whatever window has focus: the main window, a
  // second browser window, or the player itself. A listener goes on each of
  // them, and the player is found through the window mediator rather than
  // through the window that saw the key, so one code path covers every case.

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
    if (!event.ctrlKey || !event.altKey || event.shiftKey || event.metaKey) {
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
    // Nothing playing: leave the chord alone so it belongs to whoever else
    // wants Ctrl+Alt+T.
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

  // ---------- global hotkey bridge
  //
  // A browser cannot receive a chord while another application has focus. The
  // platform hands that only to a native registration, and Firefox exposes no
  // hotkey API, so tools/pip-hotkey.pyw registers Ctrl+Alt+T with Windows and
  // writes a sequence number to a small file. This side reads that file while
  // a player exists and runs the same toggle. The helper is started by the
  // user, never by this script.

  const BRIDGE_PREF = "pip-tuck-away.global-hotkey";
  const BRIDGE_POLL = 150;

  const bridgeFile = () => {
    const dir = Services.dirsvc.get("LocalAppData", Components.interfaces.nsIFile);
    dir.append("pip-tuck-away");
    dir.append("toggle.json");
    return dir.path;
  };

  let bridgeSeq = null;
  let bridgeTimer = null;
  let bridgeWarned = false;

  const readBridge = async () => {
    if (typeof IOUtils === "undefined") {
      if (!bridgeWarned) {
        bridgeWarned = true;
        log("IOUtils is unavailable, so the global hotkey bridge stays off");
      }
      return null;
    }
    try {
      const file = bridgeFile();
      if (!(await IOUtils.exists(file))) {
        return null;
      }
      return JSON.parse(await IOUtils.readUTF8(file));
    } catch (err) {
      // A half written file or a directory that vanished: the next tick retries.
      return null;
    }
  };

  const pollBridge = async () => {
    if (!pref(BRIDGE_PREF, false) || !pref(SHORTCUT_PREF, true)) {
      return;
    }
    if (!playerWindow()) {
      // No player: forget the baseline so the next one starts clean.
      bridgeSeq = null;
      return;
    }
    const data = await readBridge();
    const seq = Number(data?.seq);
    if (!Number.isFinite(seq)) {
      return;
    }
    if (bridgeSeq === null) {
      bridgeSeq = seq; // the first read is a baseline, never a trigger
      return;
    }
    if (seq === bridgeSeq) {
      return;
    }
    if (seq < bridgeSeq) {
      // The helper restarted and began counting again, so adopt its baseline
      // instead of toggling on a number left over from the previous run.
      bridgeSeq = seq;
      return;
    }
    bridgeSeq = seq;
    togglePlayer();
  };

  const startBridge = () => {
    if (bridgeTimer) {
      return;
    }
    bridgeTimer = setInterval(() => {
      pollBridge().catch(() => {});
    }, BRIDGE_POLL);
  };

  const stopBridge = () => {
    if (bridgeTimer) {
      clearInterval(bridgeTimer);
      bridgeTimer = null;
    }
    bridgeSeq = null;
  };

  const onBridgePref = (subject, topic, name) => {
    if (topic !== "nsPref:changed" || name !== BRIDGE_PREF) {
      return;
    }
    if (pref(BRIDGE_PREF, false)) {
      startBridge();
    } else {
      stopBridge();
    }
  };

  Services.prefs.addObserver(BRIDGE_PREF, onBridgePref);
  if (pref(BRIDGE_PREF, false)) {
    startBridge();
  }

  // ---------- keep playback inside Zen until the browser is left
  //
  // Firefox opens the player window in two ways: the user asks for it, or its
  // own auto toggle fires when a playing tab is hidden by a tab switch. Only
  // the second one is redirected, and Zen's media card in the sidebar already
  // shows the same video with its own controls while the tab is in the
  // background. The card hides itself whenever the player is in PiP mode, so
  // staying inline is what keeps it visible.

  let suppressed = null; // the request kept in the page
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
      return !!browser && !browser.docShellIsActive;
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
        return undefined;
      }
      return trueOriginal(wgp, videoData);
    };
    wrapped.__pipTuckAway = true;
    api.handlePictureInPictureRequest = wrapped;
  };

  /** Zen lost focus: hand the suppressed video to the real player window. */
  const floatSuppressed = () => {
    if (!suppressed || !trueOriginal) {
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
      .catch((err) => log("could not float the player after leaving Zen", err));
  };

  /** Zen has focus again: close the player we opened, leaving the card in charge. */
  const foldBack = () => {
    if (!floatedWindow || floatedWindow.closed) {
      floatedWindow = null;
      return;
    }
    const api = pipApi();
    try {
      api?.closePipWindow?.(floatedWindow);
    } catch (err) {
      log("could not close the floated player", err);
    }
    floatedWindow = null;
  };

  installPipHook();
  // Firefox fires "activate" on chrome windows. Older builds and some paths
  // only give "focus"/"blur", so both pairs are wired and each handler is
  // idempotent.
  for (const type of ["deactivate", "blur"]) {
    window.addEventListener(type, floatSuppressed);
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
    stopBridge();
    try {
      Services.prefs.removeObserver(BRIDGE_PREF, onBridgePref);
    } catch (err) {
      log("could not remove the bridge observer", err);
    }
    detachKeys(window);
    for (const win of Services.wm.getEnumerator(null)) {
      detachKeys(win);
    }
    for (const type of ["deactivate", "blur"]) {
      window.removeEventListener(type, floatSuppressed);
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
