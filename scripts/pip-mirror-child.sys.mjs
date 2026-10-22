/*
 * PiP Tuck Away: the content half of the widget mirror.
 *
 * This file runs inside the page. Its job is to find the video that is playing
 * there, copy its frames into a small canvas, and post the pixels to the browser
 * window, which paints them in the sidebar. Copying leaves the video in the
 * page with its sound; only explicit playback commands change its state.
 *
 * The video is scaled into a small canvas, then its pixels are read back and
 * sent to the browser. Readback and process messaging are bounded:
 *
 *  - Video frame callbacks drive visible playback. A privileged clock keeps
 *    the preview moving when background content callbacks are suspended.
 *  - The chosen frame-rate cap and one outstanding frame limit copying work.
 *  - The canvas is limited to 320 pixels on its longest edge, so scaling
 *    reduces the number of pixels read back and sent to the browser.
 *  - What it costs is measured and reported, so a slow picture can be answered
 *    with numbers rather than a guess.
 *
 * One still is sent the moment the copy starts, so a paused video has a picture
 * at once.
 *
 * A mirror is not Picture-in-Picture. No player window is opened while the
 * browser is in front, so the browser's own picture-in-picture keeps its size,
 * its place and its tucked edge, and it is what appears the moment the browser
 * goes to the background.
 *
 * The one thing a mirror cannot do is protected video: a frame copy of an
 * encrypted stream comes back black, so the video is checked for a media key
 * system before anything starts and the browser window is told to use a real
 * player instead.
 */

const MAX_DIMENSION = 320; // the long edge of a copied frame: the panel's own width
const DEFAULT_FPS = 30; // sidebar previews favor lower readback and IPC cost
const RATE_MS = 2000; // how often the cost of all this is reported
const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

export class PipMirrorChild extends JSWindowActorChild {
  #video = null;
  #running = false;
  #frame = 0;
  #canvas = null;
  #ctx = null;
  #lastSent = 0;
  #lastStill = -1;
  #trigger = "timer"; // "frames" for requestVideoFrameCallback, "timer" otherwise
  #copied = 0; // frames copied since the last report
  #cost = 0; // ms spent copying since the last report
  #reported = 0; // when the last report was sent
  #frameMS = 1000 / DEFAULT_FPS;
  #awaitingFrame = false;
  #session = 0;
  #frameCallback = 0; // the video's own frame callback, where the build has it

  receiveMessage(message) {
    switch (message.name) {
      case "PipMirror:Start":
        this.#start(message.data ?? {});
        break;
      case "PipMirror:FrameAck":
        if (message.data?.session === this.#session) this.#awaitingFrame = false;
        break;
      case "PipMirror:Configure":
        this.#configure(message.data ?? {});
        break;
      case "PipMirror:Stop":
        this.#stop();
        break;
      case "PipMirror:Control":
        this.#control(message.data ?? {});
        break;
      default:
        break;
    }
  }

  /** The video worth copying: the one playing, the largest of them if none is. */
  #pick() {
    let best = null;
    let bestScore = -1;
    for (const video of this.document?.querySelectorAll?.("video") ?? []) {
      if (!video.videoWidth || !video.videoHeight || video.readyState < 2) {
        continue;
      }
      const playing = !video.paused && !video.ended;
      const audible = !video.muted && video.volume > 0;
      const score =
        (playing ? 4 : 0) + (audible ? 2 : 0) + (video.videoWidth * video.videoHeight) / 1e7;
      if (score > bestScore) {
        bestScore = score;
        best = video;
      }
    }
    return best;
  }

