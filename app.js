'use strict';
/* =====================================================================
   DK Boxing Fitness — Member Tracker
   Public: roster + each boxer's progress (no fees, no private details).
   Coach: members, attendance, fees, progress, settings.
   ===================================================================== */

const sb = supabase.createClient(window.DK_CONFIG.supabaseUrl, window.DK_CONFIG.supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true }
});

// ---------- constants ----------
const INACTIVE_DAYS = 14;
const ATTENDANCE_WINDOW = 8;      // sessions used for the attendance rate
const ATTENDANCE_LOAD_DAYS = 400; // how far back attendance is loaded
const MAX_FILE_MB = 5;
const SKILLS = [
  {key:'offence', label:'Offence'},
  {key:'defence', label:'Defence'},
  {key:'footwork', label:'Footwork'},
  {key:'accuracy', label:'Accuracy'},
  {key:'timing', label:'Timing'},
  {key:'speed', label:'Speed'},
  {key:'cardio', label:'Cardio'},
  {key:'balance', label:'Balance'},
  {key:'discipline', label:'Discipline'}
];
const ALL_DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const METHOD_LABEL = { cash:'Cash', bank:'Bank transfer', other:'Other' };

// ---------- dates (always the phone's local date) ----------
let TODAY = new Date();
const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const LONG_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const SHORT_DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const pad2 = n => String(n).padStart(2,'0');
const dateKey = d => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
const periodKey = d => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-01`;
const todayKey = () => dateKey(TODAY);
const currentPeriod = () => periodKey(TODAY);
function parseKey(k){
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(k || '');
  return m ? new Date(+m[1], +m[2]-1, +m[3]) : null;
}
function addDays(d, n){ const x = new Date(d); x.setDate(x.getDate()+n); return x; }
function monthEndKey(period){ const d = parseKey(period); return dateKey(new Date(d.getFullYear(), d.getMonth()+1, 0)); }
function daysBetween(fromKey, toKey){
  const a = parseKey(fromKey), b = parseKey(toKey);
  return (a && b) ? Math.round((b - a) / 86400000) : Infinity;
}
function fmtDay(k){ const d = parseKey(k); return d ? `${d.getDate()} ${SHORT_MONTHS[d.getMonth()]} ${d.getFullYear()}` : ''; }
function fmtDayShort(k){ const d = parseKey(k); return d ? `${d.getDate()} ${SHORT_MONTHS[d.getMonth()]}` : ''; }
function fmtWeekday(k){ const d = parseKey(k); return d ? `${SHORT_DAYS[d.getDay()]}, ${d.getDate()} ${SHORT_MONTHS[d.getMonth()]}` : ''; }
function fmtMonth(period){ const d = parseKey(period); return d ? `${LONG_MONTHS[d.getMonth()]} ${d.getFullYear()}` : ''; }
function fmtMonthYear(k){ const d = parseKey(k); return d ? `${SHORT_MONTHS[d.getMonth()]} ${d.getFullYear()}` : ''; }
const rs = n => 'Rs. ' + Number(n || 0).toLocaleString('en-US');
function ageFrom(dob){
  const d = parseKey(dob); if(!d) return '';
  let a = TODAY.getFullYear() - d.getFullYear();
  if(TODAY.getMonth() < d.getMonth() || (TODAY.getMonth() === d.getMonth() && TODAY.getDate() < d.getDate())) a--;
  return a >= 0 ? String(a) : '';
}
function seenText(days){
  if(days === Infinity) return 'never';
  if(days <= 0) return 'today';
  if(days === 1) return 'yesterday';
  return days + ' days ago';
}

// ---------- safety ----------
function esc(v){
  return String(v == null ? '' : v)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
const $ = id => document.getElementById(id);

// ---------- toast ----------
let toastTimer = null;
function showToast(msg, type){
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show' + (type === 'error' ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>{ el.className = 'toast' + (type === 'error' ? ' error' : ''); }, type === 'error' ? 5000 : 2200);
}

// ---------- saving: every change goes through here ----------
// If a save fails, the coach is told and the screen is reloaded from the
// database, so it never shows changes that weren't really saved.
async function save(label, request, opts){
  opts = opts || {};
  try{
    const { data, error } = await request;
    if(error) throw error;
    if(opts.expectRows && (!data || (Array.isArray(data) && !data.length))) throw new Error('Nothing was changed (permission problem?)');
    if(opts.success) showToast(opts.success);
    return { ok:true, data };
  }catch(err){
    console.error('Save failed — ' + label, err);
    const msg = err && err.code === '23505'
      ? `That ${label} was already recorded. Showing the latest data.`
      : !navigator.onLine
        ? `You're offline, so ${label} wasn't saved. Reconnect and try again.`
        : `Couldn't save ${label}. Check your connection and try again.`;
    showToast(msg, 'error');
    await reloadAll();
    return { ok:false, error: err };
  }
}

// Supabase returns at most 1000 rows per request, so page through bigger tables.
async function fetchAll(makeQuery){
  const all = [];
  for(let from = 0; ; from += 1000){
    const { data, error } = await makeQuery().range(from, from + 999);
    if(error) return { data:null, error };
    all.push(...data);
    if(data.length < 1000) return { data: all, error:null };
  }
}

// =====================================================================
// STATE
// =====================================================================
const state = {
  members: [], sessions: [],
  coach: null,
  details: new Map(), attendance: new Map(), payments: [],
  settings: { admission_fee: 1000, monthly_fee: 3000 },
  sessionDays: [], sessionsByMember: new Map(), paymentsByMember: new Map(),
  dashboardBuilt: false
};
const memberById = id => state.members.find(m => m.id === id);
const activeMembers = () => state.members.filter(m => m.active);

function rebuildIndexes(){
  state.sessionsByMember = new Map();
  state.sessions.forEach(s=>{
    if(!state.sessionsByMember.has(s.member_id)) state.sessionsByMember.set(s.member_id, []);
    state.sessionsByMember.get(s.member_id).push(s);
  });
  state.paymentsByMember = new Map();
  state.payments.forEach(p=>{
    if(!state.paymentsByMember.has(p.member_id)) state.paymentsByMember.set(p.member_id, []);
    state.paymentsByMember.get(p.member_id).push(p);
  });
  const days = new Set();
  state.attendance.forEach(set => set.forEach(d => days.add(d)));
  state.sessionDays = Array.from(days).sort();
}

// ---------- derived facts ----------
const sessionsOf = id => state.sessionsByMember.get(id) || [];
const paymentsOf = id => state.paymentsByMember.get(id) || [];
const monthlyPayment = (id, period) => paymentsOf(id).find(p => p.kind === 'monthly' && p.period === period) || null;
const admissionPayment = id => paymentsOf(id).find(p => p.kind === 'admission') || null;
function lastVisit(id){
  const set = state.attendance.get(id);
  if(!set || !set.size) return null;
  let max = null; set.forEach(d=>{ if(!max || d > max) max = d; });
  return max;
}
function inactiveInfo(m){
  const lv = lastVisit(m.id);
  if(lv){
    const ds = daysBetween(lv, todayKey());
    return { days: ds, flagged: ds >= INACTIVE_DAYS, label: `Inactive ${ds}d` };
  }
  const since = daysBetween(m.joined_on, todayKey());
  return { days: Infinity, flagged: since >= INACTIVE_DAYS, label: 'No visits yet' };
}
function recentAttendance(m, n){
  const set = state.attendance.get(m.id) || new Set();
  return state.sessionDays
    .filter(d => d >= m.joined_on && (m.active || !m.left_on || d <= m.left_on))
    .slice(-n)
    .map(d => ({ date:d, present: set.has(d) }));
}
function inPeriod(m, period){
  // Was this member with the club during that month?
  const end = monthEndKey(period);
  if(m.joined_on > end) return false;
  if(m.active) return true;
  return (m.left_on && m.left_on >= period) || !!monthlyPayment(m.id, period);
}

