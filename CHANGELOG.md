# Changelog

## Unreleased

- When YouTube goes to the next video, the player keeps its place instead of
  jumping to the bottom right.

## 1.0.0 (2026-10-22)

First public release for Zen Browser. Tuck a floating video into a screen edge
when it covers your work, then bring it back without interrupting playback.

- Tuck and restore the player with a right-click, the arrow button, or
  `Ctrl+Alt+T` while a Zen window has focus. Drag past an edge to tuck it there.
- Enable hover peeking to reveal the video temporarily, then tuck it again when
  the pointer leaves. This is off by default.
- Choose how much of the tucked player stays visible, and set a preferred player
  size and opening location. The default is to remember the last size and location.
- Watch a video in Zen's sidebar while browsing other tabs, with play/pause and
  a pop-out button. This experimental preview is enabled by default; it runs at a
  lower frame rate and uses the regular player for protected video.
- Optionally open a floating player when you switch to another application with
  the video's tab selected.

Zia is optional. When installed, its tuck button is replaced, its own tucking is
disabled, and its minimize button is removed from the player.

See the [README](README.md#install) for installation and the
[settings guide](docs/settings.md) for options.
