'use strict';

// Unit tests for engine.js's pure transfer logic, run with Node's built-in
// test runner — no dependencies, matching the project's zero-build-step design.
// Run with: node --test tests/

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

global.window = global.window || {};
require(path.join(__dirname, '..', 'engine.js'));
const { TransferEngine, makeSource, makeTarget, checkIntegrity } = global.window.TransferEngineLib;

function buildStore(lineCount) {
  return { source: makeSource(lineCount), target: makeTarget(), jobs: new Map() };
}

function buildEngine(store, protections, opts = {}) {
  const events = [];
  const engine = new TransferEngine(store, protections, (e) => events.push(e), () => {});
  // Tick interval is set huge so the real setInterval never fires during the
  // test — every tick is driven manually via engine._tick for determinism.
  engine.tickIntervalMs = 10_000_000;
  if (opts.chunkSize) engine.chunkSize = opts.chunkSize;
  return { engine, events };
}

function runToCompletion(engine, jobId, maxTicks = 100) {
  for (let i = 0; i < maxTicks; i++) {
    const job = engine.store.jobs.get(jobId);
    if (!job || job.status !== 'running') return;
    engine._tick(jobId);
  }
  throw new Error('job did not complete within maxTicks — possible infinite loop');
}

test('checkIntegrity: healthy when target matches source exactly', () => {
  const source = makeSource(3);
  const target = makeTarget();
  target.lines = source.lines.map((l) => ({ sourceLineId: l.id }));

  const result = checkIntegrity(source, target);
  assert.equal(result.isHealthy, true);
  assert.equal(result.duplicateCount, 0);
  assert.deepEqual(result.missingIds, []);
});

test('checkIntegrity: detects duplicates and missing lines', () => {
  const source = makeSource(3);
  const target = makeTarget();
  target.lines = [
    { sourceLineId: source.lines[0].id },
    { sourceLineId: source.lines[0].id }, // duplicate of the same source line
  ];

  const result = checkIntegrity(source, target);
  assert.equal(result.isHealthy, false);
  assert.equal(result.duplicateCount, 1);
  assert.deepEqual(result.missingIds, [source.lines[1].id, source.lines[2].id]);
});

test('dedup off: a retried request after success produces real duplicates', () => {
  const store = buildStore(6);
  const { engine } = buildEngine(store, { dedup: false, resume: true, lock: false });

  const job1 = engine.submitTransfer();
  runToCompletion(engine, job1);
  const job2 = engine.submitTransfer(); // same request, fired again
  runToCompletion(engine, job2);
  engine.destroy();

  assert.equal(store.target.lines.length, 12);
  const integrity = checkIntegrity(store.source, store.target);
  assert.equal(integrity.duplicateCount, 6);
});

test('dedup on: the identical retried request converges to the correct state', () => {
  const store = buildStore(6);
  const { engine } = buildEngine(store, { dedup: true, resume: true, lock: false });

  const job1 = engine.submitTransfer();
  runToCompletion(engine, job1);
  const job2 = engine.submitTransfer();
  runToCompletion(engine, job2);
  engine.destroy();

  const integrity = checkIntegrity(store.source, store.target);
  assert.equal(integrity.isHealthy, true);
  assert.equal(store.target.lines.length, 6);
});

test('lock on: a second submit against a running job is rejected outright', () => {
  const store = buildStore(6);
  const { engine, events } = buildEngine(store, { dedup: true, resume: true, lock: true });

  const job1 = engine.submitTransfer();
  const job2 = engine.submitTransfer(); // job1 is still running
  engine.destroy();

  assert.equal(job1 !== null, true);
  assert.equal(job2, null);
  assert.equal(store.jobs.size, 1);
  assert.ok(events.some((e) => e.type === 'rejected'));
});

test('lock off: two concurrent submits both run and produce duplicates', () => {
  const store = buildStore(6);
  const { engine } = buildEngine(store, { dedup: false, resume: true, lock: false });

  const job1 = engine.submitTransfer();
  const job2 = engine.submitTransfer();
  assert.ok(job1 && job2, 'both submits should be accepted with the lock off');

  runToCompletion(engine, job1);
  runToCompletion(engine, job2);
  engine.destroy();

  const integrity = checkIntegrity(store.source, store.target);
  assert.equal(integrity.duplicateCount, 6);
});

test('lock is released on completion, allowing a new submit against the same pair', () => {
  const store = buildStore(3);
  const { engine } = buildEngine(store, { dedup: true, resume: true, lock: true });

  const job1 = engine.submitTransfer();
  runToCompletion(engine, job1);
  const job2 = engine.submitTransfer();
  engine.destroy();

  assert.ok(job2, 'second submit should succeed once the first job has completed');
});

test('cursor resume on: crash mid-transfer then resume applies zero duplicates', () => {
  const store = buildStore(9);
  const { engine } = buildEngine(store, { dedup: false, resume: true, lock: true }, { chunkSize: 3 });

  const jobId = engine.submitTransfer();
  engine._tick(jobId); // apply first chunk (3 lines), then simulate a crash
  engine.killJob(jobId);

  const killedJob = store.jobs.get(jobId);
  assert.equal(killedJob.status, 'killed');
  assert.equal(killedJob.cursor, 3);

  engine.resumeJob(jobId);
  assert.equal(store.jobs.get(jobId).cursor, 3, 'resume-on should preserve the cursor');

  runToCompletion(engine, jobId);
  engine.destroy();

  const integrity = checkIntegrity(store.source, store.target);
  assert.equal(integrity.isHealthy, true);
});

test('cursor resume off: crash mid-transfer then resume restarts from zero and duplicates prior lines', () => {
  const store = buildStore(9);
  const { engine } = buildEngine(store, { dedup: false, resume: false, lock: true }, { chunkSize: 3 });

  const jobId = engine.submitTransfer();
  engine._tick(jobId); // apply first chunk (3 lines), then simulate a crash
  engine.killJob(jobId);

  engine.resumeJob(jobId);
  assert.equal(store.jobs.get(jobId).cursor, 0, 'resume-off should restart the cursor at zero');

  runToCompletion(engine, jobId);
  engine.destroy();

  const integrity = checkIntegrity(store.source, store.target);
  assert.equal(integrity.duplicateCount, 3, 'the 3 lines applied before the crash get re-applied');
});