// =====================================================================
// LOADING DATA
// =====================================================================
async function loadPublic(){
  const [mRes, sRes] = await Promise.all([
    sb.from('members').select('*').order('name'),
    fetchAll(() => sb.from('sessions').select('*').order('day', {ascending:false}).order('created_at', {ascending:false}))
  ]);
  if(mRes.error || sRes.error){
    console.error('loadPublic', mRes.error || sRes.error);
    return false;
  }
  state.members = mRes.data;
  state.sessions = sRes.data;
  rebuildIndexes();
  return true;
}

async function loadPrivate(){
  const since = dateKey(addDays(TODAY, -ATTENDANCE_LOAD_DAYS));
  const [dRes, aRes, pRes, setRes] = await Promise.all([
    fetchAll(() => sb.from('member_details').select('*').order('member_id')),
    fetchAll(() => sb.from('attendance').select('member_id,day').gte('day', since).order('day')),
    fetchAll(() => sb.from('payments').select('*').order('paid_on', {ascending:false}).order('created_at', {ascending:false})),
    sb.from('settings').select('*').eq('id', 1).maybeSingle()
  ]);
  const err = dRes.error || aRes.error || pRes.error || setRes.error;
  if(err){
    console.error('loadPrivate', err);
    showToast("Couldn't load attendance and fees. Check your connection.", 'error');
    return false;
  }
  state.details = new Map(dRes.data.map(r => [r.member_id, r]));
  state.attendance = new Map();
  aRes.data.forEach(r=>{
    if(!state.attendance.has(r.member_id)) state.attendance.set(r.member_id, new Set());
    state.attendance.get(r.member_id).add(r.day);
  });
  state.payments = pRes.data;
  if(setRes.data) state.settings = setRes.data;
  rebuildIndexes();
  return true;
}

function clearPrivate(){
  state.details = new Map(); state.attendance = new Map(); state.payments = [];
  state.dashboardBuilt = false;
  rebuildIndexes();
}

let reloading = null;
async function reloadAll(){
  if(reloading) return reloading;
  reloading = (async ()=>{
    const ok = await loadPublic();
    if(ok && state.coach) await loadPrivate();
    renderRoster();
    if(state.coach) buildDashboard();
    route();
  })();
  try{ await reloading; } finally { reloading = null; }
}

// =====================================================================
// PUBLIC: ROSTER + BOXER PAGE
// =====================================================================
function sessionNote(s){
  if(s.note) return s.note;
  const hasSkillNotes = Object.values(s.skill_notes || {}).some(v => String(v).trim());
  return hasSkillNotes ? 'See the skill notes below.' : 'Ratings updated.';
}

function renderRoster(){
  const list = activeMembers();
  const q = $('searchInput').value.trim().toLowerCase();
  const shown = list.filter(m => m.name.toLowerCase().includes(q));
  $('rosterCount').textContent = list.length + (list.length === 1 ? ' member' : ' members');
  $('resultCount').textContent = q ? shown.length + ' match' + (shown.length === 1 ? '' : 'es') : '';
  const grid = $('rosterGrid');
  if(!list.length){ grid.innerHTML = '<p class="panel-note">No members yet.</p>'; return; }
  if(!shown.length){ grid.innerHTML = '<p class="panel-note">No one matches that name.</p>'; return; }
  grid.innerHTML = shown.map((m,i)=>{
    const isFitness = m.type === 'fitness';
    let preview;
    if(isFitness) preview = 'Training for general fitness — no skill progress tracked.';
    else {
      const last = sessionsOf(m.id)[0];
      const n = last ? sessionNote(last) : 'No sessions logged yet.';
      preview = n.length > 70 ? n.slice(0,70) + '…' : n;
    }
    return `
    <div class="boxer-card" style="animation-delay:${Math.min(i*0.05,0.4)}s" onclick="go('#/boxer/${m.id}')">
      <span class="num">${String(i+1).padStart(2,'0')}</span>
      <span class="bname">${esc(m.name)}</span>
      <span class="level${isFitness?' fitness':''}">${esc(isFitness ? 'Fitness' : m.level)}</span>
      <span class="last-note">${esc(preview)}</span>
    </div>`;
  }).join('');
}

function buildRatingSummary(ratings){
  return SKILLS.map(s=>{
    const val = Number((ratings || {})[s.key]) || 0;
    return `
    <div class="rs-row">
      <span class="rs-label">${s.label}</span>
      <span class="rs-track"><span class="rs-fill" style="width:${val*10}%"></span></span>
      <span class="rs-val">${val || '—'}</span>
    </div>`;
  }).join('');
}

function buildTimeline(sessions, prefix, coach){
  if(!sessions.length) return '<p class="panel-note">No sessions logged yet.</p>';
  return sessions.map((s,i)=>{
    const d = parseKey(s.day);
    const itemId = `${prefix}-${i}`;
    const note = sessionNote(s);
    const hasText = !!s.note || Object.values(s.skill_notes || {}).some(v => String(v).trim());
    const skills = SKILLS.map(sk=>{
      const text = String((s.skill_notes || {})[sk.key] || '').trim();
      const rating = (s.ratings || {})[sk.key];
      const skId = `${itemId}-${sk.key}`;
      return `
      <div class="skill-acc" id="${skId}">
        <div class="skill-acc-head" onclick="toggleEl('${skId}', event)">
          <span class="sa-label"><span class="sa-dot${text?'':' empty'}"></span>${sk.label}${rating ? `<span class="sa-rating">${esc(rating)}/10</span>` : ''}</span>
          <span class="sa-chevron">▾</span>
        </div>
        <div class="skill-acc-body${text?'':' empty'}">${text ? esc(text) : 'No note added for this session.'}</div>
      </div>`;
    }).join('');
    return `
    <div class="tl-item${i===0?' expanded':''}" id="${itemId}">
      <div class="tl-summary-row" onclick="toggleEl('${itemId}', event)">
        <div>
          <div class="tl-date">${d ? d.getDate() : ''}<span class="rest">${d ? SHORT_MONTHS[d.getMonth()] + ' ' + d.getFullYear() : ''}</span></div>
          <div class="tl-tag">${hasText ? 'Session' : 'Ratings update'}</div>
          <div class="tl-preview">${esc(note)}</div>
        </div>
        <span class="tl-chevron">▾</span>
      </div>
      <div class="tl-body">
        <div class="tl-note">${esc(note)}</div>
        <div class="skill-bars">${skills}</div>
        ${coach ? `<div class="tl-actions"><button onclick="deleteSession('${s.id}')">Delete this session</button></div>` : ''}
      </div>
    </div>`;
  }).join('');
}
function toggleEl(id, evt){
  if(evt) evt.stopPropagation();
  const el = $(id); if(el) el.classList.toggle('expanded');
}

