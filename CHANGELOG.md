# Changelog

## 0.1.0

First release. Everything below landed before the first tagged version, so it
all belongs to this one.

- Right-clicking the picture-in-picture player tucks it into the nearest screen edge, and right-clicking again brings it back.
- `Ctrl+Alt+T` toggles tucked and untucked. The chord is installed on every Zen chrome window, including the player, and is left alone while no player is open.
- Optional hover peek: hovering the tucked strip slides the player fully into view until the pointer leaves the video. Off by default.
- The hover peek is sticky: the reveal is kept by a screen-space band around the player and by the document's own hover state, never by pointer idleness, so a still pointer and a window sliding under it cannot collapse it. Departures wait out a grace period, movement during the reveal is ignored, dragging the strip out releases the tuck, and fullscreen never reveals.
- Auto tuck on PiP switch: a new player opens already tucked, attaching before the player document finishes loading and re-applying the tucked position over the first 320ms so the browser's own position restore cannot undo it. Off by default.
- Integrate PiP in the player widget: the automatic player from a tab switch is not created while Zen has focus, so the video stays in Zen's sidebar media card. The window appears when Zen loses focus and closes again when it comes back. Requests you make yourself are never intercepted. Off by default.
- Zia handover, softly. With `zia.pip.tuck` off, Zia hides its tuck button; this mod shows it again and routes its clicks, so the button works as a toggle with this mod's geometry. Zia's spot picker still opens on right-click, and a chosen spot is folded onto the nearest side this mod parks against. Nothing is hidden, and no warning is printed.
- Settings section with five switches under one header.
- The player keeps its size while tucking and returns with a 16px margin inside the screen.
