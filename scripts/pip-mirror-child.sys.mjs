/*
 * PiP Tuck Away: the content half of the widget mirror.
 *
 * This file runs inside the page. Its job is to find the video that is playing
 * there, copy its frames into a small canvas, and post the pixels to the browser
 * window, which paints them in the sidebar. The video itself is never moved,
 * paused or touched: the page keeps playing it, the page keeps its sound, and
 * nothing is loaded twice.
 *
 * Two ways of getting the picture out of the page, best first:
 *
 *  - A real frame stream. `video.captureStream()` fed into a
 *    `MediaStreamTrackProcessor` yields `VideoFrame` objects, which are
 *    transferable, so the sidebar draws the frame the page is showing rather
 *    than a copy of it. Nothing is read back on the CPU, the frames are not
 *    re-encoded, and the rate is the video's own rate.
 *  - A canvas copy, for a build without that API: the video is drawn into an
 *    offscreen canvas and the pixels are read back and sent. Slower, and about
 *    twenty frames a second is what it can manage.
 *
 * Either way one still is sent the moment the copy starts, so a paused video
 * has a picture at once and a stream that has nothing to send yet is not an
 * empty panel.
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

const MAX_DIMENSION = 480; // the long edge of a copied frame
const FRAME_MS = 50; // a copied preview manages about twenty frames a second
const STREAM_MS = 24; // a frame stream needs no throttle beyond the IPC hop

export class PipMirrorChild extends JSWindowActorChild {
  #video = null;
  #running = false;
  #frame = 0;
  #canvas = null;
  #ctx = null;
  #lastSent = 0;
  #lastStill = -1;
  #mode = ""; // "frames" for the stream, "copy" for the canvas
  #reader = null; // the frame stream's reader, when there is one

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
    // A picture straight away, whichever way the frames arrive after it: a
    // paused video has one, and a stream has nothing to send until it moves.
    this.#lastStill = video.paused ? video.currentTime : -1;
    this.#copy(video);
    this.#mode = this.#openStream(video) ? "frames" : "copy";
    this.#announce(video);
    this.#loop();
  }

  /**
   * The video's own frames, straight through.
   *
   * A VideoFrame is transferable, so the sidebar draws the frame the page is
   * showing: no readback, no re-encode, and no twenty-a-second ceiling.
   */
  #openStream(video) {
    try {
      const win = this.contentWindow;
      if (typeof win?.MediaStreamTrackProcessor !== "function") {
        return false;
      }
      const stream = video.captureStream?.();
      const track = stream?.getVideoTracks?.()[0];
      if (!track) {
        return false;
      }
      const processor = new win.MediaStreamTrackProcessor({ track });
      this.#reader = processor.readable.getReader();
      this.#pump();
      return true;
    } catch (err) {
      this.#reader = null;
      return false;
    }
  }

  #pump() {
    const reader = this.#reader;
    if (!reader) {
      return;
    }
    reader
      .read()
      .then(({ value, done }) => {
        if (done || !this.#running || !this.#reader) {
          value?.close?.();
          return;
        }
        const frame = value;
        const now = Date.now();
        if (now - this.#lastSent < STREAM_MS) {
          // The sidebar is not keeping up. Drop it rather than queue it.
          frame.close?.();
          this.#pump();
          return;
        }
        this.#lastSent = now;
        this.#sendFrame(frame);
        this.#pump();
      })
      .catch(() => {
        // The stream ended with the video; nothing to do.
      });
  }

  #sendFrame(frame) {
    const video = this.#video;
    try {
      this.sendAsyncMessage(
        "PipMirror:VideoFrame",
        {
          frame,
          time: (frame.timestamp ?? 0) / 1e6,
          duration: Number.isFinite(video?.duration) ? video.duration : 0,
          paused: !!video?.paused,
        },
        [frame]
      );
    } catch (err) {
      // The frame cannot travel, so this build falls back to copying pixels.
      frame.close?.();
      this.#mode = "copy";
    }
  }

  #stop() {
    const wasRunning = this.#running;
    this.#running = false;
    const reader = this.#reader;
    this.#reader = null;
    if (reader) {
      try {
        Promise.resolve(reader.cancel()).catch(() => {});
      } catch (err) {
        // The stream went with the video.
      }
    }
    this.#mode = "";
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
    if (this.#mode === "frames") {
      // The stream carries the picture while it moves. This only keeps a held
      // pause, or a seek inside one, honest.
      if (!video.paused || this.#lastStill === video.currentTime) {
        return;
      }
      this.#lastStill = video.currentTime;
      this.#copy(video);
      return;
    }
    const now = Date.now();
    if (now - this.#lastSent < FRAME_MS) {
      return;
    }
    // A held pause sends one still frame and then keeps quiet until it moves.
    if (video.paused && this.#lastStill === video.currentTime) {
      return;
    }
    this.#lastSent = now;
    this.#copy(video);
  };

  #copy(video) {
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
