/* Ice Fishing Tournament Tracker – Supabase client
 * - Staff sign in with Supabase Auth; roles come from public.staff_roles.
 * - Gate / weigh writes go through an offline queue (localStorage) with client UUIDs.
 * - Staff stations get live updates via Supabase Realtime.
 * - Public viewers and the big screen poll the get_leaderboard RPC (small payload, version-aware).
 */
'use strict';

const CFG = window.IFT_CONFIG;
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
});

const ROLE_LABEL = { admin: 'Admin 🔒', gate: 'Gate / Registration', weigh: 'Weigh Station', screen: 'Big Screen' };
const ROLE_TABS = {
  admin: ['setup', 'participants', 'weighin', 'leaderboard', 'display'],
  gate: ['participants', 'leaderboard', 'display'],
  weigh: ['weighin', 'leaderboard', 'display'],
  screen: ['display', 'leaderboard'],
  public: ['leaderboard', 'display']
};
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('localStorage full?', e); } },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};

const S = {
  session: null, user: null, roles: [], role: 'public',
  tournaments: [], tid: null, t: null,
  species: [], configs: [], participants: [], catches: [],
  online: navigator.onLine, channel: null, rtDown: false,
  currentParticipant: null, tab: null,
  board: { data: null, version: null, tid: null, timer: null, at: null },
  displayIdx: 0, displayTimer: null
};
const params = new URLSearchParams(location.search); // as loaded; use urlParam() for the live URL
const SCREEN_MODE = params.get('screen') === '1';
// Public leaderboard page (leaderboard only, no staff app): ?t=<id>&view=leaderboard, plus older shared links
// (?t=<id> on its own, or a #board=… hash). The full staff app keeps its screen in ?tab= instead.
const BOARD_MODE = !SCREEN_MODE && !params.has('tab') && (params.get('view') === 'leaderboard'
  || (params.has('t') && !params.has('view')) || (!params.has('view') && /(^#|&)board=/.test(location.hash)));
const KIOSK = SCREEN_MODE || BOARD_MODE; // read-only public pages: never load staff data or show staff controls
const TAB_NAMES = ['setup', 'participants', 'weighin', 'leaderboard', 'display'];
function urlParam(k) { return new URLSearchParams(location.search).get(k); }
// The staff-app screen named in the URL (?tab=…; older full-app URLs used ?view=…).
function linkedView() {
  const v = urlParam('tab') || urlParam('view');
  if (TAB_NAMES.includes(v)) return v;
  return /(^#|&)board=/.test(location.hash) ? 'leaderboard' : null;
}
// Keep the tournament and screen in the address bar, so reloads and copied links land on the same screen.
function syncUrl() {
  const q = new URLSearchParams(location.search);
  if (S.tid) q.set('t', S.tid);
  if (BOARD_MODE) q.set('view', 'leaderboard');
  else if (S.tab && !SCREEN_MODE) { q.delete('view'); q.set('tab', S.tab); }
  const hash = S.tab === 'leaderboard' || KIOSK ? location.hash : '';
  const url = location.pathname + (q.toString() ? '?' + q.toString() : '') + hash;
  if (url !== location.pathname + location.search + location.hash) history.replaceState(null, '', url);
}

// ---------------------------------------------------------------- utils
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function $(id) { return document.getElementById(id); }
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
async function hashUuid(text) { // deterministic UUID so re-imports are idempotent
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).slice(0, 16);
  d[6] = (d[6] & 0x0f) | 0x50; d[8] = (d[8] & 0x3f) | 0x80;
  const h = [...d].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function formatLbs(lbs) { return `${(Number(lbs) || 0).toFixed(2)} lbs`; }
function round2(n) { return Math.round(Number(n) * 100) / 100; }
function msg(id, text, ok = true) { const el = $(id); if (!el) return; el.textContent = text; el.className = (el.className.replace(/text-(red|green)-\d+/g, '') + (ok ? ' text-green-700' : ' text-red-600')).trim(); }
function closeModal(id) { $(id)?.classList.add('hidden'); }
function openModal(id) { $(id)?.classList.remove('hidden'); }
function canReadData() { return S.roles.some(r => ['admin', 'gate', 'weigh'].includes(r)); }
// Admin accounts always have gate/weigh/screen rights; admin-only rights need Admin mode (PIN-unlocked).
function hasRole(r) {
  if (r === 'admin') return S.roles.includes('admin') && S.role === 'admin';
  return S.roles.includes('admin') || S.roles.includes(r);
}
function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur.trim()); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur.trim()); cur = '';
      if (row.some(x => x !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur.trim()); if (row.some(x => x !== '')) rows.push(row);
  return rows;
}
function toCSV(rows) {
  return rows.map(r => r.map(v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\r\n');
}
function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function slug(s) { return String(s || 'tournament').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function normCode(year, raw) {
  raw = String(raw || '').trim();
  if (raw.includes('_')) { const [y, n] = raw.split('_'); year = y; raw = n || ''; }
  raw = raw.replace(/\D/g, '');
  if (!year || !raw || Number(raw) === 0) return null;
  return `${year}_${raw.padStart(5, '0')}`;
}
function isNetErr(e) { return !!e && !e.code && /fetch|network|load failed|timeout|offline/i.test(e.message || String(e)); }
function isAuthErr(e) { return !!e && (e.code === 'PGRST301' || e.code === 'PGRST303' || /jwt/i.test(e.message || '')); }

// ---------------------------------------------------------------- online / queue
let Q = upgradeOps(LS.get('ift.queue', []));
let FAILED = upgradeOps(LS.get('ift.failed', []));
// Changes queued by an older version of the app (ounces, length, initials, check-in) are converted or dropped.
function upgradeOps(ops) {
  const out = [];
  for (const op of ops || []) {
    const strip = o => { if (!o) return o; delete o.length_in; delete o.staff_initials; delete o.check_in_status; delete o.checked_in_at; delete o.checked_in_by; return o; };
    if (op.table === 'catches' && op.kind === 'insert' && op.row && op.row.weight_oz != null && op.row.weight_lbs == null) {
      op.row.weight_lbs = Math.max(0.01, round2(op.row.weight_oz / 16)); delete op.row.weight_oz;
    }
    strip(op.row); strip(op.patch);
    if (op.kind === 'update' && (!op.patch || !Object.keys(op.patch).length)) continue; // check-in only update
    out.push(op);
  }
  return out;
}
let flushing = false;
function saveQueue() { LS.set('ift.queue', Q); LS.set('ift.failed', FAILED); renderConn(); }

function setOnline(v) { if (S.online !== v) { S.online = v; renderConn(); if (v) { flushQueue(); if (S.tid && canReadData()) loadTournamentData(); } } }
window.addEventListener('online', () => setOnline(true));
window.addEventListener('offline', () => setOnline(false));

function renderConn() {
  const on = S.online;
  $('netDot').className = 'w-2 h-2 rounded-full ' + (on ? 'bg-green-500' : 'bg-red-500');
  $('netText').textContent = on ? 'Online' : 'Offline – changes are saved on this device';
  $('netStatus').className = 'inline-flex items-center gap-1 px-2 py-1 rounded-full ' + (on ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800');
  const pb = $('pendingBadge'), fb = $('failedBadge');
  pb.classList.toggle('hidden', !Q.length);
  pb.textContent = `${Q.length} waiting to sync` + (!S.session && Q.length ? ' (sign in)' : '');
  fb.classList.toggle('hidden', !FAILED.length);
  fb.textContent = `${FAILED.length} failed`;
}

function enqueue(op) {
  op.qid = uuid(); op.ts = Date.now(); op.tid = op.tid || S.tid;
  Q.push(op); saveQueue();
  applyLocal(op, true);
  flushQueue();
}

function applyLocal(op, pending) {
  if (op.tid !== S.tid) return;
  const arr = op.table === 'participants' ? S.participants : S.catches;
  if (op.kind === 'insert') {
    const i = arr.findIndex(x => x.id === op.row.id);
    const row = { ...op.row, _pending: pending };
    if (i >= 0) { if (arr[i]._pending || pending) arr[i] = { ...arr[i], ...row }; } else arr.push(row);
  } else if (op.kind === 'update') {
    const r = arr.find(x => x.id === op.id);
    if (r) Object.assign(r, op.patch, pending ? { _pending: true } : {});
  }
  saveCache(); refreshViews();
}

async function flushQueue(manual) {
  if (flushing) return;
  if (!S.session) { renderConn(); return; }
  flushing = true;
  let authRetry = 0;
  try {
    while (Q.length) {
      const op = Q[0];
      let res;
      try {
        if (op.kind === 'insert') {
          res = await sb.from(op.table).upsert(op.row, { onConflict: 'id', ignoreDuplicates: true });
        } else {
          res = await sb.from(op.table).update(op.patch).eq('id', op.id).select('id');
          if (!res.error && (!res.data || !res.data.length)) res = { error: { code: 'NOROWS', message: 'Not permitted, or the row does not exist' } };
        }
      } catch (e) { res = { error: { message: String(e) } }; }
      const e = res.error;
      if (!e) {
        Q.shift(); saveQueue();
        markSynced(op);
        if (!S.online) setOnline(true);
        continue;
      }
      if (isNetErr(e)) { setOnline(false); break; }
      if (isAuthErr(e) && authRetry++ < 1) { await sb.auth.refreshSession(); continue; }
      op.error = e.message || String(e); op.failedAt = Date.now();
      FAILED.push(op); Q.shift(); saveQueue();
      markSynced(op, true);
    }
  } finally { flushing = false; renderConn(); if (manual) renderQueue(); }
}

function markSynced(op, failed) {
  if (op.tid !== S.tid) return;
  const arr = op.table === 'participants' ? S.participants : S.catches;
  const id = op.kind === 'insert' ? op.row.id : op.id;
  const r = arr.find(x => x.id === id);
  if (r) { if (failed) r._failed = true; if (!Q.some(q => (q.row?.id || q.id) === id)) delete r._pending; }
  saveCache(); refreshViews();
}

function openQueue() { renderQueue(); openModal('queueModal'); }
function describeOp(op) {
  if (op.table === 'participants' && op.kind === 'insert') return `New participant: ${op.row.display_name} ${op.row.participant_code || '(number pending)'}`;
  if (op.table === 'participants') return `Participant update (${Object.keys(op.patch).join(', ')})`;
  if (op.kind === 'insert') return `Weigh-in: ${formatLbs(op.row.weight_lbs)}`;
  const c = S.catches.find(x => x.id === op.id);
  return `Ticket ${c ? ticketLabel(c) : ''} ${op.patch.status === 'voided' ? 'void' : op.patch.status === 'active' ? 'restore' : 'edit'} (${Object.keys(op.patch).join(', ')})`;
}
function renderQueue() {
  const el = $('queueContent');
  const item = (op, f) => `<div class="border rounded p-2 ${f ? 'bg-red-50' : ''}">${esc(describeOp(op))}<div class="text-xs text-slate-500">${new Date(op.ts).toLocaleTimeString()}${f ? ' – ' + esc(op.error) : ''}</div></div>`;
  el.innerHTML = (Q.length ? `<div class="font-medium">Waiting (${Q.length})</div>` + Q.map(o => item(o)).join('') : '<div class="text-slate-500">Nothing waiting to sync.</div>')
    + (FAILED.length ? `<div class="font-medium mt-3">Failed (${FAILED.length})</div>` + FAILED.map(o => item(o, true)).join('') : '');
}
function retryFailed() { Q.push(...FAILED.map(o => { delete o.error; return o; })); FAILED = []; saveQueue(); flushQueue(true); }
function discardFailed() { if (!FAILED.length || !confirm('Discard failed changes? They will not be saved.')) return; FAILED = []; saveQueue(); renderQueue(); if (S.tid && canReadData()) loadTournamentData(); }

setInterval(() => { if (Q.length) flushQueue(); }, 15000);

// ---------------------------------------------------------------- auth
function openSignIn() { $('siMsg').textContent = ''; openModal('signInModal'); $('siEmail').focus(); }
async function signIn() {
  const email = $('siEmail').value.trim(), password = $('siPassword').value;
  if (!email || !password) return;
  $('siMsg').textContent = 'Signing in…';
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) { $('siMsg').textContent = error.message; return; }
  $('siPassword').value = '';
  closeModal('signInModal');
}
async function signOut() {
  if (Q.length && !confirm(`${Q.length} change(s) have not synced yet. They stay on this device and sync after the next sign-in. Sign out anyway?`)) return;
  if (S.role === 'admin') { try { await sb.rpc('lock_admin'); } catch (e) {} }
  clearAdminLocal();
  await sb.auth.signOut();
}
async function onSession(session) {
  S.session = session; S.user = session?.user || null;
  if (S.user && !KIOSK) {
    const { data, error } = await sb.from('staff_roles').select('role, display_name').eq('user_id', S.user.id);
    if (!error) { S.roles = data.map(r => r.role); LS.set('ift.roles.' + S.user.id, S.roles); }
    else S.roles = LS.get('ift.roles.' + S.user.id, []);
  } else S.roles = [];
  await renderAuth();
  await loadTournamentList();
  if (S.session && !KIOSK) flushQueue();
}
async function renderAuth() {
  const signedIn = !!S.user;
  $('signInBtn').classList.toggle('hidden', signedIn || KIOSK);
  $('signOutBtn').classList.toggle('hidden', !signedIn);
  $('userBadge').textContent = signedIn ? S.user.email + (S.roles.length ? '' : ' (no staff role yet)') : '';
  const rs = $('roleSelect');
  const roles = S.roles.includes('admin') ? ['admin', 'gate', 'weigh', 'screen'] : S.roles;
  rs.innerHTML = roles.map(r => `<option value="${r}">${ROLE_LABEL[r]}</option>`).join('');
  rs.classList.toggle('hidden', !roles.length);
  const saved = LS.get('ift.stationRole', null);
  let role = roles.includes(saved) ? saved : (roles[0] || 'public');
  // Admin mode survives a reload only while this sign-in's PIN unlock is still valid.
  if (role === 'admin' && !(await adminStillUnlocked())) role = firstWorkerRole(roles);
  if (roles.length) rs.value = role;
  // First render after page load: honour a shared link (?view=leaderboard / #board=…) if this mode can show it.
  // After a real sign-in/out, go to the new mode's home screen.
  const want = S.booted ? null : linkedView();
  S.booted = true;
  applyRole(role, true, want);
}
// Switching mode always opens that mode's home screen (every mode has the Leaderboard tab, so "keep the
// current tab" made the mode picker look like it did nothing).
function applyRole(role, silent, wantTab) {
  S.role = role || 'public';
  if (S.role === 'admin') startAdminWatch(); else stopAdminWatch();
  if ($('roleSelect').value !== S.role && [...$('roleSelect').options].some(o => o.value === S.role)) $('roleSelect').value = S.role;
  if (!silent && role !== 'public') LS.set('ift.stationRole', role);
  const allowed = ROLE_TABS[S.role] || ROLE_TABS.public;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('hidden', !allowed.includes(b.dataset.tab)));
  if (SCREEN_MODE) return showTab('display');
  if (BOARD_MODE) return showTab('leaderboard');
  showTab(allowed.includes(wantTab) ? wantTab : allowed[0]);
}

// ---- Admin PIN: switching INTO Admin mode needs the PIN (checked by the server, which then unlocks admin-only
// actions for this sign-in for up to 30 min, kept alive while in use). Leaving Admin mode or going idle locks it.
const ADMIN_IDLE_MIN = 10;
function firstWorkerRole(roles) { return roles.find(r => r !== 'admin') || 'public'; }
function adminKey() { return 'ift.adminUntil.' + (S.user?.id || ''); }
function clearAdminLocal() { LS.del(adminKey()); }
async function adminStillUnlocked() {
  if (!S.session) return false;
  if (!S.online) return LS.get(adminKey(), 0) > Date.now(); // offline reload: trust the last server answer until it expires
  const { data, error } = await sb.rpc('admin_unlock_status', { p_extend: false });
  if (error) return isNetErr(error) ? LS.get(adminKey(), 0) > Date.now() : false;
  if (data?.unlocked) LS.set(adminKey(), Date.parse(data.unlocked_until)); else clearAdminLocal();
  return !!data?.unlocked;
}
function requestRole(role) {
  if (role === S.role) return;
  if (role === 'admin') { $('roleSelect').value = S.role; return openAdminPin(); }
  if (S.role === 'admin') lockAdmin();
  applyRole(role);
}
function openAdminPin() {
  $('pinInput').value = ''; $('pinMsg').textContent = ''; $('pinGo').disabled = false;
  openModal('pinModal'); setTimeout(() => $('pinInput').focus(), 0);
}
function closeAdminPin() { closeModal('pinModal'); }
async function submitAdminPin() {
  const pin = $('pinInput').value.trim(); if (!pin) return;
  if (!S.online) return msg('pinMsg', 'Admin mode needs an internet connection to check the PIN.', false);
  $('pinGo').disabled = true; $('pinMsg').className = 'mt-2 text-sm'; $('pinMsg').textContent = 'Checking…';
  const { data, error } = await sb.rpc('verify_admin_pin', { p_pin: pin });
  $('pinGo').disabled = false; $('pinInput').value = '';
  if (error) return msg('pinMsg', isNetErr(error) ? 'Admin mode needs an internet connection to check the PIN.' : error.message, false);
  if (data?.ok) {
    LS.set(adminKey(), Date.parse(data.unlocked_until)); closeAdminPin();
    $('roleMsg').textContent = '';
    applyRole('admin');
    return;
  }
  const until = data?.locked_until ? new Date(data.locked_until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const text = {
    wrong: `Wrong PIN. ${data.remaining} ${data.remaining === 1 ? 'try' : 'tries'} left before a 5-minute lockout.`,
    locked: `Too many wrong PINs. Try again after ${until}.`,
    no_pin: 'No admin PIN is set yet. Set it in Supabase: Table Editor → app_settings → admin_pin.',
    not_admin: 'This account is not an admin.',
    no_session: 'Please sign out and sign in again.'
  }[data?.reason] || 'Could not unlock admin mode.';
  msg('pinMsg', text, false);
  $('pinInput').focus();
}
function lockAdmin(reason) {
  clearAdminLocal();
  if (S.session) sb.rpc('lock_admin').then(() => {}, () => {});
  if (reason) $('roleMsg').textContent = reason;
}
function dropToWorkerMode(reason) {
  if (S.role !== 'admin') return;
  lockAdmin(reason);
  const roles = S.roles.includes('admin') ? ['admin', 'gate', 'weigh', 'screen'] : S.roles;
  applyRole(firstWorkerRole(roles));
}
let adminTimer = null, lastActivity = Date.now(), lastKeepAlive = 0;
['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(ev => document.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true, capture: true }));
function startAdminWatch() {
  lastActivity = Date.now(); lastKeepAlive = Date.now();
  if (adminTimer) return;
  adminTimer = setInterval(checkAdminWatch, 30000);
}
function stopAdminWatch() { clearInterval(adminTimer); adminTimer = null; }
async function checkAdminWatch() {
  if (S.role !== 'admin') return stopAdminWatch();
  if (Date.now() - lastActivity > ADMIN_IDLE_MIN * 60000) return dropToWorkerMode(`Admin mode locked after ${ADMIN_IDLE_MIN} minutes without activity.`);
  if (Date.now() > LS.get(adminKey(), 0) && !S.online) return dropToWorkerMode('Admin mode expired.');
  if (S.online && Date.now() - lastKeepAlive > 4 * 60000) {
    lastKeepAlive = Date.now();
    const { data, error } = await sb.rpc('admin_unlock_status', { p_extend: true });
    if (!error && data) {
      if (data.unlocked) LS.set(adminKey(), Date.parse(data.unlocked_until));
      else dropToWorkerMode('Admin mode expired – enter the PIN again.');
    }
  }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.role === 'admin') { if (Date.now() - lastActivity > ADMIN_IDLE_MIN * 60000) dropToWorkerMode(`Admin mode locked after ${ADMIN_IDLE_MIN} minutes without activity.`); else checkAdminWatch(); } });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('pinModal').classList.contains('hidden')) closeAdminPin(); });

// ---------------------------------------------------------------- tournaments
async function loadTournamentList() {
  let list = [];
  if (S.roles.length) {
    const { data, error } = await sb.from('tournaments').select('id, name, year, status, public_visible').order('year', { ascending: false }).order('created_at', { ascending: false });
    if (!error) { list = data; LS.set('ift.tournaments', list); } else list = LS.get('ift.tournaments', []);
  } else {
    const { data, error } = await sb.rpc('list_public_tournaments');
    list = error ? LS.get('ift.publicTournaments', []) : data;
    if (!error) LS.set('ift.publicTournaments', list);
  }
  S.tournaments = list || [];
  const sel = $('tournamentSelect');
  sel.innerHTML = S.tournaments.length
    ? S.tournaments.map(t => `<option value="${t.id}">${esc(t.name)} (${t.year})${t.status === 'active' ? ' • live' : ''}</option>`).join('')
    : '<option value="">No tournaments yet</option>';
  // Keep the tournament already on screen (e.g. across sign-in), else the link's ?t=, else the last one picked here.
  const byId = id => id && S.tournaments.find(t => t.id === id);
  // A public page for a specific tournament never falls back to a different one: it shows "not available" instead.
  if (KIOSK && urlParam('t')) return selectTournament(urlParam('t'));
  const pick = byId(S.tid) || byId(urlParam('t')) || byId(LS.get('ift.tid', null))
    || S.tournaments.find(t => t.status === 'active') || S.tournaments[0];
  await selectTournament(pick ? pick.id : null);
}

async function selectTournament(tid) {
  S.tid = tid || null;
  $('tournamentSelect').value = S.tid || '';
  if (S.tid && !KIOSK) LS.set('ift.tid', S.tid); // a public link shouldn't change this laptop's remembered tournament
  syncUrl();
  S.board = { data: null, version: null, tid: S.tid, timer: S.board.timer, at: null, gen: S.board.gen };
  S.t = null; S.species = []; S.configs = []; S.participants = []; S.catches = [];
  if (S.tid && S.roles.length) {
    loadCache();
    await loadTournamentData();
    subscribeRealtime();
  } else {
    unsubscribeRealtime();
  }
  fillSetupForm(); refreshViews(); restartPolling();
}

function cacheKey() { return 'ift.cache2.' + S.tid; } // v2: decimal lbs, no check-in
function saveCache() {
  if (!S.tid || !S.t) return;
  LS.set(cacheKey(), { t: S.t, species: S.species, configs: S.configs,
    participants: S.participants.map(p => ({ ...p, _pending: undefined })), catches: S.catches.map(c => ({ ...c, _pending: undefined })), at: Date.now() });
}
function loadCache() {
  const c = LS.get(cacheKey(), null);
  if (!c) return;
  Object.assign(S, { t: c.t, species: c.species || [], configs: c.configs || [], participants: c.participants || [], catches: c.catches || [] });
  Q.filter(op => op.tid === S.tid).forEach(op => applyLocal(op, true));
}

async function fetchAll(table, tid) {
  const out = []; const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await sb.from(table).select('*').eq('tournament_id', tid).order('created_at').range(from, from + size - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < size) return out;
  }
}

