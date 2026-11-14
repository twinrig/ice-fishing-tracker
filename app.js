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

const ROLE_LABEL = { admin: 'Admin', gate: 'Check-in / Gate', weigh: 'Weigh Station', screen: 'Big Screen' };
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
const params = new URLSearchParams(location.search);
const SCREEN_MODE = params.get('screen') === '1';

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
function formatOz(oz) {
  oz = Number(oz) || 0;
  const lbs = Math.floor(oz / 16 + 1e-9);
  return `${lbs} lb ${+(oz - lbs * 16).toFixed(2)} oz`;
}
function msg(id, text, ok = true) { const el = $(id); if (!el) return; el.textContent = text; el.className = (el.className.replace(/text-(red|green)-\d+/g, '') + (ok ? ' text-green-700' : ' text-red-600')).trim(); }
function closeModal(id) { $(id)?.classList.add('hidden'); }
function openModal(id) { $(id)?.classList.remove('hidden'); }
function canReadData() { return S.roles.some(r => ['admin', 'gate', 'weigh'].includes(r)); }
function hasRole(r) { return S.roles.includes('admin') || S.roles.includes(r); }
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
let Q = LS.get('ift.queue', []);
let FAILED = LS.get('ift.failed', []);
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
  if (op.kind === 'insert') return `Weigh-in: ${formatOz(op.row.weight_oz)}`;
  return `Weigh-in update (${Object.keys(op.patch).join(', ')})`;
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
  await sb.auth.signOut();
}
async function onSession(session) {
  S.session = session; S.user = session?.user || null;
  if (S.user) {
    const { data, error } = await sb.from('staff_roles').select('role, display_name').eq('user_id', S.user.id);
    if (!error) { S.roles = data.map(r => r.role); LS.set('ift.roles.' + S.user.id, S.roles); }
    else S.roles = LS.get('ift.roles.' + S.user.id, []);
  } else S.roles = [];
  renderAuth();
  await loadTournamentList();
  if (S.session) flushQueue();
}
function renderAuth() {
  const signedIn = !!S.user;
  $('signInBtn').classList.toggle('hidden', signedIn || SCREEN_MODE);
  $('signOutBtn').classList.toggle('hidden', !signedIn);
  $('userBadge').textContent = signedIn ? S.user.email + (S.roles.length ? '' : ' (no staff role yet)') : '';
  const rs = $('roleSelect');
  const roles = S.roles.includes('admin') ? ['admin', 'gate', 'weigh', 'screen'] : S.roles;
  rs.innerHTML = roles.map(r => `<option value="${r}">${ROLE_LABEL[r]}</option>`).join('');
  rs.classList.toggle('hidden', !roles.length);
  const saved = LS.get('ift.stationRole', null);
  const role = roles.includes(saved) ? saved : (roles[0] || 'public');
  if (roles.length) rs.value = role;
  applyRole(role, true);
}
function applyRole(role, silent) {
  S.role = role || 'public';
  if (!silent && role !== 'public') LS.set('ift.stationRole', role);
  const allowed = ROLE_TABS[S.role] || ROLE_TABS.public;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('hidden', !allowed.includes(b.dataset.tab)));
  if (SCREEN_MODE) return showTab('display');
  showTab(allowed.includes(S.tab) ? S.tab : allowed[0]);
}

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
  const wanted = params.get('t') || LS.get('ift.tid', null);
  const pick = S.tournaments.find(t => t.id === wanted) || S.tournaments.find(t => t.status === 'active') || S.tournaments[0];
  await selectTournament(pick ? pick.id : null);
}

