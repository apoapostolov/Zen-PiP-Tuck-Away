# Code audit — 2026-10-22

Reviewed the five runtime scripts, both stylesheets, preferences, installation
metadata, and the Node regression suites. The starting checkout was clean
at `ed2e7e6` on `main`. Changes are on `audit/cleanup-lifecycle-preview`.

## Findings addressed

| Area | Problem | Change |
| --- | --- | --- |
| Multiple windows | The global PiP request wrapper captured the first window; tab listeners for other windows also used that window's state. | Route requests to the owning window and watch each window's own tab strip. |
| Shared resources | Unloading one window unregistered the application-wide actor, removed shared shortcuts, and destroyed other windows' player controls. | Track window ownership and release shared resources after the last controller unloads. |
| Reload lifecycle | The browser guard, tab listeners, deferred decoration, and some player hooks survived unloading. | Cancel delayed work, remove listeners and guards, restore native resize functions, and make teardown idempotent. |
| Preview fallback | Replacing a preview without a new PiP request inherited the previous tab's request. A request arriving after TabSelect could also be discarded. | Associate each request with its own preview; retain requests arriving after preview startup. |
| Pending tabs | Returning to a pending tab could launch its held PiP request; its state messages could change the currently displayed video's controls. | Cancel that request and accept playback state only from the current preview. |
| Content callbacks | Failed startup still registered a video callback; stop/start accumulated animation loops; detached videos kept their preview alive. | Stop startup after failure, cancel animation callbacks on stop, and detect detached or ended videos. |
| Frame fallback | An exposed but throwing video-frame API froze the preview. The timer fallback also duplicated the opening still. | Fall back to the animation clock and timestamp the first copy. |
| Player cleanup | Unloading while tucked started another animation and left visual state or stale unload callbacks behind. | Return home synchronously, clear visual state, and detach the old unload handler. |
| Preferences | Inherited object keys such as `__proto__` could break geometry or startup. Disabling sidebar integration or tracing did not immediately stop existing work. | Validate lookup keys and observe those browser preferences. |
| Keyboard access | Sidebar controls were unfocusable divs with button roles. | Use native buttons with a visible focus indicator. |

Removed the unused `mirroring` helper, duplicate string preference reader,
redundant stylesheet-loading aliases, abandoned toggle-file test fixtures, and
comments describing the previous window-docking implementation. Actor module
cache version advances from 4 to 11 for the actor changes.

## Performance work completed

- **Bound frame copying.** The sidebar defaults to 30 fps, with 15 and 60 fps
  choices that apply immediately. Each content actor allows one pixel buffer
  awaiting acknowledgement. Session IDs prevent an old acknowledgement from
  releasing a new session's buffer.
- **Keep background previews moving.** Content animation callbacks can be
  suspended in background tabs. A privileged timer supplies the fallback while
  preserving the frame-rate cap and paused-video behavior.
- **Measure layout on changes.** Resize and mutation observers trigger one
  measurement per frame when necessary. Continuous tracking is limited to
  relevant CSS transitions, including ancestor movement and simultaneous
  transition properties. Detached targets and teardown release that work.
- **Avoid invisible previews.** A sidebar that is starting up gets time to
  appear. If it remains hidden, collapsed, or offscreen, the preview falls back
  to native PiP instead of copying an unseen video indefinitely.
- **Make diagnostics optional.** Tracing defaults off. When enabled, its
  visibility check runs once per second. File creation, size checks, rotation,
  and appends share one system-module queue; failed writes do not block later
  writes. Its promise reactions survive the browser window that enabled logging.
  The global PiP wrapper also avoids promises owned by a closing window.

A live sample used generated 640×360 H.264 video, copying 320×180 RGBA frames.
Each measurement lasted approximately 2.5 seconds:

| Preview cap | Delivered fps | Pixel payload MB/s | Card layout reads |
| --- | ---: | ---: | ---: |
| 15 | 15.2 | 3.5 | 4 |
| 30 | 24.0 | 5.5 | 4 |
| 60 | 24.4 | 5.6 | 6 |

The 60 fps setting offered little improvement on this machine and fixture.
These are local samples, not general performance guarantees. Payload excludes
message overhead. Gecko copies ArrayBuffers between processes even when listed
as transferables; see [Mozilla's actor documentation](https://firefox-source-docs.mozilla.org/dom/ipc/jsactors.html#sendasyncmessage).

## Validation

- Browser suite: 184/184 assertions pass.
- Player suite: 364/364 assertions pass.
- Content actor suite: 49/49 assertions pass.
- Parent actor suite: 9/9 assertions pass.
- Total automated assertions: **606**.
- JavaScript syntax, JSON parsing, and Git whitespace checks pass.

New coverage includes shared browser windows, unload/reload, queued trace
writes and recovery, idle layout scheduling, transition cancellation, preview
request ownership, native media controls becoming available, immediate
preferences, malformed preferences, hook restoration, acknowledgement pacing,
background copying, and copy/callback failure paths.

## Native Zen checks completed

**35 native checks passed** in a disposable Zen Twilight 1.24t profile
(build 20261020115400, Gecko 158.0.1), on Windows at 150% display scaling.
The normal user profile was read only. Native Marionette drove the production
chrome scripts, without a mocked browser or media decoder.

- All four tuck edges, restoration, hover peek, and freeing a player by moving
  it inward through the native drag-detection path.
- Native landscape-to-portrait video resizing while preserving position.
- Moving sidebar video, paused seeking, and iframe native PiP.
- A public YouTube video opening in native PiP with the mod's controls.
- The protected-video guard with a real ClearKey `MediaKeys` object.
- Two browser windows: preview ownership, closing the first window, continued
  shortcuts, previewing again in the surviving window, returned PiP requests,
  and continued trace writes after the creating window closes.
- The installed Sine 2.3.4.1c manager, copied into the disposable profile:
  registering unload callbacks, disabling the mod, updating during a hover
  peek, and enabling it again without restarting Zen.
- The installed Zia 2.103.11 player module and styles, also copied into the test
  profile: minimize removal, tuck ownership, stable hover peek, and fullscreen.

[Structured native results and measurements](validation/2026-10-22-zen-twilight.json)
record the checks and environment.

Only one display is attached, so native movement between monitors with different
DPI settings could not be exercised. Geometry regression tests cover alternative
screen origins and available bounds. Commercial DRM license playback was not
exercised; the protection check used a local MediaKeys fixture. YouTube's own
playlist automation was not driven; the same native video-resize path was
exercised with a source change, and YouTube PiP loading was checked separately.
