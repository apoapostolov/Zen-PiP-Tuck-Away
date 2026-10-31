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
  let destroyed = false;
  const timers = new Set();
  const loadingWindows = new Map();
  const cancelTimer = (id) => {
    clearTimeout(id);
    timers.delete(id);
  };
  const schedule = (callback, delay) => {
    if (destroyed) return 0;
    let id;
    let ran = false;
    id = setTimeout(() => {
      ran = true;
      timers.delete(id);
      if (!destroyed) callback();
    }, delay);
    if (!ran) timers.add(id);
    return id;
  };

  const PLAYER_URL = "chrome://global/content/pictureinpicture/player.xhtml";
  const PLAYER_SCRIPT = "chrome://sine/content/pip-tuck-away/scripts/pip-player.uc.js";
  const SHORTCUT_PREF = "pip-tuck-away.shortcut";
  const AUTO_TUCK_PREF = "pip-tuck-away.auto-tuck";
  const INLINE_PREF = "pip-tuck-away.inline-in-zen";
  const WIDGET_PREF = "pip-tuck-away.in-widget";
  const IGNORE_PREF = "pip-tuck-away.ignore-hosts";
  const FPS_PREF = "pip-tuck-away.preview-fps";
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
  const previewFPS = () => {
    try {
      const rate = Services.prefs.getStringPref(FPS_PREF, "30");
      return ["15", "30", "60"].includes(rate) ? Number(rate) : 30;
    } catch (err) {
      return 30;
    }
  };

  // ---------- trace
  //
  // Whether the player opens depends on state that only exists in a live window:
  // which route the request took, and whether Zen's media card was really on
  // screen rather than merely in the markup. Those two questions cannot be
  // answered from a test harness or a restart, so the decisions are written to a
  // small log in the profile that can be read afterwards.

  const TRACE_PREF = "pip-tuck-away.trace";

  /**
   * Where the trace goes.
   *
   * The mod's own folder comes first: it is the one directory this mod is
   * certain to be able to write to, and it is where somebody looking for the
   * trace would look. The profile root is the fallback.
   */
  const tracePath = () => {
    const id =
      /^chrome:\/\/sine\/content\/([^/]+)\//.exec(Components.stack?.filename ?? "")?.[1] ??
      "pip-tuck-away";
    for (const make of [
      () => PathUtils.join(PathUtils.profileDir, "chrome", "sine-mods", id, "trace.log"),
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
      if (!pref(TRACE_PREF, false)) {
        return;
      }
      const path = tracePath();
      const line = `${new Date().toISOString()} ${message}\n`;
      if (!path) {
        log(message);
        return;
      }
      const { appendTrace } = ChromeUtils.importESModule(
        "resource://pip-tuck-away/scripts/pip-trace.sys.mjs?v=1"
      );
      appendTrace(path, line)
        .catch((err) => {
          try {
            Services.prefs.setStringPref(
              "pip-tuck-away.trace-error",
              `${message} | ${err?.message ?? err}`
            );
          } catch (inner) {
            // Nothing left to report with.
          }
        });
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
      const keys = win[KEYS_FLAG];
      if (!keys?.owners?.delete(window) || keys.owners.size) return;
      win.removeEventListener("keydown", keys.handler, true);
      win.removeEventListener("unload", keys.onUnload);
      delete win[KEYS_FLAG];
    } catch (err) {
      // A window that is already gone needs no cleanup.
    }
  };

  const onTabSelect = () => {
    // The platform's own handler runs on the same event; letting it go first
    // means this is only needed when its registration is missing.
    schedule(closeForForegroundTab, 0);
    const now = window.gBrowser?.selectedBrowser ?? null;
    const previous = lastSelected;
    lastSelected = now;
    // The video is in the page now, so the widget has nothing left to show.
    if (mirrorBrowser && isForegroundTab(mirrorBrowser)) {
      stopMirror("its own tab came forward");
    }
    // The same goes for a tab that was only asked a moment ago: arriving at it
    // before it answered must not put its video in the widget behind its back.
    if (pendingBrowser && isForegroundTab(pendingBrowser)) {
      abandonPending("its own tab came forward", false);
    }
    // Leaving a tab shows its video in the widget, playing or paused. The
    // browser's own request only does this while a video is playing, and a
    // paused video is still a video the sidebar can show. A tab with nothing to
    // show answers that way and the panel keeps whatever it already had.
    if (previous && previous !== now && shouldMirror(previous)) {
      armMirror(previous);
    }
  };

  /** A tab that goes away takes its panel with it, rather than freezing one. */
  const onTabClose = (event) => {
    const browser = event?.target?.linkedBrowser ?? null;
    if (!browser) {
      return;
    }
    if (browser === mirrorBrowser) {
      stopMirror("its tab was closed");
    }
    if (browser === pendingBrowser) {
      abandonPending("its tab was closed", false);
    }
    if (browser === lastMirrored) {
      lastMirrored = null;
    }
    if (browser === lastSelected) {
      lastSelected = null;
    }
  };

  const watchTabs = (win) => {
    try {
      const strip = win.gBrowser?.tabContainer;
      if (!strip || strip[KEYS_FLAG]) {
        return;
      }
      strip.addEventListener("TabSelect", onTabSelect);
      strip.addEventListener("TabClose", onTabClose);
      strip[KEYS_FLAG] = true;
    } catch (err) {
      log("could not watch the tab strip", err);
    }
  };

  const attachKeys = (win) => {
    try {
      if (destroyed || !win || win.closed) return;
      if (win[KEYS_FLAG]) {
        win[KEYS_FLAG].owners.add(window);
        return;
      }
      if (!String(win.location?.href ?? "").startsWith("chrome://")) {
        return;
      }
      win.addEventListener("keydown", onKeyDown, true);
      const onUnload = () => {
        win.removeEventListener("keydown", onKeyDown, true);
        delete win[KEYS_FLAG];
      };
      win[KEYS_FLAG] = { handler: onKeyDown, onUnload, owners: new Set([window]) };
      win.addEventListener("unload", onUnload, { once: true });
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
  watchTabs(window);

  // ---------- attach the player half

  const decorate = (win) => {
    try {
      if (destroyed || !win || win.__pipTuckAway) {
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
      schedule(tick, 16);
    };
    schedule(tick, 0);
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
      const onLoad = () => {
        loadingWindows.delete(subject);
        attachKeys(subject);
        schedule(() => decorate(subject), 0);
      };
      loadingWindows.set(subject, onLoad);
      subject.addEventListener("load", onLoad, { once: true });
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
  schedule(existing, 1000);



  // ---------- hand automatic playback between the sidebar and player

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

  const sharedState = () => {
    const api = pipApi();
    if (!api) return null;
    return (api.__pipTuckAwayState ??= {
      windows: new Set(),
      handlers: new Map(),
      original: api.handlePictureInPictureRequest,
      wrapped: null,
    });
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

  // ---------- reserve space for the sidebar canvas above the media card

  const PANEL_MAX_SHARE = 0.45; // of the window height, so a tall video cannot eat the sidebar
  const PANEL_INSET = 6; // px between the panel and the edges of its slot
  const PANEL_HEIGHT_VAR = "--zen-media-collapsed-height";

  // The bar's own height, read once before any room has been made for the panel,
  // so the room is added to the real thing rather than to a guess.
  let panelBase = null;

  const releasePanelRoom = () => {
    panelBase = null;
    lastPanelNote = "";
    try {
      const style = window.document?.querySelector?.(MEDIA_BAR)?.style;
      style?.removeProperty?.(PANEL_HEIGHT_VAR);
      style?.removeProperty?.("transition");
    } catch (err) {
      // No bar to put back.
    }
  };

  /**
   * Make room for the panel inside the widget.
   *
   * Zen's media toolbar sets its own height from `--zen-media-collapsed-height`,
   * and it keeps that height while the cards overflow above it. Growing the
   * variable is therefore the supported way to give the panel a real slot: the
   * toolbar becomes taller, the tab list above gives the space up, and the card
   * sits at the bottom of the box with the panel's slot above it. The panel is
   * then inside the widget rather than floating over the sidebar, and it travels
   * with the box as the card expands on hover.
   */
  const reservePanelRoom = (bar, room) => {
    try {
      const style = bar?.style;
      if (!style?.setProperty) {
        return;
      }
      if (panelBase === null) {
        panelBase = Math.round(bar.getBoundingClientRect?.().height ?? 0) || 0;
      }
      // The toolbar's own height transition is switched off while the panel is
      // in the widget. The height is written from the card's height on every
      // frame instead, so the box and the card move together rather than the
      // box chasing the card three hundred milliseconds behind it.
      style.setProperty("transition", "none");
      style.setProperty(PANEL_HEIGHT_VAR, `calc(${panelBase}px + ${Math.round(room)}px)`);
    } catch (err) {
      log("could not make room for the panel", err);
    }
  };

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

  /**
   * The media card's own visibility, written down whenever it changes.
   *
   * A card that never appears is a question about Zen, not about this mod, and
   * it cannot be answered from the source: the answer is what the card does on
   * one real launch. This optional diagnostic reads the card once per second.
   */
  let lastCardNote = "";
  let cardWatchTimer = null;

  const cardWatchTick = () => {
    const note = mediaCardState();
    if (note !== lastCardNote) {
      lastCardNote = note;
      trace(`widget: ${note}`);
    }
  };

  const startCardWatch = () => {
    if (cardWatchTimer || !pref(TRACE_PREF, false)) {
      return;
    }
    cardWatchTimer = setInterval(cardWatchTick, 1000);
    cardWatchTick();
  };

  // --------------------------------------------------------------- the mirror
  //
  // While the browser is in front, a video in another tab is shown by copying
  // its frames into a canvas in the sidebar. No player window is opened at all,
  // so the browser's own picture-in-picture keeps its remembered size, its place
  // and its tucked edge, and it is exactly what appears the moment the browser
  // goes to the background. That is the whole point of the mirror: the widget
  // shows the video without ever standing in for picture-in-picture.
  //
  // The panel follows one rule, which covers every way a video can come and go:
  //
  //   The widget shows the video of the tab that was in front a moment ago, as
  //   long as that tab has a video at all. Playing or paused makes no
  //   difference, because the browser's own request only fires for a video that
  //   is playing and a paused video is still a video the sidebar can show.
  //
  // Everything else follows from it. The video's own tab coming forward ends the
  // panel, because the video is in the page now. A tab without a video leaves
  // the panel alone rather than emptying it. Going to another application ends
  // the panel and hands the video to the platform's own player, which is the
  // one thing a mirror cannot be: a window that floats over another application.
  //
  // A mirror copies pixels, so protected video comes back black. When the page
  // reports a media key system the request is handed to the platform and a real
  // player opens instead, which is the path this mod has always had.

  const MIRROR_ACTOR = "PipMirror";
  const MIRROR_RES = "pip-tuck-away";
  const MIRROR_VERSION = "11"; // bump when either actor file changes
  const MIRROR_ID = "pip-tuck-away-mirror";
  // Long enough for a slow first frame, short enough that a video which cannot
  // be copied is a player window rather than an empty box.
  const MIRROR_PATIENCE = 2000;
  const XHTML_NS = "http://www.w3.org/1999/xhtml";
  const PLAY_ICON = "M4 2l12 8-12 8z";
  const PAUSE_ICON = "M4 2h4v14H4zM10 2h4v14h-4z";
  const PIP_ICON = "M2 3h14v10H2zM8 8h7v5H8z";
  // The play/pause waits this long so a double click does not toggle twice on
  // its way to switching tabs.
  const DOUBLE_CLICK_MS = 260;

  let mirrorReady = false; // the actor registered: the mirror can be used at all
  let mirrorActor = null; // the tab whose picture is on screen
  let mirrorBrowser = null;
  let mirrorContext = null;
  let mirrorAspect = 16 / 9;
  let mirrorState = { paused: false, time: 0, duration: 0 };
  let mirrorPainted = false; // this tab has sent a picture
  let boxHasPicture = false; // the canvas holds one, whoever sent it
  let mirrorTimer = 0; // gives up when the tab on screen sends nothing
  let mirrorClick = 0; // a play/pause waiting out the double-click window
  let panelWatch = 0; // the next scheduled layout measurement
  let panelResize = null;
  let panelMutations = null;
  let panelBar = null;
  let panelCard = null;
  const panelTransitions = new Map();
  let lastPanelNote = ""; // what the panel was last placed at, so idle frames write nothing
  let lastPanelSize = [0, 0]; // the box the panel was last given
  let heldRequest = null; // the request the panel stands in for
  let lastMirrored = null; // the tab it was showing when the browser lost focus
  let lastSelected = null; // the tab that was in front before this one

  // A tab that was asked while another one is on screen. It is only believed
  // once it answers with a video: a tab with nothing to show leaves the panel
  // exactly as it was, which is why leaving one tab for a blank one cannot empty
  // the widget.
  let pendingActor = null;
  let pendingBrowser = null;
  let pendingHeld = null;
  let pendingTimer = 0;

  const forcedPip = new WeakSet();

  /** The mod's own folder, wherever Sine keeps it, as a resource:// alias. */
  const registerMirrorResources = () => {
    const id =
      /^chrome:\/\/sine\/content\/([^/]+)\//.exec(Components.stack?.filename ?? "")?.[1] ??
      "pip-tuck-away";
    let folder;
    try {
      folder = Cc["@mozilla.org/chrome/chrome-registry;1"]
        .getService(Ci.nsIChromeRegistry)
        .convertChromeURL(Services.io.newURI(`chrome://sine/content/${id}/`));
    } catch (err) {
      const dir = Services.dirsvc.get("ProfD", Ci.nsIFile);
      for (const part of ["chrome", "sine-mods", id]) {
        dir.append(part);
      }
      folder = Services.io.newFileURI(dir);
    }
    const protocols = Services.io
      .getProtocolHandler("resource")
      .QueryInterface(Ci.nsIResProtocolHandler);
    if (!protocols.hasSubstitution(MIRROR_RES)) {
      protocols.setSubstitution(MIRROR_RES, folder);
    }
  };

  const setupMirror = () => {
    try {
      registerMirrorResources();
      ChromeUtils.registerWindowActor(MIRROR_ACTOR, {
        parent: {
          esModuleURI: `resource://${MIRROR_RES}/scripts/pip-mirror-parent.sys.mjs?v=${MIRROR_VERSION}`,
        },
        child: {
          esModuleURI: `resource://${MIRROR_RES}/scripts/pip-mirror-child.sys.mjs?v=${MIRROR_VERSION}`,
          events: {
            play: { capture: true, mozSystemGroup: true },
            playing: { capture: true, mozSystemGroup: true },
            pause: { capture: true, mozSystemGroup: true },
            ended: { capture: true, mozSystemGroup: true },
            emptied: { capture: true, mozSystemGroup: true },
            seeked: { capture: true, mozSystemGroup: true },
            durationchange: { capture: true, mozSystemGroup: true },
          },
        },
        messageManagerGroups: ["browsers"],
        allFrames: true,
        safeForUntrustedWebProcess: true,
      });
      mirrorReady = true;
      sharedState()?.windows.add(window);
      // Registration is lazy: wake the actor for the tabs that are already open.
      for (const browser of window.gBrowser?.browsers ?? []) {
        try {
          browser.browsingContext?.currentWindowGlobal?.getActor(MIRROR_ACTOR);
        } catch (err) {
          // A tab without a live global will get one when it loads.
        }
      }
    } catch (err) {
      if (err?.name === "NotSupportedError") {
        // A second browser window finds the actor already registered, and the
        // actor belongs to the application rather than to one window: its
        // controller is reached through the window the tab lives in.
        mirrorReady = true;
        sharedState()?.windows.add(window);
      } else {
        log("the widget mirror could not register its actor", err);
        mirrorReady = false;
      }
    }
  };

  const teardownMirror = () => {
    abandonPending("unloaded");
    stopMirror("unloaded");
    try {
      const shared = sharedState();
      shared?.windows.delete(window);
      if (mirrorReady && !shared?.windows.size) {
        ChromeUtils.unregisterWindowActor(MIRROR_ACTOR);
      }
    } catch (err) {
      // Already gone.
    }
    mirrorReady = false;
  };

  /** The tab a browsing context belongs to, for matching answers to tabs. */
  const tabIdOf = (browser) => {
    try {
      return browser?.browsingContext?.id ?? null;
    } catch (err) {
      return null;
    }
  };

  const isPendingTab = (id) => id !== null && id === tabIdOf(pendingBrowser);

  /** Whether this window is the one being looked at. */
  const browserInFront = () => {
    try {
      return Services.focus?.activeWindow === window;
    } catch (err) {
      return false;
    }
  };

  /** Whether the whole application is behind something else. */
  const appInBackground = () => {
    try {
      return !Services.focus?.activeWindow;
    } catch (err) {
      return false;
    }
  };

  const mirrorBox = () => window.document?.getElementById?.(MIRROR_ID) ?? null;

  /**
   * Double click on the picture: bring the tab the video is in to the front.
   * The panel is a view of another tab, so this is the one gesture that ends the
   * look and returns to what the widget was showing.
   */
  const revealMirrorTab = () => {
    const tabbrowser = window.gBrowser;
    const browser = mirrorBrowser ?? pendingBrowser;
    if (!tabbrowser || !browser) {
      return false;
    }
    let tab = null;
    try {
      tab = tabbrowser.getTabForBrowser?.(browser) ?? null;
    } catch (err) {
      tab = null;
    }
    if (!tab) {
      tab = [...(tabbrowser.tabs ?? [])].find((entry) => entry?.linkedBrowser === browser) ?? null;
    }
    if (!tab) {
      log("the tab the widget is showing could not be found");
      return false;
    }
    tabbrowser.selectedTab = tab;
    try {
      window.focus();
    } catch (err) {
      // A window that refuses focus still has its tab selected.
    }
    trace("mirror: double click went to the video's tab");
    return true;
  };

  const buildMirrorBox = () => {
    const box = window.document.createElementNS(XHTML_NS, "div");
    box.id = MIRROR_ID;
    // Waiting means the panel is not in the layout at all: no box, no room
    // taken from the sidebar, nothing drawn until a real frame has arrived.
    box.setAttribute("waiting", "");
    const canvas = window.document.createElementNS(XHTML_NS, "canvas");
    box.append(canvas);
    const progress = window.document.createElementNS(XHTML_NS, "div");
    progress.className = "pip-tuck-away-mirror-progress";
    const bar = window.document.createElementNS(XHTML_NS, "span");
    progress.append(bar);
    box.append(progress);
    const controls = window.document.createElementNS(XHTML_NS, "div");
    controls.className = "pip-tuck-away-mirror-bar";
    const play = mirrorButton(PLAY_ICON, "Play or pause", () => controlMirror("toggle"));
    const pip = mirrorButton(PIP_ICON, "Open in a player window", () => openInPip());
    controls.append(play, pip);
    box.append(controls);
    canvas.addEventListener("click", (event) => {
      if ((event?.detail ?? 1) > 1) {
        // The second press of a double click: the tab switch owns this gesture.
        return;
      }
      if (mirrorClick) {
        cancelTimer(mirrorClick);
      }
      mirrorClick = schedule(() => {
        mirrorClick = 0;
        controlMirror("toggle");
      }, DOUBLE_CLICK_MS);
    });
    canvas.addEventListener("dblclick", (event) => {
      event?.preventDefault?.();
      if (mirrorClick) {
        cancelTimer(mirrorClick);
        mirrorClick = 0;
      }
      revealMirrorTab();
    });
    return box;
  };

  const mirrorButton = (path, label, onPress) => {
    const button = window.document.createElementNS(XHTML_NS, "button");
    button.className = "pip-tuck-away-mirror-button";
    button.setAttribute("type", "button");
    button.setAttribute("aria-label", label);
    button.title = label;
    const svg = window.document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 18 18");
    const shape = window.document.createElementNS("http://www.w3.org/2000/svg", "path");
    shape.setAttribute("d", path);
    svg.append(shape);
    button.append(svg);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onPress();
    });
    return button;
  };

  const mirrorPlayButton = () => mirrorBox()?.querySelector?.(".pip-tuck-away-mirror-button path");

  const showMirrorPlayIcon = () => {
    const shape = mirrorPlayButton();
    if (shape) {
      shape.setAttribute("d", mirrorState.paused ? PLAY_ICON : PAUSE_ICON);
    }
  };

  /** The panel sits above the card, at the widget's width. */
  const placeMirror = () => {
    const bar = window.document?.querySelector?.(MEDIA_BAR);
    const card = mediaCards()[0] ?? null;
    const box = mirrorBox();
    if (!bar || bar.hidden || bar.hasAttribute?.("hidden") || !card || !box) {
      if (mirrorActor && !mirrorTimer) startLivePatience();
      return;
    }
    const cardRect = card.getBoundingClientRect?.();
    const barRect = bar.getBoundingClientRect?.();
    if (!cardRect || !barRect || cardRect.width < 60 || barRect.width < 40 ||
        barRect.right <= 0 || barRect.bottom <= 0 ||
        barRect.left >= window.innerWidth || barRect.top >= window.innerHeight) {
      if (mirrorActor && !mirrorTimer) startLivePatience();
      return;
    }
    if (mirrorPainted && mirrorTimer) {
      cancelTimer(mirrorTimer);
      mirrorTimer = 0;
    }
    // The panel keeps the card's width for a wide video. A tall one is fitted by
    // height instead: keeping the full width would give a portrait clip every
    // pixel the sidebar is allowed to lend, which is more room than the picture
    // needs and reads as an empty black band.
    const limit = Math.round((window.innerHeight || 800) * PANEL_MAX_SHARE);
    const full = Math.max(80, Math.round(cardRect.width - PANEL_INSET * 2));
    const natural = Math.round(full / mirrorAspect);
    const height = Math.max(45, Math.min(natural, limit));
    const width = height === natural ? full : Math.max(45, Math.round(height * mirrorAspect));
    // The panel's bottom is six pixels above the card's top edge, so the room
    // the widget gives up is the panel, both insets, and whatever the card is
    // carrying beyond the height its collapsed box already counted. The card's
    // height is read as it is, mid-animation included, which is what keeps the
    // two moving together.
    // A base captured while the widget was expanded (a hover, a mid-animation
    // frame) would inflate every room written afterwards, so it is corrected the
    // moment the bar proves to be shorter than it.
    if (panelBase !== null && Math.round(barRect.height) < panelBase) {
      panelBase = Math.round(barRect.height) || 0;
    }
    const base = panelBase ?? (Math.round(barRect.height) || 0);
    const room = height + PANEL_INSET * 2 + Math.max(0, Math.round(cardRect.height) - base);
    const left = Math.round(cardRect.left - barRect.left + PANEL_INSET);
    // The panel hangs off the card's own top edge rather than off the top of
    // the toolbar. The room the toolbar gives up is what keeps the panel inside
    // the widget, but the panel's place no longer depends on it: the bottom edge
    // follows the card through layout changes, so room that has not caught up
    // yet cannot leave the panel sitting over the card.
    const bottom = Math.round(barRect.bottom - cardRect.top + PANEL_INSET);
    const note = `${left},${bottom},${width}x${height} room=${room}`;
    if (note === lastPanelNote) {
      return;
    }
    lastPanelNote = note;
    if (width !== lastPanelSize[0] || height !== lastPanelSize[1]) {
      lastPanelSize = [width, height];
      trace(`panel: ${width}x${height}, room ${room}, picture ${mirrorAspect.toFixed(3)}:1`);
    }
    reservePanelRoom(bar, room);
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;
    box.style.left = `${left}px`;
    box.style.top = "auto";
    box.style.bottom = `${bottom}px`;
  };

  // Observe sidebar changes while idle. Only active CSS transitions need
  // measurements on successive frames, so hover expansion remains aligned.
  const schedulePanel = () => {
    if (panelWatch || !mirrorBox()) return;
    panelWatch = window.requestAnimationFrame(() => {
      panelWatch = 0;
      if (!mirrorBox()) return;
      for (const target of panelTransitions.keys()) {
        if (target.isConnected === false) panelTransitions.delete(target);
      }
      const card = mediaCards()[0] ?? null;
      if (card !== panelCard) {
        if (panelCard) panelResize?.unobserve(panelCard);
        panelCard = card;
        if (card) panelResize?.observe(card);
      }
      placeMirror();
      if (panelTransitions.size) schedulePanel();
    });
  };

  const onPanelTransition = (event) => {
    // Writes to the preview itself must not keep its measurement loop alive.
    if (mirrorBox()?.contains(event.target)) return;
    if (!panelBar?.contains(event.target) && !event.target?.contains?.(panelBar)) return;
    if (event.type === "transitionrun") {
      if (!panelTransitions.has(event.target)) panelTransitions.set(event.target, new Set());
      panelTransitions.get(event.target).add(event.propertyName);
    } else {
      const properties = panelTransitions.get(event.target);
      properties?.delete(event.propertyName);
      if (!properties?.size) panelTransitions.delete(event.target);
    }
    schedulePanel();
  };

  const onPanelMutation = (records) => {
    const box = mirrorBox();
    if (records.some((record) => !box?.contains(record.target))) schedulePanel();
  };

  const startPanelWatch = () => {
    if (panelBar) return;
    panelBar = window.document?.querySelector?.(MEDIA_BAR);
    if (!panelBar) return;
    panelResize = new window.ResizeObserver(schedulePanel);
    panelResize.observe(panelBar);
    panelMutations = new window.MutationObserver(onPanelMutation);
    panelMutations.observe(panelBar, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ["class", "style", "hidden", "expanded"],
    });
    for (let ancestor = panelBar.parentElement; ancestor; ancestor = ancestor.parentElement) {
      panelMutations.observe(ancestor, {
        attributes: true,
        attributeFilter: ["class", "style", "hidden", "zen-compact-mode", "zen-user-show", "zen-sidebar-expanded"],
      });
    }
    for (const type of ["transitionrun", "transitionend", "transitioncancel"]) {
      window.addEventListener(type, onPanelTransition, true);
    }
    window.addEventListener("resize", schedulePanel);
    schedulePanel();
  };

  const stopPanelWatch = () => {
    if (panelWatch) window.cancelAnimationFrame?.(panelWatch);
    panelWatch = 0;
    panelResize?.disconnect();
    panelMutations?.disconnect();
    panelResize = panelMutations = null;
    for (const type of ["transitionrun", "transitionend", "transitioncancel"]) {
      window.removeEventListener(type, onPanelTransition, true);
    }
    window.removeEventListener("resize", schedulePanel);
    panelBar = panelCard = null;
    panelTransitions.clear();
    lastPanelNote = "";
  };

  const drawMirrorFrame = (frame) => {
    const box = mirrorBox();
    const canvas = box?.firstElementChild;
    if (!box || !canvas || !frame?.buf) {
      return;
    }
    if (!mirrorPainted) {
      mirrorPainted = true;
      boxHasPicture = true;
      box.removeAttribute("waiting");
      placeMirror();
      startPanelWatch();
    }
    if (canvas.width !== frame.width || canvas.height !== frame.height) {
      canvas.width = frame.width;
      canvas.height = frame.height;
      mirrorContext = null;
    }
    if (!mirrorContext) {
      mirrorContext = canvas.getContext("2d", { alpha: false });
    }
    try {
      mirrorContext.putImageData(
        new ImageData(new Uint8ClampedArray(frame.buf), frame.width, frame.height),
        0,
        0
      );
    } catch (err) {
      log("a mirrored frame could not be drawn", err);
    }
  };

  const showMirrorState = () => {
    showMirrorPlayIcon();
    const bar = mirrorBox()?.querySelector?.(".pip-tuck-away-mirror-progress span");
    if (!bar) {
      return;
    }
    const share =
      mirrorState.duration > 0 ? Math.min(1, mirrorState.time / mirrorState.duration) : 0;
    bar.style.width = `${Math.round(share * 100)}%`;
    mirrorBox()?.toggleAttribute?.("paused", !!mirrorState.paused);
  };

  const controlMirror = (action, value) => {
    const actor = mirrorActor ?? pendingActor;
    try {
      actor?.sendAsyncMessage?.("PipMirror:Control", { action, value });
    } catch (err) {
      log("the mirrored video did not take a command", err);
    }
  };

  const stopActor = (actor) => {
    try {
      actor?.sendAsyncMessage?.("PipMirror:Stop", {});
    } catch (err) {
      // The tab is gone; there is nothing left to stop.
    }
  };

  /** Hand a request the panel stood in for to the platform, unchanged. */
  const handToPlatform = (held, why) => {
    if (!held) {
      return;
    }
    trace(`mirror: falling back to a player window (${why})`);
    Promise.resolve(trueOriginal?.(held.wgp, held.videoData)).catch((err) =>
      log("the player the mirror fell back to did not open", err)
    );
  };

  const startLivePatience = () => {
    if (mirrorTimer) {
      cancelTimer(mirrorTimer);
    }
    mirrorTimer = schedule(() => {
      mirrorTimer = 0;
      if (mirrorPainted && mediaCardState() === "shown") {
        return;
      }
      const held = heldRequest;
      const browser = mirrorBrowser;
      const playing = !mirrorState.paused;
      heldRequest = null;
      stopMirror("no picture arrived");
      if (held) {
        handToPlatform(held, "no visible preview arrived");
      } else if (browser && playing) {
        forcedPip.add(browser);
        if (!askForPlayer(browser)) forcedPip.delete(browser);
      }
    }, MIRROR_PATIENCE);
  };

  const startPendingPatience = () => {
    if (pendingTimer) {
      cancelTimer(pendingTimer);
    }
    pendingTimer = schedule(() => {
      pendingTimer = 0;
      abandonPending("no picture arrived");
    }, MIRROR_PATIENCE);
  };

  /**
   * Ask a tab to show its video in the widget.
   *
   * With nothing on screen it becomes the panel at once, and a tab with no video
   * simply ends the attempt. With something already on screen it is asked
   * quietly and only takes the panel's place once it answers with a video, so
   * switching between tabs that have nothing to show cannot empty the widget.
   */
  const armMirror = (browser, held = null) => {
    if (!mirrorReady || !browser || skipTab(browser)) {
      return false;
    }
    if (!pref(WIDGET_PREF, true)) {
      return false;
    }
    if (!browserInFront()) {
      return false;
    }
    if (browser === mirrorBrowser || browser === pendingBrowser) {
      // TabSelect can start the preview before the platform requests PiP.
      // Retain that later request so a failed copy still gets a real player.
      if (held) {
        if (browser === mirrorBrowser) heldRequest = held;
        else pendingHeld = held;
      }
      return true;
    }
    const bar = window.document?.querySelector?.(MEDIA_BAR);
    if (!bar || !pref("zen.mediacontrols.enabled", true)) {
      return false;
    }
    let actor = null;
    try {
      actor = browser.browsingContext?.currentWindowGlobal?.getActor(MIRROR_ACTOR);
    } catch (err) {
      actor = null;
    }
    if (!actor) {
      return false;
    }
    if (mirrorActor) {
      abandonPending("another tab was asked");
      pendingActor = actor;
      pendingBrowser = browser;
      pendingHeld = held;
      startPendingPatience();
    } else {
      mirrorActor = actor;
      mirrorBrowser = browser;
      heldRequest = held;
      mirrorPainted = false;
      mirrorState = { paused: false, time: 0, duration: 0 };
      startLivePatience();
    }
    let box = mirrorBox();
    if (!box) {
      box = buildMirrorBox();
      bar.append(box);
      startPanelWatch();
    }
    if (!boxHasPicture) {
      box.setAttribute("waiting", "");
    }
    try {
      actor.sendAsyncMessage("PipMirror:Start", { fps: previewFPS() });
    } catch (err) {
      if (mirrorBrowser === browser) {
        mirrorActor = null;
        mirrorBrowser = null;
        heldRequest = null;
        if (mirrorTimer) {
          cancelTimer(mirrorTimer);
          mirrorTimer = 0;
        }
        if (!pendingBrowser) {
          stopPanelWatch();
          const dead = mirrorBox();
          if (dead) {
            dead.remove();
          }
        }
      }
      abandonPending("the tab did not take the request");
      return false;
    }
    trace(
      held
        ? "mirror: the widget shows the video, no player window opened"
        : "mirror: asked a tab for its video on a tab change"
    );
    return true;
  };

  /** The asked tab answered with a video, so it takes the panel's place. */
  const adoptPending = () => {
    const oldActor = mirrorActor;
    mirrorActor = pendingActor;
    mirrorBrowser = pendingBrowser;
    heldRequest = pendingHeld;
    pendingActor = null;
    pendingBrowser = null;
    pendingHeld = null;
    if (pendingTimer) {
      cancelTimer(pendingTimer);
      pendingTimer = 0;
    }
    if (oldActor && oldActor !== mirrorActor) {
      stopActor(oldActor);
    }
    mirrorPainted = false;
    mirrorState = { paused: false, time: 0, duration: 0 };
    const box = mirrorBox();
    if (box && !boxHasPicture) {
      box.setAttribute("waiting", "");
    }
    startLivePatience();
    trace("mirror: the panel follows the tab");
  };

  const abandonPending = (reason = "", fallback = true) => {
    if (pendingTimer) {
      cancelTimer(pendingTimer);
      pendingTimer = 0;
    }
    const actor = pendingActor;
    const held = pendingHeld;
    pendingActor = null;
    pendingBrowser = null;
    pendingHeld = null;
    if (actor) {
      stopActor(actor);
    }
    if (held && fallback) {
      handToPlatform(held, reason || "the copy could not start");
    }
  };

  const stopMirror = (reason = "") => {
    if (mirrorTimer) {
      cancelTimer(mirrorTimer);
      mirrorTimer = 0;
    }
    // A tab asked while this one was on screen is done with too: the panel it
    // was waiting to take over no longer exists.
    abandonPending("the panel was let go");
    if (mirrorClick) {
      cancelTimer(mirrorClick);
      mirrorClick = 0;
    }
    const had = !!mirrorActor;
    const actor = mirrorActor;
    mirrorActor = null;
    mirrorBrowser = null;
    heldRequest = null;
    mirrorPainted = false;
    boxHasPicture = false;
    mirrorContext = null;
    if (actor) {
      stopActor(actor);
    }
    stopPanelWatch();
    const box = mirrorBox();
    if (box) {
      box.remove();
    }
    if (panelBase !== null) {
      releasePanelRoom();
    }
    if (had && reason) {
      trace(`mirror: stopped (${reason})`);
    }
  };

  /** Hand the request the panel stood in for to the platform, and let it go. */
  const fallBackToPlayer = (why) => {
    const held = heldRequest;
    heldRequest = null;
    stopMirror("falling back");
    handToPlatform(held, why);
  };

  /** A real player for the tab on screen, asked for the way the browser asks. */
  const openInPip = () => {
    const browser = mirrorBrowser ?? window.gBrowser?.selectedBrowser;
    if (!browser) {
      return;
    }
    forcedPip.add(browser);
    heldRequest = null;
    stopMirror("asked for a player");
    if (!askForPlayer(browser)) forcedPip.delete(browser);
  };

  /**
   * The controller the parent actor talks to. It lives on the window so a second
   * browser window gets its own mirror and neither can draw into the other.
   */
  window.PipMirror = {
    mirrorStarted(id, data, actor) {
      if (data?.encrypted) {
        if (isPendingTab(id)) {
          abandonPending("the video is protected, a copy of it would be black");
        } else if (id === tabIdOf(mirrorBrowser)) {
          fallBackToPlayer("the video is protected, a copy of it would be black");
        }
        return;
      }
      if (isPendingTab(id)) {
        adoptPending();
      } else if (id !== tabIdOf(mirrorBrowser)) {
        return;
      }
      if (data?.width && data?.height) {
        mirrorAspect = data.width / data.height;
        schedulePanel();
      }
      mirrorState = {
        paused: !!data?.paused,
        time: data?.time ?? 0,
        duration: data?.duration ?? 0,
      };
      showMirrorState();
    },
    mirrorFrame(id, frame) {
      if (isPendingTab(id)) {
        adoptPending();
      } else if (id !== tabIdOf(mirrorBrowser)) {
        return;
      }
      drawMirrorFrame(frame);
      // The frame is the authority on its own shape. A page that reports its
      // video size late, or reports a different element's, cannot leave the panel
      // drawn with the wrong proportions. A degenerate copy says nothing.
      if (Math.max(frame?.width ?? 0, frame?.height ?? 0) >= 48) {
        const aspect = frame.width / frame.height;
        if (Math.abs(aspect - mirrorAspect) > 0.01) {
          mirrorAspect = aspect;
          placeMirror();
        }
      }
      if (frame) {
        mirrorState = {
          paused: !!frame.paused,
          time: frame.time ?? mirrorState.time,
          duration: frame.duration ?? mirrorState.duration,
        };
        showMirrorState();
      }
    },
    mirrorRate(id, data) {
      if (id !== tabIdOf(mirrorBrowser)) {
        return;
      }
      trace(
        `mirror: ${data.fps} fps, ${data.ms} ms a frame, ${data.width}x${data.height}, ` +
          `copied on ${data.trigger}${data.paused ? ", paused" : ""}`
      );
    },
    mirrorState(id, state) {
      if (id !== tabIdOf(mirrorBrowser)) {
        return;
      }
      mirrorState = { ...mirrorState, ...state };
      showMirrorState();
    },
    mirrorUnavailable(id, reason) {
      if (isPendingTab(id)) {
        // A tab with nothing to show is not a failure: the panel keeps what it
        // has, and a panel with nothing keeps nothing.
        abandonPending(reason);
        return;
      }
      if (id !== tabIdOf(mirrorBrowser)) {
        return;
      }
      fallBackToPlayer(reason);
    },
    mirrorStopped(id) {
      if (isPendingTab(id)) {
        abandonPending("the video stopped");
        return;
      }
      if (id !== tabIdOf(mirrorBrowser)) {
        return;
      }
      // The video ended or went away: the widget has nothing to show.
      stopMirror("the video stopped");
    },
  };

  /**
   * Whether a request should become a widget mirror rather than a player.
   *
   * Only while this window is the one being looked at, and only when the mirror
   * is possible at all. Anything else, including every request made while the
   * browser is in the background, goes to the platform untouched, which is what
   * keeps the browser's own picture-in-picture standard.
   */
  /**
   * A tab that is still nothing: Zen's own start page, or a blank one. The start
   * page can carry a video, and a video from a tab with no page has no address to
   * come back to, so it is neither shown in the widget nor given a player.
   */
  const BLANK_TITLES = ["new tab", "new tab page", "untitled"];
  const BLANK_URLS = ["about:newtab", "about:home", "about:blank"];
  const titleOf = (browser) => {
    try {
      const title = browser?.contentTitle ?? browser?.contentDocument?.title ?? "";
      return String(title).trim();
    } catch (err) {
      return "";
    }
  };
  const urlOf = (browser) => {
    try {
      return String(browser?.currentURI?.spec ?? "").trim();
    } catch (err) {
      return "";
    }
  };
  /**
   * One entry of the ignored list, reduced to a bare host. A domain is typed by
   * hand, so a pasted address, a port, a path and a www. prefix all mean the same
   * host.
   */
  const bareHost = (value) => {
    let host = String(value ?? "").trim().toLowerCase();
    if (!host) {
      return "";
    }
    host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
    host = host.replace(/^[^@/]*@/, "");
    host = host.split("/")[0].split("?")[0].split("#")[0];
    if (!host.startsWith("[")) {
      host = host.split(":")[0];
    }
    return host.replace(/^www\./, "");
  };

  const ignoredDomains = () => {
    try {
      const raw = Services.prefs.getStringPref(IGNORE_PREF, "");
      return raw.split(",").map(bareHost).filter(Boolean);
    } catch (err) {
      return [];
    }
  };

  const hostOf = (browser) => {
    try {
      const uri = browser?.currentURI;
      if (uri?.host) {
        return bareHost(uri.host);
      }
      return bareHost(uri?.spec ?? "");
    } catch (err) {
      return "";
    }
  };

  /** A domain the user typed into the settings, or anything under it. */
  const ignoredTab = (browser) => {
    const host = hostOf(browser);
    if (!host) {
      return false;
    }
    return ignoredDomains().some((entry) => host === entry || host.endsWith(`.${entry}`));
  };

  const blankTab = (browser) => {
    if (!browser) {
      return false;
    }
    if (BLANK_URLS.includes(urlOf(browser))) {
      return true;
    }
    const title = titleOf(browser).toLowerCase();
    return title !== "" && BLANK_TITLES.includes(title);
  };

  /** A tab this mod does not touch: nothing to come back to, or an ignored domain. */
  const skipTab = (browser) => blankTab(browser) || ignoredTab(browser);

  const shouldMirror = (browser) => {
    if (!mirrorReady || !browser) {
      return false;
    }
    if (!pref(WIDGET_PREF, true)) {
      return false;
    }
    if (skipTab(browser)) {
      return false;
    }
    if (forcedPip.delete(browser)) {
      return false;
    }
    return browserInFront();
  };

  const installPipHook = () => {
    const api = pipApi();
    const shared = sharedState();
    if (!api || !shared) return;
    trueOriginal = shared.original.bind(api);
    shared.handlers.set(window, (wgp, videoData) => {
      const fromTabSwitch = requestedByTabSwitch(wgp);
      const browser = browserOf(wgp);
      if (skipTab(browser)) {
        // Claimed and dropped: no player window and nothing in the widget. A tab
        // with no page has nothing to come back to, and a tab on a domain the
        // user named is not this mod's business at all.
        trace(`request: skipped (${blankTab(browser) ? "no page" : "ignored domain"})`);
        return true;
      }
      if (fromTabSwitch && browser) autoPipped.add(browser);
      if (shouldMirror(browser) && armMirror(browser, { wgp, videoData, browser })) {
        return true;
      }
      trace(
        `request: tabSwitch=${fromTabSwitch} focus=${requestingWindowFocused(wgp)} ` +
          `inline=${pref(INLINE_PREF, false)} card=${mediaCardState()} => passed to the platform`
      );
      return trueOriginal(wgp, videoData);
    });
    if (shared.wrapped) return;
    shared.wrapped = (wgp, videoData) => {
      const browser = browserOf(wgp);
      const owner = browser?.ownerGlobal ?? wgp?.browsingContext?.topChromeWindow;
      const handler = shared.handlers.get(owner) ??
        [...shared.handlers].find(([win]) =>
          win.gBrowser?.browsers?.includes(browser) || win.gBrowser?.selectedBrowser === browser
        )?.[1];
      // Unknown owners must never be mirrored in another window's sidebar.
      return handler ? handler(wgp, videoData) : shared.original.call(api, wgp, videoData);
    };
    shared.wrapped.__pipTuckAway = true;
    api.handlePictureInPictureRequest = shared.wrapped;
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
  const askForPlayer = (browser) => {
    if (Services.wm.getMostRecentWindow("Toolkit:PictureInPicture")) {
      return false;
    }
    if (Date.now() < requestCooldownUntil) {
      return false;
    }
    if (!browser || browser.audioMuted || skipTab(browser)) {
      return false;
    }
    requestCooldownUntil = Date.now() + REQUEST_COOLDOWN;
    try {
      const actor = browser.browsingContext?.currentWindowGlobal?.getActor(
        "PictureInPictureLauncher"
      );
      if (!actor) {
        return false;
      }
      actor.sendAsyncMessage?.("PictureInPicture:AutoToggle");
      // Asked for or not, that player exists because the tab was left, so it is
      // this mod's to fold away when the tab comes back.
      autoPipped.add(browser);
      trace("asked a tab for its own player");
      watchFloated();
      return true;
    } catch (err) {
      log("could not ask for a player on leaving Zen", err);
      return false;
    }
  };

  /**
   * The tab in front, asked for a player. The platform only pips a tab that got
   * hidden, so this covers the case of leaving Zen while the video's own tab is
   * the one being looked at, and it is also how a mirrored video becomes a
   * standard player window once the browser is in the background.
   */
  const requestFromSelectedTab = (browser = null, wanted = false) => {
    // `wanted` is for a video the widget was showing: leaving the browser always
    // hands it to the standard player, whatever the pop-out setting says.
    if (!wanted && !pref(INLINE_PREF, false)) {
      return;
    }
    askForPlayer(browser ?? window.gBrowser?.selectedBrowser);
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
        schedule(look, 120);
      }
    };
    schedule(look, 120);
  };

  /** The window lost focus: ask the tab in front for a player, once. */
  const onLeftZen = () => {
    // Outside the browser the video is picture-in-picture again, and the standard
    // one: the panel stops and the platform's own player opens for that tab,
    // with its remembered size, place and edge untouched.
    if (mirrorBrowser || pendingBrowser) {
      if (!appInBackground()) {
        // Another window of ours took focus, a player window most of all. The
        // browser is still the thing being looked at, so the panel stays.
        return;
      }
      const browser = mirrorBrowser ?? null;
      if (browser) {
        lastMirrored = browser;
        // A paused video is not one the platform would ever have pip'd, so it is
        // left alone: nothing floats over the other application, and the widget
        // has the video again the moment the browser comes back.
        const playing = !mirrorState.paused;
        stopMirror("the browser went to the background");
        if (playing) {
          requestFromSelectedTab(browser, true);
        }
        return;
      }
      abandonPending("the browser went to the background");
      return;
    }
    if (floatedWindow && !floatedWindow.closed) {
      return;
    }
    // A player may already be on screen, at its remembered place or tucked into an
    // edge. Asking the tab again would open a second one on top of it, which
    // reads as the browser "switching to normal picture-in-picture" the moment
    // another application comes forward. Keep the player that is there, and keep
    // it the one that folds away when the browser comes back.
    const open = Services.wm.getMostRecentWindow("Toolkit:PictureInPicture");
    if (open && !open.closed) {
      const api = pipApi();
      const browser = api?.weakWinToBrowser?.get?.(open) ?? null;
      // Only a player the tab's own departure produced is this mod's to fold
      // away. One the user asked for by hand stays theirs.
      const automatic =
        !!browser &&
        (autoPipped.has(browser) || !!api?.weakAutoPipBrowserToParent?.has?.(browser));
      if (automatic) {
        floatedWindow = open;
        trace("a player was already open; it is the one that folds away on return");
      }
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
  // The tabs whose player the platform opened because the tab was hidden. Those
  // are the ones that go away again when the tab comes back.
  const autoPipped = new WeakSet();

  const browserOf = (wgp) => {
    try {
      return wgp?.browsingContext?.top?.embedderElement ?? null;
    } catch (err) {
      return null;
    }
  };

  /** The player window the platform opened for this tab, if any. */
  const playerFor = (browser) => {
    const api = pipApi();
    if (!api?.weakWinToBrowser?.get) {
      return null;
    }
    try {
      for (const win of Services.wm.getEnumerator("Toolkit:PictureInPicture")) {
        if (api.weakWinToBrowser.get(win) === browser && !win.closed) {
          return win;
        }
      }
    } catch (err) {
      // No player windows to look at.
    }
    return null;
  };

  /**
   * Going back to the tab a hidden tab's player came from puts the video back in
   * the page. Firefox does this itself, but only for the windows it registered
   * as caught by a tab switch, and that registration depends on the tab's
   * docshell being inactive at the moment the player opened. Anything that wakes
   * the docshell first silently loses the behaviour: the player simply stays
   * where it is and the video never returns. So the mod keeps its own note of
   * which tabs it saw a player taken from, and closes that player when the tab
   * is selected again. A player asked for by hand is left alone, because it was
   * not the tab walking away that opened it.
   */
  const closeForForegroundTab = () => {
    try {
      for (const win of Services.wm.getEnumerator("Toolkit:PictureInPicture")) {
        const api = pipApi();
        const browser = api?.weakWinToBrowser?.get?.(win);
        if (!browser || !autoPipped.has(browser)) {
          continue;
        }
        if (!isForegroundTab(browser)) {
          continue;
        }
        autoPipped.delete(browser);
        if (browser.docShellIsActive) {
          releaseDocShell(api, browser);
        }
        closeFloated(win);
      }
    } catch (err) {
      log("could not fold the player for the foregrounded tab", err);
    }
  };

  /**
   * Fold the player that exists because a tab was left, whoever opened it.
   *
   * Only a player the platform or this mod produced from that tab is folded: one
   * the user asked for by hand is theirs and stays where it is.
   */
  const foldPlayerFor = (browser) => {
    const win = playerFor(browser);
    if (!win) {
      return;
    }
    const api = pipApi();
    const ours =
      autoPipped.has(browser) || !!api?.weakAutoPipBrowserToParent?.has?.(browser);
    if (!ours) {
      return;
    }
    autoPipped.delete(browser);
    if (floatedWindow === win) {
      floatedWindow = null;
    }
    trace("folding the player for the tab the widget is about to show");
    closeFloated(win);
  };

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
    // Coming back to Zen with the player's own tab in front folds that player too,
    // which is the same rule the tab strip applies.
    closeForForegroundTab();
    // A player the platform opened while the browser was in the background gives
    // way to the widget again: the video is in another tab, so it is mirrored.
    const previous = lastMirrored;
    lastMirrored = null;
    if (previous && !previous.closed) {
      // In front, that video belongs in the widget: the player opened for it
      // while the browser was away is done, and the panel has it again.
      foldPlayerFor(previous);
      if (!isForegroundTab(previous)) {
        armMirror(previous);
      }
    }
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
    schedule(() => {
      // Closed by the player itself, through return to tab or the close button,
      // before the fold got there: nothing left to do.
      if (!win.closed) {
        closeFloated(win);
      }
    }, FOLD_DELAY);
  };

  const onBrowserPref = (subject, topic, name) => {
    if (topic !== "nsPref:changed") return;
    if (name === WIDGET_PREF && !pref(WIDGET_PREF, true)) {
      fallBackToPlayer("the sidebar preview was disabled");
    }
    if (name === TRACE_PREF) {
      if (cardWatchTimer) clearInterval(cardWatchTimer);
      cardWatchTimer = null;
      startCardWatch();
    }
    if (name === IGNORE_PREF) {
      // The list is live: a domain added to it takes the video off the screen
      // rather than waiting for the next tab change.
      if (mirrorBrowser && ignoredTab(mirrorBrowser)) {
        stopMirror("its domain was added to the ignored list");
      }
      if (pendingBrowser && ignoredTab(pendingBrowser)) {
        abandonPending("its domain is ignored", false);
      }
    }
    if (name === FPS_PREF) {
      for (const actor of [mirrorActor, pendingActor]) {
        try {
          actor?.sendAsyncMessage("PipMirror:Configure", { fps: previewFPS() });
        } catch (err) {
          // A navigating tab will receive the setting when its next preview starts.
        }
      }
    }
  };

  setupMirror();
  lastSelected = window.gBrowser?.selectedBrowser ?? null;
  installPipHook();
  startCardWatch();
  Services.prefs.addObserver(WIDGET_PREF, onBrowserPref);
  Services.prefs.addObserver(IGNORE_PREF, onBrowserPref);
  Services.prefs.addObserver(TRACE_PREF, onBrowserPref);
  Services.prefs.addObserver(FPS_PREF, onBrowserPref);

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
    if (destroyed) return;
    destroyed = true;
    for (const id of timers) clearTimeout(id);
    timers.clear();
    for (const [win, onLoad] of loadingWindows) {
      win.removeEventListener("load", onLoad);
    }
    loadingWindows.clear();
    teardownMirror();
    Services.prefs.removeObserver(WIDGET_PREF, onBrowserPref);
    Services.prefs.removeObserver(IGNORE_PREF, onBrowserPref);
    Services.prefs.removeObserver(TRACE_PREF, onBrowserPref);
    Services.prefs.removeObserver(FPS_PREF, onBrowserPref);
    releasePanelRoom();
    if (cardWatchTimer) {
      clearInterval(cardWatchTimer);
      cardWatchTimer = null;
    }
    try {
      Services.ww.unregisterNotification(observer);
    } catch (err) {
      log("could not unregister the window observer", err);
    }
    const strip = window.gBrowser?.tabContainer;
    strip?.removeEventListener("TabSelect", onTabSelect);
    strip?.removeEventListener("TabClose", onTabClose);
    if (strip) delete strip[KEYS_FLAG];
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
    const shared = api?.__pipTuckAwayState;
    shared?.handlers.delete(window);
    if (shared && !shared.handlers.size) {
      if (api.handlePictureInPictureRequest === shared.wrapped) {
        api.handlePictureInPictureRequest = shared.original;
      }
      delete api.__pipTuckAwayState;
      for (const win of Services.wm.getEnumerator("Toolkit:PictureInPicture")) {
        win.__pipTuckAway?.destroy?.();
      }
    }
    delete window.PipMirror;
    delete window.__pipTuckAwayBrowser;
  };

  if (typeof window.addUnloadListener === "function") {
    window.addUnloadListener(unload);
  } else {
    window.addEventListener("unload", unload, { once: true });
  }
})();
