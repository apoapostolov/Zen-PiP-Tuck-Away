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

  const observer = {
    observe(subject, topic) {
      if (topic !== "domwindowopened" || !subject) {
        return;
      }
      // The player fills in its controls on load, so wait for it.
      subject.addEventListener("load", () => setTimeout(() => decorate(subject), 0), { once: true });
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

  // ---------- teardown (Sine calls this when the mod is disabled or updated)

  const unload = () => {
    try {
      Services.ww.unregisterNotification(observer);
    } catch (err) {
      log("could not unregister the window observer", err);
    }
    window.removeEventListener("keydown", onKeyDown, true);
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
