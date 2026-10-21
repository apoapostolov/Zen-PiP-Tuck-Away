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
  const WIDGET_PREF = "pip-tuck-away.in-widget";
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

  // ---------- trace
  //
  // Whether the player opens depends on state that only exists in a live window:
  // which route the request took, and whether Zen's media card was really on
  // screen rather than merely in the markup. Those two questions cannot be
  // answered from a test harness or a restart, so the decisions are written to a
  // small log in the profile that can be read afterwards.

  const TRACE_PREF = "pip-tuck-away.trace";
  const TRACE_MAX = 96 * 1024;

  const tracePath = () => {
    for (const make of [
      () => {
        const file = Services.dirsvc.get("ProfD", Components.interfaces.nsIFile);
        file.append("pip-tuck-away-trace.log");
        return file.path;
      },
      () => PathUtils.join(PathUtils.profileDir, "pip-tuck-away-trace.log"),
    ]) {
      try {
        const path = make();
        if (path) {
          return path;
        }
      } catch (err) {
        // try the next way of asking for the profile directory
      }
    }
    return null;
  };

  const trace = (message) => {
    try {
      if (!pref(TRACE_PREF, true)) {
        return;
      }
      const path = tracePath();
      const line = `${new Date().toISOString()} ${message}\n`;
      if (!path) {
        log(message);
        return;
      }
      IOUtils.exists(path)
        .then(async (there) => {
          if (there) {
            const info = await IOUtils.stat(path);
            if (info.size > TRACE_MAX) {
              await IOUtils.remove(path, { ignoreAbsent: true });
            }
          }
          await IOUtils.writeUTF8(path, line, { mode: "append" });
        })
        .catch(() => {});
    } catch (err) {
      log(message, err);
    }
  };

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
    // Ctrl+Alt+T. Not the browser's reopen-closed-tab chord, which this mod has
    // no business claiming, and not one a page is likely to want.
    if (!event.ctrlKey || !event.altKey || event.shiftKey || event.metaKey) {
      return;
    }
    // AltGr reports itself as ctrl+alt on most layouts, which would hand this
    // mod a key the keyboard layout owns.
    if (event.getModifierState?.("AltGraph")) {
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
    // Nothing playing: leave the chord alone rather than swallow a key nobody
    // asked this mod to hold.
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
          setTimeout(() => {
            decorate(subject);
            // A player window is the only window worth docking, and by now the
            // dock machinery exists.
            startDockLoop();
          }, 0);
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
  // Firefox opens the player window in two ways: the user asks for it, or its own
  // auto toggle fires when a playing tab is hidden by a tab switch.
  //
  // An earlier version held the automatic request back, on the theory that Zen's
  // sidebar media card would drive the video instead. It does not work that way
  // in practice: the card shows up by itself for any playing background tab, so
  // the only thing the hold added was a player that arrived late or not at all,
  // while a video with no card anywhere both showed a player and confused the
  // first tab switch with the second. Nothing is held back now. A tab switch
  // behaves exactly as the platform intends, and the mod asks for a player only
  // in the one case the platform cannot handle: leaving Zen with the video's own
  // tab in front.

  let requestCooldownUntil = 0; // two focus blurs in a row must not ask twice
  let floatedWindow = null; // the player this mod asked for on leaving Zen
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

  // ---------- is Zen's own media card there to drive the video?
  //
  // Keeping the video in the page is only worth doing while Zen's media card
  // shows it, and that card is a toolbar of its own: enabled by a preference,
  // living in the sidebar's tabs toolbar, and absent from layouts that hide it.
  // With neither a player nor a card there is a video nobody can see, which is
  // worse than the player the platform asked for.

  const MEDIA_BAR = "#zen-media-controls-toolbar";

  /**
   * Whether Zen's media card is anywhere the user can see it, in one word, for
   * the trace only. Nothing is decided on it any more, but it is the first thing
   * to check when a video seems to be nowhere.
   */
  const mediaCardState = () => {
    try {
      const doc = window.document;
      if (!doc?.querySelector) {
        return "no-document";
      }
      const bar = doc.querySelector(MEDIA_BAR);
      if (!bar) {
        return "no-bar";
      }
      if (bar.hidden || bar.hasAttribute?.("hidden")) {
        return "bar-hidden";
      }
      if (!bar.querySelector?.(".zen-media-card:not([hidden])")) {
        return "no-card";
      }
      if (bar.offsetParent === null) {
        return "bar-collapsed";
      }
      const rect = bar.getBoundingClientRect?.();
      if (rect) {
        if (rect.height < 8 || rect.width < 40) {
          return `bar-tiny ${Math.round(rect.width)}x${Math.round(rect.height)}`;
        }
        const view = { w: window.innerWidth, h: window.innerHeight };
        if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= view.h || rect.left >= view.w) {
          return `bar-offscreen ${Math.round(rect.left)},${Math.round(rect.top)}`;
        }
      }
      return "shown";
    } catch (err) {
      return `error ${err?.message ?? err}`;
    }
  };

  // ---------- the video in Zen's media card
  //
  // The card is a row in the sidebar: a thumbnail, the name, the playtime, and
  // the buttons. The picture itself cannot be moved into the page: the player's
  // video lives in a separate window with its own browsing context, and the only
  // way to render a video's pixels inside the document is a canvas mirror, which
  // loses audio and fails on anything protected.
  //
  // So what is docked is the window, not the pixels. A gap is reserved inside
  // the card, under the name and the playtime, and the player window is sized
  // and moved into it. The video is the real video, with its real sound, and
  // nothing is reloaded, so playback never restarts.

  const DOCK_CLASS = "pip-tuck-away-dock";
  const DOCK_MAX_SHARE = 0.45; // of the window height, so a tall video cannot eat the sidebar
  const DOCK_SYNC_MS = 120;

  const mediaCards = () => {
    try {
      const bar = window.document?.querySelector?.(MEDIA_BAR);
      if (!bar || bar.hidden || bar.hasAttribute?.("hidden")) {
        return [];
      }
      return Array.from(bar.querySelectorAll?.(".zen-media-card:not([hidden])") ?? []);
    } catch (err) {
      return [];
    }
  };

  /** The card under the video's own tab, or the only card there is. */
  const cardForPlayer = (win) => {
    const cards = mediaCards();
    if (!cards.length) {
      return null;
    }
    if (cards.length === 1) {
      return cards[0];
    }
    try {
      const api = pipApi();
      const browser = api?.weakWinToBrowser?.get?.(win);
      const label = browser ? window.gBrowser?.getTabForBrowser?.(browser)?.label : null;
      if (label) {
        const match = cards.find((card) =>
          card.querySelector?.(".zen-media-title")?.textContent?.trim() === label.trim()
        );
        if (match) {
          return match;
        }
      }
    } catch (err) {
      // fall through to the first card
    }
    return cards[0];
  };

  const dockSpacer = (card) => {
    const main = card?.querySelector?.(".zen-media-main-vbox");
    if (!main) {
      return null;
    }
    let spacer = main.querySelector?.(`.${DOCK_CLASS}`);
    if (!spacer) {
      spacer = window.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
      spacer.className = DOCK_CLASS;
      spacer.setAttribute("aria-hidden", "true");
      const controls = main.querySelector?.(".zen-media-controls-hbox") ?? null;
      main.insertBefore(spacer, controls);
    }
    return spacer;
  };

  const clearSpacers = () => {
    for (const spacer of window.document.querySelectorAll?.(`.${DOCK_CLASS}`) ?? []) {
      spacer.style.height = "0px";
    }
  };

  const dockAspect = (win) => {
    const aspect = win?.__pipTuckAway?.aspect?.();
    return Number.isFinite(aspect) && aspect > 0.3 && aspect < 4 ? aspect : 16 / 9;
  };

  /** Where the picture should sit, in screen pixels. */
  const dockGeometry = (card, win) => {
    const spacer = dockSpacer(card);
    if (!spacer) {
      return null;
    }
    const cardWidth = card.getBoundingClientRect?.().width ?? 0;
    const width = Math.max(80, Math.round(cardWidth - 12));
    const limit = Math.round((window.innerHeight || 800) * DOCK_MAX_SHARE);
    const height = Math.max(45, Math.min(Math.round(width / dockAspect(win)), limit));
    if (Math.abs((parseFloat(spacer.style.height) || 0) - height) > 1) {
      spacer.style.height = `${height}px`;
    }
    const rect = spacer.getBoundingClientRect?.();
    if (!rect || rect.width < 40 || rect.height < 20) {
      return null;
    }
    const originX = Number.isFinite(window.mozInnerScreenX) ? window.mozInnerScreenX : window.screenX;
    const originY = Number.isFinite(window.mozInnerScreenY) ? window.mozInnerScreenY : window.screenY;
    return {
      x: originX + rect.left,
      y: originY + rect.top,
      width: rect.width,
      height: rect.height,
    };
  };

  let dockTimer = null;
  let dockedWindow = null;

  const stopDockLoop = () => {
    if (dockTimer) {
      clearInterval(dockTimer);
      dockTimer = null;
    }
  };

  const dockTick = () => {
    const win = Services.wm.getMostRecentWindow("Toolkit:PictureInPicture");
    if (!win) {
      if (dockedWindow?.__pipTuckAway) {
        dockedWindow.__pipTuckAway.undock?.();
      }
      dockedWindow = null;
      clearSpacers();
      stopDockLoop();
      return;
    }
    const api = win.__pipTuckAway;
    if (!api?.dock) {
      // The player document is still loading. The next tick finds it.
      return;
    }
    if (!pref(WIDGET_PREF, true)) {
      if (api.isDocked?.()) {
        api.undock?.();
      }
      dockedWindow = null;
      clearSpacers();
      return;
    }
    const card = cardForPlayer(win);
    const rect = card ? dockGeometry(card, win) : null;
    if (!rect) {
      // The card is not on screen: the player is a player again.
      if (api.isDocked?.()) {
        api.undock?.();
      }
      dockedWindow = null;
      clearSpacers();
      return;
    }
    dockedWindow = win;
    api.dock?.(rect);
  };

  const startDockLoop = () => {
    if (dockTimer) {
      return;
    }
    dockTimer = setInterval(dockTick, DOCK_SYNC_MS);
    dockTick();
  };

  const installPipHook = () => {
    const api = pipApi();
    if (!api || api.handlePictureInPictureRequest.__pipTuckAway) {
      return;
    }
    trueOriginal = api.handlePictureInPictureRequest.bind(api);
    const wrapped = async (wgp, videoData) => {
      trace(
        `request: tabSwitch=${requestedByTabSwitch(wgp)} focus=${requestingWindowFocused(wgp)} ` +
          `inline=${pref(INLINE_PREF, false)} card=${mediaCardState()} => passed to the platform`
      );
      return trueOriginal(wgp, videoData);
    };
    wrapped.__pipTuckAway = true;
    api.handlePictureInPictureRequest = wrapped;
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
    if (!pref(INLINE_PREF, false)) {
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
      if (!actor) {
        return;
      }
      actor.sendAsyncMessage?.("PictureInPicture:AutoToggle");
      trace("asked the selected tab for a player");
      watchFloated();
    } catch (err) {
      log("could not ask for a player on leaving Zen", err);
    }
  };

  /**
   * Remember the player this mod asked for. A window that the mod did not open
   * is left alone on return, because the user asked for it, and only a window
   * opened by leaving Zen is folded away when Zen comes back.
   */
  const watchFloated = () => {
    let tries = 0;
    const look = () => {
      const win = Services.wm.getMostRecentWindow("Toolkit:PictureInPicture");
      if (win) {
        floatedWindow = win;
        trace("the player opened after asking; it folds away on return");
        win.addEventListener(
          "unload",
          () => {
            if (floatedWindow === win) {
              floatedWindow = null;
            }
          },
          { once: true }
        );
        return;
      }
      if (++tries < 10) {
        setTimeout(look, 120);
      }
    };
    setTimeout(look, 120);
  };

  /** The window lost focus: ask the tab in front for a player, once. */
  const onLeftZen = () => {
    if (floatedWindow && !floatedWindow.closed) {
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
      // Closed by the player itself, through return to tab or the close button,
      // before the fold got there: nothing left to do.
      if (!win.closed) {
        closeFloated(win);
      }
    }, FOLD_DELAY);
  };

  installPipHook();
  if (Services.wm.getMostRecentWindow("Toolkit:PictureInPicture")) {
    startDockLoop();
  }

  trace(
    `browser half loaded; inline=${pref(INLINE_PREF, false)} ` +
      `card=${mediaCardState()} player=${Services.wm.getMostRecentWindow("Toolkit:PictureInPicture") ? "open" : "none"}`
  );
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
    stopDockLoop();
    clearSpacers();
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
