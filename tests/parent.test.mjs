// Verify routing and frame acknowledgements across the real parent actor code.
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const source = fs.readFileSync(process.argv[2] ?? "scripts/pip-mirror-parent.sys.mjs", "utf8")
  .replace("export class PipMirrorParent", "globalThis.PipMirrorParent = class PipMirrorParent");
const sandbox = vm.createContext({ JSWindowActorParent: class {} });
vm.runInContext(source, sandbox);
const actor = new sandbox.PipMirrorParent();
const calls = [];
const messages = [];
actor.sendAsyncMessage = (name, data) => messages.push({ name, data });
actor.browsingContext = {
  id: 12,
  topChromeWindow: { PipMirror: {
    mirrorFrame: (...args) => calls.push(args),
    mirrorStarted: (...args) => calls.push(args),
  } },
};

const frame = { session: 7, buf: new ArrayBuffer(16), width: 2, height: 2 };
actor.receiveMessage({ name: "PipMirror:Frame", data: frame });
assert.equal(calls[0][0], 12);
assert.equal(calls[0][1], frame);
assert.equal(messages[0].name, "PipMirror:FrameAck");
assert.equal(messages[0].data.session, 7);
actor.browsingContext.topChromeWindow.PipMirror.mirrorFrame = () => { throw new Error("paint failed"); };
assert.throws(() => actor.receiveMessage({ name: "PipMirror:Frame", data: frame }), /paint failed/);
assert.equal(messages.length, 2, "a failed paint still releases the frame buffer");
actor.receiveMessage({ name: "PipMirror:Started", data: { paused: true } });
assert.equal(calls.at(-1)[2], actor);
actor.browsingContext.topChromeWindow.PipMirror = null;
assert.doesNotThrow(() => actor.receiveMessage({ name: "PipMirror:Frame", data: frame }));
assert.equal(messages.at(-1).name, "PipMirror:Stop", "a controllerless actor stops background copying");
console.log("9/9 parent actor assertions passed");
