// Headless harness for pip-mirror-child.sys.mjs: the content half of the widget
// mirror. Stubs the actor base class, a page with a video in it, an offscreen
// canvas, and a frame stream, then drives the real module and asserts what it
// sends and what it closes.
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
  results.push({ name, ok, actual: JSON.stringify(actual), expected: JSON.stringify(expected) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
};

/** A video the page is playing, or a page with nothing worth copying. */
const makeVideo = (opts = {}) => ({
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
  captureStream: opts.captureStream,
});

/** Frames the stream hands over, one per read. */
const makeFrames = (count) => {
  const closed = [];
  const queue = [];
  for (let i = 0; i < count; i++) {
    queue.push({
      timestamp: i * 40_000,
      displayWidth: 1280,
      displayHeight: 720,
      closed: false,
      close() {
        this.closed = true;
        closed.push(i);
      },
    });
  }
  return { queue, closed };
};

async function mk(opts = {}) {
  globalThis.__pipSent = [];
  const sent = globalThis.__pipSent;
  fs.writeFileSync(MODULE_FILE, SHIM + fs.readFileSync(process.argv[2], "utf8"));
  const frames = makeFrames(opts.frames ?? 0);
  const reader = {
    cancelled: false,
    async read() {
      if (reader.cancelled || frames.queue.length === 0) {
        return { value: undefined, done: true };
      }
      return { value: frames.queue.shift(), done: false };
    },
    async cancel() {
      reader.cancelled = true;
    },
  };
  let processorMade = 0;
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage() {},
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
    OffscreenCanvas: opts.offscreen === false ? undefined : function OffscreenCanvas() {
      return canvas;
    },
    MediaStreamTrackProcessor: opts.noProcessor
      ? undefined
      : function MediaStreamTrackProcessor() {
          processorMade++;
          return { readable: { getReader: () => reader } };
        },
    requestAnimationFrame: (fn) => {
      frameQueue.push(fn);
      return frameQueue.length;
    },
    cancelAnimationFrame: (id) => {
      frameQueue[id - 1] = null;
    },
  };

  // A fresh query string per case, so no state can leak between them.
  const module = await import(`file://${MODULE_FILE.replace(/\\/g, "/")}?${Math.random()}`);
  const Child = module.PipMirrorChild;
  const child = new Child();
  // The real base class provides these; the module under test only uses them.
  child.contentWindow = contentWindow;
  child.document = contentWindow.document;

  return {
    child,
    sent,
    frames,
    reader,
    video,
    canvas,
    processors: () => processorMade,
    /** Run the animation frame the copy loop asked for. */
    runFrame() {
      const upto = frameQueue.length;
      for (let i = 0; i < upto; i++) {
        const fn = frameQueue[i];
        frameQueue[i] = null;
        if (fn) fn();
      }
    },
    /** Let the stream's promises settle. */
    async settle() {
      for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
    },
    names: () => sent.map((m) => m.name),
  };
}

// 1. a playing video starts with a picture, then streams its own frames
{
  const t = await mk({ frames: 3, video: { captureStream: () => ({ getVideoTracks: () => [{}] }) } });
  t.child.receiveMessage({ name: "PipMirror:Start" });
  await t.settle();
  const first = t.sent[0];
  check("the browser half is told what it is looking at", [first.name, first.data.width, first.data.height], [
    "PipMirror:Started",
    1280,
    720,
  ]);
  check("and a picture is sent at once, so a paused video is not an empty panel", t.names()[1], "PipMirror:Frame");
  check("the frame stream is used when the build has one", t.processors(), 1);
  check("and its frames are sent as frames", t.names().includes("PipMirror:VideoFrame"), true);
  const carried = t.sent.filter((m) => m.name === "PipMirror:VideoFrame");
  check("each frame travels as a transferable", carried[0].transfers.length, 1);
  check("with the time it was shown at", carried[0].data.time, 0);
  // The frame is handed over, so it is the browser half that closes it. The
  // child only closes what it drops, which is what keeps a slow sidebar from
  // queueing frames behind it.
  check("and it is handed over rather than closed here", carried[0].data.frame.closed, false);
  check("frames the sidebar cannot keep up with are dropped", t.frames.closed.length >= 1, true);
  check("and nothing is lost or double counted", carried.length + t.frames.closed.length, 3);
}

