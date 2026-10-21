# Changelog

## 0.1.0

First release. Everything below landed before the first tagged version, so it
all belongs to this one.

- Right-clicking the picture-in-picture player tucks it into the nearest screen edge, and right-clicking again brings it back.
- `Ctrl+Alt+T` toggles tucked and untucked. The chord is installed on every Zen chrome window, including the player, and is left alone while no player is open.
- Optional global hotkey: `tools/pip-hotkey.pyw` registers Ctrl+Alt+T with Windows so the chord also works while another application has focus, and the mod reads its signal file. It stands aside while Zen has focus, so the in-browser path stays instant. Off by default, started by the user, never by the mod.
- Optional hover peek: hovering the tucked strip slides the player fully into view until the pointer leaves the video. Off by default.
- The hover peek is sticky: the reveal is kept by a screen-space band around the player and by the document's own hover state, never by pointer idleness, so a still pointer and a window sliding under it cannot collapse it. Departures wait out a grace period, movement during the reveal is ignored, dragging the strip out releases the tuck, and fullscreen never reveals.
- Auto tuck on PiP switch: a new player opens already tucked, attaching before the player document finishes loading and re-applying the tucked position over the first 320ms so the browser's own position restore cannot undo it. Off by default.
- Integrate PiP in the player widget: the automatic player from a tab switch is not created while Zen has focus, so the video stays in Zen's sidebar media card. The window appears when Zen loses focus and closes again when it comes back. Requests you make yourself are never intercepted. Off by default.
- Zia handover. This mod writes nothing itself, but hides Zia's tuck button while `zia.pip.tuck` is false, warns once when that button is present and Zia's tuck is on or unset, and leaves right-clicks inside Zia's controls to Zia.
- Settings section with six switches, grouped under Controls and Opening the player.
- The player keeps its size while tucking and returns with a 16px margin inside the screen.
