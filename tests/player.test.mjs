// Headless harness for pip-player.uc.js. Stubs the chrome window, document,
// Services.prefs, a driven requestAnimationFrame and a timer queue, then
// drives the real script and asserts where the window lands.
import fs from "node:fs";
import vm from "node:vm";

const CODE = fs.readFileSync(process.argv[2], "utf8");
const SCREEN = { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1040 };
const SIZE = { w: 380, h: 214 };

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The styles ship as a real file, because the player document blocks inline
// styles outright. Reading it here means the checks run against what is
// actually installed.
const SCRIPT_PATH = process.argv[2];
const REPO_ROOT = dirname(dirname(SCRIPT_PATH));
const SHEET_SOURCE = readFileSync(join(REPO_ROOT, "styles", "player.css"), "utf8");

/** Flatten a stylesheet enough to compare rules as text. */
const flatCss = (css) =>
  css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"/g, "")
    .replace(/\s*\n\s*/g, "")
    .replace(/\s*:\s+/g, ":")
    .replace(/\s*;\s*/g, ";")
    .replace(/\s*\{\s*/g, "{")
    .replace(/\s*}\s*/g, "}")
    .replace(/\s*,\s*/g, ",")
    .replace(/;\}/g, "}");

const SHEET = flatCss(SHEET_SOURCE);

