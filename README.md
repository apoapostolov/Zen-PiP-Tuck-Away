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
| Tuck when dragged past the edge | on | Drag the player so part of it is past a screen edge, then move the pointer off it to tuck that way |
| Toggle with Ctrl+Shift+T | on | The keyboard toggle, from any Zen window |
| Peek while hovering the tucked strip | off | Hovering the strip slides the player into view until the pointer leaves the video |
| Auto tuck on PiP switch | off | The player opens already tucked, instead of appearing in its normal place first |
| Integrate PiP in the player widget | off | Switching tabs keeps the video in Zen's sidebar card; the window appears only when you leave Zen |

The peek is off by default on purpose. Once it is on, the strip stops being a static sliver and starts responding to the pointer, which some people find distracting while watching something in the corner.

The reveal is sticky by design. It stays up while the pointer is anywhere in a band around the player, including the area the player slides into, and a departure is only believed after a fifth of a second, so grazing an edge or crossing a gap does not collapse it. A pointer resting still on the video keeps it open without limit, which is the case a naive hover check gets wrong: the window moves underneath a pointer that has not moved at all, and the document can stop reporting hover state mid-slide. The mod judges that from the pointer's last screen position and the document's own hover state together, never from whether the pointer has moved recently. Dragging the strip out by hand releases the tuck instead of fighting over the position, and fullscreen is left alone entirely. A reveal that comes from the pointer resting on the strip shows the video and nothing else. Firefox's controls and the dark gradient it draws along the bottom stay away, and the pointer stays visible, so a peek reads as a look rather than a set of buttons you did not ask for. The peek is a look at the video and nothing else. The frost that belongs to a tucked player is cleared the moment the window comes out, on the element itself, so the video reads plain however the state attributes land. Firefox's controls stay away, and they come back on a left press anywhere on the revealed player, and not before: moving the pointer over it, however far, changes nothing, so a peek never turns into a control panel because the mouse drifted. The press hands the controls over for about two and a half seconds, because Firefox only shows them on a pointer entering the window and the peek has already used that entry. Right-clicking or letting the strip fold away ends the bare look as well. The last few pixels of the screen get their own rule: that band belongs to the window's resize border, and a window sliding under a pointer that has not moved can stop reporting hover, so a pointer within 12px of the tucked edge counts as still there. Without that, parking the cursor on the screen edge made the reveal strobe. A reveal also cannot come back for a quarter second after it folds away, so a genuine departure never snaps it open again.

Auto tuck is off by default because it changes where the player starts life. Turn it on and the very first thing you see when a video goes picture-in-picture is the strip at the edge, chosen as the edge nearest where the player would normally have appeared. Firefox restores a player window's last position and size just after it opens, so the mod re-applies the tucked position a few times across the first third of a second to win that race. A single frame at the old spot can still slip through on a slow start, which is the price of doing this from a script rather than inside the browser's own window code.

## What is left on screen

A tucked player is mostly off screen, so what remains is a 24px strip of video. It is frosted: the video is blurred and dimmed while tucked, with the same trick Firefox uses for its see-through mode, and the blur clears as the player slides back out. Firefox's own controls hide themselves while the player is tucked, because they belong to the part nobody can see.

Across that strip sits a small badge with a chevron pointing back out, on a faint dark wash that darkens under the pointer. A press on it brings the player back, and a right press still rolls it to another edge. The strip keeps dragging as a window handle, so pulling it out by hand releases the tuck the way it always did.

## Where the player opens

The player opens where you last left it. Firefox saves a window's position when it closes, which is no help here: fold a tucked player away and the position it saves is the tucked one, mostly off screen, so the next player opens somewhere nobody put it. This mod keeps its own note instead, written when the player closes, and uses the place the player came from whenever it closes while tucked. A remembered place is pulled 16px inside the screen before it is used, so a position noted on a different display still lands somewhere you can grab.

## Clicks and double clicks

A single click on a tucked strip brings the player out, even with the hover-reveal setting off, because a person asking for the player is not an accident of geometry. A click on the player once it is out shows the controls, and they stay for as long as the pointer does instead of disappearing on a timer of their own.

