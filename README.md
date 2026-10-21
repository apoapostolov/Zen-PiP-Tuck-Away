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
| Tucked PiP Frosted Glass | on | The strip a tucked player leaves is frosted, so it reads as a handle. Off, it is plain video |
| Toggle with Ctrl+Alt+T | on | The keyboard toggle, from any Zen window |
| Peek while hovering the tucked strip | off | Hovering the strip slides the player out until the pointer leaves the video |
| PiP uses the widget | on | In front, the video plays in the media widget and no player is opened. In the background, the standard picture-in-picture is used |
| Pop the player out when leaving Zen | off | Leaving Zen asks the tab in front for a player, which the platform does not do on its own |
| Auto tuck on PiP switch | off | A new player opens already tucked instead of appearing in its normal place first |

## The video in the media widget

Zen's media card is a row in the sidebar with a thumbnail, the name, the playtime and the buttons. With **PiP uses the widget** on, a video in another tab is shown in that widget, and no player window is opened at all.

The widget shows the video, not a player. A content actor in the page hands the sidebar the video's own frames, which are drawn at the widget's width and the video's shape, in room made inside the toolbar itself. The video never moves: the page keeps playing it, the page keeps its sound, and nothing is loaded twice. A click on the picture plays or pauses, and the two small buttons that appear on hover do the same and open a real player if you would rather have one.

The panel is pixels in the sidebar, not a window. Nothing in this mod moves a player window any more: the place a player remembers, and whether it was tucked and into which edge, are its own and are never written or restored by the widget. The panel follows the sidebar's own controls instead, at the widget's width and the video's shape, in room made inside the toolbar, and it rides with the card when the card expands on hover.

That is the point of doing it this way. Picture-in-picture is never in use while the browser is in front, so it keeps its own remembered size, its own place and its own tucked edge, and it is exactly what appears the moment you leave the browser. Nothing about it is borrowed, moved or resized by this mod.

### One rule, and every case comes out of it

**The widget shows the video of the tab you just left, as long as that tab has a video at all.** Playing or paused makes no difference, which is where this parts company with the browser's own behaviour: the browser only moves a video into picture-in-picture while it is playing, and a paused video is still a video the sidebar can show.

| What you do | What the widget does |
| --- | --- |
| Play a video, then open another tab | Shows the video. No player window is opened |
| Pause the video, then open another tab | Shows it just the same |
| Move between tabs that have no video | Keeps what it is showing. It does not empty |
| Go back to the video's own tab | Lets go: the video is in the page again |
| Go to another application | Lets go. A playing video becomes the standard player window, a paused one is left alone |
| Come back to the browser | Folds that player away and shows the video again, unless you came back to the video's own tab |
| Close the video's tab | The panel goes with it |

Nothing is drawn until a real frame has arrived. Until then the panel is not in the layout at all, so there is no black box standing in for a video and no room taken from the sidebar. If no picture comes within a couple of seconds, the request goes to the platform and a player window opens instead.

Two honest limits:

- **Protected video copies as black.** A frame copy of an encrypted stream cannot be read, so when a page reports a media key system the widget steps aside and a normal player window opens instead, at its own remembered place and in its own tucked state, untouched. A tab that turns out to be protected while another tab is already in the widget is left alone rather than blackening the panel. YouTube, Twitch and most sites are fine; a DRM service is not.
- **The picture costs a little.** Frames travel as they are, downscaled to 480px on the long edge as they are drawn, so the rate is the video's own rate. On a build without a frame stream the mod falls back to copying pixels, which manages about twenty frames a second; a paused video sends one frame and then stays quiet either way.

## Going back to the tab

Selecting the tab a player came from puts the video back in the page and takes the player away. Firefox does that itself, but only for the players it registered as caught by a tab switch, and that registration depends on the tab's docshell still being asleep when the player opened. Anything that wakes it first loses the behaviour silently, and the player simply stays where it is. So the mod keeps its own note of which tabs it saw a player taken from, and closes that player when the tab comes forward, either in the tab strip or by returning to Zen with that tab in front. A player you asked for by hand is left alone, since it was not the tab walking away that opened it.

## Leaving Zen

Zen's own auto-toggle only fires for a tab that became hidden, so leaving Zen with the video's own tab in front sends no request at all. With **Pop the player out when leaving Zen** on, the mod asks that tab for a player itself and remembers the window it opened. Coming back to the video's own tab folds it away again; a player you asked for yourself is never touched.

## Where the player goes

The player remembers the place you last put it, including when it was closed while tucked, so the next video opens where the last one lived rather than in a corner. A place the mod itself imposed, from a rescue or a platform restore, is never written down as yours.

The strip is frosted by default, so it reads as a handle rather than a chopped-up sliver. **Tucked PiP Frosted Glass** turns that off, and the strip is then plain video.

A tucked strip stays 24px on screen by default, or 48 or 72 with the wider settings. Pulling it free puts it 16px inside the screen edge it came from.

## Known limits

- The video in the widget is a copy of the picture, not the player, so it has no controls of its own beyond play and pause, and it cannot show protected video.
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
| `scripts/pip-tuck-away.uc.js` | any browser window | Watches for player windows, loads the player half into each one, owns the chord on every window, and shows a video in the media widget |
| `scripts/pip-player.uc.js` | the picture-in-picture player | The move maths, the tuck button, the direction map, the hover peek, the memory, and the toggle API |
| `styles/player.css` | the picture-in-picture player | The strip, the picker, the button, the frosted tucked strip and the bare reveal |
| `chrome.css` | the browser window | The panel the widget shows a video in |

The player page carries a Content-Security-Policy that blocks inline styles, so the sheet is loaded as a real file. State lives in attributes on the root element.

`pip-tuck-away.trace` writes one line per player request to `pip-tuck-away-trace.log` in your profile, which is how a video that seems to be nowhere gets diagnosed. Set it to false to stop it.

## Tests

Three headless suites run against the shipped files, with no browser:

```
node tests/browser.test.mjs scripts/pip-tuck-away.uc.js    # the browser window half
node tests/player.test.mjs scripts/pip-player.uc.js        # the player half
node tests/child.test.mjs scripts/pip-mirror-child.sys.mjs # the page half of the mirror
```

## Credits

The idea of tucking a player into a screen edge comes from [Zia](https://github.com/z1n-k/zia) by z1n-k, MIT licensed. No source code is taken from it; see `CREDITS.md` for what the idea owes and what is new here.
