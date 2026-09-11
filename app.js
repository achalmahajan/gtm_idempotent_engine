// Wrapped in an IIFE so top-level declarations are function-scoped, not global —
// keeps this safe even if the script is ever injected/executed more than once on the page
// (e.g. by a browser extension that re-runs page scripts).
(function () {
if (window.__idempotentEngineAppInitialized) return;
window.__idempotentEngineAppInitialized = true;
const { TransferEngine, makeSource, makeTarget, checkIntegrity } = window.TransferEngineLib;

const els = {
  sourceId: document.getElementById('sourceId'),
  targetId: document.getElementById('targetId'),
  sourceLines: document.getElementById('sourceLines'),
  targetLines: document.getElementById('targetLines'),
  healthPill: document.getElementById('healthPill'),
  integrityGrid: document.getElementById('integrityGrid'),
  missingList: document.getElementById('missingList'),
  jobRows: document.getElementById('jobRows'),
  eventLog: document.getElementById('eventLog'),
  narration: document.getElementById('narration'),
  lineCountInput: document.getElementById('lineCountInput'),
  toggleDedup: document.getElementById('toggleDedup'),
  toggleResume: document.getElementById('toggleResume'),
  toggleLock: document.getElementById('toggleLock'),
};

let store, engine, startedAt;
let eventLog = [];
const protections = { dedup: true, resume: true, lock: true };
let scenarioRunning = false;

function initDemo(lineCount) {
  const n = Math.max(3, Math.min(60, lineCount || parseInt(els.lineCountInput.value, 10) || 12));
  els.lineCountInput.value = n;
  if (engine) engine.destroy();
  store = { source: makeSource(n), target: makeTarget(), jobs: new Map() };
  eventLog = [];
  startedAt = Date.now();
  engine = new TransferEngine(store, protections, onEvent, render);
  render();
}

function onEvent(evt) {
  eventLog.push(evt);
  if (eventLog.length > 250) eventLog.shift();
  renderLog();
}

function fmtTime(t) {
  const ms = t - startedAt;
  const s = (ms / 1000).toFixed(1);
  return `+${s}s`;
}

function render() {
  renderSource();
  renderTarget();
  renderIntegrity();
  renderJobs();
  renderLog();
}

function renderSource() {
  els.sourceId.textContent = store.source.id;
  els.sourceLines.innerHTML = store.source.lines
    .map((l) => `<div class="line-item"><span>${l.id}</span><span style="color:var(--muted)">${l.payload}</span></div>`)
    .join('');
}

function renderTarget() {
  els.targetId.textContent = store.target.id;
  if (store.target.lines.length === 0) {
    els.targetLines.innerHTML = `<div class="empty-hint">No lines transferred yet.</div>`;
    return;
  }
  const counts = {};
  store.target.lines.forEach((l) => { counts[l.sourceLineId] = (counts[l.sourceLineId] || 0) + 1; });
  els.targetLines.innerHTML = store.target.lines
    .map((l) => {
      const dup = counts[l.sourceLineId] > 1;
      return `<div class="line-item">
        <span>${l.sourceLineId}</span>
        <span>
          ${dup ? '<span class="badge badge-dup">DUP</span> ' : ''}
          <span class="badge badge-job">${l.appliedByJobId}${l.attempt > 1 ? ' #' + l.attempt : ''}</span>
        </span>
      </div>`;
    })
    .join('');
}

function renderIntegrity() {
  const r = checkIntegrity(store.source, store.target);
  const notStarted = store.jobs.size === 0;
  let pillClass, pillText;
  if (notStarted) {
    pillClass = 'neutral';
    pillText = '— awaiting transfer';
  } else if (r.isHealthy) {
    pillClass = 'ok';
    pillText = '✓ HEALTHY — target integrity preserved';
  } else {
    pillClass = 'broken';
    pillText = '✗ CORRUPTED STATE';
  }
  els.healthPill.innerHTML = `<div class="health-pill ${pillClass}">${pillText}</div>`;

  const cls = (bad) => (notStarted ? '' : bad ? 'bad' : 'good');
  els.integrityGrid.innerHTML = `
    <div class="stat"><div class="num">${r.expectedCount}</div><div class="lbl">Expected</div></div>
    <div class="stat ${cls(r.actualCount !== r.expectedCount)}"><div class="num">${r.actualCount}</div><div class="lbl">Actual lines</div></div>
    <div class="stat ${cls(r.duplicateCount > 0)}"><div class="num">${r.duplicateCount}</div><div class="lbl">Duplicates</div></div>
    <div class="stat ${cls(r.missingIds.length > 0)}"><div class="num">${r.missingIds.length}</div><div class="lbl">Missing</div></div>
  `;
  els.missingList.textContent = !notStarted && r.missingIds.length ? `Missing: ${r.missingIds.join(', ')}` : '';
}

function renderJobs() {
  const jobs = Array.from(store.jobs.values()).sort((a, b) => a.createdAt - b.createdAt);
  if (jobs.length === 0) {
    els.jobRows.innerHTML = `<div class="empty-hint">No jobs yet — click "Start transfer" or run a guided demo.</div>`;
    return;
  }
  els.jobRows.innerHTML = jobs
    .map((j) => `<div class="job-row">
      <span>${j.id}</span>
      <span style="color:var(--muted)">cursor ${j.cursor}/${j.lineIds.length}</span>
      <span class="status-chip status-${j.status}">${j.status}</span>
      <span style="color:var(--muted)">attempt ${j.attempt}</span>
    </div>`)
    .join('');
}

function renderLog() {
  els.eventLog.innerHTML = eventLog
    .slice()
    .reverse()
    .map(
      (e) => `<div class="log-entry">
        <span class="t">${fmtTime(e.t)}</span>
        <span class="tag tag-${e.type}">${e.type}</span>
        <span class="log-msg">${e.message}</span>
      </div>`
    )
    .join('');
}

function setNarration(step, html) {
  els.narration.innerHTML = `${step ? `<span class="step-tag">${step}</span>` : ''}${html}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitFor(predicate, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (predicate() || Date.now() - start > timeoutMs) return resolve();
      setTimeout(check, 100);
    };
    check();
  });
}

async function waitForAllJobsSettled() {
  await waitFor(() =>
    Array.from(store.jobs.values()).every((j) => j.status === 'completed' || j.status === 'killed')
  );
}

function setControlsEnabled(enabled) {
  document
    .querySelectorAll('.controls-panel button, .controls-panel input, .btn-row button, .setting-mini button, .setting-mini input')
    .forEach((el) => (el.disabled = !enabled));
}

function syncToggleUI() {
  els.toggleDedup.checked = protections.dedup;
  els.toggleResume.checked = protections.resume;
  els.toggleLock.checked = protections.lock;
}

// ---- manual controls ----

document.getElementById('btnSubmit').addEventListener('click', () => engine.submitTransfer());
document.getElementById('btnDuplicate').addEventListener('click', () => engine.submitTransfer());
document.getElementById('btnKill').addEventListener('click', () => {
  const job = engine.latestRunningJob();
  if (job) engine.killJob(job.id);
});
document.getElementById('btnResume').addEventListener('click', () => {
  const job = engine.latestKilledJob();
  if (job) engine.resumeJob(job.id);
});
document.getElementById('btnReset').addEventListener('click', () => {
  setNarration('', 'Demo reset. Click <b>Run guided demo</b> below for a scripted walkthrough, or use the manual controls to break things yourself.');
  initDemo(parseInt(els.lineCountInput.value, 10));
});
document.getElementById('btnRegenerate').addEventListener('click', () => initDemo(parseInt(els.lineCountInput.value, 10)));

els.toggleDedup.addEventListener('change', (e) => { protections.dedup = e.target.checked; });
els.toggleResume.addEventListener('change', (e) => { protections.resume = e.target.checked; });
els.toggleLock.addEventListener('change', (e) => { protections.lock = e.target.checked; });

// ---- guided scenarios ----

async function runScenario(name) {
  if (scenarioRunning) return;
  scenarioRunning = true;
  setControlsEnabled(false);
  try {
    if (name === 'clean') await scenarioClean();
    else if (name === 'duplicate') await scenarioDuplicate();
    else if (name === 'crash') await scenarioCrash();
    else if (name === 'race') await scenarioRace();
  } finally {
    setControlsEnabled(true);
    scenarioRunning = false;
  }
}

async function scenarioClean() {
  protections.dedup = true; protections.resume = true; protections.lock = true;
  syncToggleUI();
  initDemo(10);
  setNarration('STEP 1/1', 'Normal transfer, all protections enabled. Watch the job run to completion.');
  await sleep(400);
  engine.submitTransfer();
  await waitForAllJobsSettled();
  setNarration('DONE', 'Completed cleanly — the Integrity panel shows the target matches the source exactly, no duplicates, nothing missing.');
}

async function scenarioDuplicate() {
  protections.dedup = false; protections.resume = true; protections.lock = false;
  syncToggleUI();
  initDemo(9);
  setNarration('STEP 1/3', 'Dedup and lock both OFF. Firing the <b>same transfer request twice</b>, back-to-back...');
  await sleep(500);
  engine.submitTransfer();
  await sleep(600);
  engine.submitTransfer();
  await waitForAllJobsSettled();
  setNarration('STEP 2/3', 'Look at the Integrity panel — <b>duplicates detected</b>. Both jobs blindly applied every line with no idea the other existed.');
  await sleep(3200);

  protections.dedup = true;
  syncToggleUI();
  store.target = makeTarget();
  store.jobs = new Map();
  render();
  setNarration('STEP 3/3', 'Turning idempotency-key <b>dedup back ON</b> (lock still OFF) and repeating the exact same duplicate request...');
  await sleep(500);
  engine.submitTransfer();
  await sleep(600);
  engine.submitTransfer();
  await waitForAllJobsSettled();
  setNarration('DONE', 'Converged to the correct state even though two jobs actually ran — the idempotency key caught the overlap and skipped every already-applied line.');
}

async function scenarioCrash() {
  protections.dedup = false; protections.resume = true; protections.lock = true;
  syncToggleUI();
  initDemo(21);
  engine.tickIntervalMs = 450;
  setNarration('STEP 1/4', 'Dedup OFF (so resume has to do the work alone). Starting a large transfer, will kill it mid-flight to simulate a crashed worker...');
  await sleep(500);
  engine.submitTransfer();
  await sleep(1150);
  const running = engine.latestRunningJob();
  if (running) engine.killJob(running.id);
  await sleep(1300);
  setNarration('STEP 2/4', 'Job killed mid-transfer. Its lock is still held — a crashed worker never releases its lease. Resuming from its saved cursor...');
  const killed = engine.latestKilledJob();
  if (killed) engine.resumeJob(killed.id);
  await waitForAllJobsSettled();
  setNarration('STEP 3/4', 'Resumed cleanly with zero duplicates — even without dedup, cursor-resume alone prevented re-sending already-applied lines.');
  await sleep(3000);

  protections.resume = false;
  syncToggleUI();
  store.target = makeTarget();
  store.jobs = new Map();
  render();
  setNarration('STEP 4/4', 'Same crash, but with cursor-resume turned OFF this time...');
  await sleep(500);
  engine.submitTransfer();
  await sleep(1150);
  const running2 = engine.latestRunningJob();
  if (running2) engine.killJob(running2.id);
  await sleep(1300);
  const killed2 = engine.latestKilledJob();
  if (killed2) engine.resumeJob(killed2.id);
  await waitForAllJobsSettled();
  setNarration('DONE', 'Resume restarted from cursor 0 — every line applied before the crash got duplicated. This is the "weird state, seller has to restart the whole process" failure mode.');
}

async function scenarioRace() {
  protections.dedup = false; protections.resume = true; protections.lock = false;
  syncToggleUI();
  initDemo(12);
  setNarration('STEP 1/3', 'Lock and dedup both OFF. Firing two concurrent transfer requests almost simultaneously...');
  await sleep(500);
  engine.submitTransfer();
  await sleep(150);
  engine.submitTransfer();
  await waitForAllJobsSettled();
  setNarration('STEP 2/3', 'Both jobs ran unprotected in parallel — the target now has duplicate lines from two independent transfers that never knew about each other.');
  await sleep(3200);

  protections.lock = true;
  syncToggleUI();
  store.target = makeTarget();
  store.jobs = new Map();
  render();
  setNarration('STEP 3/3', 'Turning the source/target lock back ON and firing the same two concurrent requests...');
  await sleep(500);
  engine.submitTransfer();
  await sleep(150);
  engine.submitTransfer();
  await waitForAllJobsSettled();
  setNarration('DONE', 'The second request was rejected outright (see the event log) — with only one job ever allowed to hold the lock, there is nothing left to reconcile after the fact.');
}

document.querySelectorAll('.scenario-btn').forEach((btn) => {
  btn.addEventListener('click', () => runScenario(btn.dataset.scenario));
});

initDemo(12);
})();
