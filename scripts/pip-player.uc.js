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
  const BARE_STYLE_ID = "pip-tuck-away-bare-style";
  const BARE_CSS = [
    ":root[pip-tuck-away-bare] .control-item{opacity:0 !important;transition:none !important}",
    // Firefox hides the cursor whenever the controls are hidden. In a bare
    // reveal that leaves a pointer you cannot see, so keep it.
    ":root[pip-tuck-away-bare] #controls{cursor:default !important}",
  ].join("");
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
  let leaveTimer = null;
  let pollTimer = null;
  let tuckedTimer = null;
  let reopenAfter = 0;
  let controlsTimer = null;
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
   * Measured as the gap between the window's own edge and each screen edge,
   * with the window pulled inside the screen box first so a position restored
   * from a different display or scaling cannot decide it. A sideways tuck
   * leaves the video as a tall strip, which is what a player wants, so a
   * vertical edge has to be clearly closer to win. Centre distance was the old
   * measure and it parked wide, short windows on the top or bottom edge even
   * when they sat in a corner.
   */
  const EDGE_BIAS = 1.25;
  const nearestSide = () => {
    const b = screenBox();
    const w = W();
    const h = H();
    const x = clamp(window.screenX, b.left, b.right - w);
    const y = clamp(window.screenY, b.top, b.bottom - h);
    const gap = {
      left: x - b.left,
      right: b.right - (x + w),
      top: y - b.top,
      bottom: b.bottom - (y + h),
    };
    const sideways = Math.min(gap.left, gap.right);
    const standing = Math.min(gap.top, gap.bottom) * EDGE_BIAS;
    if (standing < sideways) {
      return gap.top <= gap.bottom ? "top" : "bottom";
    }
    return gap.left <= gap.right ? "left" : "right";
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
    updateOverlay();
    reflectZiaButton();
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
    if (!bare) {
      if (root.hasAttribute(BARE_ATTR)) {
        root.removeAttribute(BARE_ATTR);
      }
      return;
    }
    if (!document.getElementById(BARE_STYLE_ID)) {
      try {
        const style = document.createElementNS("http://www.w3.org/1999/xhtml", "style");
        style.id = BARE_STYLE_ID;
        style.textContent = BARE_CSS;
        document.documentElement.appendChild(style);
      } catch (err) {
        log("could not style the bare reveal", err);
      }
    }
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
  const ZIA_STYLE_ID = "pip-tuck-away-zia";

  const showZiaButton = () => {
    if (document.getElementById(ZIA_STYLE_ID)) {
      return;
    }
    try {
      const style = document.createElementNS("http://www.w3.org/1999/xhtml", "style");
      style.id = ZIA_STYLE_ID;
      // Zia hides the button with display:none and only shows it while its own
      // tuck is on. Both of its rules are matched here, because a bare
      // !important would lose to the :root[zia-no-tuck] one.
      style.textContent =
        "#controls .zia-pip-tuck-button,:root[zia-no-tuck] #controls .zia-pip-tuck-button{display:inline-flex !important;}";
      document.documentElement.appendChild(style);
    } catch (err) {
      log("could not show Zia's tuck button", err);
    }
  };

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

  const reconcileZia = () => {
    if (!ziaButton()) {
      return;
    }
    showZiaButton();
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

  const XHTML_NS = "http://www.w3.org/1999/xhtml";
  const PREF_OVERLAY = "pip-tuck-away.overlay";
  const PREF_DIRECTION = "pip-tuck-away.direction";
  const OVERLAY_ID = "pip-tuck-away-overlay";
  const PICKER_ID = "pip-tuck-away-picker";
  const OVERLAY_STYLE_ID = "pip-tuck-away-overlay-style";
  const SIDES = ["right", "top", "left", "bottom"];
  const PICKER_ORDER = ["top", "left", "smart", "right", "bottom"];
  const DIRECTION_LABELS = {
    smart: "Smart",
    right: "Right",
    top: "Top",
    left: "Left",
    bottom: "Bottom",
  };

  const OVERLAY_CSS = [
    "#pip-tuck-away-overlay{position:absolute;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.3em;border:0;padding:0;margin:0;background:transparent;color:#fff;font:600 11px/1.15 system-ui,-apple-system,'Segoe UI',sans-serif;letter-spacing:.03em;cursor:pointer;opacity:.45;z-index:0;-moz-window-dragging:no-drag;text-shadow:0 1px 3px rgba(0,0,0,.9);transition:opacity 120ms linear,background-color 120ms linear}",
    "#pip-tuck-away-overlay[hidden]{display:none}",
    "#pip-tuck-away-overlay:hover,#pip-tuck-away-overlay:focus-visible{opacity:1;background:rgba(0,0,0,.3);outline:none}",
    "#pip-tuck-away-overlay[data-side=left]{left:0;top:5%;width:20%;height:90%}",
    "#pip-tuck-away-overlay[data-side=right]{right:0;top:5%;width:20%;height:90%}",
    "#pip-tuck-away-overlay[data-side=top]{top:0;left:5%;width:90%;height:20%}",
    "#pip-tuck-away-overlay[data-side=bottom]{bottom:0;left:5%;width:90%;height:20%}",
    "#pip-tuck-away-overlay .pip-tuck-away-arrow{width:0;height:0;border:7px solid transparent}",
    "#pip-tuck-away-overlay[data-side=left] .pip-tuck-away-arrow{border-right-color:#fff}",
    "#pip-tuck-away-overlay[data-side=right] .pip-tuck-away-arrow{border-left-color:#fff}",
    "#pip-tuck-away-overlay[data-side=top] .pip-tuck-away-arrow{border-bottom-color:#fff}",
    "#pip-tuck-away-overlay[data-side=bottom] .pip-tuck-away-arrow{border-top-color:#fff}",
    "#pip-tuck-away-picker{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2;display:grid;grid-template-columns:repeat(3,auto);gap:4px;padding:8px;border-radius:10px;background:rgba(24,24,27,.94);color:#fff;font:600 11px/1 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.5);-moz-window-dragging:no-drag}",
    "#pip-tuck-away-picker[hidden]{display:none}",
    "#pip-tuck-away-picker .pip-tuck-away-picker-title{grid-column:1/-1;font-weight:600;opacity:.7;text-align:center;padding:2px 0 5px}",
    "#pip-tuck-away-picker button{appearance:none;border:0;background:rgba(255,255,255,.08);color:inherit;font:inherit;padding:6px 9px;border-radius:6px;cursor:pointer}",
    "#pip-tuck-away-picker button:hover{background:rgba(255,255,255,.22)}",
    "#pip-tuck-away-picker button[aria-pressed=true]{background:rgba(255,255,255,.32)}",
    "#pip-tuck-away-picker button[data-side=top]{grid-column:2;grid-row:2}",
    "#pip-tuck-away-picker button[data-side=left]{grid-column:1;grid-row:3}",
    "#pip-tuck-away-picker button[data-side=smart]{grid-column:2;grid-row:3}",
    "#pip-tuck-away-picker button[data-side=right]{grid-column:3;grid-row:3}",
    "#pip-tuck-away-picker button[data-side=bottom]{grid-column:2;grid-row:4}",
  ].join("");

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

  const ensureOverlayStyle = () => {
    if (document.getElementById(OVERLAY_STYLE_ID)) {
      return;
    }
    try {
      const style = document.createElementNS(XHTML_NS, "style");
      style.id = OVERLAY_STYLE_ID;
      style.textContent = OVERLAY_CSS;
      document.documentElement.appendChild(style);
    } catch (err) {
      log("could not style the tuck overlay", err);
    }
  };

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

  const playerHolder = () => {
    try {
      return document.querySelector(".player-holder");
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
    root.setAttribute(CONTROLS_ATTR, "");
    if (controlsTimer) {
      clearTimeout(controlsTimer);
    }
    controlsTimer = setTimeout(() => {
      controlsTimer = null;
      root.removeAttribute(CONTROLS_ATTR);
    }, CONTROLS_HOLD);
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
  const TUCK_STYLE_ID = "pip-tuck-away-tuck-style";
  const TUCK_CSS = [
    "#pip-tuck-away-badge{position:fixed;z-index:40;display:none;align-items:center;justify-content:center;background:rgba(24,24,27,.32);cursor:pointer;-moz-window-dragging:drag;transition:background-color 160ms linear}",
    "#pip-tuck-away-badge:hover{background:rgba(24,24,27,.55)}",
    "#pip-tuck-away-badge::after{content:'';width:7px;height:7px;border-right:2px solid rgba(255,255,255,.92);border-bottom:2px solid rgba(255,255,255,.92);transition:transform 200ms ease}",
    ":root[pip-tucked] #pip-tuck-away-badge{display:flex}",
    // The peek owns the window while it is out, and the badge has nothing to
    // point at then.
    ":root[pip-peeking] #pip-tuck-away-badge{display:none}",
    ":root[pip-tucked=left] #pip-tuck-away-badge{right:0;top:0;bottom:0;width:24px}",
    ":root[pip-tucked=left] #pip-tuck-away-badge::after{transform:rotate(135deg)}",
    ":root[pip-tucked=right] #pip-tuck-away-badge{left:0;top:0;bottom:0;width:24px}",
    ":root[pip-tucked=right] #pip-tuck-away-badge::after{transform:rotate(-45deg)}",
    ":root[pip-tucked=top] #pip-tuck-away-badge{left:0;right:0;bottom:0;height:24px}",
    ":root[pip-tucked=top] #pip-tuck-away-badge::after{transform:rotate(-135deg)}",
    ":root[pip-tucked=bottom] #pip-tuck-away-badge{left:0;right:0;top:0;height:24px}",
    ":root[pip-tucked=bottom] #pip-tuck-away-badge::after{transform:rotate(45deg)}",
    // Firefox's controls belong to the part of the player nobody can see.
    ":root[pip-tucked]:not([pip-peeking]) #controls{visibility:hidden}",
    // A filter on the holder works on the video itself, where a backdrop blur
    // cannot see it, and it clears as the window slides back out.
    ":root[pip-tucked] .player-holder{transition:filter 280ms ease}",
    ":root[pip-tucked]:not([pip-peeking]) .player-holder{filter:blur(16px) brightness(.85)}",
    // A peek is a look at the video, so nothing may tint it, whatever state the
    // attributes happen to be in.
    ":root[pip-peeking] .player-holder{filter:none !important}",
    ":root[pip-controls] .control-item{opacity:1 !important}",
  ].join("");

  const ensureTuckLook = () => {
    if (document.getElementById(TUCK_STYLE_ID)) {
      return;
    }
    try {
      const style = document.createElementNS(XHTML_NS, "style");
      style.id = TUCK_STYLE_ID;
      style.textContent = TUCK_CSS;
      document.documentElement.appendChild(style);
    } catch (err) {
      log("could not style the tucked strip", err);
    }
  };

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

  const ensureBadge = () => {
    ensureTuckLook();
    if (document.getElementById(BADGE_ID)) {
      return;
    }
    try {
      (document.body ?? document.documentElement).appendChild(buildBadge());
    } catch (err) {
      log("could not build the tucked strip badge", err);
    }
  };

  ensureBadge();

  // Start tucked rather than showing the player in its normal place first.
  if (pref(PREF_AUTO_TUCK, false)) {
    instantTuck(nearestSide());
  } else {
    // Firefox restores the last position just after the window opens, so check
    // more than once that it is actually somewhere the user can see.
    for (const delay of [0, 300, 800]) {
      settleTimers.push(setTimeout(rescuePosition, delay));
    }
  }

  const destroy = () => {
    stopPeek();
    glideId++;
    if (tuckedTimer) {
      clearInterval(tuckedTimer);
      tuckedTimer = null;
    }
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
      document.getElementById(ZIA_STYLE_ID)?.remove();
      if (controlsTimer) {
        clearTimeout(controlsTimer);
        controlsTimer = null;
      }
      document.getElementById(BADGE_ID)?.remove();
      document.getElementById(TUCK_STYLE_ID)?.remove();
      document.getElementById(BARE_STYLE_ID)?.remove();
      root.removeAttribute(BARE_ATTR);
      document.getElementById(OVERLAY_ID)?.remove();
      document.getElementById(PICKER_ID)?.remove();
      document.getElementById(OVERLAY_STYLE_ID)?.remove();
      document.removeEventListener("mousedown", onDocumentMouseDown, true);
      Services.prefs.removeObserver(PREF_OVERLAY, onOverlayPref);
      Services.prefs.removeObserver(PREF_DIRECTION, onOverlayPref);
    } catch (err) {
      log("could not remove the Zia button style", err);
    }
    delete window.__pipTuckAway;
  };

  window.__pipTuckAway = { toggle, tuck, untuck, destroy, isTucked: () => state === "tucked" };
  window.addEventListener("unload", destroy, { once: true });
})();
