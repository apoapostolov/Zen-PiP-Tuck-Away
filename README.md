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
| Toggle with Ctrl+Alt+T | on | The keyboard toggle, from any Zen window |
| Same chord outside Zen | off | Uses the bundled helper, which registers the chord with Windows |
| Peek while hovering the tucked strip | off | Hovering the strip slides the player into view until the pointer leaves the video |
| Auto tuck on PiP switch | off | The player opens already tucked, instead of appearing in its normal place first |
| Integrate PiP in the player widget | off | Switching tabs keeps the video in Zen's sidebar card; the window appears only when you leave Zen |

The peek is off by default on purpose. Once it is on, the strip stops being a static sliver and starts responding to the pointer, which some people find distracting while watching something in the corner.

The reveal is sticky by design. It stays up while the pointer is anywhere in a band around the player, including the area the player slides into, and a departure is only believed after a fifth of a second, so grazing an edge or crossing a gap does not collapse it. A pointer resting still on the video keeps it open without limit, which is the case a naive hover check gets wrong: the window moves underneath a pointer that has not moved at all, and the document can stop reporting hover state mid-slide. The mod judges that from the pointer's last screen position and the document's own hover state together, never from whether the pointer has moved recently. Dragging the strip out by hand releases the tuck instead of fighting over the position, and fullscreen is left alone entirely.

Auto tuck is off by default because it changes where the player starts life. Turn it on and the very first thing you see when a video goes picture-in-picture is the strip at the edge, chosen as the edge nearest where the player would normally have appeared. Firefox restores a player window's last position and size just after it opens, so the mod re-applies the tucked position a few times across the first third of a second to win that race. A single frame at the old spot can still slip through on a slow start, which is the price of doing this from a script rather than inside the browser's own window code.

## Player widget integration

Zen already has a media card in the sidebar. It shows whatever is playing, with play, seek, mute and its own PiP button, and it hides itself the moment that video is in a PiP window. Firefox also opens a PiP window by itself when a playing tab is hidden by a tab switch, which is what the Auto-PiP setting does. Together those mean switching tabs inside Zen replaces the card with a floating window, which is backwards.

With **Integrate PiP in the player widget** on, the automatic window from a tab switch is not created while Zen has focus. The video keeps playing in its tab and the sidebar card stays put with its controls. Switch away from Zen and the player pops out then, because that is when a floating window is worth having. Come back and the window closes, so the card takes over again.

Two rules keep it predictable. A request you make yourself, from the card's PiP button or the video's own toggle, is never intercepted, so asking for a window always gets you one. And interception only happens while Zen has focus, so a player requested from a background window still opens normally.

The mechanism is a wrapper around `PictureInPicture.handlePictureInPictureRequest`, the single place Firefox creates a player from. It tells the automatic path apart by checking whether the requesting browser's docshell is inactive, which is Mozilla's own marker: a docshell is only inactive when the request came from the auto toggle for a hidden tab.

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

## The keyboard chord

Ctrl+Alt+T toggles the player. The listener is installed on every chrome window the browser owns, not just the main one, so the chord works from a second browser window and from the player itself, which is the window that usually has focus while you are watching something. The player is found through the window mediator rather than through the window that saw the key, so there is one code path whether the chord lands in the browser or in the player.

The chord only acts while a player window is open. With nothing playing it is passed through untouched, so Ctrl+Alt+T stays available for whatever else wants it.

### Making it work outside Zen

Windows delivers a chord to another application only if a process registered it with `RegisterHotKey`. Firefox exposes no hotkey API to its own chrome scripts, and the browser can never receive keys while another application holds focus, so this part cannot live in the mod.

`tools/pip-hotkey.pyw` is that registration. It is a small helper that registers Ctrl+Alt+T, and on each press appends a sequence number to `%LOCALAPPDATA%\pip-tuck-away\toggle.json`. The mod polls that file while a player exists and runs the same toggle. Nothing else changes: with the helper absent, the chord simply works inside Zen only.

```powershell
powershell -NoProfile -File tools\install-autostart.ps1
```

That writes a tiny `.vbs` into your Startup folder, which starts the helper through `pythonw.exe` so no console window ever appears, and starts it now. Remove it with `-Remove`, which also asks the helper to exit.

Requirements and behaviour worth knowing:

- Python 3 must be installed, because the helper is the registration host. Nothing else is downloaded.
- If another application already owns Ctrl+Alt+T, registration fails, the helper writes the Windows error to `status.json`, and the mod keeps working inside Zen only. Nothing breaks quietly without a trace.
- When Zen already has focus the helper stands aside and lets the browser handle the chord, so the normal case has no delay. The file round trip only happens when some other application is in front, which is the case the helper exists for.
- The mod never launches the helper. What starts on your machine stays your decision.
- `stop` in the state folder makes the helper exit; it also exits when the registration is lost.

## Known limits

- It only touches picture-in-picture. Normal windows are none of its business.
- Tucking is skipped while the player is in fullscreen, since there is nothing to hide there.
- The player window keeps its size, so a very large video leaves a taller strip than a small one. The strip is always 24px wide.
- Built and tested against Sine 2.3.4.1c and Zen Twilight 1.24t. Zen's own mod loader uses a different content URL, so the player half will not load there without a path change.

## How it is put together

Two scripts, no stylesheet.

| File | Runs in | Job |
| --- | --- | --- |
| `scripts/pip-tuck-away.uc.js` | any browser window | Watches for player windows, loads the player half into each one, owns the keyboard chord on every window, keeps playback inline while Zen has focus |
| `scripts/pip-player.uc.js` | the picture-in-picture player | Right-click, hover peek, the move maths, and the exposed toggle API |
| `tools/pip-hotkey.pyw` | a hidden Windows process | Registers Ctrl+Alt+T with the OS and writes the toggle signal the mod polls |

Sine declares only the first script, so it loads exactly once into `browser.xhtml`. The second is loaded on demand through `Services.scriptloader.loadSubScript`, using the profile's `content sine ../sine-mods/` manifest entry, which is why the mod's files are reachable at `chrome://sine/content/pip-tuck-away/`.

## Credits

The screen-edge geometry and the load-into-the-player technique are adapted from [Zia](https://github.com/z1n-k/zia) by z1n-k, which is MIT licensed. Zia bundles this idea inside a much larger reskin; this mod exists to have the tuck on its own, with its own controls. Details in [CREDITS.md](CREDITS.md).

MIT licensed. See [LICENSE](LICENSE).
