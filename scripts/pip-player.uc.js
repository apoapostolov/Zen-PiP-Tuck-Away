// PiP Tuck Away: player half.
//
// Runs inside the picture-in-picture player window. Moves that window to a
// screen edge so only a strip stays visible, and brings it back on demand.
//
// Exposes window.__pipTuckAway = { toggle, tuck, untuck, isTucked, destroy }
// so the browser-window half can drive it from a keyboard shortcut.
//
// The screen-edge geometry (sliver width, tuck/return maths) is adapted from
// Zia by z1n-k (MIT), chrome/sine-mods/zia/zia-pip.js. See CREDITS.md.
(() => {
  "use strict";

  if (window.__pipTuckAway) {
    return;
  }

  const PREF_RIGHT_CLICK = "pip-tuck-away.right-click";
  const PREF_SHORTCUT = "pip-tuck-away.shortcut";
  const PREF_HOVER_PEEK = "pip-tuck-away.hover-peek";
  const PREF_AUTO_TUCK = "pip-tuck-away.auto-tuck";
  /** Zia's own tuck switch. This mod replaces that feature, so it must be off. */
  const ZIA_TUCK_PREF = "zia.pip.tuck";

  const SLIVER = 24; // px of window left on screen while tucked
  const MARGIN = 16; // px kept from the screen edge when the window is out
  const GLIDE_MS = 260; // move duration
  const PEEK_GRACE = 380; // ms without pointer movement before a peek retracts

  const root = document.documentElement;

  /** "free" when the whole window is on screen, "tucked" when it is at an edge. */
  let state = "free";
  /** Which edge: "left", "right" or "bottom". */
  let spot = null;
  /** Where the window was before it was first tucked. */
  let home = null;
  let peeked = false;
  let glideId = 0;
  let lastPointerAt = 0;
  let watchdog = null;
  let settleTimers = [];

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

  /** true, false, or undefined when the preference has never been set. */
  const prefState = (name) => {
    try {
      if (Services.prefs.getPrefType(name) === 0) {
        return undefined;
      }
      return Services.prefs.getBoolPref(name);
    } catch (err) {
      return undefined;
    }
  };

  /** True when the node belongs to Zia's picture-in-picture controls. */
  const inZiaUI = (node) => {
    try {
      return !!node?.closest?.("[class*='zia-pip-']");
    } catch (err) {
      return false;
    }
  };

  const log = (message, err) => console.error(`[PiP Tuck Away] ${message}`, err ?? "");

  // ---------- geometry

  const W = () => window.outerWidth || window.innerWidth;
  const H = () => window.outerHeight || window.innerHeight;

  const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));

  const screenBox = () => {
    const s = window.screen;
    const left = Number.isFinite(s.availLeft) ? s.availLeft : 0;
    const top = Number.isFinite(s.availTop) ? s.availTop : 0;
    return { left, top, right: left + s.availWidth, bottom: top + s.availHeight };
  };

  /** The edge the window is closest to. No top edge: macOS refuses to move a window above the screen. */
  const nearestSide = () => {
    const b = screenBox();
    const cx = window.screenX + W() / 2;
    const cy = window.screenY + H() / 2;
    const distance = {
      left: cx - b.left,
      right: b.right - cx,
      bottom: b.bottom - cy,
    };
    return Object.keys(distance).sort((a, z) => distance[a] - distance[z])[0];
  };

  /** Position with only a strip of the window left on screen. */
  const tuckedPos = (name) => {
    const b = screenBox();
    const w = W();
    const h = H();
    let x = clamp(window.screenX, b.left, b.right - w);
    let y = clamp(window.screenY, b.top, b.bottom - h);
    if (name === "left") {
      x = b.left - w + SLIVER;
    } else if (name === "right") {
      x = b.right - SLIVER;
    } else if (name === "bottom") {
      y = b.bottom - SLIVER;
    }
    return [Math.round(x), Math.round(y)];
  };

  /** Position with the whole window back on screen, on the edge it was tucked into. */
  const flushPos = (name) => {
    const b = screenBox();
    const w = W();
    const h = H();
    let x = clamp(window.screenX, b.left, b.right - w);
    let y = clamp(window.screenY, b.top, b.bottom - h);
    if (name === "right") {
      x = b.right - w;
    } else if (name === "left") {
      x = b.left;
    } else if (name === "bottom") {
      y = b.bottom - h;
    }
    return [Math.round(x), Math.round(y)];
  };

  /** Where the window goes when it comes back out by hand. */
  const homePos = () => {
    const b = screenBox();
    const w = W();
    const h = H();
    const at = home || { x: window.screenX, y: window.screenY };
    return [
      Math.round(clamp(at.x, b.left + MARGIN, b.right - w - MARGIN)),
      Math.round(clamp(at.y, b.top + MARGIN, b.bottom - h - MARGIN)),
    ];
  };

  // ---------- movement

  const glide = (x, y, duration = GLIDE_MS, done = null) => {
    const id = ++glideId;
    const fromX = window.screenX;
    const fromY = window.screenY;
    const dx = x - fromX;
    const dy = y - fromY;
    if (!dx && !dy) {
      done?.();
      return;
    }
    const start = performance.now();
    const step = (now) => {
      if (id !== glideId) {
        return;
      }
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 3;
      window.moveTo(Math.round(fromX + dx * eased), Math.round(fromY + dy * eased));
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        done?.();
      }
    };
    requestAnimationFrame(step);
  };

  // ---------- state changes

  const stopPeek = () => {
    peeked = false;
    if (watchdog) {
      clearInterval(watchdog);
      watchdog = null;
    }
  };

  const tuck = (side = null) => {
    if (document.fullscreenElement) {
      return false;
    }
    if (state !== "tucked") {
      home = { x: window.screenX, y: window.screenY };
      spot = null;
    }
    stopPeek();
    spot = side || spot || nearestSide();
    state = "tucked";
    root.setAttribute("pip-tucked", spot);
    glide(...tuckedPos(spot));
    return true;
  };

  const untuck = () => {
    if (state !== "tucked") {
      return false;
    }
    stopPeek();
    state = "free";
    spot = null;
    root.removeAttribute("pip-tucked");
    glide(...homePos());
    return true;
  };

  const toggle = () => (state === "tucked" ? untuck() : tuck());

  /**
   * Tuck with no animation, at the moment the player window is created.
   *
   * Firefox restores the player's last position and size shortly after it
   * opens, which would undo an early move, so the position is re-asserted a
   * few times over the first third of a second. That is also why `home` is
   * left unset here: the coordinates visible this early can be placeholder
   * values, and untucking should land on the screen edge instead.
   */
  const instantTuck = (side) => {
    if (document.fullscreenElement) {
      return false;
    }
    stopPeek();
    spot = side || nearestSide();
    state = "tucked";
    root.setAttribute("pip-tucked", spot);
    glideId++; // cancel anything already in flight
    const settle = () => {
      if (state !== "tucked" || peeked) {
        return;
      }
      // The window has no real size yet while the document is still parsing.
      if (!W() || W() < 50) {
        return;
      }
      window.moveTo(...tuckedPos(spot));
    };
    settle();
    requestAnimationFrame(settle);
    for (const delay of [60, 150, 320]) {
      settleTimers.push(setTimeout(settle, delay));
    }
    return true;
  };

  /** Slide fully into view while the pointer is on the strip. */
  const peek = () => {
    if (state !== "tucked" || peeked || !pref(PREF_HOVER_PEEK, false)) {
      return;
    }
    peeked = true;
    lastPointerAt = Date.now();
    root.setAttribute("pip-peeking", "");
    glide(...flushPos(spot), GLIDE_MS);
    // Safety net: if the player window misses the leave event (it can when the
    // window slides under a stationary pointer), retract after the pointer has
    // been quiet for a while.
    watchdog = setInterval(() => {
      if (!peeked) {
        stopPeek();
        return;
      }
      if (Date.now() - lastPointerAt > PEEK_GRACE) {
        retract();
      }
    }, 100);
  };

  const retract = () => {
    stopPeek();
    root.removeAttribute("pip-peeking");
    if (state === "tucked") {
      glide(...tuckedPos(spot));
    }
  };

  // ---------- events

  const onContextMenu = (event) => {
    if (!pref(PREF_RIGHT_CLICK, true)) {
      return;
    }
    // Zia already uses right-click on its own tuck button to open its picker.
    // Leave anything inside its controls to Zia.
    if (inZiaUI(event.target)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    toggle();
  };

  const onMouseMove = () => {
    lastPointerAt = Date.now();
  };

  const onMouseEnter = () => {
    if (peeked) {
      lastPointerAt = Date.now();
      return;
    }
    peek();
  };

  const onMouseLeave = () => {
    if (peeked) {
      retract();
    }
  };

  const onKeyDown = (event) => {
    if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) {
      return;
    }
    if (event.code !== "KeyT" && event.key?.toLowerCase() !== "t") {
      return;
    }
    if (!pref(PREF_SHORTCUT, true) || event.repeat) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    toggle();
  };

  const onResize = () => {
    // A tuck against the right or bottom edge is measured from the window size.
    if (state === "tucked" && !peeked) {
      window.moveTo(...tuckedPos(spot));
    }
  };

  const onPrefChange = (subject, topic, name) => {
    if (topic !== "nsPref:changed") {
      return;
    }
    if (name === PREF_HOVER_PEEK && !pref(PREF_HOVER_PEEK, false) && peeked) {
      retract();
    }
  };

  document.addEventListener("contextmenu", onContextMenu, true);
  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("mouseenter", onMouseEnter, true);
  document.addEventListener("mouseleave", onMouseLeave, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("resize", onResize);
  Services.prefs.addObserver(PREF_HOVER_PEEK, onPrefChange);

  // Zia can tuck picture-in-picture as well. Two mods moving the same window
  // turn every tuck into a tug of war, so say it once rather than failing
  // quietly. Zia's own controls keep their right-click picker either way.
  if (prefState(ZIA_TUCK_PREF) === true) {
    console.warn(
      "[PiP Tuck Away] Zia's own tuck is still on (zia.pip.tuck = true). " +
        "Two mods are moving the player window. Set zia.pip.tuck to false so this mod owns it."
    );
  }

  // Start tucked rather than showing the player in its normal place first.
  if (pref(PREF_AUTO_TUCK, false)) {
    instantTuck(nearestSide());
  }

  const destroy = () => {
    stopPeek();
    glideId++;
    for (const id of settleTimers) {
      clearTimeout(id);
    }
    settleTimers = [];
    document.removeEventListener("contextmenu", onContextMenu, true);
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("mouseenter", onMouseEnter, true);
    document.removeEventListener("mouseleave", onMouseLeave, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("resize", onResize);
    try {
      Services.prefs.removeObserver(PREF_HOVER_PEEK, onPrefChange);
    } catch (err) {
      log("could not remove the preference observer", err);
    }
    if (state === "tucked") {
      untuck();
    }
    root.removeAttribute("pip-tucked");
    root.removeAttribute("pip-peeking");
    delete window.__pipTuckAway;
  };

  window.__pipTuckAway = { toggle, tuck, untuck, destroy, isTucked: () => state === "tucked" };
  window.addEventListener("unload", destroy, { once: true });
})();
