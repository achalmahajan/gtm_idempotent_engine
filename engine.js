// Idempotent Transfer Engine — pure simulation logic, no DOM dependencies.
// A "Source" record has N lines that must be merged into a "Target" record exactly once,
// even under duplicate requests, crashes mid-transfer, and concurrent attempts.
//
// Wrapped in an IIFE so top-level declarations are function-scoped, not global —
// keeps this safe even if the script is ever injected/executed more than once on the page
// (e.g. by a browser extension that re-runs page scripts).
(function () {
let idCounter = 0;
function genId(prefix) {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function makeSource(lineCount) {
  const id = genId('SRC');
  return {
    id,
    lines: Array.from({ length: lineCount }, (_, i) => ({
      id: `${id}-L${i + 1}`,
      payload: `line item #${i + 1}`,
    })),
  };
}

function makeTarget() {
  return { id: genId('TGT'), lines: [] };
}

function checkIntegrity(source, target) {
  const expected = source.lines.length;
  const appliedIds = target.lines.map((l) => l.sourceLineId);
  const uniqueIds = new Set(appliedIds);
  const duplicateCount = appliedIds.length - uniqueIds.size;
  const missingIds = source.lines.filter((l) => !uniqueIds.has(l.id)).map((l) => l.id);
  return {
    expectedCount: expected,
    actualCount: target.lines.length,
    uniqueCount: uniqueIds.size,
    duplicateCount,
    missingIds,
    isHealthy: duplicateCount === 0 && missingIds.length === 0 && target.lines.length === expected,
  };
}

class TransferEngine {
  /**
   * @param {object} store  { source, target, jobs: Map }
   * @param {object} protections  { dedup: bool, resume: bool, lock: bool }
   * @param {function} onEvent  (event) => void, called for every log-worthy event
   * @param {function} onChange  () => void, called whenever state mutates (for re-render)
   */
  constructor(store, protections, onEvent, onChange) {
    this.store = store;
    this.protections = protections;
    this.onEvent = onEvent;
    this.onChange = onChange;
    this.locks = new Map(); // key `${sourceId}:${targetId}` -> jobId holding it
    this.timers = new Map(); // jobId -> interval handle
    this.tickIntervalMs = 550;
    this.chunkSize = 3;
  }

  _emit(type, jobId, message) {
    this.onEvent({ type, jobId, message, t: Date.now() });
  }

  _lockKey() {
    return `${this.store.source.id}:${this.store.target.id}`;
  }

  submitTransfer() {
    const lockKey = this._lockKey();
    if (this.protections.lock && this.locks.has(lockKey)) {
      const holderId = this.locks.get(lockKey);
      const holder = this.store.jobs.get(holderId);
      const holderState = holder ? holder.status : 'unknown';
      this._emit(
        'rejected',
        null,
        `Transfer request REJECTED — lock on ${lockKey} is held by ${holderId} (status: ${holderState}). ` +
          `Resume or complete it first.`
      );
      this.onChange();
      return null;
    }

    const job = {
      id: genId('JOB'),
      sourceId: this.store.source.id,
      targetId: this.store.target.id,
      lineIds: this.store.source.lines.map((l) => l.id),
      cursor: 0,
      status: 'running',
      attempt: 1,
      createdAt: Date.now(),
    };
    this.store.jobs.set(job.id, job);
    if (this.protections.lock) this.locks.set(lockKey, job.id);

    this._emit('submitted', job.id, `Job ${job.id} submitted — ${job.lineIds.length} lines to transfer.`);
    this._schedule(job);
    this.onChange();
    return job.id;
  }

  _schedule(job) {
    const timer = setInterval(() => this._tick(job.id), this.tickIntervalMs);
    this.timers.set(job.id, timer);
  }

  _tick(jobId) {
    const job = this.store.jobs.get(jobId);
    if (!job || job.status !== 'running') return;

    const chunk = job.lineIds.slice(job.cursor, job.cursor + this.chunkSize);
    if (chunk.length === 0) {
      this._complete(job);
      return;
    }

    const appliedThisChunk = [];
    const skippedThisChunk = [];
    chunk.forEach((lineId) => {
      const alreadyApplied = this.store.target.lines.some((l) => l.sourceLineId === lineId);
      if (this.protections.dedup && alreadyApplied) {
        skippedThisChunk.push(lineId);
        return;
      }
      const sourceLine = this.store.source.lines.find((l) => l.id === lineId);
      this.store.target.lines.push({
        sourceLineId: lineId,
        payload: sourceLine.payload,
        appliedByJobId: job.id,
        attempt: job.attempt,
        appliedAt: Date.now(),
      });
      appliedThisChunk.push(lineId);
    });

    job.cursor += chunk.length;

    let msg = `Job ${job.id}: cursor ${job.cursor}/${job.lineIds.length}.`;
    if (appliedThisChunk.length) msg += ` Applied [${appliedThisChunk.join(', ')}].`;
    if (skippedThisChunk.length) msg += ` Skipped (dedup) [${skippedThisChunk.join(', ')}].`;
    this._emit(skippedThisChunk.length ? 'dedup-skip' : 'chunk-applied', job.id, msg);

    this.onChange();
  }

  _complete(job) {
    clearInterval(this.timers.get(job.id));
    this.timers.delete(job.id);
    job.status = 'completed';
    const lockKey = `${job.sourceId}:${job.targetId}`;
    if (this.locks.get(lockKey) === job.id) this.locks.delete(lockKey);
    this._emit('completed', job.id, `Job ${job.id} completed. Lock released.`);
    this.onChange();
  }

  killJob(jobId) {
    const job = this.store.jobs.get(jobId);
    if (!job || job.status !== 'running') return;
    clearInterval(this.timers.get(job.id));
    this.timers.delete(job.id);
    job.status = 'killed';
    const lockKey = this._lockKeyFor(job);
    const stillLocked = this.locks.get(lockKey) === job.id;
    this._emit(
      'killed',
      job.id,
      `Job ${job.id} KILLED mid-transfer at cursor ${job.cursor}/${job.lineIds.length} (simulated crash). ` +
        (stillLocked
          ? `Its lock on ${lockKey} is still held — a crashed worker doesn't release its lease.`
          : `No lock was held for this pair (lock protection is off).`)
    );
    this.onChange();
  }

  _lockKeyFor(job) {
    return `${job.sourceId}:${job.targetId}`;
  }

  resumeJob(jobId) {
    const job = this.store.jobs.get(jobId);
    if (!job || job.status !== 'killed') return;
    const resumeFrom = this.protections.resume ? job.cursor : 0;
    job.cursor = resumeFrom;
    job.status = 'running';
    job.attempt += 1;
    this._emit(
      'resumed',
      job.id,
      `Job ${job.id} resumed (attempt ${job.attempt}) from cursor ${resumeFrom}` +
        (this.protections.resume ? ' (cursor was preserved).' : ' — RESTARTED FROM ZERO (cursor-resume is off).')
    );
    this._schedule(job);
    this.onChange();
  }

  latestJob() {
    let latest = null;
    for (const job of this.store.jobs.values()) {
      if (!latest || job.createdAt > latest.createdAt) latest = job;
    }
    return latest;
  }

  latestRunningJob() {
    let latest = null;
    for (const job of this.store.jobs.values()) {
      if (job.status === 'running' && (!latest || job.createdAt > latest.createdAt)) latest = job;
    }
    return latest;
  }

  latestKilledJob() {
    let latest = null;
    for (const job of this.store.jobs.values()) {
      if (job.status === 'killed' && (!latest || job.createdAt > latest.createdAt)) latest = job;
    }
    return latest;
  }

  destroy() {
    this.timers.forEach((t) => clearInterval(t));
    this.timers.clear();
  }
}

window.TransferEngineLib = { TransferEngine, makeSource, makeTarget, checkIntegrity, genId };
})();
