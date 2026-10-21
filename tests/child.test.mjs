// Headless harness for pip-mirror-child.sys.mjs: the content half of the widget
// mirror. Stubs the actor base class, a page with a video in it, an offscreen
// canvas and the video's own frame callbacks, then drives the real module and
// asserts what it copies, what it sends, and what it costs.
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The real base class is provided by Gecko. The shim stands in for it: it
// collects what the child sends, so the test can read it.
const SHIM = `class JSWindowActorChild {
  sendAsyncMessage(name, data, transfers) {
    (globalThis.__pipSent ??= []).push({ name, data, transfers: transfers ?? [] });
  }
}
`;
// A real file rather than a data URL, so a failure reads like a stack trace.
const MODULE_FILE = join(tmpdir(), `pip-mirror-child-${process.pid}.mjs`);

const results = [];
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
};

/** The clock the module sees, so a rate can be tested without waiting. */
const clock = { now: 1_000_000 };
const realNow = Date.now;
const setClock = (ms) => {
  clock.now = ms;
};

/** A video the page is playing, or a page with nothing worth copying. */
const makeVideo = (opts = {}) => {
  const callbacks = new Map();
  let nextId = 1;
  const video = {
    videoWidth: opts.width ?? 1280,
    videoHeight: opts.height ?? 720,
    readyState: opts.readyState ?? 4,
    paused: opts.paused ?? false,
    ended: false,
    muted: false,
    volume: 1,
    currentTime: opts.time ?? 0,
    duration: opts.duration ?? 300,
    mediaKeys: opts.encrypted ? {} : null,
    play() {
      video.paused = false;
      return Promise.resolve();
    },
    pause() {
      video.paused = true;
    },
  };
  if (opts.frameCallback !== false) {
    video.requestVideoFrameCallback = (fn) => {
      callbacks.set(nextId, fn);
      return nextId++;
    };
    video.cancelVideoFrameCallback = (id) => callbacks.delete(id);
  }
  /** The video presents a frame: its callbacks run, and re-register. */
  video.present = () => {
    const pending = [...callbacks.entries()];
    callbacks.clear();
    for (const [, fn] of pending) fn();
    return pending.length;
  };
  video.pending = () => callbacks.size;
  return video;
};

async function mk(opts = {}) {
  globalThis.__pipSent = [];
  const sent = globalThis.__pipSent;
  const draws = [];
  fs.writeFileSync(MODULE_FILE, SHIM + fs.readFileSync(process.argv[2], "utf8"));

  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: (source, x, y, w, h) => draws.push({ source, w, h }),
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    }),
  };
  const video = opts.noVideo ? null : makeVideo(opts.video ?? {});
  const frameQueue = [];
  const contentWindow = {
    document: {
      querySelectorAll: () => (video ? [video] : []),
      createElement: () => canvas,
    },
    OffscreenCanvas: function OffscreenCanvas() {
      return canvas;
    },
    requestAnimationFrame: (fn) => {
      frameQueue.push(fn);
      return frameQueue.length;
    },
    cancelAnimationFrame: (id) => {
      frameQueue[id - 1] = null;
    },
  };

  const module = await import(`file://${MODULE_FILE.replace(/\\/g, "/")}?${Math.random()}`);
  const child = new module.PipMirrorChild();
  child.contentWindow = contentWindow;
  child.document = contentWindow.document;

  return {
    child,
    sent,
    video,
    canvas,
    draws,
    names: () => sent.map((m) => m.name),
    frames: () => sent.filter((m) => m.name === "PipMirror:Frame"),
    rate: () => [...sent].reverse().find((m) => m.name === "PipMirror:Rate")?.data ?? null,
    /** Run the animation frame the copy loop asked for. */
    runFrame() {
      const upto = frameQueue.length;
      for (let i = 0; i < upto; i++) {
        const fn = frameQueue[i];
        frameQueue[i] = null;
        if (fn) fn();
      }
    },
    async settle() {
      for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
    },
  };
}

Date.now = () => clock.now;

// 1. a playing video starts with a picture, and copies at the panel's size
{
  setClock(1_000_000);
  const t = await mk({});
  t.child.receiveMessage({ name: "PipMirror:Start" });
  await t.settle();
  const first = t.sent[0];
  check("the browser half is told what it is looking at", [first.name, first.data.width, first.data.height], [
    "PipMirror:Started",
    1280,
    720,
  ]);
  check("and a picture is sent at once, so a paused video is not an empty panel", t.names()[1], "PipMirror:Frame");
  check("copied at the size the sidebar shows it", [t.canvas.width, t.canvas.height], [320, 180]);
  check("and the copy is the video's own shape", t.draws[0].w, 320);
}

