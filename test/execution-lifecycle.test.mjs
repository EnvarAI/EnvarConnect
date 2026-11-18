import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionLifecycle } from '../dist/connector/execution-lifecycle.js';

test('the durable marker precedes native dispatch and the closure cannot replay an unknown send', async () => {
  const calls = [], lifecycle = new ExecutionLifecycle(async () => {}, 30000);
  const dispatch = lifecycle.prepareDispatch(() => calls.push('persist'), async () => {
    calls.push('send'); throw new Error('Response lost');
  });
  assert.deepEqual(calls, ['persist']);
  await assert.rejects(dispatch(), /Response lost/);
  assert.throws(dispatch, /already attempted/);
  assert.deepEqual(calls, ['persist', 'send']);
  assert.throws(() => lifecycle.prepareDispatch(() => { throw new Error('Journal unavailable'); }, async () => calls.push('unsafe send')), /Journal unavailable/);
  assert.deepEqual(calls, ['persist', 'send']);
});

test('an original observation is retained while an outstanding failed lease finishes', { timeout: 2000 }, async () => {
  let releaseLease, finishObservation, leaseStarted;
  const started = new Promise(resolve => { leaseStarted = resolve; });
  const lease = new Promise((_, reject) => { releaseLease = reject; });
  const original = new Promise(resolve => { finishObservation = resolve; });
  const failures = [];
  const lifecycle = new ExecutionLifecycle(() => { leaseStarted(); return lease; }, 5, error => failures.push(error.message));
  let finished = false;
  const result = lifecycle.observe(() => original).then(value => { finished = true; return value; });
  await started;
  finishObservation('Original result'); await Promise.resolve();
  assert.equal(finished, false);
  releaseLease(new Error('Lease unavailable'));
  assert.equal(await result, 'Original result');
  assert.deepEqual(failures, ['Lease unavailable']);
});
