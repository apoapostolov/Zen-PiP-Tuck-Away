# Changelog

## Unreleased

- Double-click the video in the sidebar media controls to go to the tab it plays
  in. A single click still plays or pauses, and now waits a moment to see whether
  a second click is coming.

## 1.0.1 (2026-10-22)

- Default sidebar previews to 30 fps, with 15 and 60 fps choices. Limit copying
  to one frame awaiting display and keep previews moving in background tabs.
- Measure sidebar layout when it changes, with frame tracking during card
  transitions. Fall back to a floating player when the sidebar stays unavailable.
- Make diagnostic logs opt-in and queue writes across browser windows, with a
  system-module queue that keeps running after a window closes.
- Keep sidebar previews and keyboard controls working across multiple Zen
  windows, including when one window closes.
- Clean up timers, tab listeners, and native resize hooks when the mod unloads,
  so it can be enabled again without restarting Zen.
- Keep preview fallback requests tied to the correct tab, and stop preview
  callbacks after a failed copy or when the video leaves the page.
- Apply sidebar and tracing settings immediately. Sidebar playback buttons now
  support keyboard focus and activation.
- Ignore malformed player size, location, and strip-width preferences.
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
