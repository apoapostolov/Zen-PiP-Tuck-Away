# Changelog

## 1.0.0 (2026-10-22)

First release. Zen's picture-in-picture player gets somewhere to hide: right-click
it and it slides into the nearest screen edge, leaving a strip of video you can
still see. Ask for it back and it comes out, still playing from where it was,
because nothing ever reloads.

**Tucking it away**

- Right-click anywhere on the player.
- Press the chevron in the player's own controls. It points at the edge it will
  leave by, and a right-click on it picks the edge yourself.
- `Ctrl+Alt+T` works from any Zen window, a second browser window included.
- Drag the player past a screen edge and let go.

**The strip**

- Hover it and the player slides back out while your pointer is on the video,
  then tucks itself again when you leave.
- It keeps 24px on screen, or 48 or 72 if you want more of it.
- Frosted glass by default, so it reads as a handle. Turn that off for plain
  video.
- Drag the strip along its edge to move it, or pull it free to keep the player
  out.
- Press the overlay on the video to tuck, right-click it to pick the direction.

**Where it lives**

- Where you last left the player is where the next video opens, tucked or not.
- Want the same spot every time? Pick a default corner, or a default size from
  Very Small to Very Large.

**In the sidebar**

- Zen's media widget can show the video itself instead of opening a player, so
  picture-in-picture stays yours and is what appears when you leave the browser.
  The widget's picture is a copy, so it runs at a lower frame rate, and
  protected video opens a normal player instead.

**With Zia**

- Zia is not required, and it is not broken. Its tuck button steps aside for the
  one here, and its minimize button is gone since a tucked strip already does
  that job. Switch Zia's own tucking back on and hovering a strip still works.

**Worth knowing**

- `Ctrl+Alt+T` works in Zen's windows. A browser mod cannot take a chord while
  another application has focus.
- The widget cannot show protected video, and its picture is a copy rather than
  the player.
