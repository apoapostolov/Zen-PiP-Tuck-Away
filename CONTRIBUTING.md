# Contributing

## Reporting a problem

Include your Zen and Sine versions, other installed PiP mods, the relevant
PiP Tuck Away settings, and the steps needed to reproduce the problem. For
positioning or hover problems, include your monitor layout and which screen
edge you used.

Diagnostic logging is off by default. Enable **Write diagnostic logs** in the
mod settings before reproducing a problem. Look for `trace.log` in the mod's
folder under your Zen profile: `chrome/sine-mods/pip-tuck-away/`. Turn the
setting off when you have collected the log.

## Running tests

With Node.js installed, run these commands from the repository root:

```sh
node tests/browser.test.mjs scripts/pip-tuck-away.uc.js
node tests/player.test.mjs scripts/pip-player.uc.js
node tests/child.test.mjs scripts/pip-mirror-child.sys.mjs
node tests/parent.test.mjs scripts/pip-mirror-parent.sys.mjs
```

These suites check browser integration, player behavior, and the sidebar video
preview without launching Zen. Changes to window movement, hover behavior, or
the sidebar also need a manual check in Zen with a real video.
