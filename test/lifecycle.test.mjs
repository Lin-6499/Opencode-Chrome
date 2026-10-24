import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupEvent, consumeLifecycle } from '../opencode-plugin/lifecycle.mjs';

test('only terminal OpenCode 2 events trigger cleanup with an owner and cutoff', async () => {
  assert.equal(cleanupEvent({ type: 'session.tool.success', created: 100, data: { sessionID: 'ses_a' } }), null);
  const events = [
    { type: 'session.execution.started', created: 100, data: { sessionID: 'ses_a' } },
    { type: 'session.execution.succeeded', created: 200, data: { sessionID: 'ses_a' } },
    { type: 'session.execution.failed', created: 300, data: { sessionID: 'ses_b' } },
    { type: 'session.execution.interrupted', created: 400, data: { sessionID: 'ses_c' } },
  ];
  const called = [];
  async function* stream() { yield* events; }
  await consumeLifecycle(stream(), async (owner, endedAt) => { called.push([owner, endedAt]); return { cleaned: true }; });
  assert.deepEqual(called, [['session:ses_a', 200], ['session:ses_b', 300], ['session:ses_c', 400]]);
});
test('cleanup failures are reported without terminating future lifecycle handling', async () => {
  const reports = [];
  async function* stream() {
    yield { type: 'session.deleted', created: 100, data: { sessionID: 'ses_a' } };
    yield { type: 'session.execution.failed', created: 200, data: { sessionID: 'ses_b' } };
  }
  let calls = 0;
  await consumeLifecycle(stream(), async () => { calls++; throw new Error('offline'); }, text => reports.push(text));
  assert.equal(calls, 2);
  assert.equal(reports.length, 2);
});
