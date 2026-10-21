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
  // Hover peek. The pointer can rest still on the revealed video while the
  // window moves underneath it, so departures are judged from a screen-space
  // zone around the revealed player plus the document's own hover state.
  // Pointer idleness is never used as a signal: that is what made the reveal
  // collapse after a moment of stillness.
  const PEEK_GRACE = 220; // a departure shorter than this is ignored
  const PEEK_SETTLE = 280; // departures during the reveal move are ignored
  const PEEK_POLL = 90; // how often the zone is re-checked while revealed
  const PEEK_ZONE = 28; // screen-space margin around the revealed player
  const PEEK_STALE = 30000; // how long a remembered pointer position is trusted
  const DRIFT_PX = 3; // movement by anyone else that counts as a drag

  const root = document.documentElement;

  /** "free" when the whole window is on screen, "tucked" when it is at an edge. */
  let state = "free";
  /** Which edge: "left", "right" or "bottom". */
  let spot = null;
  /** Where the window was before it was first tucked. */
  let home = null;
  let peeked = false;
  let glideId = 0;
  let animating = false;
  let settleUntil = 0;
  let revealing = false;
  let settleTimers = [];
  let ziaWarned = false;
  let leaveTimer = null;
  let pollTimer = null;
  let driftTimer = null;
  /** Screen coordinates of the pointer at its last event, so window moves cannot invalidate them. */
  let pointer = { x: 0, y: 0, at: 0 };

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
    const finish = () => {
      animating = false;
      settleUntil = Date.now() + PEEK_SETTLE;
      done?.();
    };
    if (!dx && !dy) {
      finish();
      return;
    }
    animating = true;
    settleUntil = Date.now() + duration + PEEK_SETTLE;
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
        finish();
      }
    };
    requestAnimationFrame(step);
  };

  // ---------- state changes

  const clearLeave = () => {
    if (leaveTimer) {
      clearTimeout(leaveTimer);
      leaveTimer = null;
    }
  };

  const stopPoll = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  /** Drop a reveal and its timers without moving the window. */
  const stopPeek = () => {
    peeked = false;
    revealing = false;
    clearLeave();
    stopPoll();
    root.removeAttribute("pip-peeking");
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

  // ---------- the hover zone
  //
  // A reveal has to stay up while the pointer is anywhere near the player,
  // including the area the player slides into and a margin around it. The
  // window moves under a pointer that may not move at all, so the last known
  // pointer position is kept in screen coordinates, which a window move cannot
  // invalidate, and the document's own hover state is asked directly. Pointer
  // idleness is never a departure signal.

  const rectNow = () => ({
    left: window.screenX,
    top: window.screenY,
    right: window.screenX + W(),
    bottom: window.screenY + H(),
  });

  const rectRevealed = () => {
    const [x, y] = flushPos(spot);
    return { left: x, top: y, right: x + W(), bottom: y + H() };
  };

  /** Union of where the player is and where it is going, plus a margin. */
  const zone = () => {
    const now = rectNow();
    const going = state === "tucked" ? rectRevealed() : now;
    return {
      left: Math.min(now.left, going.left) - PEEK_ZONE,
      top: Math.min(now.top, going.top) - PEEK_ZONE,
      right: Math.max(now.right, going.right) + PEEK_ZONE,
      bottom: Math.max(now.bottom, going.bottom) + PEEK_ZONE,
    };
  };

  const inZone = (x, y) => {
    const area = zone();
    return x >= area.left && x <= area.right && y >= area.top && y <= area.bottom;
  };

  /** Is the pointer over this document right now? */
  const hovering = () => {
    try {
      return root.matches(":hover");
    } catch (err) {
      return false;
    }
  };

  /** Keep the reveal while either signal says the pointer is still around. */
  const stillWanted = () => {
    if (hovering()) {
      return true;
    }
    return Date.now() - pointer.at < PEEK_STALE && inZone(pointer.x, pointer.y);
  };

  const startPoll = () => {
    stopPoll();
    pollTimer = setInterval(() => {
      if (!peeked) {
        stopPoll();
        return;
      }
      // Ignore the move itself and a moment after it, so a window sliding
      // under a stationary pointer cannot be mistaken for a departure.
      if (revealing || animating || Date.now() < settleUntil) {
        return;
      }
      if (stillWanted()) {
        clearLeave();
        return;
      }
      scheduleLeave();
    }, PEEK_POLL);
  };

  const reveal = () => {
    if (state !== "tucked" || peeked || document.fullscreenElement) {
      return;
    }
    if (!pref(PREF_HOVER_PEEK, false)) {
      return;
    }
    peeked = true;
    revealing = true;
    clearLeave();
    root.setAttribute("pip-peeking", "");
    glide(...flushPos(spot), GLIDE_MS, () => {
      revealing = false;
    });
    startPoll();
  };

  const retract = () => {
    if (!peeked) {
      return;
    }
    stopPeek();
    if (state === "tucked" && !document.fullscreenElement) {
      glide(...tuckedPos(spot));
    }
  };

  /** Give a departure a moment to turn out to be a mistake. */
  const scheduleLeave = () => {
    if (leaveTimer) {
      return;
    }
    leaveTimer = setTimeout(() => {
      leaveTimer = null;
      if (peeked && !revealing && !animating && !stillWanted()) {
        retract();
      }
    }, PEEK_GRACE);
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

  const rememberPointer = (event) => {
    if (typeof event?.clientX === "number" && typeof event?.clientY === "number") {
      pointer = {
        x: window.screenX + event.clientX,
        y: window.screenY + event.clientY,
        at: Date.now(),
      };
    }
  };

  const onMouseMove = (event) => {
    rememberPointer(event);
    if (peeked) {
      clearLeave();
    }
  };

  const onMouseEnter = (event) => {
    rememberPointer(event);
    if (peeked) {
      clearLeave();
      return;
    }
    reveal();
  };

  const onMouseLeave = () => {
    if (peeked) {
      // A real departure. Forget where the pointer was so the zone cannot keep
      // the reveal alive from a stale reading, but do not collapse at once:
      // the grace period covers a pointer crossing a gap.
      pointer = { ...pointer, at: 0 };
      scheduleLeave();
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
    if (state !== "tucked") {
      return;
    }
    // Both positions are measured from the window size, so a resize re-anchors
    // whichever of the two is on screen.
    window.moveTo(...(peeked ? flushPos(spot) : tuckedPos(spot)));
  };

  const onFullscreenChange = () => {
    if (document.fullscreenElement) {
      // Geometry means something else in fullscreen, so drop the reveal and do
      // not start another one until it ends.
      stopPeek();
    }
  };

  /**
   * While tucked, only this mod moves the window. If it ends up somewhere
   * else, the strip was dragged out by hand, so stop claiming it is tucked
   * rather than fighting for the position.
   */
  const watchDrift = () => {
    if (driftTimer) {
      return;
    }
    driftTimer = setInterval(() => {
      if (state !== "tucked" || peeked || animating || revealing) {
        return;
      }
      if (Date.now() < settleUntil) {
        return;
      }
      const [x, y] = tuckedPos(spot);
      if (Math.abs(window.screenX - x) <= DRIFT_PX && Math.abs(window.screenY - y) <= DRIFT_PX) {
        return;
      }
      stopPeek();
      state = "free";
      spot = null;
      root.removeAttribute("pip-tucked");
      home = { x: window.screenX, y: window.screenY };
    }, 300);
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
  document.addEventListener("fullscreenchange", onFullscreenChange);
  Services.prefs.addObserver(PREF_HOVER_PEEK, onPrefChange);
  watchDrift();

  /**
   * Zia's tuck button is styled by `.zia-pip-pill`, which is `display:
   * inline-flex` on every pill, so switching Zia's tuck off does not remove
   * the button. Hide it while this mod owns tucking, otherwise the player
   * carries a second control that moves the window behind our back.
   */
  const hideZiaTuckButton = () => {
    if (document.getElementById("pip-tuck-away-zia")) {
      return;
    }
    try {
      const style = document.createElementNS("http://www.w3.org/1999/xhtml", "style");
      style.id = "pip-tuck-away-zia";
      style.textContent = "#controls .zia-pip-tuck-button{display:none !important;}";
      document.documentElement.appendChild(style);
    } catch (err) {
      log("could not hide Zia's tuck button", err);
    }
  };

  /**
   * Decide who owns tucking for this window. A missing preference means Zia
   * has never been configured, and Zia's own default is on, so the presence
   * of its button is the signal worth trusting.
   */
  const reconcileZia = () => {
    const zia = prefState(ZIA_TUCK_PREF);
    if (zia === false) {
      hideZiaTuckButton();
      return;
    }
    let button = null;
    try {
      button = document.querySelector("#controls .zia-pip-tuck-button");
    } catch (err) {
      button = null;
    }
    if (button && !ziaWarned) {
      ziaWarned = true;
      const state =
        zia === undefined
          ? "is unset, so Zia's default of true applies"
          : "is true";
      console.warn(
        `[PiP Tuck Away] Zia's tuck button is in this player (zia.pip.tuck ${state}). ` +
          "Two mods are moving the window. Set zia.pip.tuck to false so this mod owns tucking."
      );
    }
  };

  reconcileZia();
  // Zia may attach its controls after us, so look again once they exist.
  settleTimers.push(setTimeout(reconcileZia, 600));

  // Start tucked rather than showing the player in its normal place first.
  if (pref(PREF_AUTO_TUCK, false)) {
    instantTuck(nearestSide());
  }

  const destroy = () => {
    stopPeek();
    glideId++;
    if (driftTimer) {
      clearInterval(driftTimer);
      driftTimer = null;
    }
    for (const id of settleTimers) {
      clearTimeout(id);
    }
    settleTimers = [];
    document.removeEventListener("contextmenu", onContextMenu, true);
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("mouseenter", onMouseEnter, true);
    document.removeEventListener("mouseleave", onMouseLeave, true);
    document.removeEventListener("fullscreenchange", onFullscreenChange);
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
    try {
      document.getElementById("pip-tuck-away-zia")?.remove();
    } catch (err) {
      log("could not remove the Zia button style", err);
    }
    delete window.__pipTuckAway;
  };

  window.__pipTuckAway = { toggle, tuck, untuck, destroy, isTucked: () => state === "tucked" };
  window.addEventListener("unload", destroy, { once: true });
})();