// 2. no frame stream in the build: the pixels are copied instead
{
  const t = await mk({ noProcessor: true, video: { captureStream: () => ({ getVideoTracks: () => [{}] }) } });
  t.child.receiveMessage({ name: "PipMirror:Start" });
  await t.settle();
  check("nothing is streamed", t.names().includes("PipMirror:VideoFrame"), false);
  check("pixels are copied", t.names().includes("PipMirror:Frame"), true);
  check("and the copy keeps going on the video's own clock", (t.runFrame(), t.names().filter((n) => n === "PipMirror:Frame").length >= 1), true);
}

// 3. a video the page will not hand over a stream for
{
  const t = await mk({ noProcessor: true });
  t.child.receiveMessage({ name: "PipMirror:Start" });
  await t.settle();
  check("no stream is asked for", t.names().includes("PipMirror:VideoFrame"), false);
  check("and the copy is what shows it", t.names().includes("PipMirror:Frame"), true);
}

// 4. a page with nothing to copy says so
{
  const t = await mk({ noVideo: true });
  t.child.receiveMessage({ name: "PipMirror:Start" });
  await t.settle();
  check("the browser half is told there is no video", t.names(), ["PipMirror:Unavailable"]);
}

// 5. protected video is refused before anything is copied
{
  const t = await mk({ video: { encrypted: true, captureStream: () => ({ getVideoTracks: () => [{}] }) } });
  t.child.receiveMessage({ name: "PipMirror:Start" });
  await t.settle();
  check("it is reported as protected", t.sent[0].data.encrypted, true);
  check("and nothing is copied", t.names().includes("PipMirror:Frame"), false);
  check("nor streamed", t.names().includes("PipMirror:VideoFrame"), false);
}

// 6. stopping lets the stream go
{
  const t = await mk({ frames: 5, video: { captureStream: () => ({ getVideoTracks: () => [{}] }) } });
  t.child.receiveMessage({ name: "PipMirror:Start" });
  await t.settle();
  t.child.receiveMessage({ name: "PipMirror:Stop" });
  await t.settle();
  check("the reader is cancelled", t.reader.cancelled, true);
  check("and the browser half is told it stopped", t.names().includes("PipMirror:Stopped"), true);
}

// 7. a pause sends one still, and the state with it
{
  const t = await mk({ video: { captureStream: () => ({ getVideoTracks: () => [{}] }) } });
  t.child.receiveMessage({ name: "PipMirror:Start" });
  await t.settle();
  const before = t.names().filter((n) => n === "PipMirror:Frame").length;
  t.video.paused = true;
  t.video.currentTime = 12;
  t.child.handleEvent({ type: "pause", target: t.video });
  check("a still is sent", t.names().filter((n) => n === "PipMirror:Frame").length, before + 1);
  check("with the time it stopped at", t.sent.at(-1).data.time, 12);
  check("and the playback state follows the video's own event", t.names().includes("PipMirror:State"), true);
}

// 8. a command reaches the video, and the state comes back
{
  const t = await mk({ video: { captureStream: () => ({ getVideoTracks: () => [{}] }) } });
  let played = 0;
  t.video.play = () => {
    played++;
    return Promise.resolve();
  };
  t.video.pause = () => {
    t.video.paused = true;
  };
  t.child.receiveMessage({ name: "PipMirror:Start" });
  await t.settle();
  t.child.receiveMessage({ name: "PipMirror:Control", data: { action: "toggle" } });
  check("a playing video is paused", t.video.paused, true);
  t.child.receiveMessage({ name: "PipMirror:Control", data: { action: "toggle" } });
  await t.settle();
  check("and a paused one is played", played, 1);
  check("the state is announced either way", t.names().includes("PipMirror:State"), true);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
