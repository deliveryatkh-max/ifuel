// Overtime (ថែមម៉ោង) request form. Employees type their Employee ID, the name and line manager come from the
// "Employee & Approver" sheet, and the request is saved to "OT Data" and sent to that manager on Telegram.
// No sign-in: the server re-checks the ID and the manager on every submission and every approval.
(function () {
  'use strict';

  const API = ((window.OT_CONFIG || {}).OT_API_URL || '').trim();
  const DEMO = !API;
  const $ = s => document.querySelector(s);
  const t = (km, en) => (window.LANG ? LANG.t(km, en) : km);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const get = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const set = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* private mode */ } };
  const getJ = (k, d) => { try { return JSON.parse(get(k)) || d; } catch (e) { return d; } };

  const K = { cfg: 'ot_cfg', id: 'ot_last_id', mine: 'ot_mine', items: 'ot_items', draft: 'ot_draft', people: 'ot_people' };

  // ---------- server ----------
  const ERR_KM = {
    NOTFOUND: 'រកមិនឃើញលេខកាតបុគ្គលិកនេះទេ។ សូមពិនិត្យម្តងទៀត។',
    DUPLICATE: 'លេខកាតនេះមានច្រើនជាងមួយក្នុងបញ្ជីបុគ្គលិក។ សូមទាក់ទង HR។',
    NET: 'មិនអាចភ្ជាប់អ៊ីនធឺណិត។ សូមព្យាយាមម្តងទៀត។',
    BUSY: 'ប្រព័ន្ធកំពុងរវល់។ សូមព្យាយាមម្តងទៀត។',
    LIMIT: 'សំណើច្រើនពេកសម្រាប់លេខកាតនេះ។ សូមរង់ចាំបន្តិច។',
    SAVE: 'មិនអាចរក្សាទុកសំណើបានទេ។ សូមព្យាយាមម្តងទៀត។',
    GPS: 'អ្នកត្រូវនៅជិតកន្លែងធ្វើការរបស់អ្នក។',
  };
  function niceError(e) {
    const code = e.code || '';
    if (code === 'DUPLICATE_OT') return t('អ្នកមានថែមម៉ោងនៅពេលនេះរួចហើយ។ ', '') + e.message;
    if (ERR_KM[code] && (window.LANG && LANG.get() === 'km')) return ERR_KM[code];
    return e.message;
  }

  async function api(action, payload) {
    if (DEMO) return demo(action, payload || {});
    let data;
    try {
      const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, payload: payload || {} }) });
      data = await res.json();
    } catch (e) {
      throw Object.assign(new Error(t(ERR_KM.NET, 'No connection. Please try again.')), { code: 'NET' });
    }
    if (!data.ok) {
      const m = String(data.error || 'Error').match(/^([A-Z_]+):\s*(.*)$/);
      throw Object.assign(new Error(m ? m[2] : String(data.error)), { code: m ? m[1] : '' });
    }
    return data.data;
  }

  // ---------- small helpers ----------
  const pad = n => String(n).padStart(2, '0');
  const localYmd = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const toMin = s => { const m = String(s || '').match(/^(\d{1,2}):(\d{2})/); return m ? +m[1] * 60 + +m[2] : null; };
  const h12 = s => { const m = toMin(s); if (m == null) return ''; const h = Math.floor(m / 60); return ((h % 12) || 12) + ':' + pad(m % 60) + (h < 12 ? ' AM' : ' PM'); };
  const fmtDate = ymd => { if (!ymd) return ''; const d = new Date(ymd + 'T00:00:00'); return d.toLocaleDateString(LANG.get() === 'en' ? 'en-GB' : 'km-KH', { day: 'numeric', month: 'short', year: 'numeric' }); };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
  const hoursText = h => (Math.round(h * 100) / 100).toString();

  function calc(start, end, allowOvernight) {
    const s = toMin(start), e = toMin(end);
    if (s == null || e == null) return null;
    if (s === e) return { err: t('ម៉ោងចាប់ផ្តើម និងម៉ោងបញ្ចប់មិនអាចដូចគ្នាទេ។', 'Start and end time cannot be the same.') };
    const overnight = e < s;
    if (overnight && !allowOvernight) return { err: t('ម៉ោងបញ្ចប់ត្រូវក្រោយម៉ោងចាប់ផ្តើម។', 'End time must be after start time.') };
    return { hours: Math.round(((overnight ? e + 1440 : e) - s) / 60 * 100) / 100, overnight };
  }

  const STATUS = {
    Pending: { cls: 'pending', km: 'កំពុងរង់ចាំ', en: 'Pending', ico: '⏳' },
    Approved: { cls: 'approved', km: 'បានអនុម័ត', en: 'Approved', ico: '✅' },
    Rejected: { cls: 'rejected', km: 'បានបដិសេធ', en: 'Rejected', ico: '❌' },
    'Requires Follow-up': { cls: 'follow', km: 'ត្រូវការតាមដាន', en: 'Requires Follow-up', ico: '⚠️' },
  };
  const badge = s => { const x = STATUS[s] || STATUS.Pending; return `<span class="badge ${x.cls}">${x.ico} ${esc(t(x.km, x.en))}</span>`; };

  let toastTimer = 0;
  function toast(msg) { const el = $('#toast'); el.textContent = msg; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 2800); }

  // ---------- state ----------
  let cfg = getJ(K.cfg, null);
  const state = { tab: 'new', emp: null, lookingUp: false, lookupErr: '', draft: getJ(K.draft, {}), sending: false, sendErr: '', result: null };
  let redraw = () => {};

  async function loadConfig() {
    try {
      const c = await api('config');
      cfg = c; set(K.cfg, JSON.stringify(c));
      if (state.tab === 'new' && !state.result) renderNew(true);
    } catch (e) { if (!cfg) cfg = { reasons: [], overnight: true, needGps: false }; }
  }

  function saveDraft() {
    const d = state.draft;
    set(K.draft, JSON.stringify({ date: d.date, start: d.start, end: d.end, reason: d.reason, key: d.key }));
  }

  // ---------- New request ----------
  function renderNew(keep) {
    state.tab = 'new'; paintTabs();
    redraw = () => renderNew(true);
    if (state.result) return renderDone();
    const c = cfg || { reasons: [], overnight: true };
    const d = state.draft;
    if (!d.date) d.date = c.today || localYmd();
    if (!d.key) { d.key = uuid(); saveDraft(); }
    const idVal = keep && $('#empId') ? $('#empId').value : (state.emp ? state.emp.id : (get(K.id) || ''));
    const calcd = calc(d.start, d.end, c.overnight !== false);
    const reasons = (c.reasons || []).map(r => r.replace(/[.…]+$/, '').trim()).filter(Boolean);

    $('#view').innerHTML = `
      <form id="form" novalidate autocomplete="off">
        <section class="card">
          <h2><span class="n">1</span>${t('បុគ្គលិក', 'Employee')}</h2>
          <label class="f" for="empId">${t('លេខកាត ឬឈ្មោះបុគ្គលិក', 'Employee ID or name')} <span class="req">*</span></label>
          <div class="idrow">
            <div class="search">
              <input class="in${state.lookupErr ? ' err' : ''}" id="empId" autocomplete="off" autocorrect="off" spellcheck="false" maxlength="60" placeholder="${esc(t('ឧ. 100027 ឬ ទូច អេ ឬ TOUCH E', 'e.g. 100027, TOUCH E or ទូច អេ'))}" value="${esc(idVal)}" role="combobox" aria-autocomplete="list" aria-controls="sugg" aria-expanded="false">
              <div class="sugg" id="sugg" role="listbox" hidden></div>
            </div>
            <button type="button" class="btn" id="findBtn" ${state.lookingUp ? 'disabled' : ''}>${state.lookingUp ? '<span class="sp"></span>' : '🔎'} ${t('ស្វែងរក', 'Find')}</button>
          </div>
          ${state.lookupErr ? `<div class="msg-err" role="alert">${esc(state.lookupErr)}</div>` : ''}
          ${state.emp ? `
          <div class="emp" aria-live="polite">
            <div class="kv"><span>${t('ឈ្មោះ (អង់គ្លេស)', 'Name (English)')}</span><b>${esc(state.emp.en)}</b></div>
            <div class="kv"><span>${t('ឈ្មោះ (ខ្មែរ)', 'Name (Khmer)')}</span><b>${esc(state.emp.kh || '—')}</b></div>
            <div class="kv"><span>${t('អ្នកគ្រប់គ្រងផ្ទាល់', 'Line manager')}</span><b>${esc(state.emp.manager || '—')}</b></div>
            <div class="lock">🔒 ${t('ព័ត៌មាននេះមកពីបញ្ជីបុគ្គលិក មិនអាចកែបានទេ។', 'From the employee list. It cannot be changed here.')}</div>
          </div>
          ${state.emp.ready ? '' : `<div class="alert warn">${t('អ្នកគ្រប់គ្រងរបស់អ្នកមិនទាន់ភ្ជាប់ Telegram ទេ។ សំណើនឹងត្រូវរក្សាទុក ហើយផ្ញើទៅពេលក្រោយ។', "Your line manager is not connected to Telegram yet. Your request will be saved and sent once they are.")}</div>`}` : ''}
        </section>

        <section class="card">
          <h2><span class="n">2</span>${t('ព័ត៌មានថែមម៉ោង', 'OT details')}</h2>
          <div class="field">
            <label class="f" for="otDate">${t('ថ្ងៃធ្វើថែមម៉ោង', 'OT date')} <span class="req">*</span></label>
            <div class="row2">
              <input class="in" type="date" id="otDate" value="${esc(d.date)}" required>
              <div class="dayinfo" id="dayInfo" aria-live="polite">${dayHtml(d.date)}</div>
            </div>
          </div>
          <div class="field row2">
            <div>
              <label class="f" for="otStart">${t('ចាប់ពីម៉ោង', 'Start time')} <span class="req">*</span></label>
              <input class="in" type="time" id="otStart" value="${esc(d.start || '')}" required>
            </div>
            <div>
              <label class="f" for="otEnd">${t('ដល់ម៉ោង', 'End time')} <span class="req">*</span></label>
              <input class="in" type="time" id="otEnd" value="${esc(d.end || '')}" required>
            </div>
          </div>
          <div class="field">
            <div class="total" id="total">${totalHtml(calcd)}</div>
          </div>
          <div class="field">
            <label class="f" for="otReason">${t('មូលហេតុ / ការងារដែលធ្វើ', 'Reason / work done')} <span class="req">*</span></label>
            ${reasons.length ? `<div class="chips">${reasons.map(r => `<button type="button" class="chip${d.reason === r ? ' on' : ''}" data-r="${esc(r)}">${esc(r)}</button>`).join('')}</div>` : ''}
            <textarea class="in" id="otReason" maxlength="500" placeholder="${esc(t('ឧ. រៀបចំទំនិញសម្រាប់ដឹកជញ្ជូន', 'e.g. Preparing goods for delivery'))}">${esc(d.reason || '')}</textarea>
          </div>
          ${c.needGps ? `<div class="hint">📍 ${t('ត្រូវការទីតាំងរបស់អ្នក ហើយអ្នកត្រូវនៅក្នុងចម្ងាយ', 'Your location is needed. You must be within')} ${esc(c.radius)} m ${t('ពីកន្លែងធ្វើការរបស់អ្នក។', 'of your workplace.')}</div>` : ''}
        </section>

        ${state.sendErr ? `<div class="alert bad" role="alert" style="margin:0 0 12px">${esc(state.sendErr)}</div>` : ''}
        <button type="submit" class="btn ok big" id="sendBtn" ${state.sending ? 'disabled' : ''}>
          ${state.sending ? `<span class="sp"></span> ${t('កំពុងផ្ញើ…', 'Submitting…')}` : `📨 ${t('ផ្ញើសំណើថែមម៉ោង', 'Submit OT Request')}`}
        </button>
      </form>`;

    const idEl = $('#empId');
    let idTimer = 0;
    idEl.addEventListener('input', () => {
      const v = idEl.value.trim();
      if (state.emp && state.emp.id !== v) { state.emp = null; state.lookupErr = ''; renderNew(true); $('#empId').focus(); placeCaret(); showSugg(v); return; }
      clearTimeout(idTimer);
      const hits = showSugg(v);
      // A complete ID typed in full is looked up straight away.
      if (/^\d{4,}$/.test(v) && hits.some(p => p.id === v)) idTimer = setTimeout(() => lookup(v), 250);
      else if (/^\d{6,}$/.test(v) && !people().length) idTimer = setTimeout(() => lookup(v), 450);
    });
    idEl.addEventListener('focus', () => { if (!state.emp) showSugg(idEl.value.trim()); });
    idEl.addEventListener('keydown', e => {
      const items = Array.from(document.querySelectorAll('#sugg .opt'));
      const on = items.findIndex(x => x.classList.contains('on'));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!items.length) return;
        e.preventDefault();
        const n = (on + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items.forEach((x, i) => x.classList.toggle('on', i === n));
      } else if (e.key === 'Enter') { e.preventDefault(); find(on >= 0 ? items[on].dataset.id : null); }
      else if (e.key === 'Escape') hideSugg();
    });
    idEl.addEventListener('blur', () => setTimeout(() => {
      hideSugg();
      const v = idEl.value.trim();
      if (/^\d+$/.test(v) && (!state.emp || state.emp.id !== v) && !state.lookingUp) lookup(v);
    }, 180));
    $('#sugg').addEventListener('mousedown', e => e.preventDefault());   // keep focus so the tap lands
    $('#sugg').addEventListener('click', e => { const o = e.target.closest('.opt'); if (o) pick(o.dataset.id); });
    $('#findBtn').onclick = () => find(null);

    const onTime = () => {
      d.date = $('#otDate').value; d.start = $('#otStart').value; d.end = $('#otEnd').value; saveDraft();
      $('#dayInfo').innerHTML = dayHtml(d.date);
      $('#total').innerHTML = totalHtml(calc(d.start, d.end, (cfg || {}).overnight !== false));
    };
    ['#otDate', '#otStart', '#otEnd'].forEach(s => { $(s).addEventListener('input', onTime); $(s).addEventListener('change', onTime); });
    $('#otReason').addEventListener('input', e => {
      d.reason = e.target.value; saveDraft();
      document.querySelectorAll('.chip').forEach(ch => ch.classList.toggle('on', ch.dataset.r === d.reason));
    });
    document.querySelectorAll('.chip').forEach(ch => ch.onclick = () => {
      d.reason = ch.dataset.r; $('#otReason').value = d.reason; saveDraft();
      document.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === ch));
    });
    $('#form').onsubmit = e => { e.preventDefault(); submit(); };
  }
  function placeCaret() { const el = $('#empId'); if (el) { const n = el.value.length; try { el.setSelectionRange(n, n); } catch (e) { /* number input */ } } }

  // ---------- employee search (ID, English or Khmer name) ----------
  const people = () => (state.people || []);
  const fold = s => String(s || '').toLowerCase().replace(/[\s.\-_]+/g, '');
  function search(q) {
    const f = fold(q);
    if (!f) return [];
    const out = [];
    for (const p of people()) {
      const id = fold(p.id), en = fold(p.en), kh = fold(p.kh);
      let score = -1;
      if (id === f) score = 0;
      else if (id.startsWith(f)) score = 1;
      else if (en.startsWith(f) || kh.startsWith(f)) score = 2;
      else if (en.includes(f) || kh.includes(f) || id.includes(f)) score = 3;
      if (score >= 0) out.push({ p, score });
    }
    out.sort((a, b) => a.score - b.score || a.p.en.localeCompare(b.p.en));
    return out.slice(0, 8).map(x => x.p);
  }
  function showSugg(q) {
    const box = $('#sugg');
    if (!box) return [];
    const hits = state.emp ? [] : search(q);
    if (!hits.length || (hits.length === 1 && hits[0].id === q.trim())) { hideSugg(); return hits; }
    box.innerHTML = hits.map((p, i) => `<div class="opt${i === 0 ? ' on' : ''}" role="option" data-id="${esc(p.id)}"><b>${esc(p.id)}</b><span>${esc(p.en)}</span><span class="kh">${esc(p.kh || '')}</span></div>`).join('');
    box.hidden = false;
    $('#empId').setAttribute('aria-expanded', 'true');
    return hits;
  }
  function hideSugg() { const box = $('#sugg'); if (box) { box.hidden = true; box.innerHTML = ''; } const el = $('#empId'); if (el) el.setAttribute('aria-expanded', 'false'); }
  function pick(id) { hideSugg(); const el = $('#empId'); if (el) el.value = id; lookup(id); }
  function find(chosen) {
    const v = $('#empId').value.trim();
    if (chosen) return pick(chosen);
    if (!v) return lookup('');
    const hits = search(v);
    const exact = hits.find(p => p.id === v);
    if (exact || hits.length === 1) return pick((exact || hits[0]).id);
    if (/^[A-Za-z0-9-]{1,20}$/.test(v) && /\d/.test(v)) return lookup(v);   // an ID not in the saved list yet
    if (hits.length) { showSugg(v); return; }
    state.emp = null; state.lookupErr = t('រកមិនឃើញបុគ្គលិកដែលមានលេខកាត ឬឈ្មោះនេះទេ។', 'No employee found with that ID or name.'); renderNew(true);
  }
  async function loadPeople() {
    const saved = getJ(K.people, null);
    if (saved && saved.list) state.people = saved.list;
    if (saved && Date.now() - saved.at < 10 * 60000) return;
    try {
      const r = await api('employees');
      state.people = r.list || [];
      set(K.people, JSON.stringify({ at: Date.now(), list: state.people }));
      const el = $('#empId');
      if (el && document.activeElement === el && !state.emp) showSugg(el.value.trim());
    } catch (e) { /* the ID box still works by exact ID */ }
  }

  // ---------- OT date: public holiday from the Setting sheet ----------
  function dayHtml(ymd) {
    if (!ymd) return '';
    const h = ((cfg || {}).holidays || []).find(x => x.date === ymd);
    if (h) return `<span class="hol">🎉 ${esc(t(h.kh || h.en, h.en || h.kh))}</span>`;
    const dow = new Date(ymd + 'T00:00:00').getDay();
    if (dow === 0) return `<span class="sun">🗓️ ${t('ថ្ងៃអាទិត្យ', 'Sunday')}</span>`;
    return `<span class="norm">${t('ថ្ងៃធ្វើការធម្មតា', 'Regular workday')}</span>`;
  }

  function totalHtml(c) {
    if (!c) return `<span>${t('ម៉ោងថែមសរុប', 'Total OT hours')}</span><b>—</b>`;
    if (c.err) return `<span class="msg-err" style="margin:0">${esc(c.err)}</span>`;
    return `<span>${t('ម៉ោងថែមសរុប', 'Total OT hours')} ${c.overnight ? `<span class="tag">🌙 ${t('ឆ្លងថ្ងៃ', 'Overnight')}</span>` : ''}</span><b>${hoursText(c.hours)} ${t('ម៉ោង', 'h')}</b>`;
  }

  const lookupCache = {};
  async function lookup(id) {
    if (!id) { state.lookupErr = t('សូមបញ្ចូលលេខកាតបុគ្គលិក។', 'Please enter your Employee ID.'); return renderNew(true); }
    if (!/^[A-Za-z0-9-]{1,20}$/.test(id)) { state.lookupErr = t('លេខកាតមិនត្រឹមត្រូវ។', 'Please enter a valid Employee ID.'); return renderNew(true); }
    if (state.emp && state.emp.id === id) return;
    const hit = lookupCache[id];
    if (hit && Date.now() - hit.at < 120000) { state.emp = hit.emp; state.lookupErr = ''; set(K.id, id); return renderNew(true); }
    state.lookingUp = true; state.lookupErr = ''; renderNew(true);
    try {
      const emp = await api('lookup', { id });
      lookupCache[id] = { emp, at: Date.now() };
      if ($('#empId') && $('#empId').value.trim() !== id) return;   // typed something else meanwhile
      state.emp = emp; set(K.id, emp.id);
    } catch (e) {
      state.emp = null; state.lookupErr = niceError(e);
    } finally {
      state.lookingUp = false;
      if (state.tab === 'new' && !state.result) renderNew(true);
    }
  }

  function getGps() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error(t('ទូរស័ព្ទនេះមិនអាចរកទីតាំងបានទេ។', 'This phone cannot share its location.')));
      navigator.geolocation.getCurrentPosition(p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => reject(new Error(t('សូមអនុញ្ញាតទីតាំង ហើយព្យាយាមម្តងទៀត។', 'Please allow location and try again.'))),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
    });
  }

  async function submit() {
    if (state.sending) return;   // double tap
    const d = state.draft, c = cfg || {};
    const idNow = $('#empId').value.trim();
    const problems = [];
    if (!state.emp || state.emp.id !== idNow) problems.push(t('សូមស្វែងរកលេខកាតបុគ្គលិករបស់អ្នកជាមុន។', 'Please find your Employee ID first.'));
    if (!d.date) problems.push(t('សូមជ្រើសរើសថ្ងៃ។', 'Please choose the OT date.'));
    if (!d.start || !d.end) problems.push(t('សូមបញ្ចូលម៉ោងចាប់ផ្តើម និងម៉ោងបញ្ចប់។', 'Please enter the start and end time.'));
    const cc = calc(d.start, d.end, c.overnight !== false);
    if (cc && cc.err) problems.push(cc.err);
    if (cc && !cc.err && c.maxHours != null && cc.hours > c.maxHours) problems.push(t('ម៉ោងថែមលើសកំណត់', 'OT is more than the limit of') + ' ' + c.maxHours + ' ' + t('ម៉ោង។', 'hours.'));
    if (String(d.reason || '').trim().length < 3) problems.push(t('សូមបញ្ចូលមូលហេតុ។', 'Please enter the OT reason.'));
    if (problems.length) { state.sendErr = problems.join(' '); renderNew(true); return; }

    state.sending = true; state.sendErr = ''; renderNew(true);
    try {
      const payload = { key: d.key, id: state.emp.id, date: d.date, start: d.start, end: d.end, reason: String(d.reason).trim() };
      if (c.needGps) Object.assign(payload, await getGps());
      const r = await api('submit', payload);
      remember(state.emp.id, r.reqId);
      state.result = Object.assign({ hours: cc.hours, date: d.date, start: d.start, end: d.end, emp: state.emp }, r);
      state.draft = { date: d.date };   // a fresh key for the next request
      saveDraft();
    } catch (e) {
      // The same key is kept, so trying again can never save the request twice.
      state.sendErr = niceError(e);
    } finally {
      state.sending = false;
      if (state.tab === 'new') renderNew(true);
    }
  }

  function remember(id, reqId) {
    const mine = getJ(K.mine, []).filter(x => x.reqId !== reqId);
    mine.unshift({ id, reqId });
    set(K.mine, JSON.stringify(mine.slice(0, 30)));
  }

  function renderDone() {
    const r = state.result;
    const follow = r.status === 'Requires Follow-up';
    $('#view').innerHTML = `
      <section class="card done">
        <div class="emoji">${follow ? '📝' : '✅'}</div>
        <h2>${follow ? t('បានរក្សាទុកសំណើរបស់អ្នក', 'Your OT request has been saved') : t('បានផ្ញើសំណើថែមម៉ោងដោយជោគជ័យ', 'Your OT request has been submitted successfully')}</h2>
        <p>${follow
          ? t('អ្នកគ្រប់គ្រងរបស់អ្នកមិនទាន់អាចទទួលសារ Telegram បានទេ។ សំណើនឹងត្រូវផ្ញើទៅគាត់ភ្លាមៗពេលគាត់ភ្ជាប់រួច។', 'Your line manager cannot receive Telegram messages yet. It will be sent to them as soon as they are connected.')
          : t('សំណើកំពុងរង់ចាំការអនុម័តពី', 'It is now Pending Approval by') + ' <b>' + esc(r.manager || r.emp.manager || '') + '</b>.'}</p>
        <div class="reqid"><span id="rid">${esc(r.reqId)}</span><button type="button" id="copy" aria-label="${esc(t('ចម្លង', 'Copy'))}" title="${esc(t('ចម្លង', 'Copy'))}">📋</button></div>
        <div>${badge(r.status)}</div>
        <div class="item" style="text-align:left;margin-top:16px">
          <div class="meta"><b>${esc(r.emp.en)}</b> · ${esc(r.emp.kh || '')} · ${esc(r.emp.id)}</div>
          <div class="meta">📅 <b>${esc(fmtDate(r.date))}</b> · 🕒 ${esc(h12(r.start))} – ${esc(h12(r.end))} · <b>${esc(hoursText(r.hours))} ${t('ម៉ោង', 'h')}</b></div>
        </div>
        <div class="actions">
          <button type="button" class="btn ok big" id="again">➕ ${t('ស្នើថ្មីមួយទៀត', 'New request')}</button>
          <button type="button" class="btn big" id="toMine">📋 ${t('មើលសំណើរបស់ខ្ញុំ', 'See my requests')}</button>
        </div>
      </section>`;
    $('#copy').onclick = () => { try { navigator.clipboard.writeText(r.reqId); toast(t('បានចម្លង', 'Copied')); } catch (e) { /* old phone */ } };
    $('#again').onclick = () => { state.result = null; renderNew(); };
    $('#toMine').onclick = () => { state.result = null; renderMine(); };
  }

  // ---------- My requests ----------
  async function renderMine() {
    state.tab = 'mine'; paintTabs();
    redraw = () => draw(getJ(K.items, []), false);
    const mine = getJ(K.mine, []);
    const draw = (items, loading, err) => {
      const byId = {}; items.forEach(i => { byId[i.reqId] = i; });
      const rows = mine.map(m => byId[m.reqId]).filter(Boolean);
      $('#view').innerHTML = `
        <div class="head2"><h2>${t('សំណើរបស់ខ្ញុំ', 'My requests')}</h2>
          <button type="button" class="btn" id="refresh" ${loading ? 'disabled' : ''}>${loading ? '<span class="sp"></span>' : '🔄'} ${t('ផ្ទុកឡើងវិញ', 'Refresh')}</button></div>
        ${err ? `<div class="alert bad" style="margin:0 0 12px">${esc(err)}</div>` : ''}
        <div class="list">${rows.length ? rows.map(itemHtml).join('') : `<div class="empty">${loading ? '<div class="spinner" style="margin:20px auto"></div>' : t('មិនទាន់មានសំណើនៅលើទូរស័ព្ទនេះទេ។', 'No requests on this phone yet.')}</div>`}</div>
        <section class="card" style="margin-top:16px">
          <h2>🔍 ${t('ពិនិត្យសំណើ', 'Check a request')}</h2>
          <div class="field row2">
            <div><label class="f" for="qId">${t('លេខកាតបុគ្គលិក', 'Employee ID')}</label><input class="in" id="qId" inputmode="numeric" value="${esc(get(K.id) || '')}"></div>
            <div><label class="f" for="qReq">${t('លេខសំណើ', 'Request ID')}</label><input class="in" id="qReq" placeholder="OT-261010-ABCDE" autocapitalize="characters"></div>
          </div>
          <button type="button" class="btn ok" id="qBtn" style="width:100%">${t('ពិនិត្យ', 'Check')}</button>
          <div class="hint">${t('អ្នកអាចមើលបានតែសំណើរបស់អ្នកប៉ុណ្ណោះ (ត្រូវការទាំងលេខកាត និងលេខសំណើ)។', 'You can only see your own requests (both your Employee ID and the Request ID are needed).')}</div>
        </section>`;
      $('#refresh').onclick = () => renderMine();
      $('#qBtn').onclick = check;
    };
    draw(getJ(K.items, []), mine.length > 0);
    if (!mine.length) return;
    // One call per Employee ID used on this phone.
    const groups = {};
    mine.forEach(m => { (groups[m.id] = groups[m.id] || []).push(m.reqId); });
    try {
      const lists = await Promise.all(Object.keys(groups).map(id => api('status', { id, requests: groups[id] })));
      const items = [].concat.apply([], lists.map(l => l.items));
      set(K.items, JSON.stringify(items));
      if (state.tab === 'mine') draw(items, false);
    } catch (e) {
      if (state.tab === 'mine') draw(getJ(K.items, []), false, niceError(e));
    }
  }

  function itemHtml(i) {
    return `<div class="item">
      <div class="top"><span class="id">${esc(i.reqId)}</span>${badge(i.status)}</div>
      <div class="meta">📅 <b>${esc(i.dateText || fmtDate(i.date))}</b> · 🕒 ${esc(i.from)} – ${esc(i.to)} · <b>${esc(i.hours)} ${t('ម៉ោង', 'h')}</b></div>
      <div class="meta">${esc(i.reason)}</div>
      ${i.status === 'Approved' || i.status === 'Rejected' ? `<div class="meta">${t('ដោយ', 'By')} <b>${esc(i.reviewed)}</b> · ${esc(i.decided)}</div>` : `<div class="meta">${t('អ្នកអនុម័ត', 'Approver')}: <b>${esc(i.manager)}</b></div>`}
      ${i.rejectReason ? `<div class="why">${t('មូលហេតុបដិសេធ', 'Rejection reason')}: ${esc(i.rejectReason)}</div>` : ''}
    </div>`;
  }

  async function check() {
    const id = $('#qId').value.trim(), req = $('#qReq').value.trim().toUpperCase();
    if (!id || !/^OT-\d{6}-[A-Z0-9]{5}$/.test(req)) { toast(t('សូមបញ្ចូលលេខកាត និងលេខសំណើឲ្យត្រឹមត្រូវ។', 'Enter your Employee ID and a valid Request ID.')); return; }
    $('#qBtn').disabled = true;
    try {
      const r = await api('status', { id, requests: [req] });
      if (!r.items.length) { toast(t('រកមិនឃើញសំណើនេះសម្រាប់លេខកាតនេះទេ។', 'No request with that ID for this Employee ID.')); return; }
      remember(id, req);
      const items = getJ(K.items, []).filter(x => x.reqId !== req).concat(r.items);
      set(K.items, JSON.stringify(items));
      renderMine();
    } catch (e) { toast(niceError(e)); }
    finally { if ($('#qBtn')) $('#qBtn').disabled = false; }
  }

  // ---------- chrome ----------
  function paintTabs() {
    document.querySelectorAll('.tab[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === state.tab));
    document.querySelectorAll('[data-km]').forEach(el => { el.textContent = t(el.dataset.km, el.dataset.en); });
    $('#sub').textContent = t('ស្នើសុំថែមម៉ោង', 'OT request');
    document.title = t('ថែមម៉ោង', 'Overtime');
    $('#title').textContent = t('ថែមម៉ោង', 'Overtime');
    $('#themeBtn').title = t('ពន្លឺ / ងងឹត', 'Light / Dark');
    if (DEMO) { $('#demo').hidden = false; $('#demo').textContent = t('DEMO · ទិន្នន័យមិនត្រូវបានរក្សាទុក ហើយមិនផ្ញើ Telegram ទេ', 'DEMO · nothing is saved and no Telegram message is sent'); }
  }
  document.querySelectorAll('.tab[data-tab]').forEach(b => b.onclick = () => (b.dataset.tab === 'mine' ? renderMine() : renderNew()));

  const prefersDark = () => window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
  function paintTheme() { const th = document.documentElement.getAttribute('data-theme') || (prefersDark() ? 'dark' : 'light'); $('#themeBtn').textContent = th === 'dark' ? '☀️' : '🌙'; }
  $('#themeBtn').onclick = () => {
    const now = document.documentElement.getAttribute('data-theme') || (prefersDark() ? 'dark' : 'light');
    const next = now === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next); set('fr_theme', next); paintTheme();
  };
  paintTheme();
  if (window.LANG) { LANG.button($('#langBtn')); LANG.onChange(() => { paintTabs(); redraw(); }); }

  // ---------- demo backend (no API URL yet) ----------
  function demo(action, p) {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const EMP = {
      100027: { id: '100027', en: 'TOUCH E', kh: 'ទូច អេ', manager: 'Kim Sopheakdey', ready: true },
      100037: { id: '100037', en: 'KANG VANNA', kh: 'កាំង វណ្ណា', manager: 'Kim Sopheakdey', ready: true },
      100022: { id: '100022', en: 'SENG VICHEA', kh: '', manager: 'Kim Sopheakdey', ready: false },
    };
    const db = getJ('ot_demo_db', {});
    return wait(350).then(() => {
      if (action === 'config') return { reasons: ['ធ្វើការថ្ងៃបុណ្យ...', 'រៀបចំទំនិញសម្រាប់ដឹកជញ្ជូន...'], overnight: true, needGps: false, maxHours: null, today: localYmd(),
        holidays: [{ date: '2026-10-10', en: 'Phcum Ben Festival', kh: 'ពិធីបុណ្យភ្ជុំបិណ្ឌ' }, { date: '2026-10-15', en: "Commemoration Day of King's Father", kh: 'ទិវាប្រារព្ធពិធីគោរពព្រះវិញ្ញាណក្ខន្ធ ព្រះករុណា ព្រះបាទសម្តេចព្រះ នរោត្តម សីហនុ' }] };
      if (action === 'employees') return { list: Object.keys(EMP).map(k => ({ id: EMP[k].id, en: EMP[k].en, kh: EMP[k].kh })) };
      if (action === 'lookup') { const e = EMP[p.id]; if (!e) throw Object.assign(new Error('Employee ID not found.'), { code: 'NOTFOUND' }); return e; }
      if (action === 'submit') {
        if (db['k_' + p.key]) return { reqId: db['k_' + p.key], status: 'Pending', repeated: true };
        const e = EMP[p.id];
        const reqId = 'OT-' + localYmd().slice(2).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 7).toUpperCase().replace(/[^A-Z0-9]/g, 'X').padEnd(5, 'X');
        const c = calc(p.start, p.end, true);
        db['k_' + p.key] = reqId;
        db[reqId] = { reqId, id: p.id, status: e.ready ? 'Pending' : 'Requires Follow-up', date: p.date, from: h12(p.start), to: h12(p.end), hours: c.hours, reason: p.reason, manager: e.manager };
        set('ot_demo_db', JSON.stringify(db));
        return { reqId, status: db[reqId].status, manager: e.manager };
      }
      if (action === 'status') return { items: (p.requests || []).map(r => db[r]).filter(x => x && x.id === p.id) };
      throw new Error('Unknown action');
    });
  }

  // ---------- start ----------
  renderNew();
  loadConfig();
  loadPeople();
  if (get(K.id) && !state.emp) lookup(get(K.id));
})();
