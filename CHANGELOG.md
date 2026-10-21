# Changelog

## 0.1.0

First release. Everything below landed before the first tagged version, so it
all belongs to this one.

- Right-clicking the picture-in-picture player tucks it into the nearest screen edge, and right-clicking again brings it back.
- `Ctrl+Alt+T` toggles tucked and untucked. The chord is installed on every Zen chrome window, including the player, and is left alone while no player is open, so the browser's own reopen-closed-tab keeps working when there is nothing to tuck.
- Tuck Control Overlay, on by default: a band of the video, 20% of the width and 90% of the height on the side it will tuck into, with an arrow and the words Tuck Away. A press tucks, a right-click opens a small direction map, and the choice is saved. It works with or without Zia, and sits below Firefox's own controls so they keep their clicks.
- Tuck Direction, a dropdown: Smart, Right, Top, Left or Bottom. Smart measures the player's centre against all four edges. The top edge is now a supported direction alongside left, right and bottom.
- Optional hover peek: hovering the tucked strip slides the player fully into view until the pointer leaves the video. Off by default.
- The hover peek no longer strobes when the pointer is parked on the screen edge. That band is the window's resize border and can stop reporting hover while the pointer has not moved, so a pointer within 12px of the tucked edge counts as present, and the tucked state is watched rather than waiting for an enter event. A reveal also waits a quarter second after folding away before it can come back.
- A hover reveal is bare and unfrosted: Firefox's control bar, its buttons and the dark gradient along the bottom are suppressed, the cursor stays visible, and the tucked frost is lifted on the video element itself so a peek is plain video. A left press anywhere on the revealed player hands the controls over for a couple of seconds; moving the pointer never does. A retract or a right-click ends the bare state too.
- The hover peek is sticky: the reveal is kept by a screen-space band around the player and by the document's own hover state, never by pointer idleness, so a still pointer and a window sliding under it cannot collapse it. Departures wait out a grace period, movement during the reveal is ignored, dragging the strip out releases the tuck, and fullscreen never reveals.
- Auto tuck on PiP switch: a new player opens already tucked, attaching before the player document finishes loading and re-applying the tucked position over the first 320ms so the browser's own position restore cannot undo it. Off by default.
- Integrate PiP in the player widget: the automatic player from a tab switch is not created while Zen has focus, so the video stays in Zen's sidebar media card. The window appears when Zen loses focus and closes again when it comes back. Requests you make yourself are never intercepted. Off by default.
- Zia handover, softly. With `zia.pip.tuck` off, Zia hides its tuck button; this mod shows it again and routes its clicks, so the button works as a toggle with this mod's geometry. Zia's spot picker still opens on right-click, and a chosen spot is folded onto the nearest side this mod parks against. Nothing is hidden, and no warning is printed.
- The chord is `Ctrl+Alt+T`, and nothing listens outside the browser. It moved off `Ctrl+Shift+T`, which is the browser's own reopen-closed-tab and was never this mod's to take, and it is not claimed unless a player window exists. An AltGr press is ignored, since most keyboard layouts report AltGr as ctrl+alt.
- Settings section with six switches and a direction dropdown, under one header.
- The player keeps its size while tucking and returns with a 16px margin inside the screen.
