# PiP Tuck Away

A Sine mod for Zen Browser that gets the picture-in-picture player out of the way. Throw it at a screen edge and it slides mostly off screen, leaving a small strip of video. Right-click, press Ctrl+Shift+T, or hover the strip to bring it back.

Picture-in-picture is useful right up until it sits on top of the thing you are reading. Firefox lets you move the window but never remembers where it went, so every video ends up parked over the same paragraph. This mod turns the screen edge into a drawer.

## How it behaves

Right-clicking the player tucks it into the closest edge and right-clicking again pulls it back out. Pressing **Ctrl+Shift+T** switches between the two states from any Zen window, so the shortcut works while you are typing in the browser as well as while the video has focus. Hovering the strip slides the whole player back into view, and it returns to the edge as soon as the pointer leaves the video.

Tucking keeps the window's size and only moves it, so the video never re-encodes, restarts, or loses its place. The strip is a narrow sliver on a side edge and sits flush with the screen, which makes it reachable without aiming. Coming back out by hand places the player inside the screen edges with a 16px margin, never half off screen.

The edge is chosen when you tuck: whichever of left, right, or bottom the window is nearest to. There is no top edge, because macOS refuses to move a window above the screen.

## Settings

The mod adds one section to its settings dialog in Sine.

| Setting | Default | What it does |
| --- | --- | --- |
| Tuck away on right click | on | Right-clicking the player toggles tucked and untucked |
| Tuck Control Overlay | on | Shows the tuck strip on the player, with an arrow and the words Tuck Away |
| Tuck Direction | Smart | Which edge the strip tucks into: Smart, Right, Top, Left or Bottom |
| Toggle with Ctrl+Shift+T | on | The keyboard toggle, from any Zen window |
| Peek while hovering the tucked strip | off | Hovering the strip slides the player into view until the pointer leaves the video |
| Auto tuck on PiP switch | off | The player opens already tucked, instead of appearing in its normal place first |
| Integrate PiP in the player widget | off | Switching tabs keeps the video in Zen's sidebar card; the window appears only when you leave Zen |

The peek is off by default on purpose. Once it is on, the strip stops being a static sliver and starts responding to the pointer, which some people find distracting while watching something in the corner.

The reveal is sticky by design. It stays up while the pointer is anywhere in a band around the player, including the area the player slides into, and a departure is only believed after a fifth of a second, so grazing an edge or crossing a gap does not collapse it. A pointer resting still on the video keeps it open without limit, which is the case a naive hover check gets wrong: the window moves underneath a pointer that has not moved at all, and the document can stop reporting hover state mid-slide. The mod judges that from the pointer's last screen position and the document's own hover state together, never from whether the pointer has moved recently. Dragging the strip out by hand releases the tuck instead of fighting over the position, and fullscreen is left alone entirely. A reveal that comes from the pointer resting on the strip shows the video and nothing else. Firefox's controls and the dark gradient it draws along the bottom stay away, and the pointer stays visible, so a peek reads as a look rather than a set of buttons you did not ask for. They come back as soon as the pointer travels more than 24px across the revealed player, which is what reaching for a button looks like; a jitter does not count. Right-clicking or letting the strip fold away ends the bare look as well. The last few pixels of the screen get their own rule: that band belongs to the window's resize border, and a window sliding under a pointer that has not moved can stop reporting hover, so a pointer within 12px of the tucked edge counts as still there. Without that, parking the cursor on the screen edge made the reveal strobe. A reveal also cannot come back for a quarter second after it folds away, so a genuine departure never snaps it open again.

Auto tuck is off by default because it changes where the player starts life. Turn it on and the very first thing you see when a video goes picture-in-picture is the strip at the edge, chosen as the edge nearest where the player would normally have appeared. Firefox restores a player window's last position and size just after it opens, so the mod re-applies the tucked position a few times across the first third of a second to win that race. A single frame at the old spot can still slip through on a slow start, which is the price of doing this from a script rather than inside the browser's own window code.

