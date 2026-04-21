/* ============================================================
   Risk Grid — classroom tool
   Plain JS + Supabase (realtime, no backend).
   ============================================================ */

/* ---------- Supabase config ----------
   Publishable key is safe to ship in client code — access is governed
   by Row Level Security policies on each table. */
const SUPABASE_URL = 'https://uvopkutazobrqprnkwmm.supabase.co';
const SUPABASE_KEY = 'sb_publishable_0TZWCi6ShAQKV42bLBGWKA_sVyzA163';

// The UMD bundle exposes window.supabase (the namespace). We name our client
// instance `db` to avoid shadowing that global at the top-level const.
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

/* ---------- Constants ---------- */
const RISK_IDS = ['A', 'B', 'C'];
const TIMER_SECONDS = 60;
const DRAG_THROTTLE_MS = 150;

// Inline SVG icons for each risk. Use currentColor so fill/stroke inherits
// from the parent's `color` property (white on user-colored markers).
const ICONS = {
  // A — rain cloud
  A: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="Rain cloud">
        <path d="M16 13a4 4 0 0 0 0-8 6 6 0 0 0-11.3 2.1A4 4 0 0 0 6 15h10Z"/>
        <path d="m8 19-1 2"/><path d="m12 19-1 2"/><path d="m16 19-1 2"/>
      </svg>`,
  // B — alarm clock
  B: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="Alarm clock">
        <circle cx="12" cy="13" r="8"/>
        <path d="M12 9v4l2 2"/>
        <path d="M5 3 2 6"/><path d="m22 6-3-3"/>
        <path d="M6.38 18.7 4 21"/><path d="M17.64 18.67 20 21"/>
      </svg>`,
  // C — security badge (shield with check)
  C: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="Security badge">
        <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>
        <path d="m9 12 2 2 4-4"/>
      </svg>`,
};

/* ---------- Session + user setup ---------- */

// session_id from ?session=... or auto-generate and update URL
function getOrCreateSessionId() {
  const url = new URL(window.location.href);
  let sid = url.searchParams.get('session');
  if (!sid) {
    sid = Math.random().toString(36).slice(2, 10);
    url.searchParams.set('session', sid);
    window.history.replaceState({}, '', url);
  }
  return sid;
}

// user_id stored in localStorage so same browser keeps identity across reloads
function getOrCreateUserId() {
  let uid = localStorage.getItem('risk_grid_user_id');
  if (!uid) {
    uid = 'u_' + Math.random().toString(36).slice(2, 12);
    localStorage.setItem('risk_grid_user_id', uid);
  }
  return uid;
}

// Deterministic color per user (so same user always gets the same color)
function colorForUser(uid) {
  let hash = 0;
  for (let i = 0; i < uid.length; i++) hash = (hash * 31 + uid.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return `hsl(${hue}, 70%, 45%)`;
}

const SESSION_ID = getOrCreateSessionId();
const USER_ID    = getOrCreateUserId();
const USER_COLOR = colorForUser(USER_ID);

const params = new URLSearchParams(window.location.search);
const IS_INSTRUCTOR = params.get('role') === 'instructor';

/* ---------- App state (client-side mirror) ---------- */
const state = {
  sessionState: null,       // 'placing' | 'revealed' | null
  sessionStartTime: null,   // ISO string
  isSubmitted: false,
  myPositions: {},          // { A: {x, y}, B: ..., C: ... }
  allPositions: [],         // all users' positions (populated after reveal)
  timerInterval: null,
};

/* ---------- DOM refs ---------- */
const gridEl         = document.getElementById('grid');
const trayMarkersEl  = document.getElementById('tray-markers');
const submitBtn      = document.getElementById('btn-submit');
const timerEl        = document.getElementById('timer');
const stateLabelEl   = document.getElementById('state-label');
const sessionInfoEl  = document.getElementById('session-info');
const instructorPnl  = document.getElementById('instructor-panel');

/* ============================================================
   GRID RENDERING
   ============================================================ */

// Bucket a score (1..25) into one of 7 heat stops (matches --h1..--h7 in CSS).
function heatBucket(score) {
  if (score <= 2)  return 1;
  if (score <= 4)  return 2;
  if (score <= 6)  return 3;
  if (score <= 9)  return 4;
  if (score <= 12) return 5;
  if (score <= 16) return 6;
  return 7;
}

// Build 5x5 cells. Top row = high impact, bottom row = low impact.
function buildGridCells() {
  gridEl.innerHTML = '';
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) {
      const impact = 5 - row;      // 5..1 (top to bottom)
      const prob   = col + 1;      // 1..5 (left to right)
      const score  = impact * prob;

      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.heat = String(heatBucket(score));
      gridEl.appendChild(cell);
    }
  }
}

/* ============================================================
   MARKERS
   ============================================================ */

// Throttle helper. Fires first call immediately, queues a trailing call.
function throttle(fn, ms) {
  let lastCall = 0;
  let queued = null;
  return function(...args) {
    const now = Date.now();
    const remaining = ms - (now - lastCall);
    if (remaining <= 0) {
      lastCall = now;
      fn.apply(this, args);
    } else {
      clearTimeout(queued);
      queued = setTimeout(() => {
        lastCall = Date.now();
        fn.apply(this, args);
      }, remaining);
    }
  };
}

// Convert a normalized (0..1) position to CSS left/top inside the grid.
// Note: y=1 should appear at the TOP (high impact), so we invert.
function normToCss(x, y) {
  return { left: `${x * 100}%`, top: `${(1 - y) * 100}%` };
}

// Given a pointer event, compute normalized (x, y) inside the grid.
// Clamps into [0, 1] so markers can't escape.
function eventToNorm(ev) {
  const rect = gridEl.getBoundingClientRect();
  const px = (ev.clientX - rect.left) / rect.width;
  const py = (ev.clientY - rect.top) / rect.height;
  const x = Math.max(0, Math.min(1, px));
  const y = Math.max(0, Math.min(1, 1 - py)); // invert: top=1
  return { x, y };
}

// Create a marker DOM element for a given risk letter owned by current user.
function createMyMarker(riskId) {
  const el = document.createElement('div');
  el.className = 'marker mine';
  el.dataset.riskId = riskId;
  el.innerHTML = ICONS[riskId] || riskId;
  el.style.background = USER_COLOR;
  attachDragHandlers(el, riskId);
  return el;
}

// Create a read-only marker for another user (shown after reveal).
function createOtherMarker(riskId, userId, x, y, jitterIndex) {
  const el = document.createElement('div');
  el.className = 'marker other';
  el.dataset.riskId = riskId;
  el.innerHTML = ICONS[riskId] || riskId;
  el.style.background = colorForUser(userId);

  // Slight jitter offset for overlapping markers: small radial offset
  // indexed by jitterIndex (count of overlaps seen so far for this cell).
  const jitterPx = 6 * jitterIndex;
  const angle = (jitterIndex * 137.5) * (Math.PI / 180); // golden-angle scatter
  el.style.setProperty('--jx', `${Math.cos(angle) * jitterPx}px`);
  el.style.setProperty('--jy', `${Math.sin(angle) * jitterPx}px`);
  el.style.transform = `translate(calc(-50% + ${Math.cos(angle)*jitterPx}px), calc(-50% + ${Math.sin(angle)*jitterPx}px))`;

  const pos = normToCss(x, y);
  el.style.left = pos.left;
  el.style.top  = pos.top;
  return el;
}

// Position one of my markers, updating DOM + state + Supabase.
function placeMyMarker(riskId, x, y) {
  state.myPositions[riskId] = { x, y };
  const el = gridEl.querySelector(`.marker.mine[data-risk-id="${riskId}"]`);
  if (el) {
    const pos = normToCss(x, y);
    el.style.left = pos.left;
    el.style.top  = pos.top;
  }
}

/* ---------- Drag handling ---------- */

// Throttled save to Supabase while dragging.
// Log errors once so silent RLS failures stop being invisible.
let dragSaveWarned = false;
const saveDragPosition = throttle(async (riskId, x, y) => {
  if (state.isSubmitted || state.sessionState === 'revealed') return;
  const { error } = await db.from('risk_positions').upsert({
    session_id: SESSION_ID,
    user_id: USER_ID,
    risk_id: riskId,
    x_position: x,
    y_position: y,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'session_id,user_id,risk_id' });
  if (error && !dragSaveWarned) {
    dragSaveWarned = true;
    reportDbError('Save drag position', error);
  }
}, DRAG_THROTTLE_MS);

function attachDragHandlers(el, riskId) {
  let dragging = false;

  const onDown = (ev) => {
    if (state.isSubmitted || state.sessionState === 'revealed') return;
    dragging = true;
    el.setPointerCapture(ev.pointerId);
    ev.preventDefault();

    // On first grab from the tray, move marker into the grid so its
    // coordinate space is the grid's, not the tray's.
    if (el.parentElement !== gridEl) {
      gridEl.appendChild(el);
    }
  };

  const onMove = (ev) => {
    if (!dragging) return;
    const { x, y } = eventToNorm(ev);
    placeMyMarker(riskId, x, y);
    saveDragPosition(riskId, x, y);
  };

  const onUp = (ev) => {
    if (!dragging) return;
    dragging = false;
    el.releasePointerCapture(ev.pointerId);
    // Final write (throttle may have a pending one queued too — that's fine, upsert is idempotent)
    const p = state.myPositions[riskId];
    if (p) saveDragPosition(riskId, p.x, p.y);
    maybeEnableSubmit();
  };

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
}

// Enable submit once all 3 markers have been placed on the grid.
function maybeEnableSubmit() {
  const allPlaced = RISK_IDS.every(id => state.myPositions[id]);
  submitBtn.disabled = !(allPlaced && !state.isSubmitted && state.sessionState === 'placing');
}

/* ---------- Build initial markers in tray ---------- */
function buildTrayMarkers() {
  trayMarkersEl.innerHTML = '';
  RISK_IDS.forEach(id => {
    const slot = document.createElement('div');
    slot.className = 'tray-slot';
    const m = createMyMarker(id);
    // Position marker inside its slot (at center)
    m.style.position = 'absolute';
    m.style.left = '50%';
    m.style.top  = '50%';
    slot.appendChild(m);
    trayMarkersEl.appendChild(slot);
  });
}

/* ============================================================
   SUPABASE LOADERS
   ============================================================ */

// Fetch session state row (or null if doesn't exist yet).
async function loadSessionState() {
  const { data } = await db
    .from('session_state')
    .select('*')
    .eq('session_id', SESSION_ID)
    .maybeSingle();
  if (data) {
    state.sessionState = data.state;
    state.sessionStartTime = data.session_start_time;
  } else {
    state.sessionState = null;
    state.sessionStartTime = null;
  }
  applyStateToUI();
}

// Fetch my submission status.
async function loadMySubmission() {
  const { data } = await db
    .from('user_submissions')
    .select('*')
    .eq('session_id', SESSION_ID)
    .eq('user_id', USER_ID)
    .maybeSingle();
  state.isSubmitted = !!(data && data.is_submitted);
  applyLockState();
}

// Load positions appropriate to current phase.
// - placing: only my markers
// - revealed: all markers (mine + others)
async function loadPositions() {
  if (state.sessionState === 'revealed') {
    const { data, error } = await db
      .from('risk_positions')
      .select('*')
      .eq('session_id', SESSION_ID);
    if (error) return reportDbError('Load positions (reveal)', error);
    state.allPositions = data || [];
    console.log(`[reveal] loaded ${state.allPositions.length} positions from session ${SESSION_ID}`,
                state.allPositions);
    renderAllMarkers();
  } else {
    const { data, error } = await db
      .from('risk_positions')
      .select('*')
      .eq('session_id', SESSION_ID)
      .eq('user_id', USER_ID);
    if (error) return reportDbError('Load my positions', error);
    (data || []).forEach(row => {
      // Move marker element into grid first (not tray), then place it.
      const el = document.querySelector(`.marker.mine[data-risk-id="${row.risk_id}"]`);
      if (el && el.parentElement !== gridEl) gridEl.appendChild(el);
      placeMyMarker(row.risk_id, row.x_position, row.y_position);
    });
    maybeEnableSubmit();
  }
}

/* ============================================================
   RENDER ALL MARKERS (reveal phase)
   ============================================================ */
function renderAllMarkers() {
  // Remove existing "other" markers only; keep mine in place (they'll be refreshed below).
  gridEl.querySelectorAll('.marker.other').forEach(el => el.remove());

  // Jitter bucket: count markers per (cellX, cellY, riskId) for overlap offset
  const bucket = {};

  state.allPositions.forEach(row => {
    if (row.user_id === USER_ID) {
      // Make sure my own marker is shown at its stored spot, locked.
      placeMyMarker(row.risk_id, row.x_position, row.y_position);
      const el = gridEl.querySelector(`.marker.mine[data-risk-id="${row.risk_id}"]`);
      if (el && el.parentElement !== gridEl) gridEl.appendChild(el);
      return;
    }
    // Jitter key: snap to ~1/20 buckets so overlapping markers get offsets
    const bx = Math.round(row.x_position * 20);
    const by = Math.round(row.y_position * 20);
    const key = `${bx}_${by}_${row.risk_id}`;
    bucket[key] = (bucket[key] || 0) + 1;
    const el = createOtherMarker(row.risk_id, row.user_id, row.x_position, row.y_position, bucket[key]);
    gridEl.appendChild(el);
  });
}

/* ============================================================
   UI STATE
   ============================================================ */

function applyLockState() {
  const locked = state.isSubmitted || state.sessionState === 'revealed';
  gridEl.querySelectorAll('.marker.mine').forEach(el => {
    el.classList.toggle('locked', locked);
  });
  if (locked) submitBtn.disabled = true;
  else maybeEnableSubmit();
}

function applyStateToUI() {
  if (!state.sessionState) {
    stateLabelEl.textContent = 'Waiting for instructor';
    timerEl.textContent = '--';
  } else if (state.sessionState === 'placing') {
    stateLabelEl.textContent = 'Placing';
    startTimerLoop();
  } else if (state.sessionState === 'revealed') {
    stateLabelEl.textContent = 'Revealed';
    timerEl.textContent = '00';
    stopTimerLoop();
  }
  applyLockState();
  sessionInfoEl.textContent = `session=${SESSION_ID} · user=${USER_ID}${IS_INSTRUCTOR ? ' · instructor' : ''}`;
}

/* ============================================================
   TIMER
   ============================================================ */
function startTimerLoop() {
  stopTimerLoop();
  if (!state.sessionStartTime) {
    timerEl.textContent = '--';
    return;
  }
  const update = () => {
    const start = new Date(state.sessionStartTime).getTime();
    const elapsed = Math.floor((Date.now() - start) / 1000);
    const remaining = Math.max(0, TIMER_SECONDS - elapsed);
    timerEl.textContent = String(remaining).padStart(2, '0');
    if (remaining === 0 && state.sessionState === 'placing') {
      // Any client that sees timer hit zero triggers reveal.
      // (Idempotent: multiple clients calling this just re-set the same state.)
      revealSession();
    }
  };
  update();
  state.timerInterval = setInterval(update, 500);
}

function stopTimerLoop() {
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = null;
}

/* ============================================================
   ACTIONS
   ============================================================ */

// Called when user clicks Submit.
async function handleSubmit() {
  state.isSubmitted = true;
  applyLockState();

  await db.from('user_submissions').upsert({
    session_id: SESSION_ID,
    user_id: USER_ID,
    is_submitted: true,
    submitted_at: new Date().toISOString(),
  }, { onConflict: 'session_id,user_id' });

  await checkAllSubmittedAndReveal();
}

// If every user with any position row has also submitted, trigger reveal.
async function checkAllSubmittedAndReveal() {
  const [{ data: positions }, { data: subs }] = await Promise.all([
    db.from('risk_positions').select('user_id').eq('session_id', SESSION_ID),
    db.from('user_submissions').select('user_id,is_submitted').eq('session_id', SESSION_ID),
  ]);
  const activeUsers = new Set((positions || []).map(r => r.user_id));
  if (activeUsers.size === 0) return;
  const submittedUsers = new Set((subs || []).filter(s => s.is_submitted).map(s => s.user_id));
  const everyoneSubmitted = [...activeUsers].every(u => submittedUsers.has(u));
  if (everyoneSubmitted) await revealSession();
}

// Flip session to revealed. Idempotent.
async function revealSession() {
  if (state.sessionState === 'revealed') return;
  const { error } = await db.from('session_state').upsert({
    session_id: SESSION_ID,
    state: 'revealed',
    revealed_at: new Date().toISOString(),
  }, { onConflict: 'session_id' });
  if (error) return reportDbError('Reveal', error);

  await loadSessionState();
  await loadPositions();
}

/* ---------- Instructor actions ---------- */

// Surface DB errors to the user AND the console. Silent failures were
// previously hiding RLS / schema issues.
function reportDbError(label, error) {
  console.error(`[${label}]`, error);
  alert(`${label} failed:\n${error.message || error}\n\nCheck console + Supabase RLS policies.`);
}

async function instructorStart() {
  const { error } = await db.from('session_state').upsert({
    session_id: SESSION_ID,
    state: 'placing',
    session_start_time: new Date().toISOString(),
    revealed_at: null,
  }, { onConflict: 'session_id' });
  if (error) return reportDbError('Start Session', error);

  // Don't wait for realtime echo — refresh local state immediately.
  await loadSessionState();
}

async function instructorReset() {
  if (!confirm('Reset session? All positions and submissions will be cleared.')) return;
  const results = await Promise.all([
    db.from('risk_positions').delete().eq('session_id', SESSION_ID),
    db.from('user_submissions').delete().eq('session_id', SESSION_ID),
    db.from('session_state').delete().eq('session_id', SESSION_ID),
  ]);
  const err = results.find(r => r.error)?.error;
  if (err) return reportDbError('Reset Session', err);

  // Local reset
  state.myPositions = {};
  state.allPositions = [];
  state.isSubmitted = false;
  state.sessionState = null;
  state.sessionStartTime = null;
  gridEl.querySelectorAll('.marker').forEach(el => el.remove());
  buildTrayMarkers();
  applyStateToUI();
}

function setupInstructorPanel() {
  if (!IS_INSTRUCTOR) return;
  instructorPnl.classList.remove('hidden');
  document.getElementById('btn-start').addEventListener('click', instructorStart);
  document.getElementById('btn-reveal').addEventListener('click', revealSession);
  document.getElementById('btn-reset').addEventListener('click', instructorReset);
}

/* ============================================================
   REALTIME SUBSCRIPTIONS
   ============================================================ */

function subscribeRealtime() {
  // Session state changes (start / reveal / reset)
  db.channel(`session_state:${SESSION_ID}`)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'session_state',
      filter: `session_id=eq.${SESSION_ID}`,
    }, async () => {
      await loadSessionState();
      await loadPositions();
    })
    .subscribe();

  // Position changes — during placing, we only care about our own;
  // during revealed, we need everyone's.
  db.channel(`risk_positions:${SESSION_ID}`)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'risk_positions',
      filter: `session_id=eq.${SESSION_ID}`,
    }, async (payload) => {
      if (state.sessionState === 'revealed') {
        await loadPositions();
      }
      // In placing phase we ignore others' updates; they'll only appear on reveal.
    })
    .subscribe();

  // Submissions — used to auto-reveal when all users submit.
  db.channel(`user_submissions:${SESSION_ID}`)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'user_submissions',
      filter: `session_id=eq.${SESSION_ID}`,
    }, async () => {
      await checkAllSubmittedAndReveal();
    })
    .subscribe();
}

/* ============================================================
   INIT
   ============================================================ */
async function init() {
  buildGridCells();
  buildTrayMarkers();
  setupInstructorPanel();

  submitBtn.addEventListener('click', handleSubmit);

  await loadSessionState();
  await loadMySubmission();
  await loadPositions();

  subscribeRealtime();
}

init();