A double click still means fullscreen, which is why no single-click action runs straight away: it waits a quarter of a second, and a second click cancels it. The player itself only goes fullscreen when the double click's target is the control layer, so the tucked strip's chevron badge draws without taking any press, and the control layer stays a hit target while tucked instead of being switched off. Anything painted over the strip that accepted the press used to eat that gesture.

## Pulling a tucked player out

Dragging a tucked player into the screen frees it: it goes free exactly where it was let go, and it stays there. A drag **along** the edge does not free it, it re-anchors the strip where you dropped it, because sliding a strip up or down its own edge is not a request to untuck. A nudge of a few pixels is ignored for the same reason, and the release is decided by how far the player has come back in from its attached position, not by whether the window moved at all.

This works from the strip and from a peek alike. A peeked player is a player whose window is out on the screen, so dragging it away from the edge is the same gesture; before this, a peeked drag was slid straight back under the pointer by the peek's own retract. The pointer usually leaves the player halfway through a drag, and a departure that happens while the player has been pulled out frees it rather than reeling it in.

There is no separate switch for this. A tucked player you dragged somewhere is a player you wanted out, and the settings list is long enough already.

## Tucking by drag

Drag the player so that any part of it is past a screen edge and the mod marks that edge with a thin line, placed on the screen edge itself rather than on the window's off-screen end. Move the pointer off the player and it tucks that way. A drag that ends with the pointer already past the player completes the same way, because the window simply stopped being under the pointer. The gesture reads the window's position rather than the drag itself, since a window drag belongs to the window manager and reports nothing to the page.

The mark clears the moment the player is back fully on screen, so a window that is merely parked near an edge does nothing. Only the deepest overhang counts when two edges are involved, and the switch turns the whole gesture off.

## The tuck strip

The player carries a strip that tucks it. It is not a small pill beside the controls: it is a band of the video itself, 20% of the width and 90% of the height along the side it will tuck into, and 90% by 20% across the top or the bottom. Inside it are an arrow pointing at that edge and the words Tuck Away, at 45% opacity until you hover, then solid, on a faint dark wash.

Press it and the player parks against that edge. Right-click it and a small map of the directions opens, the same idea as Zia's picker: Smart in the middle, with Right, Top, Left and Bottom around it, the current choice lit. Pick one and the strip moves to that side, and the setting is saved, so it holds for the next video too.

**Smart** means the edge the player belongs to. Sides come first, because a side tuck leaves the video as a tall strip rather than a thin bar. A top or bottom tuck is only considered when the player is well clear of both side edges, at least 160px from each, and close to a horizontal edge, within 96px of it. Between those two the top is the default and the bottom has to be nearer by more than 64px to take it. Anything else falls to the nearer side, so a player in a corner tucks into the side of that corner and only one parked near the middle of the top or bottom goes up or down. A player that hangs over a screen edge at all, even slightly, tucks into that edge, because that is where it was put. Distances are measured from the player's own edges, so a wide, short player in a corner reads as a corner rather than as a top or bottom, and a player that opens mostly off screen is pulled back into view before anything else happens.

The strip is a child of Firefox's own `#controls` layer, placed before everything else in it, so the control bar, the close and minimise buttons and Zia's own controls all sit above it and keep their clicks. Where those cover it, they win; the rest of the strip is the tuck target.

With **Tuck Control Overlay** off there is no strip at all, and tucking falls back to right-click, the chord and auto tuck. The strip also steps aside while the player is tucked or in fullscreen, because the strip at the edge is the way back.

A peek is a look at the video, so nothing sits on it: the strip stays away while a reveal is bare, and so does every control. That last part needed a different lever. Zia, installed alongside, forces its controls visible with `:root[zia-dia] #controls:is(:hover, [showing], [keying]) .control-item{opacity:1 !important}`, which outranks any rule this mod can write in a sheet, and the scrim it draws behind them is what reads as the video dimming. So the whole control layer is switched off on the element itself while a peek is bare, `opacity: 0 !important` written straight onto `#controls`, which no sheet outranks and which takes the scrim with it. A left press on the revealed player switches the layer back on and hands the controls over for a couple of seconds. The buttons go inert while the layer is dark, so nothing gets clicked blind, but the layer itself stays a drag surface.

The overlay is on by default and works whether or not Zia is installed. When Zia is there, both its button and this strip do the same thing, since both end up in the same tuck.

