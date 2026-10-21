/*
 * PiP Tuck Away: the browser half of the widget mirror.
 *
 * This is the actor that sits between the page copying frames and the sidebar
 * painting them. It holds nothing of its own: every message is handed straight
 * to the controller the mod puts on the browser window, which is the half that
 * knows where the panel is and whether the mirror is still wanted.
 *
 * The controller is reached through the browsing context rather than through a
 * global, so a second browser window gets its own mirror and neither can draw
 * into the other's sidebar.
 */

export class PipMirrorParent extends JSWindowActorParent {
  receiveMessage(message) {
    const win = this.browsingContext?.topChromeWindow;
    const controller = win?.PipMirror;
    if (!controller) {
      // The mod was unloaded while a frame was in flight.
      return;
    }
    const id = this.browsingContext?.id;
    switch (message.name) {
      case "PipMirror:Started":
        controller.mirrorStarted(id, message.data ?? {}, this);
        break;
      case "PipMirror:Frame":
        controller.mirrorFrame(id, message.data);
        break;
      case "PipMirror:Rate":
        controller.mirrorRate(id, message.data ?? {});
        break;
      case "PipMirror:State":
        controller.mirrorState(id, message.data ?? {});
        break;
      case "PipMirror:Unavailable":
        controller.mirrorUnavailable(id, message.data?.reason ?? "unknown");
        break;
      case "PipMirror:Stopped":
        controller.mirrorStopped(id);
        break;
      default:
        break;
    }
  }
}