async function loadTournamentData() {
  const tid = S.tid; if (!tid) return;
  try {
    const [t, sp, cf] = await Promise.all([
      sb.from('tournaments').select('*').eq('id', tid).maybeSingle(),
      sb.from('species').select('*').eq('tournament_id', tid).order('sort_order').order('name'),
      sb.from('leaderboard_configs').select('*').eq('tournament_id', tid).order('sort_order').order('created_at')
    ]);
    if (!t.error && !t.data) { if (tid === S.tid) await forgetTournament(tid, true); return; } // deleted elsewhere
    for (const r of [t, sp, cf]) if (r.error) throw r.error;
    let parts = [], catches = [];
    if (canReadData()) [parts, catches] = await Promise.all([fetchAll('participants', tid), fetchAll('catches', tid)]);
    if (tid !== S.tid) return;
    Object.assign(S, { t: t.data, species: sp.data, configs: cf.data, participants: parts, catches });
    Q.filter(op => op.tid === tid).forEach(op => applyLocal(op, true));
    saveCache(); setOnline(true);
    ensureCodePool();
  } catch (e) {
    if (isNetErr(e)) setOnline(false); else console.warn('Load failed:', e.message || e);
  }
  refreshViews();
}

// ---------------------------------------------------------------- realtime (staff only)
function unsubscribeRealtime() { if (S.channel) { sb.removeChannel(S.channel); S.channel = null; } $('liveStatus').textContent = ''; }
function subscribeRealtime() {
  unsubscribeRealtime();
  if (!S.tid || !canReadData() || !S.session) return;
  const tid = S.tid;
  const handler = table => payload => {
    if (tid !== S.tid) return;
    const arr = table === 'participants' ? S.participants : S.catches;
    if (payload.eventType === 'DELETE') {
      const i = arr.findIndex(x => x.id === payload.old.id); if (i >= 0) arr.splice(i, 1);
    } else {
      const row = payload.new; const i = arr.findIndex(x => x.id === row.id);
      const stillPending = Q.some(q => (q.row?.id || q.id) === row.id);
      if (i >= 0) arr[i] = { ...arr[i], ...row, _pending: stillPending || undefined }; else arr.push(row);
    }
    saveCache(); refreshViews();
  };
  S.channel = sb.channel('t-' + tid)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'catches', filter: 'tournament_id=eq.' + tid }, handler('catches'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'participants', filter: 'tournament_id=eq.' + tid }, handler('participants'))
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'tournaments' }, payload => { if (payload.old?.id) forgetTournament(payload.old.id); })
    .subscribe(status => {
      if (status === 'SUBSCRIBED') {
        $('liveStatus').textContent = '● Live updates on';
        if (S.rtDown) { S.rtDown = false; loadTournamentData(); } // catch up on anything missed
      } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
        S.rtDown = true; $('liveStatus').textContent = '○ Live updates reconnecting…';
      }
    });
}