function openBoxer(id){
  const m = memberById(id);
  if(!m || !m.active) return false;
  const isFitness = m.type === 'fitness';
  $('detailName').textContent = m.name;
  $('detailLevel').textContent = isFitness ? 'Fitness' : m.level;
  $('detailSub').textContent = 'Training since ' + fmtMonthYear(m.joined_on);
  if(isFitness){
    $('detailRatings').innerHTML = '';
    $('detailLogHeading').style.display = 'none';
    $('detailLog').innerHTML = '<p class="panel-note" style="max-width:420px;">This member trains for general fitness, so no skill progress is tracked.</p>';
  } else {
    $('detailLogHeading').style.display = '';
    $('detailRatings').innerHTML = buildRatingSummary(m.ratings);
    $('detailLog').innerHTML = buildTimeline(sessionsOf(m.id), 'pub', false);
  }
  showView('detail');
  return true;
}

// =====================================================================
// NAVIGATION (hash routes, so the phone's back button works)
// =====================================================================
let inAppNavs = 0;
function showView(name){
  const target = $('view-' + name);
  if(target.classList.contains('active')) return;
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  target.classList.add('active');
  window.scrollTo(0,0);
}
function go(hash, replace){
  if(location.hash === hash){ route(); return; }
  if(replace) location.replace(hash); else location.hash = hash;
}
function goBack(fallback){
  if(inAppNavs > 0) history.back(); else go(fallback, true);
}
function closeAllModals(){ document.querySelectorAll('.modal-overlay.open').forEach(m=>m.classList.remove('open')); }

