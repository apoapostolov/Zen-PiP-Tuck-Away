<div align="center">

# PiP Tuck Away

A Sine mod for Zen Browser that tucks the picture-in-picture player into a screen edge, then brings it back when you want it.

![Zen Browser](https://img.shields.io/badge/Zen-Browser-f76f53?style=flat-square)
![Sine mod](https://img.shields.io/badge/Sine-mod-6e56cf?style=flat-square)
![Version](https://img.shields.io/badge/version-0.1.0-informational?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)

</div>

Right-click the player and it slides into the nearest screen edge, leaving a thin strip of video you can still see. Click it, hover it, press a chord, or pull it out and it comes back. The only thing that moves is the window, so the video keeps playing from where it was.

## Four ways to tuck and untuck

- **Right-click** anywhere on the player.
- **The button** in the player's own control bar, a chevron pointing at the edge it will leave by.
- **`Ctrl+Alt+T`** from any Zen window, including a second browser window. AltGr is ignored so a keyboard layout keeps its own keys, and the chord passes through untouched when no player is open.
- **Drag** the player so part of it hangs off a screen edge, then move the pointer off it.

Hovering the strip slides the whole player back into view when the peek setting is on. Pulling it into the screen by hand frees it; carrying it to another edge re-tucks it there.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Tuck away on right click | on | Right-clicking the player toggles tucked and untucked |
| Tuck Control Overlay | on | A band of the video, with an arrow and the words Tuck Away, that tucks when pressed |
| Tuck Direction | Smart | Which edge the strip tucks into: Smart, Right, Top, Left or Bottom. Smart measures the player's centre against all four edges |
| Tuck when dragged past the edge | on | Drag the player past a screen edge, then move the pointer off it to tuck that way |
| Tuck width | Normal | How much of the player stays on screen: Normal (24px), Wide (48px) or Very wide (72px) |
| Toggle with Ctrl+Alt+T | on | The keyboard toggle, from any Zen window |
| Peek while hovering the tucked strip | off | Hovering the strip slides the player out until the pointer leaves the video |
| Play the video in the media widget | on | The player is embedded in Zen's media card, in room made inside the widget |
| Pop the player out when leaving Zen | off | Leaving Zen asks the tab in front for a player, which the platform does not do on its own |
| Auto tuck on PiP switch | off | A new player opens already tucked instead of appearing in its normal place first |

## The video in the media widget

Zen's media card is a row in the sidebar with a thumbnail, the name, the playtime and the buttons. With **Play the video in the media widget** on, the player is embedded in the widget: the toolbar is made taller to hold it, and the panel sits in that room, above the card's rows, at the widget's width and the video's own shape.

The room is real. Zen's media toolbar takes its height from `--zen-media-collapsed-height`, so growing that variable is how the panel gets a laid-out slot: the toolbar becomes taller, the tab list above gives the space up, and the card keeps its place at the bottom of the box. Nothing is added to the card's markup, and nothing floats over the sidebar. As the card expands on hover the box grows, its top edge rises, and the panel rises with it.

The panel is a window, and that is the one honest limit: the playing video lives in the player's own browsing context and cannot be moved into a document. The only way to paint video inside the page is a frame mirror, which has no sound of its own and goes black on protected content. A docked window is the real video with the real audio, and nothing is reloaded, so playback never restarts. What the panel does not have is the player's own furniture: its control bar is built for a window and reads as a wall of buttons at panel size, so it is switched off while docked and the picture is the whole of it. A click still pauses and plays.

The panel comes out when the card goes away, when the setting is off, and when you tuck it, and the toolbar's room is given back with it. With more than one playing tab the mod looks for the card whose title matches the video's tab, and otherwise uses the first card on screen.

## Going back to the tab

Selecting the tab a player came from puts the video back in the page and takes the player away. Firefox does that itself, but only for the players it registered as caught by a tab switch, and that registration depends on the tab's docshell still being asleep when the player opened. Anything that wakes it first loses the behaviour silently, and the player simply stays where it is. So the mod keeps its own note of which tabs it saw a player taken from, and closes that player when the tab comes forward, either in the tab strip or by returning to Zen with that tab in front. A player you asked for by hand is left alone, since it was not the tab walking away that opened it.

## Leaving Zen

Zen's own auto-toggle only fires for a tab that became hidden, so leaving Zen with the video's own tab in front sends no request at all. With **Pop the player out when leaving Zen** on, the mod asks that tab for a player itself and remembers the window it opened. Coming back to the video's own tab folds it away again; a player you asked for yourself is never touched.

## Where the player goes

The player remembers the place you last put it, including when it was closed while tucked, so the next video opens where the last one lived rather than in a corner. A place the mod itself imposed, from a rescue or a platform restore, is never written down as yours.

A tucked strip stays 24px on screen by default, or 48 or 72 with the wider settings. Pulling it free puts it 16px inside the screen edge it came from.

## Known limits

- The docked video is a window, so it sits above the sidebar and appears in the taskbar. It is above other applications while Zen is in the background.
- A browser mod cannot take a keyboard chord while another application has focus. The platform has no hotkey API, so `Ctrl+Alt+T` works in Zen's windows and nowhere else.
- The strip is a share of the player: 20% of the width and 90% of the height along a side, or 90% by 20% across the top or bottom.
- Hover peeking is judged by the pointer's position and the document's own hover state, never by pointer idleness, so a still pointer on the video holds it open. On a multi-monitor setup the first test needs a real video and a real move.

## Install

Paste this address into Sine's mod installer:

```
https://github.com/apoapostolov/Zen-PiP-Tuck-Away
```

Then restart Zen. Chrome scripts load at startup, so nothing appears before a restart.

## Using it with Zia

This mod needs nothing else installed. If [Zia](https://github.com/z1n-k/zia) is present, its own tuck button gives way to the one here, since two buttons would move the same window, and its own tucking preference is switched off at startup for the same reason. Nothing is hidden when Zia is absent, and nothing here breaks.

## How it is put together

| File | Runs in | Job |
| --- | --- | --- |
| `scripts/pip-tuck-away.uc.js` | any browser window | Watches for player windows, loads the player half into each one, owns the chord on every window, and docks the player into the media card |
| `scripts/pip-player.uc.js` | the picture-in-picture player | The move maths, the tuck button, the direction map, the hover peek, the memory, and the toggle API |
| `styles/player.css` | the picture-in-picture player | The strip, the picker, the button, the frosted tucked strip and the bare reveal |

The player page carries a Content-Security-Policy that blocks inline styles, so the sheet is loaded as a real file. State lives in attributes on the root element.

`pip-tuck-away.trace` writes one line per player request to `pip-tuck-away-trace.log` in your profile, which is how a video that seems to be nowhere gets diagnosed. Set it to false to stop it.

## Credits

The idea of tucking a player into a screen edge comes from [Zia](https://github.com/z1n-k/zia) by z1n-k, MIT licensed. No source code is taken from it; see `CREDITS.md` for what the idea owes and what is new here.