// ---------------------------------------------------------------- tabs
function showTab(name) {
  S.tab = name;
  syncUrl();
  document.querySelectorAll('.tab').forEach(t => t.classList.add('hidden'));
  $('tab-' + name)?.classList.remove('hidden');
  document.querySelectorAll('.tab-btn').forEach(b => {
    const on = b.dataset.tab === name;
    b.classList.toggle('bg-blue-600', on); b.classList.toggle('text-white', on);
    b.classList.toggle('rounded-t', on); b.classList.toggle('text-slate-600', !on);
  });
  if (name !== 'display') { clearInterval(S.displayTimer); S.displayTimer = null; }
  refreshViews(); restartPolling();
  if (name === 'participants') $('checkNum').focus();
  if (name === 'weighin') $('scanNum').focus();
  if (name === 'display') startDisplay();
}
function refreshViews() {
  const y = S.t?.year || '';
  $('checkYear').value = y; $('scanYear').value = y;
  populateSelects();
  if (S.tab === 'participants') renderParticipants();
  if (S.tab === 'weighin') renderRecentCatches();
  if (S.tab === 'leaderboard') renderLeaderboard();
  if (S.tab === 'setup') renderConfigs();
  if (S.tab === 'display' && !S.displayTimer) startDisplay();
}

// ---------------------------------------------------------------- setup (admin)
function newTournamentForm() {
  S.editingNew = true;
  $('setupTitle').textContent = 'New Tournament';
  $('tName').value = ''; $('tYear').value = new Date().getFullYear(); $('tDate').value = '';
  $('tStatus').value = 'setup'; $('tPublic').checked = true;
  renderDivisionRows([{ name: 'Youth', min: null, max: 17 }, { name: 'Adult', min: 18, max: 64 }, { name: 'Senior', min: 65, max: null }]);
  $('speciesList').value = 'Walleye, Perch, Pike, Crappie';
  $('setupMsg').textContent = ''; $('publicLinks').innerHTML = '';
  $('dangerZone').classList.add('hidden');
}
// ---- Age/Division ranges
// Ordered divisions for a tournament: [{name, min, max, suggested}]
function divisionsOf(t, suggest) {
  const names = t?.age_groups || [], ranges = t?.age_group_ranges || {};
  const list = names.map(n => ({ name: n, min: ranges[n]?.min ?? null, max: ranges[n]?.max ?? null, suggested: false }));
  if (suggest && !Object.keys(ranges).length) suggestRanges(list);
  return list;
}
// Guess ranges from names like "13 & Under", "14-18", "65+", "U12", "Adult" (only used when none are saved yet).
function suggestRanges(list) {
  for (const d of list) {
    const n = d.name.toLowerCase(); let m;
    if ((m = n.match(/(\d+)\s*(?:-|–|to)\s*(\d+)/))) { d.min = +m[1]; d.max = +m[2]; }
    else if ((m = n.match(/(\d+)\s*(?:&|and)?\s*(?:under|younger|below)/)) || (m = n.match(/(?:under|u)\s*(\d+)/))) d.max = +m[1];
    else if ((m = n.match(/(\d+)\s*(?:\+|&\s*(?:over|up|older)|and\s*(?:over|up|older)|plus)/))) d.min = +m[1];
    else continue;
    d.suggested = true;
  }
  for (const d of list.filter(d => d.min == null && d.max == null && /adult/i.test(d.name))) {
    const below = list.filter(x => x !== d && x.max != null).map(x => x.max), above = list.filter(x => x !== d && x.min != null && x.max == null).map(x => x.min);
    if (below.length) { d.min = Math.max(...below) + 1; if (above.length) d.max = Math.min(...above) - 1; d.suggested = true; }
  }
}
function renderDivisionRows(list) {
  $('divisionRows').innerHTML = list.map(d => `
    <div class="div-row flex flex-wrap gap-2 items-center">
      <input class="dv-name border rounded px-2 py-1 flex-1 min-w-[8rem]" value="${esc(d.name)}" placeholder="Age/Division name">
      <label class="text-xs">Min <input class="dv-min border rounded px-2 py-1 w-16 ${d.suggested ? 'bg-amber-50' : ''}" type="number" min="0" max="120" value="${d.min ?? ''}"></label>
      <label class="text-xs">Max <input class="dv-max border rounded px-2 py-1 w-16 ${d.suggested ? 'bg-amber-50' : ''}" type="number" min="0" max="120" value="${d.max ?? ''}"></label>
      ${d.suggested ? '<span class="text-xs text-amber-700">suggested – check &amp; save</span>' : ''}
      <button type="button" onclick="this.closest('.div-row').remove(); checkDivisionRows()" class="text-xs border px-2 py-1 rounded text-red-700">Remove</button>
    </div>`).join('');
  $('divisionRows').oninput = checkDivisionRows;
  checkDivisionRows();
}
function addDivisionRow() { const list = readDivisionRows(true).list; list.push({ name: '', min: null, max: null }); renderDivisionRows(list); }
function readDivisionRows(loose) {
  const list = [...document.querySelectorAll('#divisionRows .div-row')].map(r => {
    const v = c => { const x = r.querySelector(c).value.trim(); return x === '' ? null : parseInt(x, 10); };
    return { name: r.querySelector('.dv-name').value.trim(), min: v('.dv-min'), max: v('.dv-max') };
  });
  if (loose) return { list };
  const named = list.filter(d => d.name);
  if (new Set(named.map(d => d.name.toLowerCase())).size !== named.length) return { error: 'Age/Division names must be unique.' };
  const bad = named.find(d => d.min != null && d.max != null && d.min > d.max);
  if (bad) return { error: `${bad.name}: Min is greater than Max.` };
  return { list: named };
}
function checkDivisionRows() {
  const { list } = readDivisionRows(true); const w = [];
  const named = list.filter(d => d.name);
  named.filter(d => d.min == null && d.max == null).forEach(d => w.push(`${d.name} has no age range, so nobody is placed there automatically.`));
  for (let i = 0; i < named.length; i++) for (let j = i + 1; j < named.length; j++) {
    const a = named[i], b = named[j];
    if ((a.min != null || a.max != null) && (b.min != null || b.max != null) && (a.min ?? 0) <= (b.max ?? 999) && (b.min ?? 0) <= (a.max ?? 999))
      w.push(`${a.name} and ${b.name} overlap; the first one listed wins.`);
  }
  $('divisionWarn').textContent = w.join(' ');
}
// Mirrors private.division_for_age() so a laptop can show/print it before syncing.
function divisionForAge(t, age) {
  if (age == null || age === '' || isNaN(age)) return null;
  const d = divisionsOf(t).find(d => (d.min != null || d.max != null) && (d.min == null || age >= d.min) && (d.max == null || age <= d.max));
  return d ? d.name : null;
}
function divisionLabel(p) {
  if (!p.age_group) return `<span class="text-red-700 font-medium">⚠ No Age/Division${p.age == null ? ' (age missing)' : ''}</span>`;
  const unknown = S.t && !(S.t.age_groups || []).includes(p.age_group);
  return esc(p.age_group) + (p.age_group_override ? ' <span class="text-xs bg-amber-100 text-amber-800 px-1 rounded">set by hand</span>' : '')
    + (unknown ? ' <span class="text-xs bg-red-100 text-red-800 px-1 rounded">not in this tournament\'s Age/Division list</span>' : '');
}
function fillSetupForm() {
  $('dangerZone').classList.toggle('hidden', !(S.t && hasRole('admin')));
  if (S.t) $('dzName').textContent = S.t.name;
  if (!S.t) { if (!S.tid) newTournamentForm(); return; }
  S.editingNew = false;
  $('setupTitle').textContent = 'Tournament Setup – ' + S.t.name;
  $('tName').value = S.t.name; $('tYear').value = S.t.year; $('tDate').value = S.t.event_date || '';
  $('tStatus').value = S.t.status; $('tPublic').checked = !!S.t.public_visible;
  renderDivisionRows(divisionsOf(S.t, true));
  $('speciesList').value = S.species.map(s => s.name).join(', ');
  const base = location.origin + location.pathname;
  $('publicLinks').innerHTML = `Public leaderboard: <a class="text-blue-700 underline" href="${base}?t=${S.t.id}&view=leaderboard" target="_blank">${esc(base)}?t=${S.t.id}&amp;view=leaderboard</a><br>
    Big screen (TV, no sign-in): <a class="text-blue-700 underline" href="${base}?t=${S.t.id}&screen=1" target="_blank">${esc(base)}?t=${S.t.id}&amp;screen=1</a>`;
}
async function saveTournament() {
  if (!hasRole('admin')) return msg('setupMsg', 'Admin only', false);
  const year = parseInt($('tYear').value, 10);
  if (!year || year < 2020 || year > 2100) return msg('setupMsg', 'Year is required (2020–2100)', false);
  const row = {
    name: $('tName').value.trim() || 'Untitled', year, event_date: $('tDate').value || null,
    status: $('tStatus').value, public_visible: $('tPublic').checked,
  };
  const divs = readDivisionRows();
  if (divs.error) return msg('setupMsg', divs.error, false);
  row.age_groups = divs.list.map(d => d.name);
  row.age_group_ranges = Object.fromEntries(divs.list.map(d => [d.name, { min: d.min, max: d.max }]));
  const speciesNames = [...new Set($('speciesList').value.split(',').map(s => s.trim()).filter(Boolean))];
  msg('setupMsg', 'Saving…');
  let tid = S.editingNew ? null : S.tid;
  if (!tid) {
    const { data, error } = await sb.from('tournaments').insert(row).select().single();
    if (error) return msg('setupMsg', error.message, false);
    tid = data.id;
  } else {
    const { error } = await sb.from('tournaments').update(row).eq('id', tid);
    if (error) return msg('setupMsg', error.message, false);
  }
  // species diff
  const { data: existing, error: e1 } = await sb.from('species').select('*').eq('tournament_id', tid);
  if (e1) return msg('setupMsg', e1.message, false);
  const problems = [];
  for (const s of existing.filter(s => !speciesNames.includes(s.name))) {
    const { error } = await sb.from('species').delete().eq('id', s.id);
    if (error) problems.push(`${s.name} has weigh-ins and was kept`);
  }
  for (const [i, name] of speciesNames.entries()) {
    const ex = existing.find(s => s.name === name);
    const { error } = ex
      ? (ex.sort_order !== i ? await sb.from('species').update({ sort_order: i }).eq('id', ex.id) : { error: null })
      : await sb.from('species').insert({ tournament_id: tid, name, sort_order: i });
    if (error) problems.push(error.message);
  }
  S.editingNew = false;
  LS.set('ift.tid', tid);
  await loadTournamentList();
  await selectTournament(tid);
  msg('setupMsg', 'Tournament saved!' + (problems.length ? ' Note: ' + problems.join('; ') : ''), !problems.length);
}

