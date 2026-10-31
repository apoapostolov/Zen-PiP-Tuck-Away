// Headless harness for pip-tuck-away.uc.js: the browser-window half.
import fs from "node:fs";
import vm from "node:vm";
import { dirname, join } from "node:path";

const CODE = fs.readFileSync(process.argv[2], "utf8");
const TRACE_CODE = fs.readFileSync(join(dirname(dirname(process.argv[2])), "scripts", "pip-trace.sys.mjs"), "utf8")
  .replaceAll("export function", "function");
const PLAYER_URL = "chrome://global/content/pictureinpicture/player.xhtml";
const PLAYER_SCRIPT = "chrome://sine/content/pip-tuck-away/scripts/pip-player.uc.js";

let latestWindow = null;

function mk(prefsIn = {}, opts = {}) {
  const app = opts.app ?? {};
  const wwObservers = [];
  const winEvents = Object.create(null);
  const loads = [];
  const destroys = [];
  const toggles = [];
  let unloadListener = null;
  const intervals = [];
  const frames = [];
  const prefObservers = [];
  const resizeObservers = [];
  const mutationObservers = [];

  const prefs = { ...prefsIn };

  const pipWindow = (href = PLAYER_URL, env = {}) => {
    const { fireLoad = true, documentReady = true } = env;
    const listeners = Object.create(null);
    const w = {
      location: { href },
      closed: false,
      moves: [],
      resizes: [],
      moveTo(x, y) {
        w.moves.push([x, y]);
      },
      resizeTo(width, height) {
        w.resizes.push([width, height]);
      },
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

  const windows = app.windows ??= [pipWindow(), browserWindow()];

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
      contains(target) {
        return target === node || node.children.some((kid) => kid.contains(target));
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
          drawImage: (source, x, y, width, height) => {
            node.drawn = { source, x, y, width, height };
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
  const registeredActors = app.registeredActors ??= Object.create(null);
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
    removeEventListener(type, fn) {
      this._events[type] = (this._events[type] || []).filter((f) => f !== fn);
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
  const pipModule = app.pipModule ??= {
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
  let cardMode = opts.mediaCard ?? "absent";
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

  const traces = app.traces ??= new Map();
  const launcherMessages = [];
  const selected = {
    audioMuted: opts.muted ?? false,
    contentTitle: opts.title ?? "",
    currentURI: { spec: opts.url ?? "https://example.com/" },
    browsingContext: {
      currentWindowGlobal: {
        getActor: (name) =>
          name === "PictureInPictureLauncher"
            ? { sendAsyncMessage: (msg) => launcherMessages.push(msg) }
            : null,
      },
    },
  };

  mediaBar.contains = (target) => target === mediaBar || target === dockCardEl || mediaBar.children.some((node) => node.contains(target));
  mediaBar.addEventListener = (type, fn) => (mediaBar.listeners ??= {})[type] = fn;
  mediaBar.removeEventListener = (type) => { delete (mediaBar.listeners ??= {})[type]; };
  const tabByBrowser = new Map();
  const tabFor = (browser) => {
    let tab = tabByBrowser.get(browser);
    if (!tab) {
      tab = { linkedBrowser: browser };
      tabByBrowser.set(browser, tab);
    }
    return tab;
  };
  const window = {
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.active = true; resizeObservers.push(this); }
      observe() { this.active = true; }
      unobserve() {}
      disconnect() { this.active = false; }
    },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.active = true; mutationObservers.push(this); }
      observe() { this.active = true; }
      disconnect() { this.active = false; }
    },
    innerWidth: 1920,
    innerHeight: 1080,
    location: { href: "chrome://browser/content/browser.xhtml" },
    gBrowser: {
      selectedBrowser: selected,
      selectedTab: null,
      tabContainer: tabStrip,
      tabs: [],
      getTabForBrowser: (browser) => (browser ? tabFor(browser) : null),
    },
    requestAnimationFrame: (fn) => frames.push(fn),
    cancelAnimationFrame: (id) => {
      frames[id - 1] = null;
    },
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

  window.gBrowser.getTabForBrowser = (browser) => {
    const tab = tabFor(browser);
    if (!window.gBrowser.tabs.includes(tab)) {
      window.gBrowser.tabs.push(tab);
    }
    return tab;
  };
  latestWindow = window;
  if (opts.app) windows.push(window);
  const sandbox = {
    window,
    Services: {
      prefs: {
        getPrefType: (k) => (k in prefs ? 128 : 0),
        getBoolPref: (k, fallback = false) => (k in prefs ? !!prefs[k] : fallback),
        getStringPref: (k, fallback = "") => prefs[k] ?? fallback,
        setStringPref: (k, value) => { prefs[k] = value; },
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
      importESModule: (url) => {
        if (url.includes("pip-trace.sys.mjs")) {
          return app.traceModule ??= vm.runInNewContext(TRACE_CODE + "\n({ appendTrace, flushTrace });", { IOUtils: sandbox.IOUtils });
        }
        return pipModule;
      },
      registerWindowActor: (name, spec) => {
        if (registeredActors[name]) {
          const err = new Error("already registered");
          err.name = "NotSupportedError";
          throw err;
        }
        registeredActors[name] = spec;
      },
      unregisterWindowActor: (name) => {
        delete registeredActors[name];
      },
    },
    Components: { interfaces: { nsIFile: "nsIFile" } },
    IOUtils: {
      async exists(path) {
        return traces.has(path);
      },
      async stat(path) {
        return { size: (traces.get(path) ?? "").length };
      },
      async writeUTF8(path, text, options = {}) {
        // Gecko fails an append to a file that is not there, which is what made
        // the trace silently never exist. The stub says so too, so the fix
        // cannot be undone quietly.
        if (options.mode === "append" && !traces.has(path)) {
          throw new Error("NS_ERROR_FILE_NOT_FOUND");
        }
        if (opts.traceFails) throw new Error("disk unavailable");
        traces.set(path, (options.mode === "append" ? traces.get(path) ?? "" : "") + text);
      },
      async remove(path) {
        traces.delete(path);
      },
    },
    setInterval: (fn) => {
      intervals.push(fn);
      return intervals.length;
    },
    requestAnimationFrame: (fn) => {
      frames.push(fn);
      return frames.length;
    },
    cancelAnimationFrame: (id) => {
      frames[id - 1] = null;
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
    reload: () => vm.runInContext(CODE, sandbox),
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
    flushTrace: () => app.traceModule?.flushTrace(),
    closedWindows,
    closedSingle,
    launcherMessages,
    selected,
    tabStrip,
    tabFor: (browser) => tabByBrowser.get(browser) ?? null,
    gBrowser: () => window.gBrowser,
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
    intervals,
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
      for (const obs of prefObservers.filter((entry) => entry.name === name)) obs.fn({}, "nsPref:changed", name);
    },
    showMediaBar() { cardMode = "shown"; mediaBar.hidden = false; this.notifyMutation(mediaBar); },
    pendingFrames: () => frames.filter(Boolean).length,
    notifyResize() { for (const obs of resizeObservers) if (obs.active) obs.callback([]); },
    notifyMutation(target) { for (const obs of mutationObservers) if (obs.active) obs.callback([{ target }]); },
    transition(type, target, propertyName = "height") {
      for (const fn of winEvents[type] ?? []) fn({ type, target, propertyName });
    },
    async tick(notifyResize = true) {
      if (notifyResize) for (const obs of resizeObservers) if (obs.active) obs.callback([]);
      for (const fn of [...intervals]) {
        if (fn) fn();
      }
      // A frame callback runs once per registration, as it would in a window:
      // the loop re-registers itself for the frame after this one.
      const upto = frames.length;
      for (let i = 0; i < upto; i++) {
        const fn = frames[i];
        frames[i] = null;
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
    ownerGlobal: opts.owner ?? latestWindow,
    docShellIsActive: active,
    contentTitle: opts.title ?? "",
    currentURI: { spec: opts.url ?? "https://example.com/" },
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

// 16f2. leaving Zen on a new tab asks nothing
{
  const t = mk({ "pip-tuck-away.inline-in-zen": true, "pip-tuck-away.in-widget": false }, { mediaCard: "shown", title: "New Tab" });
  t.windows.length = 0;
  t.emit("deactivate");
  await tick();
  check("a new tab is never asked for a player", t.launcherMessages, []);
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
  const t = mk({ "pip-tuck-away.trace": true, "pip-tuck-away.inline-in-zen": true, "pip-tuck-away.in-widget": true }, { mediaCard: "shown", deferTimers: true });
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
  check("inside the widget's own box, six pixels in from its left edge", t.mirror().style.left, "26px");
  // Hung off the card's own top edge, not off the top of the toolbar: the room
  // the widget gives up can lag a frame behind without the panel sitting over
  // the card, which is what a hover used to be needed to fix.
  check("and hung six pixels above the card's top edge", t.mirror().style.bottom, "586px");
  check("so its place does not depend on the room", t.mirror().style.top, "auto");
  // 162 for the panel, 6px above and below it, and the 120px the card carries
  // beyond the 80px its collapsed box already counted.
  check(
    "and the widget makes exactly that much room",
    t.barStyle.props["--zen-media-collapsed-height"],
    "calc(80px + 294px)"
  );
  check("with the toolbar's own height animation switched off", t.barStyle.props.transition, "none");
  check("with nothing added to the card", t.dockSpacers.length, 0);
  check("and the play button says pause", t.mirror().querySelector(".pip-tuck-away-mirror-button path").getAttribute("d").startsWith("M4 2h4"), true);
  t.mirror().firstElementChild.fire("click", {});
  check("a click waits out the double-click window", mirrorActor.sent.some((m) => m.name === "PipMirror:Control"), false);
  t.runTimers();
  check("a click on the picture is a play/pause", mirrorActor.sent.some((m) => m.name === "PipMirror:Control" && m.data.action === "toggle"), true);
}

// 30g2. a double click on the picture goes to the video's tab
{
  const t = mk({ "pip-tuck-away.in-widget": true, "pip-tuck-away.trace": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  const wgp = wgpFor(false, { selected: false, bcId: 31 });
  await t.pipApi().handlePictureInPictureRequest(wgp, {});
  t.controller().mirrorStarted(31, { width: 1280, height: 720, paused: false }, mirrorActor);
  t.controller().mirrorFrame(31, { buf: new ArrayBuffer(16), width: 2, height: 2, paused: false });
  mirrorActor.sent.length = 0;
  t.mirror().firstElementChild.fire("click", {});
  t.mirror().firstElementChild.fire("dblclick", {});
  t.runTimers();
  check("the double click selects the video's tab", t.gBrowser().selectedTab === t.gBrowser().getTabForBrowser(wgp.browser), true);
  check("and it is the tab the widget was showing", t.gBrowser().selectedTab.linkedBrowser === wgp.browser, true);
  check("a double click does not also toggle the video", mirrorActor.sent.filter((m) => m.name === "PipMirror:Control").length, 0);
}

// 30g3. the second press of a double click is not a play/pause
{
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  const wgp = wgpFor(false, { selected: false, bcId: 32 });
  await t.pipApi().handlePictureInPictureRequest(wgp, {});
  t.controller().mirrorStarted(32, { width: 1280, height: 720, paused: false }, mirrorActor);
  t.controller().mirrorFrame(32, { buf: new ArrayBuffer(16), width: 2, height: 2, paused: false });
  mirrorActor.sent.length = 0;
  t.mirror().firstElementChild.fire("click", { detail: 2 });
  t.runTimers();
  check("a second press toggles nothing", mirrorActor.sent.length, 0);
}

// 30g4. a double click before the panel settles goes to the tab it is waiting for
{
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  const A = wgpFor(false, { selected: true, bcId: 33 });
  await t.pipApi().handlePictureInPictureRequest(A, {});
  t.controller().mirrorStarted(33, { width: 1280, height: 720, paused: false }, mirrorActor);
  t.controller().mirrorFrame(33, { buf: new ArrayBuffer(16), width: 2, height: 2, paused: false });
  // the tab changes: B is asked, and answers only afterwards
  const B = wgpFor(false, { selected: false, bcId: 34 });
  t.select(B.browser);
  t.controller().mirrorRequested?.(34);
  t.mirror()?.firstElementChild?.fire?.("dblclick", {});
  t.runTimers();
  const got = t.gBrowser().selectedTab?.linkedBrowser;
  check("a double click during the hand-over goes to a tab that has the video", got === B.browser || got === A.browser, true);
}

// 30i. a tab that is still a new tab gets no player and no panel
{
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  const wgp = wgpFor(false, { selected: false, bcId: 35, title: "New Tab" });
  await t.pipApi().handlePictureInPictureRequest(wgp, {});
  await tick();
  check("no player was opened for it", t.pipCalls.length, 0);
  check("and the widget shows nothing", t.mirror()?.firstElementChild?.painted ?? null, null);
}

// 30j. an about:newtab address is skipped whatever it is called
{
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  const wgp = wgpFor(false, { selected: false, bcId: 36, title: "Some page", url: "about:newtab" });
  await t.pipApi().handlePictureInPictureRequest(wgp, {});
  await tick();
  check("an empty start page opens no player", t.pipCalls.length, 0);
}

// 30k. leaving a new tab does not put a video in the widget
{
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  const blankActor = { sent: [], sendAsyncMessage(name, data) { this.sent.push({ name, data }); } };
  const blank = wgpFor(true, { selected: true, bcId: 37, title: "New Tab", actor: blankActor });
  t.select(blank.browser);
  t.tabStrip.fire("TabSelect", {});
  const other = wgpFor(false, { selected: false, bcId: 38, title: "YouTube" });
  t.select(other.browser);
  t.tabStrip.fire("TabSelect", {});
  await tick();
  check("the new tab was never asked for a picture", blankActor.sent.length, 0);
  check("and no player was opened", t.pipCalls.length, 0);
}

// 30l. a domain on the ignored list gets no player and no panel
{
  const t = mk({ "pip-tuck-away.in-widget": true, "pip-tuck-away.ignore-hosts": "youtube.com" }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  const wgp = wgpFor(false, { selected: false, bcId: 51, title: "A video", url: "https://www.youtube.com/watch?v=1" });
  await t.pipApi().handlePictureInPictureRequest(wgp, {});
  await tick();
  check("an ignored domain opens no player", t.pipCalls.length, 0);
  check("and the widget shows nothing for it", t.mirror()?.firstElementChild?.painted ?? null, null);
}

// 30m. a subdomain of an ignored domain is ignored too
{
  const t = mk({ "pip-tuck-away.in-widget": true, "pip-tuck-away.ignore-hosts": "youtube.com" }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  await t.pipApi().handlePictureInPictureRequest(wgpFor(false, { selected: false, bcId: 52, url: "https://m.youtube.com/watch?v=2" }), {});
  await tick();
  check("a subdomain is skipped", t.pipCalls.length, 0);
}

// 30n. a pasted address, a port and a stray prefix all mean the same host
{
  const t = mk({ "pip-tuck-away.in-widget": true, "pip-tuck-away.ignore-hosts": " https://WWW.YouTube.com/watch?v=9 ,, example.org:8080 " }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  await t.pipApi().handlePictureInPictureRequest(wgpFor(false, { selected: false, bcId: 53, url: "https://youtube.com/watch?v=3" }), {});
  await tick();
  check("a pasted address matches the plain domain", t.pipCalls.length, 0);
  const t2 = mk({ "pip-tuck-away.in-widget": true, "pip-tuck-away.ignore-hosts": "example.org:8080" }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  await t2.pipApi().handlePictureInPictureRequest(wgpFor(false, { selected: false, bcId: 54, url: "https://example.org/watch" }), {});
  await tick();
  check("a port in the entry does not stop the host matching", t2.pipCalls.length, 0);
}

// 30o. a domain that is not on the list is untouched
{
  const t = mk({ "pip-tuck-away.in-widget": true, "pip-tuck-away.ignore-hosts": "youtube.com" }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  const wgp = wgpFor(false, { selected: false, bcId: 55, url: "https://vimeo.com/123" });
  await t.pipApi().handlePictureInPictureRequest(wgp, {});
  t.controller().mirrorStarted(55, { width: 1280, height: 720, paused: false }, mirrorActor);
  t.controller().mirrorFrame(55, { buf: new ArrayBuffer(16), width: 2, height: 2, paused: false });
  check("another domain is mirrored as usual", t.mirror()?.firstElementChild?.painted?.width, 2);
  check("and no player was opened for it", t.pipCalls.length, 0);
}

// 30p. adding a domain to the list takes the video off the screen at once
{
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  const wgp = wgpFor(false, { selected: false, bcId: 56, url: "https://youtube.com/watch?v=4" });
  await t.pipApi().handlePictureInPictureRequest(wgp, {});
  t.controller().mirrorStarted(56, { width: 1280, height: 720, paused: false }, mirrorActor);
  t.controller().mirrorFrame(56, { buf: new ArrayBuffer(16), width: 2, height: 2, paused: false });
  check("the panel is showing it", t.mirror()?.hasAttribute("waiting"), false);
  t.setPref("pip-tuck-away.ignore-hosts", "youtube.com");
  check("the panel goes when its domain is ignored", t.mirror(), null);
  check("and no player was opened in its place", t.pipCalls.length, 0);
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
  // The card grew, which is what hovering it does: the room follows it, up to
  // the point where the hover rows stop growing.
  t.dockCardEl.rect = { left: 20, top: 340, width: 200, height: 160 };
  await t.tick();
  check("and the panel follows the card's top edge", t.mirror().style.bottom, "646px");
  check(
    "and the room follows the card's own growth",
    t.barStyle.props["--zen-media-collapsed-height"],
    "calc(80px + 198px)"
  );
}

// 30h2. the widget's height moves with the card, on the frame the card moves
{
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  const wgp = wgpFor(false, { selected: false, bcId: 25 });
  await t.pipApi().handlePictureInPictureRequest(wgp, {});
  t.controller().mirrorStarted(25, { width: 1280, height: 720, paused: false }, mirrorActor);
  t.controller().mirrorFrame(25, { buf: new ArrayBuffer(16), width: 2, height: 2, paused: false });
  const atRest = t.barStyle.props["--zen-media-collapsed-height"];
  // The card expands on hover over 300ms. Whatever height it is at this frame,
  // the room follows it in the same frame, which is what keeps the panel six
  // pixels above the card rather than chasing it.
  t.dockCardEl.rect = { left: 20, top: 400, width: 300, height: 235 };
  await t.tick();
  const midway = t.barStyle.props["--zen-media-collapsed-height"];
  check("at rest", atRest, "calc(80px + 294px)");
  check("and partway through the card's own expansion", midway, "calc(80px + 329px)");
  check("the widget gave up exactly the card's growth", 329 - 294, 235 - 200);
  check("and the panel did not move sideways", t.mirror().style.left, "26px");
}

// 30j. the setting names the cost of the picture it turns on
{
  const settings = JSON.parse(fs.readFileSync("preferences.json", "utf8"));
  const widget = settings.find((e) => e.property === "pip-tuck-away.in-widget");
  check("the widget setting is there", !!widget, true);
  check("and it warns that the frame rate is slow and the feature is experimental",
    /slow framerate, experimental/.test(widget.label), true);
  // No setting carries an inline hint: the label names the setting and nothing
  // more, and the low frame rate is the one thing a name has to warn about.
  const hints = settings.filter((e) => e.property && /\s\*[^*]/.test(e.label));
  check("and no setting carries a hint beside its name", hints.map((e) => e.property), []);
}

// 30k. the settings are grouped, in order, with the new ones where they belong
{
  const settings = JSON.parse(fs.readFileSync("preferences.json", "utf8"));
  const groups = settings.filter((e) => e.type === "separator").map((e) => e.label);
  check("settings groups follow the mod workflow", groups, [
    "**Tuck away**",
    "**The player**",
    "**Sidebar media controls**",
    "**Videos to leave alone**",
    "**Diagnostics**",
  ]);
  check("settings groups are unchanged where they should be", groups.slice(0, 3), [
    "**Tuck away**",
    "**The player**",
    "**Sidebar media controls**",
  ]);
  check("every setting is a real type the settings page renders", 
    settings.filter((e) => e.property && !["checkbox", "dropdown", "string"].includes(e.type)), []);
  // A text field is the one type that also needs a default, or the page shows
  // the empty string and the pref is never written.
  const text = settings.find((e) => e.property === "pip-tuck-away.ignore-hosts");
  check("the ignored domains field is a text field with an empty default",
    [text.type, text.defaultValue], ["string", ""]);
  const size = settings.find((e) => e.property === "pip-tuck-away.size");
  const place = settings.find((e) => e.property === "pip-tuck-away.place");
  check("a default size, Remember Last first and by default", [size.options[0], size.defaultValue],
    [{ label: "Remember Last", value: "remember" }, "remember"]);
  check("and the sizes run from very small to very large",
    size.options.map((o) => o.label).slice(1),
    ["Very Small", "Small", "Medium", "Large", "Very Large"]);
  check("a default location, Remember Last first and by default", [place.options[0], place.defaultValue],
    [{ label: "Remember Last", value: "remember" }, "remember"]);
  check("with the corners and the two middles",
    place.options.map((o) => o.label).slice(1),
    ["Top Left", "Top Middle", "Top Right", "Bottom Left", "Bottom Middle", "Bottom Right"]);
}

// 30l. the trace exists on a profile that has never had one
{
  const t = mk({ "pip-tuck-away.trace": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  await t.tick();
  check("a trace line was written to a file that did not exist", /widget:/.test(t.traces()), true);
  check("with no write error recorded", t.prefs["pip-tuck-away.trace-error"], undefined);
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
  check("with the toolbar's own animation handed back", t.barStyle.props.transition, undefined);
}

// 32. the widget never touches the player's own place or size
{
  mirrorActor.sent.length = 0;
  const t = mk({ "pip-tuck-away.in-widget": true }, { mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM, deferTimers: true });
  const player = t.windows[0];
  t.pipWindows.push(player); // a player window is on screen, at its remembered place
  const A = wgpFor(false, { selected: false, bcId: 141 });
  await t.pipApi().handlePictureInPictureRequest(A, {});
  t.controller().mirrorStarted(141, { width: 1280, height: 720 }, mirrorActor);
  t.controller().mirrorFrame(141, { buf: new ArrayBuffer(16), width: 2, height: 2 });
  await t.tick();
  t.runTimers();
  check("the panel is in the widget", !!t.mirror(), true);
  check("and the player window was never moved", player.moves, []);
  check("or resized", player.resizes, []);
}

// 32b. the browser half has no way to move a window at all
{
  const code = fs.readFileSync(process.argv[2], "utf8");
  check("no moveTo", /\bmoveTo\b/.test(code), false);
  check("no resizeTo", /\bresizeTo\b/.test(code), false);
  check("no docking", /\bdock\b/i.test(code.replace(/dockCard|dockSpacers|dockMain|dockControls|DOCK_ATTR/g, "")), false);
}

// 32c. and no way to write the remembered place, which is the player's own
{
  const code = fs.readFileSync(process.argv[2], "utf8");
  check("the remembered place is never named here", /pip-tuck-away\.home/.test(code), false);
  check("nor the tuck spot", /pip-tuck-away\.spot|pip-tuck-away\.tucked/.test(code), false);
}

// 22. unload puts the original handler back
{
  const t = mk({ "pip-tuck-away.inline-in-zen": true, "pip-tuck-away.in-widget": false }, { mediaCard: "shown" });
  t.unload();
  check("handler restored on unload", !!t.pipApi().handlePictureInPictureRequest.__pipTuckAway, false);
}

// Lifecycle regressions: Sine unload/reload and multiple browser windows.
{
  const t = mk({}, { deferTimers: true });
  const fresh = t.pipWindow(PLAYER_URL, { fireLoad: false });
  t.windows.push(fresh);
  t.openWindow(fresh);
  t.unload();
  t.fireOn(fresh, "load");
  t.runTimers();
  check("unload cancels late player decoration", t.loads.length, 1);
  check("unload removes tab listeners", t.tabStrip._events.TabSelect.length, 0);
  check("unload removes the actor controller", t.controller(), undefined);
  t.reload();
  check("Sine can reload the browser script", t.observerCount(), 1);
  check("reload installs one tab listener", t.tabStrip._events.TabSelect.length, 1);
}
{
  const app = {};
  const first = mk({}, { app, deferTimers: true, mediaCard: "shown" });
  const second = mk({}, { app, deferTimers: true, mediaCard: "shown" });
  const video = wgpFor(false, { selected: false, bcId: 201, owner: second.window });
  await first.pipApi().handlePictureInPictureRequest(video, {});
  check("a second window owns its own preview", !!second.mirror(), true);
  check("the first sidebar stays empty", first.mirror(), null);
  first.unload();
  check("another window keeps the actor registered", !!second.registeredActors.PipMirror, true);
  check("another window keeps the PiP hook installed", !!second.pipApi().handlePictureInPictureRequest.__pipTuckAway, true);
  second.keyOn(app.windows[0], { ctrlKey: true, altKey: true, key: "t" });
  check("shared player shortcuts survive the first window unloading", first.toggles.length, 1);
  second.unload();
  check("the last window unregisters the actor", second.registeredActors.PipMirror, undefined);
  check("the last window releases shared keyboard handling", app.windows[0].listeners.keydown.length, 0);
}
{
  const t = mk({}, { deferTimers: true, mediaCard: "shown" });
  const a = wgpFor(false, { selected: false, bcId: 202 });
  await t.pipApi().handlePictureInPictureRequest(a, {});
  t.controller().mirrorStarted(202, { width: 1280, height: 720 }, mirrorActor);
  const b = wgpFor(false, { selected: true, bcId: 203 });
  t.select(b.browser);
  t.tabStrip.fire("TabSelect");
  const c = wgpFor(false, { selected: false, bcId: 204 });
  t.select(c.browser);
  t.tabStrip.fire("TabSelect");
  t.controller().mirrorStarted(203, { width: 1280, height: 720 }, mirrorActor);
  t.controller().mirrorUnavailable(203, "copy failed");
  await tick();
  check("a replacement preview never falls back to the previous tab", t.pipCalls.length, 0);
}
{
  const t = mk({}, { deferTimers: true, mediaCard: "shown" });
  const video = wgpFor(false, { selected: false, bcId: 205 });
  await t.pipApi().handlePictureInPictureRequest(video, {});
  const button = t.mirror().querySelector(".pip-tuck-away-mirror-button");
  check("sidebar controls use native keyboard buttons", [button.tagName, button.getAttribute("type")], ["BUTTON", "button"]);
}

{
  const t = mk({}, { deferTimers: true, mediaCard: "shown" });
  const video = wgpFor(false, { selected: false, bcId: 206 });
  await t.pipApi().handlePictureInPictureRequest(video, {});
  t.setPref("pip-tuck-away.in-widget", false);
  await tick();
  check("disabling sidebar integration removes the preview immediately", t.mirror(), null);
  check("disabling sidebar integration releases its held PiP request", t.pipCalls.length, 1);
  t.setPref("pip-tuck-away.trace", false);
  check("disabling tracing stops the layout polling", t.intervals.filter(Boolean).length, 0);
  t.setPref("pip-tuck-away.trace", true);
  check("enabling tracing starts one layout poll", t.intervals.filter(Boolean).length, 1);
}

{
  const t = mk({}, { deferTimers: true, mediaCard: "shown" });
  const a = wgpFor(false, { selected: true, bcId: 207 });
  t.select(a.browser);
  t.tabStrip.fire("TabSelect");
  const b = wgpFor(false, { selected: false, bcId: 208 });
  t.select(b.browser);
  t.tabStrip.fire("TabSelect");
  await t.pipApi().handlePictureInPictureRequest(a, {});
  t.controller().mirrorUnavailable(207, "copy failed");
  await tick();
  check("a PiP request arriving after TabSelect still falls back", t.pipCalls.length, 1);
}
{
  const t = mk({}, { deferTimers: true, mediaCard: "shown" });
  const a = wgpFor(false, { selected: false, bcId: 209 });
  const b = wgpFor(false, { selected: false, bcId: 210 });
  await t.pipApi().handlePictureInPictureRequest(a, {});
  await t.pipApi().handlePictureInPictureRequest(b, {});
  t.select(b.browser);
  t.tabStrip.fire("TabSelect");
  await tick();
  check("foregrounding a pending tab cancels its held PiP request", t.pipCalls.length, 0);
}

{
  const t = mk({}, { deferTimers: true, mediaCard: "shown" });
  const a = wgpFor(false, { selected: false, bcId: 211 });
  const b = wgpFor(false, { selected: false, bcId: 212 });
  await t.pipApi().handlePictureInPictureRequest(a, {});
  t.controller().mirrorStarted(211, { paused: true }, mirrorActor);
  await t.pipApi().handlePictureInPictureRequest(b, {});
  t.controller().mirrorState(212, { paused: false });
  check("pending state cannot change the current play button", t.mirror().querySelector(".pip-tuck-away-mirror-button path").getAttribute("d"), "M4 2l12 8-12 8z");
}
{
  const t = mk({}, { deferTimers: true, mediaCard: "shown" });
  t.windows.length = 0;
  const video = wgpFor(false, { selected: false, bcId: 213 });
  await t.pipApi().handlePictureInPictureRequest(video, {});
  const controls = t.mirror().querySelector(".pip-tuck-away-mirror-bar");
  controls.children[1].fire("click", { preventDefault() {}, stopPropagation() {} });
  await t.pipApi().handlePictureInPictureRequest(video, {});
  check("pop-out bypasses the preview for its own request", t.pipCalls.length, 1);
  await t.pipApi().handlePictureInPictureRequest(video, {});
  check("later requests can show the same tab in the sidebar again", !!t.mirror(), true);
}

// Idle previews do not schedule continuous layout measurements.
{
  const t = mk({}, { deferTimers: true, mediaCard: "shown", dockCard: true, barRect: BAR_AT_BOTTOM });
  const video = wgpFor(false, { selected: false, bcId: 301 });
  await t.pipApi().handlePictureInPictureRequest(video, {});
  t.controller().mirrorStarted(301, { width: 1280, height: 720 }, mirrorActor);
  t.controller().mirrorFrame(301, { buf: new ArrayBuffer(16), width: 2, height: 2 });
  await t.tick(false);
  check("idle sidebar layout leaves no frame callback", t.pendingFrames(), 0);
  t.notifyMutation(t.mirror().firstElementChild);
  check("preview-owned DOM writes do not request layout", t.pendingFrames(), 0);
  t.transition("transitionrun", t.dockCardEl, "height");
  t.transition("transitionrun", t.dockCardEl, "width");
  await t.tick(false);
  check("active card transitions keep layout synchronized", t.pendingFrames(), 1);
  t.transition("transitionend", t.dockCardEl, "height");
  await t.tick(false);
  check("another transitioning property keeps tracking alive", t.pendingFrames(), 1);
  t.transition("transitioncancel", t.dockCardEl, "width");
  await t.tick(false);
  check("finished card transitions return layout to idle", t.pendingFrames(), 0);
  t.unload();
  t.notifyResize();
  check("unloaded observers cannot schedule another layout", t.pendingFrames(), 0);
}
// Trace writes from different browser windows share the same ordered queue.
{
  const app = {};
  const first = mk({ "pip-tuck-away.trace": true }, { app, deferTimers: true });
  const second = mk({ "pip-tuck-away.trace": true }, { app, deferTimers: true });
  await second.flushTrace();
  check("concurrent startup logs are never overwritten", (first.traces().match(/browser half loaded/g) ?? []).length, 2);
  first.unload(); second.unload();
}
{
  const t = mk({}, { deferTimers: true });
  await t.tick(false);
  check("tracing is opt-in for a new installation", [t.traces(), t.intervals.filter(Boolean).length], ["", 0]);
  const settings = JSON.parse(fs.readFileSync("preferences.json", "utf8"));
  check("preview rate defaults to 30 fps", settings.find((e) => e.property === "pip-tuck-away.preview-fps").defaultValue, "30");
}

{
  const opts = { deferTimers: true, traceFails: true };
  const t = mk({ "pip-tuck-away.trace": true, "pip-tuck-away.in-widget": false }, opts);
  await t.flushTrace();
  check("trace write errors are recorded", /disk unavailable/.test(t.prefs["pip-tuck-away.trace-error"]), true);
  opts.traceFails = false;
  await t.pipApi().handlePictureInPictureRequest(wgpFor(false), {});
  await t.flushTrace();
  check("a failed write does not poison later queued writes", /request:/.test(t.traces()), true);
}
{
  const t = mk({}, { deferTimers: true, mediaCard: "shown" });
  const video = wgpFor(false, { selected: false, bcId: 302 });
  await t.pipApi().handlePictureInPictureRequest(video, {});
  const before = mirrorActor.sent.length;
  t.setPref("pip-tuck-away.preview-fps", "15");
  check("changing the cap configures the current actor", mirrorActor.sent.slice(before).map((m) => [m.name, m.data.fps]), [["PipMirror:Configure", 15]]);
}

for (const mediaCard of ["absent", "offscreen"]) {
  const t = mk({}, { deferTimers: true, mediaCard, dockCard: true });
  const video = wgpFor(false, { selected: false, bcId: 303 });
  await t.pipApi().handlePictureInPictureRequest(video, {});
  t.controller().mirrorFrame(303, { buf: new ArrayBuffer(16), width: 2, height: 2 });
  t.runTimers();await tick();
  check(`a ${mediaCard} sidebar falls back even after copying pixels`, t.pipCalls.length, 1);
}
{
  const t = mk({}, { deferTimers: true, mediaCard: "absent", dockCard: true, barRect: BAR_AT_BOTTOM });
  const video = wgpFor(false, { selected: false, bcId: 304 });
  await t.pipApi().handlePictureInPictureRequest(video, {});
  t.controller().mirrorFrame(304, { buf: new ArrayBuffer(16), width: 2, height: 2 });
  t.showMediaBar();await t.tick();t.runTimers();await tick();
  check("a toolbar appearing during startup keeps its preview", [!!t.mirror(),t.pipCalls.length], [true,0]);
}
{
  const t = mk({ "zen.mediacontrols.enabled": false }, { deferTimers: true, mediaCard: "shown" });
  await t.pipApi().handlePictureInPictureRequest(wgpFor(false), {});
  check("disabled native media controls use the platform directly", [t.mirror(),t.pipCalls.length], [null,1]);
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  got ${r.actual} want ${r.expected}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
