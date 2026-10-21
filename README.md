<div align="center">

# PiP Tuck Away

A Sine mod for Zen Browser that tucks the picture-in-picture player into a screen edge, then brings it back when you want it.

![Zen Browser](https://img.shields.io/badge/Zen-Browser-f76f53?style=flat-square)
![Sine mod](https://img.shields.io/badge/Sine-mod-6e56cf?style=flat-square)
![Version](https://img.shields.io/badge/version-1.0.0-informational?style=flat-square)
![Released](https://img.shields.io/badge/released-2026--10--22-informational?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)

</div>

Right-click the player and it slides into the nearest screen edge, leaving a 24px
strip of video you can still see. Click it, hover it, press a chord, or pull it
out, and it comes back. Only the window moves, so the video keeps playing from
where it was.

## Four ways to tuck and untuck

- **Right-click** anywhere on the player.
- **The chevron** in the player's own controls, pointing at the edge it will leave
  by. Right-click it to pick the edge yourself.
- **`Ctrl+Alt+T`** from any Zen window, a second browser window included. AltGr is
  left alone, and the chord passes through untouched when no player is open.
- **Drag** the player so part of it hangs off a screen edge, then move the pointer
  off it.

Hovering the strip slides the whole player back into view when peek is on. Pulling
it into the screen frees it, and carrying it to another edge re-tucks it there.

## Settings

| Tuck away | Default | What it does |
| --- | --- | --- |
| Tuck away on right click | on | Right-clicking the player toggles tucked and untucked |
| Toggle with Ctrl+Alt+T | on | The keyboard toggle, from any Zen window |
| Tuck Direction | Smart | Which edge the strip tucks into: Smart, Right, Top, Left or Bottom. Smart measures the player's centre against all four edges |
| Tuck width | Normal | How much of the player stays on screen: Normal (24px), Wide (48px) or Very wide (72px) |
| Tucked PiP Frosted Glass | on | The strip a tucked player leaves is frosted, so it reads as a handle. Off, it is plain video |
| Peek while hovering the tucked strip | off | Hovering the strip slides the player out until the pointer leaves the video |
| Tuck Control Overlay | on | A band of the video, with an arrow and the words Tuck Away, that tucks when pressed |
| Tuck when dragged past the edge | on | Drag the player past a screen edge, then move the pointer off it to tuck that way |
| Auto tuck on PiP switch | off | A new player opens already tucked instead of appearing in its normal place first |

| The player | Default | What it does |
| --- | --- | --- |
| Default PiP size | Remember Last | The size a player opens at: Remember Last, Very Small (200px wide), Small (280), Medium (380), Large (520) or Very Large (680) |
| Default PiP location | Remember Last | Where a player opens, and it opens tucked there: Remember Last, the four corners, Top Middle or Bottom Middle |

| Sidebar media controls | Default | What it does |
| --- | --- | --- |
| Integrate in Sidebar Media Controls (slow framerate, experimental) | on | In front, the video plays in the media widget and no player is opened. In the background, the standard picture-in-picture is used. The widget's picture is a copy, so it plays below the video's own frame rate |
| Pop the player out when leaving Zen | off | Leaving Zen asks the tab in front for a player, which the platform does not do on its own |

## How a player opens

Size and place both start at **Remember Last**, which means the mod leaves them
alone: the platform remembers them, and that is usually what you want.

Pick a size and the window is resized to it as it opens, keeping the shape the
video already has, so nothing is stretched. The width is what the setting names,
200px through 680px, and the height follows the video. A window that would end up
past a screen edge comes back inside it.

Pick a place and the player opens there and tucked, because a place is a place for
the strip to live. Top Left and the other corners tuck into the side edge they are
nearest, Top Middle and Bottom Middle tuck into the flat edge they name. The place
is remembered, so untucking returns to it and it survives a restart. It tucks even
with **Auto tuck on PiP switch** off.

## The video in the sidebar

Zen's media card is a row in the sidebar with a thumbnail, the name, the playtime
and the buttons. With **Integrate in Sidebar Media Controls** on, a video in
another tab is shown in that widget and no player window is opened at all.

The widget shows a copy of the video: the page copies the picture into a small
canvas at the size the sidebar shows it, and the sidebar paints those pixels at the
widget's width and the video's shape, in room made inside the toolbar. A copy is
asked for when the video presents a new frame, so nothing is copied twice. The page
keeps playing the video, keeps its sound, and nothing is loaded twice. A click on
the picture plays or pauses, and the two buttons that appear on hover do the same
plus open a real player if you would rather have one.

The panel is pixels in the sidebar, and nothing here moves a player window, so
the place a player remembers and the edge it was tucked into stay its own. That
is the whole point: picture-in-picture is never in use while the browser is in
front, so it appears with its own size and place the moment you leave.

### One rule, and every case comes out of it

**The widget shows the video of the tab you just left, as long as that tab has a
video at all.** Playing or paused makes no difference, which is where this parts
company with the browser: it only moves a video into picture-in-picture while it
is playing, and a paused video is still a video the sidebar can show.

| What you do | What the widget does |
| --- | --- |
| Play a video, then open another tab | Shows the video. No player window is opened |
| Pause the video, then open another tab | Shows it just the same |
| Move between tabs that have no video | Keeps what it is showing. It does not empty |
| Go back to the video's own tab | Lets go: the video is in the page again |
| Go to another application | Lets go. A playing video becomes the standard player window, a paused one is left alone |
| Come back to the browser | Folds that player away and shows the video again, unless you came back to the video's own tab |
| Close the video's tab | The panel goes with it |

Nothing is drawn until a real frame has arrived, so there is no black box standing
in for a video and no room taken from the sidebar. If no picture comes within a
couple of seconds, the request goes to the platform and a player window opens
instead.

Two honest limits. A frame copy of an encrypted stream cannot be read, so a page
that reports a media key system gets a normal player window at its own remembered
place, untouched, and YouTube, Twitch and most sites are fine while a DRM service
is not. And the copy is the ceiling on speed: Firefox keeps the frame-stream APIs
in workers, the one on the page is a compatibility shim built out of a canvas, and
there is no way to hand the sidebar a frame without reading the pixels back on the
CPU. The mod copies at 320px on the long edge, once per frame the video presents,
and writes what that costs to `trace.log` every two seconds, so a stutter has a
number next to it.

## Going back to the tab

Selecting the tab a player came from puts the video back in the page and takes the
player away. Firefox does that itself, but only for players it registered as caught
by a tab switch, and anything that wakes the tab first loses that silently, leaving
the player on screen. So the mod keeps its own note of which tabs it saw a player
taken from, and closes that player when the tab comes forward, in the tab strip or
by returning to Zen with that tab in front. A player you asked for by hand is left
alone.

## Leaving Zen

Zen's own auto-toggle only fires for a tab that became hidden, so leaving Zen with
the video's own tab in front sends no request at all. With **Pop the player out
when leaving Zen** on, the mod asks that tab for a player itself and remembers the
window it opened. Coming back to the video's own tab folds it away again, and a
player you opened yourself is never touched.

## Where the player goes

The player remembers the place you last put it, including when it was closed while
tucked, so the next video opens where the last one lived rather than in a corner. A
place the mod itself imposed, from a rescue or a platform restore, is never written
down as yours.

A tucked strip stays 24px on screen by default, or 48 or 72 with the wider
settings. Pulling it free puts it 16px inside the screen edge it came from.

## Known limits

- The widget shows a copy of the picture, so it has no controls beyond play and
  pause, and it cannot show protected video.
- A browser mod cannot take a keyboard chord while another application has focus,
  so `Ctrl+Alt+T` works in Zen's windows and nowhere else.
- The strip is a share of the player: 20% of the width and 90% of the height along
  a side, or 90% by 20% across the top or bottom.
- Hover peeking is judged by the pointer's position and the document's own hover
  state, never by pointer idleness, so a still pointer on the video holds it open.
  On a multi-monitor setup the first test needs a real video and a real move.

## Install

Paste this address into Sine's mod installer:

```
https://github.com/apoapostolov/Zen-PiP-Tuck-Away
```

Then restart Zen. Chrome scripts load at startup, so nothing appears before a
restart.

## Using it with Zia

This mod needs nothing else installed. If [Zia](https://github.com/z1n-k/zia) is
present, its own tuck button gives way to the one here, since two buttons would
move the same window, and its tucking preference is switched off at startup for the
same reason. Zia's minimize button is gone from the player too, because a tucked
strip already does that job.

Switch Zia's tucking back on and a peek still works: this mod holds it off while a
peek is open and hands it back the moment the peek ends, since Zia reads a peek as
a drag towards an edge and would tuck the player straight back.

## Files

| File | Runs in | Job |
| --- | --- | --- |
| `scripts/pip-tuck-away.uc.js` | any browser window | Watches for player windows, loads the player half into each one, owns the chord on every window, and shows a video in the media widget |
| `scripts/pip-player.uc.js` | the picture-in-picture player | The move maths, the tuck button, the direction map, the hover peek, the memory, and the toggle API |
| `styles/player.css` | the picture-in-picture player | The strip, the picker, the button, the frosted tucked strip and the bare reveal |
| `chrome.css` | the browser window | The panel the widget shows a video in |

The player page carries a Content-Security-Policy that blocks inline styles, so the
sheet is a real file and the state lives in attributes on the root element.
`pip-tuck-away.trace` writes a line to `trace.log` in the mod's own folder, which
is the one place this mod is certain it can write to. Set it to false to stop it.

## Tests

Three headless suites run against the shipped files, with no browser:

```
node tests/browser.test.mjs scripts/pip-tuck-away.uc.js    # the browser window half
node tests/player.test.mjs scripts/pip-player.uc.js        # the player half
node tests/child.test.mjs scripts/pip-mirror-child.sys.mjs # the page half of the mirror
```

## Credits

The idea of tucking a player into a screen edge comes from [Zia](https://github.com/z1n-k/zia) by z1n-k, MIT licensed. No source code is taken from it; see `CREDITS.md` for what the idea owes and what is new here.