// ---- Delete tournament (admin): typed-name confirmation, done server-side in one transaction.
function openDeleteTournament() {
  if (!S.t || !hasRole('admin')) return;
  if (!S.online) return msg('dzMsg', 'You need to be online to delete a tournament.', false);
  const n = (x, w) => `${x} ${w}${x === 1 ? '' : 's'}`;
  $('delName').textContent = S.t.name; $('delNameHint').textContent = S.t.name;
  $('delCounts').innerHTML = [n(S.participants.length, 'participant'), n(S.catches.length, 'weigh-in'),
    n(S.species.length, 'species').replace(/speciess/, 'species'), n(S.configs.length, 'leaderboard')].map(x => `<li>${esc(x)}</li>`).join('');
  $('delConfirm').value = ''; $('delMsg').textContent = ''; deleteConfirmChanged();
  S.deletingTid = S.t.id;
  openModal('deleteModal'); setTimeout(() => $('delConfirm').focus(), 0);
}
function closeDeleteTournament() { S.deletingTid = null; closeModal('deleteModal'); }
function deleteNameMatches() { return !!S.t && S.t.id === S.deletingTid && $('delConfirm').value.trim() === S.t.name.trim(); }
function deleteConfirmChanged() { $('delGo').disabled = !deleteNameMatches(); }
async function confirmDeleteTournament() {
  if (!deleteNameMatches()) return;
  const tid = S.t.id, typed = $('delConfirm').value.trim();
  $('delGo').disabled = true; $('delMsg').textContent = 'Deleting…';
  const { data, error } = await sb.rpc('delete_tournament', { p_tournament_id: tid, p_confirm_name: typed });
  if (error) { $('delMsg').textContent = error.message; deleteConfirmChanged(); return; }
  closeDeleteTournament();
  await forgetTournament(tid);
  msg('setupMsg', `Deleted "${data.name}" (${data.participants} participants, ${data.catches} weigh-ins).`);
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('deleteModal').classList.contains('hidden')) closeDeleteTournament(); });
// Drop everything this laptop keeps for a tournament that no longer exists, then move to another one.
let forgetting = null;
async function forgetTournament(tid, purge = true) {
  if (forgetting === tid) return; forgetting = tid;
  try {
    if (!purge) { S.tournaments = S.tournaments.filter(t => t.id !== tid); if (S.tid === tid) S.tid = null; return await loadTournamentList(); }
    const dropped = Q.filter(op => op.tid === tid).length + FAILED.filter(op => op.tid === tid).length;
    Q = Q.filter(op => op.tid !== tid); FAILED = FAILED.filter(op => op.tid !== tid); saveQueue();
    LS.del('ift.cache2.' + tid); LS.del('ift.codes.' + tid);
    if (LS.get('ift.tid', null) === tid) LS.del('ift.tid');
    S.tournaments = S.tournaments.filter(t => t.id !== tid);
    if (S.tid === tid) {
      S.tid = null; S.t = null;
      const q = new URLSearchParams(location.search);
      if (q.get('t') === tid) { q.delete('t'); history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash); }
    }
    if (BOARD_MODE || SCREEN_MODE) { // public pages: show a notice rather than silently jumping elsewhere
      S.board.data = { error: 'gone' }; refreshViews();
    } else await loadTournamentList();
    if (dropped) console.info(`Dropped ${dropped} unsynced change(s) for a deleted tournament.`);
  } finally { forgetting = null; }
}
async function tournamentStillExists(tid) {
  const { data, error } = await sb.from('tournaments').select('id').eq('id', tid).maybeSingle();
  return error ? true : !!data; // on errors assume it exists (offline etc.)
}

