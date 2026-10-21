// Headless harness for pip-tuck-away.uc.js: the browser-window half.
import fs from "node:fs";
import vm from "node:vm";

const CODE = fs.readFileSync(process.argv[2], "utf8");
const PLAYER_URL = "chrome://global/content/pictureinpicture/player.xhtml";
const PLAYER_SCRIPT = "chrome://sine/content/pip-tuck-away/scripts/pip-player.uc.js";

function mk(prefsIn = {}, opts = {}) {
  const wwObservers = [];
  const winEvents = Object.create(null);
  const loads = [];
  const destroys = [];
  const toggles = [];
  let unloadListener = null;
  const files = new Map();
  const intervals = [];
  const prefObservers = [];

  const prefs = { ...prefsIn };

  const BRIDGE_PATH = "C:/AppData/Local/pip-tuck-away/toggle.json";

  const pipWindow = (href = PLAYER_URL, env = {}) => {
    const { fireLoad = true, documentReady = true } = env;
    const listeners = Object.create(null);
    const w = {
      location: { href },
      closed: false,
      document: documentReady ? { documentElement: {} } : undefined,
      // A freshly opened chrome window fires load on its own; the script waits
      // for it, so deliver it as soon as the listener is attached.
      addEventListener(type, fn) {
        (listeners[type] ||= []).push(fn);
        if (type === "load" && fireLoad) fn();
      },
      removeEventListener(type, fn) {
        listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
      },
      listeners,
    };
    Object.defineProperty(w, "__pipTuckAway", {
      get: () => w._api,
      set: (v) => {
        w._api = v;
      },
      configurable: true,
    });
    return w;
  };

  const browserWindow = (href = "chrome://browser/content/browser.xhtml") => {
    const listeners = Object.create(null);
    return {
      location: { href },
      closed: false,
      document: { documentElement: {} },
      addEventListener(type, fn) {
        (listeners[type] ||= []).push(fn);
      },
      removeEventListener(type, fn) {
        listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
      },
      listeners,
    };
  };

  const windows = [pipWindow(), browserWindow()];

  // Fake picture-in-picture module plus the windows it would create.
  const pipCalls = [];
  const closedWindows = [];
  const closedSingle = [];
  const pipWindows = [];
  const deferred = [];
  // The platform's own maps: which window belongs to which browser, and which
  // browser was auto-pipped and through which actor.
  const weakWinToBrowser = new WeakMap();
  const weakAutoPipBrowserToParent = new WeakMap();
  let focused = opts.focused ?? true;
  const pipModule = {
    PictureInPicture: {
      weakWinToBrowser,
      weakAutoPipBrowserToParent,
      async handlePictureInPictureRequest(wgp, videoData) {
        pipCalls.push({ wgp, videoData });
        const browser = wgp?.browsingContext?.top?.embedderElement;
        const win = pipWindows[0] ?? null;
        if (browser && win) {
          weakWinToBrowser.set(win, browser);
          weakAutoPipBrowserToParent.set(browser, { actor: "ref" });
        }
        return undefined;
      },
      async closePipWindow(win) {
        closedWindows.push(win);
        win.closed = true;
      },
      // Mimics the platform: clears its maps and puts the docshell back.
      async closeSinglePipWindow({ reason, actorRef }) {
        closedSingle.push({ reason, actorRef });
        const win = pipWindows[0] ?? null;
        if (!win) {
          return;
        }
        const browser = weakWinToBrowser.get(win);
        weakAutoPipBrowserToParent.delete(browser);
        closedWindows.push(win);
        win.closed = true;
        const tabbrowser = browser?.getTabBrowser?.();
        if (browser && tabbrowser && !tabbrowser.shouldActivateDocShell?.(browser)) {
          browser.docShellIsActive = false;
        }
      },
    },
  };

  const mediaCardElement = { hidden: false };
  const dockSpacers = [];
  const dockControls = { className: "zen-media-controls-hbox" };
  const dockMain = {
    _spacer: null,
    querySelector(sel) {
      if (sel === ".pip-tuck-away-dock") return this._spacer;
      if (sel === ".zen-media-controls-hbox") return dockControls;
      return null;
    },
    insertBefore(node) {
      this._spacer = node;
      dockSpacers.push(node);
      return node;
    },
  };
  const dockCardEl = {
    hidden: false,
    getBoundingClientRect: () => ({ left: 20, top: 400, width: 300, height: 200, right: 320, bottom: 600 }),
    querySelector(sel) {
      if (sel === ".zen-media-main-vbox") return dockMain;
      if (sel === ".zen-media-title") return { textContent: "Video" };
      return null;
    },
  };
  const cardMode = opts.mediaCard ?? "absent";
  // "shown" is a card on screen; "tiny" is one in a collapsed sidebar, "offscreen"
  // is one a sliding sidebar has carried out of the viewport.
  const cardRect = {
    shown: { left: 40, top: 120, width: 300, height: 120, right: 340, bottom: 240 },
    tiny: { left: 40, top: 120, width: 0, height: 0, right: 40, bottom: 120 },
    offscreen: { left: -400, top: 120, width: 300, height: 120, right: -100, bottom: 240 },
  }[cardMode] ?? { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  const mediaBar = {
    hidden: cardMode === "absent",
    offsetParent: cardMode === "absent" || cardMode === "tiny" ? null : {},
    getBoundingClientRect: () => opts.barRect ?? cardRect,
    hasAttribute(name) {
      return name === "hidden" ? cardMode === "absent" : false;
    },
    querySelector(sel) {
      return sel.includes("zen-media-card") && cardMode !== "absent" ? mediaCardElement : null;
    },
    querySelectorAll(sel) {
      return sel.includes("zen-media-card") && cardMode !== "absent" && opts.dockCard ? [dockCardEl] : [];
    },
  };

  const traces = new Map();
  const launcherMessages = [];
  const selected = {
    audioMuted: opts.muted ?? false,
    browsingContext: {
      currentWindowGlobal: {
        getActor: (name) =>
          name === "PictureInPictureLauncher"
            ? { sendAsyncMessage: (msg) => launcherMessages.push(msg) }
            : null,
      },
    },
  };

  const window = {
    innerWidth: 1920,
    innerHeight: 1080,
    location: { href: "chrome://browser/content/browser.xhtml" },
    gBrowser: { selectedBrowser: selected },
    document: {
      hasFocus: () => focused,
      querySelector: (sel) => (sel === "#zen-media-controls-toolbar" ? mediaBar : null),
      querySelectorAll: (sel) =>
        sel === ".pip-tuck-away-dock" ? dockSpacers.slice() : [],
      createElementNS: (_ns, tag) => ({
        tagName: tag,
        className: "",
        style: { height: "" },
        setAttribute() {},
        getBoundingClientRect() {
          const height = parseFloat(this.style.height) || 0;
          return { left: 20, top: 460, width: 288, height, right: 308, bottom: 460 + height };
        },
      }),
    },
    mozInnerScreenX: opts.screenX ?? 0,
    mozInnerScreenY: opts.screenY ?? 0,
    addEventListener(type, fn) {
      (winEvents[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      winEvents[type] = (winEvents[type] || []).filter((f) => f !== fn);
    },
    addUnloadListener(fn) {
      unloadListener = fn;
    },
  };

  const sandbox = {
    window,
    Services: {
      prefs: {
        getPrefType: (k) => (k in prefs ? 128 : 0),
        getBoolPref: (k, fallback = false) => (k in prefs ? !!prefs[k] : fallback),
        addObserver: (name, fn) => prefObservers.push({ name, fn }),
        removeObserver: (name, fn) => {
          const i = prefObservers.findIndex((o) => o.name === name && o.fn === fn);
          if (i >= 0) prefObservers.splice(i, 1);
        },
      },
      dirsvc: {
        get() {
          return {
            _parts: ["C:/AppData/Local"],
            append(name) {
              this._parts.push(name);
            },
            get path() {
              return this._parts.join("/");
            },
          };
        },
      },
      ww: {
        registerNotification: (obs) => wwObservers.push(obs),
        unregisterNotification: (obs) => {
          const i = wwObservers.indexOf(obs);
          if (i >= 0) wwObservers.splice(i, 1);
        },
      },
      wm: {
        getEnumerator: () => windows,
        getMostRecentWindow: (type) =>
          type === "Toolkit:PictureInPicture"
            ? pipWindows.find((w) => !w.closed) ??
              windows.find((w) => w.location?.href === PLAYER_URL) ??
              null
            : windows[0] ?? null,
      },
      scriptloader: {
        loadSubScript(url, win) {
          loads.push({ url, win });
          win.__pipTuckAway = {
            toggle: (...a) => toggles.push(a),
            destroy: () => destroys.push(win),
          };
        },
      },
    },
    ChromeUtils: { importESModule: () => pipModule },
    Components: { interfaces: { nsIFile: "nsIFile" } },
    IOUtils: {
      async exists(path) {
        return files.has(path) || traces.has(path);
      },
      async readUTF8(path) {
        if (!files.has(path)) throw new Error("missing");
        return files.get(path);
      },
      async stat(path) {
        return { size: (traces.get(path) ?? "").length };
      },
      async writeUTF8(path, text) {
        traces.set(path, (traces.get(path) ?? "") + text);
      },
      async remove(path) {
        traces.delete(path);
      },
    },
    setInterval: (fn) => {
      intervals.push(fn);
      return intervals.length;
    },
    clearInterval: (id) => {
      intervals[id - 1] = null;
    },
    setTimeout: (fn) => {
      if (opts.deferTimers) {
        deferred.push(fn);
        return deferred.length;
      }
      fn();
      return 0;
    },
    console,
    Object,
    Error,
    JSON,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox);

  const fire = (type, event = {}) => {
    event.preventDefault ??= () => {
      event.prevented = true;
    };
    event.stopPropagation ??= () => {
      event.stopped = true;
    };
    for (const fn of [...(winEvents[type] || [])]) fn(event);
    return event;
  };

  return {
    window,
    loads,
    toggles,
    destroys,
    windows,
    prefs,
    pipWindow,
    key: (event) => fire("keydown", event),
    openWindow(win) {
      for (const obs of wwObservers) obs.observe(win, "domwindowopened");
    },
    otherTopic(win, topic) {
      for (const obs of wwObservers) obs.observe(win, topic);
    },
    unload: () => unloadListener?.(),
    observerCount: () => wwObservers.length,
    emit(type, event = {}) {
      event.preventDefault ??= () => {};
      event.stopPropagation ??= () => {};
      for (const fn of [...(winEvents[type] || [])]) fn(event);
      return event;
    },
    pipCalls,
    dockSpacers,
    traces: () => [...traces.entries()].map(([p, s]) => s).join(""),
    closedWindows,
    closedSingle,
    launcherMessages,
    selected,
    weakWinToBrowser,
    weakAutoPipBrowserToParent,
    pipWindows,
    runTimers: () => {
      while (deferred.length) {
        deferred.shift()();
      }
    },
    pipApi: () => pipModule.PictureInPicture,
    setFocus: (v) => {
      focused = v;
    },
    files,
    intervals,
    bridgePath: BRIDGE_PATH,
    browserWindow,
    /** Deliver any event to a specific chrome window. */
    fireOn(win, type, event = {}) {
      for (const fn of [...(win.listeners?.[type] || [])]) fn(event);
      return event;
    },
    /** Deliver a key event to a specific chrome window. */
    keyOn(win, event) {
      event.preventDefault ??= () => {
        event.prevented = true;
      };
      event.stopPropagation ??= () => {
        event.stopped = true;
      };
      for (const fn of [...(win.listeners?.keydown || [])]) fn(event);
      return event;
    },
    setPref(name, value) {
      prefs[name] = value;
      for (const obs of [...prefObservers]) obs.fn({}, "nsPref:changed", name);
    },
    async tick() {
      for (const fn of [...intervals]) {
        if (fn) fn();
      }
      // Let the poller's awaits settle.
      for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
    },
  };
}

const results = [];
const check = (name, actual, expected) => {
  results.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual: JSON.stringify(actual), expected: JSON.stringify(expected) });
};

// 1. existing player windows are decorated on load
{
  const t = mk();
  check("existing player window decorated", t.loads.length, 1);
  check("player script url", t.loads[0]?.url, PLAYER_SCRIPT);
}

// 2. a new player window is decorated when it opens
{
  const t = mk();
  const fresh = t.pipWindow();
  t.windows.unshift(fresh);
  t.openWindow(fresh);
  check("new player window decorated", t.loads.length >= 2, true);
  check("decorated the new window", t.loads.at(-1)?.win, fresh);
}

// 3. a non-player window is ignored
{
  const t = mk();
  const other = t.pipWindow("chrome://browser/content/browser.xhtml");
  t.openWindow(other);
  check("non-player window ignored", t.loads.length, 1);
}

// 4. windows are decorated once
{
  const t = mk();
  const fresh = t.pipWindow();
  t.windows.unshift(fresh);
  t.openWindow(fresh);
  const before = t.loads.filter((l) => l.win === fresh).length;
  t.openWindow(fresh);
  check("no double decoration", t.loads.filter((l) => l.win === fresh).length, before);
}

// 5. only domwindowopened is acted on
{
  const t = mk();
  const fresh = t.pipWindow();
  t.windows.unshift(fresh);
  t.otherTopic(fresh, "domwindowclosed");
  check("other topics ignored", t.loads.filter((l) => l.win === fresh).length, 0);
}

// 6. ctrl+shift+t toggles and claims the chord
{
  const t = mk({ "pip-tuck-away.shortcut": true });
  const ev = t.key({ ctrlKey: true, altKey: true, code: "KeyT", key: "T", target: {} });
  check("toggle called", t.toggles.length, 1);
  check("chord prevented", ev.prevented, true);
  check("chord stopped", ev.stopped, true);
}

// 6b. ctrl+shift+t is the browser's reopen-closed-tab and is left alone
{
  const t = mk({ "pip-tuck-away.shortcut": true });
  const ev = t.key({ ctrlKey: true, shiftKey: true, code: "KeyT", key: "T", target: {} });
  check("the browser's chord ignored", t.toggles.length, 0);
  check("the browser's chord not prevented", ev.prevented, undefined);
}

// 6b2. an AltGr press is not the chord, even though it reports ctrl+alt
{
  const t = mk({ "pip-tuck-away.shortcut": true });
  const ev = t.key({
    ctrlKey: true,
    altKey: true,
    code: "KeyT",
    key: "T",
    getModifierState: (name) => name === "AltGraph",
    target: {},
  });
  check("AltGr is left to the layout", t.toggles.length, 0);
  check("AltGr not prevented", ev.prevented, undefined);
}

// 6c. the chord works from a second browser window
{
  const t = mk({ "pip-tuck-away.shortcut": true });
  const second = t.browserWindow();
  t.openWindow(second);
  const ev = t.keyOn(second, { ctrlKey: true, altKey: true, code: "KeyT", key: "T", target: {} });
  check("second window toggles", t.toggles.length, 1);
  check("second window claims the chord", ev.prevented, true);
}

// 6d. the chord works from the player window itself
{
  const t = mk({ "pip-tuck-away.shortcut": true });
  const ev = t.keyOn(t.windows[0], { ctrlKey: true, altKey: true, code: "KeyT", key: "T", target: {} });
  check("player window toggles", t.toggles.length, 1);
  check("player window claims the chord", ev.prevented, true);
}

// 6e. content windows are never given the listener
{
  const t = mk({ "pip-tuck-away.shortcut": true });
  const content = t.browserWindow("https://example.com/");
  t.openWindow(content);
  t.keyOn(content, { ctrlKey: true, altKey: true, code: "KeyT", key: "T", target: {} });
  check("content window ignored", t.toggles.length, 0);
}

// 6f. a window opened as about:blank gets the chord once its document loads
{
  const t = mk({ "pip-tuck-away.shortcut": true });
  const late = t.browserWindow("about:blank");
  t.openWindow(late);
  t.keyOn(late, { ctrlKey: true, altKey: true, code: "KeyT", key: "T", target: {} });
  check("blank window has no chord yet", t.toggles.length, 0);
  late.location.href = "chrome://browser/content/browser.xhtml";
  t.fireOn(late, "load");
  t.keyOn(late, { ctrlKey: true, altKey: true, code: "KeyT", key: "T", target: {} });
  check("window gets the chord after load", t.toggles.length, 1);
}

// 7. no player window: the chord is left alone
{
  const t = mk({ "pip-tuck-away.shortcut": true });
  t.windows.length = 0;
  const ev = t.key({ ctrlKey: true, altKey: true, code: "KeyT", key: "T", target: {} });
  check("no toggle without a player", t.toggles.length, 0);
  check("chord not prevented", ev.prevented, undefined);
}

// 7b. with no player the chord is free for the browser's own reopen-tab
{
  const t = mk({ "pip-tuck-away.shortcut": true });
  t.windows.length = 0;
  const ev = t.key({ ctrlKey: true, altKey: true, code: "KeyT", key: "T", target: {} });
  check("reopen-tab chord untouched", ev.prevented, undefined);
}

// 8. shortcut pref off
{
  const t = mk({ "pip-tuck-away.shortcut": false });
  const ev = t.key({ ctrlKey: true, altKey: true, code: "KeyT", key: "T", target: {} });
  check("pref off: no toggle", t.toggles.length, 0);
  check("pref off: not prevented", ev.prevented, undefined);
}

// 9. typing in an editable field is left alone
{
  const t = mk({ "pip-tuck-away.shortcut": true });
  const ev = t.key({
    ctrlKey: true,
    shiftKey: true,
    code: "KeyT",
    key: "T",
    target: { nodeType: 1, localName: "input", isContentEditable: false },
  });
  check("editable field not intercepted", t.toggles.length, 0);
  check("editable field not prevented", ev.prevented, undefined);
}

// 10. other modifiers and other keys are ignored
{
  const t = mk({ "pip-tuck-away.shortcut": true });
  t.key({ ctrlKey: true, altKey: true, shiftKey: true, code: "KeyT", key: "T", target: {} });
  t.key({ ctrlKey: true, code: "KeyT", key: "T", target: {} });
  t.key({ ctrlKey: true, altKey: true, code: "KeyR", key: "R", target: {} });
  t.key({ ctrlKey: true, altKey: true, code: "KeyT", key: "T", repeat: true, target: {} });
  check("variants ignored", t.toggles.length, 0);
}

// 11. unload unregisters, detaches the keyboard and tears down player windows
{
  const t = mk({ "pip-tuck-away.shortcut": true });
  t.unload();
  check("observer unregistered", t.observerCount(), 0);
  check("player window destroyed", t.destroys.length, 1);
  t.keyOn(t.windows[0], { ctrlKey: true, altKey: true, code: "KeyT", key: "T", target: {} });
  check("no key handling after unload", t.toggles.length, 0);
}

// 12. auto tuck attaches before load, so the player is never seen untucked
{
  const t = mk({ "pip-tuck-away.auto-tuck": true });
  const early = t.pipWindow(PLAYER_URL, { fireLoad: false, documentReady: true });
  t.windows.unshift(early);
  t.openWindow(early);
  check("early attach decorated the player", t.loads.filter((l) => l.win === early).length, 1);
}

// 13. without auto tuck, a still-loading player is left for its load event
{
  const t = mk({ "pip-tuck-away.auto-tuck": false });
  const early = t.pipWindow(PLAYER_URL, { fireLoad: false, documentReady: true });
  t.windows.unshift(early);
  t.openWindow(early);
  check("no early attach without auto tuck", t.loads.filter((l) => l.win === early).length, 0);
}

const wgpFor = (active, opts = {}) => {
  const browser = {
    docShellIsActive: active,
    getTabBrowser: () => ({
      selectedBrowser: opts.selected === false ? {} : browser,
      shouldActivateDocShell: () => !!opts.wantsActive,
    }),
  };
  return { browsingContext: { top: { embedderElement: browser } }, browser };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

// 14. the request handler is wrapped on load
{
  const t = mk({ "pip-tuck-away.inline-in-zen": true }, { mediaCard: "shown" });
  check("request handler wrapped", !!t.pipApi().handlePictureInPictureRequest.__pipTuckAway, true);
}

// 16f. leaving Zen with the video's own tab selected asks the tab for a player
{
  const t = mk({ "pip-tuck-away.inline-in-zen": true }, { mediaCard: "shown" });
  t.windows.length = 0; // no player open yet
  t.emit("deactivate");
  await tick();
  check("asked the selected tab", t.launcherMessages, ["PictureInPicture:AutoToggle"]);
  check("nothing floated from a stale request", t.pipCalls.length, 0);
}

// 16g. no second ask while a player is open
{
  const t = mk({ "pip-tuck-away.inline-in-zen": true }, { mediaCard: "shown" });
  t.windows.length = 0;
  t.emit("deactivate");
  await tick();
  t.emit("blur");
  await tick();
  check("asked once", t.launcherMessages.length, 1);
}

// 16h. no ask when the feature is off, or the tab is muted
{
  const off = mk({ "pip-tuck-away.inline-in-zen": false });
  off.windows.length = 0;
  off.emit("deactivate");
  await tick();
  check("off: no ask", off.launcherMessages.length, 0);

  const muted = mk({ "pip-tuck-away.inline-in-zen": true }, { muted: true });
  muted.windows.length = 0;
  muted.emit("deactivate");
  await tick();
  check("muted tab: no ask", muted.launcherMessages.length, 0);
}

// 17. with the setting on, a tab switch opens the player on the first switch
//
// This is the whole point: the setting used to hold the request back on the
// theory that Zen's media card would drive the video, and a held request meant
// the first switch showed nothing at all while a later one produced a player.
{
  const t = mk({ "pip-tuck-away.inline-in-zen": true }, { mediaCard: "shown" });
  await t.pipApi().handlePictureInPictureRequest(wgpFor(false), { src: "video" });
  check("the first switch opens the player", t.pipCalls.length, 1);
}

// 17b. and nothing arrives late, whatever timers are pending
{
  const t = mk({ "pip-tuck-away.inline-in-zen": true }, { mediaCard: "shown", deferTimers: true });
  await t.pipApi().handlePictureInPictureRequest(wgpFor(false), { src: "video" });
  check("opened straight away", t.pipCalls.length, 1);
  t.runTimers();
  await tick();
  check("and nothing else opens afterwards", t.pipCalls.length, 1);
}

// 17c. the trace says the request was passed on rather than held
{
  const t = mk({ "pip-tuck-away.inline-in-zen": true }, { mediaCard: "shown" });
  await t.pipApi().handlePictureInPictureRequest(wgpFor(false), { src: "video" });
  await tick();
  check("the request is recorded as passed on", /=> passed to the platform/.test(t.traces()), true);
}

// 18. activating with no floated window does nothing
{
  const t = mk({ "pip-tuck-away.inline-in-zen": true }, { mediaCard: "shown" });
  t.emit("activate");
  await tick();
  check("no window to close", t.closedWindows.length, 0);
}

// 18b. deactivating asks the tab in front for a player, whether or not a card exists
{
  const forEachCard = async (mediaCard) => {
    const t = mk({ "pip-tuck-away.inline-in-zen": true }, { mediaCard });
    t.windows.length = 0; // no player open yet
    t.emit("deactivate");
    await tick();
    return t;
  };
  const shown = await forEachCard("shown");
  check("asks with a card on screen too", shown.launcherMessages.length, 1);
  const absent = await forEachCard("absent");
  check("asks with no card", absent.launcherMessages.length, 1);
}

// 19. an explicit request still opens the player
{
  const t = mk({ "pip-tuck-away.inline-in-zen": true }, { mediaCard: "shown" });
  await t.pipApi().handlePictureInPictureRequest(wgpFor(true), { src: "video" });
  check("explicit request passes through", t.pipCalls.length, 1);
}

// 20. the setting off leaves the auto path alone
{
  const t = mk({ "pip-tuck-away.inline-in-zen": false });
  await t.pipApi().handlePictureInPictureRequest(wgpFor(false), { src: "video" });
  check("auto request passes through when off", t.pipCalls.length, 1);
}

// 21. an unfocused browser asks the tab in front for its own player
{
  const t = mk({ "pip-tuck-away.inline-in-zen": true }, { focused: false, mediaCard: "shown" });
  await t.pipApi().handlePictureInPictureRequest(wgpFor(false), { src: "video" });
  check("unfocused browser passes through", t.pipCalls.length, 1);
}

const BAR_AT_BOTTOM = { left: 0, top: 900, width: 300, height: 80, right: 300, bottom: 980 };

// 23a. the player is docked into the media card's gap
{
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM });
  const calls = [];
  const undocks = [];
  t.windows[0].__pipTuckAway = {
    dock: (rect) => calls.push(rect),
    undock: () => undocks.push(true),
    isDocked: () => undocks.length === 0 && calls.length > 0,
    aspect: () => 16 / 9,
  };
  await t.tick();
  check("docked once", calls.length >= 1, true);
  // card at left 20, width 300 -> panel 288 wide and 162 tall at 16:9,
  // hanging above the bar's top edge (900) with a 6px inset.
  check("above the widget, at its width", calls[0], { x: 26, y: 732, width: 288, height: 162 });
  check("and nothing was added to the card", t.dockSpacers.length, 0);
  check("nothing was undocked", undocks.length, 0);
}

