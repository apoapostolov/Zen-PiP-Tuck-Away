# Settings

[Back to the README](../README.md)

These are the options in PiP Tuck Away's Sine settings.

## Tuck and restore the player

| Setting | Default | Use it to |
| --- | --- | --- |
| Tuck away on right click | On | Right-click the player to tuck or restore it. |
| Toggle with Ctrl+Alt+T | On | Tuck or restore from any Zen window or the player. The shortcut requires Zen to have focus. |
| Tuck Direction | Smart | Let the mod choose an edge based on the player's position, or choose Right, Top, Left, or Bottom. |
| Tuck width | Normal | Leave a 24px strip visible, or choose Wide (48px) or Very wide (72px). |
| Tucked PiP Frosted Glass | On | Give the strip a frosted appearance. Turn it off to see the video clearly in the strip. |
| Peek while hovering the tucked strip | Off | Reveal the video while the pointer is over it, then tuck it again when the pointer leaves. |
| Tuck Control Overlay | On | Show a Tuck Away overlay on the video. Click to tuck; right-click to choose an edge. |
| Tuck when dragged past the edge | On | Tuck by dragging the player partly past a screen edge and moving the pointer off it. |
| Auto tuck on PiP switch | Off | Open a new picture-in-picture player already tucked. |

Right-click the arrow button in the player's controls to choose an edge for a
tuck. You can move the tucked strip along its edge or pull it back onto the
screen to keep the player visible.

## Player size and opening location

Both settings default to **Remember Last**. Leave them there to keep using the
player's remembered size and position, including a position saved while tucked.
A video that swaps inside the open player, such as YouTube going to the next
one, keeps that place too.

**Default PiP size** also offers Very Small (200px wide), Small (280px), Medium
(380px), Large (520px), and Very Large (680px). Each preserves the video's
proportions.

**Default PiP location** also offers the four corners, Top Middle, and Bottom
Middle. Choosing one opens the player tucked at that location, even with
**Auto tuck on PiP switch** off. Corners tuck into the left or right edge;
Top Middle and Bottom Middle tuck into the top and bottom edges.

## Sidebar video and switching applications

**Integrate in Sidebar Media Controls (slow framerate, experimental)** is on by
default. It shows the video from the tab you leave in Zen's sidebar media
controls. Click the preview to play or pause, double-click it to go to the video's
own tab, or use its pop-out button to open a floating player.

| What you do | What happens |
| --- | --- |
| Switch away from a tab with a playing or paused video | The sidebar shows that video. |
| Browse tabs without video | The current preview stays visible. |
| Switch away from another tab with a video | That video replaces the preview. |
| Return to the video's tab | The preview closes. |
| Switch to another application | A playing preview opens in a floating player. A paused video stays in its tab. |
| Return to Zen | The automatically opened player closes and the preview returns, unless the video's tab is selected. |
| Close the video's tab | The preview closes. |

**Sidebar preview frame rate** defaults to 30 fps. Choose 15 fps for lower CPU
and messaging use, or 60 fps for a higher cap. Actual rates depend on the video
and machine. This setting applies immediately to an open preview. Only one
copied frame waits for the browser at a time, so a slow preview cannot build up
a queue of pixel buffers.

The preview offers play/pause and pop-out controls. Protected video, or video that cannot be shown
in the preview, opens in the regular picture-in-picture player instead. A tab that
is still called New Tab, or any `about:newtab`, `about:home` or `about:blank` page,
is skipped in both: nothing from it appears in the sidebar and no player opens for
it. Turn this option off to use a floating player while browsing other tabs.

**Pop the player out when leaving Zen** is off by default. Enable it to also
request a floating player when you switch to another application with the
video's own tab selected. Returning to that tab closes the automatically opened
player. Players you open manually stay open.

## Zia compatibility

Zia is optional. When it is installed, this mod replaces its tuck button,
switches off Zia's tucking preference at startup, and removes Zia's minimize
button from the player. If you re-enable Zia's tucking, hover peeking temporarily
suspends it until the peek ends.

## Diagnostics

**Write diagnostic logs** is off by default. Enable it before reproducing a
problem and disable it afterward. Log writes are ordered across browser
windows, and the media-card visibility poll runs only while logging is enabled.
The log is `chrome/sine-mods/pip-tuck-away/trace.log` inside your Zen profile.
