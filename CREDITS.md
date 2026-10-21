# Credits

## Zia

The idea of tucking a picture-in-picture player into a screen edge comes from [Zia](https://github.com/z1n-k/zia) by z1n-k, MIT licensed. Zia ships that as one feature inside a full browser reskin.

What this mod takes from it is the shape of the idea, not its code:

- A player that keeps playing while most of its window is off screen, leaving a strip of video on the edge.
- The strip measured from the screen's working area, so a taskbar or a dock does not sit in front of it.
- A frosted strip with a chevron pointing back out, so the sliver reads as a handle rather than a cropped video.
- Loading a script into the player window from the browser window, which is the only way to reach that page.

Everything in this repository is written here: the geometry and its clamps, the strip and its overlay, the button in the control bar, the direction map, the keyboard chord, the hover peek, drag tucking, the position memory, the media widget dock, and the request made when leaving Zen. The files carry no Zia source, and the mod works with Zia uninstalled, which is how it is tested.

If Zia is installed, this mod hides Zia's own tuck button so two controls do not move one window, and switches Zia's tucking preference off at startup for the same reason. That is coexistence, not a dependency.

The MIT licence notice for the idea is reproduced in `LICENSE`.