## The tuck strip

The player carries a strip that tucks it. It is not a small pill beside the controls: it is a band of the video itself, 20% of the width and 90% of the height along the side it will tuck into, and 90% by 20% across the top or the bottom. Inside it are an arrow pointing at that edge and the words Tuck Away, at 45% opacity until you hover, then solid, on a faint dark wash.

Press it and the player parks against that edge. Right-click it and a small map of the directions opens, the same idea as Zia's picker: Smart in the middle, with Right, Top, Left and Bottom around it, the current choice lit. Pick one and the strip moves to that side, and the setting is saved, so it holds for the next video too.

**Smart** means the edge the player is nearest to when it has no fixed direction, measured as the gap between the player's own edge and each screen edge. Sideways wins unless the top or bottom is clearly closer, because a side tuck leaves the video as a tall strip rather than a thin bar. A player sitting in a corner tucks into the side of that corner; only a player parked near the middle of the top or bottom goes up or down. The measurement uses the player's position clamped into the screen first, so a position saved on another display or scaling cannot decide it, and a player that opens mostly off screen is pulled back into view before anything else happens.

The strip is a child of Firefox's own `#controls` layer, placed before everything else in it, so the control bar, the close and minimise buttons and Zia's own controls all sit above it and keep their clicks. Where those cover it, they win; the rest of the strip is the tuck target.

With **Tuck Control Overlay** off there is no strip at all, and tucking falls back to right-click, the chord and auto tuck. The strip also steps aside while the player is tucked or in fullscreen, because the strip at the edge is the way back.

The overlay is on by default and works whether or not Zia is installed. When Zia is there, both its button and this strip do the same thing, since both end up in the same tuck.

## Player widget integration

Zen already has a media card in the sidebar. It shows whatever is playing, with play, seek, mute and its own PiP button, and it hides itself the moment that video is in a PiP window. Firefox also opens a PiP window by itself when a playing tab is hidden by a tab switch, which is what the Auto-PiP setting does. Together those mean switching tabs inside Zen replaces the card with a floating window, which is backwards.

With **Integrate PiP in the player widget** on, the automatic window from a tab switch is not created while Zen has focus. The video keeps playing in its tab and the sidebar card stays put with its controls. Switch away from Zen and the player pops out then, because that is when a floating window is worth having. Come back and the window closes, so the card takes over again.

Watching a video on its own tab and leaving Zen works the same way, even though the browser asks for nothing by itself: it only pips a tab that got hidden, and its own handler deliberately skips the selected tab. The mod asks that tab's launcher for a player when Zen loses focus, which is the same toggle the browser uses, so the window appears without a tab switch. It asks once per departure, never while a player is already open, and never for a muted tab. The catch is scope: it asks the tab you are looking at, so a video playing in some other tab comes out only through the tab-switch path above. The fold is careful about one piece of browser state. Floating a player makes the platform mark the tab as auto-pipped and force its docshell active so the hidden tab keeps running, and both marks are cleared only by the platform's own foreground close. Closing the window a plainer way left the tab flagged, so it never reported itself hidden again and no player was ever requested a second time: the video folded away once and never came back. The mod now closes through that foreground path and restores the docshell, and it keeps the video as a pending request, so leaving Zen a second time brings the player out again without needing another tab switch. Two rules keep it predictable. A request you make yourself, from the card's PiP button or the video's own toggle, is never intercepted, so asking for a window always gets you one. And interception only happens while Zen has focus, so a player requested from a background window still opens normally.

The mechanism is a wrapper around `PictureInPicture.handlePictureInPictureRequest`, the single place Firefox creates a player from. It tells the automatic path apart by checking whether the requesting browser's docshell is inactive, which is Mozilla's own marker: a docshell is only inactive when the request came from the auto toggle for a hidden tab.

