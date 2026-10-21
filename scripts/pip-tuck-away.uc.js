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

  // ---------- keyboard toggle

  const playerWindow = () => Services.wm.getMostRecentWindow("Toolkit:PictureInPicture");

  const editable = (node) => {
    if (!node || node.nodeType !== 1) {
      return false;
    }
    const tag = node.localName;
    return tag === "input" || tag === "textarea" || tag === "select" || node.isContentEditable;
  };

  const onKeyDown = (event) => {
    if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) {
      return;
    }
    if (event.code !== "KeyT" && event.key?.toLowerCase() !== "t") {
      return;
    }
    if (!pref(SHORTCUT_PREF, true) || event.repeat) {
      return;
    }
    if (editable(event.originalTarget ?? event.target)) {
      return;
    }

    const pip = playerWindow();
    const api = pip?.__pipTuckAway;
    // Nothing playing: leave Ctrl+Shift+T alone so undo-close-tab still works.
    if (!api) {
      return;
    }

    // While a player is open this chord is ours, otherwise Firefox would
    // reopen the last closed tab at the same time.
    event.preventDefault();
    event.stopPropagation();
    api.toggle();
  };

  window.addEventListener("keydown", onKeyDown, true);

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
  window.addEventListener("deactivate", floatSuppressed);
  window.addEventListener("activate", foldBack);

  // ---------- teardown (Sine calls this when the mod is disabled or updated)

  const unload = () => {
    try {
      Services.ww.unregisterNotification(observer);
    } catch (err) {
      log("could not unregister the window observer", err);
    }
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("deactivate", floatSuppressed);
    window.removeEventListener("activate", foldBack);
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