## Player widget integration

Zen already has a media card in the sidebar. It shows whatever is playing, with play, seek, mute and its own PiP button, and it hides itself the moment that video is in a PiP window. Firefox also opens a PiP window by itself when a playing tab is hidden by a tab switch, which is what the Auto-PiP setting does. Together those mean switching tabs inside Zen replaces the card with a floating window, which is backwards.

With **Integrate PiP in the player widget** on, the automatic window from a tab switch is not created while Zen has focus. The video keeps playing in its tab and the sidebar card stays put with its controls. Switch away from Zen and the player pops out then, because that is when a floating window is worth having. Come back and the window closes, so the card takes over again.

Watching a video on its own tab and leaving Zen works the same way, even though the browser asks for nothing by itself: it only pips a tab that got hidden, and its own handler deliberately skips the selected tab. The mod asks that tab's launcher for a player when Zen loses focus, which is the same toggle the browser uses, so the window appears without a tab switch. It asks once per departure, never while a player is already open, and never for a muted tab. The catch is scope: it asks the tab you are looking at, so a video playing in some other tab comes out only through the tab-switch path above. The fold is careful about one piece of browser state. Floating a player makes the platform mark the tab as auto-pipped and force its docshell active so the hidden tab keeps running, and both marks are cleared only by the platform's own foreground close. Closing the window a plainer way left the tab flagged, so it never reported itself hidden again and no player was ever requested a second time: the video folded away once and never came back. The mod now closes through that foreground path and restores the docshell, and it keeps the video as a pending request, so leaving Zen a second time brings the player out again without needing another tab switch. Returning to the tab from the player is a case of its own: that path focuses Zen before it closes the window, so the mod's own fold always runs first and used to close the player out from under it. The fold now waits a moment, lets the platform's close land, and only closes a window that is still open, checking afterwards that it really went away and falling back to a plain close when the platform's close finds nothing to close. A player that closed itself that way also drops the pending request, so a video sent back to its page is not floated out again on the next departure. Two rules keep it predictable. A request you make yourself, from the card's PiP button or the video's own toggle, is never intercepted, so asking for a window always gets you one. And interception only happens while Zen has focus, so a player requested from a background window still opens normally.

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

The button stays. Zia hides its tuck button once its own switch is off, and a player missing a control it used to have looks broken, so this mod shows the button again and puts its own tuck behind it. It does that on the element itself, with an inline `!important`, because Zia hides the button through its own style sheet and two injected sheets win or lose by nothing more than their order. The click is taken in the capture phase, before Zia's handler runs, so exactly one thing moves the window:

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

Two scripts, one stylesheet, no helper process.

| File | Runs in | Job |
| --- | --- | --- |
| `scripts/pip-tuck-away.uc.js` | any browser window | Watches for player windows, loads the player half into each one, owns the keyboard chord on every window, keeps playback inline while Zen has focus |
| `scripts/pip-player.uc.js` | the picture-in-picture player | Right-click, hover peek, the move maths, and the exposed toggle API |
| `styles/player.css` | the picture-in-picture player | The strip, the picker, the frosted tucked strip with its chevron, and the bare reveal |

Sine declares only the first script, so it loads exactly once into `browser.xhtml`. The second is loaded on demand through `Services.scriptloader.loadSubScript`, using the profile's `content sine ../sine-mods/` manifest entry, which is why the mod's files are reachable at `chrome://sine/content/pip-tuck-away/`.

The styles are a real file for a reason. The player document is served with `Content-Security-Policy: default-src chrome:`, which blocks inline styles outright, so an injected `<style>` element is dropped without a word and every rule in it is dead. The player half loads the sheet through `window.windowUtils.loadSheetUsingURIString` as an author sheet, which is not subject to the page's rules at all, with a `chrome://` `<link>` as the fallback. State is carried entirely by attributes on the root element, so the script never has to touch a style rule to redraw.

## Credits

The screen-edge geometry and the load-into-the-player technique are adapted from [Zia](https://github.com/z1n-k/zia) by z1n-k, which is MIT licensed. Zia bundles this idea inside a much larger reskin; this mod exists to have the tuck on its own, with its own controls. Details in [CREDITS.md](CREDITS.md).

MIT licensed. See [LICENSE](LICENSE).
