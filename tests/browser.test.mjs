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
      close() {
        w.closed = true;
      },
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
  const mirrorNodes = Object.create(null);
  const makeElement = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(),
      id: "",
      className: "",
      title: "",
      style: {},
      attrs: {},
      children: [],
      parent: null,
      listeners: {},
      width: 0,
      height: 0,
      painted: null,
      append(...kids) {
        for (const kid of kids) {
          kid.parent = node;
          node.children.push(kid);
        }
      },
      remove() {
        if (node.parent) {
          node.parent.children = node.parent.children.filter((c) => c !== node);
          node.parent = null;
        }
        if (node.id) delete mirrorNodes[node.id];
      },
      setAttribute(name, value) {
        node.attrs[name] = String(value);
        if (name === "id") {
          node.id = String(value);
          mirrorNodes[node.id] = node;
        }
        if (name === "class") node.className = String(value);
      },
      getAttribute(name) {
        return node.attrs[name] ?? null;
      },
      hasAttribute(name) {
        return name in node.attrs;
      },
      removeAttribute(name) {
        delete node.attrs[name];
      },
      toggleAttribute(name, on) {
        if (on) node.attrs[name] = "";
        else delete node.attrs[name];
      },
      addEventListener(type, fn) {
        (node.listeners[type] ||= []).push(fn);
      },
      fire(type, event = {}) {
        for (const fn of [...(node.listeners[type] || [])]) fn(event);
      },
      get firstElementChild() {
        return node.children[0] ?? null;
      },
      getContext() {
        return {
          putImageData: (data) => {
            node.painted = data;
          },
        };
      },
      querySelector(selector) {
        return find(node, String(selector).trim().split(/\s+/));
      },
      querySelectorAll: () => [],
    };
    return node;
  };

  const matchesPart = (node, part) => {
    const tag = part.match(/^[a-zA-Z]+/)?.[0]?.toUpperCase();
    const id = part.match(/#([\w-]+)/)?.[1];
    const cls = part.match(/\.([\w-]+)/)?.[1];
    if (tag && node.tagName !== tag) return false;
    if (id && node.id !== id) return false;
    if (cls && !String(node.className).split(/\s+/).includes(cls)) return false;
    return true;
  };

  const findById = (root, id) => {
    for (const kid of root?.children ?? []) {
      if (kid.id === id) return kid;
      const deeper = findById(kid, id);
      if (deeper) return deeper;
    }
    return null;
  };

  const find = (root, parts) => {
    const [head, ...rest] = parts;
    for (const kid of root.children) {
      if (matchesPart(kid, head)) {
        if (rest.length === 0) return kid;
        const deeper = find(kid, rest);
        if (deeper) return deeper;
      }
      const inside = find(kid, parts);
      if (inside) return inside;
    }
    return null;
  };

  const substitutions = Object.create(null);
  const registeredActors = Object.create(null);
  const Cc = {
    "@mozilla.org/chrome/chrome-registry;1": {
      getService: () => ({ convertChromeURL: (uri) => ({ spec: uri.spec }) }),
    },
  };
  const Ci = { nsIChromeRegistry: 1, nsIFile: 1, nsIResProtocolHandler: 1 };

  const tabStrip = {
    _events: {},
    addEventListener(type, fn) {
      (this._events[type] ||= []).push(fn);
    },
    fire(type, target = {}) {
      for (const fn of [...(this._events[type] || [])]) fn({ type, target });
    },
  };
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
    rect: { left: 20, top: 400, width: 300, height: 200, right: 320, bottom: 600 },
    getBoundingClientRect() {
      return this.rect;
    },
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
    children: [],
    append(node) {
      node.parent = mediaBar;
      mediaBar.children.push(node);
    },
    style: {
      props: {},
      setProperty(k, v) {
        this.props[k] = v;
      },
      removeProperty(k) {
        delete this.props[k];
      },
      getPropertyValue(k) {
        return this.props[k] ?? "";
      },
    },
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
    gBrowser: { selectedBrowser: selected, tabContainer: tabStrip },
    document: {
      hasFocus: () => focused,
      querySelector: (sel) => (sel === "#zen-media-controls-toolbar" ? mediaBar : null),
      querySelectorAll: (sel) =>
        sel === ".pip-tuck-away-dock" ? dockSpacers.slice() : [],
      getElementById: (id) => findById(mediaBar, id),
      createElementNS: (_ns, tag) => makeElement(tag),
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
      io: {
        newURI: (spec) => ({ spec }),
        newFileURI: (file) => ({ spec: `file:///${file.path ?? "mod"}/` }),
        getProtocolHandler: () => ({
          QueryInterface: () => ({
            hasSubstitution: () => false,
            setSubstitution: (name, uri) => {
              substitutions[name] = uri;
            },
          }),
        }),
      },
      focus: {
        get activeWindow() {
          // A player window of ours, another application, or nothing at all.
          if (opts.frontWithApp === "player") {
            return pipWindows[0] ?? windows[0] ?? null;
          }
          return opts.frontWithApp === false || focused === false ? null : window;
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
    ChromeUtils: {
      importESModule: () => pipModule,
      registerWindowActor: (name, spec) => {
        registeredActors[name] = spec;
      },
      unregisterWindowActor: (name) => {
        delete registeredActors[name];
      },
    },
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
        deferred.push({ fn, cancelled: false });
        return deferred.length;
      }
      fn();
      return 0;
    },
    clearTimeout: (id) => {
      const entry = deferred[id - 1];
      if (entry) entry.cancelled = true;
    },
    console,
    Object,
    Error,
    JSON,
    Cc,
    Ci,
    Components: {
      interfaces: { nsIFile: "nsIFile" },
      stack: { filename: "chrome://sine/content/pip-tuck-away/scripts/pip-tuck-away.uc.js" },
    },
    ImageData: class {
      constructor(data, width, height) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    },
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
    tabStrip,
    select(browser) {
      window.gBrowser.selectedBrowser = browser;
      browser.getTabBrowser = () => ({
        selectedBrowser: browser,
        shouldActivateDocShell: () => false,
      });
    },
    barStyle: mediaBar.style,
    dockCardEl,
    mirrorNodes,
    registeredActors,
    substitutions,
    controller: () => window.PipMirror,
    mirror: () => window.document.getElementById("pip-tuck-away-mirror"),
    setFront(on) {
      opts.frontWithApp = on;
    },
    weakWinToBrowser,
    weakAutoPipBrowserToParent,
    pipWindows,
    runTimers: () => {
      while (deferred.length) {
        const entry = deferred.shift();
        if (!entry.cancelled) entry.fn();
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
  const context = { id: opts.bcId ?? 42, top: { embedderElement: browser } };
  const launcher = [];
  context.currentWindowGlobal = {
    getActor: (name) => {
      if (name === "PipMirror") return opts.actor ?? mirrorActor;
      if (name === "PictureInPictureLauncher") {
        return { sendAsyncMessage: (msg) => launcher.push(msg) };
      }
      return null;
    },
  };
  browser.browsingContext = context;
  return { browsingContext: context, browser, launcher };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

/** The actor a mirrored tab talks through, and what it was told. */
const mirrorActor = {
  sent: [],
  sendAsyncMessage(name, data) {
    mirrorActor.sent.push({ name, data });
  },
};

// 14. the request handler is wrapped on load
{
  const t = mk({ "pip-tuck-away.inline-in-zen": true, "pip-tuck-away.in-widget": false }, { mediaCard: "shown" });
  check("request handler wrapped", !!t.pipApi().handlePictureInPictureRequest.__pipTuckAway, true);
}

// 16f. leaving Zen with the video's own tab selected asks the tab for a player
{
  const t = mk({ "pip-tuck-away.inline-in-zen": true, "pip-tuck-away.in-widget": false }, { mediaCard: "shown" });
  t.windows.length = 0; // no player open yet
  t.emit("deactivate");
  await tick();
  check("asked the selected tab", t.launcherMessages, ["PictureInPicture:AutoToggle"]);
  check("nothing floated from a stale request", t.pipCalls.length, 0);
}

// 16g. no second ask while a player is open
{
  const t = mk({ "pip-tuck-away.inline-in-zen": true, "pip-tuck-away.in-widget": false }, { mediaCard: "shown" });
  t.windows.length = 0;
  t.emit("deactivate");
  await tick();
  t.emit("blur");
  await tick();
  check("asked once", t.launcherMessages.length, 1);
}

// 16h. no ask when the feature is off, or the tab is muted
{
  const off = mk({ "pip-tuck-away.inline-in-zen": false, "pip-tuck-away.in-widget": false });
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
  const t = mk({ "pip-tuck-away.inline-in-zen": true, "pip-tuck-away.in-widget": false }, { mediaCard: "shown" });
  await t.pipApi().handlePictureInPictureRequest(wgpFor(false), { src: "video" });
  check("the first switch opens the player", t.pipCalls.length, 1);
}

// 17b. and nothing arrives late, whatever timers are pending
{
  const t = mk({ "pip-tuck-away.inline-in-zen": true, "pip-tuck-away.in-widget": false }, { mediaCard: "shown", deferTimers: true });
  await t.pipApi().handlePictureInPictureRequest(wgpFor(false), { src: "video" });
  check("opened straight away", t.pipCalls.length, 1);
  t.runTimers();
  await tick();
  check("and nothing else opens afterwards", t.pipCalls.length, 1);
}

// 17c. the trace says what happened to the request
{
  const t = mk({ "pip-tuck-away.inline-in-zen": true, "pip-tuck-away.in-widget": true }, { mediaCard: "shown", deferTimers: true });
  await t.pipApi().handlePictureInPictureRequest(wgpFor(false), { src: "video" });
  await tick();
  check("the request is recorded as mirrored", /mirror: the widget shows the video/.test(t.traces()), true);
}

// 18. activating with no floated window does nothing
{
  const t = mk({ "pip-tuck-away.inline-in-zen": true, "pip-tuck-away.in-widget": false }, { mediaCard: "shown" });
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
  const t = mk({ "pip-tuck-away.inline-in-zen": true, "pip-tuck-away.in-widget": false }, { mediaCard: "shown" });
  await t.pipApi().handlePictureInPictureRequest(wgpFor(true), { src: "video" });
  check("explicit request passes through", t.pipCalls.length, 1);
}

// 20. the setting off leaves the auto path alone
{
  const t = mk({ "pip-tuck-away.inline-in-zen": false, "pip-tuck-away.in-widget": false });
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
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
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
  // card at left 20, width 300 -> panel 288 wide and 162 tall at 16:9, sitting
  // inside the widget's own box, 6px in from its top edge (900).
  check("inside the widget, at its width", calls[0], { x: 26, y: 232, width: 288, height: 162 });
  check("and nothing was added to the card", t.dockSpacers.length, 0);
  // 162 for the panel, 6px above and below it, and the card's own hover growth
  // (200 - the 80px it already had) capped at 96.
  check("room is made in the widget itself", t.barStyle.props["--zen-media-collapsed-height"], "calc(80px + 270px)");
  check("nothing was undocked", undocks.length, 0);
}

// 23b. the gap is stable while nothing moves
{
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
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
  check("the room is given back", t.barStyle.props["--zen-media-collapsed-height"], undefined);
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
  check("the room is given back", t.barStyle.props["--zen-media-collapsed-height"], undefined);
}

// 26. coming back to the tab the player came from puts the video back
{
  const t = mk({ "pip-tuck-away.in-widget": false });
  t.pipWindows.push(t.windows[0]); // the platform's registry of player windows
  const wgp = wgpFor(false); // the docshell is inactive: the automatic path
  await t.pipApi().handlePictureInPictureRequest(wgp, {});
  check("a player was opened", t.windows[0].closed, false);
  t.select(wgp.browser);
  t.tabStrip.fire("TabSelect");
  await tick();
  await tick();
  check("selecting that tab closes it", t.windows[0].closed, true);
}

// 26b. any other tab leaves the player alone
{
  const t = mk({});
  t.pipWindows.push(t.windows[0]);
  const wgp = wgpFor(false, { selected: false }); // the player's tab is in the background
  await t.pipApi().handlePictureInPictureRequest(wgp, {});
  t.tabStrip.fire("TabSelect"); // another tab came forward
  await tick();
  await tick();
  check("still open", t.windows[0].closed, false);
}

// 26c. a player asked for by hand is not the tab walking away
{
  const t = mk({});
  t.pipWindows.push(t.windows[0]);
  const wgp = wgpFor(true); // docshell active and selected: a real PiP press
  await t.pipApi().handlePictureInPictureRequest(wgp, {});
  t.select(wgp.browser);
  t.tabStrip.fire("TabSelect");
  await tick();
  await tick();
  check("left alone", t.windows[0].closed, false);
}

// 23e. the panel leaves the widget when the application goes to the background
{
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  const calls = [];
  const undocks = [];
  t.windows[0].__pipTuckAway = {
    dock: (rect) => calls.push(rect),
    undock: () => undocks.push(true),
    isDocked: () => undocks.length === 0 && calls.length > 0,
    aspect: () => 16 / 9,
  };
  await t.tick();
  check("embedded while the browser is in front", calls.length >= 1, true);
  t.setFront(false); // another application came forward
  await t.tick();
  check("and handed back as a real player", undocks.length, 1);
  check("the room is given back", t.barStyle.props["--zen-media-collapsed-height"], undefined);
  t.setFront(true); // the browser comes back
  await t.tick();
  check("it is embedded again", calls.length >= 2, true);
  check("with the room made again", t.barStyle.props["--zen-media-collapsed-height"] !== undefined, true);
}

// 23f. a player that is already open is never doubled up
{
  const t = mk({ "pip-tuck-away.inline-in-zen": true, "pip-tuck-away.in-widget": false }, { mediaCard: "shown" });
  t.pipWindows.push(t.windows[0]); // the platform's registry of player windows
  const wgp = wgpFor(false, { selected: false }); // the tab's own departure opened it
  await t.pipApi().handlePictureInPictureRequest(wgp, {});
  t.emit("deactivate"); // another application comes forward
  await tick();
  check("no second player was asked for", t.launcherMessages.length, 0);
  t.select(wgp.browser); // and back to the tab the video came from
  t.tabStrip.fire("TabSelect");
  await tick();
  await tick();
  check("the player that was there folds away", t.windows[0].closed, true);
}

// 23g. the gap between the panel and the card stays the same size
{
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  const calls = [];
  t.windows[0].__pipTuckAway = {
    dock: (rect) => calls.push(rect),
    undock: () => {},
    isDocked: () => calls.length > 0,
    aspect: () => 16 / 9,
  };
  await t.tick();
  const collapsed = calls.at(-1);
  t.dockCardEl.rect = { left: 20, top: 340, width: 300, height: 260 }; // hovered: the card grew
  await t.tick();
  const expanded = calls.at(-1);
  check("the panel moved up with the card", expanded.y < collapsed.y, true);
  check("six pixels above the card at rest", collapsed.y + collapsed.height + 6, 400);
  check("and six pixels above it while hovered", expanded.y + expanded.height + 6, 340);
}

// 30. in front, a playing video is shown by the widget and no player is opened
{
  mirrorActor.sent.length = 0;
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  const wgp = wgpFor(false, { selected: false });
  await t.pipApi().handlePictureInPictureRequest(wgp, {});
  await tick();
  check("no player window was opened", t.pipCalls.length, 0);
  check("the widget has the video", !!t.mirror(), true);
  check("the canvas is in the toolbar", t.mirror()?.parent !== null, true);
  check("nothing is drawn before a picture arrives", t.mirror().hasAttribute("waiting"), true);
  check("and no room is taken yet", t.barStyle.props["--zen-media-collapsed-height"], undefined);
  check("the tab was asked to start copying", mirrorActor.sent.map((m) => m.name), ["PipMirror:Start"]);
  check("the actor is registered", Object.keys(t.registeredActors), ["PipMirror"]);
}

// 30b. in the background the request goes to the platform, untouched
{
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", frontWithApp: false });
  await t.pipApi().handlePictureInPictureRequest(wgpFor(false), {});
  await tick();
  check("the platform opened the player", t.pipCalls.length, 1);
  check("and the widget shows nothing", t.mirror(), null);
}

// 30c. with the setting off nothing is mirrored
{
  const t = mk({ "pip-tuck-away.in-widget": false }, { mediaCard: "shown" });
  await t.pipApi().handlePictureInPictureRequest(wgpFor(false), {});
  await tick();
  check("the platform opened the player", t.pipCalls.length, 1);
  check("and the widget shows nothing", t.mirror(), null);
}

// 30d. a protected video falls back to a player window
{
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  const wgp = wgpFor(false, { selected: false, bcId: 7 });
  await t.pipApi().handlePictureInPictureRequest(wgp, {});
  await tick();
  t.controller().mirrorStarted(7, { encrypted: true, width: 1920, height: 1080 }, mirrorActor);
  await tick();
  check("the platform got the request after all", t.pipCalls.length, 1);
  check("and the widget let go of it", t.mirror(), null);
}

// 30e. a copied frame is painted
{
  mirrorActor.sent.length = 0;
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  const wgp = wgpFor(false, { selected: false, bcId: 11 });
  await t.pipApi().handlePictureInPictureRequest(wgp, {});
  await tick();
  const frame = { buf: new ArrayBuffer(4 * 4 * 2 * 2), width: 2, height: 2, time: 3, duration: 60, paused: false };
  t.controller().mirrorStarted(11, { width: 1280, height: 720, paused: false }, mirrorActor);
  check("still waiting for a picture", t.mirror().hasAttribute("waiting"), true);
  t.controller().mirrorFrame(11, frame);
  check("the canvas has pixels", t.mirror().firstElementChild.painted?.width, 2);
  check("the panel appears with the first frame", t.mirror().hasAttribute("waiting"), false);
  check("it sits above the card, at the card's width", [t.mirror().style.width, t.mirror().style.height], ["288px", "162px"]);
  check("and the widget makes room for it", t.barStyle.props["--zen-media-collapsed-height"] !== undefined, true);
  check("and the play button says pause", t.mirror().querySelector(".pip-tuck-away-mirror-button path").getAttribute("d").startsWith("M4 2h4"), true);
  check("a click on the picture is a play/pause", (t.mirror().firstElementChild.fire("click", {}) ?? true) && mirrorActor.sent.some((m) => m.name === "PipMirror:Control" && m.data.action === "toggle"), true);
}

// 30h. the panel is measured with the widget, not once
{
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  const wgp = wgpFor(false, { selected: false, bcId: 21 });
  await t.pipApi().handlePictureInPictureRequest(wgp, {});
  t.controller().mirrorStarted(21, { width: 1280, height: 720, paused: false }, mirrorActor);
  t.controller().mirrorFrame(21, { buf: new ArrayBuffer(16), width: 2, height: 2, paused: false });
  check("placed at the widget's width", t.mirror().style.width, "288px");
  t.dockCardEl.rect = { left: 20, top: 400, width: 200, height: 160 };
  await t.tick();
  check("and it follows the widget when the widget changes", t.mirror().style.width, "188px");
}

// 30e2. a video that never produces a picture becomes a player window
{
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  const wgp = wgpFor(false, { selected: false, bcId: 19 });
  await t.pipApi().handlePictureInPictureRequest(wgp, {});
  await tick();
  check("nothing drawn yet", t.mirror().hasAttribute("waiting"), true);
  t.runTimers(); // the patience runs out
  await tick();
  await tick();
  check("the platform got the request", t.pipCalls.length, 1);
  check("and the empty panel is gone", t.mirror(), null);
}

// 30f. leaving the browser hands the video to the standard player
{
  mirrorActor.sent.length = 0;
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  t.windows.length = 0; // the widget is showing it: no player window exists
  const wgp = wgpFor(false, { selected: false, bcId: 13 });
  await t.pipApi().handlePictureInPictureRequest(wgp, {});
  await tick();
  t.setFront(false); // the whole application goes behind something else
  t.emit("deactivate");
  await tick();
  check("the widget stopped copying", mirrorActor.sent.map((m) => m.name).includes("PipMirror:Stop"), true);
  check("the widget let go of the panel", t.mirror(), null);
  check("and the tab was asked for its player", wgp.launcher, ["PictureInPicture:AutoToggle"]);
}

// 30g. the video's own tab coming forward ends the mirror
{
  mirrorActor.sent.length = 0;
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  const wgp = wgpFor(false, { selected: false, bcId: 17 });
  await t.pipApi().handlePictureInPictureRequest(wgp, {});
  await tick();
  t.select(wgp.browser);
  t.tabStrip.fire("TabSelect");
  await tick();
  check("the widget stopped copying", mirrorActor.sent.map((m) => m.name).includes("PipMirror:Stop"), true);
  check("and the panel is gone", t.mirror(), null);
}

// 31. a paused video still shows in the widget when its tab is left
{
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  const aActor = { sent: [], sendAsyncMessage(name, data) { aActor.sent.push({ name, data }); } };
  const A = wgpFor(false, { selected: true, bcId: 41, actor: aActor });
  t.select(A.browser);
  t.tabStrip.fire("TabSelect"); // the mod knows which tab was in front
  const B = wgpFor(false, { selected: false, bcId: 42 });
  t.select(B.browser);
  t.tabStrip.fire("TabSelect");
  await tick();
  check("the tab that was left is asked for its video", aActor.sent.map((m) => m.name), ["PipMirror:Start"]);
  t.controller().mirrorStarted(41, { width: 1280, height: 720, paused: true }, aActor);
  t.controller().mirrorFrame(41, { buf: new ArrayBuffer(16), width: 2, height: 2, paused: true });
  check("the widget shows it", t.mirror()?.hasAttribute("waiting"), false);
  check("and says it is paused", t.mirror().querySelector(".pip-tuck-away-mirror-button path").getAttribute("d"), "M4 2l12 8-12 8z");
}

// 31b. a tab with nothing to show leaves the panel exactly as it was
{
  mirrorActor.sent.length = 0;
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  const blankActor = { sent: [], sendAsyncMessage(name) { blankActor.sent.push({ name }); } };
  const B = wgpFor(false, { selected: true, bcId: 52, actor: blankActor });
  t.select(B.browser);
  t.tabStrip.fire("TabSelect");
  const A = wgpFor(false, { selected: false, bcId: 51 });
  await t.pipApi().handlePictureInPictureRequest(A, {});
  t.controller().mirrorStarted(51, { width: 1280, height: 720 }, mirrorActor);
  t.controller().mirrorFrame(51, { buf: new ArrayBuffer(16), width: 2, height: 2 });
  check("the widget shows the video", t.mirror()?.hasAttribute("waiting"), false);
  const C = wgpFor(false, { selected: false, bcId: 53 });
  t.select(C.browser);
  t.tabStrip.fire("TabSelect"); // leaving the blank tab, which is asked
  await tick();
  check("the blank tab was asked", blankActor.sent.map((m) => m.name), ["PipMirror:Start"]);
  t.controller().mirrorUnavailable(52, "no video is playing");
  check("and the panel kept the video it had", t.mirror()?.hasAttribute("waiting"), false);
  check("which was never stopped", mirrorActor.sent.map((m) => m.name), ["PipMirror:Start"]);
}

// 31c. a tab that does have a video takes the panel's place
{
  mirrorActor.sent.length = 0;
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  const otherActor = { sent: [], sendAsyncMessage(name) { otherActor.sent.push({ name }); } };
  const B = wgpFor(false, { selected: true, bcId: 62, actor: otherActor });
  t.select(B.browser);
  t.tabStrip.fire("TabSelect");
  const A = wgpFor(false, { selected: false, bcId: 61 });
  await t.pipApi().handlePictureInPictureRequest(A, {});
  t.controller().mirrorStarted(61, { width: 1280, height: 720 }, mirrorActor);
  t.controller().mirrorFrame(61, { buf: new ArrayBuffer(16), width: 2, height: 2 });
  const C = wgpFor(false, { selected: false, bcId: 63 });
  t.select(C.browser);
  t.tabStrip.fire("TabSelect");
  await tick();
  t.controller().mirrorStarted(62, { width: 1280, height: 720 }, otherActor);
  check("the tab the panel left stops copying", mirrorActor.sent.map((m) => m.name), ["PipMirror:Start", "PipMirror:Stop"]);
  t.controller().mirrorFrame(62, { buf: new ArrayBuffer(16), width: 2, height: 2 });
  check("and the new picture is the one drawn", t.mirror().firstElementChild.painted.width, 2);
}

// 31c2. arriving at a tab that was only asked keeps its video out of the widget
{
  mirrorActor.sent.length = 0;
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  const otherActor = { sent: [], sendAsyncMessage(name) { otherActor.sent.push({ name }); } };
  const B = wgpFor(false, { selected: true, bcId: 65, actor: otherActor });
  t.select(B.browser);
  t.tabStrip.fire("TabSelect");
  const A = wgpFor(false, { selected: false, bcId: 64 });
  await t.pipApi().handlePictureInPictureRequest(A, {});
  t.controller().mirrorStarted(64, { width: 1280, height: 720 }, mirrorActor);
  t.controller().mirrorFrame(64, { buf: new ArrayBuffer(16), width: 2, height: 2 });
  const cActor = { sent: [], sendAsyncMessage(name) { cActor.sent.push({ name }); } };
  const C = wgpFor(false, { selected: false, bcId: 66, actor: cActor });
  t.select(C.browser);
  t.tabStrip.fire("TabSelect"); // leaving B: B is asked, and has not answered yet
  await tick();
  t.select(B.browser); // and the user arrives at B before it does
  t.tabStrip.fire("TabSelect");
  check("the tab that came forward is let go of", otherActor.sent.map((m) => m.name), ["PipMirror:Start", "PipMirror:Stop"]);
  t.controller().mirrorStarted(65, { width: 1280, height: 720 }, otherActor);
  t.controller().mirrorFrame(65, { buf: new ArrayBuffer(16), width: 2, height: 2 });
  check("the tab left after it was asked in turn", cActor.sent.map((m) => m.name), ["PipMirror:Start"]);
  check("and the video on screen is still the one that was playing", mirrorActor.sent.map((m) => m.name), ["PipMirror:Start"]);
  check("shown, not waiting", t.mirror()?.hasAttribute("waiting"), false);
}

// 31d. a protected video leaves the panel alone rather than blackening it
{
  mirrorActor.sent.length = 0;
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  const lockedActor = { sent: [], sendAsyncMessage(name) { lockedActor.sent.push({ name }); } };
  const B = wgpFor(false, { selected: true, bcId: 72, actor: lockedActor });
  t.select(B.browser);
  t.tabStrip.fire("TabSelect");
  const A = wgpFor(false, { selected: false, bcId: 71 });
  await t.pipApi().handlePictureInPictureRequest(A, {});
  t.controller().mirrorStarted(71, { width: 1280, height: 720 }, mirrorActor);
  t.controller().mirrorFrame(71, { buf: new ArrayBuffer(16), width: 2, height: 2 });
  const C = wgpFor(false, { selected: false, bcId: 73 });
  t.select(C.browser);
  t.tabStrip.fire("TabSelect");
  await tick();
  t.controller().mirrorStarted(72, { encrypted: true }, lockedActor);
  check("the panel keeps the video it had", t.mirror()?.hasAttribute("waiting"), false);
  check("no player was opened for it", t.pipCalls.length, 0);
}

// 31e. leaving the application with a paused video opens nothing at all
{
  mirrorActor.sent.length = 0;
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  const A = wgpFor(false, { selected: false, bcId: 81 });
  await t.pipApi().handlePictureInPictureRequest(A, {});
  t.controller().mirrorStarted(81, { width: 1280, height: 720, paused: true }, mirrorActor);
  t.controller().mirrorFrame(81, { buf: new ArrayBuffer(16), width: 2, height: 2, paused: true });
  t.setFront(false);
  t.emit("deactivate");
  await tick();
  check("the panel goes", t.mirror(), null);
  check("and nothing floats over the other application", A.launcher, []);
}

// 31f. leaving the application with a playing video hands it to the player
{
  mirrorActor.sent.length = 0;
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  t.windows.length = 0;
  const A = wgpFor(false, { selected: false, bcId: 91 });
  await t.pipApi().handlePictureInPictureRequest(A, {});
  t.controller().mirrorStarted(91, { width: 1280, height: 720, paused: false }, mirrorActor);
  t.controller().mirrorFrame(91, { buf: new ArrayBuffer(16), width: 2, height: 2, paused: false });
  t.setFront(false);
  t.emit("deactivate");
  await tick();
  check("the tab is asked for its own player", A.launcher, ["PictureInPicture:AutoToggle"]);
}

// 31g. coming back on another tab folds that player and shows the widget again
{
  mirrorActor.sent.length = 0;
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  t.windows.length = 0;
  const A = wgpFor(false, { selected: false, bcId: 101 });
  await t.pipApi().handlePictureInPictureRequest(A, {});
  t.controller().mirrorStarted(101, { width: 1280, height: 720, paused: false }, mirrorActor);
  t.controller().mirrorFrame(101, { buf: new ArrayBuffer(16), width: 2, height: 2, paused: false });
  t.setFront(false);
  t.emit("deactivate");
  await tick();
  // the player the platform opened for that tab, while the browser was away
  const player = t.pipWindow();
  t.windows.push(player);
  t.pipWindows.push(player);
  t.weakWinToBrowser.set(player, A.browser);
  const other = wgpFor(false, { selected: true, bcId: 102 });
  t.select(other.browser);
  t.setFront(true);
  t.emit("activate");
  await tick();
  check("the player is folded away", t.closedWindows.includes(player), true);
  check("the widget asks for the video again", mirrorActor.sent.map((m) => m.name), ["PipMirror:Start", "PipMirror:Stop", "PipMirror:Start"]);
  t.controller().mirrorStarted(101, { width: 1280, height: 720 }, mirrorActor);
  t.controller().mirrorFrame(101, { buf: new ArrayBuffer(16), width: 2, height: 2 });
  check("and shows it", t.mirror()?.hasAttribute("waiting"), false);
}

// 31h. coming back on the video's own tab folds the player and shows nothing
{
  mirrorActor.sent.length = 0;
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  t.windows.length = 0;
  const A = wgpFor(false, { selected: false, bcId: 111 });
  await t.pipApi().handlePictureInPictureRequest(A, {});
  t.controller().mirrorStarted(111, { width: 1280, height: 720, paused: false }, mirrorActor);
  t.controller().mirrorFrame(111, { buf: new ArrayBuffer(16), width: 2, height: 2, paused: false });
  t.setFront(false);
  t.emit("deactivate");
  await tick();
  const player = t.pipWindow();
  t.windows.push(player);
  t.pipWindows.push(player);
  t.weakWinToBrowser.set(player, A.browser);
  t.select(A.browser);
  t.setFront(true);
  t.emit("activate");
  await tick();
  check("the player is folded away", player.closed, true);
  check("and the video is back in its page", t.mirror(), null);
}

// 31i. a player window taking focus is not the browser going away
{
  mirrorActor.sent.length = 0;
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  const A = wgpFor(false, { selected: false, bcId: 121 });
  await t.pipApi().handlePictureInPictureRequest(A, {});
  t.controller().mirrorStarted(121, { width: 1280, height: 720 }, mirrorActor);
  t.controller().mirrorFrame(121, { buf: new ArrayBuffer(16), width: 2, height: 2 });
  t.setFront("player");
  t.emit("deactivate");
  await tick();
  check("the panel stays where it is", t.mirror()?.hasAttribute("waiting"), false);
  check("and nothing was stopped", mirrorActor.sent.map((m) => m.name), ["PipMirror:Start"]);
}

// 31j. a tab that is closed takes its panel with it
{
  mirrorActor.sent.length = 0;
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  const A = wgpFor(false, { selected: false, bcId: 131 });
  await t.pipApi().handlePictureInPictureRequest(A, {});
  t.controller().mirrorStarted(131, { width: 1280, height: 720 }, mirrorActor);
  t.controller().mirrorFrame(131, { buf: new ArrayBuffer(16), width: 2, height: 2 });
  t.tabStrip.fire("TabClose", { linkedBrowser: A.browser });
  check("the panel is gone", t.mirror(), null);
  check("and the room went with it", t.barStyle.props["--zen-media-collapsed-height"], undefined);
}

// 22. unload puts the original handler back
{
  const t = mk({ "pip-tuck-away.inline-in-zen": true, "pip-tuck-away.in-widget": false }, { mediaCard: "shown" });
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
