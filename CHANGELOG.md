# Changelog

## 0.2.0

- New setting: Auto tuck on PiP switch. When on, a new player window is tucked before it is shown, so a video goes straight to the strip instead of appearing in its usual place. Off by default.
- The player half now attaches before the player document finishes loading when auto tuck is on, and re-applies the tucked position over the first 320ms so the browser's own position restore cannot undo it.
- Untucking after an auto tuck lands the player on the screen edge it came from, because no reliable "before" position exists that early.

## 0.1.0

First release.

- Right-clicking the picture-in-picture player tucks it into the nearest screen edge, and right-clicking again brings it back.
- `Ctrl+Shift+T` toggles tucked and untucked from the browser window and from the player window. The chord is passed through to undo-close-tab while no player is open.
- Optional hover peek: hovering the tucked strip slides the player fully into view until the pointer leaves the video.
- Settings section with the right-click toggle, the shortcut toggle, and the hover peek switch (off by default).
- The player keeps its size while tucking and returns with a 16px margin inside the screen.