// 23b. the gap is stable while nothing moves
{
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM });
  const calls = [];
  t.windows[0].__pipTuckAway = {
    dock: (rect) => calls.push(rect),
    undock: () => {},
    isDocked: () => true,
    aspect: () => 4 / 3,
  };
  await t.tick();
  await t.tick();
  check("the same rectangle every time", JSON.stringify(calls[0]) === JSON.stringify(calls[1]), true);
  check("sized to the video's shape", calls[0].height, 216);
}

// 23c. the setting off means the player is a player
{
  const t = mk({ "pip-tuck-away.in-widget": false }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM });
  let undocked = 0;
  const calls = [];
  t.windows[0].__pipTuckAway = {
    dock: (rect) => calls.push(rect),
    undock: () => undocked++,
    isDocked: () => true,
    aspect: () => 16 / 9,
  };
  await t.tick();
  check("never docked", calls.length, 0);
  check("and taken out of the widget", undocked >= 1, true);
}

// 23d. no card on screen means no dock
{
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "absent", dockCard: true, barRect: BAR_AT_BOTTOM });
  let undocked = 0;
  const calls = [];
  t.windows[0].__pipTuckAway = {
    dock: (rect) => calls.push(rect),
    undock: () => undocked++,
    isDocked: () => true,
    aspect: () => 16 / 9,
  };
  await t.tick();
  check("the player comes out", undocked >= 1, true);
}

// 22. unload puts the original handler back
{
  const t = mk({ "pip-tuck-away.inline-in-zen": true }, { mediaCard: "shown" });
  t.unload();
  check("handler restored on unload", !!t.pipApi().handlePictureInPictureRequest.__pipTuckAway, false);
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  got ${r.actual} want ${r.expected}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
