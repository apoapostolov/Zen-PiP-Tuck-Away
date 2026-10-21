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
// The idea of tucking a player into a screen edge came from Zia (z1n-k, MIT).
// Nothing in this file is taken from it: the geometry, the strip, the button and
// the direction map are written here, and this mod needs no other mod to work.
// See CREDITS.md for what the idea owes and to whom.
(() => {
  "use strict";

  if (window.__pipTuckAway) {
    return;
  }

  const PREF_RIGHT_CLICK = "pip-tuck-away.right-click";
  const PREF_FROST = "pip-tuck-away.frosted";
  const FROST_ATTR = "pip-frosted";
  const stringPref = (name, fallback) => {
    try {
      if (Services.prefs.getPrefType(name) === 0) {
        return fallback;
      }
      return Services.prefs.getStringPref(name, fallback);
    } catch (err) {
      return fallback;
    }
  };

  const PREF_HOVER_PEEK = "pip-tuck-away.hover-peek";
  const PREF_AUTO_TUCK = "pip-tuck-away.auto-tuck";
  const PREF_DRAG_TUCK = "pip-tuck-away.drag-tuck";
  const PREF_WIDTH = "pip-tuck-away.width";
  const PREF_SIZE = "pip-tuck-away.size";
  const PREF_PLACE = "pip-tuck-away.place";
  const REMEMBER = "remember";

  // How much of the window stays on screen while tucked. The narrow default is
  // the one that reads as a drawer; the wider ones are for people who want more
  // of the video to hold on to.
  const WIDTHS = { normal: 24, wide: 48, "very-wide": 72 };
  let sliver = WIDTHS.normal;
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
  let clickTimer = null; // pending single-click action, waiting out a double
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

  const prefString = (name, fallback) => {
    try {
      if (Services.prefs.getPrefType(name) === 0) {
        return fallback;
      }
      return Services.prefs.getStringPref(name, fallback);
    } catch (err) {
      return fallback;
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
  const hungOver = (whileTucked = false) => {
    if (!pref(PREF_DRAG_TUCK, true) || document.fullscreenElement) {
      return null;
    }
    if (!whileTucked && state !== "free") {
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
    // Nothing remembered means nothing to go back to, so the window is put
    // somewhere usable. That place is the mod's idea, not the user's.
    moveWindow(
      clamp(window.screenX, b.left + MARGIN, b.right - w - MARGIN),
      clamp(window.screenY, b.top + MARGIN, b.bottom - h - MARGIN)
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
      x = b.left - w + sliver;
    } else if (name === "right") {
      x = b.right - sliver;
    } else if (name === "bottom") {
      y = b.bottom - sliver;
    } else if (name === "top") {
      y = b.top - h + sliver;
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

  /** Where a given spot sits once the screen and the window size are accounted for. */
  const clampPoint = (point) => {
    const b = screenBox();
    const w = W();
    const h = H();
    if (!point) {
      return homePos();
    }
    if (!w || !h) {
      return [Math.round(point.x), Math.round(point.y)];
    }
    return [
      Math.round(clamp(point.x, b.left + MARGIN, b.right - w - MARGIN)),
      Math.round(clamp(point.y, b.top + MARGIN, b.bottom - h - MARGIN)),
    ];
  };

  // ---------- movement

  const glide = (x, y, duration = GLIDE_MS, done = null) => {
    const id = ++glideId;
    const fromX = window.screenX;
    const fromY = window.screenY;
    const dx = x - fromX;
    const dy = y - fromY;
    // The glide is the mod moving the window, and where it lands is not a place
    // the user chose.
    modTarget = { x: Math.round(x), y: Math.round(y) };
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
    endControlsHold();
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
      if (home || !atImposedPlace()) {
        home = { x: window.screenX, y: window.screenY };
      }
      spot = null;
    }
    stopPeek();
    spot = side || spot || nearestSide();
    state = "tucked";
    root.setAttribute("pip-tucked", spot);
    // Tucking onto another edge changes which axis is the real one.
    syncHome();
    glide(...tuckedPos(spot));
    updateOverlay();
    reflectButton();
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
    reflectButton();
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
    // The player was tucked before it was ever seen, so it has no position of
    // its own. The place it was last left does exist, and using it is the whole
    // difference between a strip where the player belongs and a strip wherever
    // the platform happened to restore the window.
    const remembered = readHome();
    home = remembered ? { x: remembered.x, y: remembered.y } : null;
    persistedHome = null;
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
      // Put the window on the remembered place before deciding which edge it
      // belongs to: the side is read from where the window is, so a strip
      // chosen from the restored geometry lands wherever the platform left it.
      if (home) {
        const [hx, hy] = homePos();
        if (Math.abs(window.screenX - hx) > 2 || Math.abs(window.screenY - hy) > 2) {
          moveWindow(hx, hy);
        }
      }
      if (!spot) {
        spot = nearestSide();
        root.setAttribute("pip-tucked", spot);
        reflectButton();
      }
      moveWindow(...tuckedPos(spot));
    };
    settle();
    requestAnimationFrame(settle);
    for (const delay of [60, 150, 320]) {
      settleTimers.push(setTimeout(settle, delay));
    }
    reflectButton();
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

  /**
   * Bring the tucked player out. Hovering needs the setting and has to respect
   * the cooldown that keeps a retract from strobing; an explicit click does
   * not, because a person asking for the player is not an accident of geometry.
   */
  const reveal = (forced = false) => {
    if (state !== "tucked" || peeked || document.fullscreenElement) {
      return;
    }
    if (!forced && !pref(PREF_HOVER_PEEK, false)) {
      return;
    }
    if (!forced && Date.now() < reopenAfter) {
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

  /** A click on a tucked player is a request for it, not a hover accident. */
  const peekNow = () => {
    if (state !== "tucked" || peeked || document.fullscreenElement) {
      return false;
    }
    reopenAfter = 0;
    reveal(true);
    return peeked;
  };

  const retract = () => {
    if (!peeked) {
      return;
    }
    // Halfway through a drag the pointer usually leaves the player before the
    // player leaves the edge. Leaving it out is right; sliding it back under
    // the pointer is not.
    if (pullFromEdge() > Math.max(DRIFT_PX, PULL_FREE)) {
      reopenAfter = Date.now() + REVEAL_COOLDOWN;
      settleAfterPull();
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
    // The button in the bar owns its own right-click: it opens the direction map.
    if (event.target?.closest?.(`#${BUTTON_ID}`)) {
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
  const CLICK_SPLIT = 250; // ms a single click waits to learn it is not a double

  /**
   * A real control keeps its own click; everything else on the player is the
   * mod's business, which here means telling a single click from a double.
   */
  const isPlayerChrome = (node) => {
    try {
      return Boolean(
        node?.closest?.(
          "#controls button, #controls input, #controls [role='button'], #pip-tuck-away-overlay, #pip-tuck-away-picker"
        )
      );
    } catch (err) {
      return false;
    }
  };

  /** What a single click asks for, once it is known to be single. */
  const actOnClick = () => {
    if (state === "tucked" && !peeked) {
      peekNow();
      return;
    }
    if (peeked) {
      // A bare peek is a look at the video; a click asks for the controls.
      setBare(false);
      offerControls();
    }
  };

  /**
   * A double click is the player's own gesture, and it only fires when the event
   * target is `#controls` itself. A single-click action that runs first destroys
   * it: the window tucks away, or the controls appear under the pointer and the
   * second click lands on a button. So the single action waits a quarter of a
   * second, and a second click cancels it.
   */
  const cancelScheduledClick = () => {
    if (!clickTimer) {
      return false;
    }
    clearTimeout(clickTimer);
    clickTimer = null;
    return true;
  };

  const setLayerInert = (on) => {
    for (const node of layerControls()) {
      if (on) {
        node.style?.setProperty?.("pointer-events", "none", "important");
      } else {
        node.style?.removeProperty?.("pointer-events");
      }
    }
  };

  let lastPressAt = 0;

  /**
   * A press on the player, from either route it can arrive by.
   *
   * Both halves matter. A press over one of the player's own controls is that
   * control's business. A press anywhere else on a bare peek wants the controls
   * and gets them at once, because showing them moves nothing; their buttons
   * stay inert for the arbitration window so a second press still lands on the
   * control layer, which is the only place the player's own double click
   * becomes fullscreen.
   */
  const handlePress = (detail) => {
    const now = Date.now();
    const isDouble = detail > 1 || (lastPressAt > 0 && now - lastPressAt < 400);
    lastPressAt = now;
    if (isDouble) {
      // A second press is the platform's double click. The action the first
      // press scheduled is left to run: it either releases the inert hold, or
      // moves the window 250ms later, by which time the platform has finished
      // with the double click, and a reveal refuses to run in fullscreen.
      if (clickTimer) {
        return;
      }
      if (detail > 1) {
        return;
      }
    }
    if (peeked && bare) {
      setBare(false);
      offerControls();
      setLayerInert(true);
      cancelScheduledClick();
      clickTimer = setTimeout(() => {
        clickTimer = null;
        setLayerInert(false);
      }, CLICK_SPLIT);
      return;
    }
    if (state !== "tucked" || peeked) {
      return;
    }
    const at = { x: window.screenX, y: window.screenY };
    cancelScheduledClick();
    clickTimer = setTimeout(() => {
      clickTimer = null;
      if (Math.abs(window.screenX - at.x) > 4 || Math.abs(window.screenY - at.y) > 4) {
        return; // the window moved under the press: that is a drag, not a click
      }
      actOnClick();
    }, CLICK_SPLIT);
  };

  const onClickPlayer = (event) => {
    if (event.button !== 0) {
      return;
    }
    if (isPlayerChrome(event.target)) {
      return;
    }
    handlePress(event.detail);
  };

  /**
   * Most of the player is a window-drag region, and Gecko sends those presses as
   * `draggableregionleftmousedown` instead of a mousedown or a click. Without
   * this route a bare peek only showed its controls when the press happened to
   * land on one of the player's own buttons, which is the middle of the picture.
   */
  const onDragRegionPress = () => handlePress(0);

  const onResize = () => {
    updateOverlay();
    refreshSide();
    if (state === "tucked") {
      if (!document.fullscreenElement) {
        // Both positions are measured from the window size, so a resize
        // re-anchors whichever of the two is on screen.
        moveWindow(...(peeked ? flushPos(spot) : tuckedPos(spot)));
      }
      return;
    }
    // A remembered place beats a rescue. A window that is off screen right after
    // it opened is usually the platform putting back the geometry it saved when
    // the player was closed while tucked, and rescuing that to the nearest
    // corner is what made a player open in the corner from then on.
    if (!enforceHome()) {
      rescuePosition();
    }
  };

  const onFullscreenChange = () => {
    // A fullscreen round trip can rebuild the control bar, and the button has to
    // be in whatever bar exists afterwards.
    reflectButton();
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
  const PULL_FREE = 24; // px pulled in from the attached position that frees the player

  /**
   * How far the player has been pulled in from its attached position, along the
   * axis of the edge it is tucked against. Sliding along the edge leaves this
   * at zero, which is what keeps a sideways drag tucked while a drag into the
   * screen frees the player.
   */
  const pullFromEdge = () => {
    // Fullscreen is not a drag: the window becomes the screen, and every
    // measure of an edge stops meaning anything.
    if (state !== "tucked" || !spot || document.fullscreenElement) {
      return 0;
    }
    const w = W();
    const h = H();
    if (!w || !h) {
      return 0;
    }
    const [expectX, expectY] = peeked ? flushPos(spot) : tuckedPos(spot);
    if (spot === "right") {
      return expectX - window.screenX;
    }
    if (spot === "left") {
      return window.screenX - expectX;
    }
    if (spot === "top") {
      return window.screenY - expectY;
    }
    return expectY - window.screenY;
  };

  /**
   * A tucked player dragged into the screen is not tucked any more: it goes free
   * where it was let go, which is the whole point of pulling it out. The same
   * routine runs whether it was dragged from the strip or from a peek, because
   * both are just the window moving away from its attached position.
   */
  const releaseTuck = () => {
    stopPeek();
    state = "free";
    spot = null;
    root.removeAttribute("pip-tucked");
    setArmed(null);
    home = { x: window.screenX, y: window.screenY };
    persistHome();
    updateOverlay();
    refreshSide();
    reflectButton();
    return true;
  };

  /**
   * The place this player belongs, kept current as it moves.
   *
   * While the player is free that is simply where it is. While it is tucked the
   * window is mostly off screen, so only the axis that runs along the edge is
   * real and the other one is taken from where the player came from. That is
   * what makes a strip slid along the edge, or a peek dragged sideways, come
   * back to the place the user actually put it.
   */
  /** Is the window exactly where the mod last put it? */
  const atImposedPlace = () => {
    if (!modTarget) {
      return false;
    }
    return (
      Math.abs(window.screenX - modTarget.x) <= 2 && Math.abs(window.screenY - modTarget.y) <= 2
    );
  };

  const syncHome = () => {
    const b = screenBox();
    const w = W();
    const h = H();
    if (!w || !h) {
      return home;
    }
    if (state !== "tucked" && !home && atImposedPlace()) {
      // Nothing is remembered and the window is standing where the mod put it:
      // a rescue is not a place the user chose, and inheriting it is how the
      // corner a player was once rescued to became its home for good.
      return null;
    }
    const at = home || { x: window.screenX, y: window.screenY };
    const free = {
      x: Math.round(clamp(at.x, b.left + MARGIN, b.right - w - MARGIN)),
      y: Math.round(clamp(at.y, b.top + MARGIN, b.bottom - h - MARGIN)),
    };
    if (state === "tucked" && spot) {
      if (spot === "left" || spot === "right") {
        free.y = Math.round(clamp(window.screenY, b.top + MARGIN, b.bottom - h - MARGIN));
      } else {
        free.x = Math.round(clamp(window.screenX, b.left + MARGIN, b.right - w - MARGIN));
      }
    } else {
      free.x = Math.round(window.screenX);
      free.y = Math.round(window.screenY);
    }
    home = free;
    return free;
  };

  let persistedHome = null; // the last value written, so a poll cannot spam prefs
  let modTarget = null; // the last place the mod itself put the window
  const LOADED_AT = Date.now();
  const HOME_WINDOW = 3000; // ms after load that the remembered place is enforced

  /**
   * Every move this mod makes goes through here, so a later tick can tell a
   * place the user chose from a place the mod imposed. A rescue, a re-anchor or
   * a restore must never be written down as the user's position, or the one
   * place the player was rescued to becomes the place it always opens at.
   */
  const moveWindow = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return false;
    }
    modTarget = { x: Math.round(x), y: Math.round(y) };
    window.moveTo(modTarget.x, modTarget.y);
    return true;
  };
  // The spawn point is not a position anybody asked for. Nothing is remembered
  // until the player has been placed: at that moment the remembered place has
  // been read and the first real move can be tracked.
  let tracking = false;

  const persistHome = () => {
    const at = home;
    if (!at) {
      return false;
    }
    // Only a free window can be standing at a place the mod imposed. While
    // tucked the window is off screen by design and the place worth keeping is
    // the one it came from, which is not where it is.
    if (state === "free" && atImposedPlace()) {
      return false;
    }
    if (persistedHome && Math.abs(persistedHome.x - at.x) < 2 && Math.abs(persistedHome.y - at.y) < 2) {
      return false;
    }
    persistedHome = { x: at.x, y: at.y };
    writeHome(at.x, at.y);
    return true;
  };

  /**
   * Called on the same beat as the arming check: a place worth remembering is a
   * place the user put the player, and waiting for the window to close to write
   * it down loses every move when the player is killed, crashes, or the browser
   * is closed by something that does not run unload handlers.
   */
  /**
   * The platform restores a player's own last geometry a moment after it opens,
   * which for a player that was closed while tucked is a mostly off screen
   * place. Left alone, the window is then rescued to the nearest corner, and the
   * corner becomes the place it opens at forever. So for the first few seconds
   * the remembered place is put back, unless the pointer says a person is
   * already working with the window.
   */
  const enforceHome = () => {
    if (state !== "free" || document.fullscreenElement || animating || revealing) {
      return false;
    }
    if (Date.now() - LOADED_AT > HOME_WINDOW) {
      return false;
    }
    if (hovering() || Date.now() - pointer.at < 1200) {
      return false;
    }
    // The place on disk, never the in-memory one: while the window sits where
    // the platform put it, the in-memory home has already been dragged along to
    // that position, and enforcing it would enforce nothing.
    const wanted = readHome();
    const b = screenBox();
    const w = W();
    const h = H();
    if (!wanted || !w || !h) {
      return false;
    }
    const x = Math.round(clamp(wanted.x, b.left + MARGIN, b.right - w - MARGIN));
    const y = Math.round(clamp(wanted.y, b.top + MARGIN, b.bottom - h - MARGIN));
    if (Math.abs(window.screenX - x) <= 2 && Math.abs(window.screenY - y) <= 2) {
      return false;
    }
    return moveWindow(x, y);
  };

  const trackPosition = () => {
    if (!tracking) {
      return;
    }
    if (document.fullscreenElement || animating || revealing || Date.now() < settleUntil) {
      return;
    }
    enforceHome();
    syncHome();
    // A place the mod put the window in is not a place the user chose: a rescue,
    // a re-anchor or a restore must never be written down as their position, or
    // the corner a player was once rescued to becomes the place it always opens
    // at. A window that has been moved since is the user's again.
    if (
      modTarget &&
      Math.abs(window.screenX - modTarget.x) <= 2 &&
      Math.abs(window.screenY - modTarget.y) <= 2
    ) {
      return;
    }
    persistHome();
  };

  /**
   * The strip width lives in two places that cannot read each other: the
   * geometry here, and the badge, which is drawn by a style sheet. The number is
   * published as a custom property on the root element so the sheet can use it,
   * and a player that is already tucked moves to the width it was given.
   */
  const applyWidth = () => {
    const width = WIDTHS[stringPref(PREF_WIDTH, "normal")] ?? WIDTHS.normal;
    const changed = width !== sliver;
    sliver = width;
    try {
      root.style?.setProperty("--pip-sliver", `${width}px`);
    } catch (err) {
      log("could not publish the strip width", err);
    }
    if (changed && state === "tucked" && spot && !animating && !document.fullscreenElement) {
      moveWindow(...(peeked ? flushPos(spot) : tuckedPos(spot)));
    }
    return width;
  };

  /**
   * A dragged tucked player has two honest outcomes: it was pulled into the
   * screen, or it was taken to a different edge. Hanging over an edge it was not
   * tucked into means the second, and it tucks there instead of falling free,
   * so a player carried from one side to another changes its tuck rather than
   * landing in the middle of the screen.
   */
  const settleAfterPull = () => {
    const over = hungOver(true);
    if (over && over.side !== spot) {
      tuck(over.side);
      return true;
    }
    releaseTuck();
    return true;
  };

  const watchTucked = () => {
    if (tuckedTimer) {
      return;
    }
    tuckedTimer = setInterval(() => {
      if (state !== "tucked" || animating || revealing || document.fullscreenElement) {
        return;
      }
      if (Date.now() < settleUntil) {
        return;
      }
      // Somebody else moved the window: let go before anything else, or a
      // pointer resting on it would drag it straight back. A pull into the
      // screen frees the player; a slide along the edge keeps it tucked where
      // it now sits, because the attached position follows the drag.
      if (pullFromEdge() > Math.max(DRIFT_PX, PULL_FREE)) {
        settleAfterPull();
        return;
      }
      if (peeked) {
        return;
      }
      // A pointer that is still there should have the strip out, whether or not
      // an enter event ever arrived. Same condition the poll retracts on, so
      // the two can never disagree.
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
    if (name === PREF_WIDTH) {
      applyWidth();
    }
  };

  document.addEventListener("contextmenu", onContextMenu, true);
  document.addEventListener("click", onClickPlayer, true);
  for (const node of [window, document]) {
    node.addEventListener("draggableregionleftmousedown", onDragRegionPress, true);
  }
  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("mouseenter", onMouseEnter, true);
  document.addEventListener("mouseleave", onMouseLeave, true);
  window.addEventListener("resize", onResize);
  document.addEventListener("fullscreenchange", onFullscreenChange);
  Services.prefs.addObserver(PREF_HOVER_PEEK, onPrefChange);
  Services.prefs.addObserver(PREF_WIDTH, onPrefChange);
  watchTucked();

  // ---------- the tuck button in the player's control bar
  //
  // One button, drawn here, that tucks the window and comes back out again; a
  // right-click on it opens the direction map. The player's bar already has a
  // place for a control like this, and owning it means the gesture is the same
  // whether or not any other mod is installed.

  const BUTTON_ID = "pip-tuck-away-button";
  const SVG_NS = "http://www.w3.org/2000/svg";

  const buildButton = () => {
    const button = document.createElementNS(XHTML_NS, "button");
    button.id = BUTTON_ID;
    button.className = "control-item pip-tuck-away-button";
    button.setAttribute("type", "button");
    button.tabIndex = -1;
    button.setAttribute("aria-label", "Tuck the player away");
    button.setAttribute("aria-pressed", "false");
    button.dataset.side = "right";

    // A chevron, pointing at the edge the player would leave by.
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M9 5l7 7-7 7");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
    button.append(svg);

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setBare(false);
      toggle();
    });

    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setBare(false);
      togglePicker();
    });

    return button;
  };

  const ensureButton = () => {
    const controls = document.getElementById("controls");
    if (!controls) {
      return null;
    }
    let button = document.getElementById(BUTTON_ID);
    if (!button) {
      button = buildButton();
      controls.append(button);
    }
    return button;
  };

  /** The button says which way it will tuck, and whether the player is away. */
  const reflectButton = () => {
    const button = ensureButton();
    if (!button) {
      return;
    }
    const side = state === "tucked" ? spot || chosenSide() : chosenSide();
    if (button.dataset.side !== side) {
      button.dataset.side = side;
    }
    const away = state === "tucked" ? "true" : "false";
    if (button.getAttribute("aria-pressed") !== away) {
      button.setAttribute("aria-pressed", away);
    }
    const label = state === "tucked" ? "Bring the player back" : "Tuck the player away";
    if (button.getAttribute("aria-label") !== label) {
      button.setAttribute("aria-label", label);
    }
  };

  /**
   * Another mod that tucks may be installed beside this one. If it is, its own
   * button gives way to this one through the style sheet, and its window-moving
   * preference is switched off so only one thing owns the geometry. Neither call
   * does anything when that mod is not installed, which is the case this mod is
   * built for: nothing here is borrowed, so nothing here goes missing.
   */
  const quietOtherTuckers = () => {
    try {
      const name = "zia.pip.tuck";
      if (Services.prefs.getPrefType(name) === Services.prefs.PREF_BOOL && Services.prefs.getBoolPref(name, false)) {
        Services.prefs.setBoolPref(name, false);
      }
    } catch (err) {
      // No other tucking mod, or a preference that cannot be written.
    }
  };
  quietOtherTuckers();

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

  const ensurePicker = () => {
    let picker = pickerElement();
    if (picker) {
      return picker;
    }
    const controls = document.getElementById("controls");
    if (!controls) {
      return null;
    }
    picker = buildPicker();
    controls.append(picker);
    return picker;
  };

  const openPicker = () => {
    const picker = ensurePicker();
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
   * A bare reveal has to be bare. Another mod may add elements of its own to the
   * control layer, Firefox raises opacity through `#controls[showing]`, `[keying]`
   * and hover rules of its own, and a style sheet of ours only wins that fight on
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

  /**
   * The frosted glass on a tucked strip is a matter of taste: a plain strip of
   * video is what some people want. Off, the attribute that carries the filter
   * is dropped, and any filter already on the element goes with it, so a strip
   * that was frosted a moment ago is plain at once rather than at the next tuck.
   */
  const applyFrost = () => {
    try {
      if (pref(PREF_FROST, true)) {
        root.setAttribute(FROST_ATTR, "");
      } else {
        root.removeAttribute(FROST_ATTR);
        clearFrost();
      }
    } catch (err) {
      // A player without a root element needs nothing.
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
  const endControlsHold = () => {
    if (controlsTimer) {
      clearTimeout(controlsTimer);
      controlsTimer = null;
    }
    root.removeAttribute(CONTROLS_ATTR);
  };

  const offerControls = () => {
    hideControlLayer(false);
    root.setAttribute(CONTROLS_ATTR, "");
    if (controlsTimer) {
      clearTimeout(controlsTimer);
    }
    controlsTimer = setTimeout(() => {
      controlsTimer = null;
      // Firefox hides the controls on a timer of its own, and a peek has
      // already spent the pointer-enter that would have shown them. A pointer
      // still on the player is a person still looking at the controls, so the
      // hand-over is renewed instead of expiring under them.
      if (peeked || hovering()) {
        offerControls();
        return;
      }
      endControlsHold();
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
    moveWindow(x, y);
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
    applyFrost();
    const controls = document.getElementById("controls");
    if (!controls) {
      return;
    }
    ensureOverlayStyle();
    reflectButton();
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

  const onFrostPref = () => {
    applyFrost();
  };

  const onOpenPref = (subject, topic, name) => {
    if (topic !== "nsPref:changed") {
      return;
    }
    if (name === PREF_SIZE) {
      applyDefaultSize();
      if (placeIsChosen()) {
        applyDefaultPlace();
        if (state !== "tucked") {
          instantTuck(spot);
        }
      }
      return;
    }
    if (name === PREF_PLACE) {
      if (applyDefaultPlace() && state !== "tucked") {
        instantTuck(spot);
      }
    }
  };

  Services.prefs.addObserver(PREF_SIZE, onOpenPref);
  Services.prefs.addObserver(PREF_PLACE, onOpenPref);
  Services.prefs.addObserver(PREF_FROST, onFrostPref);
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
  // handle rather than a chopped-up sliver. The idea of frosting that sliver is
  // borrowed from Zia; the implementation here is its own, an attribute on the
  // root plus rules in the sheet.

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
    // The badge never takes an event. Firefox only goes fullscreen on a double
    // click whose target is `#controls`, so anything painted over the strip that
    // accepts the press breaks that gesture, and a single click belongs to the
    // player too. The key handler keeps it reachable without a pointer.
    badge.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      if (state === "tucked") {
        untuck();
      }
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

  // ---------- how a player opens
  //
  // Two settings decide where a player appears and how big it is. Both default
  // to leaving it alone: the platform remembers a player's size and place, and
  // that is what most people want. A size is applied to the window with the
  // shape it already has, so the video is never stretched. A place is written
  // into the mod's own position memory and then tucked, because a chosen place
  // is a place for the strip to live in.

  const SIZES = {
    "very-small": 200,
    small: 280,
    medium: 380,
    large: 520,
    "very-large": 680,
  };

  const PLACES = {
    "top-left": (b, w, h) => [b.left + MARGIN, b.top + MARGIN],
    "top-middle": (b, w, h) => [Math.round(b.left + (b.right - b.left - w) / 2), b.top + MARGIN],
    "top-right": (b, w, h) => [b.right - w - MARGIN, b.top + MARGIN],
    "bottom-left": (b, w, h) => [b.left + MARGIN, b.bottom - h - MARGIN],
    "bottom-middle": (b, w, h) => [Math.round(b.left + (b.right - b.left - w) / 2), b.bottom - h - MARGIN],
    "bottom-right": (b, w, h) => [b.right - w - MARGIN, b.bottom - h - MARGIN],
  };

  /** The size the setting asks for, or null when the platform remembers it. */
  const wantedSize = () => {
    const choice = prefString(PREF_SIZE, REMEMBER);
    const width = SIZES[choice];
    if (!width) {
      return null;
    }
    // The window already has the video's shape, so scaling one side keeps it.
    const aspect = W() / H();
    if (!Number.isFinite(aspect) || aspect < 0.2 || aspect > 6) {
      return null;
    }
    const height = Math.max(90, Math.round(width / aspect));
    return { width, height };
  };

  const applyDefaultSize = () => {
    const want = wantedSize();
    if (!want) {
      return false;
    }
    if (W() === want.width && H() === want.height) {
      return false;
    }
    try {
      window.resizeTo(want.width, want.height);
      // A window that grew past an edge comes back, rather than opening half
      // off screen.
      const b = screenBox();
      const x = clamp(window.screenX, b.left + MARGIN, Math.max(b.left + MARGIN, b.right - want.width - MARGIN));
      const y = clamp(window.screenY, b.top + MARGIN, Math.max(b.top + MARGIN, b.bottom - want.height - MARGIN));
      if (Math.abs(x - window.screenX) > 2 || Math.abs(y - window.screenY) > 2) {
        moveWindow(x, y);
      }
      return true;
    } catch (err) {
      log("could not set the player size", err);
      return false;
    }
  };

  /** The place the setting asks for, or null when the platform remembers it. */
  const wantedPlace = () => {
    const choice = prefString(PREF_PLACE, REMEMBER);
    const make = PLACES[choice];
    if (!make) {
      return null;
    }
    const [x, y] = make(screenBox(), W(), H());
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    return { x: Math.round(x), y: Math.round(y) };
  };

  /**
   * Put a chosen place where the mod keeps its position memory, so the tuck
   * that follows lands the strip there and a later untuck returns to it.
   */
  const applyDefaultPlace = () => {
    const at = wantedPlace();
    if (!at) {
      return false;
    }
    home = { x: at.x, y: at.y };
    writeHome(at.x, at.y);
    return true;
  };

  const placeIsChosen = () => !!wantedPlace();

  const applyOpenDefaults = () => {
    applyDefaultSize();
    applyDefaultPlace();
  };

  ensureBadge();
  applyWidth();
  applyOpenDefaults();

  // One timer for the life of the window: a size read and four subtractions
  // every 200ms, which is what notices a player dragged past an edge.
  if (!armTimer) {
    armTimer = setInterval(() => {
      watchArmed();
      trackPosition();
    }, ARM_POLL);
  }
  watchArmed();
  trackPosition();

  // Start tucked rather than showing the player in its normal place first.
  // A chosen place is always tucked: it names a place for the strip, and a
  // player that opened in the middle of the screen would not be there.
  if (pref(PREF_AUTO_TUCK, false) || placeIsChosen()) {
    instantTuck();
    tracking = true;
  } else {
    // Firefox restores the last position just after the window opens, so check
    // more than once: first for a place this mod remembers, then that whatever
    // is left is somewhere the user can see.
    const placePlayer = () => {
      if (!restoreHome() && !enforceHome()) {
        rescuePosition();
      }
      tracking = true;
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
    document.removeEventListener("click", onClickPlayer, true);
    for (const node of [window, document]) {
      node.removeEventListener("draggableregionleftmousedown", onDragRegionPress, true);
    }
    cancelScheduledClick();
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("mouseenter", onMouseEnter, true);
    document.removeEventListener("mouseleave", onMouseLeave, true);
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    window.removeEventListener("resize", onResize);
    try {
      Services.prefs.removeObserver(PREF_HOVER_PEEK, onPrefChange);
      Services.prefs.removeObserver(PREF_WIDTH, onPrefChange);
    } catch (err) {
      log("could not remove the preference observer", err);
    }
    if (state === "tucked") {
      untuck();
    }
    root.removeAttribute("pip-tucked");
    root.removeAttribute("pip-peeking");
    try {
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
      document.getElementById(BUTTON_ID)?.remove();
      document.removeEventListener("mousedown", onDocumentMouseDown, true);
      Services.prefs.removeObserver(PREF_FROST, onFrostPref);
      Services.prefs.removeObserver(PREF_SIZE, onOpenPref);
      Services.prefs.removeObserver(PREF_PLACE, onOpenPref);
      Services.prefs.removeObserver(PREF_OVERLAY, onOverlayPref);
      Services.prefs.removeObserver(PREF_DIRECTION, onOverlayPref);
    } catch (err) {
      log("could not drop the preference observers", err);
    }
    delete window.__pipTuckAway;
  };

  window.__pipTuckAway = {
    toggle,
    tuck,
    untuck,
    destroy,
    isTucked: () => state === "tucked",
    size: () => ({ want: wantedSize(), at: [W(), H()] }),
    place: () => ({ want: wantedPlace(), home, spot }),
    stats: () => ({ state, spot, home, tracking, sliver, peeked, modTarget, loadedAt: LOADED_AT }),
    why: () => ({
      hover: hovering(),
      pointerAt: pointer.at,
      nowMinusPointer: Date.now() - pointer.at,
      animating,
      revealing,
      age: Date.now() - LOADED_AT,
      disk: readHome(),
      pos: [window.screenX, window.screenY],
      hp: homePos(),
    }),
  };
  /**
   * Last chance to note where the player belongs: while tucked that is the
   * place it came from, because the window itself is mostly off screen.
   */
  window.addEventListener(
    "unload",
    () => {
      try {
        syncHome();
        persistHome();
      } catch (err) {
        // A window on its way out needs nothing.
      }
      destroy();
    },
    { once: true }
  );
})();