  #configure({ fps = DEFAULT_FPS } = {}) {
    this.#frameMS = 1000 / ([15, 30, 60].includes(fps) ? fps : DEFAULT_FPS);
  }

  #start(settings = {}) {
    this.#configure(settings);
    if (this.#running) {
      return;
    }
    this.#session++;
    const video = this.#pick();
    if (!video) {
      this.sendAsyncMessage("PipMirror:Unavailable", { reason: "no video is playing" });
      return;
    }
    this.#video = video;
    this.#running = true;
    this.sendAsyncMessage("PipMirror:Started", {
      width: video.videoWidth,
      height: video.videoHeight,
      // An encrypted stream copies as black, so say so before copying anything.
      encrypted: !!video.mediaKeys,
      paused: video.paused,
      time: video.currentTime,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      mode: "pending",
    });
    if (video.mediaKeys) {
      this.#stop();
      return;
    }
    // A picture straight away: a paused video has one, and a video that is
    // about to move should not show an empty panel while it waits.
    this.#lastStill = video.paused ? video.currentTime : -1;
    this.#lastSent = Date.now();
    this.#copy(video);
    if (!this.#running) {
      return;
    }
    this.#trigger = this.#watchFrames(video) ? "frames" : "timer";
    this.#reported = Date.now();
    this.#announce(video);
    this.#loop();
  }

  /**
   * Copy when the video presents a frame, rather than on a clock.
   *
   * A timer copies the same picture over and over between frames and pays the
   * readback for every one of them. This asks the video to say when it has
   * something new, which is both cheaper and truer to the video's own rate.
   */
  #watchFrames(video) {
    if (typeof video.requestVideoFrameCallback !== "function") {
      return false;
    }
    let registered = false;
    const step = () => {
      if (!this.#running || this.#video !== video) {
        return;
      }
      try {
        this.#frameCallback = video.requestVideoFrameCallback(() => {
          if (!this.#running || this.#video !== video) {
            return;
          }
          this.#maybeCopy(video);
          step();
        });
        registered = true;
      } catch (err) {
        // Some builds expose the API but refuse registration. Keep copying
        // through the animation loop instead of freezing the preview.
        this.#trigger = "timer";
      }
    };
    step();
    return registered;
  }

  /** One copy, unless the last one is still warm. */
  #maybeCopy(video) {
    const now = Date.now();
    if (now - this.#lastSent < this.#frameMS) {
      return;
    }
    const intervals = Math.floor((now - this.#lastSent) / this.#frameMS + 1e-7);
    this.#lastSent += intervals * this.#frameMS;
    this.#copy(video);
  }

  /** What the copy costs and how fast it is going, every couple of seconds. */
  #report() {
    const now = Date.now();
    if (now - this.#reported < RATE_MS) {
      return;
    }
    const seconds = (now - this.#reported) / 1000;
    this.#reported = now;
    const copied = this.#copied;
    const cost = this.#cost;
    this.#copied = 0;
    this.#cost = 0;
    this.sendAsyncMessage("PipMirror:Rate", {
      fps: Math.round((copied / seconds) * 10) / 10,
      ms: copied ? Math.round((cost / copied) * 10) / 10 : 0,
      width: this.#canvas?.width ?? 0,
      height: this.#canvas?.height ?? 0,
      trigger: this.document.hidden ? "background timer" : this.#trigger,
      paused: !!this.#video?.paused,
    });
  }

  #stop() {
    const wasRunning = this.#running;
    this.#running = false;
    this.#awaitingFrame = false;
    if (this.#frame) {
      clearTimeout(this.#frame);
      this.#frame = 0;
    }
    if (this.#frameCallback) {
      try {
        this.#video?.cancelVideoFrameCallback?.(this.#frameCallback);
      } catch (err) {
        // The video went away with the callback.
      }
      this.#frameCallback = 0;
    }
    this.#trigger = "timer";
    if (this.#frame) {
      try {
        this.contentWindow?.cancelAnimationFrame?.(this.#frame);
      } catch (err) {
        // The window is going away with the frame.
      }
      this.#frame = 0;
    }
    this.#video = null;
    this.#canvas = null;
    this.#ctx = null;
    this.#lastSent = 0;
    this.#lastStill = -1;
    this.#copied = 0;
    this.#cost = 0;
    this.#reported = 0;
    if (wasRunning) {
      try {
        this.sendAsyncMessage("PipMirror:Stopped", {});
      } catch (err) {
        // Unregistering the actor can close its channel before didDestroy.
      }
    }
  }

  #loop = () => {
    if (!this.#running) {
      return;
    }
    // Content animation callbacks stop when the video's tab is hidden. A
    // privileged timer keeps the background preview moving at its chosen cap.
    this.#frame = setTimeout(this.#loop, this.#frameMS);
    const video = this.#video;
    if (video?.isConnected === false || video?.ended) {
      this.#stop();
      return;
    }
    if (!video || video.readyState < 2 || !video.videoWidth) {
      return;
    }
    if (video.paused) {
      // A held pause sends one still frame and then keeps quiet until it moves,
      // and a seek inside a pause sends one more.
      if (this.#lastStill === video.currentTime) {
        this.#report();
        return;
      }
      this.#lastSent = Date.now();
      this.#copy(video);
      return;
    }
    // Visible playback uses video callbacks. Hidden tabs and builds without
    // that API use this clock, subject to the same cap and acknowledgement.
    if (this.#trigger === "timer" || this.document.hidden) {
      this.#maybeCopy(video);
    }
    this.#report();
  };

  #copy(video) {
    if (this.#awaitingFrame) return;
    const started = this.contentWindow.performance?.now() ?? Date.now();
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = Math.min(1, MAX_DIMENSION / Math.max(vw, vh));
    // Even numbers keep the aspect from drifting a pixel at a time.
    const width = Math.max(2, Math.round((vw * scale) / 2) * 2);
    const height = Math.max(2, Math.round((vh * scale) / 2) * 2);
    try {
      const win = this.contentWindow;
      if (!this.#ctx || this.#canvas.width !== width || this.#canvas.height !== height) {
        this.#canvas =
          typeof win.OffscreenCanvas === "function"
            ? new win.OffscreenCanvas(width, height)
            : win.document.createElement("canvas");
        this.#canvas.width = width;
        this.#canvas.height = height;
        this.#ctx = this.#canvas.getContext("2d", {
          alpha: false,
          willReadFrequently: true,
        });
      }
      this.#ctx.drawImage(video, 0, 0, width, height);
      const pixels = this.#ctx.getImageData(0, 0, width, height);
      this.#lastStill = video.paused ? video.currentTime : -1;
      this.#copied++;
      this.#cost += (this.contentWindow.performance?.now() ?? Date.now()) - started;
      // Pixels cross the actor boundary as a serialized buffer. Gecko copies
      // ArrayBuffers between processes even when listed as transferables.
      this.#awaitingFrame = true;
      this.sendAsyncMessage(
        "PipMirror:Frame",
        {
          session: this.#session,
          buf: pixels.data.buffer,
          width,
          height,
          time: video.currentTime,
          duration: Number.isFinite(video.duration) ? video.duration : 0,
          paused: video.paused,
        },
        [pixels.data.buffer]
      );
    } catch (err) {
      this.sendAsyncMessage("PipMirror:Unavailable", {
        reason: `copying a frame failed: ${err?.message ?? err}`,
      });
      this.#stop();
    }
  }

  #control({ action, value }) {
    const video = this.#video ?? this.#pick();
    if (!video) {
      return;
    }
    try {
      switch (action) {
        case "toggle":
          if (video.paused) {
            Promise.resolve(video.play()).catch(() => {});
          } else {
            video.pause();
          }
          break;
        case "play":
          Promise.resolve(video.play()).catch(() => {});
          break;
        case "pause":
          video.pause();
          break;
        case "seek":
          if (Number.isFinite(value)) {
            video.currentTime = value;
          }
          break;
        default:
          break;
      }
    } catch (err) {
      this.sendAsyncMessage("PipMirror:Unavailable", {
        reason: `the video refused a command: ${err?.message ?? err}`,
      });
    }
    this.#announce(video);
  }

  #announce(video) {
    this.sendAsyncMessage("PipMirror:State", {
      paused: video.paused,
      time: video.currentTime,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
    });
  }

  /**
   * Playback state follows the video's own events rather than the copied
   * frames, so the controls stay right through a seek or a pause even when no
   * new picture is being sent.
   */
  handleEvent(event) {
    if (!this.#running) {
      return;
    }
    const video = this.#video ?? event?.target;
    if (!video || event?.target !== video) {
      return;
    }
    if (event.type === "emptied" || event.type === "ended") {
      this.#stop();
      return;
    }
    if (event.type === "pause") {
      // One last still frame so the sidebar shows where it stopped.
      this.#lastStill = -1;
      this.#copy(video);
    }
    this.#announce(video);
  }

  didDestroy() {
    this.#stop();
  }
}