## Install

Sine installs mods straight from a repository. Paste this into Sine's mod installer:

```text
https://github.com/apoapostolov/Zen-PiP-Tuck-Away
```

Restart Zen afterwards, because script mods load at startup.

One requirement applies to every Sine mod installed from a repository rather than the store: JavaScript must be allowed. Check that `sine.allow-unsafe-js` is `true` in `about:config`, otherwise the mod installs, appears enabled, and does nothing at all. Mods that ship scripts run with full browser privileges, so read the two files in `scripts/` before you trust them. They are short and they only move a window.

## Using it with Zia

Zia tucks picture-in-picture too, and two mods moving the same window turn every tuck into a tug of war. Set `zia.pip.tuck` to `false` in `about:config` and Zia's edge code goes dormant, which is what the install writes into `user.js` for you.

The button stays. Zia hides its tuck button once its own switch is off, and a player missing a control it used to have looks broken, so this mod shows the button again and puts its own tuck behind it. The click is taken in the capture phase, before Zia's handler runs, so exactly one thing moves the window:

- Clicking the button tucks, and clicking it again brings the player back. Zia's own button only ever tucked.
- Right-clicking it still opens Zia's spot picker. A spot you pick there is honoured through this mod, folded onto the nearest side it parks against, which is left, right or bottom.
- The button reports its state through `aria-pressed`, so it is not a toggle that looks the same both ways.
- Right-clicks anywhere else inside Zia's controls are passed straight to Zia, so its picker and the rest of its player styling are untouched.
- The two mods share no state: this one marks the window with `pip-tucked` and `pip-peeking`, never writes Zia's preferences, and Zia keeps its own `zia-*` attributes.

## The keyboard chord

Ctrl+Shift+T toggles the player. The listener is installed on every chrome window the browser owns, not just the main one, so the chord works from a second browser window and from the player itself, which is the window that usually has focus while you are watching something. The player is found through the window mediator rather than through the window that saw the key, so there is one code path whether the chord lands in the browser or in the player.

The chord only acts while a player window is open. With nothing playing it is passed through untouched, so Ctrl+Shift+T still reopens a closed tab the way the browser intends.

Outside Zen it does nothing. Windows gives a chord to another application only through a native registration, and the platform has no hotkey API a browser mod could use, so there is no honest way to make this work while another application has focus.

## Known limits

- It only touches picture-in-picture. Normal windows are none of its business.
- Tucking is skipped while the player is in fullscreen, since there is nothing to hide there.
- The player window keeps its size, so a very large video leaves a taller strip than a small one. The strip is always a narrow sliver along the edge.
- Built and tested against Sine 2.3.4.1c and Zen Twilight 1.24t. Zen's own mod loader uses a different content URL, so the player half will not load there without a path change.

## How it is put together

Two scripts, no stylesheet, no helper process.

| File | Runs in | Job |
| --- | --- | --- |
| `scripts/pip-tuck-away.uc.js` | any browser window | Watches for player windows, loads the player half into each one, owns the keyboard chord on every window, keeps playback inline while Zen has focus |
| `scripts/pip-player.uc.js` | the picture-in-picture player | Right-click, hover peek, the move maths, and the exposed toggle API |

Sine declares only the first script, so it loads exactly once into `browser.xhtml`. The second is loaded on demand through `Services.scriptloader.loadSubScript`, using the profile's `content sine ../sine-mods/` manifest entry, which is why the mod's files are reachable at `chrome://sine/content/pip-tuck-away/`.

## Credits

The screen-edge geometry and the load-into-the-player technique are adapted from [Zia](https://github.com/z1n-k/zia) by z1n-k, which is MIT licensed. Zia bundles this idea inside a much larger reskin; this mod exists to have the tuck on its own, with its own controls. Details in [CREDITS.md](CREDITS.md).

MIT licensed. See [LICENSE](LICENSE).