async function selectTournament(tid) {
  S.tid = tid || null;
  $('tournamentSelect').value = S.tid || '';
  if (S.tid) LS.set('ift.tid', S.tid);
  S.board = { data: null, version: null, tid: S.tid, timer: S.board.timer, at: null };
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

function cacheKey() { return 'ift.cache.' + S.tid; }
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
      sb.from('tournaments').select('*').eq('id', tid).single(),
      sb.from('species').select('*').eq('tournament_id', tid).order('sort_order').order('name'),
      sb.from('leaderboard_configs').select('*').eq('tournament_id', tid).order('sort_order').order('created_at')
    ]);
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
  $('ageGroups').value = 'Youth, Adult, Senior'; $('speciesList').value = 'Walleye, Perch, Pike, Crappie';
  $('setupMsg').textContent = ''; $('publicLinks').innerHTML = '';
}
function fillSetupForm() {
  if (!S.t) { if (!S.tid) newTournamentForm(); return; }
  S.editingNew = false;
  $('setupTitle').textContent = 'Tournament Setup – ' + S.t.name;
  $('tName').value = S.t.name; $('tYear').value = S.t.year; $('tDate').value = S.t.event_date || '';
  $('tStatus').value = S.t.status; $('tPublic').checked = !!S.t.public_visible;
  $('ageGroups').value = (S.t.age_groups || []).join(', ');
  $('speciesList').value = S.species.map(s => s.name).join(', ');
  const base = location.origin + location.pathname;
  $('publicLinks').innerHTML = `Public leaderboard: <a class="text-blue-700 underline" href="${base}?t=${S.t.id}" target="_blank">${esc(base)}?t=${S.t.id}</a><br>
    Big screen (TV, no sign-in): <a class="text-blue-700 underline" href="${base}?t=${S.t.id}&screen=1" target="_blank">${esc(base)}?t=${S.t.id}&amp;screen=1</a>`;
}
async function saveTournament() {
  if (!hasRole('admin')) return msg('setupMsg', 'Admin only', false);
  const year = parseInt($('tYear').value, 10);
  if (!year || year < 2020 || year > 2100) return msg('setupMsg', 'Year is required (2020–2100)', false);
  const row = {
    name: $('tName').value.trim() || 'Untitled', year, event_date: $('tDate').value || null,
    status: $('tStatus').value, public_visible: $('tPublic').checked,
    age_groups: $('ageGroups').value.split(',').map(s => s.trim()).filter(Boolean)
  };
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

function boardFilterOptions(c) {
  if (c.board_type === 'species') return `<option value="">Each species</option>` + S.species.map(s => `<option value="${s.id}" ${c.species_id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  if (c.board_type === 'age_group') return `<option value="">Each age group</option>` + (S.t?.age_groups || []).map(g => `<option value="${esc(g)}" ${c.age_group === g ? 'selected' : ''}>${esc(g)}</option>`).join('');
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
        ${['overall', 'species', 'age_group'].map(t => `<option value="${t}" ${c.board_type === t ? 'selected' : ''}>${{ overall: 'Overall', species: 'Species', age_group: 'Age group' }[t]}</option>`).join('')}
      </select>
      <select class="cf-filter border rounded px-2 py-1">${filterOpts(c)}</select>
      <select class="cf-scoring border rounded px-2 py-1">
        <option value="total_weight" ${c.scoring === 'total_weight' ? 'selected' : ''}>Total weight</option>
        <option value="biggest_fish" ${c.scoring === 'biggest_fish' ? 'selected' : ''}>Biggest fish</option>
      </select>
      <label>Top <input class="cf-top border rounded px-2 py-1 w-14" type="number" min="1" max="100" value="${c.top_n}"></label>
      <label class="flex items-center gap-1"><input class="cf-enabled" type="checkbox" ${c.enabled ? 'checked' : ''}> On</label>
      <button onclick="saveBoardConfig('${c.id}')" class="bg-blue-600 text-white px-2 py-1 rounded">Save</button>
      <button onclick="deleteBoardConfig('${c.id}')" class="border px-2 py-1 rounded text-red-700">Delete</button>
    </div>`).join('') || '<p class="text-slate-500">No leaderboards configured.</p>';
}
async function saveBoardConfig(id) {
  const row = document.querySelector(`[data-id="${id}"]`);
  const type = row.querySelector('.cf-type').value, filter = row.querySelector('.cf-filter').value || null;
  const patch = {
    title: row.querySelector('.cf-title').value.trim() || 'Leaderboard', board_type: type,
    scoring: row.querySelector('.cf-scoring').value, top_n: parseInt(row.querySelector('.cf-top').value, 10) || 10,
    sort_order: parseInt(row.querySelector('.cf-order').value, 10) || 0, enabled: row.querySelector('.cf-enabled').checked,
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

async function importParticipantsCSV() {
  if (!S.t) return msg('importMsg', 'Save the tournament first.', false);
  let text; try { text = await readFile($('csvFile')); } catch (e) { return msg('importMsg', e.message, false); }
  const rows = parseCSV(text);
  if (rows.length < 2) return msg('importMsg', 'CSV appears empty or missing header.', false);
  const h = rows[0].map(x => x.toLowerCase().replace(/[^a-z]/g, ''));
  const ni = h.findIndex(x => x.includes('name')), ai = h.findIndex(x => x.includes('age') || x.includes('group'));
  const ei = headerIndex(h, 'email', 'emailaddress'), pi = headerIndex(h, 'phone', 'phonenumber', 'cell');
  const ci = headerIndex(h, 'id', 'code', 'participantid', 'participantcode', 'number');
  if (ni === -1) return msg('importMsg', 'CSV must have a "name" column.', false);
  const source = $('csvSource').value;
  const existingIds = new Set(S.participants.map(p => p.id));
  const out = [];
  for (const r of rows.slice(1)) {
    const name = r[ni]; if (!name) continue;
    const code = ci >= 0 && r[ci] ? normCode(S.t.year, r[ci]) : null;
    const email = ei >= 0 ? r[ei] || null : null, phone = pi >= 0 ? r[pi] || null : null;
    const id = await hashUuid([S.tid, name.toLowerCase(), (email || '').toLowerCase(), phone || '', code || ''].join('|'));
    if (existingIds.has(id)) continue;
    existingIds.add(id);
    out.push({ id, tournament_id: S.tid, display_name: name, age_group: (ai >= 0 && r[ai]) || S.t.age_groups?.[0] || null,
      email, phone, participant_code: code, source, check_in_status: source === 'walkup' ? 'arrived' : 'not_arrived' });
  }
  if (!out.length) return msg('importMsg', 'Nothing new to import (already imported?).');
  msg('importMsg', `Importing ${out.length}…`);
  for (let i = 0; i < out.length; i += 200) {
    const { error } = await sb.from('participants').upsert(out.slice(i, i + 200), { onConflict: 'id', ignoreDuplicates: true });
    if (error) return msg('importMsg', `Stopped after ${i} rows: ${error.message}`, false);
  }
  $('csvFile').value = '';
  await loadTournamentData();
  msg('importMsg', `Imported ${out.length} participants.`);
}

function exportParticipants() {
  const rows = [['id', 'name', 'age_group', 'email', 'phone', 'source', 'check_in', 'checked_in_at']]
    .concat(S.participants.slice().sort((a, b) => (a.participant_code || '').localeCompare(b.participant_code || ''))
      .map(p => [p.participant_code, p.display_name, p.age_group, p.email, p.phone, p.source, p.check_in_status, p.checked_in_at]));
  download(`${slug(S.t?.name)}-participants.csv`, toCSV(rows));
}
function exportCatches() {
  const pById = Object.fromEntries(S.participants.map(p => [p.id, p])), sById = Object.fromEntries(S.species.map(s => [s.id, s]));
  const rows = [['ticket', 'id', 'name', 'age_group', 'species', 'lbs', 'oz', 'weight_oz', 'length_in', 'station', 'initials', 'weighed_at', 'status', 'void_reason']]
    .concat(S.catches.slice().sort((a, b) => (a.weighed_at || '').localeCompare(b.weighed_at || '')).map(c => {
      const p = pById[c.participant_id] || {}, w = Number(c.weight_oz), lbs = Math.floor(w / 16 + 1e-9);
      return [c.id, p.participant_code, p.display_name, p.age_group, sById[c.species_id]?.name, lbs, (w - lbs * 16).toFixed(2), w, c.length_in, c.station, c.staff_initials, c.weighed_at, c.status, c.void_reason];
    }));
  download(`${slug(S.t?.name)}-weigh-ins.csv`, toCSV(rows));
}
function exportLeaderboard() {
  const data = currentBoards();
  const rows = [['board', 'rank', 'name', 'age_group', 'fish', 'weight_oz', 'weight']];
  (data?.boards || []).forEach(b => b.rows.forEach(r => rows.push([b.title, r.rank, r.name, r.group, r.fish, r.oz, formatOz(r.oz)])));
  download(`${slug(S.t?.name || data?.tournament?.name)}-leaderboard.csv`, toCSV(rows));
}

// ---------------------------------------------------------------- gate
function populateSelects() {
  const groups = S.t?.age_groups || [];
  const curAge = $('wAge').value;
  $('wAge').innerHTML = groups.map(a => `<option>${esc(a)}</option>`).join('');
  if (curAge) $('wAge').value = curAge;
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

function openWalkup() {
  if (!S.t) return alert('Select or create a tournament first');
  ['wName', 'wEmail', 'wPhone'].forEach(id => $(id).value = '');
  populateSelects(); openModal('modal'); $('wName').focus();
}
function createWalkup() {
  const name = $('wName').value.trim(); if (!name) return;
  const row = {
    id: uuid(), tournament_id: S.tid, participant_code: takeCode(), display_name: name,
    age_group: $('wAge').value || null, email: $('wEmail').value.trim() || null, phone: $('wPhone').value.trim() || null,
    source: 'walkup', check_in_status: 'arrived', checked_in_at: new Date().toISOString(), created_at: new Date().toISOString()
  };
  enqueue({ kind: 'insert', table: 'participants', row });
  closeModal('modal');
  if (row.participant_code) printParticipantCard(row);
  else alert('Saved. No reserved badge number was available on this laptop, so the number will be assigned when it syncs. Print the card from the list after that.');
  ensureCodePool();
}

function renderParticipants() {
  const el = $('participantList'); if (!el) return;
  if (!canReadData()) { el.innerHTML = '<p class="text-slate-500">Sign in as gate or admin staff.</p>'; return; }
  const f = $('partFilter').value.trim().toLowerCase();
  const list = S.participants.filter(p => !f || p.display_name.toLowerCase().includes(f) || (p.participant_code || '').includes(f))
    .sort((a, b) => (a.participant_code || 'z').localeCompare(b.participant_code || 'z'));
  const arrived = S.participants.filter(p => p.check_in_status === 'arrived').length;
  $('partCount').textContent = `${S.participants.length} registered • ${arrived} checked in`;
  el.innerHTML = list.slice(0, 300).map(p => `
    <div class="flex justify-between items-center border rounded p-3 ${p._failed ? 'border-red-400' : ''}">
      <div>
        <div class="font-medium">${esc(p.display_name)} ${p._pending ? '<span class="text-xs text-amber-700">(not synced)</span>' : ''}</div>
        <div class="text-sm text-slate-500">${esc(p.age_group)} • ID: ${esc(p.participant_code || 'pending')} •
          <span class="${p.check_in_status === 'arrived' ? 'text-green-600' : 'text-amber-600'}">${p.check_in_status.replace('_', ' ')}</span></div>
      </div>
      <div class="flex gap-2">
        <button onclick="toggleCheckIn('${p.id}')" class="text-sm px-3 py-1 bg-slate-200 rounded">Toggle Check-in</button>
        <button onclick="printParticipantCardById('${p.id}')" class="text-sm px-3 py-1 bg-blue-100 rounded" ${p.participant_code ? '' : 'disabled'}>Print Card</button>
      </div>
    </div>`).join('') + (list.length > 300 ? `<p class="text-xs text-slate-500">Showing 300 of ${list.length}. Use the filter.</p>` : '')
    || '<p class="text-slate-500">No participants yet. Add a walk-up or import a CSV.</p>';
}
function setCheckIn(p, status) {
  const patch = { check_in_status: status, checked_in_at: status === 'arrived' ? new Date().toISOString() : null };
  enqueue({ kind: 'update', table: 'participants', id: p.id, patch });
}
function toggleCheckIn(id) { const p = S.participants.find(x => x.id === id); if (p) setCheckIn(p, p.check_in_status === 'arrived' ? 'not_arrived' : 'arrived'); }
function checkInLookup() {
  const code = normCode(S.t?.year, $('checkNum').value);
  if (!code) return msg('checkInResult', 'Enter a participant number', false);
  const p = S.participants.find(x => x.participant_code === code);
  if (!p) return msg('checkInResult', 'Not found: ' + code, false);
  if (p.check_in_status !== 'arrived') setCheckIn(p, 'arrived');
  msg('checkInResult', `Checked in: ${p.display_name} (${p.age_group || ''})`);
  $('checkNum').value = ''; $('checkNum').focus();
}

// ---------------------------------------------------------------- printing
function showPrintPreview(html) { $('printPreviewContent').innerHTML = html; $('printArea').innerHTML = html; openModal('printPreviewModal'); }
function doPrint() { try { window.print(); } catch (e) { alert('Print dialog blocked. Use the browser menu to print.'); } }
function printParticipantCardById(id) { const p = S.participants.find(x => x.id === id); if (p?.participant_code) printParticipantCard(p); }
function printParticipantCard(p) {
  const card = `<div class="print-card">
      <div class="font-bold text-sm">${esc(S.t?.name || 'Tournament')}</div>
      <div class="text-lg font-bold mt-1">${esc(p.display_name)}</div>
      <div class="text-xs mb-2">${esc(p.age_group)}</div>
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
  const w = Number(c.weight_oz), lbs = Math.floor(w / 16 + 1e-9);
  const sp = S.species.find(s => s.id === c.species_id)?.name || '';
  showPrintPreview(`<div class="print-ticket">
      <div class="font-bold text-xs">WEIGH TICKET</div>
      <div class="font-bold">${esc(p.display_name)}</div>
      <div class="font-mono text-xs">${esc(p.participant_code || '')}</div>
      <div>${esc(sp)}</div>
      <div class="text-lg font-bold">${formatOz(w)}</div>
      <div>${c.length_in ? esc(c.length_in) + '" • ' : ''}${new Date(c.weighed_at).toLocaleTimeString()}</div>
      <div class="text-xs">Staff: ${esc(c.staff_initials || '—')} • ${esc(c.station || '')}</div>
      <div class="font-mono text-[9px] mt-1">${c.id.slice(0, 8)}</div>
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
  $('pInfo').textContent = `${p.display_name} • ${p.age_group || ''} • ${code}` + (p.check_in_status !== 'arrived' ? ' • NOT CHECKED IN' : '');
  $('weighMsg').textContent = '';
  populateSelects();
  $('scanNum').value = ''; $('weightLbs').focus();
}
function submitWeighIn() {
  const p = S.currentParticipant; if (!p) return;
  const lbs = parseFloat($('weightLbs').value) || 0, oz = parseFloat($('weightOz').value) || 0;
  if (oz >= 16) return msg('weighMsg', 'Ounces must be under 16', false);
  const total = Math.round((lbs * 16 + oz) * 100) / 100;
  if (total <= 0) return msg('weighMsg', 'Enter a weight', false);
  if (!$('species').value) return msg('weighMsg', 'No species set up for this tournament', false);
  const len = parseFloat($('length').value);
  const row = {
    id: uuid(), tournament_id: S.tid, participant_id: p.id, species_id: $('species').value, weight_oz: total,
    length_in: len > 0 ? len : null, station: $('stationName').value.trim() || null,
    staff_initials: $('initials').value.trim() || null, weighed_at: new Date().toISOString(), source: 'station', status: 'active'
  };
  enqueue({ kind: 'insert', table: 'catches', row: { ...row } });
  const local = S.catches.find(c => c.id === row.id); if (local) local.recorded_by = S.user?.id;
  printWeighTicket(p, row);
  ['weightLbs', 'weightOz', 'length'].forEach(id => $(id).value = '');
  $('weighForm').classList.add('hidden'); S.currentParticipant = null;
  msg('weighMsg', `Recorded ${formatOz(total)} for ${p.display_name}`);
  $('scanNum').focus();
}
function renderRecentCatches() {
  const el = $('recentCatches'); if (!el) return;
  const pById = Object.fromEntries(S.participants.map(p => [p.id, p])), sById = Object.fromEntries(S.species.map(s => [s.id, s]));
  const list = S.catches.slice().sort((a, b) => (b.weighed_at || '').localeCompare(a.weighed_at || '')).slice(0, 40);
  el.innerHTML = list.map(c => {
    const canVoid = c.status === 'active' && (hasRole('admin') || (hasRole('weigh') && (c.recorded_by === S.user?.id || c._pending)));
    return `<div class="flex justify-between items-center border-b py-1 ${c.status === 'voided' ? 'line-through text-slate-400' : ''}">
      <span>${new Date(c.weighed_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} • ${esc(pById[c.participant_id]?.display_name || '?')} • ${esc(sById[c.species_id]?.name || '')} • <b>${formatOz(c.weight_oz)}</b>
      ${c._pending ? '<span class="text-xs text-amber-700">(not synced)</span>' : ''} <span class="text-xs text-slate-400">${esc(c.station || '')}</span></span>
      ${canVoid ? `<button onclick="voidCatch('${c.id}')" class="text-xs text-red-700 border px-2 rounded">Void</button>` : ''}
    </div>`;
  }).join('') || '<p class="text-slate-500">No weigh-ins yet.</p>';
}
function voidCatch(id) {
  const reason = prompt('Reason for voiding this weigh-in?'); if (reason === null) return;
  enqueue({ kind: 'update', table: 'catches', id, patch: { status: 'voided', void_reason: reason.slice(0, 200) || null } });
}
async function importTicketsCSV() {
  if (!S.t) return msg('ticketMsg', 'Select a tournament first.', false);
  let text; try { text = await readFile($('ticketFile')); } catch (e) { return msg('ticketMsg', e.message, false); }
  const rows = parseCSV(text);
  if (rows.length < 2) return msg('ticketMsg', 'CSV appears empty.', false);
  const h = rows[0].map(x => x.toLowerCase().replace(/[^a-z]/g, ''));
  const ix = { code: headerIndex(h, 'id', 'participantid', 'participant', 'code', 'number'), sp: headerIndex(h, 'species', 'fish'),
    lbs: headerIndex(h, 'lbs', 'lb', 'pounds', 'weightlbs'), oz: headerIndex(h, 'oz', 'ounces'), woz: headerIndex(h, 'weightoz', 'totaloz'),
    len: headerIndex(h, 'length', 'lengthin'), ini: headerIndex(h, 'initials', 'staff'), st: headerIndex(h, 'station'),
    time: headerIndex(h, 'time', 'weighedat', 'timestamp'), ticket: headerIndex(h, 'ticket', 'ticketid') };
  if (ix.code < 0 || ix.sp < 0 || (ix.lbs < 0 && ix.oz < 0 && ix.woz < 0)) return msg('ticketMsg', 'Need id, species and weight columns.', false);
  const byCode = Object.fromEntries(S.participants.map(p => [p.participant_code, p]));
  const bySp = Object.fromEntries(S.species.map(s => [s.name.toLowerCase(), s]));
  const known = new Set(S.catches.map(c => c.id));
  let added = 0; const errs = [];
  for (const [n, r] of rows.slice(1).entries()) {
    const p = byCode[normCode(S.t.year, r[ix.code])], sp = bySp[(r[ix.sp] || '').toLowerCase()];
    const woz = ix.woz >= 0 && r[ix.woz] ? parseFloat(r[ix.woz]) : (parseFloat(r[ix.lbs]) || 0) * 16 + (parseFloat(r[ix.oz]) || 0);
    if (!p) { errs.push(`row ${n + 2}: unknown participant`); continue; }
    if (!sp) { errs.push(`row ${n + 2}: unknown species`); continue; }
    if (!(woz > 0)) { errs.push(`row ${n + 2}: bad weight`); continue; }
    let when = ix.time >= 0 && r[ix.time] ? new Date(r[ix.time]) : null;
    if (when && isNaN(when)) when = null;
    const ticket = ix.ticket >= 0 ? r[ix.ticket] : '';
    const id = /^[0-9a-f-]{36}$/i.test(ticket) ? ticket : await hashUuid([S.tid, p.id, sp.id, woz, ticket || (when ? when.toISOString() : n)].join('|'));
    if (known.has(id)) continue; known.add(id);
    enqueue({ kind: 'insert', table: 'catches', row: { id, tournament_id: S.tid, participant_id: p.id, species_id: sp.id,
      weight_oz: Math.round(woz * 100) / 100, length_in: parseFloat(r[ix.len]) > 0 ? parseFloat(r[ix.len]) : null,
      staff_initials: ix.ini >= 0 ? (r[ix.ini] || '').slice(0, 10) || null : null, station: ix.st >= 0 ? r[ix.st] || null : 'Import',
      weighed_at: (when || new Date()).toISOString(), source: 'import', status: 'active' } });
    added++;
  }
  $('ticketFile').value = '';
  msg('ticketMsg', `Queued ${added} weigh-ins.` + (errs.length ? ` Skipped ${errs.length}: ${errs.slice(0, 5).join('; ')}` : ''), !errs.length);
}

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
      const w = Number(c.weight_oz); a.fish++; a.sum += w; a.max = Math.max(a.max, w);
    }
    const list = Object.entries(agg).map(([pid, a]) => ({ p: pById[pid], fish: a.fish, oz: Math.round((scoring === 'biggest_fish' ? a.max : a.sum) * 100) / 100 }))
      .filter(x => x.p && (!ageGroup || x.p.age_group === ageGroup))
      .sort((a, b) => b.oz - a.oz || a.p.display_name.localeCompare(b.p.display_name));
    let rank = 0;
    return list.slice(0, topN).map((x, i) => { if (i === 0 || x.oz !== list[i - 1].oz) rank = i + 1; return { rank, name: x.p.display_name, group: x.p.age_group, fish: x.fish, oz: x.oz }; });
  };
  const boards = [];
  for (const c of S.configs.filter(c => c.enabled).sort((a, b) => a.sort_order - b.sort_order)) {
    if (c.board_type === 'species' && !c.species_id) S.species.forEach(s => boards.push({ title: `${c.title} – ${s.name}`, scoring: c.scoring, rows: rowsFor(c.scoring, s.id, null, c.top_n) }));
    else if (c.board_type === 'age_group' && !c.age_group) (S.t.age_groups || []).forEach(g => boards.push({ title: `${c.title} – ${g}`, scoring: c.scoring, rows: rowsFor(c.scoring, null, g, c.top_n) }));
    else boards.push({ title: c.title, scoring: c.scoring, rows: rowsFor(c.scoring, c.species_id, c.age_group, c.top_n) });
  }
  return { tournament: { id: S.t.id, name: S.t.name, year: S.t.year, status: S.t.status }, boards, local: true };
}
function currentBoards() { return canReadData() && S.t ? computeBoards() : S.board.data; }

function renderLeaderboard() {
  const data = currentBoards();
  $('boardHeading').textContent = data?.tournament ? `${data.tournament.name} – Leaderboard` : 'Leaderboard';
  $('boardUpdated').textContent = data?.local ? 'Live (this station)' : (S.board.at ? 'Updated ' + S.board.at.toLocaleTimeString() + ` • refreshes every ${CFG.publicPollSeconds}s` : '');
  if (!data) { $('boardContent').innerHTML = `<p class="text-slate-500">${S.tid ? 'Loading…' : 'No public tournament yet.'}</p>`; return; }
  if (data.error) { $('boardContent').innerHTML = '<p class="text-slate-500">This tournament is not public.</p>'; return; }
  $('boardContent').innerHTML = data.boards.map(b => `
    <div class="border rounded-lg p-4">
      <h3 class="font-semibold mb-2">${esc(b.title)} <span class="text-xs font-normal text-slate-500">${b.scoring === 'biggest_fish' ? 'biggest fish' : 'total weight'}</span></h3>
      ${b.rows.map(r => `<div class="flex justify-between py-1 border-b text-sm"><span>${r.rank}. ${esc(r.name)} <span class="text-slate-400">${esc(r.group || '')}</span></span><span class="font-bold">${formatOz(r.oz)}</span></div>`).join('') || '<div class="text-sm text-slate-500">No fish yet</div>'}
    </div>`).join('') || '<p class="text-slate-500">No leaderboards configured.</p>';
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
  if (!data.unchanged) { S.board.data = data; S.board.version = data.v ?? null; }
  if (S.tab === 'leaderboard') renderLeaderboard();
  if (S.tab === 'display') renderDisplay();
}
function restartPolling() {
  clearTimeout(S.board.timer); S.board.timer = null;
  const needs = (S.tab === 'display') || (S.tab === 'leaderboard' && !canReadData());
  if (!needs || !S.tid) return;
  const secs = S.tab === 'display' ? CFG.screenPollSeconds : CFG.publicPollSeconds;
  const loop = async () => {
    await pollBoard();
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
function renderDisplay() {
  const data = S.board.data; // the TV always uses the polled RPC
  $('displayTournament').textContent = data?.tournament ? `${data.tournament.name} (${data.tournament.year})` : '';
  const boards = (data?.boards || []).filter(b => b.rows.length) ;
  const list = boards.length ? boards : (data?.boards || []);
  if (!list.length) { $('displayTitle').textContent = 'LIVE LEADERBOARD'; $('displayBoard').innerHTML = `<p class="text-center text-slate-400">${data ? 'No weigh-ins yet.' : 'Loading…'}</p>`; return; }
  const b = list[S.displayIdx % list.length];
  $('displayTitle').textContent = b.title.toUpperCase();
  $('displayBoard').innerHTML = b.rows.map(r => `<div class="flex justify-between border-b border-slate-700 py-2"><span>${r.rank}. ${esc(r.name)} <span class="text-slate-400 text-xl">${esc(r.group || '')}</span></span><span class="font-bold">${formatOz(r.oz)}</span></div>`).join('') || '<p class="text-center text-slate-400">No fish yet</p>';
  $('displayUpdated').textContent = S.board.at ? 'Updated ' + S.board.at.toLocaleTimeString() : '';
}

// ---------------------------------------------------------------- startup
document.addEventListener('DOMContentLoaded', async () => {
  if (SCREEN_MODE) document.body.classList.add('screen-mode');
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
