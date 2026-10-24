import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

test('iframe snapshots include frame ownership, unique refs, document binding and inaccessible frames', async () => {
  const calls = [];
  const context = vm.createContext({
    pageAgent() {}, controlOverlay() {}, setTimeout,
    chrome: {
      webNavigation: { async getAllFrames() { return [{ frameId: 0, parentFrameId: -1 }, { frameId: 5, parentFrameId: 0 }, { frameId: 6, parentFrameId: 0 }]; } },
      scripting: { async executeScript(options) {
        calls.push(options);
        const frame = options.target.frameIds?.[0] ?? 5;
        if (frame === 6) throw new Error('Browser access denied');
        return [{ frameId: frame, documentId: `doc-${frame}`, result: { title: `Frame ${frame}`, url: 'https://example.com/', text: 'Content', headings: [{ localRef: 'n1', name: 'Title' }], elements: [{ localRef: 'n2', role: 'button', name: '设置' }] } }];
      } },
    },
  });
  vm.runInContext(readFileSync(new URL('../extension/frame-driver.js', import.meta.url), 'utf8'), context);
  const first = await context.inspectFrames(1);
  assert.equal(first.frames.length, 3);
  assert.equal(first.frames[2].inaccessible, true);
  const topRef = first.frames[0].elements[0].ref;
  const childRef = first.frames[1].elements[0].ref;
  assert.notEqual(topRef, childRef);
  const target = context.resolveTarget(1, { ref: childRef });
  assert.equal(target.frameId, 5);
  assert.equal(target.documentId, 'doc-5');
  await context.targetCall(1, target, 'locate');
  assert.equal(calls.at(-1).target.documentIds[0], 'doc-5');
  await context.inspectFrames(1);
  assert.throws(() => context.resolveTarget(1, { ref: childRef }), /stale/);
});
