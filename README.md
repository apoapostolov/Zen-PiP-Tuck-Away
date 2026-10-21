# PiP Tuck Away

A Sine mod for Zen Browser that gets the picture-in-picture player out of the way. Throw it at a screen edge and it slides mostly off screen, leaving a 24px strip of video. Right-click, press Ctrl+Shift+T, or hover the strip to bring it back.

Picture-in-picture is useful right up until it sits on top of the thing you are reading. Firefox lets you move the window but never remembers where it went, so every video ends up parked over the same paragraph. This mod turns the screen edge into a drawer.

## How it behaves

Right-clicking the player tucks it into the closest edge and right-clicking again pulls it back out. Pressing **Ctrl+Shift+T** switches between the two states from either window, so the shortcut works while you are typing in the browser as well as while the video has focus. Hovering the strip slides the whole player back into view, and it returns to the edge as soon as the pointer leaves the video.

Tucking keeps the window's size and only moves it, so the video never re-encodes, restarts, or loses its place. The strip is 24px wide on a side edge and sits flush with the screen, which makes it reachable without aiming. Coming back out by hand places the player inside the screen edges with a 16px margin, never half off screen.

The edge is chosen when you tuck: whichever of left, right, or bottom the window is nearest to. There is no top edge, because macOS refuses to move a window above the screen.

## Settings

The mod adds one section to its settings dialog in Sine, with four switches.

| Setting | Default | What it does |
| --- | --- | --- |
| Tuck away on right click | on | Right-clicking the player toggles tucked and untucked |
| Toggle with Ctrl+Shift+T | on | The keyboard toggle, from the browser window or the player |
| Peek while hovering the tucked strip | off | Hovering the strip slides the player into view until the pointer leaves the video |
| Auto tuck on PiP switch | off | The player opens already tucked, instead of appearing in its normal place first |

The peek is off by default on purpose. Once it is on, the strip stops being a static sliver and starts responding to the pointer, which some people find distracting while watching something in the corner.

Auto tuck is off by default because it changes where the player starts life. Turn it on and the very first thing you see when a video goes picture-in-picture is the strip at the edge, chosen as the edge nearest where the player would normally have appeared. Firefox restores a player window's last position and size just after it opens, so the mod re-applies the tucked position a few times across the first third of a second to win that race. A single frame at the old spot can still slip through on a slow start, which is the price of doing this from a script rather than inside the browser's own window code.

## Install

Sine installs mods straight from a repository. Paste this into Sine's mod installer:

```text
https://github.com/apoapostolov/Zen-PiP-Tuck-Away
```

Restart Zen afterwards, because script mods load at startup.

One requirement applies to every Sine mod installed from a repository rather than the store: JavaScript must be allowed. Check that `sine.allow-unsafe-js` is `true` in `about:config`, otherwise the mod installs, appears enabled, and does nothing at all. Mods that ship scripts run with full browser privileges, so read the two files in `scripts/` before you trust them. They are short and they only move a window.

## Using it with Zia

Zia tucks picture-in-picture as well, and two mods moving the same window turn every tuck into a tug of war. This mod is meant to replace that part of Zia, so make Zia hand the job over:

- Set `zia.pip.tuck` to `false` in `about:config`. Zia's edge code goes dormant, and this mod hides Zia's tuck button for you, because Zia's CSS keeps that button visible even with its own switch off. Zia's right-click edge picker and the rest of its player styling keep working.
- The mod warns once in the Browser Console if it finds Zia's tuck button in a player while `zia.pip.tuck` is on, or unset, which means Zia's default of on applies.
- Right-clicks inside Zia's own player controls are passed straight to Zia, so turning Zia's tuck back on does not break its picker.
- The two mods share no state: this one marks the window with `pip-tucked` and `pip-peeking`, never writes Zia's preferences, and Zia keeps its own `zia-*` attributes.

## Ctrl+Shift+T is a busy shortcut

Firefox uses Ctrl+Shift+T to reopen the last closed tab. While a picture-in-picture player is open, this mod takes the chord, because that is the point of a toggle. When no player is open the chord is passed straight through and undo-close-tab works as usual.

If you would rather keep undo-close-tab everywhere, turn the shortcut off in the mod settings. The right-click and hover controls keep working.

## Known limits

- It only touches picture-in-picture. Normal windows are none of its business.
- Tucking is skipped while the player is in fullscreen, since there is nothing to hide there.
- The player window keeps its size, so a very large video leaves a taller strip than a small one. The strip is always 24px wide.
- Built and tested against Sine 2.3.4.1c and Zen Twilight 1.24t. Zen's own mod loader uses a different content URL, so the player half will not load there without a path change.

## How it is put together

Two scripts, no stylesheet.

| File | Runs in | Job |
| --- | --- | --- |
| `scripts/pip-tuck-away.uc.js` | the browser window | Watches for player windows, loads the player half into each one, owns the keyboard toggle |
| `scripts/pip-player.uc.js` | the picture-in-picture player | Right-click, hover peek, the move maths, and the exposed toggle API |

Sine declares only the first script, so it loads exactly once into `browser.xhtml`. The second is loaded on demand through `Services.scriptloader.loadSubScript`, using the profile's `content sine ../sine-mods/` manifest entry, which is why the mod's files are reachable at `chrome://sine/content/pip-tuck-away/`.

## Credits

The screen-edge geometry and the load-into-the-player technique are adapted from [Zia](https://github.com/z1n-k/zia) by z1n-k, which is MIT licensed. Zia bundles this idea inside a much larger reskin; this mod exists to have the tuck on its own, with its own controls. Details in [CREDITS.md](CREDITS.md).

MIT licensed. See [LICENSE](LICENSE).
