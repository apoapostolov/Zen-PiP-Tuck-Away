// PiP Tuck Away: player half.
//
// Runs inside the picture-in-picture player window. Moves that window to a
// screen edge so only a strip stays visible, and brings it back on demand.
//
// Exposes window.__pipTuckAway = { toggle, tuck, untuck, isTucked, destroy }
// so the browser-window half can drive it. The keyboard chord lives in the
// browser half, which installs it on every Zen window including this one.
//
// The screen-edge geometry (sliver width, tuck/return maths) is adapted from
// Zia by z1n-k (MIT), chrome/sine-mods/zia/zia-pip.js. See CREDITS.md.
(() => {
  "use strict";

  if (window.__pipTuckAway) {
    return;
  }

  const PREF_RIGHT_CLICK = "pip-tuck-away.right-click";
  const PREF_HOVER_PEEK = "pip-tuck-away.hover-peek";
  const PREF_AUTO_TUCK = "pip-tuck-away.auto-tuck";
  const PREF_DRAG_TUCK = "pip-tuck-away.drag-tuck";

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
  const EDGE_BAND = 12; // px from the screen edge where :hover is not trustworthy
  const REVEAL_COOLDOWN = 250; // after a retract, no new reveal at once
  const BARE_ATTR = "pip-tuck-away-bare";
  const ARM_ATTR = "pip-armed"; // an edge the player is already hanging over
  const ARM_POLL = 200; // ms between checks for a window dragged past an edge
  const DRIFT_PX = 3; // movement by anyone else that counts as a drag

  const root = document.documentElement;

  // ---------- the sheet
  //
  // The player document is served with `Content-Security-Policy:
  // default-src chrome:`, so an injected <style> element is dropped without a
  // word and every rule here would be dead. A real file loaded as an author
  // sheet is not subject to the page's rules at all, and a chrome:// link is
  // the fallback.
  const XHTML_NS = "http://www.w3.org/1999/xhtml";
  const SHEET_URL = "chrome://sine/content/pip-tuck-away/styles/player.css";
  let sheetLoaded = false;

  const loadSheet = () => {
    if (sheetLoaded) {
      return;
    }
    sheetLoaded = true;
    try {
      const utils = window.windowUtils;
      if (utils?.loadSheetUsingURIString) {
        utils.loadSheetUsingURIString(SHEET_URL, utils.AUTHOR_SHEET);
        return;
      }
    } catch (err) {
      log("could not load the player styles as a sheet", err);
    }
    try {
      const link = document.createElementNS(XHTML_NS, "link");
      link.rel = "stylesheet";
      link.href = SHEET_URL;
      (document.head ?? root).appendChild(link);
    } catch (err) {
      log("could not link the player styles", err);
    }
  };

  loadSheet();

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
  let leaveTimer = null;
  let pollTimer = null;
  let tuckedTimer = null;
  let reopenAfter = 0;
  let controlsTimer = null;
  let armedSide = null; // the edge a drag has hooked onto, if any
  let armedDepth = 0; // how far past that edge the player is
  let armTimer = null;
  let bare = false;
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

  /**
   * The edge a tuck should use.
   *
   * Sides first: a sideways tuck leaves the video as a tall strip, which is
   * what a playing video wants. A vertical tuck is only worth having when the
   * window is well clear of both side edges and near one of the horizontal
   * ones, and then the top is the default, so the bottom has to be clearly
   * nearer to take it.
   *
   * A window that already hangs over an edge, however slightly, belongs to that
   * edge: that is where the user last put it, and dragging it back toward the
   * middle is not what a tuck is for. Distances are measured from the window's
   * own edges rather than its centre, which is what makes a wide, short window
   * in a corner read as a corner instead of as a top or bottom.
   */
  const OVERHANG = 2; // px past a screen edge that claims the tuck
  const SIDE_CLEAR = 160; // px from both side edges before a vertical tuck
  const FLAT_NEAR = 96; // px from a horizontal edge that calls it close
  const TOP_BIAS = 64; // px the bottom edge has to beat the top by

  const nearestSide = () => {
    const b = screenBox();
    const w = W();
    const h = H();
    if (!w || !h) {
      return "right";
    }
    const x = window.screenX;
    const y = window.screenY;
    if (x <= b.left - OVERHANG) {
      return "left";
    }
    if (x + w >= b.right + OVERHANG) {
      return "right";
    }
    if (y <= b.top - OVERHANG) {
      return "top";
    }
    if (y + h >= b.bottom + OVERHANG) {
      return "bottom";
    }
    const gap = {
      left: x - b.left,
      right: b.right - (x + w),
      top: y - b.top,
      bottom: b.bottom - (y + h),
    };
    const sideways = Math.min(gap.left, gap.right);
    const flat = Math.min(gap.top, gap.bottom);
    if (flat <= FLAT_NEAR && sideways >= SIDE_CLEAR) {
      return gap.bottom + TOP_BIAS < gap.top ? "bottom" : "top";
    }
    return gap.left <= gap.right ? "left" : "right";
  };

  /**
   * Tuck by drag: a player dragged so that part of it is past a screen edge has
   * already committed to that edge, and moving the pointer off the player
   * completes the gesture. The window is watched rather than the drag, because
   * a window drag belongs to the window manager and reports nothing to the
   * page; what can be read is where the window ended up.
   */
  const hungOver = () => {
    if (!pref(PREF_DRAG_TUCK, true) || state !== "free" || document.fullscreenElement) {
      return null;
    }
    const b = screenBox();
    const w = W();
    const h = H();
    if (!w || !h) {
      return null;
    }
    const over = {
      right: window.screenX + w - b.right,
      top: b.top - window.screenY,
      left: b.left - window.screenX,
      bottom: window.screenY + h - b.bottom,
    };
    let side = null;
    let depth = OVERHANG;
    for (const name of SIDES) {
      if (over[name] >= depth) {
        side = name;
        depth = over[name];
      }
    }
    return side ? { side, depth } : null;
  };

  /** Draw the indicator where the screen edge is, not where the window ends. */
  const placeArm = (armed) => {
    const arm = document.getElementById(ARM_ID);
    if (!arm?.style) {
      return;
    }
    try {
      for (const name of SIDES) {
        arm.style.removeProperty(name);
      }
      if (armed) {
        arm.style.setProperty(armed.side, `${Math.round(armed.depth)}px`);
      }
    } catch (err) {
      log("could not place the tuck indicator", err);
    }
  };

  const setArmed = (armed) => {
    const side = armed?.side ?? null;
    const changed = side !== armedSide || (side && armed?.depth !== armedDepth);
    armedSide = side;
    armedDepth = armed?.depth ?? 0;
    if (!changed) {
      return;
    }
    if (side) {
      root.setAttribute(ARM_ATTR, side);
    } else {
      root.removeAttribute(ARM_ATTR);
    }
    ensureBadge();
    placeArm(armed);
  };

  // How long a pointer reading is trusted to say where the pointer still is.
  // A drag reports constantly while it is over the window, so a couple of
  // seconds is generous for the moment just after a release.
  const POINTER_TRUST = 2000;

  /** The pointer is not over the player any more, as far as we last saw it. */
  const pointerOutside = () => {
    if (!pointer.at || Date.now() - pointer.at > POINTER_TRUST) {
      return false;
    }
    return (
      pointer.x < window.screenX ||
      pointer.y < window.screenY ||
      pointer.x > window.screenX + W() ||
      pointer.y > window.screenY + H()
    );
  };

  const watchArmed = () => {
    const armed = hungOver();
    setArmed(armed);
    // A drag that ends outside the player leaves no mouseleave behind: the
    // window simply stopped being under the pointer. That is still the gesture.
    if (armed && pointerOutside()) {
      setArmed(null);
      tuck(armed.side);
    }
  };

  /**
   * A player restored from a position saved on another display can open mostly
   * off screen, where every edge looks far away. Pull it back when little of it
   * is visible, so tucking never starts from coordinates nobody can see.
   */
  const rescuePosition = () => {
    if (state !== "free" || document.fullscreenElement) {
      return;
    }
    const b = screenBox();
    const w = W();
    const h = H();
    if (!w || !h) {
      return;
    }
    const overX = Math.min(window.screenX + w, b.right) - Math.max(window.screenX, b.left);
    const overY = Math.min(window.screenY + h, b.bottom) - Math.max(window.screenY, b.top);
    const visible = Math.max(0, overX) * Math.max(0, overY);
    if (visible >= w * h * 0.6) {
      return;
    }
    window.moveTo(
      Math.round(clamp(window.screenX, b.left + MARGIN, b.right - w - MARGIN)),
      Math.round(clamp(window.screenY, b.top + MARGIN, b.bottom - h - MARGIN))
    );
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
    } else if (name === "top") {
      y = b.top - h + SLIVER;
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
    } else if (name === "top") {
      y = b.top;
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
    root.removeAttribute(CONTROLS_ATTR);
    setBare(false);
    clearFrost();
    updateOverlay();
  };

  const tuck = (side = null) => {
    if (document.fullscreenElement) {
      return false;
    }
    setArmed(null);
    if (state !== "tucked") {
      home = { x: window.screenX, y: window.screenY };
      spot = null;
    }
    stopPeek();
    spot = side || spot || nearestSide();
    state = "tucked";
    root.setAttribute("pip-tucked", spot);
    glide(...tuckedPos(spot));
    updateOverlay();
    reflectZiaButton();
    return true;
  };

  const untuck = () => {
    if (state !== "tucked") {
      return false;
    }
    setArmed(null);
    stopPeek();
    state = "free";
    spot = null;
    root.removeAttribute("pip-tucked");
    glide(...homePos());
    updateOverlay();
    reflectZiaButton();
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
    // A side is not knowable while the window still reports no size, which is
    // exactly how early an auto tuck runs, so it is settled on the first pass
    // that can see one.
    spot = side || null;
    state = "tucked";
    if (spot) {
      root.setAttribute("pip-tucked", spot);
    }
    glideId++; // cancel anything already in flight
    const settle = () => {
      if (state !== "tucked" || peeked) {
        return;
      }
      // The window has no real size yet while the document is still parsing.
      if (!W() || W() < 50) {
        return;
      }
      if (!spot) {
        spot = nearestSide();
        root.setAttribute("pip-tucked", spot);
        reflectZiaButton();
      }
      window.moveTo(...tuckedPos(spot));
    };
    settle();
    requestAnimationFrame(settle);
    for (const delay of [60, 150, 320]) {
      settleTimers.push(setTimeout(settle, delay));
    }
    reflectZiaButton();
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

  /**
   * The last pixel of the screen belongs to the window's resize border, and a
   * window that moves under a pointer which never moved can drop its hover
   * state. Near the tucked edge neither is a decision to leave, so a pointer
   * in that band keeps counting as present.
   */
  const pointerNearEdge = () => {
    if (Date.now() - pointer.at >= PEEK_STALE || !inZone(pointer.x, pointer.y)) {
      return false;
    }
    const b = screenBox();
    if (spot === "left") {
      return pointer.x <= b.left + EDGE_BAND;
    }
    if (spot === "right") {
      return pointer.x >= b.right - EDGE_BAND;
    }
    if (spot === "top") {
      return pointer.y <= b.top + EDGE_BAND;
    }
    return pointer.y >= b.bottom - EDGE_BAND;
  };

  /**
   * A reveal that comes from the pointer resting on the strip shows the video
   * and nothing else. Firefox's own controls and the dim gradient stay away
   * until the user reaches for them with a left press.
   */
  const setBare = (on) => {
    bare = !!on;
    hideControlLayer(bare);
    if (!bare) {
      if (root.hasAttribute(BARE_ATTR)) {
        root.removeAttribute(BARE_ATTR);
      }
      return;
    }
    loadSheet();
    root.setAttribute(BARE_ATTR, "");
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
    if (!pref(PREF_HOVER_PEEK, false) || Date.now() < reopenAfter) {
      return;
    }
    peeked = true;
    revealing = true;
    clearLeave();
    root.setAttribute("pip-peeking", "");
    setBare(true);
    frostNothing();
    // The strip belongs to the control layer and a peek is not one.
    updateOverlay();
    glide(...flushPos(spot), GLIDE_MS, () => {
      revealing = false;
    });
    startPoll();
  };

  const retract = () => {
    if (!peeked) {
      return;
    }
    reopenAfter = Date.now() + REVEAL_COOLDOWN;
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
      if (peeked && !revealing && !animating && Date.now() >= settleUntil && !stillWanted()) {
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
    setBare(false);
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
    refreshSide();
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
    // Tuck by drag first: the pointer leaving the player is the second half of
    // that gesture, and it has nothing to do with a peek.
    if (!peeked && armedSide) {
      const side = armedSide;
      setArmed(null);
      tuck(side);
      return;
    }
    if (!peeked) {
      return;
    }
    if (pointerNearEdge()) {
      // The pointer cannot have gone anywhere: the edge is right there. Keep
      // the reading fresh instead of believing this leave, which is what made
      // the reveal strobe when the cursor was parked on the screen edge.
      pointer = { ...pointer, at: Date.now() };
      return;
    }
    // A real departure. Forget where the pointer was so the zone cannot keep
    // the reveal alive from a stale reading, but do not collapse at once: the
    // grace period covers a pointer crossing a gap.
    pointer = { ...pointer, at: 0 };
    scheduleLeave();
  };

  /**
   * A left press is the user reaching for the player, so it brings the controls
   * back. Movement does not: a peek must survive the pointer drifting, which is
   * why the bare look is only given up on a press.
   */
  const onBarePress = (event) => {
    if (event.button !== 0) {
      return;
    }
    if (event.target === badge()) {
      return;
    }
    if (bare) {
      setBare(false);
    }
    // Only a peek needs the hand-over: elsewhere Firefox is already in charge.
    if (peeked) {
      offerControls();
    }
  };

  const onResize = () => {
    updateOverlay();
    refreshSide();
    rescuePosition();
    if (state !== "tucked") {
      return;
    }
    // Both positions are measured from the window size, so a resize re-anchors
    // whichever of the two is on screen.
    window.moveTo(...(peeked ? flushPos(spot) : tuckedPos(spot)));
  };

  const onFullscreenChange = () => {
    // Zia can rebuild its overlay around a fullscreen round trip.
    reconcileZia();
    if (document.fullscreenElement) {
      // Geometry means something else in fullscreen, so drop the reveal and do
      // not start another one until it ends.
      stopPeek();
    }
  };

  /**
   * Watches the tucked state for the two things an event cannot be trusted
   * for: a pointer still sitting on the strip whose hover state went missing,
   * and a window somebody else moved.
   */
  const watchTucked = () => {
    if (tuckedTimer) {
      return;
    }
    tuckedTimer = setInterval(() => {
      if (state !== "tucked" || peeked || animating || revealing) {
        return;
      }
      if (Date.now() < settleUntil) {
        return;
      }
      // Somebody else moved the window: let go before anything else, or a
      // pointer resting on it would drag it straight back.
      const [x, y] = tuckedPos(spot);
      if (Math.abs(window.screenX - x) > DRIFT_PX || Math.abs(window.screenY - y) > DRIFT_PX) {
        stopPeek();
        state = "free";
        spot = null;
        root.removeAttribute("pip-tucked");
        home = { x: window.screenX, y: window.screenY };
        return;
      }
      // A pointer that is still there should have the strip out, whether or not
      // an enter event ever arrived. Same condition the poll retracts on, so the
      // two can never disagree.
      if (Date.now() >= reopenAfter && (hovering() || pointerNearEdge())) {
        reveal();
      }
    }, 200);
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
  document.addEventListener("mousedown", onBarePress, true);
  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("mouseenter", onMouseEnter, true);
  document.addEventListener("mouseleave", onMouseLeave, true);
  window.addEventListener("resize", onResize);
  document.addEventListener("fullscreenchange", onFullscreenChange);
  Services.prefs.addObserver(PREF_HOVER_PEEK, onPrefChange);
  watchTucked();

  /**
   * Zia's tuck button stays where it is and drives this mod.
   *
   * Zia hides that button when `zia.pip.tuck` is false, and this mod keeps the
   * preference off so only one thing moves the window. A missing control reads
   * as a broken player, so the button is shown again and the clicks are taken
   * in the capture phase, before Zia's handlers run: the same button, with this
   * mod's geometry behind it. Zia's own picker still opens on right-click, and
   * a spot picked there is honoured through the same path, folded onto the
   * nearest side this mod supports.
   */

  const showZiaButton = () => loadSheet();

  const ziaButton = () => {
    try {
      return document.querySelector("#controls .zia-pip-tuck-button");
    } catch (err) {
      return null;
    }
  };

  /** Keep the button's pressed state honest, since it now drives this mod. */
  const reflectZiaButton = () => {
    const button = ziaButton();
    if (!button?.setAttribute) {
      return;
    }
    button.setAttribute("aria-pressed", state === "tucked" ? "true" : "false");
  };

  /** Zia's picker closes on Escape, which is the only handle it offers. */
  const closeZiaPicker = () => {
    try {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    } catch (err) {
      // No picker open, or a window that refuses synthetic events.
    }
  };

  /** Zia names eight spots; this mod parks against three sides. */
  const sideFromSpot = (name) => {
    if (!name) {
      return nearestSide();
    }
    if (name.includes("left")) {
      return "left";
    }
    if (name.includes("right")) {
      return "right";
    }
    if (name.includes("bottom")) {
      return "bottom";
    }
    return nearestSide();
  };

  const ziaTarget = (node, selector) => {
    try {
      return node?.closest?.(selector) ?? null;
    } catch (err) {
      return null;
    }
  };

  const onZiaClick = (event) => {
    const spot = ziaTarget(event.target, "#controls .zia-pip-spot");
    const button = ziaTarget(event.target, "#controls .zia-pip-tuck-button");
    if (!spot && !button) {
      return;
    }
    // Claim the press before Zia's own listener sees it, or two things move
    // the window and the second one wins.
    event.preventDefault();
    event.stopImmediatePropagation?.();
    event.stopPropagation();
    if (spot) {
      tuck(sideFromSpot(spot.dataset?.spot));
      closeZiaPicker();
      reflectZiaButton();
      return;
    }
    toggle();
    reflectZiaButton();
  };

  document.addEventListener("click", onZiaClick, true);

  /**
   * Zia hides its button through its own style sheet, with `display: none`
   * and a `!important` rule of its own for the case where it thinks there is
   * nowhere to tuck. A style sheet of ours can only beat that on specificity
   * and order, and the order of two injected sheets is a race, so the winning
   * declaration is put on the element itself: an inline `!important` outranks
   * every style sheet there is.
   */
  const revealZiaButton = () => {
    const button = ziaButton();
    if (!button?.style?.setProperty) {
      return false;
    }
    try {
      button.style.setProperty("display", "inline-flex", "important");
      return true;
    } catch (err) {
      return false;
    }
  };

  const reconcileZia = () => {
    if (!ziaButton()) {
      return;
    }
    showZiaButton();
    revealZiaButton();
    reflectZiaButton();
  };

  reconcileZia();
  // Zia builds its controls after this script in some players, so look again.
  for (const delay of [300, 900]) {
    settleTimers.push(setTimeout(reconcileZia, delay));
  }


  // ---------- the tuck control overlay
  //
  // A strip of the video that tucks when clicked, instead of the small pill
  // other mods add: 20% of the width and 90% of the height on the side it will
  // tuck into, with an arrow and a label. It goes in as the first child of
  // #controls, so Firefox's own buttons and the control bar paint above it and
  // keep their clicks. Only the uncovered part of the strip answers.

  const PREF_OVERLAY = "pip-tuck-away.overlay";
  const PREF_DIRECTION = "pip-tuck-away.direction";
  const OVERLAY_ID = "pip-tuck-away-overlay";
  const PICKER_ID = "pip-tuck-away-picker";
  const SIDES = ["right", "top", "left", "bottom"];
  const PICKER_ORDER = ["top", "left", "smart", "right", "bottom"];
  const DIRECTION_LABELS = {
    smart: "Smart",
    right: "Right",
    top: "Top",
    left: "Left",
    bottom: "Bottom",
  };


  const directionPref = () => {
    try {
      const value = Services.prefs.getStringPref(PREF_DIRECTION, "smart");
      return value === "smart" || SIDES.includes(value) ? value : "smart";
    } catch (err) {
      return "smart";
    }
  };

  /** Where a press on the strip will park the player. */
  const chosenSide = () => {
    const value = directionPref();
    return value === "smart" ? nearestSide() : value;
  };

  const ensureOverlayStyle = () => loadSheet();

  const pickerElement = () => document.getElementById(PICKER_ID);

  const closePicker = () => {
    const picker = pickerElement();
    if (picker) {
      picker.hidden = true;
    }
    document.removeEventListener("mousedown", onDocumentMouseDown, true);
  };

  const chooseDirection = (side) => {
    try {
      Services.prefs.setStringPref(PREF_DIRECTION, side);
    } catch (err) {
      log("could not save the tuck direction", err);
    }
    closePicker();
    updateOverlay();
  };

  const onDocumentMouseDown = (event) => {
    const picker = pickerElement();
    if (!picker || picker.hidden) {
      return;
    }
    if (!picker.contains(event.target)) {
      closePicker();
    }
  };

  const buildPicker = () => {
    const picker = document.createElementNS(XHTML_NS, "div");
    picker.id = PICKER_ID;
    picker.hidden = true;
    picker.addEventListener("contextmenu", (event) => event.preventDefault());
    const title = document.createElementNS(XHTML_NS, "div");
    title.className = "pip-tuck-away-picker-title";
    title.textContent = "Tuck into…";
    picker.append(title);
    for (const side of PICKER_ORDER) {
      const button = document.createElementNS(XHTML_NS, "button");
      button.dataset.side = side;
      button.textContent = DIRECTION_LABELS[side];
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        chooseDirection(side);
      });
      picker.append(button);
    }
    return picker;
  };

  const openPicker = () => {
    const picker = pickerElement();
    if (!picker) {
      return;
    }
    picker.hidden = false;
    const current = directionPref();
    for (const button of picker.querySelectorAll("button")) {
      button.setAttribute("aria-pressed", button.dataset.side === current ? "true" : "false");
    }
    document.addEventListener("mousedown", onDocumentMouseDown, true);
  };

  const togglePicker = () => {
    const picker = pickerElement();
    if (picker && !picker.hidden) {
      closePicker();
    } else {
      openPicker();
    }
  };

  const onOverlayClick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (state === "tucked") {
      untuck();
      return;
    }
    tuck(chosenSide());
  };

  const onOverlayContext = (event) => {
    event.preventDefault();
    event.stopPropagation();
    togglePicker();
  };

  const onOverlayKey = (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    onOverlayClick(event);
  };

  const buildOverlay = () => {
    const overlay = document.createElementNS(XHTML_NS, "div");
    overlay.id = OVERLAY_ID;
    overlay.setAttribute("role", "button");
    overlay.setAttribute("tabindex", "0");
    overlay.setAttribute("tooltip", "Tuck away · right-click for where");
    const arrow = document.createElementNS(XHTML_NS, "span");
    arrow.className = "pip-tuck-away-arrow";
    arrow.setAttribute("aria-hidden", "true");
    const label = document.createElementNS(XHTML_NS, "span");
    label.className = "pip-tuck-away-label";
    label.textContent = "Tuck Away";
    overlay.append(arrow, label);
    overlay.addEventListener("click", onOverlayClick);
    overlay.addEventListener("contextmenu", onOverlayContext);
    overlay.addEventListener("keydown", onOverlayKey);
    return overlay;
  };

  const badge = () => document.getElementById(BADGE_ID);

  const controlsNode = () => {
    try {
      return document.getElementById("controls");
    } catch (err) {
      return null;
    }
  };

  /**
   * A bare reveal has to be bare. Zia adds elements of its own to the control
   * layer, Firefox raises opacity through `#controls[showing]`, `[keying]` and
   * hover rules of its own, and a style sheet of ours only wins that fight on
   * specificity and load order. A property set on the element itself wins
   * every one of them, so the whole layer is switched off there: nothing
   * inside it can be more visible than the layer holding it, whatever it
   * carries and whoever put it there.
   */
  /** The things in the layer that take a press, so they cannot be pressed blind. */
  const layerControls = () => {
    const controls = controlsNode();
    if (!controls?.querySelectorAll) {
      return [];
    }
    try {
      return Array.from(controls.querySelectorAll("button,input"));
    } catch (err) {
      return [];
    }
  };

  const hideControlLayer = (on) => {
    const controls = controlsNode();
    if (!controls?.style?.setProperty) {
      return;
    }
    try {
      if (on) {
        // Every child of this layer fades with it, including the gradient bar
        // at the bottom, whatever classes they carry and whoever added them.
        controls.style.setProperty("opacity", "0", "important");
        for (const node of layerControls()) {
          node.style?.setProperty?.("pointer-events", "none", "important");
        }
      } else {
        controls.style.removeProperty("opacity");
        for (const node of layerControls()) {
          node.style?.removeProperty?.("pointer-events");
        }
      }
    } catch (err) {
      log("could not switch the control layer", err);
    }
  };

  const playerHolder = () => {
    try {
      const found = document.querySelector(".player-holder");
      if (found) {
        return found;
      }
      // The video lives in a browser element; its parent is the holder.
      return document.getElementById("browser")?.parentNode ?? null;
    } catch (err) {
      return null;
    }
  };

  /**
   * The frost belongs to the tucked state only. While the window is out for a
   * peek it has to read as plain video, so the filter is cleared on the element
   * itself rather than trusted to an attribute selector alone.
   */
  const clearFrost = () => {
    try {
      playerHolder()?.style?.removeProperty("filter");
    } catch (err) {
      // A player without a holder needs nothing.
    }
  };

  const frostNothing = () => {
    try {
      const holder = playerHolder();
      if (holder?.style) {
        holder.style.filter = "none";
      }
    } catch (err) {
      // A player without a holder needs nothing.
    }
  };

  /** Firefox shows the controls on enter and hides them on its own timer, so a
   * press that un-bares them has to hand them over with a visible window. */
  const offerControls = () => {
    hideControlLayer(false);
    root.setAttribute(CONTROLS_ATTR, "");
    if (controlsTimer) {
      clearTimeout(controlsTimer);
    }
    controlsTimer = setTimeout(() => {
      controlsTimer = null;
      root.removeAttribute(CONTROLS_ATTR);
    }, CONTROLS_HOLD);
  };

  /**
   * Where the player was parked, kept in a preference.
   *
   * Firefox saves the window position when it closes, which is the tucked
   * position whenever the player folds away while tucked, and that is mostly
   * off screen: the next player then opens somewhere nobody put it. The place
   * worth remembering is the one before the tuck, so this mod keeps its own.
   */
  const HOME_PREF = "pip-tuck-away.home";

  const readHome = () => {
    try {
      const raw = Services.prefs.getStringPref(HOME_PREF, "");
      const [x, y] = String(raw).split(",").map((part) => Number(part));
      return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    } catch (err) {
      return null;
    }
  };

  const writeHome = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }
    try {
      Services.prefs.setStringPref(HOME_PREF, `${Math.round(x)},${Math.round(y)}`);
    } catch (err) {
      log("could not remember the player position", err);
    }
  };

  /** Put the player back where it was last parked, inside the screen. */
  const restoreHome = () => {
    if (state !== "free" || document.fullscreenElement) {
      return false;
    }
    const wanted = readHome();
    const w = W();
    const h = H();
    if (!wanted || !w || !h) {
      return false;
    }
    const b = screenBox();
    // Same margin the rest of the mod uses, so a remembered place never lands
    // flush against an edge where the resize border would swallow the drag.
    const x = Math.round(clamp(wanted.x, b.left + MARGIN, b.right - w - MARGIN));
    const y = Math.round(clamp(wanted.y, b.top + MARGIN, b.bottom - h - MARGIN));
    if (Math.abs(window.screenX - x) <= 2 && Math.abs(window.screenY - y) <= 2) {
      return true;
    }
    window.moveTo(x, y);
    return true;
  };

  /** Keep the arrow honest when the window is moved without a state change. */
  const refreshSide = () => {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay || state === "tucked") {
      return;
    }
    const side = chosenSide();
    if (overlay.dataset.side !== side) {
      overlay.dataset.side = side;
    }
  };

  /** Build, place, or take away the strip to match the settings and the state. */
  const updateOverlay = () => {
    const controls = document.getElementById("controls");
    if (!controls) {
      return;
    }
    ensureOverlayStyle();
    let overlay = document.getElementById(OVERLAY_ID);
    let picker = pickerElement();
    if (!pref(PREF_OVERLAY, true)) {
      overlay?.remove();
      picker?.remove();
      closePicker();
      return;
    }
    if (!overlay) {
      overlay = buildOverlay();
      controls.insertBefore(overlay, controls.firstChild);
    }
    if (!picker) {
      picker = buildPicker();
      controls.append(picker);
    }
    overlay.dataset.side = chosenSide();
    const hide = state === "tucked" || !!document.fullscreenElement;
    overlay.hidden = hide;
    if (hide) {
      closePicker();
    }
  };

  const onOverlayPref = (subject, topic) => {
    if (topic === "nsPref:changed") {
      updateOverlay();
    }
  };

  Services.prefs.addObserver(PREF_OVERLAY, onOverlayPref);
  Services.prefs.addObserver(PREF_DIRECTION, onOverlayPref);
  updateOverlay();
  // #controls can arrive after this script in a freshly opened player.
  for (const delay of [120, 400, 1000]) {
    settleTimers.push(setTimeout(updateOverlay, delay));
  }

  // ---------- the tucked look
  //
  // What is left on screen while tucked is a strip of the video, so it is
  // frosted and carries a chevron pointing back out: the strip reads as a
  // handle rather than a chopped-up sliver. Taken from Zia, which did this
  // with a sliver overlay and a filter on the video.

  const CONTROLS_ATTR = "pip-controls";
  const CONTROLS_HOLD = 2600; // ms the controls stay after a press asks for them
  const BADGE_ID = "pip-tuck-away-badge";
  const ARM_ID = "pip-tuck-away-arm";

  const ensureTuckLook = () => loadSheet();

  const buildBadge = () => {
    const badge = document.createElementNS(XHTML_NS, "div");
    badge.id = BADGE_ID;
    badge.setAttribute("role", "button");
    badge.setAttribute("tabindex", "0");
    badge.setAttribute("tooltip", "Bring the player back");
    badge.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (state === "tucked") {
        untuck();
      }
    });
    badge.addEventListener("contextmenu", (event) => {
      // Right-click belongs to the mod's own tuck toggle, not to a menu.
      event.preventDefault();
      event.stopPropagation();
      toggle();
    });
    return badge;
  };

  const buildArm = () => {
    // A line on the edge the player is hanging over, so a drag shows what it
    // is about to do before the pointer leaves.
    const arm = document.createElementNS(XHTML_NS, "div");
    arm.id = ARM_ID;
    return arm;
  };

  const ensureBadge = () => {
    ensureTuckLook();
    const parent = document.body ?? document.documentElement;
    try {
      if (!document.getElementById(BADGE_ID)) {
        parent.appendChild(buildBadge());
      }
      if (!document.getElementById(ARM_ID)) {
        parent.appendChild(buildArm());
      }
    } catch (err) {
      log("could not build the tucked strip badge", err);
    }
  };

  ensureBadge();

  // One timer for the life of the window: a size read and four subtractions
  // every 200ms, which is what notices a player dragged past an edge.
  if (!armTimer) {
    armTimer = setInterval(watchArmed, ARM_POLL);
  }
  watchArmed();

  // Start tucked rather than showing the player in its normal place first.
  if (pref(PREF_AUTO_TUCK, false)) {
    instantTuck();
  } else {
    // Firefox restores the last position just after the window opens, so check
    // more than once: first for a place this mod remembers, then that whatever
    // is left is somewhere the user can see.
    const placePlayer = () => {
      if (!restoreHome()) {
        rescuePosition();
      }
    };
    for (const delay of [0, 300, 800]) {
      settleTimers.push(setTimeout(placePlayer, delay));
    }
  }

  const destroy = () => {
    stopPeek();
    glideId++;
    if (tuckedTimer) {
      clearInterval(tuckedTimer);
      tuckedTimer = null;
    }
    if (armTimer) {
      clearInterval(armTimer);
      armTimer = null;
    }
    root.removeAttribute(ARM_ATTR);
    for (const id of settleTimers) {
      clearTimeout(id);
    }
    settleTimers = [];
    document.removeEventListener("contextmenu", onContextMenu, true);
    document.removeEventListener("mousedown", onBarePress, true);
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("mouseenter", onMouseEnter, true);
    document.removeEventListener("mouseleave", onMouseLeave, true);
    document.removeEventListener("fullscreenchange", onFullscreenChange);
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
      document.removeEventListener("click", onZiaClick, true);
      if (controlsTimer) {
        clearTimeout(controlsTimer);
        controlsTimer = null;
      }
      hideControlLayer(false);
      document.getElementById(BADGE_ID)?.remove();
      document.getElementById(ARM_ID)?.remove();
      root.removeAttribute(BARE_ATTR);
      document.getElementById(OVERLAY_ID)?.remove();
      document.getElementById(PICKER_ID)?.remove();
      document.removeEventListener("mousedown", onDocumentMouseDown, true);
      Services.prefs.removeObserver(PREF_OVERLAY, onOverlayPref);
      Services.prefs.removeObserver(PREF_DIRECTION, onOverlayPref);
    } catch (err) {
      log("could not remove the Zia button style", err);
    }
    delete window.__pipTuckAway;
  };

  window.__pipTuckAway = { toggle, tuck, untuck, destroy, isTucked: () => state === "tucked" };
  /**
   * Last chance to note where the player belongs: while tucked that is the
   * place it came from, because the window itself is mostly off screen.
   */
  window.addEventListener(
    "unload",
    () => {
      try {
        if (state === "tucked") {
          if (home) {
            writeHome(home.x, home.y);
          }
        } else {
          writeHome(window.screenX, window.screenY);
        }
      } catch (err) {
        // A window on its way out needs nothing.
      }
      destroy();
    },
    { once: true }
  );
})();