// 2. the video's own frames drive the copying, once each
{
  setClock(1_000_000);
  const t = await mk({});
  t.child.receiveMessage({ name: "PipMirror:Start" });
  await t.settle();
  const before = t.draws.length;
  check("the video was asked to say when it has a frame", t.video.pending() > 0, true);
  setClock(1_000_050);
  t.video.present();
  check("a presented frame is copied", t.draws.length, before + 1);
  check("and it is sent", t.frames().length, before + 1);
  // Two presentations inside the floor are one copy: the readback is not free.
  setClock(1_000_060);
  t.video.present();
  check("a second frame too soon is not copied", t.draws.length, before + 1);
  setClock(1_000_100);
  t.video.present();
  check("and the next one is", t.draws.length, before + 2);
}

// 3. a build without the video's frame callback copies on a clock instead
{
  setClock(2_000_000);
  const t = await mk({ video: { frameCallback: false } });
  t.child.receiveMessage({ name: "PipMirror:Start" });
  await t.settle();
  const before = t.draws.length;
  setClock(2_000_100);
  t.runFrame();
  check("a frame of the browser's own clock is copied", t.draws.length, before + 1);
  setClock(2_000_105);
  t.runFrame();
  check("and a second one inside the floor is not", t.draws.length, before + 1);
  setClock(2_000_200);
  t.runFrame();
  check("the next one is", t.draws.length, before + 2);
}

// 4. what it costs is reported, so a slow picture has numbers
{
  setClock(3_000_000);
  const t = await mk({});
  t.child.receiveMessage({ name: "PipMirror:Start" });
  await t.settle();
  for (const at of [3_000_100, 3_000_500, 3_001_000, 3_001_500]) {
    setClock(at);
    t.video.present();
  }
  setClock(3_002_000); // two seconds after the start
  t.runFrame();
  const rate = t.rate();
  check("the rate is reported", !!rate, true);
  // The opening still plus four presented frames, over two seconds.
  check("with the frames a second it managed", rate.fps, 2.5);
  check("the size it copied", [rate.width, rate.height], [320, 180]);
  check("what drove the copying", rate.trigger, "frames");
  check("and how long a frame took", typeof rate.ms, "number");
}

// 5. a page with nothing to copy says so
{
  const t = await mk({ noVideo: true });
  t.child.receiveMessage({ name: "PipMirror:Start" });
  await t.settle();
  check("the browser half is told there is no video", t.names(), ["PipMirror:Unavailable"]);
}

// 6. protected video is refused before anything is copied
{
  const t = await mk({ video: { encrypted: true } });
  t.child.receiveMessage({ name: "PipMirror:Start" });
  await t.settle();
  check("it is reported as protected", t.sent[0].data.encrypted, true);
  check("and nothing is copied", t.names().includes("PipMirror:Frame"), false);
}

// 7. a pause sends one still, and the state with it
{
  setClock(4_000_000);
  const t = await mk({});
  t.child.receiveMessage({ name: "PipMirror:Start" });
  await t.settle();
  const before = t.draws.length;
  t.video.paused = true;
  t.video.currentTime = 12;
  t.child.handleEvent({ type: "pause", target: t.video });
  check("a still is sent", t.draws.length, before + 1);
  check("with the time it stopped at", t.frames().at(-1).data.time, 12);
  check("and the playback state follows the video's own event", t.names().includes("PipMirror:State"), true);
  setClock(4_000_200);
  t.runFrame();
  check("and it stays quiet while the pause is held", t.draws.length, before + 1);
}

// 8. stopping lets the video's callbacks go
{
  setClock(5_000_000);
  const t = await mk({});
  t.child.receiveMessage({ name: "PipMirror:Start" });
  await t.settle();
  t.child.receiveMessage({ name: "PipMirror:Stop" });
  await t.settle();
  check("the browser half is told it stopped", t.names().includes("PipMirror:Stopped"), true);
  check("and nothing is left waiting on the video", t.video.pending(), 0);
}

// 9. a command reaches the video, and the state comes back
{
  const t = await mk({});
  t.child.receiveMessage({ name: "PipMirror:Start" });
  await t.settle();
  t.child.receiveMessage({ name: "PipMirror:Control", data: { action: "toggle" } });
  check("a playing video is paused", t.video.paused, true);
  t.child.receiveMessage({ name: "PipMirror:Control", data: { action: "toggle" } });
  await t.settle();
  check("and a paused one is played", t.video.paused, false);
  check("the state is announced either way", t.names().includes("PipMirror:State"), true);
}

Date.now = realNow;
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