// Special picker values for species / age-group boards with no single species / group chosen.
const SPLIT_OPTS = { '': 'tabs', '__grouped__': 'grouped', '__combined__': 'combined' };
function boardFilterOptions(c) {
  const mode = c.split_mode || 'tabs';
  const special = (each, all, any, hasFilter) =>
    `<option value="" ${!hasFilter && mode === 'tabs' ? 'selected' : ''}>${each}</option>` +
    `<option value="__grouped__" ${!hasFilter && mode === 'grouped' ? 'selected' : ''}>${all}</option>` +
    `<option value="__combined__" ${!hasFilter && mode === 'combined' ? 'selected' : ''}>${any}</option>`;
  if (c.board_type === 'species') return special('Each species (separate tabs)', 'All species, grouped on one board', 'Any species, combined ranking', !!c.species_id)
    + S.species.map(s => `<option value="${s.id}" ${c.species_id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  if (c.board_type === 'age_group') return special('Each Age/Division (separate tabs)', 'All Age/Divisions, grouped on one board', 'Any Age/Division, combined ranking', !!c.age_group)
    + (S.t?.age_groups || []).map(g => `<option value="${esc(g)}" ${c.age_group === g ? 'selected' : ''}>${esc(g)}</option>`).join('');
  return '<option value="">All anglers</option>';
}
function renderConfigs() {
  const el = $('configList'); if (!el) return;
  if (!S.t) { el.innerHTML = '<p class="text-slate-500">Save a tournament first.</p>'; return; }
  const filterOpts = boardFilterOptions;
  el.innerHTML = S.configs.map(c => `
    <div class="flex flex-wrap gap-2 items-center border rounded p-2" data-id="${c.id}">
      <input class="cf-order border rounded px-2 py-1 w-14" type="number" value="${c.sort_order}" title="Order">
      <input class="cf-title border rounded px-2 py-1 flex-1 min-w-[10rem]" value="${esc(c.title)}">
      <select class="cf-type border rounded px-2 py-1" onchange="this.closest('[data-id]').querySelector('.cf-filter').innerHTML = boardFilterOptions({ board_type: this.value })">
        ${['overall', 'species', 'age_group'].map(t => `<option value="${t}" ${c.board_type === t ? 'selected' : ''}>${{ overall: 'Overall', species: 'Species', age_group: 'Age/Division' }[t]}</option>`).join('')}
      </select>
      <select class="cf-filter border rounded px-2 py-1">${filterOpts(c)}</select>
      <select class="cf-scoring border rounded px-2 py-1">
        <option value="total_weight" ${c.scoring === 'total_weight' ? 'selected' : ''}>Total weight</option>
        <option value="biggest_fish" ${c.scoring === 'biggest_fish' ? 'selected' : ''}>Biggest fish</option>
      </select>
      <label>Top <select class="cf-top border rounded px-2 py-1">${topOptions(c.top_n)}</select></label>
      <label class="flex items-center gap-1"><input class="cf-enabled" type="checkbox" ${c.enabled ? 'checked' : ''}> On</label>
      <button onclick="saveBoardConfig('${c.id}')" class="bg-blue-600 text-white px-2 py-1 rounded">Save</button>
      <button onclick="deleteBoardConfig('${c.id}')" class="border px-2 py-1 rounded text-red-700">Delete</button>
    </div>`).join('') || '<p class="text-slate-500">No leaderboards configured.</p>';
}
function topOptions(cur) {
  const vals = [3, 5, 10, 15, 20, 25, 50, 100];
  if (cur != null && !vals.includes(cur)) vals.push(cur), vals.sort((x, y) => x - y);
  return `<option value="all" ${cur == null ? 'selected' : ''}>All</option>` + vals.map(v => `<option value="${v}" ${v === cur ? 'selected' : ''}>${v}</option>`).join('');
}
async function saveBoardConfig(id) {
  const row = document.querySelector(`[data-id="${id}"]`);
  const type = row.querySelector('.cf-type').value, raw = row.querySelector('.cf-filter').value;
  const special = raw in SPLIT_OPTS, filter = special ? null : raw;
  const patch = {
    title: row.querySelector('.cf-title').value.trim() || 'Leaderboard', board_type: type,
    scoring: row.querySelector('.cf-scoring').value, top_n: row.querySelector('.cf-top').value === 'all' ? null : (parseInt(row.querySelector('.cf-top').value, 10) || 10),
    sort_order: parseInt(row.querySelector('.cf-order').value, 10) || 0, enabled: row.querySelector('.cf-enabled').checked,
    split_mode: type !== 'overall' && special ? SPLIT_OPTS[raw] : 'tabs',
    species_id: type === 'species' ? filter : null, age_group: type === 'age_group' ? filter : null
  };
  const { error } = await sb.from('leaderboard_configs').update(patch).eq('id', id);
  if (error) return msg('configMsg', error.message, false);
  msg('configMsg', 'Saved'); await reloadConfigs();
}
async function addBoardConfig() {
  if (!S.t) return;
  const { error } = await sb.from('leaderboard_configs').insert({ tournament_id: S.tid, title: 'New board', board_type: 'overall', scoring: 'total_weight', top_n: 10, sort_order: (S.configs.length + 1) * 10 });
  if (error) return msg('configMsg', error.message, false);
  await reloadConfigs();
}
async function deleteBoardConfig(id) {
  if (!confirm('Delete this leaderboard?')) return;
  const { error } = await sb.from('leaderboard_configs').delete().eq('id', id);
  if (error) return msg('configMsg', error.message, false);
  await reloadConfigs();
}
async function reloadConfigs() {
  const { data } = await sb.from('leaderboard_configs').select('*').eq('tournament_id', S.tid).order('sort_order').order('created_at');
  if (data) { S.configs = data; saveCache(); }
  renderConfigs();
}

function headerIndex(headers, ...names) { return headers.findIndex(h => names.includes(h)); }
function readFile(input) {
  return new Promise((res, rej) => { const f = input.files[0]; if (!f) return rej(new Error('Please select a CSV file.')); const r = new FileReader(); r.onload = e => res(e.target.result); r.onerror = rej; r.readAsText(f); });
}

// ---- birth dates / ages
// "As of" date for ages: the tournament's event date, else today (local).
function asOfDate(t) {
  if (t?.event_date) return t.event_date;
  const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function ageOn(birth, asOf) { // both 'YYYY-MM-DD'
  if (!birth || birth > asOf) return null;
  const [by, bm, bd] = birth.split('-').map(Number), [ay, am, ad] = asOf.split('-').map(Number);
  return ay - by - ((am < bm || (am === bm && ad < bd)) ? 1 : 0);
}
// Accepts YYYY-MM-DD (or / .), M/D/YYYY, MM/DD/YYYY, M/D/YY (US month-first). Returns {date} or {error}.
function parseBirthDate(raw, asOf) {
  const s = String(raw ?? '').trim(); if (!s) return { date: null };
  let y, m, d, k;
  if ((k = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) [y, m, d] = [+k[1], +k[2], +k[3]];
  else if ((k = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/))) {
    [m, d, y] = [+k[1], +k[2], +k[3]];
    if (k[3].length === 2) { // 2-digit year: newest century that doesn't put the birthday after the tournament date
      y += 2000;
      const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (iso > asOf) y -= 100;
    }
  } else return { error: `"${s}" isn't a date format I recognize (use YYYY-MM-DD or M/D/YYYY)` };
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (m < 1 || m > 12 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return { error: `"${s}" isn't a real date` };
  const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (date > asOf) return { error: `birth date ${s} is after the tournament date` };
  if (ageOn(date, asOf) > 120) return { error: `birth date ${s} gives an age over 120` };
  return { date };
}

// Build an import plan (no network) so the admin sees ages, divisions and warnings before importing.
async function buildImportPlan(text, t, existing) {
  const rows = parseCSV(text);
  if (rows.length < 2) return { error: 'CSV appears empty or missing header.' };
  const h = rows[0].map(x => x.toLowerCase().replace(/[^a-z]/g, ''));
  const bi = headerIndex(h, 'birthdate', 'dob', 'dateofbirth', 'birthday', 'bday', 'born');
  const ni = h.findIndex((x, i) => x.includes('name') && i !== bi), yi = headerIndex(h, 'age', 'ageyears', 'years');
  const ai = h.findIndex(x => x.includes('division') || x.includes('group'));
  const ei = headerIndex(h, 'email', 'emailaddress'), pi = headerIndex(h, 'phone', 'phonenumber', 'cell');
  const ci = headerIndex(h, 'id', 'code', 'participantid', 'participantcode', 'number'); // ignored: numbers are always assigned
  if (ni === -1) return { error: 'CSV must have a "name" column.' };
  const asOf = asOfDate(t), seen = new Set(existing), plan = [];
  for (const [n, r] of rows.slice(1).entries()) {
    const name = (r[ni] || '').trim();
    const item = { line: n + 2, name, warnings: [], status: 'new' };
    plan.push(item);
    if (!name) { item.status = 'skip'; item.warnings.push('no name – skipped'); continue; }
    item.code = null; // participant numbers are always assigned by the server
    if (ci >= 0 && (r[ci] || '').trim()) item.ignoredId = r[ci].trim();
    item.email = ei >= 0 ? r[ei] || null : null; item.phone = pi >= 0 ? r[pi] || null : null;
    item.id = await hashUuid([t.id, name.toLowerCase(), (item.email || '').toLowerCase(), item.phone || '', item.code || ''].join('|'));
    if (seen.has(item.id)) { item.status = 'already'; item.warnings.push('already imported – skipped'); continue; }
    seen.add(item.id);
    item.ageRaw = yi >= 0 ? (r[yi] || '').trim() : '';
    item.birthRaw = bi >= 0 ? (r[bi] || '').trim() : '';
    const fileAge = /^\d{1,3}$/.test(item.ageRaw) && +item.ageRaw <= 120 ? +item.ageRaw : null;
    if (item.ageRaw && fileAge == null) item.warnings.push(`age "${item.ageRaw}" isn't a whole number 0–120 – ignored`);
    const b = parseBirthDate(item.birthRaw, asOf);
    if (b.error) item.warnings.push(b.error + (fileAge != null ? ' – using the age column' : ' – age left blank'));
    item.birth = b.date || null;
    const birthAge = item.birth ? ageOn(item.birth, asOf) : null;
    if (birthAge != null && fileAge != null && birthAge !== fileAge) {
      // The database derives age from a stored birth date, so keep the birth date out when the age column wins.
      item.warnings.push(`age column says ${fileAge}, birth date gives ${birthAge} on ${asOf} – using the age column (birth date not saved)`);
      item.birth = null;
    }
    item.age = fileAge ?? birthAge;
    const fileDiv = ai >= 0 ? (r[ai] || null) : null;
    item.manual = item.age == null && !!fileDiv;
    item.division = item.manual ? fileDiv : divisionForAge(t, item.age);
    if (item.age == null && !item.birthRaw && !item.ageRaw) item.warnings.push(fileDiv ? `no age or birth date – using "${fileDiv}" from the file (set by hand)` : 'no age or birth date');
    if (!item.division) item.warnings.push(item.age == null ? 'no Age/Division (age unknown)' : `no Age/Division matches age ${item.age}`);
  }
  return { plan, asOf, hasBirth: bi >= 0, hasAge: yi >= 0, idsIgnored: plan.filter(p => p.ignoredId).length, idHeader: ci >= 0 ? rows[0][ci] : null };
}

async function previewParticipantsCSV() {
  if (!S.t) return msg('importMsg', 'Save the tournament first.', false);
  let text; try { text = await readFile($('csvFile')); } catch (e) { return msg('importMsg', e.message, false); }
  const res = await buildImportPlan(text, S.t, S.participants.map(p => p.id));
  if (res.error) { cancelImport(); return msg('importMsg', res.error, false); }
  S.importPlan = res;
  const plan = res.plan, newRows = plan.filter(p => p.status === 'new'), warned = newRows.filter(p => p.warnings.length);
  $('importMsg').textContent = '';
  $('importSummary').innerHTML = `${plan.length} rows • <b>${newRows.length} to import</b> • ${plan.length - newRows.length} skipped • `
    + `<span class="${warned.length ? 'text-amber-700 font-medium' : ''}">${warned.length} with warnings</span> • ages as of ${esc(res.asOf)}${S.t.event_date ? ' (event date)' : ' (today – no event date set)'}`
    + (res.idHeader ? `<div class="mt-1 text-slate-600">Note: the file's “${esc(res.idHeader)}” column is ignored${res.idsIgnored ? ` (${res.idsIgnored} value${res.idsIgnored === 1 ? '' : 's'})` : ''} – participant numbers are always assigned automatically.</div>` : '');
  $('importRows').innerHTML = plan.map(p => `<tr class="border-t ${p.status !== 'new' ? 'text-slate-400' : p.warnings.length ? 'bg-amber-50' : ''}">
      <td class="p-1">${p.line}</td><td class="p-1">${esc(p.name)}</td><td class="p-1">${esc(p.ageRaw || '')}</td><td class="p-1">${esc(p.birthRaw || '')}</td>
      <td class="p-1 font-medium">${p.age ?? ''}</td><td class="p-1">${p.division ? esc(p.division) + (p.manual ? ' <span class="text-amber-700">(by hand)</span>' : '') : (p.status === 'new' ? '<span class="text-red-700">—</span>' : '')}</td>
      <td class="p-1 ${p.status === 'new' ? 'text-amber-800' : ''}">${p.warnings.map(esc).join('; ')}</td></tr>`).join('');
  $('importGo').textContent = `Import ${newRows.length}`;
  $('importGo').disabled = !newRows.length;
  $('importPreview').classList.remove('hidden');
}
function csvChosen(quiet) {
  const f = $('csvFile').files[0], el = $('csvFileName');
  el.textContent = f ? `📄 ${f.name}` : 'No file chosen';
  el.className = 'font-medium truncate ' + (f ? 'text-slate-900' : 'text-slate-500');
  if (f && !quiet) previewParticipantsCSV(); else if (!f) cancelImport();
}
function setupFileDrop() {
  const z = $('csvDrop'); if (!z) return;
  const on = e => { e.preventDefault(); z.classList.add('ring-4', 'ring-blue-300', 'bg-blue-100'); };
  const off = () => z.classList.remove('ring-4', 'ring-blue-300', 'bg-blue-100');
  ['dragenter', 'dragover'].forEach(ev => z.addEventListener(ev, on));
  ['dragleave', 'dragend'].forEach(ev => z.addEventListener(ev, off));
  z.addEventListener('drop', e => {
    e.preventDefault(); off();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (!f) return;
    if (!/\.csv$/i.test(f.name) && f.type && !/csv|text/.test(f.type)) return msg('importMsg', 'Please drop a .csv file.', false);
    const dt = new DataTransfer(); dt.items.add(f); $('csvFile').files = dt.files; csvChosen();
  });
}
document.addEventListener('DOMContentLoaded', setupFileDrop);
if (document.readyState !== 'loading') setupFileDrop();
function cancelImport() { S.importPlan = null; $('importPreview').classList.add('hidden'); $('importRows').innerHTML = ''; }

async function importParticipantsCSV() {
  const res = S.importPlan; if (!res) return;
  const source = $('csvSource').value;
  const out = res.plan.filter(p => p.status === 'new').map(p => ({ id: p.id, tournament_id: S.tid, display_name: p.name,
    age: p.age, birth_date: p.birth, age_group: p.division, age_group_override: p.manual,
    email: p.email, phone: p.phone, participant_code: p.code, source }));
  if (!out.length) return msg('importMsg', 'Nothing new to import (already imported?).');
  msg('importMsg', `Importing ${out.length}…`);
  for (let i = 0; i < out.length; i += 200) {
    const { error } = await sb.from('participants').upsert(out.slice(i, i + 200), { onConflict: 'id', ignoreDuplicates: true });
    if (error) return msg('importMsg', `Stopped after ${i} rows: ${error.message}`, false);
  }
  $('csvFile').value = ''; csvChosen(true); cancelImport();
  await loadTournamentData();
  const missing = S.participants.filter(p => !p.age_group).length;
  msg('importMsg', `Imported ${out.length} participants.` + (missing ? ` ${missing} participant(s) have no Age/Division – they're flagged on the Participants tab.` : ''));
}

function exportParticipants() {
  const rows = [['id', 'name', 'age', 'birth_date', 'Age/Division', 'division_set_by_hand', 'email', 'phone', 'source', 'created_at']]
    .concat(S.participants.slice().sort((a, b) => (a.participant_code || '').localeCompare(b.participant_code || ''))
      .map(p => [p.participant_code, p.display_name, p.age ?? '', p.birth_date ?? '', p.age_group ?? '', p.age_group_override ? 'yes' : 'no', p.email, p.phone, p.source, p.created_at]));
  download(`${slug(S.t?.name)}-participants.csv`, toCSV(rows));
}
function exportCatches() {
  const pById = Object.fromEntries(S.participants.map(p => [p.id, p])), sById = Object.fromEntries(S.species.map(s => [s.id, s]));
  const rows = [['ticket_no', 'ticket_code', 'ticket_id', 'id', 'name', 'Age/Division', 'species', 'lbs', 'station', 'weighed_at', 'status', 'void_reason', 'note', 'last_changed_at']]
    .concat(S.catches.slice().sort((a, b) => (a.weighed_at || '').localeCompare(b.weighed_at || '')).map(c => {
      const p = pById[c.participant_id] || {};
      return [c.ticket_no, ticketCode(c), c.id, p.participant_code, p.display_name, p.age_group, sById[c.species_id]?.name, Number(c.weight_lbs).toFixed(2), c.station, c.weighed_at, c.status, c.void_reason, c.note, c.updated_at];
    }));
  download(`${slug(S.t?.name)}-weigh-ins.csv`, toCSV(rows));
}
function exportLeaderboard() {
  const data = currentBoards();
  const rows = [['board', 'section', 'rank', 'name', 'Age/Division', 'fish', 'lbs']];
  (data?.boards || []).forEach(b => boardSections(b).forEach(sec => sec.rows.forEach(r => rows.push([b.title, sec.name || '', r.rank, r.name, r.group, r.fish, Number(r.lbs).toFixed(2)]))));
  download(`${slug(S.t?.name || data?.tournament?.name)}-leaderboard.csv`, toCSV(rows));
}

// ---------------------------------------------------------------- gate
function populateSelects() {
  const groups = S.t?.age_groups || [];
  const curAge = $('wAge').value;
  $('wAge').innerHTML = '<option value="">Age/Division: automatic from age</option>' + groups.map(a => `<option value="${esc(a)}">${esc(a)} (set by hand)</option>`).join('');
  $('wAge').value = curAge;
  const cur = $('species').value;
  $('species').innerHTML = S.species.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  if (cur) $('species').value = cur;
}

function codePoolKey() { return 'ift.codes.' + S.tid; }
async function ensureCodePool() {
  if (!S.tid || !hasRole('gate') || !S.online || !S.session) return;
  const used = new Set(S.participants.map(p => p.participant_code));
  let pool = LS.get(codePoolKey(), []).filter(c => !used.has(c));
  if (pool.length < 10) {
    const { data, error } = await sb.rpc('reserve_participant_codes', { p_tournament_id: S.tid, p_count: 25 });
    if (!error && data) pool = pool.concat(data);
  }
  LS.set(codePoolKey(), pool);
  $('codePoolInfo').textContent = pool.length ? `${pool.length} badge numbers reserved on this laptop for offline walk-ups.` : '';
}
function takeCode() {
  const pool = LS.get(codePoolKey(), []);
  const used = new Set(S.participants.map(p => p.participant_code));
  let code = null;
  while (pool.length && !code) { const c = pool.shift(); if (!used.has(c)) code = c; }
  LS.set(codePoolKey(), pool);
  return code;
}

function openWalkup() { openParticipantModal(null); }
function openParticipantModal(id) {
  if (!S.t) return alert('Select or create a tournament first');
  const p = id ? S.participants.find(x => x.id === id) : null;
  S.editingParticipant = p ? p.id : null;
  populateSelects();
  $('pmTitle').textContent = p ? `Edit ${p.participant_code || 'participant'}` : 'New Walk-up';
  $('pmSave').textContent = p ? 'Save' : 'Create + Print Card';
  $('wName').value = p?.display_name || ''; $('wYears').value = p?.age ?? ''; $('wBirth').value = p?.birth_date || '';
  $('wYears').disabled = !!p?.birth_date;
  $('wEmail').value = p?.email || ''; $('wPhone').value = p?.phone || '';
  $('wAge').value = p?.age_group_override ? p.age_group : '';
  updateDivisionPreview(); openModal('modal'); $('wName').focus();
}
function readAge(v) { v = String(v ?? '').trim(); return /^\d{1,3}$/.test(v) && +v <= 120 ? parseInt(v, 10) : null; }
function birthChanged() {
  const b = $('wBirth').value;
  $('wYears').disabled = !!b;
  if (b) { const a = ageOn(b, asOfDate(S.t)); $('wYears').value = a ?? ''; }
  updateDivisionPreview();
}
function updateDivisionPreview() {
  const el = $('wDivPreview'); if (!el) return;
  if ($('wAge').value) { el.innerHTML = `<span class="text-amber-800">Age/Division set by hand: ${esc($('wAge').value)}</span>`; return; }
  const age = readAge($('wYears').value), d = divisionForAge(S.t, age);
  el.innerHTML = d ? `<span class="text-green-700">Age/Division: ${esc(d)}</span>`
    : `<span class="text-red-700">⚠ ${age == null ? 'Enter an age to assign the Age/Division' : 'No Age/Division matches age ' + age}</span>`;
}
function saveParticipantModal() {
  const name = $('wName').value.trim(); if (!name) return;
  const birth = $('wBirth').value || null;
  if (birth && (birth > asOfDate(S.t) || ageOn(birth, asOfDate(S.t)) > 120)) return alert('That birth date is after the tournament date or more than 120 years ago.');
  const yearsRaw = $('wYears').value.trim(), age = birth ? ageOn(birth, asOfDate(S.t)) : readAge(yearsRaw);
  if (!birth && yearsRaw && age == null) return alert('Age must be a whole number from 0 to 120.');
  const manual = $('wAge').value || null;
  const fields = { display_name: name, age, birth_date: birth, age_group: manual || divisionForAge(S.t, age), age_group_override: !!manual,
    email: $('wEmail').value.trim() || null, phone: $('wPhone').value.trim() || null };
  closeModal('modal');
  if (S.editingParticipant) {
    enqueue({ kind: 'update', table: 'participants', id: S.editingParticipant, patch: fields });
    return;
  }
  const row = { id: uuid(), tournament_id: S.tid, participant_code: takeCode(), ...fields, source: 'walkup', created_at: new Date().toISOString() };
  enqueue({ kind: 'insert', table: 'participants', row });
  if (row.participant_code) printParticipantCard(row);
  else alert('Saved. No reserved badge number was available on this laptop, so the number will be assigned when it syncs. Print the card from the list after that.');
  ensureCodePool();
}

function renderParticipants() {
  const el = $('participantList'); if (!el) return;
  if (!canReadData()) { el.innerHTML = '<p class="text-slate-500">Sign in as gate or admin staff.</p>'; return; }
  const f = $('partFilter').value.trim().toLowerCase();
  const list = S.participants.filter(p => f === '!' ? !p.age_group : !f || p.display_name.toLowerCase().includes(f) || (p.participant_code || '').includes(f))
    .sort((a, b) => (a.participant_code || 'z').localeCompare(b.participant_code || 'z'));
  const noDiv = S.participants.filter(p => !p.age_group).length;
  $('partCount').innerHTML = `${S.participants.length} registered` + (noDiv ? ` • <button class="text-red-700 underline" onclick="$('partFilter').value='!';renderParticipants()">${noDiv} without Age/Division</button>` : '');
  el.innerHTML = list.slice(0, 300).map(p => `
    <div class="flex justify-between items-center border rounded p-3 ${p._failed ? 'border-red-400' : ''}">
      <div>
        <div class="font-medium">${esc(p.display_name)} ${p._pending ? '<span class="text-xs text-amber-700">(not synced)</span>' : ''}</div>
        <div class="text-sm text-slate-500">ID: ${esc(p.participant_code || 'pending')} • Age ${p.age ?? '—'} • ${divisionLabel(p)}</div>
      </div>
      <div class="flex gap-2">
        <button onclick="openParticipantModal('${p.id}')" class="text-sm px-3 py-1 bg-slate-200 rounded">Edit</button>
        <button onclick="printParticipantCardById('${p.id}')" class="text-sm px-3 py-1 bg-blue-100 rounded" ${p.participant_code ? '' : 'disabled'}>Print Card</button>
      </div>
    </div>`).join('') + (list.length > 300 ? `<p class="text-xs text-slate-500">Showing 300 of ${list.length}. Use the filter.</p>` : '')
    || '<p class="text-slate-500">No participants yet. Add a walk-up or import a CSV.</p>';
}
function findParticipant() {
  const code = normCode(S.t?.year, $('checkNum').value);
  if (!code) return msg('findResult', 'Enter a participant number', false);
  const p = S.participants.find(x => x.participant_code === code);
  if (!p) return msg('findResult', 'Not found: ' + code, false);
  msg('findResult', `Found: ${p.display_name} (${p.age_group || ''})`);
  $('partFilter').value = code; renderParticipants();
  $('checkNum').value = '';
  printParticipantCard(p);
}

// ---------------------------------------------------------------- printing
function showPrintPreview(html) { $('printPreviewContent').innerHTML = html; $('printArea').innerHTML = html; openModal('printPreviewModal'); }
function doPrint() { try { window.print(); } catch (e) { alert('Print dialog blocked. Use the browser menu to print.'); } }
function printParticipantCardById(id) { const p = S.participants.find(x => x.id === id); if (p?.participant_code) printParticipantCard(p); }
function printParticipantCard(p) {
  const card = `<div class="print-card">
      <div class="font-bold text-sm">${esc(S.t?.name || 'Tournament')}</div>
      <div class="text-lg font-bold mt-1">${esc(p.display_name)}</div>
      <div class="text-xs mb-2">${esc(p.age_group || '')}${p.age != null ? ' • Age ' + p.age : ''}</div>
      <svg class="bc"></svg>
      <div class="qr mx-auto my-1" style="width:80px"></div>
      <div class="font-mono text-xs mt-1">${esc(p.participant_code)}</div>
    </div>`;
  showPrintPreview(card);
  setTimeout(() => {
    document.querySelectorAll('#printPreviewContent .bc, #printArea .bc').forEach(svg => {
      try { JsBarcode(svg, p.participant_code, { format: 'CODE128', width: 1.5, height: 40, displayValue: false }); } catch (e) {}
    });
    document.querySelectorAll('#printPreviewContent .qr, #printArea .qr').forEach(div => {
      try { new QRCode(div, { text: p.participant_code, width: 80, height: 80 }); } catch (e) {}
    });
  }, 30);
}
function printWeighTicket(p, c) {
  const sp = S.species.find(s => s.id === c.species_id)?.name || '';
  showPrintPreview(`<div class="print-ticket">
      <div class="font-bold text-xs">WEIGH TICKET</div>
      <div class="font-bold">${esc(p.display_name)}</div>
      <div class="font-mono text-xs">${esc(p.participant_code || '')}</div>
      <div>${esc(sp)}</div>
      <div class="text-lg font-bold">${formatLbs(c.weight_lbs)}</div>
      <div>${new Date(c.weighed_at).toLocaleTimeString()}</div>
      <div class="text-xs">${esc(c.station || '')}</div>
      <div class="font-mono text-[9px] mt-1">${c.ticket_no ? 'Ticket #' + c.ticket_no + ' • ' : ''}${ticketCode(c)}</div>
    </div>`);
}

// ---------------------------------------------------------------- weigh
function saveStationName() { LS.set('ift.station', $('stationName').value.trim()); }
function lookupParticipant() {
  const code = normCode(S.t?.year, $('scanNum').value);
  if (!code) return msg('weighMsg', 'Enter the participant number', false);
  const p = S.participants.find(x => x.participant_code === code);
  if (!p) return msg('weighMsg', 'Participant not found: ' + code, false);
  S.currentParticipant = p;
  $('weighForm').classList.remove('hidden');
  $('pInfo').textContent = `${p.display_name} • ${p.age_group || 'No Age/Division'} • ${code}`;
  $('weighMsg').textContent = '';
  populateSelects();
  $('scanNum').value = ''; $('weightLbs').focus();
}
function submitWeighIn() {
  const p = S.currentParticipant; if (!p) return;
  const total = round2(parseFloat($('weightLbs').value));
  if (!(total > 0)) return msg('weighMsg', 'Enter a weight in pounds (e.g. 2.35)', false);
  if (total > 500) return msg('weighMsg', 'Weight must be 500 lbs or less', false);
  if (!$('species').value) return msg('weighMsg', 'No species set up for this tournament', false);
  const row = {
    id: uuid(), tournament_id: S.tid, participant_id: p.id, species_id: $('species').value, weight_lbs: total,
    station: $('stationName').value.trim() || null, weighed_at: new Date().toISOString(), source: 'station', status: 'active'
  };
  enqueue({ kind: 'insert', table: 'catches', row: { ...row } });
  const local = S.catches.find(c => c.id === row.id); if (local) local.recorded_by = S.user?.id;
  printWeighTicket(p, row);
  $('weightLbs').value = '';
  $('weighForm').classList.add('hidden'); S.currentParticipant = null;
  msg('weighMsg', `Recorded ${formatLbs(total)} for ${p.display_name}`);
  $('scanNum').focus();
}
// ---- Find / edit weigh tickets (weigh + admin). Edits go through the offline queue as absolute-value updates.
function ticketCode(c) { return c.id.replace(/-/g, '').slice(0, 8).toUpperCase(); }
function ticketLabel(c) { return c.ticket_no ? `#${c.ticket_no}` : '#…'; }
function canEditTickets() { return hasRole('weigh'); }
function ticketMatches(c, q, p, sp) {
  if (!q) return true;
  const year = S.t?.year;
  return q.split(/\s+/).every(tok => {
    const t = tok.toLowerCase();
    if (/^#\d+$/.test(t)) return String(c.ticket_no) === t.slice(1);
    if (/^\d{4}_\d+$/.test(t)) return p?.participant_code === normCode(year, t);
    if (/^\d+$/.test(t)) return String(c.ticket_no) === t || (p?.participant_code && Number(p.participant_code.split('_')[1]) === Number(t));
    if (/^[0-9a-f]{4,8}$/i.test(t) && ticketCode(c).toLowerCase().startsWith(t)) return true;
    return [p?.display_name, sp?.name, c.station, c.note].some(v => (v || '').toLowerCase().includes(t));
  });
}
function renderRecentCatches() {
  const el = $('recentCatches'); if (!el) return;
  const pById = Object.fromEntries(S.participants.map(p => [p.id, p])), sById = Object.fromEntries(S.species.map(s => [s.id, s]));
  const q = ($('tkSearch')?.value || '').trim(), showVoid = $('tkShowVoid')?.checked;
  const limit = S.tkLimit || 50;
  const all = S.catches.filter(c => (showVoid || c.status !== 'voided' || q) && ticketMatches(c, q, pById[c.participant_id], sById[c.species_id]))
    .sort((a, b) => (b.weighed_at || '').localeCompare(a.weighed_at || '') || (b.ticket_no || 1e9) - (a.ticket_no || 1e9));
  const list = all.slice(0, limit), edit = canEditTickets();
  $('tkCount').textContent = q ? `${all.length} match${all.length === 1 ? '' : 'es'}` : `${S.catches.length} ticket${S.catches.length === 1 ? '' : 's'} • newest first`;
  $('tkMore').classList.toggle('hidden', all.length <= limit);
  el.innerHTML = list.map(c => {
    const p = pById[c.participant_id], v = c.status === 'voided';
    const edited = c.updated_at && c.created_at && (new Date(c.updated_at) - new Date(c.created_at) > 2000);
    const inner = `<div class="flex justify-between items-start gap-2">
        <div class="min-w-0">
          <div class="font-medium truncate ${v ? 'line-through text-slate-400' : ''}">${esc(p?.display_name || '?')} <span class="text-xs text-slate-500 font-mono">${esc(p?.participant_code || '')}</span></div>
          <div class="text-xs text-slate-500">${ticketLabel(c)} • ${new Date(c.weighed_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} • ${esc(sById[c.species_id]?.name || '')}${c.station ? ' • ' + esc(c.station) : ''}
            ${v ? '<span class="text-red-700">• voided</span>' : ''}${edited && !v ? ' • <span class="text-blue-700">edited</span>' : ''}${c._pending ? ' • <span class="text-amber-700">not synced</span>' : ''}${c._failed ? ' • <span class="text-red-700">sync failed</span>' : ''}</div>
          ${c.note ? `<div class="text-xs text-slate-600 italic truncate">${esc(c.note)}</div>` : ''}
        </div>
        <div class="font-bold whitespace-nowrap ${v ? 'line-through text-slate-400' : ''}">${formatLbs(c.weight_lbs)}</div>
      </div>`;
    return edit ? `<button type="button" onclick="openTicket('${c.id}')" class="tk-row block w-full text-left border-b py-2 px-1 hover:bg-slate-50 active:bg-slate-100">${inner}</button>`
      : `<div class="border-b py-2 px-1">${inner}</div>`;
  }).join('') || `<p class="text-slate-500 py-2">${q ? 'No tickets match.' : 'No weigh-ins yet.'}</p>`;
  if (S.ticketId && !$('ticketModal').classList.contains('hidden')) refreshTicketHeader();
}
function openTicket(id) {
  const c = S.catches.find(x => x.id === id); if (!c || !canEditTickets()) return;
  S.ticketId = id;
  $('tkAngler').innerHTML = S.participants.slice().sort((a, b) => a.display_name.localeCompare(b.display_name))
    .map(p => `<option value="${p.id}">${esc(p.display_name)} — ${esc(p.participant_code || 'no #')}${p.age_group ? ' (' + esc(p.age_group) + ')' : ''}</option>`).join('');
  $('tkSpecies').innerHTML = S.species.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  $('tkAngler').value = c.participant_id; $('tkSpecies').value = c.species_id;
  $('tkWeight').value = Number(c.weight_lbs).toFixed(2); $('tkNote').value = c.note || '';
  $('tkMsg').textContent = ''; showVoidConfirm(false); refreshTicketHeader();
  openModal('ticketModal'); loadTicketHistory(id);
}
function refreshTicketHeader() {
  const c = S.catches.find(x => x.id === S.ticketId); if (!c) return closeTicket();
  const v = c.status === 'voided';
  $('tkTitle').textContent = `Ticket ${ticketLabel(c)}`;
  $('tkMeta').textContent = `Code ${ticketCode(c)} • weighed ${new Date(c.weighed_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}${c.station ? ' at ' + c.station : ''}${c._pending ? ' • not synced yet' : ''}`;
  $('tkVoided').classList.toggle('hidden', !v);
  $('tkVoided').textContent = v ? `Voided${c.void_reason ? ': ' + c.void_reason : ''}. It doesn't count on any leaderboard.` : '';
  $('tkVoidBtn').classList.toggle('hidden', v); $('tkRestoreBtn').classList.toggle('hidden', !v);
  if (v) showVoidConfirm(false);
}
function closeTicket() { S.ticketId = null; closeModal('ticketModal'); }
function showVoidConfirm(on) {
  $('tkVoidConfirm').classList.toggle('hidden', !on); $('tkVoidReason').value = ''; $('tkVoidGo').disabled = true;
  if (on) setTimeout(() => $('tkVoidReason').focus(), 0);
}
function saveTicket() {
  const c = S.catches.find(x => x.id === S.ticketId); if (!c) return;
  const w = round2(parseFloat($('tkWeight').value));
  if (!(w > 0) || w > 500) return msg('tkMsg', 'Enter a weight between 0.01 and 500 lbs', false);
  const want = { participant_id: $('tkAngler').value, species_id: $('tkSpecies').value, weight_lbs: w, note: $('tkNote').value.trim().slice(0, 200) || null };
  const patch = {};
  for (const [k, v] of Object.entries(want)) if (k === 'weight_lbs' ? round2(c[k]) !== v : (c[k] ?? null) !== v) patch[k] = v;
  if (!Object.keys(patch).length) return msg('tkMsg', 'Nothing changed.');
  enqueue({ kind: 'update', table: 'catches', id: c.id, patch });
  msg('weighMsg', `Saved ticket ${ticketLabel(c)}${S.online ? '' : ' (will sync when back online)'}.`);
  closeTicket();
}
function voidTicket() {
  const c = S.catches.find(x => x.id === S.ticketId); const reason = $('tkVoidReason').value.trim();
  if (!c || !reason) return;
  enqueue({ kind: 'update', table: 'catches', id: c.id, patch: { status: 'voided', void_reason: reason.slice(0, 200) } });
  msg('weighMsg', `Voided ticket ${ticketLabel(c)}.`); closeTicket();
}
function restoreTicket() {
  const c = S.catches.find(x => x.id === S.ticketId); if (!c) return;
  if (!confirm(`Restore ticket ${ticketLabel(c)}? It will count on the leaderboards again.`)) return;
  enqueue({ kind: 'update', table: 'catches', id: c.id, patch: { status: 'active', void_reason: null } });
  msg('weighMsg', `Restored ticket ${ticketLabel(c)}.`); closeTicket();
}
function reprintTicket() {
  const c = S.catches.find(x => x.id === S.ticketId); const p = c && S.participants.find(x => x.id === c.participant_id);
  if (c && p) printWeighTicket(p, c);
}
async function loadTicketHistory(id) {
  const el = $('tkHistory');
  const pName = pid => S.participants.find(p => p.id === pid)?.display_name || '?';
  const sName = sid => S.species.find(s => s.id === sid)?.name || '?';
  const fmt = (k, [a, b]) => k === 'weight_lbs' ? `weight ${Number(a).toFixed(2)} → ${Number(b).toFixed(2)} lbs`
    : k === 'species_id' ? `species ${sName(a)} → ${sName(b)}` : k === 'participant_id' ? `angler ${pName(a)} → ${pName(b)}`
    : k === 'note' ? `note “${a || ''}” → “${b || ''}”` : k === 'void_reason' ? (b ? `reason: ${b}` : '') : '';
  const pend = Q.filter(op => op.table === 'catches' && op.kind === 'update' && op.id === id)
    .map(op => `<div class="text-amber-700">Waiting to sync: ${esc(Object.keys(op.patch).join(', '))}</div>`).join('');
  el.innerHTML = pend + '<div>Loading…</div>';
  if (!S.online) { el.innerHTML = pend + '<div>History is available when online.</div>'; return; }
  const { data, error } = await sb.from('catch_history').select('*').eq('catch_id', id).order('changed_at');
  if (S.ticketId !== id) return;
  if (error) { el.innerHTML = pend + `<div>Couldn't load history (${esc(error.message)}).</div>`; return; }
  const rows = (data || []).map(h => {
    const what = Object.entries(h.changes).map(([k, v]) => fmt(k, v)).filter(Boolean).join('; ');
    const verb = h.action === 'void' ? 'Voided' : h.action === 'restore' ? 'Restored' : 'Edited';
    return `<div>${new Date(h.changed_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })} • <b>${verb}</b> by ${esc(h.changed_by_email || 'unknown')}${what ? ' – ' + esc(what) : ''}</div>`;
  });
  el.innerHTML = pend + (rows.join('') || '<div>No changes since it was weighed.</div>');
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('ticketModal').classList.contains('hidden')) closeTicket(); });

// ---------------------------------------------------------------- leaderboards
// Same logic as private.leaderboard() in the database, run locally for staff (instant + offline).
function computeBoards() {
  if (!S.t) return null;
  const active = S.catches.filter(c => c.status === 'active');
  const pById = Object.fromEntries(S.participants.map(p => [p.id, p]));
  const rowsFor = (scoring, speciesId, ageGroup, topN) => {
    const agg = {};
    for (const c of active) {
      if (speciesId && c.species_id !== speciesId) continue;
      const a = agg[c.participant_id] || (agg[c.participant_id] = { fish: 0, sum: 0, max: 0 });
      const w = Number(c.weight_lbs); a.fish++; a.sum += w; a.max = Math.max(a.max, w);
    }
    const list = Object.entries(agg).map(([pid, a]) => ({ p: pById[pid], fish: a.fish, lbs: round2(scoring === 'biggest_fish' ? a.max : a.sum) }))
      .filter(x => x.p && (!ageGroup || x.p.age_group === ageGroup))
      .sort((a, b) => b.lbs - a.lbs || a.p.display_name.localeCompare(b.p.display_name));
    let rank = 0;
    return (topN ? list.slice(0, topN) : list).map((x, i) => { if (i === 0 || x.lbs !== list[i - 1].lbs) rank = i + 1; return { rank, name: x.p.display_name, group: x.p.age_group, fish: x.fish, lbs: x.lbs }; });
  };
  const boards = [];
  for (const c of S.configs.filter(c => c.enabled).sort((a, b) => a.sort_order - b.sort_order)) {
    const mode = c.split_mode || 'tabs';
    if (c.board_type === 'species' && !c.species_id && mode === 'tabs') S.species.forEach(s => boards.push({ title: `${c.title} – ${s.name}`, scoring: c.scoring, rows: rowsFor(c.scoring, s.id, null, c.top_n) }));
    else if (c.board_type === 'species' && !c.species_id && mode === 'grouped') boards.push({ title: c.title, scoring: c.scoring, rows: [], groups: S.species.map(s => ({ name: s.name, rows: rowsFor(c.scoring, s.id, null, c.top_n) })) });
    else if (c.board_type === 'age_group' && !c.age_group && mode === 'tabs') (S.t.age_groups || []).forEach(g => boards.push({ title: `${c.title} – ${g}`, scoring: c.scoring, rows: rowsFor(c.scoring, null, g, c.top_n) }));
    else if (c.board_type === 'age_group' && !c.age_group && mode === 'grouped') boards.push({ title: c.title, scoring: c.scoring, rows: [], groups: (S.t.age_groups || []).map(g => ({ name: g, rows: rowsFor(c.scoring, null, g, c.top_n) })) });
    else boards.push({ title: c.title, scoring: c.scoring, rows: rowsFor(c.scoring, c.species_id, c.age_group, c.top_n) });
  }
  return { tournament: { id: S.t.id, name: S.t.name, year: S.t.year, status: S.t.status }, boards, local: true };
}
// A board is either plain ({rows}) or grouped ({groups:[{name, rows}]}) – one section per species / age group.
function boardSections(b) { return b.groups ? b.groups : [{ name: null, rows: b.rows || [] }]; }
function boardHasData(b) { return boardSections(b).some(s => s.rows.length); }
function rowsHtml(rows, compact) {
  return rows.map(r => `<div class="flex justify-between gap-3 ${compact ? 'py-1.5 px-2' : 'py-2'} border-b"><span class="min-w-0 truncate"><span class="font-semibold">${r.rank}.</span> ${esc(r.name)} <span class="text-slate-400 text-sm">${esc(r.group || '')}</span></span><span class="font-bold whitespace-nowrap">${formatLbs(r.lbs)}</span></div>`).join('')
    || `<div class="text-sm text-slate-500 ${compact ? 'px-2 py-1' : ''}">No fish yet</div>`;
}
// Collapsed group sections on grouped boards, remembered per tournament + board on this device.
function collapsedGroups() { return LS.get('ift.collapsed', {}); }
function groupKey(boardSlug, name) { return `${S.tid}|${boardSlug}|${name}`; }
function toggleGroup(btn) {
  const all = collapsedGroups(), key = btn.dataset.key;
  if (all[key]) delete all[key]; else all[key] = 1;
  LS.set('ift.collapsed', all);
  const open = !all[key];
  btn.setAttribute('aria-expanded', open);
  btn.nextElementSibling.classList.toggle('hidden', !open);
  btn.querySelector('svg').classList.toggle('-rotate-90', !open);
}
// Selected leaderboard tab lives in the URL hash (#board=<slug>) so it can be shared.
function currentBoardSlug() { const m = location.hash.match(/board=([^&]+)/); return m ? decodeURIComponent(m[1]) : null; }
function selectBoard(slugName) { history.replaceState(null, '', location.pathname + location.search + '#board=' + encodeURIComponent(slugName)); renderLeaderboard(); }
window.addEventListener('hashchange', () => {
  if (/(^#|&)board=/.test(location.hash) && S.tab !== 'leaderboard' && (ROLE_TABS[S.role] || ROLE_TABS.public).includes('leaderboard')) return showTab('leaderboard');
  if (S.tab === 'leaderboard') renderLeaderboard();
});
window.addEventListener('popstate', () => {
  const t = urlParam('t'); if (t && t !== S.tid && S.tournaments.some(x => x.id === t)) selectTournament(t);
  if (KIOSK) return;
  const v = linkedView(); if (v && v !== S.tab && (ROLE_TABS[S.role] || ROLE_TABS.public).includes(v)) showTab(v);
});
function currentBoards() { return canReadData() && S.t ? computeBoards() : S.board.data; }

function renderLeaderboard() {
  const data = currentBoards();
  $('boardHeading').textContent = data?.tournament ? `${data.tournament.name} – Leaderboard` : 'Leaderboard';
  if (BOARD_MODE && data?.tournament) document.title = `${data.tournament.name} – Leaderboard`;
  $('boardUpdated').textContent = data?.local ? 'Live (this station)' : (S.board.at ? 'Updated ' + S.board.at.toLocaleTimeString() + ` • refreshes every ${CFG.publicPollSeconds}s` : '');
  if (!data || data.error) $('boardTabs').innerHTML = '';
  if (!data) { $('boardContent').innerHTML = `<p class="text-slate-500">${S.tid ? 'Loading…' : 'No public tournament yet.'}</p>`; return; }
  if (data.error) { $('boardContent').innerHTML = '<p class="text-slate-500">This leaderboard isn\'t available – the tournament may have been deleted or hidden from the public.</p>'; return; }
  const boards = data.boards || [];
  if (!boards.length) { $('boardTabs').innerHTML = ''; $('boardContent').innerHTML = '<p class="text-slate-500">No leaderboards configured.</p>'; return; }
  const slugs = []; boards.forEach((b, i) => { let k = slug(b.title) || 'board'; if (slugs.includes(k)) k += '-' + i; slugs.push(k); });
  let idx = slugs.indexOf(currentBoardSlug());
  if (idx < 0) idx = 0;
  $('boardTabs').innerHTML = boards.map((b, i) => `<button role="tab" aria-selected="${i === idx}" onclick="selectBoard('${slugs[i]}')"
      class="px-3 py-2 rounded-full text-sm ${i === idx ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}">${esc(b.title)}</button>`).join('');
  const b = boards[idx];
  $('boardContent').innerHTML = `
    <div class="text-xs text-slate-500 mb-2">${b.scoring === 'biggest_fish' ? 'Biggest single fish' : 'Total weight'}</div>
    ${b.groups ? b.groups.map(g => {
      const key = groupKey(slugs[idx], g.name), shut = !!collapsedGroups()[key];
      return `<section class="mb-3">
        <button type="button" data-key="${esc(key)}" onclick="toggleGroup(this)" aria-expanded="${!shut}"
          class="sticky top-0 w-full flex items-center justify-between gap-2 bg-slate-100 hover:bg-slate-200 text-slate-800 font-semibold text-sm uppercase tracking-wide px-2 py-2 rounded text-left">
          <span>${esc(g.name)} <span class="normal-case font-normal text-slate-500">(${g.rows.length})</span></span>
          <svg class="w-4 h-4 transition-transform ${shut ? '-rotate-90' : ''}" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clip-rule="evenodd"/></svg>
        </button>
        <div class="${shut ? 'hidden' : ''}">${rowsHtml(g.rows, true)}</div>
      </section>`; }).join('') || '<div class="text-sm text-slate-500">No sections</div>' : rowsHtml(b.rows)}`;
  const active = $('boardTabs').children[idx];
  if (active && S.lastBoardIdx !== idx) { const c = $('boardTabs'); c.scrollLeft = active.offsetLeft - (c.clientWidth - active.offsetWidth) / 2; S.lastBoardIdx = idx; }
}

// Public / big-screen polling: one small RPC, skipped payload when nothing changed.
async function pollBoard() {
  if (!S.tid || document.hidden) return;
  const tid = S.tid;
  const { data, error } = await sb.rpc('get_leaderboard', { p_tournament_id: tid, p_known_version: S.board.tid === tid ? S.board.version : null });
  if (tid !== S.tid) return;
  if (error) { if (isNetErr(error)) setOnline(false); return; }
  if (!S.online) setOnline(true);
  S.board.at = new Date(); S.board.tid = tid;
  if (data.error === 'not_found') { // deleted (or hidden from the public) since we picked it
    if (canReadData()) { if (!(await tournamentStillExists(tid))) return forgetTournament(tid, true); }
    else if (!KIOSK) {
      const r = await sb.rpc('list_public_tournaments');
      if (!r.error && !(r.data || []).some(x => x.id === tid)) return forgetTournament(tid, false);
    }
  }
  if (!data.unchanged) { S.board.data = data; S.board.version = data.v ?? null; }
  if (S.tab === 'leaderboard') renderLeaderboard();
  if (S.tab === 'display') renderDisplay();
}
function restartPolling() {
  clearTimeout(S.board.timer); S.board.timer = null;
  const gen = S.board.gen = (S.board.gen || 0) + 1; // stops older loops still waiting on a request
  const needs = (S.tab === 'display') || (S.tab === 'leaderboard' && !canReadData());
  if (!needs || !S.tid) return;
  const secs = S.tab === 'display' ? CFG.screenPollSeconds : CFG.publicPollSeconds;
  const loop = async () => {
    if (gen !== S.board.gen) return;
    await pollBoard();
    if (gen !== S.board.gen) return;
    S.board.timer = setTimeout(loop, (secs + Math.random() * 5) * 1000); // jitter spreads load
  };
  loop();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) restartPolling(); });

function startDisplay() {
  clearInterval(S.displayTimer);
  S.displayIdx = 0; renderDisplay();
  S.displayTimer = setInterval(() => { S.displayIdx++; renderDisplay(); }, CFG.boardRotateSeconds * 1000);
}
const TV_LINES = 11; // rows per TV slide (section headers count as a line)
function displaySlides(data) {
  const boards = (data?.boards || []);
  const withData = boards.filter(boardHasData);
  const slides = [];
  for (const b of (withData.length ? withData : boards)) {
    if (!b.groups) { slides.push({ title: b.title, sections: [{ name: null, rows: b.rows }] }); continue; }
    // Grouped board: keep sections whole where possible, split long ones across pages.
    const pages = []; let cur = [], lines = 0;
    for (const g of b.groups.filter(g => g.rows.length).length ? b.groups.filter(g => g.rows.length) : b.groups) {
      let rows = g.rows.length ? g.rows : [];
      do {
        const room = TV_LINES - lines - 1;
        if (room < 2 && cur.length) { pages.push(cur); cur = []; lines = 0; continue; }
        const part = rows.slice(0, Math.max(room, 1));
        cur.push({ name: g.name + (rows !== g.rows ? ' (cont.)' : ''), rows: part, empty: !g.rows.length });
        lines += 1 + Math.max(part.length, 1);
        rows = rows.slice(part.length);
      } while (rows.length);
    }
    if (cur.length) pages.push(cur);
    pages.forEach((p, i) => slides.push({ title: b.title + (pages.length > 1 ? ` (${i + 1}/${pages.length})` : ''), sections: p }));
  }
  return slides;
}
function renderDisplay() {
  const data = S.board.data; // the TV always uses the polled RPC
  $('displayTournament').textContent = data?.tournament ? `${data.tournament.name} (${data.tournament.year})` : '';
  const slides = displaySlides(data);
  if (!slides.length) { $('displayTitle').textContent = 'LIVE LEADERBOARD'; $('displayBoard').innerHTML = `<p class="text-center text-slate-400">${data?.error ? 'This leaderboard isn\'t available.' : data ? 'No weigh-ins yet.' : 'Loading…'}</p>`; return; }
  const sl = slides[S.displayIdx % slides.length];
  const grouped = sl.sections.some(x => x.name);
  $('displayTitle').textContent = sl.title.toUpperCase();
  $('displayBoard').innerHTML = sl.sections.map(sec => `
    ${sec.name ? `<div class="text-xl font-semibold uppercase tracking-wider text-sky-300 mt-4 border-b border-sky-800 pb-1">${esc(sec.name)}</div>` : ''}
    ${sec.rows.map(r => `<div class="flex justify-between border-b border-slate-700 ${grouped ? 'py-1 text-2xl' : 'py-2'}"><span>${r.rank}. ${esc(r.name)} <span class="text-slate-400 text-xl">${esc(r.group || '')}</span></span><span class="font-bold">${formatLbs(r.lbs)}</span></div>`).join('')
      || `<p class="text-slate-500 text-xl py-1">No fish yet</p>`}`).join('');
  $('displayUpdated').textContent = S.board.at ? 'Updated ' + S.board.at.toLocaleTimeString() : '';
}

// ---------------------------------------------------------------- startup
document.addEventListener('DOMContentLoaded', async () => {
  if (SCREEN_MODE) document.body.classList.add('screen-mode');
  if (BOARD_MODE) { document.body.classList.add('board-mode'); document.title = 'Leaderboard'; }
  $('stationName').value = LS.get('ift.station', '') || '';
  renderConn();
  const { data } = await sb.auth.getSession();
  await onSession(data.session);
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' && session?.user?.id !== S.user?.id) setTimeout(() => onSession(session), 0);
    else if (event === 'SIGNED_OUT') setTimeout(() => { unsubscribeRealtime(); onSession(null); }, 0);
    else if (session) S.session = session;
  });
});
