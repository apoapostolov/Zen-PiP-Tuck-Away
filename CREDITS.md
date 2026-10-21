# Credits

## Zia

The tuck mechanic is adapted from [Zia](https://github.com/z1n-k/zia) by z1n-k, MIT licensed. Zia ships picture-in-picture tucking as one feature inside a full browser reskin. What came across into this mod:

- Loading a script into the picture-in-picture player window: watch `domwindowopened`, wait for `load`, then `Services.scriptloader.loadSubScript` against the player window.
- The screen-edge position maths: a 24px sliver left on screen, `screen.availLeft` / `availTop` / `availWidth` / `availHeight` as the working box, and the clamp-then-offset approach for each side.
- The 16px margin used when a window is placed back inside the screen.
- The absence of a top edge. Zia skips top tucks because macOS will not move a window above the top of the screen.
- The frame-by-frame move loop with eased rounding, so the window glides instead of jumping.

What is new here: right-click as a trigger, the Ctrl+Shift+T toggle in both windows, the hover peek, the setting surface, and the decision to tuck to the nearest edge rather than offering a spot picker.

Zia's license text is reproduced in this repository's LICENSE file as required.