function route(){
  closeAllModals();
  const [page, rawArg] = (location.hash || '#/').replace(/^#\/?/, '').split('/');
  const arg = rawArg ? decodeURIComponent(rawArg) : '';
  if(page === 'boxer'){ if(!openBoxer(arg)) go('#/', true); return; }
  if(page === 'login'){
    if(state.coach){ go('#/dashboard/overview', true); return; }
    showView('login'); return;
  }
  if(page === 'dashboard'){
    if(!state.coach){ go('#/login', true); return; }
    if(!state.dashboardBuilt) buildDashboard();
    activateDashTab(arg || 'overview');
    showView('dashboard'); return;
  }
  if(page === 'member'){
    if(!state.coach){ go('#/login', true); return; }
    if(!openCoachProfile(arg)) go('#/dashboard/members', true);
    return;
  }
  showView('roster');
}
function coachNav(){ go(state.coach ? '#/dashboard/overview' : '#/login'); }
function updateCoachButton(){ $('coachBtn').title = state.coach ? 'Open the coach dashboard' : 'Coach sign in'; }

// =====================================================================
// THEME
// =====================================================================
function updateThemeToggleIcon(){
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  $('themeToggle').textContent = isDark ? '☀️' : '🌙';
}
function toggleTheme(){
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  if(isDark) document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', 'dark');
  try{ localStorage.setItem('dk-theme', isDark ? 'light' : 'dark'); }catch(e){}
  updateThemeToggleIcon();
  const topbar = document.querySelector('.topbar');
  topbar.style.display = 'none'; void topbar.offsetHeight; topbar.style.display = '';
}

// =====================================================================
// COACH SIGN IN / OUT
// =====================================================================
async function checkCoach(){
  const { data, error } = await sb.rpc('is_coach');
  if(error) throw error;
  return data === true;
}

async function tryLogin(){
  const email = $('loginUser').value.trim();
  const password = $('loginPass').value;
  const errEl = $('loginError');
  const btn = $('loginBtn');
  const fail = msg => { errEl.textContent = msg; errEl.style.display = 'block'; };
  errEl.style.display = 'none';
  if(!email || !password) return fail('Enter your email and password.');
  btn.disabled = true; btn.textContent = 'Signing in…';
  try{
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if(error){
      return fail(/fetch|network/i.test(error.message || '') ? "Couldn't reach the server. Check your internet connection." : 'Wrong email or password.');
    }
    let isCoach = false;
    try{ isCoach = await checkCoach(); }catch(e){ return fail("Couldn't reach the server. Check your internet connection."); }
    if(!isCoach){
      await sb.auth.signOut();
      return fail("This account doesn't have coach access yet. Add it with step 3 of the setup guide.");
    }
    state.coach = data.user;
    $('loginPass').value = '';
    updateCoachButton();
    await loadPublic();   // coach also sees archived members
    await loadPrivate();
    renderRoster();
    buildDashboard();
    go('#/dashboard/overview', true);
  } finally {
    btn.disabled = false; btn.textContent = 'Sign in';
  }
}

async function logout(){
  if(!confirm('Sign out of the coach dashboard?')) return;
  try{ await sb.auth.signOut(); }catch(e){ console.error(e); }
  state.coach = null;
  clearPrivate();
  updateCoachButton();
  go('#/', true);
  await reloadAll();
}

// =====================================================================
// DASHBOARD
// =====================================================================
function activateDashTab(name){
  if(!$('panel-' + name)) name = 'overview';
  document.querySelectorAll('.dash-tab').forEach(t=>t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.dash-panel').forEach(p=>p.classList.toggle('active', p.id === 'panel-' + name));
}
function showDashTab(name){ go('#/dashboard/' + name, true); }

function buildDashboard(){
  const attDate = $('attDate'), feeMonth = $('feeMonth');
  attDate.max = todayKey();
  if(!attDate.value || attDate.value > todayKey()) attDate.value = todayKey();
  if(!feeMonth.value) feeMonth.value = currentPeriod().slice(0,7);
  renderOverview();
  renderMembersTable();
  renderAttendanceTable();
  renderFeesTable();
  renderProgressPicker();
  state.dashboardBuilt = true;
}

// ---------- charts ----------
function barChart(data){
  const w = 320, h = 150, padL = 8, padR = 8, padB = 22, padT = 16;
  const chartW = w - padL - padR, chartH = h - padT - padB;
  const max = Math.max(...data.map(d=>d.value), 1) * 1.15;
  const gap = chartW / data.length, barW = gap * 0.55;
  const bars = data.map((d,i)=>{
    const barH = (d.value / max) * chartH;
    const x = padL + gap * i + (gap - barW)/2, y = padT + chartH - barH;
    const label = d.value >= 100000 ? Math.round(d.value/1000) + 'k' : d.value.toLocaleString('en-US');
    return `<rect class="bar-track" x="${x}" y="${padT}" width="${barW}" height="${chartH}" rx="4"></rect>
      <rect class="bar-fill" x="${x}" y="${y}" width="${barW}" height="${barH}" rx="4"></rect>
      <text class="chart-value-label" x="${x+barW/2}" y="${y-6}" text-anchor="middle">${label}</text>
      <text class="chart-axis-label" x="${x+barW/2}" y="${h-6}" text-anchor="middle">${d.label}</text>`;
  }).join('');
  return `<svg class="chart-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="Bar chart">${bars}</svg>`;
}
function lineChart(data){
  const w = 320, h = 150, padL = 12, padR = 12, padB = 22, padT = 18;
  const chartW = w - padL - padR, chartH = h - padT - padB;
  const max = Math.max(...data.map(d=>d.value), 1) * 1.2;
  const stepX = chartW / (data.length - 1 || 1);
  const pts = data.map((d,i)=>({ x: padL + stepX*i, y: padT + chartH - (d.value/max)*chartH, ...d }));
  const line = pts.map((p,i)=>(i?'L':'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' ');
  const area = line + ` L ${pts[pts.length-1].x.toFixed(1)} ${padT+chartH} L ${pts[0].x.toFixed(1)} ${padT+chartH} Z`;
  const dots = pts.map(p=>`<circle class="line-dot" cx="${p.x}" cy="${p.y}" r="3"></circle>
    <text class="chart-value-label" x="${p.x}" y="${p.y-8}" text-anchor="middle">${p.value}</text>
    <text class="chart-axis-label" x="${p.x}" y="${h-6}" text-anchor="middle">${p.label}</text>`).join('');
  return `<svg class="chart-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="Line chart">
    <defs><linearGradient id="lineGradient" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#B3271E"></stop><stop offset="100%" stop-color="#B3271E" stop-opacity="0"></stop>
    </linearGradient></defs>
    <path class="line-area" d="${area}"></path><path class="line-path" d="${line}"></path>${dots}</svg>`;
}
function lastSixPeriods(){
  const out = [];
  for(let i=5; i>=0; i--) out.push(periodKey(new Date(TODAY.getFullYear(), TODAY.getMonth()-i, 1)));
  return out;
}

function animateCountUps(){
  document.querySelectorAll('.count-up').forEach(el=>{
    const target = parseInt(el.dataset.target, 10) || 0, prefix = el.dataset.prefix || '';
    const start = performance.now();
    (function tick(now){
      const p = Math.min((now - start) / 650, 1);
      el.textContent = prefix + Math.round(target * (1 - Math.pow(1-p, 3))).toLocaleString('en-US');
      if(p < 1) requestAnimationFrame(tick);
    })(start);
  });
}

// ---------- overview ----------
function renderOverview(){
  const active = activeMembers();
  const cur = currentPeriod();
  const boxers = active.filter(m=>m.type !== 'fitness').length;
  const unpaid = active.filter(m=>!monthlyPayment(m.id, cur));
  const inactive = active.filter(m=>inactiveInfo(m).flagged);
  const collected = state.payments.filter(p=>p.paid_on.slice(0,7) === cur.slice(0,7)).reduce((s,p)=>s + p.amount, 0);

  $('statGrid').innerHTML = `
    <div class="stat-card" onclick="showDashTab('members')"><div class="stat-num count-up" data-target="${active.length}">0</div><div class="stat-label">Active members</div></div>
    <div class="stat-card" onclick="showDashTab('members')"><div class="stat-num">${boxers} / ${active.length - boxers}</div><div class="stat-label">Boxers / Fitness only</div></div>
    <div class="stat-card" onclick="showDashTab('fees')"><div class="stat-num count-up" data-target="${collected}" data-prefix="Rs. ">Rs. 0</div><div class="stat-label">Collected in ${LONG_MONTHS[TODAY.getMonth()]}</div></div>
    <div class="stat-card${unpaid.length?' warn':''}" onclick="showDashTab('fees')"><div class="stat-num count-up" data-target="${unpaid.length}">0</div><div class="stat-label">Unpaid this month</div></div>
    <div class="stat-card${inactive.length?' warn':''}" onclick="showDashTab('attendance')"><div class="stat-num count-up" data-target="${inactive.length}">0</div><div class="stat-label">Not seen in ${INACTIVE_DAYS}+ days</div></div>`;
  animateCountUps();

  const periods = lastSixPeriods();
  $('chartRevenue').innerHTML = barChart(periods.map(p=>({
    label: SHORT_MONTHS[parseKey(p).getMonth()],
    value: state.payments.filter(x=>x.paid_on.slice(0,7) === p.slice(0,7)).reduce((s,x)=>s + x.amount, 0)
  })));
  $('chartMembers').innerHTML = lineChart(periods.map(p=>{
    const end = monthEndKey(p);
    return {
      label: SHORT_MONTHS[parseKey(p).getMonth()],
      value: state.members.filter(m => m.joined_on <= end && (m.active || !m.left_on || m.left_on > end)).length
    };
  }));

  const flagged = active.map(m=>{
    const tags = [];
    const ia = inactiveInfo(m);
    if(ia.flagged) tags.push(`<span class="attn-tag inactive">${ia.label}</span>`);
    if(!monthlyPayment(m.id, cur)) tags.push('<span class="attn-tag unpaid">Unpaid</span>');
    if(!admissionPayment(m.id)) tags.push('<span class="attn-tag unpaid">Admission due</span>');
    return { m, tags, ia };
  }).filter(x=>x.tags.length);
  $('attentionList').innerHTML = flagged.length
    ? flagged.map(({m, tags, ia})=>`
      <div class="attn-row" onclick="go('#/member/${m.id}')">
        <div>
          <div class="attn-name">${esc(m.name)}</div>
          <div class="attn-reason">${m.type==='fitness'?'Fitness member':'Boxer'} · Last seen ${seenText(ia.days)}</div>
        </div>
        <div class="attn-tags">${tags.join('')}</div>
      </div>`).join('')
    : '<p class="attn-empty">Nothing needs attention right now — nice.</p>';
}

// ---------- members ----------
function renderMembersTable(){
  const q = $('memberSearch').value.trim().toLowerCase();
  const f = $('memberFilter').value;
  const list = state.members.filter(m=>{
    if(!m.name.toLowerCase().includes(q)) return false;
    if(f === 'archived') return !m.active;
    if(!m.active) return false;
    return f === 'active' || m.type === f;
  });
  const body = $('membersBody');
  if(!list.length){
    body.innerHTML = `<tr><td colspan="5" style="color:var(--muted);text-align:center;padding:20px;">${f==='archived' ? 'No archived members.' : state.members.length ? 'No members match this search or filter.' : 'No members yet. Tap “+ Add member” to add the first one.'}</td></tr>`;
    return;
  }
  body.innerHTML = list.map(m=>`
    <tr>
      <td data-label="Name">${esc(m.name)}</td>
      <td data-label="Joined">${fmtMonthYear(m.joined_on)}</td>
      <td data-label="Type">${m.type === 'fitness' ? 'Fitness only' : 'Boxer'}</td>
      <td data-label="Level">${m.type === 'fitness' ? '—' : esc(m.level)}</td>
      <td class="row-actions" data-label="">
        <button class="icon-btn" onclick="go('#/member/${m.id}')" title="View profile" aria-label="View ${esc(m.name)}'s profile">👁</button><button class="icon-btn" onclick="openMemberForm('${m.id}')" title="Edit" aria-label="Edit ${esc(m.name)}">✎</button>
      </td>
    </tr>`).join('');
}

// ---------- attendance ----------
function renderAttendanceTable(){
  const day = $('attDate').value || todayKey();
  const q = $('attSearch').value.trim().toLowerCase();
  const f = $('attFilter').value;
  const eligible = state.members.filter(m => m.joined_on <= day && (m.active || (m.left_on && m.left_on > day)));
  const presentCount = eligible.filter(m => (state.attendance.get(m.id) || new Set()).has(day)).length;
  $('attTitle').textContent = day === todayKey() ? 'Attendance — Today' : 'Attendance';
  $('attSummary').textContent = `${fmtWeekday(day)} · ${presentCount} present`;
  const list = eligible.filter(m=>{
    const present = (state.attendance.get(m.id) || new Set()).has(day);
    return m.name.toLowerCase().includes(q) && (f === 'all' || (f === 'present') === present);
  });
  const box = $('attendanceList');
  if(!list.length){ box.innerHTML = '<p class="panel-note">No members match this search or filter.</p>'; return; }
  box.innerHTML = list.map(m=>{
    const present = (state.attendance.get(m.id) || new Set()).has(day);
    const lv = lastVisit(m.id);
    return `
    <div class="list-row">
      <div class="lr-main">
        <div class="lr-name">${esc(m.name)}</div>
        <div class="lr-meta">${m.type==='fitness'?'Fitness':'Boxer'} · last visit ${lv ? fmtDayShort(lv) : 'none yet'}</div>
      </div>
      <div class="lr-actions">
        <button class="att-toggle${present?' on':''}" aria-pressed="${present}" onclick="toggleAttendance('${m.id}')">${present ? '✓ Present' : 'Mark present'}</button>
      </div>
    </div>`;
  }).join('');
}

async function toggleAttendance(id){
  checkDateRollover();
  const day = $('attDate').value || todayKey();
  if(day > todayKey()){ showToast("You can't mark attendance for a future date.", 'error'); return; }
  if(!state.attendance.has(id)) state.attendance.set(id, new Set());
  const set = state.attendance.get(id);
  const nowPresent = !set.has(day);
  if(nowPresent) set.add(day); else set.delete(day);
  rebuildIndexes();
  renderAttendanceTable();
  renderOverview();
  const name = (memberById(id) || {}).name || 'this member';
  if(nowPresent){
    await save('attendance for ' + name, sb.from('attendance').upsert({ member_id:id, day }, { onConflict:'member_id,day', ignoreDuplicates:true }));
  } else {
    await save('attendance for ' + name, sb.from('attendance').delete().eq('member_id', id).eq('day', day));
  }
}

// ---------- fees ----------
function renderFeesTable(){
  const period = ($('feeMonth').value || currentPeriod().slice(0,7)) + '-01';
  const q = $('feeSearch').value.trim().toLowerCase();
  const f = $('feeFilter').value;
  $('feesTitle').textContent = 'Fees — ' + fmtMonth(period);

  const eligible = state.members.filter(m => inPeriod(m, period));
  const paid = eligible.filter(m => monthlyPayment(m.id, period));
  const total = paid.reduce((s,m)=> s + monthlyPayment(m.id, period).amount, 0);
  $('feeSummary').textContent = `${paid.length} of ${eligible.length} paid · ${rs(total)} in monthly fees`;

  const list = eligible.filter(m=>{
    if(!m.name.toLowerCase().includes(q)) return false;
    const p = monthlyPayment(m.id, period);
    if(f === 'paid') return !!p;
    if(f === 'unpaid') return !p;
    if(f === 'admission') return !admissionPayment(m.id);
    return true;
  });
  const box = $('feesList');
  if(!list.length){ box.innerHTML = '<p class="panel-note">No members match this search or filter.</p>'; return; }
  box.innerHTML = list.map(m=>{
    const p = monthlyPayment(m.id, period);
    const admissionDue = !admissionPayment(m.id);
    const meta = p
      ? `<span style="color:#3E7A3E;font-weight:500;">Paid ${rs(p.amount)}</span> · ${METHOD_LABEL[p.method]} · ${fmtDayShort(p.paid_on)}`
      : 'Not paid';
    return `
    <div class="list-row">
      <div class="lr-main">
        <div class="lr-name">${esc(m.name)}${admissionDue ? '<span class="tag">Admission due</span>' : ''}${m.active ? '' : '<span class="tag" style="border-color:var(--muted);color:var(--muted);">Archived</span>'}</div>
        <div class="lr-meta">${meta}</div>
      </div>
      <div class="lr-actions">
        ${p && p.receipt_path ? `<button class="row-btn icon" onclick="viewReceipt('${p.id}')" title="View receipt" aria-label="View receipt">📎</button>` : ''}
        ${p
          ? `<button class="row-btn" onclick="removePayment('${p.id}')">Undo</button>`
          : `<button class="row-btn primary" onclick="openPaymentModal('${m.id}','monthly','${period}')">Mark paid</button>`}
      </div>
    </div>`;
  }).join('');
}

let payCtx = null;
function openPaymentModal(memberId, kind, period){
  const m = memberById(memberId); if(!m) return;
  payCtx = { memberId, kind, period: kind === 'monthly' ? period : null, file:null };
  const admissionDue = !admissionPayment(memberId);
  $('pay-title').textContent = kind === 'monthly' ? 'Record monthly fee' : 'Record admission fee';
  $('pay-sub').textContent = kind === 'monthly' ? `${m.name} · ${fmtMonth(period)}` : m.name;
  $('pay-amount').value = kind === 'monthly' ? state.settings.monthly_fee : state.settings.admission_fee;
  $('pay-date').value = todayKey();
  $('pay-date').max = todayKey();
  $('pay-method').value = 'cash';
  $('pay-note').value = '';
  $('pay-file').value = '';
  $('pay-drop').classList.remove('has-file');
  $('pay-drop').textContent = '📎 Tap to add a photo or PDF';
  const showAdmission = kind === 'monthly' && admissionDue;
  $('pay-admissionrow').style.display = showAdmission ? '' : 'none';
  $('pay-admission').checked = showAdmission;
  $('pay-admissionlabel').textContent = `Also record admission fee (${rs(state.settings.admission_fee)})`;
  $('modal-payment').classList.add('open');
}
function handleReceiptChosen(){
  const f = $('pay-file').files[0];
  if(!f) return;
  if(f.size > MAX_FILE_MB * 1024 * 1024){
    alert(`That file is over ${MAX_FILE_MB} MB. Take a screenshot of the receipt instead.`);
    $('pay-file').value = '';
    return;
  }
  payCtx.file = f;
  $('pay-drop').classList.add('has-file');
  $('pay-drop').textContent = '✓ ' + f.name;
}

async function uploadReceipt(memberId, file){
  const safe = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(-60);
  const path = `${memberId}/${Date.now()}-${safe}`;
  const { error } = await sb.storage.from('receipts').upload(path, file, { upsert:false });
  if(error){
    console.error('receipt upload', error);
    showToast("Couldn't upload the receipt. Check your connection, or save without it.", 'error');
    return null;
  }
  return path;
}

async function submitPayment(){
  checkDateRollover();
  const ctx = payCtx; if(!ctx) return;
  const amount = parseInt($('pay-amount').value, 10);
  if(isNaN(amount) || amount < 0){ alert('Enter the amount paid.'); return; }
  const paidOn = $('pay-date').value || todayKey();
  if(paidOn > todayKey()){ alert("The payment date can't be in the future."); return; }
  const btn = $('pay-submit');
  btn.disabled = true; btn.textContent = 'Saving…';
  try{
    let receipt = null;
    if(ctx.file){
      receipt = await uploadReceipt(ctx.memberId, ctx.file);
      if(!receipt) return;
    }
    const base = { member_id: ctx.memberId, method: $('pay-method').value, paid_on: paidOn,
                   note: $('pay-note').value.trim() || null, receipt_path: receipt };
    const rows = [{ ...base, kind: ctx.kind, period: ctx.period, amount }];
    if(ctx.kind === 'monthly' && $('pay-admission').checked){
      rows.push({ ...base, kind:'admission', period:null, amount: state.settings.admission_fee });
    }
    closeModal('modal-payment');
    const res = await save('payment', sb.from('payments').insert(rows).select(), { expectRows:true, success:'Payment recorded' });
    if(res.ok){
      state.payments = res.data.concat(state.payments);
      rebuildIndexes();
      refreshCoachViews();
    }
  } finally {
    btn.disabled = false; btn.textContent = 'Mark as paid';
  }
}

async function removePayment(paymentId){
  const p = state.payments.find(x=>x.id === paymentId); if(!p) return;
  const m = memberById(p.member_id);
  const what = p.kind === 'admission' ? 'admission fee' : fmtMonth(p.period) + ' fee';
  if(!confirm(`Remove ${m ? m.name + "'s " : ''}${what} (${rs(p.amount)})? It will show as unpaid again.`)) return;
  state.payments = state.payments.filter(x=>x.id !== paymentId);
  rebuildIndexes();
  refreshCoachViews();
  const res = await save('the payment removal', sb.from('payments').delete().eq('id', paymentId).select('id'), { expectRows:true, success:'Payment removed' });
  if(res.ok && p.receipt_path && !state.payments.some(x=>x.receipt_path === p.receipt_path)){
    const { error } = await sb.storage.from('receipts').remove([p.receipt_path]);
    if(error) console.error('receipt cleanup', error);
  }
}

async function viewReceipt(paymentId){
  const p = state.payments.find(x=>x.id === paymentId);
  if(!p || !p.receipt_path) return;
  const win = window.open('', '_blank'); // open first; phones block pop-ups opened after a wait
  const { data, error } = await sb.storage.from('receipts').createSignedUrl(p.receipt_path, 120);
  if(error){
    if(win) win.close();
    showToast("Couldn't open the receipt. Check your connection.", 'error');
    return;
  }
  if(win) win.location = data.signedUrl; else location.href = data.signedUrl;
}

// ---------- progress ----------
function renderProgressPicker(){
  const sel = $('progressBoxer');
  const prev = sel.value;
  const boxers = activeMembers().filter(m=>m.type !== 'fitness');
  sel.innerHTML = boxers.length
    ? boxers.map(m=>`<option value="${m.id}">${esc(m.name)}</option>`).join('')
    : '<option value="">No boxers yet</option>';
  if(prev && boxers.some(m=>m.id === prev)) sel.value = prev;
  renderCoachTimeline();
}
function renderCoachTimeline(){
  const m = memberById($('progressBoxer').value);
  if(!m){
    $('coachRatings').innerHTML = '';
    $('sliderGrid').innerHTML = '';
    $('coachLog').innerHTML = '<p class="panel-note">No boxers on the tracked list yet. Add a member with type “Boxer (tracked)”.</p>';
    return;
  }
  $('coachRatings').innerHTML = buildRatingSummary(m.ratings);
  $('coachLog').innerHTML = buildTimeline(sessionsOf(m.id), 'coach', true);
  $('sliderGrid').innerHTML = SKILLS.map(s=>`
    <div class="slider-row">
      <label for="rt-${s.key}">${s.label}</label>
      <div class="sr-inputs">
        <input type="number" min="1" max="10" inputmode="numeric" id="rt-${s.key}" placeholder="—" value="${esc((m.ratings || {})[s.key] || '')}" aria-label="${s.label} rating" />
        <input type="text" id="sl-${s.key}" maxlength="300" placeholder="Note on ${s.label.toLowerCase()} (optional)" aria-label="${s.label} note" />
      </div>
    </div>`).join('');
}

async function saveSession(){
  checkDateRollover();
  const m = memberById($('progressBoxer').value); if(!m) return;
  const note = $('progressNote').value.trim();
  const skill_notes = {}, ratings = {};
  let changed = false;
  for(const s of SKILLS){
    const t = $('sl-' + s.key).value.trim();
    if(t) skill_notes[s.key] = t;
    const raw = $('rt-' + s.key).value.trim();
    if(raw !== ''){
      const n = parseInt(raw, 10);
      if(isNaN(n) || n < 1 || n > 10){ showToast(`${s.label} rating must be between 1 and 10.`, 'error'); return; }
      ratings[s.key] = n;
      if(Number((m.ratings || {})[s.key]) !== n) changed = true;
    }
  }
  if(!note && !Object.keys(skill_notes).length && !changed){
    showToast('Write a session note or change a rating before saving.', 'error');
    return;
  }
  const btn = $('saveSessionBtn');
  btn.disabled = true;
  const res = await save('the session', sb.from('sessions').insert({ member_id: m.id, day: todayKey(), note, skill_notes, ratings }).select(),
    { expectRows:true, success:'Session saved' });
  btn.disabled = false;
  if(res.ok){
    $('progressNote').value = '';
    await loadPublic();          // ratings are recalculated by the database
    renderRoster();
    renderCoachTimeline();
  }
}

async function deleteSession(sessionId){
  if(!confirm('Delete this session? Its notes are removed and ratings go back to the previous session.')) return;
  const res = await save('the session deletion', sb.from('sessions').delete().eq('id', sessionId).select('id'), { expectRows:true, success:'Session deleted' });
  if(res.ok){
    await loadPublic();
    renderRoster();
    renderCoachTimeline();
    route();
  }
}

// =====================================================================
// COACH: MEMBER PROFILE
// =====================================================================
function mdItem(label, value, full){
  return `<div class="md-item${full?' full':''}"><div class="md-label">${label}</div><div class="md-value">${value ? esc(value) : '—'}</div></div>`;
}
function openCoachProfile(id){
  const m = memberById(id);
  if(!m) return false;
  const d = state.details.get(id) || {};
  const cur = currentPeriod();
  $('cpName').textContent = m.name;
  $('cpLevel').textContent = m.type === 'fitness' ? 'Fitness' : m.level;
  $('cpSub').textContent = `Joined ${fmtDay(m.joined_on)} · ${m.type === 'fitness' ? 'Fitness member' : 'Boxer (tracked)'}`;
  $('cpActions').innerHTML = `
    ${m.active ? '' : `<p class="archived-note" style="width:100%;">Archived${m.left_on ? ' on ' + fmtDay(m.left_on) : ''}. Hidden from the roster.</p>`}
    <button class="btn-secondary small-btn" onclick="openMemberForm('${m.id}')">Edit details</button>
    ${m.active && !monthlyPayment(m.id, cur) ? `<button class="btn-secondary small-btn" onclick="openPaymentModal('${m.id}','monthly','${cur}')">Record ${LONG_MONTHS[TODAY.getMonth()]} fee</button>` : ''}
    ${!admissionPayment(m.id) ? `<button class="btn-secondary small-btn" onclick="openPaymentModal('${m.id}','admission')">Record admission fee</button>` : ''}
    <button class="btn-secondary small-btn" onclick="setArchived('${m.id}', ${m.active})">${m.active ? 'Archive' : 'Restore member'}</button>`;

  const recent = recentAttendance(m, ATTENDANCE_WINDOW);
  const presentCount = recent.filter(r=>r.present).length;
  const lv = lastVisit(m.id);
  const fee = monthlyPayment(m.id, cur);
  $('cpStatGrid').innerHTML = `
    <div class="stat-card"><div class="stat-num">${recent.length ? Math.round(presentCount/recent.length*100) + '%' : '—'}</div><div class="stat-label">Attendance, last ${recent.length || ATTENDANCE_WINDOW} sessions</div></div>
    <div class="stat-card"><div class="stat-num">${lv ? daysBetween(lv, todayKey()) : '—'}</div><div class="stat-label">Days since last visit</div></div>
    <div class="stat-card${fee?'':' warn'}"><div class="stat-num">${fee ? 'Paid' : 'Unpaid'}</div><div class="stat-label">${LONG_MONTHS[TODAY.getMonth()]} fee</div></div>`;

  $('cpAttendanceStrip').innerHTML = recent.length
    ? recent.map(r=>`<span class="att-dot ${r.present?'present':'absent'}" title="${fmtWeekday(r.date)}" aria-label="${fmtWeekday(r.date)}: ${r.present?'present':'absent'}">${r.present?'✓':'✕'}</span>`).join('')
    : '<p class="attn-empty">No sessions recorded since this member joined.</p>';

  const pays = paymentsOf(id).slice().sort((a,b)=>{
    const ka = a.kind === 'admission' ? '0000' : a.period, kb = b.kind === 'admission' ? '0000' : b.period;
    return kb.localeCompare(ka);
  });
  $('cpPayments').innerHTML = pays.length
    ? pays.map(p=>`
      <div class="pay-row">
        <div class="pr-main">
          ${p.kind === 'admission' ? 'Admission fee' : fmtMonth(p.period)} · ${rs(p.amount)}
          <small>${METHOD_LABEL[p.method]} · paid ${fmtDay(p.paid_on)}${p.note ? ' · ' + esc(p.note) : ''}</small>
        </div>
        <div class="pr-actions">
          ${p.receipt_path ? `<button onclick="viewReceipt('${p.id}')" aria-label="View receipt">📎</button>` : ''}
          <button onclick="removePayment('${p.id}')" aria-label="Remove payment">Remove</button>
        </div>
      </div>`).join('')
    : '<p class="attn-empty">No payments recorded yet.</p>';

  $('cp-personal').innerHTML =
    mdItem('Date of birth', d.dob ? fmtDay(d.dob) : '') + mdItem('Age', ageFrom(d.dob)) +
    mdItem('Gender', d.gender) + mdItem('National ID / Passport', d.national_id);
  $('cp-contact').innerHTML =
    mdItem('Mobile number', d.mobile) + mdItem('WhatsApp number', d.whatsapp) +
    mdItem('Email', d.email, true) + mdItem('Residential address', d.address, true) +
    mdItem('Emergency contact name', d.emergency_name) + mdItem('Emergency contact number', d.emergency_phone) +
    mdItem('Relationship', d.emergency_relation);
  const sched = d.schedule || [];
  $('cp-training').innerHTML =
    `<div class="md-item full"><div class="md-label">Class schedule</div><div class="md-chip-row">${ALL_DAYS.map(x=>`<span class="md-chip${sched.includes(x)?' on':''}">${x}</span>`).join('')}</div></div>` +
    mdItem('Previous boxing / combat experience', d.prior_experience, true) +
    mdItem('Medical conditions / injuries', d.medical, true);

  showView('coachprofile');
  return true;
}

// Re-render whatever the coach is looking at after a change.
function refreshCoachViews(){
  renderOverview();
  renderMembersTable();
  renderAttendanceTable();
  renderFeesTable();
  renderRoster();
  if($('view-coachprofile').classList.contains('active')){
    const id = decodeURIComponent((location.hash.split('/')[2] || ''));
    if(!openCoachProfile(id)) go('#/dashboard/members', true);
  }
}

// =====================================================================
// ADD / EDIT MEMBER
// =====================================================================
let editingId = null;
function openMemberForm(id){
  editingId = id || null;
  const m = id ? memberById(id) : null;
  const d = (id && state.details.get(id)) || {};
  $('mf-title').textContent = m ? 'Edit member' : 'Add a member';
  $('mf-submit').textContent = m ? 'Save changes' : 'Add member';
  $('mf-name').value = m ? m.name : '';
  $('mf-dob').value = d.dob || '';
  $('mf-dob').max = todayKey();
  $('mf-gender').value = d.gender || '';
  $('mf-nic').value = d.national_id || '';
  $('mf-mobile').value = d.mobile || '';
  $('mf-whatsapp').value = d.whatsapp || '';
  $('mf-email').value = d.email || '';
  $('mf-address').value = d.address || '';
  $('mf-emname').value = d.emergency_name || '';
  $('mf-emphone').value = d.emergency_phone || '';
  $('mf-emrel').value = d.emergency_relation || '';
  $('mf-exp').value = d.prior_experience || '';
  $('mf-medical').value = d.medical || '';
  $('mf-type').value = m ? m.type : 'boxer';
  $('mf-level').value = m ? m.level : 'Beginner';
  $('mf-joined').value = m ? m.joined_on : todayKey();
  $('mf-joined').max = todayKey();
  const sched = d.schedule || [];
  $('mf-schedule').innerHTML = ALL_DAYS.map(x=>
    `<span class="md-chip${sched.includes(x)?' on':''}" role="checkbox" aria-checked="${sched.includes(x)}" tabindex="0" data-day="${x}" onclick="toggleChip(this)" onkeydown="if(event.key===' '||event.key==='Enter'){event.preventDefault();toggleChip(this);}" style="cursor:pointer;">${x}</span>`).join('');
  $('mf-paysection').style.display = m ? 'none' : '';
  $('mf-payadmission').checked = true;
  $('mf-paymonth').checked = true;
  $('mf-method').value = 'cash';
  $('mf-admissionlabel').textContent = `Admission fee — ${rs(state.settings.admission_fee)}`;
  $('mf-monthlabel').textContent = `First month (${LONG_MONTHS[TODAY.getMonth()]}) — ${rs(state.settings.monthly_fee)}`;
  $('mf-danger').style.display = m ? '' : 'none';
  if(m) $('mf-archive').textContent = m.active ? 'Archive member' : 'Restore member';
  $('modal-member').classList.add('open');
}
function toggleChip(el){
  el.classList.toggle('on');
  el.setAttribute('aria-checked', el.classList.contains('on'));
}

function readDetailsForm(){
  const v = id => $(id).value.trim() || null;
  return {
    dob: v('mf-dob'), gender: v('mf-gender'), national_id: v('mf-nic'),
    mobile: v('mf-mobile'), whatsapp: v('mf-whatsapp'), email: v('mf-email'), address: v('mf-address'),
    emergency_name: v('mf-emname'), emergency_phone: v('mf-emphone'), emergency_relation: v('mf-emrel'),
    schedule: Array.from(document.querySelectorAll('#mf-schedule .md-chip.on')).map(el=>el.dataset.day),
    prior_experience: v('mf-exp'), medical: v('mf-medical'),
    updated_at: new Date().toISOString()
  };
}

async function submitMemberForm(){
  checkDateRollover();
  const name = $('mf-name').value.trim();
  if(!name){ alert("Enter the member's name."); return; }
  const joined = $('mf-joined').value || todayKey();
  if(joined > todayKey()){ alert("The joined date can't be in the future."); return; }
  const core = { name, type: $('mf-type').value, level: $('mf-level').value, joined_on: joined };
  const details = readDetailsForm();
  const btn = $('mf-submit');
  btn.disabled = true;
  try{
    if(editingId){
      const id = editingId;
      closeModal('modal-member');
      const r1 = await save('the member', sb.from('members').update(core).eq('id', id).select(), { expectRows:true });
      if(!r1.ok) return;
      const r2 = await save('the member details', sb.from('member_details').upsert({ member_id:id, ...details }, { onConflict:'member_id' }).select(),
        { expectRows:true, success:'Changes saved' });
      if(!r2.ok) return;
      Object.assign(memberById(id), r1.data[0]);
      state.details.set(id, r2.data[0]);
      renderProgressPicker();
      refreshCoachViews();
      return;
    }

    const payAdmission = $('mf-payadmission').checked, payMonth = $('mf-paymonth').checked;
    const method = $('mf-method').value;
    closeModal('modal-member');
    const r1 = await save('the new member', sb.from('members').insert(core).select(), { expectRows:true });
    if(!r1.ok) return;
    const m = r1.data[0];
    state.members.push(m);
    state.members.sort((a,b)=>a.name.localeCompare(b.name));
    const r2 = await save('the member details', sb.from('member_details').insert({ member_id:m.id, ...details }).select(), { expectRows:true });
    if(!r2.ok) return;
    state.details.set(m.id, r2.data[0]);
    const pays = [];
    if(payAdmission) pays.push({ member_id:m.id, kind:'admission', period:null, amount: state.settings.admission_fee, method, paid_on: todayKey() });
    if(payMonth) pays.push({ member_id:m.id, kind:'monthly', period: periodKey(parseKey(joined)), amount: state.settings.monthly_fee, method, paid_on: todayKey() });
    if(pays.length){
      const r3 = await save('the joining payment', sb.from('payments').insert(pays).select(), { expectRows:true });
      if(!r3.ok) return;
      state.payments = r3.data.concat(state.payments);
    }
    rebuildIndexes();
    showToast(name + ' added');
    renderProgressPicker();
    refreshCoachViews();
  } finally {
    btn.disabled = false;
  }
}

async function setArchived(id, archive){
  const m = memberById(id); if(!m) return;
  if(archive && !confirm(`Archive ${m.name}? They'll be hidden from the roster and fee lists, but their history is kept. You can restore them any time.`)) return;
  const patch = archive ? { active:false, left_on: todayKey() } : { active:true, left_on:null };
  const res = await save(archive ? 'the archive' : 'the restore', sb.from('members').update(patch).eq('id', id).select(),
    { expectRows:true, success: archive ? m.name + ' archived' : m.name + ' restored' });
  if(res.ok){
    Object.assign(m, res.data[0]);
    renderProgressPicker();
    refreshCoachViews();
  }
}
function toggleArchiveFromForm(){
  const m = memberById(editingId); if(!m) return;
  closeModal('modal-member');
  setArchived(m.id, m.active);
}
async function deleteMemberFromForm(){
  const m = memberById(editingId); if(!m) return;
  if(!confirm(`Permanently delete ${m.name}? All their attendance, payments, and progress notes are erased. This can't be undone.\n\nTo keep their history, use Archive instead.`)) return;
  closeModal('modal-member');
  const receipts = paymentsOf(m.id).map(p=>p.receipt_path).filter(Boolean);
  const res = await save('the deletion', sb.from('members').delete().eq('id', m.id).select('id'), { expectRows:true, success: m.name + ' deleted' });
  if(res.ok){
    if(receipts.length){
      const { error } = await sb.storage.from('receipts').remove(receipts);
      if(error) console.error('receipt cleanup', error);
    }
    await reloadAll();
    go('#/dashboard/members', true);
  }
}

// =====================================================================
// FEE SETTINGS
// =====================================================================
function openSettingsModal(){
  $('set-admission').value = state.settings.admission_fee;
  $('set-monthly').value = state.settings.monthly_fee;
  $('modal-settings').classList.add('open');
}
async function saveSettings(){
  const a = parseInt($('set-admission').value, 10), mo = parseInt($('set-monthly').value, 10);
  if(isNaN(a) || a < 0 || isNaN(mo) || mo < 0){ alert('Enter both amounts.'); return; }
  closeModal('modal-settings');
  const res = await save('the fee amounts', sb.from('settings').update({ admission_fee:a, monthly_fee:mo, updated_at: new Date().toISOString() }).eq('id', 1).select(),
    { expectRows:true, success:'Fee amounts saved' });
  if(res.ok) state.settings = res.data[0];
}

// =====================================================================
// MODALS
// =====================================================================
function closeModal(id){ $(id).classList.remove('open'); }
document.addEventListener('keydown', e=>{ if(e.key === 'Escape') closeAllModals(); });

// =====================================================================
// KEEPING THINGS CURRENT
// =====================================================================
function hasUnsavedInput(){
  if(document.querySelector('.modal-overlay.open')) return true;
  if($('progressNote').value.trim()) return true;
  return Array.from(document.querySelectorAll('#sliderGrid input[type=text]')).some(i=>i.value.trim());
}
function checkDateRollover(){
  const now = new Date();
  const changed = dateKey(now) !== dateKey(TODAY);
  const oldToday = dateKey(TODAY);
  TODAY = now;
  if(changed && state.coach && state.dashboardBuilt){
    if($('attDate').value === oldToday) $('attDate').value = todayKey();
    if($('feeMonth').value === oldToday.slice(0,7)) $('feeMonth').value = currentPeriod().slice(0,7);
    if(!hasUnsavedInput()) buildDashboard();
  }
  return changed;
}
setInterval(checkDateRollover, 60 * 1000);

let hiddenAt = 0;
document.addEventListener('visibilitychange', ()=>{
  if(document.hidden){ hiddenAt = Date.now(); return; }
  checkDateRollover();
  if(hiddenAt && Date.now() - hiddenAt > 60 * 1000 && !hasUnsavedInput()) reloadAll();
});

function updateOnline(){ $('offlineBar').classList.toggle('show', !navigator.onLine); }
window.addEventListener('online', async ()=>{
  updateOnline();
  if(!state.coach) await restoreSession();   // app may have been opened while offline
  if(!hasUnsavedInput()) reloadAll();
});
window.addEventListener('offline', updateOnline);

// ---------- installable app ----------
let installEvent = null;
window.addEventListener('beforeinstallprompt', e=>{
  e.preventDefault();
  installEvent = e;
  $('installBtn').style.display = '';
});
async function installApp(){
  if(!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  $('installBtn').style.display = 'none';
}
if('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')){
  window.addEventListener('load', ()=> navigator.serviceWorker.register('sw.js').catch(err=>console.error('SW', err)));
}

// =====================================================================
// START
// =====================================================================
async function restoreSession(){
  try{
    const { data } = await sb.auth.getSession();
    if(data && data.session && await checkCoach()){
      state.coach = data.session.user;
      await loadPublic();              // coach can also see archived members
      await loadPrivate();
    }
  }catch(e){ console.error('session restore', e); }
  updateCoachButton();
}

async function init(){
  updateThemeToggleIcon();
  updateOnline();
  let ok = false;
  if(navigator.onLine){
    $('rosterGrid').innerHTML = '<p class="panel-note">Loading roster…</p>';
    ok = await loadPublic();
    if(!ok) $('rosterGrid').innerHTML = '<p class="panel-note">Could not load the roster. Check your internet connection and refresh.</p>';
    await restoreSession();
  } else {
    $('rosterGrid').innerHTML = "<p class=\"panel-note\">You're offline. The roster will load as soon as you reconnect.</p>";
  }
  if(ok || state.coach) renderRoster();
  if(state.coach) buildDashboard();
  route();
  window.addEventListener('hashchange', ()=>{ inAppNavs++; route(); });

  sb.auth.onAuthStateChange(event=>{
    if(event === 'SIGNED_OUT' && state.coach){
      state.coach = null;
      clearPrivate();
      updateCoachButton();
      showToast('You were signed out. Sign in again to continue.', 'error');
      go('#/login', true);
    }
  });
}
init();