function mk(prefsIn = {}, opts = {}) {
  let fakeNow = 0;
  let fakeWall = Date.now();
  let hover = true;
  let rafQueue = [];
  let intId = 0;
  let timerId = 0;
  const intervals = new Map();
  const timers = new Map();
  const attrs = new Map();
  const dispatched = [];
  const docEvents = Object.create(null);
  const winEvents = Object.create(null);

  const prefs = { ...prefsIn };
  const sheets = [];
  const moves = [];
  const resizes = [];
  const styleElements = [];
  const observers = new Map();
  const warnings = [];

  const target = (store) => ({
    addEventListener(type, fn) {
      (store[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      store[type] = (store[type] || []).filter((f) => f !== fn);
    },
  });

  const fire = (store, type, event = {}) => {
    event.preventDefault ??= () => {
      event.prevented = true;
    };
    event.stopPropagation ??= () => {
      event.stopped = true;
    };
    for (const fn of [...(store[type] || [])]) fn(event);
    return event;
  };

  const appended = [];
  const byId = new Map();

  const matchesTag = (el, sel) => el && el.tagName === sel.toUpperCase();

  const makeElement = (tag) => {
    if (tag === "style") {
      styleElements.push(tag);
    }
    const el = {
      tagName: String(tag).toUpperCase(),
      _id: "",
      className: "",
      textContent: "",
      hidden: false,
      dataset: {},
      attrs: {},
      children: [],
      parent: null,
      _events: {},
      style: {
        props: {},
        setProperty(k, v, prio) {
          this.props[k] = { value: v, priority: prio };
        },
        removeProperty(k) {
          delete this.props[k];
        },
        getPropertyValue(k) {
          return this.props[k]?.value ?? "";
        },
        getPropertyPriority(k) {
          return this.props[k]?.priority ?? "";
        },
      },
      setAttribute(k, v) {
        if (k === "id") {
          el.id = v;
          return;
        }
        el.attrs[k] = String(v);
      },
      getAttribute(k) {
        return k === "id" ? el.id : el.attrs[k] ?? null;
      },
      removeAttribute(k) {
        delete el.attrs[k];
      },
      append(...nodes) {
        for (const node of nodes) {
          node.parent = el;
          el.children.push(node);
        }
      },
      insertBefore(node, ref) {
        node.parent = el;
        const i = el.children.indexOf(ref);
        if (i < 0) el.children.unshift(node);
        else el.children.splice(i, 0, node);
        return node;
      },
      remove() {
        el.removed = true;
        if (el.id) byId.delete(el.id);
        if (el.parent) {
          const i = el.parent.children.indexOf(el);
          if (i >= 0) el.parent.children.splice(i, 1);
          el.parent = null;
        }
      },
      contains(node) {
        let walk = node;
        while (walk) {
          if (walk === el) return true;
          walk = walk.parent;
        }
        return false;
      },
      querySelectorAll(sel) {
        return el.children.filter((child) => matchesTag(child, sel));
      },
      addEventListener(type, fn) {
        (el._events[type] ||= []).push(fn);
      },
      removeEventListener(type, fn) {
        el._events[type] = (el._events[type] || []).filter((f) => f !== fn);
      },
      fire(type, event = {}) {
        event.preventDefault ??= () => {
          event.prevented = true;
        };
        event.stopPropagation ??= () => {
          event.stopped = true;
        };
        for (const fn of [...(el._events[type] || [])]) fn(event);
        return event;
      },
    };
    Object.defineProperty(el, "id", {
      get: () => el._id ?? "",
      set: (v) => {
        if (el._id) byId.delete(el._id);
        el._id = String(v);
        if (el._id) byId.set(el._id, el);
      },
    });
    Object.defineProperty(el, "firstChild", {
      get: () => el.children[0] ?? null,
    });
    return el;
  };

  // The player document's root: the script keeps its whole state in attributes
  // here, so the stub has to write through to the map the assertions read.
  const root = {
    _hover: opts.hover ?? false,
    children: [],
    appendChild(node) {
      node.parent = this;
      this.children.push(node);
      return node;
    },
    querySelectorAll: () => [],
    contains(node) {
      let walk = node;
      while (walk) {
        if (walk === this) return true;
        walk = walk.parent;
      }
      return false;
    },
    remove() {
      this.children.length = 0;
    },
    setAttribute(k, v) {
      attrs.set(k, String(v));
    },
    getAttribute(k) {
      return attrs.get(k) ?? null;
    },
    hasAttribute(k) {
      return attrs.has(k);
    },
    removeAttribute(k) {
      attrs.delete(k);
    },
    toggleAttribute(k, force) {
      const on = force === undefined ? !attrs.has(k) : !!force;
      if (on) attrs.set(k, "");
      else attrs.delete(k);
      return on;
    },
    matches(sel) {
      return sel === ":hover" ? !!hover : false;
    },
    style: {
      props: {},
      setProperty(k, v, prio) {
        this.props[k] = { value: v, priority: prio };
      },
      removeProperty(k) {
        delete this.props[k];
      },
      getPropertyValue(k) {
        return this.props[k]?.value ?? "";
      },
    },
  };

  const controls = makeElement("div");
  // Zen's own minimize button, in the player's corner.
  const minimize = makeElement("div");
  minimize._id = "minimize";
  let lateMinimizeHere = !opts.lateMinimize;
  // Zia's own minimize button, drawn into the player's corner.
  const minimiseNode = makeElement("button");
  minimiseNode._id = "zia-minimise";
  const layerButton = {
    style: {
      props: {},
      setProperty(k, v, prio) {
        this.props[k] = { value: v, priority: prio };
      },
      removeProperty(k) {
        delete this.props[k];
      },
    },
  };
  controls.querySelectorAll = () => [layerButton];
  controls.id = "controls";

  // The video holder, which is what the frost is applied to.
  const holder = {
    style: {
      filter: "",
      removeProperty(k) {
        holder.style[k] = "";
      },
    },
  };

  const document = {
    documentElement: root,
    fullscreenElement: opts.fullscreen ?? null,
    body: root,
    ...target(docEvents),
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, append() {} }),
    createElementNS: (ns, tag) => makeElement(tag),
    createElement: (tag) => makeElement(tag),
    querySelector: (sel) => {
      if (sel === ".player-holder") return holder;
      if (sel.includes("zia-pip-tuck-button")) return opts.ziaButton ? ziaButtonNode : null;
      if (sel.includes("zia-pip-minimise")) {
        return opts.ziaMinimise && !minimiseNode.removed ? minimiseNode : null;
      }
      return null;
    },
    getElementById: (id) =>
      id === "controls"
        ? controls
        : id === "minimize"
          ? (opts.lateMinimize && !lateMinimizeHere) || minimize.removed
            ? null
            : minimize
          : byId.get(id) ?? null,
  };

  const window = {
    screenX: opts.x ?? 100,
    screenY: opts.y ?? 100,
    outerWidth: opts.width ?? SIZE.w,
    outerHeight: opts.height ?? SIZE.h,
    innerWidth: opts.width ?? SIZE.w,
    innerHeight: opts.height ?? SIZE.h,
    screen: SCREEN,
    windowUtils: {
      AUTHOR_SHEET: 1,
      USER_SHEET: 2,
      loadSheetUsingURIString(uri, type) {
        sheets.push({ uri, type });
      },
    },
    moveTo(x, y) {
      window.screenX = x;
      window.screenY = y;
      moves.push([x, y]);
    },
    resizeTo(w, h) {
      window.outerWidth = w;
      window.outerHeight = h;
      resizes.push([w, h]);
    },
    resizeToVideo(rect) {
      window.resizeTo(rect.width, rect.height);
      window.moveTo(rect.left, rect.top);
    },
    Player: {
      resizeToVideo(rect) {
        window.resizeTo(rect.width, rect.height);
        window.moveTo(rect.left, rect.top);
      },
    },
    dispatchEvent(event) {
      dispatched.push(event);
      return true;
    },
    ...target(winEvents),
  };
  window.document = document;

  const sandbox = {
    window,
    document,
    performance: { now: () => fakeNow },
    Services: {
      prefs: {
        getPrefType: (k) => (k in prefs ? 128 : 0),
        getBoolPref: (k) => !!prefs[k],
        getStringPref: (k, fallback = "") => (k in prefs ? String(prefs[k]) : fallback),
        setStringPref: (k, v) => {
          prefs[k] = v;
          observers.get(k)?.({}, "nsPref:changed", k);
        },
        setBoolPref: (k, v) => {
          prefs[k] = v;
          observers.get(k)?.({}, "nsPref:changed", k);
        },
        addObserver: (k, fn) => observers.set(k, fn),
        removeObserver: (k) => observers.delete(k),
      },
    },
    requestAnimationFrame: (cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    },
    cancelAnimationFrame: () => {},
    setInterval: (fn) => {
      intervals.set(++intId, fn);
      return intId;
    },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (fn, ms = 0) => {
      const id = ++timerId;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    console: { ...console, warn: (...args) => warnings.push(args.join(" ")) },
    KeyboardEvent: class KeyboardEvent {
      constructor(type, init) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    Date: { now: () => fakeWall },
    Math,
    Number,
    Object,
    Array,
    String,
    Boolean,
    Error,
    JSON,
    isFinite: Number.isFinite,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox);

  const flush = (max = 300, dt = 20) => {
    for (let i = 0; i < max; i++) {
      if (!rafQueue.length) return i;
      const batch = rafQueue;
      rafQueue = [];
      fakeNow += dt;
      fakeWall += dt;
      for (const cb of batch) cb(fakeNow);
    }
    return max;
  };

  return {
    window,
    doc: document,
    api: window.__pipTuckAway,
    minimizeRemoved: () => !!minimize.removed,
    attrs,
    flush,
    prefs,
    runTimers() {
      const queued = [...timers.entries()].sort((a, b) => a[1].ms - b[1].ms);
      timers.clear();
      lateMinimizeHere = true;
      if (opts.lateZiaMinimise) opts.ziaMinimise = true;
      for (const [, t] of queued) t.fn();
      return queued.length;
    },
    pendingTimers: () => timers.size,
    setPref(k, v) {
      prefs[k] = v;
      observers.get(k)?.(null, "nsPref:changed", k);
    },
    rootStyle: () => root.style.props,
    layerButton,
    getPref: (k) => prefs[k],
    clickPlayer(target = {}, opts = {}) {
      const event = fire(docEvents, "click", { button: 0, detail: 1, target, ...opts });
      this.runTimers();
      return event;
    },
    doubleClickPlayer(target = {}) {
      this.clickPlayer(target);
      return fire(docEvents, "click", { button: 0, detail: 2, target });
    },
    contextMenu(target = {}) {
      return fire(docEvents, "contextmenu", { target });
    },
    mouseEnter(x = 12, y = 40) {
      hover = true;
      return fire(docEvents, "mouseenter", { target: root, clientX: x, clientY: y });
    },
    mouseLeave() {
      // Leaving the window means the document stops reporting hover.
      hover = false;
      return fire(docEvents, "mouseleave", { target: root });
    },
    mouseMove(x = 12, y = 40) {
      hover = true;
      return fire(docEvents, "mousemove", { target: root, clientX: x, clientY: y });
    },
    setHover(value) {
      hover = value;
    },
    advance(ms) {
      fakeWall += ms;
      fakeNow += ms;
    },
    key(event) {
      return fire(winEvents, "keydown", event);
    },
    resize() {
      return fire(winEvents, "resize", {});
    },
    tickIntervals() {
      for (const fn of intervals.values()) fn();
    },
    warnings,
    sheets,
    styleElements,
    sheetUri: () => sheets[0]?.uri ?? null,
    controls,
    docFire: (type, event = {}) => fire(docEvents, type, event),
    winFire: (type, event = {}) => fire(winEvents, type, event),
    bare: () => t.attrsRef?.has?.("pip-tuck-away-bare") ?? false,
    bareStyle: () => ({ textContent: SHEET }),
    holder,
    overlay: () => byId.get("pip-tuck-away-overlay") ?? null,
    button: () => byId.get("pip-tuck-away-button") ?? null,
    picker: () => byId.get("pip-tuck-away-picker") ?? null,
    overlayStyle: () => ({ textContent: SHEET }),
    badge: () => byId.get("pip-tuck-away-badge") ?? null,
    arm: () => byId.get("pip-tuck-away-arm") ?? null,
    tuckStyle: () => ({ textContent: SHEET }),
    pressPicker(side) {
      const button = this.picker()?.children.find((c) => c.dataset?.side === side);
      return button ? button.fire("click") : null;
    },
    dispatched,
    /** Click something inside the player's controls, the way a user would. */
    intervalCount: () => intervals.size,
    pos: () => [window.screenX, window.screenY],
    size: () => [window.outerWidth, window.outerHeight],
    moves,
    resizes,
  };
}

const results = [];
const asText = (value) => {
  try {
    return JSON.stringify(value);
  } catch (err) {
    return `[object ${value?.tagName ?? "value"}]`;
  }
};

const check = (name, actual, expected) => {
  let ok;
  try {
    ok = JSON.stringify(actual) === JSON.stringify(expected);
  } catch (err) {
    // Element nodes carry parent links, so identity is the only comparison.
    ok = actual === expected;
  }
  results.push({ name, ok, actual: asText(actual), expected: asText(expected) });
};

// 1. tuck to the nearest edge (left, from x=100 on a 1920 wide screen)
{
  const t = mk({ "pip-tuck-away.right-click": true });
  t.contextMenu();
  t.flush();
  check("right-click tucks to the nearest edge (left here)", t.pos(), [-356, 100]);
  check("tucked attribute records the edge", t.attrs.get("pip-tucked"), "left");
}

// 1b. sides are preferred: a corner belongs to the side, not to the top
{
  const t = mk({}, { x: 1524, y: 40 });
  t.contextMenu();
  t.flush();
  check("near the top and near the right edge tucks right", t.pos(), [1896, 40]);
  check("and says so", t.attrs.get("pip-tucked"), "right");
}

// 1c. clear of both sides and near the top: a vertical tuck, the top
{
  const t = mk({}, { x: 770, y: 40 });
  t.contextMenu();
  t.flush();
  check("clear of the sides, near the top, tucks top", t.attrs.get("pip-tucked"), "top");
  check("with the strip on the top edge", t.pos(), [770, -190]);
}

// 1d. near the bottom with the top far away: the bottom
{
  const t = mk({}, { x: 770, y: 800 });
  t.contextMenu();
  t.flush();
  check("near the bottom, clear of the sides, tucks bottom", t.attrs.get("pip-tucked"), "bottom");
  check("with the strip on the bottom edge", t.pos(), [770, 1016]);
}

// 1e. the top is preferred when both horizontal edges are about as near
{
  const t = mk({}, { x: 770, y: 300 });
  t.contextMenu();
  t.flush();
  check("sides win when neither horizontal edge is close", t.attrs.get("pip-tucked"), "left");
}

// 1f. a window hanging over an edge belongs to that edge
{
  const left = mk({}, { x: -120, y: 300 });
  left.contextMenu();
  left.flush();
  check("hanging over the left edge tucks left", left.attrs.get("pip-tucked"), "left");

  const right = mk({}, { x: 1560, y: 300 });
  right.contextMenu();
  right.flush();
  check("slightly over the right edge tucks right", right.attrs.get("pip-tucked"), "right");

  const top = mk({}, { x: 700, y: -60 });
  top.contextMenu();
  top.flush();
  check("hanging over the top edge tucks top", top.attrs.get("pip-tucked"), "top");

  const bottom = mk({}, { x: 700, y: 900 });
  bottom.contextMenu();
  bottom.flush();
  check("hanging over the bottom edge tucks bottom", bottom.attrs.get("pip-tucked"), "bottom");
}

// 1g. tuck by drag: a player hung over an edge tucks when the pointer leaves
{
  const t = mk({});
  // dragged so that 120px hang past the right edge
  t.window.screenX = 1660;
  t.tickIntervals();
  check("the edge it hangs over is marked", t.attrs.get("pip-armed"), "right");
  check("and an indicator element exists for it", !!t.arm(), true);
  t.mouseLeave();
  t.flush();
  check("leaving the player tucks that way", t.api.isTucked(), true);
  check("against the right edge", t.pos(), [1896, 100]);
  check("and the mark is gone", t.attrs.has("pip-armed"), false);
}

// 1g2. the indicator sits on the screen edge, not on the window's off-screen end
{
  const t = mk({});
  t.window.screenX = 1660; // 120px past the right edge
  t.tickIntervals();
  check("the indicator is offset by the overhang", t.arm()?.style.props.right, { value: "120px", priority: undefined });
  check("and nothing is set on the other sides", t.arm()?.style.props.left ?? null, null);
}

// 1g3. a drag that ends with the pointer already past the player still tucks
{
  const t = mk({});
  t.window.screenX = 1660; // 120px past the right edge
  t.mouseMove(200, 140); // inside, in client coordinates
  t.tickIntervals();
  check("armed while the pointer is on it", t.attrs.get("pip-armed"), "right");
  check("not tucked while the pointer is inside", t.api.isTucked(), false);
  t.mouseMove(500, 140); // the pointer ends up past the window's right edge
  t.tickIntervals();
  check("a drag that ends outside completes the gesture", t.api.isTucked(), true);
}

// 1h. a player fully on screen is not armed, so leaving it tucks nothing
{
  const t = mk({});
  t.tickIntervals();
  check("nothing armed inside the screen", t.attrs.has("pip-armed"), false);
  t.mouseLeave();
  t.flush();
  check("leaving it does not tuck", t.api.isTucked(), false);
}

// 1i. back inside the screen, the mark clears
{
  const t = mk({});
  t.window.screenX = 1600;
  t.window.screenY = -80;
  t.tickIntervals();
  check("the deeper overhang wins", t.attrs.get("pip-armed"), "top");
  t.window.screenX = 400;
  t.window.screenY = 300;
  t.tickIntervals();
  check("and clears when it comes back", t.attrs.has("pip-armed"), false);
}

// 1j. the setting off means no arming and no tuck on leaving
{
  const t = mk({ "pip-tuck-away.drag-tuck": false });
  t.window.screenX = 1660;
  t.tickIntervals();
  check("no mark with the setting off", t.attrs.has("pip-armed"), false);
  t.mouseLeave();
  t.flush();
  check("and no tuck on leaving", t.api.isTucked(), false);
}

// 2. right-click again brings it back to where it was
{
  const t = mk({ "pip-tuck-away.right-click": true });
  t.contextMenu();
  t.flush();
  t.contextMenu();
  t.flush();
  check("second right-click returns home", t.pos(), [100, 100]);
  check("attribute cleared on return", t.attrs.has("pip-tucked"), false);
}

// 3. explicit edge tucks leave exactly the sliver
{
  const r = mk({});
  r.api.tuck("right");
  r.flush();
  check("right tuck leaves a 24px sliver", r.pos(), [1896, 100]);
  const b = mk({});
  b.api.tuck("bottom");
  b.flush();
  check("bottom tuck leaves a 24px sliver", b.pos(), [100, 1016]);
}

// 4. the chord belongs to the browser half now, so the player ignores keys
{
  const t = mk({ "pip-tuck-away.shortcut": true });
  const ev = t.key({ ctrlKey: true, altKey: true, code: "KeyT", key: "T" });
  t.flush();
  check("player half does not handle the chord", t.api.isTucked(), false);
  check("player half does not claim it", ev.prevented, undefined);
}

// 6. hover peek reveals, and a real departure retracts after the grace period
{
  const t = mk({ "pip-tuck-away.hover-peek": true });
  t.api.tuck("right");
  t.flush();
  t.mouseEnter();
  t.flush();
  check("hover peeks the window flush to the edge", t.pos(), [1540, 100]);
  check("peeking attribute set", t.attrs.has("pip-peeking"), true);
  // Move into the middle of the video first: leaving from the strip itself is
  // the screen-edge case, which is covered on its own below.
  t.mouseMove(200, 40);
  t.mouseLeave();
  t.advance(300);
  t.runTimers();
  t.flush();
  check("leaving the video tucks it back", t.pos(), [1896, 100]);
  check("peeking attribute cleared", t.attrs.has("pip-peeking"), false);
}

// 7. hover peek off (the default) ignores the pointer
{
  const t = mk({});
  t.api.tuck("right");
  t.flush();
  t.mouseEnter();
  t.flush();
  check("peek off leaves it tucked", t.pos(), [1896, 100]);
}

// 8. right-click disabled leaves it alone and does not swallow the menu
{
  const t = mk({ "pip-tuck-away.right-click": false });
  const ev = t.contextMenu();
  t.flush();
  check("right-click off does not tuck", t.api.isTucked(), false);
  check("right-click off does not preventDefault", ev.prevented, undefined);
}

// 9. resize while tucked re-anchors to the edge
{
  const t = mk({});
  t.api.tuck("right");
  t.flush();
  t.window.outerWidth = 500;
  t.resize();
  check("resize re-anchors the tucked window", t.pos(), [1896, 100]);
}

// 10. a pointer resting on the revealed video keeps it revealed
{
  const t = mk({ "pip-tuck-away.hover-peek": true });
  t.api.tuck("right");
  t.flush();
  t.mouseEnter();
  t.flush();
  // No mousemove for a long time: the pointer is simply still.
  t.setHover(true);
  for (let i = 0; i < 20; i++) {
    t.advance(500);
    t.tickIntervals();
  }
  t.flush();
  check("still pointer never collapses the reveal", t.pos(), [1540, 100]);
  check("still revealed after ten seconds", t.attrs.has("pip-peeking"), true);
}

// 10b. hover state lost but the remembered pointer is inside the zone
{
  const t = mk({ "pip-tuck-away.hover-peek": true });
  t.api.tuck("right");
  t.flush();
  t.mouseEnter();
  t.flush();
  t.setHover(false); // the document cannot report hover any more
  t.advance(600);
  t.tickIntervals();
  t.flush();
  check("zone keeps the reveal alive", t.pos(), [1540, 100]);
}

// 10c. a departure during the reveal move does not collapse it instantly
{
  const t = mk({ "pip-tuck-away.hover-peek": true });
  t.api.tuck("right");
  t.flush();
  t.mouseEnter();
  t.mouseMove(200, 40); // away from the edge
  t.mouseLeave(); // mid glide
  t.advance(100);
  t.tickIntervals();
  check("reveal survives a leave during the move", t.attrs.has("pip-peeking"), true);
  t.flush();
  t.advance(400);
  t.tickIntervals();
  t.runTimers();
  t.flush();
  check("and retracts once the move is over", t.attrs.has("pip-peeking"), false);
}

// 10c2. a leave from the strip at the screen edge is not believed
{
  const t = mk({ "pip-tuck-away.hover-peek": true });
  t.api.tuck("right");
  t.flush();
  t.mouseEnter(); // on the 24px strip, 12px from the right edge
  t.flush();
  t.advance(600);
  t.tickIntervals(); // the tucked watcher sees a pointer still there
  t.flush();
  check("strip parked at the edge stays out", t.pos(), [1540, 100]);
  // The edge drops hover state all the time; a leave alone must not hide it.
  t.mouseLeave();
  t.advance(400);
  t.runTimers();
  t.tickIntervals();
  t.flush();
  check("still out after a leave at the edge", t.pos(), [1540, 100]);
  check("still marked as peeking", t.attrs.has("pip-peeking"), true);
}

// 10c3. away from the edge the same leave does hide it
{
  const t = mk({ "pip-tuck-away.hover-peek": true });
  t.api.tuck("right");
  t.flush();
  t.mouseEnter();
  t.mouseMove(200, 40); // 140px from the right edge
  t.flush();
  t.mouseLeave();
  t.advance(400);
  t.runTimers();
  t.flush();
  check("a leave away from the edge hides it", t.pos(), [1896, 100]);
}

// 10c4. a pointer already resting on the strip brings it out on its own
{
  const t = mk({ "pip-tuck-away.hover-peek": true });
  t.api.tuck("right");
  t.flush();
  t.setHover(true); // hovering, but no enter event was ever delivered
  t.advance(400);
  t.tickIntervals();
  t.flush();
  check("the tucked watcher reveals on its own", t.pos(), [1540, 100]);
}

// 10c5. a retract does not snap straight back under the same pointer
{
  const t = mk({ "pip-tuck-away.hover-peek": true });
  t.api.tuck("right");
  t.flush();
  t.mouseEnter();
  t.mouseMove(200, 40);
  t.flush(); // let the reveal finish before the pointer walks off
  t.mouseLeave();
  t.advance(700);
  t.runTimers();
  t.flush();
  check("hidden after the departure", t.pos(), [1896, 100]);
  // The pointer is back on the strip, but the cooldown is still running.
  t.setHover(true);
  t.tickIntervals();
  t.flush();
  check("no instant rebound", t.pos(), [1896, 100]);
  t.advance(300);
  t.tickIntervals();
  t.flush();
  check("and it comes back after the cooldown", t.pos(), [1540, 100]);
}

// 10c6. a hover reveal shows the video bare, with no controls and no dim
{
  const t = mk({ "pip-tuck-away.hover-peek": true });
  t.api.tuck("right");
  t.flush();
  t.mouseEnter(); // resting on the strip
  t.flush();
  check("reveal marked bare", t.attrs.has("pip-tuck-away-bare"), true);
  const css = t.bareStyle()?.textContent ?? "";
  check("controls are zeroed while bare", /control-item\{opacity:0 !important/.test(css), true);
  check("the dim gradient is one of them", css.includes(".control-item"), true);
  check("the cursor still shows", /#controls\{cursor:default !important\}/.test(css), true);
}

// 10c7. moving the pointer keeps it bare; only a left press gives the controls back
{
  const t = mk({ "pip-tuck-away.hover-peek": true });
  t.api.tuck("right");
  t.flush();
  t.mouseEnter(); // screen x = 1908
  t.flush();
  t.mouseMove(12, 48);
  check("a small move keeps it bare", t.attrs.has("pip-tuck-away-bare"), true);
  t.mouseMove(12, 160); // a long sweep
  check("a long move keeps it bare too", t.attrs.has("pip-tuck-away-bare"), true);
  t.mouseMove(200, 90);
  check("even across the whole player", t.attrs.has("pip-tuck-away-bare"), true);
  check("and the peek is still up", t.attrs.has("pip-peeking"), true);
  t.clickPlayer();
  check("a left click brings the controls back", t.attrs.has("pip-tuck-away-bare"), false);
  check("the peek itself survives the click", t.attrs.has("pip-peeking"), true);
}

// 10c7b. presses that are not the left button are left to Firefox
{
  const t = mk({ "pip-tuck-away.hover-peek": true });
  t.api.tuck("right");
  t.flush();
  t.mouseEnter();
  t.flush();
  t.clickPlayer({}, { button: 2 });
  check("a right click alone does not undo the bare look", t.attrs.has("pip-tuck-away-bare"), true);
}

// 10c8. folding away or right-clicking clears the bare state
{
  const t = mk({ "pip-tuck-away.hover-peek": true });
  t.api.tuck("right");
  t.flush();
  t.mouseEnter();
  t.flush();
  check("bare on reveal", t.attrs.has("pip-tuck-away-bare"), true);
  t.mouseMove(200, 40);
  t.flush();
  t.mouseLeave();
  t.advance(700);
  t.runTimers();
  t.flush();
  check("retract clears the bare state", t.attrs.has("pip-tuck-away-bare"), false);

  const u = mk({ "pip-tuck-away.hover-peek": true });
  u.api.tuck("right");
  u.flush();
  u.mouseEnter();
  u.flush();
  u.docFire("contextmenu", { target: {} });
  u.flush();
  check("right-click clears the bare state", u.attrs.has("pip-tuck-away-bare"), false);
}

// 10d. dragging the tucked strip out releases the tuck instead of fighting
{
  const t = mk({ "pip-tuck-away.hover-peek": true });
  t.api.tuck("right");
  t.flush();
  t.window.screenX = 1200; // someone else moved the window
  t.advance(500);
  t.tickIntervals();
  check("drift releases the tuck", t.attrs.has("pip-tucked"), false);
  check("no reveal while free", t.attrs.has("pip-peeking"), false);
}

// 10d2. sliding along the edge stays tucked; pulling into the screen frees it
{
  const t = mk({ "pip-tuck-away.hover-peek": true });
  t.api.tuck("right");
  t.flush();
  t.window.screenY = 420; // dragged along the right edge
  t.advance(500);
  t.tickIntervals();
  check("a slide along the edge keeps it tucked", t.attrs.get("pip-tucked"), "right");
  check("and it stays where it was dragged", t.pos(), [1896, 420]);
}

{
  const t = mk({ "pip-tuck-away.hover-peek": true });
  t.setHover(false); // no peek in the way: this is about the drag
  t.api.tuck("right");
  t.flush();
  t.window.screenX = 1890; // a small wobble, not a pull
  t.advance(500);
  t.tickIntervals();
  check("a nudge does not free it", t.attrs.get("pip-tucked"), "right");
  t.window.screenX = 1700; // pulled well into the screen
  t.tickIntervals();
  check("a pull frees it", t.attrs.has("pip-tucked"), false);
  check("where it was let go", t.pos(), [1700, 100]);
  check("and it is not tucked any more", t.api.isTucked(), false);
}

// 10d3. a peeked player dragged into the screen is left out, not slid back
{
  const t = mk({ "pip-tuck-away.hover-peek": true });
  t.api.tuck("right");
  t.flush();
  t.mouseEnter();
  t.flush();
  check("peeking", t.attrs.has("pip-peeking"), true);
  check("out on screen", t.pos(), [1540, 100]);
  t.window.screenX = 1400; // dragged further into the screen
  t.advance(500);
  t.tickIntervals();
  check("the pull frees it", t.attrs.has("pip-tucked"), false);
  check("out of the peek too", t.attrs.has("pip-peeking"), false);
  check("left where it was let go", t.pos(), [1400, 100]);
  check("and it stays there", (t.tickIntervals(), t.pos()), [1400, 100]);
}

// 10e. fullscreen never reveals
{
  const t = mk({ "pip-tuck-away.hover-peek": true }, { fullscreen: {} });
  t.api.tuck("right");
  t.flush();
  t.mouseEnter();
  t.flush();
  check("no reveal in fullscreen", t.attrs.has("pip-peeking"), false);
}

// 11. turning the hover peek pref off retracts an open peek at once
{
  const t = mk({ "pip-tuck-away.hover-peek": true });
  t.api.tuck("right");
  t.flush();
  t.mouseEnter();
  t.flush();
  t.setPref("pip-tuck-away.hover-peek", false);
  t.flush();
  check("pref off retracts the peek", t.pos(), [1896, 100]);
  check("attribute cleared by the pref change", t.attrs.has("pip-peeking"), false);
}

// 12. auto tuck on: the window is tucked before it is ever shown
{
  const t = mk({ "pip-tuck-away.auto-tuck": true });
  check("auto tuck moved immediately on init", t.pos(), [-356, 100]);
  check("auto tuck marks the edge", t.attrs.get("pip-tucked"), "left");
  check("auto tuck is already tucked", t.api.isTucked(), true);
  check("settle timers scheduled", t.pendingTimers() > 0, true);
}

// 13. auto tuck off: the window stays where the browser put it
{
  const t = mk({});
  check("no auto tuck by default", t.pos(), [100, 100]);
  check("not tucked by default", t.api.isTucked(), false);
  check("only the fixed re-checks are pending", t.pendingTimers(), 6);
}

// 14. auto tuck survives the browser restoring the window position afterwards
{
  const t = mk({ "pip-tuck-away.auto-tuck": true });
  t.window.screenX = 100; // browser puts it back where it remembered
  t.window.screenY = 100;
  t.flush();
  t.runTimers();
  check("position restored after a late browser move", t.pos(), [-356, 100]);
}

// 15. auto tuck waits for a real window size instead of moving blind
{
  const t = mk({ "pip-tuck-away.auto-tuck": true }, { width: 0, height: 0 });
  check("no move without a window size", t.pos(), [100, 100]);
  t.window.outerWidth = SIZE.w;
  t.window.outerHeight = SIZE.h;
  t.flush();
  t.runTimers();
  check("tucks once the size is known", t.pos(), [-356, 100]);
}

// 16. auto tuck is skipped in fullscreen
{
  const t = mk({ "pip-tuck-away.auto-tuck": true }, { fullscreen: {} });
  check("fullscreen is left alone", t.pos(), [100, 100]);
  check("fullscreen not tucked", t.api.isTucked(), false);
}

// 17. untucking after an auto tuck lands on the edge, fully visible
{
  const t = mk({ "pip-tuck-away.auto-tuck": true });
  t.runTimers();
  t.api.untuck();
  t.flush();
  check("untuck from auto tuck lands inside the screen", t.pos(), [16, 100]);
  check("attribute cleared", t.attrs.has("pip-tucked"), false);
}

// 18. auto tuck keeps the hover peek working afterwards
{
  const t = mk({ "pip-tuck-away.auto-tuck": true, "pip-tuck-away.hover-peek": true });
  t.runTimers();
  t.mouseEnter();
  t.flush();
  // Auto tuck picks the left edge here, so the flush position is x=0.
  check("peek still works under auto tuck", t.pos(), [0, 100]);
  t.mouseLeave();
  t.advance(300);
  t.runTimers();
  t.flush();
  check("retracts again", t.pos(), [-356, 100]);
}

// 19. destroy cleans up
{
  const t = mk({});
  t.api.tuck("right");
  t.flush();
  t.api.destroy();
  t.flush();
  check("destroy exposes no api", t.window.__pipTuckAway, undefined);
  check("destroy returns the window home", t.pos(), [100, 100]);
}

// 20. destroy cancels the auto tuck settle timers
{
  const t = mk({ "pip-tuck-away.auto-tuck": true });
  t.api.destroy();
  check("settle timers cancelled", t.pendingTimers(), 0);
}

// 21. a right-click on the tuck button opens the direction map instead of tucking
{
  const t = mk({ "pip-tuck-away.right-click": true });
  const button = t.button();
  check("the button is in the control bar", !!button, true);
  const ev = button.fire("contextmenu", {});
  check("the map opens", t.picker()?.hidden, false);
  check("and the window stayed put", t.api.isTucked(), false);
  check("the press was claimed", ev.prevented, true);
}

// 22. a plain right-click elsewhere still tucks
{
  const t = mk({ "pip-tuck-away.right-click": true });
  t.contextMenu({ closest: () => null });
  t.flush();
  check("plain right-click still tucks", t.api.isTucked(), true);
}

// 23. the button is drawn here, and its chevron follows the tuck side
{
  const t = mk({});
  const button = t.button();
  check("marked as one of the bar's controls", button.className, "control-item pip-tuck-away-button");
  check("it carries a chevron", button.children[0]?.tagName, "SVG");
  check("pointing at the edge it would leave by", button.dataset.side, "left");
  check("and says what it does", button.getAttribute("aria-label"), "Tuck the player away");
}

// 23b. pressing it tucks, and pressing it again brings the player back
{
  const t = mk({});
  const button = t.button();
  const ev = button.fire("click", {});
  t.flush();
  check("pressed tucks", t.api.isTucked(), true);
  check("the press was claimed", ev.prevented, true);
  check("and does not bubble into the bar", ev.stopped, true);
  check("the button says it is away", button.getAttribute("aria-pressed"), "true");
  check("and offers the way back", button.getAttribute("aria-label"), "Bring the player back");
  button.fire("click", {});
  t.flush();
  check("pressed again comes back", t.api.isTucked(), false);
  check("pressed state cleared", button.getAttribute("aria-pressed"), "false");
}

// 23c. the chord and the right-click keep the button honest too
{
  const t = mk({ "pip-tuck-away.right-click": true });
  t.contextMenu({ closest: () => null });
  t.flush();
  check("right-click reflects on the button", t.button().getAttribute("aria-pressed"), "true");
}

// 24. a direction picked from the map is written down and followed
{
  const t = mk({});
  t.button().fire("contextmenu", {});
  const spot = t.picker()?.children.find((c) => c.dataset?.side === "bottom");
  spot.fire("click", {});
  t.flush();
  check("the choice is saved", t.getPref("pip-tuck-away.direction"), "bottom");
  check("the map closes", t.picker()?.hidden, true);
  check("and the button points that way", t.button().dataset.side, "bottom");
}

// 24b. the map still opens from the button when the strip is switched off
{
  const t = mk({ "pip-tuck-away.overlay": false });
  t.button().fire("contextmenu", {});
  check("the map is built on demand", t.picker()?.hidden, false);
  const spot = t.picker()?.children.find((c) => c.dataset?.side === "top");
  spot.fire("click", {});
  t.flush();
  check("and still writes the choice down", t.getPref("pip-tuck-away.direction"), "top");
}

// 31. the frosted glass on a tucked strip is a setting
{
  const t = mk({});
  t.runTimers();
  t.flush();
  check("frosted by default", t.attrs.has("pip-frosted"), true);
  t.api.tuck("right");
  t.flush();
  check("and still frosted when tucked", t.attrs.has("pip-frosted"), true);
  const css = t.overlayStyle()?.textContent ?? "";
  check("the sheet only frosts a strip that asked for it", css.includes(":root[pip-tucked][pip-frosted]"), true);
}

// 31b. off, the strip is plain video, at once
{
  const t = mk({ "pip-tuck-away.frosted": false });
  t.runTimers();
  t.flush();
  check("not frosted", t.attrs.has("pip-frosted"), false);
  t.api.tuck("right");
  t.flush();
  check("and the strip carries no filter", t.attrs.has("pip-frosted"), false);
}

// 31c. switching it on with a player open takes effect without a restart
{
  const t = mk({ "pip-tuck-away.frosted": false });
  t.runTimers();
  t.flush();
  t.api.tuck("right");
  t.flush();
  t.setPref("pip-tuck-away.frosted", true);
  check("frosted now", t.attrs.has("pip-frosted"), true);
  t.setPref("pip-tuck-away.frosted", false);
  check("and plain again", t.attrs.has("pip-frosted"), false);
}

// 33. the player has no state for the widget: its place and its tuck are its own
{
  const code = readFileSync(process.argv[2], "utf8");
  check("no docked state in the player", /pip-docked/.test(code), false);
  check("no dock in its own API", /\bdock\b|isDocked|undock/i.test(code), false);
  const css = readFileSync(join(dirname(process.argv[2]), "..", "styles", "player.css"), "utf8");
  check("and no docked rules in the sheet", /pip-docked/.test(css), false);
  check("while the tuck rules are still there", /:root\[pip-tucked\]/.test(css), true);
}

// 25. nothing else is needed for any of it
{
  const t = mk({});
  t.runTimers();
  check("no inline styles are used, the player blocks them", t.styleElements.length, 0);
  check("the sheet is loaded once", t.sheets.length, 1);
  check("from a chrome file", t.sheetUri(), "chrome://sine/content/pip-tuck-away/styles/player.css");
  check("the button exists with nothing else installed", !!t.button(), true);
  const css = t.overlayStyle()?.textContent ?? "";
  check("only one tuck button is shown", css.includes("#controls .zia-pip-tuck-button{display:none !important}"), true);
  check("and the bar's own button is styled", css.includes("#pip-tuck-away-button{"), true);
}

// 27. destroy leaves no inline style behind, and does not unload the sheet
{
  const t = mk({});
  check("no inline style before destroy", t.styleElements.length, 0);
  t.api.destroy();
  check("no inline style after destroy", t.styleElements.length, 0);
  check("the author sheet is still the window's", t.sheets.length, 1);
}

// ---------- the tuck control overlay

// O1. the strip exists by default, first inside the controls
{
  const t = mk({});
  const overlay = t.overlay();
  check("overlay built", !!overlay, true);
  check("overlay is the first control child", t.controls.children[0], overlay);
  check("overlay label", overlay.children[1].textContent, "Tuck Away");
  check("smart chose the nearest edge (left here)", overlay.dataset.side, "left");
}

// O2. it is a share of the video, not a small pill
{
  const t = mk({});
  const css = t.overlayStyle()?.textContent ?? "";
  check("side strips are 20% wide and 90% tall", /data-side=right\]\{right:0;top:5%;width:20%;height:90%\}/.test(css), true);
  check("top and bottom strips are 90% wide and 20% tall", /data-side=top\]\{top:0;left:5%;width:90%;height:20%\}/.test(css), true);
  check("it is transparent until hovered", /opacity:0\.45/.test(css), true);
  check("each side gets its own arrow", css.includes("data-side=top] .pip-tuck-away-arrow"), true);
}

// O3. clicking it tucks to the side it shows
{
  const t = mk({});
  const ev = t.overlay().fire("click");
  t.flush();
  check("overlay click tucks", t.api.isTucked(), true);
  check("click claimed", ev.prevented, true);
  check("smart tucks to the nearest edge", t.pos(), [-356, 100]);
  check("strip hides while tucked", t.overlay().hidden, true);
}

// O3b. a window in a corner tucks against the corner it is nearest to
{
  // upper right: 1920 - 380 wide, 20 from the top
  const ur = mk({}, { x: 1540, y: 20 });
  ur.flush();
  check("upper right chooses the right edge", ur.overlay().dataset.side, "right");
  ur.overlay().fire("click");
  ur.flush();
  check("and tucks there", ur.pos(), [1896, 20]);
}

{
  // bottom right, the awkward tie: sideways wins
  const br = mk({}, { x: 1540, y: 826 });
  br.flush();
  check("a bottom corner still prefers the side", br.overlay().dataset.side, "right");
}

{
  // top middle: only then does the top edge win
  const tm = mk({}, { x: 770, y: 0 });
  tm.flush();
  check("top middle chooses the top edge", tm.overlay().dataset.side, "top");
}

{
  // a position restored from another display, entirely off screen
  const off = mk({}, { x: 2400, y: 1200 });
  off.advance(400);
  off.runTimers();
  check("an off screen start is pulled back", off.pos(), [1524, 810]);
  check("and it is not read as the bottom edge", off.overlay().dataset.side, "right");
}

{
  const tucked = mk({ "pip-tuck-away.auto-tuck": true }, { x: 2400, y: 1200 });
  tucked.advance(400);
  tucked.runTimers();
  check("a tucked window stays tucked on its edge", tucked.attrs.get("pip-tucked"), "right");
  check("and is not pulled to the middle", tucked.pos(), [1896, 826]);
}

// O2b. the strip stays away while a peek is bare, and comes back on a press
{
  const t = mk({ "pip-tuck-away.hover-peek": true });
  const css = t.overlayStyle()?.textContent ?? "";
  check(
    "the strip hides with the controls during a bare peek",
    css.includes(":root[pip-tuck-away-bare] #pip-tuck-away-overlay:not([hidden]){display:none}"),
    true
  );
  t.api.tuck("right");
  t.flush();
  t.mouseEnter();
  t.flush();
  check("a peek is bare, so the strip is away", t.attrs.has("pip-tuck-away-bare"), true);
  check("and the strip element is hidden outright", t.overlay()?.hidden, true);
  check(
    "with a rule that does not trust the flag",
    css.includes(":root[pip-peeking][pip-tuck-away-bare] #pip-tuck-away-overlay{display:none}"),
    true
  );
  t.clickPlayer();
  check("a click brings it back with the controls", t.attrs.has("pip-tuck-away-bare"), false);
  check("the strip is still put away because the player is tucked", t.overlay()?.hidden, true);
}

// O2c. a bare peek switches the whole control layer off on the element itself
{
  const t = mk({ "pip-tuck-away.hover-peek": true });
  t.api.tuck("right");
  t.flush();
  check("nothing switched off while tucked and quiet", t.controls.style.props.opacity ?? null, null);
  t.mouseEnter();
  t.flush();
  check(
    "the control layer is switched off on the element",
    t.controls.style.props.opacity,
    { value: "0", priority: "important" }
  );
  check("so nothing inside it can show, Zia's parts included", t.controls.style.props.opacity?.priority, "important");
  t.clickPlayer();
  check("a click gives the layer back", t.controls.style.props.opacity ?? null, null);
  check("and hands the controls over", t.attrs.has("pip-controls"), true);
}


// O2d. retracting puts the layer back on its own
{
  const t = mk({ "pip-tuck-away.hover-peek": true });
  t.api.tuck("right");
  t.flush();
  t.mouseEnter();
  t.flush();
  check("off while out", t.controls.style.props.opacity?.value, "0");
  t.mouseMove(200, 40);
  t.flush();
  t.mouseLeave();
  t.advance(900);
  t.runTimers();
  t.flush();
  check("back on when it tucks away", t.controls.style.props.opacity ?? null, null);
}

// O3c. the tucked strip wears a chevron badge and a frosted video
{
  const t = mk({});
  const badge = t.badge();
  check("badge built", !!badge, true);
  const css = t.tuckStyle()?.textContent ?? "";
  check("the video frosts while tucked", css.includes(".player-holder{filter:blur(16px) brightness(0.85)}"), true);
  check("the frost is only for a tucked strip that asked for it", css.includes(":root[pip-tucked][pip-frosted]:not([pip-peeking]) .player-holder"), true);
  check(
    "the controls go transparent while tucked, so the strip stays a hit target",
    css.includes(":root[pip-tucked]:not([pip-peeking]) #controls{opacity:0 !important}"),
    true
  );
  check(
    "their buttons cannot be pressed blind",
    css.includes(":root[pip-tucked]:not([pip-peeking]) #controls button") && css.includes("pointer-events:none !important"),
    true
  );
  check("and the badge never swallows the press", css.includes("pointer-events:none"), true);
  check(
    "the badge covers the strip, at whatever width the setting gives",
    css.includes(":root[pip-tucked=right] #pip-tuck-away-badge{left:0;top:0;bottom:0;width:var(--pip-sliver,24px)}"),
    true
  );
  check("and points back out", css.includes(":root[pip-tucked=right] #pip-tuck-away-badge::after{transform:rotate(-45deg)}"), true);
  check("the badge steps aside for a peek", css.includes(":root[pip-peeking] #pip-tuck-away-badge{display:none}"), true);
}

// O3d. a click on the strip brings the player out, and the badge takes no events
{
  const t = mk({}); // hover peek off: a click is the only way in
  t.api.tuck("right");
  t.flush();
  check("tucked first", t.api.isTucked(), true);
  check("the badge cannot be the target of the press", t.badge()?.style?.pointerEvents ?? "css", "css");
  t.clickPlayer(t.controls);
  check("a click brings it out even with hover peek off", t.attrs.has("pip-peeking"), true);
  check("still tucked, just out on the screen", t.api.isTucked(), true);
}

// O3e. a peek is never frosted, and a press hands the controls over
{
  const t = mk({ "pip-tuck-away.hover-peek": true });
  t.api.tuck("right");
  t.flush();
  check("tucked players are frosted by the style sheet", t.holder.style.filter, "");
  t.mouseEnter();
  t.flush();
  check("a peek clears the frost on the element", t.holder.style.filter, "none");
  check("and the style sheet agrees", (t.tuckStyle()?.textContent ?? "").includes(":root[pip-peeking] .player-holder{filter:none !important}"), true);
  check("no controls on the way in", t.attrs.has("pip-controls"), false);
  t.mouseMove(20, 60);
  t.mouseMove(60, 120);
  check("moving never brings the controls", t.attrs.has("pip-controls"), false);
  check("and the video stays bare", t.attrs.has("pip-tuck-away-bare"), true);
  t.clickPlayer();
  check("a left click hands the controls over", t.attrs.has("pip-controls"), true);
  check("and un-bares the video", t.attrs.has("pip-tuck-away-bare"), false);
  t.advance(3000);
  t.runTimers();
  check("the hand-over holds while the pointer stays", t.attrs.has("pip-controls"), true);
  t.setHover(false);
  t.mouseLeave();
  t.advance(3000);
  t.runTimers();
  check("and ends when the pointer goes", t.attrs.has("pip-controls"), false);
}

// 11a. a press on a bare peek shows the controls at once
{
  const t = mk({ "pip-tuck-away.hover-peek": true });
  t.api.tuck("right");
  t.flush();
  t.mouseEnter();
  t.flush();
  check("a bare peek is up", t.attrs.has("pip-tuck-away-bare"), true);
  const event = t.docFire("click", { button: 0, detail: 1, target: t.controls });
  check("the controls come at once", t.attrs.has("pip-controls"), true);
  check("and the video is not bare any more", t.attrs.has("pip-tuck-away-bare"), false);
  check("the press itself is untouched", event.prevented ?? false, false);
  check(
    "the layer's own buttons stay inert, so a second press still reaches the layer",
    t.layerButton.style.props["pointer-events"],
    { value: "none", priority: "important" }
  );
  t.runTimers();
  check("and they come back after the arbitration window", t.layerButton.style.props["pointer-events"] ?? null, null);
}

// 11a2. a second press inside the window is left to the player
{
  const t = mk({ "pip-tuck-away.hover-peek": true });
  t.api.tuck("right");
  t.flush();
  t.mouseEnter();
  t.flush();
  t.docFire("click", { button: 0, detail: 1, target: t.controls });
  const second = t.docFire("click", { button: 0, detail: 2, target: t.controls });
  check("the second press is left for the player", second.prevented ?? false, false);
  check("and not stopped", second.stopped ?? false, false);
  t.runTimers();
  check("the buttons come back", t.layerButton.style.props["pointer-events"] ?? null, null);
}

// 16a. the strip paints nothing over the video, at rest or on hover
{
  const t = mk({});
  const css = t.tuckStyle()?.textContent ?? "";
  check(
    "the hover state has no wash",
    css.includes("#pip-tuck-away-overlay:hover,#pip-tuck-away-overlay:focus-visible{opacity:1;background:transparent;outline:none}"),
    true
  );
  check("and no dark glass anywhere on the strip", css.includes("rgba(0,0,0,0.3)"), false);
  check("while the rest state is transparent too", css.includes("#pip-tuck-away-overlay{"), true);
  check("with assets that are only an arrow and a label", css.includes("text-shadow"), true);
}

// 15a. a press on the video itself is the drag region, and shows the controls
{
  const t = mk({ "pip-tuck-away.hover-peek": true });
  t.api.tuck("right");
  t.flush();
  t.mouseEnter();
  t.flush();
  check("bare first", t.attrs.has("pip-tuck-away-bare"), true);
  t.docFire("draggableregionleftmousedown", {});
  check("a press anywhere on the frame shows the controls", t.attrs.has("pip-controls"), true);
  check("and the video is not bare", t.attrs.has("pip-tuck-away-bare"), false);
  t.runTimers();
}

// 15b. the same press on a tucked strip brings the player out
{
  const t = mk({});
  t.api.tuck("right");
  t.flush();
  t.docFire("draggableregionleftmousedown", {});
  check("nothing happens before the press is known to be single", t.attrs.has("pip-peeking"), false);
  t.runTimers();
  check("then the player is out", t.attrs.has("pip-peeking"), true);
}

// 15c. a press that turns into a drag does not reveal anything
{
  const t = mk({});
  t.api.tuck("right");
  t.flush();
  t.docFire("draggableregionleftmousedown", {});
  t.window.screenY = 400; // the pointer dragged the window
  t.runTimers();
  check("a drag is not a click", t.attrs.has("pip-peeking"), false);
}

// 11b. a double click on the strip is the player's gesture, untouched
{
  const t = mk({});
  t.api.tuck("right");
  t.flush();
  const event = t.docFire("dblclick", { target: t.controls });
  check("the double click passes through", event.prevented ?? false, false);
  check("nobody stopped it", event.stopped ?? false, false);
  check("and nothing moved", t.api.isTucked(), true);
}

// 11c. a click on the strip is a request for the player, not a hover accident
{
  const t = mk({}); // hover peek off: geometry alone would never bring it out
  t.api.tuck("right");
  t.flush();
  t.clickPlayer(t.controls);
  check("the player comes out on a click", t.attrs.has("pip-peeking"), true);
  check("with no controls yet", t.attrs.has("pip-controls"), false);
  check("and the video is bare", t.attrs.has("pip-tuck-away-bare"), true);
  t.advance(600);
  t.clickPlayer(t.controls);
  check("a second click asks for the controls", t.attrs.has("pip-controls"), true);
  check("and un-bares the video", t.attrs.has("pip-tuck-away-bare"), false);
}

// 17a. an auto tuck starts from the remembered place, not from the spawn point
{
  // The remembered place is where the user left it; the spawn is wherever the
  // platform restored the window, which after a tucked close is mostly off screen.
  const t = mk({ "pip-tuck-away.auto-tuck": true, "pip-tuck-away.home": "1122,75" }, { x: 1896, y: 826 });
  t.runTimers();
  t.flush();
  t.tickIntervals();
  const spot = t.api.stats().spot;
  const [x, y] = t.pos();
  check("auto tucked", t.api.isTucked(), true);
  check("the strip does not land in the corner the platform restored", spot !== null, true);
  check(
    "the strip is anchored at the remembered place",
    spot === "top" || spot === "bottom" ? Math.abs(x - 1122) <= 1 : Math.abs(y - 75) <= 1,
    true
  );
  check("and the memory itself is untouched", String(t.getPref("pip-tuck-away.home")), "1122,75");
}

// 14a. a player that opens where Firefox saved a tucked position goes home
{
  const t = mk({ "pip-tuck-away.home": "700,300" }, { x: 1896, y: 826 });
  t.runTimers();
  t.flush();
  check("the player opens at the remembered place", t.pos(), [700, 300]);
  t.tickIntervals();
  check("and the memory is not overwritten by a rescue", String(t.getPref("pip-tuck-away.home")), "700,300");
}

// 14b. the platform's late restore does not steal the place back
{
  const t = mk({ "pip-tuck-away.home": "700,300" }, { x: 700, y: 300 });
  t.runTimers();
  t.flush();
  t.setHover(false);
  t.window.screenX = 1896; // the platform puts back the tucked geometry
  t.window.screenY = 826;
  t.tickIntervals();
  check("the remembered place is put back", t.pos(), [700, 300]);
  check("and it is still the remembered place", String(t.getPref("pip-tuck-away.home")), "700,300");
}

// 14c. a rescue is never mistaken for a place the user chose
{
  const t = mk({}, { x: 1896, y: 826 }); // nothing remembered, mostly off screen
  t.runTimers();
  t.flush();
  check("the window is rescued somewhere usable", t.pos(), [1524, 810]);
  t.tickIntervals();
  t.advance(400);
  t.tickIntervals();
  check("but the rescue is not written down", t.getPref("pip-tuck-away.home") ?? null, null);
}

// 13a. a strip slid along its edge is remembered where it was put
{
  const t = mk({});
  t.runTimers();
  t.flush();
  t.api.tuck("right");
  t.flush();
  t.advance(600);
  t.window.screenY = 420;
  t.tickIntervals();
  check("the tuck survives the slide", t.attrs.get("pip-tucked"), "right");
  // The place worth keeping is where the player would sit if it were free: the
  // spot along the edge it was slid to, and the x it came from.
  check("and the new spot is written down", String(t.getPref("pip-tuck-away.home")), "100,420");
}

// 13b. a free player's place is remembered without waiting for a close
{
  const t = mk({});
  t.runTimers();
  t.flush();
  t.window.screenX = 700;
  t.window.screenY = 300;
  t.tickIntervals();
  check("a plain move is written down", String(t.getPref("pip-tuck-away.home")), "700,300");
  check("and nothing tucked it", t.api.isTucked(), false);
}

// 13c. a tucked player carried onto another edge changes its tuck
{
  const t = mk({});
  t.runTimers();
  t.flush();
  t.api.tuck("right");
  t.flush();
  t.advance(600);
  t.window.screenX = -300; // dropped past the left edge
  t.tickIntervals();
  check("it does not fall free in the middle of the screen", t.api.isTucked(), true);
  check("it tucks into the edge it was taken to", t.attrs.get("pip-tucked"), "left");
  t.flush();
  check("and sits against that edge", t.pos(), [-356, 100]);
}

// 13d. the same when it was carried out of a peek
{
  const t = mk({ "pip-tuck-away.hover-peek": true });
  t.runTimers();
  t.flush();
  t.api.tuck("right");
  t.flush();
  t.mouseEnter();
  t.flush();
  check("peeking first", t.pos(), [1540, 100]);
  t.advance(600);
  t.window.screenX = -300;
  t.tickIntervals();
  check("a dragged peek re-tucks rather than freeing", t.attrs.get("pip-tucked"), "left");
  check("and the peek is over", t.attrs.has("pip-peeking"), false);
}

// 13e. a peek dragged into the screen still frees the player where it lands
{
  const t = mk({ "pip-tuck-away.hover-peek": true });
  t.runTimers();
  t.flush();
  t.api.tuck("right");
  t.flush();
  t.mouseEnter();
  t.flush();
  t.advance(600);
  t.window.screenX = 1200; // inside the screen, hanging over nothing
  t.tickIntervals();
  check("it goes free", t.api.isTucked(), false);
  t.flush();
  check("where it was let go", t.pos(), [1200, 100]);
  check("and that place is remembered", String(t.getPref("pip-tuck-away.home")), "1200,100");
}

// 12a. the strip width is a setting, and the geometry follows it// 12a. the strip width is a setting, and the geometry follows it
{
  const t = mk({ "pip-tuck-away.width": "wide" });
  check("the sheet is told the width", t.rootStyle()["--pip-sliver"], { value: "48px", priority: undefined });
  t.api.tuck("right");
  t.flush();
  check("a wide strip leaves 48px on screen", t.pos(), [1872, 100]);
}

{
  const t = mk({ "pip-tuck-away.width": "very-wide" });
  t.api.tuck("left");
  t.flush();
  check("the widest strip leaves 72px of the video out", t.pos(), [-380 + 72, 100]);
}

{
  const t = mk({ "pip-tuck-away.width": "very-wide" });
  t.api.tuck("bottom");
  t.flush();
  check("and on a horizontal edge it is a tall strip", t.pos(), [100, 1040 - 72]);
}

{
  const t = mk({});
  check("normal is the default width", t.rootStyle()["--pip-sliver"], { value: "24px", priority: undefined });
}

// 12b. changing the width re-anchors a player that is already tucked
{
  const t = mk({});
  t.api.tuck("right");
  t.flush();
  check("tucked at the narrow width", t.pos(), [1896, 100]);
  t.setPref("pip-tuck-away.width", "wide");
  t.flush();
  check("and it moves to the new width at once", t.pos(), [1872, 100]);
  check("the sheet follows too", t.rootStyle()["--pip-sliver"]?.value, "48px");
}

// 12c. a value nobody recognises falls back to normal
{
  const t = mk({ "pip-tuck-away.width": "enormous" });
  t.api.tuck("right");
  t.flush();
  check("an unknown width is ignored", t.pos(), [1896, 100]);
}

// 11b2. a fullscreen round trip does not free a tucked player
{
  const t = mk({});
  t.api.tuck("right");
  t.flush();
  t.doc.fullscreenElement = {};
  t.window.outerWidth = 1920;
  t.window.outerHeight = 1080;
  t.advance(500);
  t.tickIntervals();
  check("fullscreen is not a drag", t.attrs.get("pip-tucked"), "right");
  t.doc.fullscreenElement = null;
  t.window.outerWidth = 380;
  t.window.outerHeight = 214;
  t.advance(500);
  t.tickIntervals();
  check("and it is still tucked afterwards", t.attrs.get("pip-tucked"), "right");
}

// 11d. a click on a real control is not the mod's business
{
  const t = mk({});
  t.api.tuck("right");
  t.flush();
  const button = { closest: (selector) => (String(selector).includes("button") ? {} : null) };
  t.clickPlayer(button);
  check("a press on a control does not bring the player out", t.attrs.has("pip-peeking"), false);
}

// O3f. folding away takes the frost clearing with it
{
  const t = mk({ "pip-tuck-away.hover-peek": true });
  t.api.tuck("right");
  t.flush();
  t.mouseEnter();
  t.flush();
  check("cleared while out", t.holder.style.filter, "none");
  t.mouseMove(200, 40);
  t.flush();
  t.mouseLeave();
  t.advance(900);
  t.runTimers();
  t.flush();
  check("frost returns when it tucks back", t.holder.style.filter, "");
  check("and no controls are left showing", t.attrs.has("pip-controls"), false);
}

// O3g. the button sits in the bar with the overlay, and neither hides the other
{
  const t = mk({});
  t.advance(1200);
  t.runTimers();
  const controls = t.controls;
  const button = t.button();
  check("the button is in the bar", controls.children.includes(button), true);
  check("the strip is still there beside it", controls.children.includes(t.overlay()), true);
  check("the bar keeps its own items first", controls.children[0], t.overlay());
}

// O3h. the player remembers where it was parked
{
  // closing while out keeps the live position
  const t = mk({});
  t.window.screenX = 700;
  t.window.screenY = 300;
  t.winFire("unload");
  check("an open player saves its own place", t.prefs["pip-tuck-away.home"], "700,300");
}

{
  // closing while tucked keeps the place it came from, not the tuck
  const t = mk({});
  t.window.screenX = 700;
  t.window.screenY = 300;
  t.api.tuck("right");
  t.flush();
  check("tucked away", t.pos(), [1896, 300]);
  t.winFire("unload");
  check("a tucked player saves the place it came from", t.prefs["pip-tuck-away.home"], "700,300");
}

{
  // a new player opens where the last one was parked
  const t = mk({ "pip-tuck-away.home": "700,300" }, { x: 1524, y: 810 });
  t.advance(400);
  t.runTimers();
  check("the remembered place is used", t.pos(), [700, 300]);
}

{
  // and a remembered place from another screen is pulled inside this one
  const t = mk({ "pip-tuck-away.home": "9000,9000" }, { x: 300, y: 300 });
  t.advance(400);
  t.runTimers();
  check("a remembered place off screen is clamped", t.pos(), [1524, 810]);
}

// O4. a chosen direction wins over smart
{
  const right = mk({ "pip-tuck-away.direction": "right" });
  check("right chosen on the strip", right.overlay().dataset.side, "right");
  right.overlay().fire("click");
  right.flush();
  check("right tuck", right.pos(), [1896, 100]);

  const top = mk({ "pip-tuck-away.direction": "top" });
  check("top chosen on the strip", top.overlay().dataset.side, "top");
  top.overlay().fire("click");
  top.flush();
  check("top tuck leaves a strip at the top", top.pos(), [100, -190]);

  const bottom = mk({ "pip-tuck-away.direction": "bottom" });
  bottom.overlay().fire("click");
  bottom.flush();
  check("bottom tuck", bottom.pos(), [100, 1016]);
}

// O5. right-click offers the directions, the way Zia's picker does
{
  const t = mk({});
  const ev = t.overlay().fire("contextmenu");
  check("picker opened", t.picker().hidden, false);
  check("right-click claimed", ev.prevented, true);
  const labels = t.picker().children.filter((c) => c.tagName === "BUTTON").map((c) => c.textContent);
  check("every direction offered", labels, ["Top", "Left", "Smart", "Right", "Bottom"]);
  check("smart marked as current", t.picker().children.find((c) => c.dataset?.side === "smart").attrs["aria-pressed"], "true");
}

// O6. picking a direction saves it, moves the strip, and closes the picker
{
  const t = mk({});
  t.overlay().fire("contextmenu");
  t.pressPicker("right");
  check("direction saved", t.prefs["pip-tuck-away.direction"], "right");
  check("strip moved to the chosen side", t.overlay().dataset.side, "right");
  check("picker closed after the choice", t.picker().hidden, true);
  t.overlay().fire("click");
  t.flush();
  check("and the strip now tucks that way", t.pos(), [1896, 100]);
}

// O7. clicking outside the picker closes it
{
  const t = mk({});
  t.overlay().fire("contextmenu");
  t.docFire("mousedown", { target: {} });
  check("picker closes on an outside press", t.picker().hidden, true);
}

// O8. the switch takes the strip away entirely
{
  const t = mk({ "pip-tuck-away.overlay": false });
  check("no strip when switched off", t.overlay(), null);
  t.setPref("pip-tuck-away.overlay", true);
  check("strip returns when switched on", !!t.overlay(), true);
  t.setPref("pip-tuck-away.overlay", false);
  check("strip goes away again", t.overlay(), null);
}

// O9. coming back out brings the strip back
{
  const t = mk({});
  t.api.tuck("left");
  t.flush();
  check("hidden while tucked", t.overlay().hidden, true);
  t.api.untuck();
  t.flush();
  check("shown when it comes back", t.overlay().hidden, false);
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  got ${r.actual} want ${r.expected}`}`);
}
// ---------- how a player opens: the size and place settings

// 100. Remember Last is the default, so nothing is touched
{
  const t = mk({});
  check("a player opens at the size the platform restored", t.size(), [SIZE.w, SIZE.h]);
  check("with no size imposed", t.resizes, []);
  check("and no place imposed", t.api.place().want, null);
  check("so it is left free where the platform put it", t.api.isTucked(), false);
}

// 101. a chosen size is applied, keeping the video's own shape
{
  const t = mk({ "pip-tuck-away.size": "very-small" });
  check("the player opens very small", t.size(), [200, 113]);
  check("by being resized, not by luck", t.resizes.at(-1), [200, 113]);
  check("and the video is not stretched", Math.abs(200 / 113 - SIZE.w / SIZE.h) < 0.02, true);
}

// 101b. choosing Remember Last explicitly is the same as never touching it
{
  const t = mk({ "pip-tuck-away.size": "remember", "pip-tuck-away.place": "remember" });
  check("no size is imposed", t.resizes, []);
  check("nothing is tucked", t.api.isTucked(), false);
  check("and the player keeps the place the platform gave it", t.pos(), [100, 100]);
}

// 102. every size on the ladder
{
  for (const [choice, width] of [
    ["small", 280],
    ["medium", 380],
    ["large", 520],
    ["very-large", 680],
  ]) {
    const t = mk({ "pip-tuck-away.size": choice });
    check(`${choice} is ${width} wide`, t.size()[0], width);
    check(
      `and keeps the video's shape at ${choice}`,
      Math.abs(t.size()[0] / t.size()[1] - SIZE.w / SIZE.h) < 0.02,
      true
    );
  }
}

// 103. a window that would end up off screen comes back on
{
  const t = mk({ "pip-tuck-away.size": "very-large" }, { x: 1800, y: 100 });
  check("the window comes back on screen", t.pos(), [1920 - 680 - 16, 100]);
}

// 104. a chosen place is where the strip lives, and it is always tucked
{
  const t = mk({ "pip-tuck-away.place": "bottom-right" });
  t.flush();
  check("the strip lives in the bottom right corner", t.api.place().home, {
    x: 1920 - SIZE.w - 16,
    y: 1040 - SIZE.h - 16,
  });
  check("the player is tucked without being asked to auto tuck", t.api.isTucked(), true);
  check("on the edge it hangs over", t.attrs.get("pip-tucked"), "right");
  check("and the place is written down, so it survives a restart", t.getPref("pip-tuck-away.home"), "1524,810");
}

// 105. the middles tuck to the flat edges
{
  const top = mk({ "pip-tuck-away.place": "top-middle" });
  top.flush();
  check("top middle sits centred on the top edge", top.api.place().home, {
    x: Math.round((1920 - SIZE.w) / 2),
    y: 16,
  });
  check("and tucks to the top", top.attrs.get("pip-tucked"), "top");
  const bottom = mk({ "pip-tuck-away.place": "bottom-middle" });
  bottom.flush();
  check("bottom middle sits centred on the bottom edge", bottom.api.place().home, {
    x: Math.round((1920 - SIZE.w) / 2),
    y: 1040 - SIZE.h - 16,
  });
  check("and tucks to the bottom", bottom.attrs.get("pip-tucked"), "bottom");
}

// 106. a corner tucks into the side edge it is nearest
{
  const t = mk({ "pip-tuck-away.place": "top-left" });
  t.flush();
  check("top left tucks to the left edge", t.attrs.get("pip-tucked"), "left");
  check("at the top of it", t.api.place().home, { x: 16, y: 16 });
}

// 107. choosing a place while the player is free tucks it at once
{
  const t = mk({});
  check("free to begin with", t.api.isTucked(), false);
  t.setPref("pip-tuck-away.place", "top-right");
  t.flush();
  check("a place chosen later tucks the player", t.api.isTucked(), true);
  check("in the corner it names", t.api.place().home, { x: 1920 - SIZE.w - 16, y: 16 });
}

// 108. a size chosen later resizes the player where it stands
{
  const t = mk({}, { x: 400, y: 300 });
  t.setPref("pip-tuck-away.size", "small");
  check("the player takes the size", t.size(), [280, 158]);
  check("and stays where it was", t.pos(), [400, 300]);
}


// ---------- a video swap keeps the player's place

// 115. YouTube's next video resizes the player but does not send it to the corner
{
  const t = mk({}, { x: 700, y: 300 });
  t.window.resizeToVideo({ left: 1524, top: 810, width: 480, height: 270 });
  check("the next video is given its own size", t.size(), [480, 270]);
  check("and the player stays where it was", t.pos(), [700, 300]);
  check("the platform's own bottom-right park is ignored", t.pos()[0] !== 1524, true);
}

// 116. a tucked player keeps its strip through a video swap
{
  const t = mk({ "pip-tuck-away.auto-tuck": true, "pip-tuck-away.home": "700,300" }, { x: 700, y: 300 });
  t.flush();
  check("tucked to begin with", t.api.isTucked(), true);
  const before = t.pos();
  t.window.resizeToVideo({ left: 1524, top: 810, width: 480, height: 270 });
  check("the strip is still on its edge", t.api.isTucked(), true);
  check("and it did not jump to the bottom right", t.pos()[0] !== 1524, true);
  check("the place it came from is still remembered", String(t.getPref("pip-tuck-away.home")), "700,300");
  check("the strip moved only as much as the new size asked", t.pos()[1], before[1]);
}

// 117. a player near the right edge is clamped back on screen, not parked
{
  const t = mk({}, { x: 1600, y: 100, width: 380, height: 214 });
  t.window.resizeToVideo({ left: 1524, top: 810, width: 480, height: 270 });
  check("it grew to the next video's size", t.size(), [480, 270]);
  check("and stayed on screen rather than hanging off it", t.pos(), [1920 - 480 - 16, 100]);
}

// ---------- Zia's minimize button, and Zia's tuck against our peek

// 109. with no Zia in the player there is nothing to take out
{
  const t = mk({});
  check("nothing was there to remove", t.getPref("pip-tuck-away.minimize"), "absent");
}

// 110. Zia's own minimize button is taken out of the document
{
  const t = mk({}, { ziaMinimise: true });
  check("the button is gone", t.doc.querySelector(".zia-pip-minimise"), null);
  check("and that is written down", t.getPref("pip-tuck-away.minimize"), "removed");
  check("while Zia's tuck button is left alone", !!t.doc.querySelector(".zia-pip-tuck-button"), false);
}

// 111. a button Zia builds late goes too
{
  const t = mk({}, { lateZiaMinimise: true });
  t.runTimers();
  check("the late button is removed as well", t.getPref("pip-tuck-away.minimize"), "removed");
}

// 112. the platform's own minimize is left alone: Zia clicks it
{
  const source = fs.readFileSync(process.argv[2], "utf8");
  check("nothing removes the platform's #minimize", /getElementById\("minimize"\)[\s\S]{0,80}remove\(\)/.test(source), false);
}

// 113. Zia's tuck is held off while our peek is open, and handed back after
{
  const t = mk({ "pip-tuck-away.hover-peek": true, "zia.pip.tuck": true });
  check("Zia's tuck is on to begin with", t.getPref("zia.pip.tuck"), true);
  t.api.tuck("right");
  t.flush();
  t.mouseEnter();
  t.flush();
  check("the peek is open", t.attrs.has("pip-peeking"), true);
  check("and Zia's tuck is held off so it cannot snap the reveal shut", t.getPref("zia.pip.tuck"), false);
  check("with the user's own value remembered", t.api.ziaTuckHeld(), true);
  t.mouseMove(200, 40);
  t.mouseLeave();
  t.advance(300);
  t.runTimers();
  t.flush();
  check("the peek is closed", t.attrs.has("pip-peeking"), false);
  check("and Zia's tuck is handed back as it was", t.getPref("zia.pip.tuck"), true);
  check("with nothing left held", t.api.ziaTuckHeld(), null);
}

// 114. a player with Zia absent changes nothing about Zia
{
  const t = mk({ "pip-tuck-away.hover-peek": true });
  t.api.tuck("right");
  t.flush();
  t.mouseEnter();
  t.flush();
  check("no Zia setting is invented", t.getPref("zia.pip.tuck"), undefined);
  check("and none is held", t.api.ziaTuckHeld(), null);
}


console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
