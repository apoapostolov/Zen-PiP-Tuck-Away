/*
 * PiP Tuck Away: the content half of the widget mirror.
 *
 * This file runs inside the page. Its job is to find the video that is playing
 * there, copy its frames into a small canvas, and post the pixels to the browser
 * window, which paints them in the sidebar. The video itself is never moved,
 * paused or touched: the page keeps playing it, the page keeps its sound, and
 * nothing is loaded twice.
 *
 * The picture is a copy: the video is drawn into an offscreen canvas at the
 * size the sidebar shows it, and the pixels are read back and sent. That is the
 * only route in Firefox, where the frame-stream APIs exist in workers rather
 * than on the page, and the window-scoped `MediaStreamTrackProcessor` is a
 * webcompat shim built out of a canvas: same cost as copying, none of the
 * benefit. So the work goes into making the copy cheap:
 *
 *  - A new frame is copied when the video presents one, through
 *    `requestVideoFrameCallback` where the build has it, rather than on a timer
 *    that copies the same picture again and again.
 *  - The canvas is the width the sidebar shows, so the readback is a quarter of
 *    what a full-size frame would cost and the scaling happens on the GPU.
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
const FRAME_MS = 16; // a copied preview never tries for more than sixty a second
const RATE_MS = 2000; // how often the cost of all this is reported

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
  #frameCallback = 0; // the video's own frame callback, where the build has it

  receiveMessage(message) {
    switch (message.name) {
      case "PipMirror:Start":
        this.#start();
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

  #start() {
    if (this.#running) {
      return;
    }
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
    this.#copy(video);
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
    const win = this.contentWindow;
    if (typeof video.requestVideoFrameCallback !== "function") {
      return false;
    }
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
      } catch (err) {
        // The video went away with the callback.
      }
    };
    step();
    return true;
  }

  /** One copy, unless the last one is still warm. */
  #maybeCopy(video) {
    const now = Date.now();
    if (now - this.#lastSent < FRAME_MS) {
      return;
    }
    this.#lastSent = now;
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
      trigger: this.#trigger,
      paused: !!this.#video?.paused,
    });
  }

  #stop() {
    const wasRunning = this.#running;
    this.#running = false;
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
      this.sendAsyncMessage("PipMirror:Stopped", {});
    }
  }

  #loop = () => {
    if (!this.#running) {
      return;
    }
    this.#frame = this.contentWindow.requestAnimationFrame(this.#loop);
    const video = this.#video;
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
      this.#lastStill = video.currentTime;
      this.#lastSent = Date.now();
      this.#copy(video);
      return;
    }
    // Playing: the video's own frame callback does the copying. A build without
    // it copies here instead, at a sane rate.
    if (this.#trigger === "timer") {
      this.#maybeCopy(video);
    }
    this.#report();
  };

  #copy(video) {
    const started = Date.now();
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
      this.#cost += Date.now() - started;
      // An ImageBitmap cannot cross an actor boundary, so the pixels travel as
      // a transferred buffer.
      this.sendAsyncMessage(
        "PipMirror:Frame",
        {
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
