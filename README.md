<div align="center">

# PiP Tuck Away

Keep a video playing at the screen edge while you use the rest of your desktop.

![Zen Browser](https://img.shields.io/badge/Zen-Browser-f76f53?style=flat-square)
![Sine mod](https://img.shields.io/badge/Sine-mod-6e56cf?style=flat-square)
[![Version: 1.0.1](https://img.shields.io/badge/version-1.0.1-informational?style=flat-square)](https://github.com/apoapostolov/Zen-PiP-Tuck-Away/releases/tag/v1.0.1)
[![Released: 2026-10-22](https://img.shields.io/badge/released-2026--10--22-informational?style=flat-square)](https://github.com/apoapostolov/Zen-PiP-Tuck-Away/releases/tag/v1.0.1)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

</div>

PiP Tuck Away is a Sine mod for Zen Browser. When a floating video covers something
you need, right-click it to slide it into a screen edge. A narrow strip stays
visible, and playback continues. Right-click the strip or press `Ctrl+Alt+T` to
bring the player back.

## Install

You need Zen Browser with Sine installed. Paste this repository address into
Sine's mod installer:

```text
https://github.com/apoapostolov/Zen-PiP-Tuck-Away
```

Restart Zen, then open a video in picture-in-picture to try it.

## Move the player out of the way

Right-click the player or press `Ctrl+Alt+T` to tuck it away and bring it back.
The shortcut works while a Zen window or the player has focus.

You can also use the arrow button in the player's controls. Right-click that
button to choose an edge. To tuck by dragging, move the player partly past a
screen edge, then move the pointer off it. Pull the tucked strip back onto the
screen to keep the player out.

For a quick look, enable **Peek while hovering the tucked strip** in the mod's
settings. Hover to reveal the video; move the pointer away to tuck it again.
This is off by default.

## Choose how much stays on screen

The strip is 24px wide by default. **Tuck width** offers 48px and 72px options if
you want a larger target. Turn off **Tucked PiP Frosted Glass** to see the video
clearly in the strip.

The player remembers where you leave it. Keep **Default PiP size** and
**Default PiP location** on **Remember Last**, or choose a fixed size and location.
Choosing a location makes the player open tucked at that spot. When YouTube
goes to the next video, the player keeps that place instead of jumping to the
bottom right.

See the [settings guide](docs/settings.md) for all options and defaults.

## Watch while browsing other tabs

The mod can show a video in Zen's sidebar media controls while you browse another
tab. Click the preview to play or pause, or use its pop-out button for a floating
player. Returning to the video's tab removes the preview. Switching to another
application opens a floating player if the previewed video is playing.

This feature is experimental and enabled by default. The preview defaults to
30 fps; choose 15 or 60 fps in settings. It cannot show protected video;
those videos open in the regular
picture-in-picture player. Turn off **Integrate in Sidebar Media Controls** if
you prefer a floating player while browsing.

To also open a floating player when you leave Zen with the video's own tab
selected, enable **Pop the player out when leaving Zen**. This is off by default.

## Using Zia

Zia is optional. If it is installed, PiP Tuck Away replaces its tuck button,
disables Zia's own tucking, and removes Zia's minimize button from the player.

## Help and release history

If the controls don't appear after installation, restart Zen. The `Ctrl+Alt+T`
shortcut only works in Zen windows, so it won't respond while another application
has focus.

For a bug report, include your Zen and Sine versions, any other PiP mods, and the
steps that reproduce the problem. See [contributing](CONTRIBUTING.md) for tests
and diagnostic logs.

[Changelog](CHANGELOG.md) · [1.0.1 release notes](https://github.com/apoapostolov/Zen-PiP-Tuck-Away/releases/tag/v1.0.1)

## Credits

Inspired by [Zia](https://github.com/z1n-k/zia) by z1n-k. See [credits](CREDITS.md)
for attribution. Released under the [MIT license](LICENSE).
