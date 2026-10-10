/**
 * OT Request & Approval — Google Apps Script backend for the ថែមម៉ោង (Overtime) app.
 *
 * Bound to the SSK_OT_DATA Google Sheet (Extensions > Apps Script inside that sheet).
 * Source of truth: the sheet's own tabs.
 *   - "OT Data"              one row per OT request (existing columns A–L are kept; status columns are added after them)
 *   - "Employee & Approver"  ID No. → Name, Khmer Name, Direct Manager (Approver), Telegram (@username)
 *   - "OT Reason"            preset reasons shown as quick picks on the form
 * Tabs this script adds (nothing existing is moved or overwritten):
 *   - "OT Approvers"         each manager's verified Telegram chat, saved when they press Start on the bot
 *   - "OT Log"               audit trail of every submission, notification and decision
 *   - "OT App Settings"      optional rules (max hours, date window, site GPS check); blank = not enforced
 *
 * Secrets live only in Script Properties: OT_BOT_TOKEN (from @BotFather) and OT_WEBHOOK_SECRET (made by setup()).
 * Telegram reaches this script through the relay at https://isteel-app.pages.dev/tg/ot (functions/tg/ot.js),
 * because Apps Script answers POSTs with a redirect that Telegram counts as a failure.
 *
 * Run once from the editor, in order: setup()  →  (paste the bot token)  →  deploy  →  connectTelegram().
 */

// ---------------------------------------------------------------- names
const OT = {
  DATA: 'OT Data',
  EMP: 'Employee & Approver',
  REASON: 'OT Reason',
  APPROVERS: 'OT Approvers',
  LOG: 'OT Log',
  SETTINGS: 'OT App Settings',
  RELAY_URL: 'https://isteel-app.pages.dev/tg/ot',
};

const STATUS = { PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected', FOLLOW: 'Requires Follow-up' };

// Columns added to "OT Data" after the existing ones (in this order, only if missing).
const NEW_DATA_COLS = ['Request ID', 'Status', 'Approver', 'Decision Time', 'Rejection Reason', 'Telegram Ref', 'Note'];

const APPROVER_COLS = ['Telegram Username', 'Manager Name', 'Chat ID', 'Telegram Name', 'Registered At', 'Active'];
const LOG_COLS = ['Time', 'Request ID', 'Event', 'By', 'Detail', 'Key'];
const SETTING_ROWS = [
  ['Setting', 'Value', 'What it does'],
  ['MAX_HOURS_PER_REQUEST', '', 'Largest OT hours one request may have. Blank = no limit.'],
  ['MAX_DAYS_IN_PAST', '', 'How many days back an OT date may be. Blank = no limit.'],
  ['MAX_DAYS_IN_FUTURE', '', 'How many days ahead an OT date may be. Blank = no limit.'],
  ['ALLOW_OVERNIGHT', 'Yes', 'Yes = End time earlier than Start means the next morning (e.g. 10:00 PM – 12:30 AM).'],
  ['SITE_LATLONG', '', 'Site GPS as "lat, long" (e.g. 11.5564, 104.9282). Blank = no location check.'],
  ['SITE_RADIUS_M', '100', 'How close to the site (metres) the phone must be when SITE_LATLONG is set.'],
];

// Header → field. Headers are compared without case, spaces or punctuation ("From:" = "from").
const DATA_FIELDS = {
  no: ['n', 'no', 'nº'], date: ['date', 'otdate'], id: ['idno', 'employeeid', 'id'], name: ['name', 'employeename'],
  kh: ['khmername'], from: ['from', 'start', 'starttime'], to: ['to', 'end', 'endtime'], hours: ['othr', 'othours', 'hours'],
  reason: ['reasonofot', 'reason', 'otreason'], record: ['datetimerecord', 'submitted'], latlong: ['latlong'],
  reviewed: ['reviewedby'], reqId: ['requestid'], status: ['status'], approver: ['approver'], decided: ['decisiontime'],
  rejectReason: ['rejectionreason'], tgRef: ['telegramref'], note: ['note'],
};
const REQUIRED_DATA = ['date', 'id', 'name', 'from', 'to', 'hours'];

// ---------------------------------------------------------------- web entry points
function doGet() {
  return json_({ ok: true, app: 'OT Request & Approval' });
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return json_({ ok: false, error: 'Bad request' }); }
  try {
    if (body.action === 'telegram') { handleTelegram_(body); return json_({ ok: true }); }
    const p = body.payload || {};
    switch (body.action) {
      case 'config': return json_({ ok: true, data: Object.assign(publicConfig_(), p.withEmployees ? employeeList_() : {}) });
      case 'lookup': return json_({ ok: true, data: lookupPublic_(p.id) });
      case 'employees': return json_({ ok: true, data: employeeList_() });
      case 'submit': return json_({ ok: true, data: submit_(p) });
      case 'status': return json_({ ok: true, data: statusFor_(p) });
      default: return json_({ ok: false, error: 'Unknown action' });
    }
  } catch (err) {
    const msg = String(err && err.message || err);
    if (!/^[A-Z_]+:/.test(msg)) console.error(body.action + ' failed: ' + msg);   // known user errors are not logged as faults
    return json_({ ok: false, error: msg });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------- small helpers
const norm_ = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9º]/g, '');
const tz_ = () => Session.getScriptTimeZone() || 'Asia/Phnom_Penh';
const fmt_ = (d, f) => Utilities.formatDate(d, tz_(), f);
const esc_ = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const prop_ = k => PropertiesService.getScriptProperties().getProperty(k) || '';
const fail_ = (code, msg) => { throw new Error(code + ': ' + msg); };

// Employee IDs are compared as text, so "000123" keeps its zeros; a number cell like 100027 reads "100027" (not "100027.0").
function idText_(v) {
  if (typeof v === 'number') return String(v);
  return String(v == null ? '' : v).trim().replace(/\.0+$/, '');
}

function ss_() { return SpreadsheetApp.getActive(); }
// A sheet with no empty rows left at the bottom gets one more, so a new row can always be written.
function ensureRows_(sh, row) { const max = sh.getMaxRows(); if (row > max) sh.insertRowsAfter(max, row - max); }
function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) fail_('SETUP', 'The sheet tab "' + name + '" is missing.');
  return sh;
}

// Finds each field's column (0-based) from the header row. Unknown headers are ignored.
function headerMap_(headers, fields) {
  const keys = headers.map(norm_);
  const map = {};
  Object.keys(fields).forEach(f => {
    for (const alias of fields[f]) { const i = keys.indexOf(alias); if (i >= 0) { map[f] = i; return; } }
  });
  return map;
}

function minutesOf_(s) {
  const m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?$/);
  if (!m) return null;
  let h = +m[1]; const min = +m[2];
  if (min > 59) return null;
  if (m[3]) { if (h < 1 || h > 12) return null; h = (h % 12) + (/p/i.test(m[3]) ? 12 : 0); } else if (h > 23) return null;
  return h * 60 + min;
}
const hhmm12_ = mins => { const h = Math.floor(mins / 60) % 24, m = mins % 60; return ((h % 12) || 12) + ':' + String(m).padStart(2, '0') + (h < 12 ? ' AM' : ' PM'); };

// Sheet serial day number for a yyyy-mm-dd date (no time zone involved).
function serialOf_(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const back = new Date(t);
  if (back.getUTCFullYear() !== +m[1] || back.getUTCMonth() !== +m[2] - 1 || back.getUTCDate() !== +m[3]) return null;
  return Math.round((t - Date.UTC(1899, 11, 30)) / 86400000);
}
const ymdOfSerial_ = n => new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10);
const dmyOf_ = ymd => { const d = new Date(ymd + 'T00:00:00Z'); return d.getUTCDate() + '-' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()] + '-' + String(d.getUTCFullYear()).slice(2); };

function todayYmd_() { return fmt_(new Date(), 'yyyy-MM-dd'); }

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) fail_('BUSY', 'The system is busy. Please try again.');
  try { return fn(); } finally { lock.releaseLock(); }
}

// ---------------------------------------------------------------- settings
function settings_() {
  const out = {};
  SETTING_ROWS.slice(1).forEach(r => { out[r[0]] = String(r[1]); });
  const sh = ss_().getSheetByName(OT.SETTINGS);
  if (sh && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 2).getDisplayValues().forEach(r => { if (r[0]) out[String(r[0]).trim()] = String(r[1]).trim(); });
  }
  const num = k => (out[k] === '' || isNaN(+out[k]) ? null : +out[k]);
  const ll = String(out.SITE_LATLONG || '').match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  return {
    maxHours: num('MAX_HOURS_PER_REQUEST'),
    maxPast: num('MAX_DAYS_IN_PAST'),
    maxFuture: num('MAX_DAYS_IN_FUTURE'),
    overnight: !/^(no|n|false|0)$/i.test(out.ALLOW_OVERNIGHT || 'Yes'),
    site: ll ? { lat: +ll[1], lng: +ll[2], radius: num('SITE_RADIUS_M') || 100 } : null,
  };
}

function publicConfig_() {
  const s = settings_();
  let reasons = [];
  const sh = ss_().getSheetByName(OT.REASON);
  if (sh && sh.getLastRow() > 1) {
    reasons = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getDisplayValues().map(r => String(r[0]).trim()).filter(Boolean);
  }
  return {
    reasons, maxHours: s.maxHours, maxPast: s.maxPast, maxFuture: s.maxFuture, overnight: s.overnight,
    needGps: !!s.site, radius: s.site ? s.site.radius : null, today: todayYmd_(), holidays: holidays_(),
  };
}

// Khmer names for the holidays listed (in English) in the Setting sheet. A Khmer name typed in the sheet
// (a column whose header has "Khmer", or the column right after "Public Holiday") always wins.
const HOLIDAY_KH = {
  'international new year day': 'ទិវាចូលឆ្នាំសកល',
  'victory day over genocide': 'ទិវាជ័យជម្នះលើរបបប្រល័យពូជសាសន៍',
  "international women's day": 'ទិវានារីអន្តរជាតិ',
  'khmer new year days': 'ពិធីបុណ្យចូលឆ្នាំថ្មីប្រពៃណីជាតិ',
  'khmer new year day': 'ពិធីបុណ្យចូលឆ្នាំថ្មីប្រពៃណីជាតិ',
  'international labor day & visak bochea day': 'ទិវាពលកម្មអន្តរជាតិ និងពិធីបុណ្យវិសាខបូជា',
  'international labor day': 'ទិវាពលកម្មអន្តរជាតិ',
  'visak bochea day': 'ពិធីបុណ្យវិសាខបូជា',
  'royal plowing ceremony': 'ព្រះរាជពិធីច្រត់ព្រះនង្គ័ល',
  "king norodom sihamoni's birthday": 'ព្រះរាជពិធីបុណ្យចម្រើនព្រះជន្ម ព្រះករុណា ព្រះបាទសម្តេចព្រះបរមនាថ នរោត្តម សីហមុនី',
  "queen monineath's birthday": 'ព្រះរាជពិធីបុណ្យចម្រើនព្រះជន្ម សម្តេចព្រះមហាក្សត្រី នរោត្តម មុនិនាថ សីហនុ',
  'constitutional day': 'ទិវាប្រកាសរដ្ឋធម្មនុញ្ញ',
  'phcum ben festival': 'ពិធីបុណ្យភ្ជុំបិណ្ឌ',
  'pchum ben festival': 'ពិធីបុណ្យភ្ជុំបិណ្ឌ',
  "commemoration day of king's father": 'ទិវាប្រារព្ធពិធីគោរពព្រះវិញ្ញាណក្ខន្ធ ព្រះករុណា ព្រះបាទសម្តេចព្រះ នរោត្តម សីហនុ',
  'coronation day of king sihamoni': 'ព្រះរាជពិធីគ្រងព្រះបរមរាជសម្បត្តិ ព្រះករុណា ព្រះបាទសម្តេចព្រះបរមនាថ នរោត្តម សីហមុនី',
  'national independence day': 'ពិធីបុណ្យឯករាជ្យជាតិ',
  'water festival day': 'ព្រះរាជពិធីបុណ្យអុំទូក បណ្តែតប្រទីប និងសំពះព្រះខែ អកអំបុក',
  'peace day in cambodia': 'ទិវាសន្តិភាពនៅកម្ពុជា',
};

// Public holidays from the "Setting" tab: the "Public Holiday" column and the "Date" column just left of it.
function holidays_() {
  const sh = ss_().getSheetByName('Setting');
  if (!sh || sh.getLastRow() < 2) return [];
  const v = sh.getDataRange().getValues();
  const head = v[0].map(norm_);
  const hc = head.indexOf('publicholiday');
  if (hc < 0) return [];
  let dc = -1;
  for (let c = hc - 1; c >= 0; c--) if (head[c] === 'date') { dc = c; break; }
  if (dc < 0) return [];
  const isKh = x => /[\u1780-\u17FF]/.test(String(x || ''));
  let kc = head.findIndex(h => h.indexOf('khmer') >= 0);
  if (kc < 0 && hc + 1 < head.length && !head[hc + 1] && v.slice(1).some(r => isKh(r[hc + 1]))) kc = hc + 1;
  const out = [];
  for (let r = 1; r < v.length; r++) {
    const d = v[r][dc];
    const en = String(v[r][hc] || '').trim();
    if (!(d instanceof Date) || (!en && !(kc >= 0 && v[r][kc]))) continue;
    const typed = kc >= 0 && isKh(v[r][kc]) ? String(v[r][kc]).trim() : (isKh(en) ? en : '');
    out.push({ date: fmt_(d, 'yyyy-MM-dd'), en: isKh(en) ? '' : en, kh: typed || HOLIDAY_KH[en.toLowerCase()] || '' });
  }
  return out;
}

// ---------------------------------------------------------------- employees & approvers
// Read fresh for every submit and approval (the mapping must never be stale there); lookups may use a 2-minute copy.
function readEmployees_() {
  const sh = sheet_(OT.EMP);
  const values = sh.getDataRange().getValues();
  const head = values[0] || [];
  const keys = head.map(norm_);
  const col = test => keys.findIndex(test);
  const c = {
    id: col(k => k === 'idno' || k === 'employeeid' || k === 'id'),
    en: col(k => k === 'name' || k === 'englishname' || k === 'employeename'),
    kh: col(k => k === 'khmername'),
    mgr: col(k => k.indexOf('manager') >= 0 || k.indexOf('approver') >= 0),
    tg: col(k => k.indexOf('telegram') >= 0 && k.indexOf('chat') < 0),
  };
  if (c.id < 0 || c.en < 0 || c.mgr < 0) fail_('SETUP', '"' + OT.EMP + '" needs ID No., Name and Direct Manager (Approver) columns.');
  const byId = {};
  for (let r = 1; r < values.length; r++) {
    const id = idText_(values[r][c.id]);
    if (!id) continue;
    const rec = {
      id, raw: values[r][c.id], row: r + 1,
      en: String(values[r][c.en] || '').trim(),
      kh: c.kh >= 0 ? String(values[r][c.kh] || '').trim() : '',
      manager: String(values[r][c.mgr] || '').trim(),
      telegram: c.tg >= 0 ? String(values[r][c.tg] || '').trim() : '',
    };
    (byId[id] = byId[id] || []).push(rec);
  }
  return byId;
}

// Khmer names already typed in old OT rows: used while "Khmer Name" is still blank in Employee & Approver.
function khmerFromHistory_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('kh_hist');
  if (hit) return JSON.parse(hit);
  const sh = sheet_(OT.DATA);
  const last = sh.getLastRow();
  const out = {};
  if (last > 1) {
    const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    const m = headerMap_(head, DATA_FIELDS);
    if (m.id != null && m.kh != null) {
      const ids = sh.getRange(2, m.id + 1, last - 1, 1).getValues();
      const kh = sh.getRange(2, m.kh + 1, last - 1, 1).getValues();
      for (let i = 0; i < ids.length; i++) { const k = String(kh[i][0] || '').trim(); if (k) out[idText_(ids[i][0])] = k; }
    }
  }
  try { cache.put('kh_hist', JSON.stringify(out), 600); } catch (e) { /* too big for cache: fine */ }
  return out;
}

function readApprovers_() {
  const sh = ss_().getSheetByName(OT.APPROVERS);
  const list = [];
  if (!sh || sh.getLastRow() < 2) return list;
  const v = sh.getRange(2, 1, sh.getLastRow() - 1, APPROVER_COLS.length).getValues();
  v.forEach((r, i) => list.push({
    row: i + 2, username: normUser_(r[0]), manager: String(r[1] || ''), chatId: String(r[2] || '').trim(),
    tgName: String(r[3] || ''), active: !/^(no|n|false|0)$/i.test(String(r[5] || 'Yes')),
  }));
  return list;
}
const normUser_ = u => String(u || '').trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '').toLowerCase();

/**
 * The one place that decides who approves an employee's OT. Returns
 *   { ok: true, emp, manager, username, chatId }  or  { ok: false, code, msg, emp? }
 * It never falls back to another person: a missing or doubtful link is reported instead.
 */
function resolveApprover_(id, employees, approvers) {
  const recs = employees[idText_(id)];
  if (!recs) return { ok: false, code: 'NOTFOUND', msg: 'Employee ID not found.' };
  if (recs.length > 1) return { ok: false, code: 'DUPLICATE', msg: 'This Employee ID is listed ' + recs.length + ' times in "' + OT.EMP + '".' };
  const emp = recs[0];
  if (!emp.manager) return { ok: false, code: 'NOMANAGER', msg: 'No line manager is set for this employee.', emp };
  const username = normUser_(emp.telegram);
  if (!username) return { ok: false, code: 'NOTELEGRAM', msg: 'The line manager has no Telegram username in "' + OT.EMP + '".', emp, manager: emp.manager };
  const matches = approvers.filter(a => a.username === username && a.active && a.chatId);
  if (!matches.length) return { ok: false, code: 'NOTREGISTERED', msg: 'Line manager @' + username + ' has not pressed Start on the OT bot yet.', emp, manager: emp.manager };
  const chats = Array.from(new Set(matches.map(a => a.chatId)));
  if (chats.length > 1) return { ok: false, code: 'AMBIGUOUS', msg: '@' + username + ' is registered with more than one Telegram account in "' + OT.APPROVERS + '".', emp, manager: emp.manager };
  return { ok: true, emp, manager: emp.manager, username, chatId: chats[0] };
}

function employeesCached_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('emp_v1');
  if (hit) return JSON.parse(hit);
  const e = readEmployees_();
  try { cache.put('emp_v1', JSON.stringify(e), 120); } catch (err) { /* large list: skip cache */ }
  return e;
}

// For the search box: ID, English name and Khmer name of every employee (no Telegram details).
// It also carries each person's line manager name and whether that manager can get Telegram yet, so picking a
// name fills the form at once. The server still re-checks the employee and manager on every submit.
function employeeList_() {
  const employees = employeesCached_();
  const approvers = readApprovers_();
  const kh = khmerFromHistory_();
  const list = [];
  Object.keys(employees).forEach(id => {
    if (employees[id].length > 1) return;   // duplicated IDs are refused at lookup and submit
    const e = employees[id][0];
    const r = resolveApprover_(id, employees, approvers);
    list.push({ id, en: e.en, kh: e.kh || kh[id] || '', manager: e.manager || '', ready: r.ok });
  });
  list.sort((a, b) => a.en.localeCompare(b.en));
  return { list };
}

function lookupPublic_(id) {
  id = idText_(id);
  if (!/^[A-Za-z0-9-]{1,20}$/.test(id)) fail_('INVALID', 'Please enter a valid Employee ID.');
  const employees = employeesCached_();
  const r = resolveApprover_(id, employees, readApprovers_());
  if (!r.ok && (r.code === 'NOTFOUND' || r.code === 'DUPLICATE')) fail_(r.code, r.msg);
  const emp = r.emp;
  return {
    id: emp.id, en: emp.en, kh: emp.kh || khmerFromHistory_()[emp.id] || '',
    manager: emp.manager || '', ready: r.ok, problem: r.ok ? '' : r.code,
  };
}

// ---------------------------------------------------------------- OT Data access
function dataSheet_() {
  const sh = sheet_(OT.DATA);
  const lastCol = sh.getLastColumn();
  const head = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const map = headerMap_(head, DATA_FIELDS);
  const missing = REQUIRED_DATA.filter(f => map[f] == null);
  if (missing.length) fail_('SETUP', '"' + OT.DATA + '" is missing columns: ' + missing.join(', '));
  if (map.reqId == null || map.status == null) fail_('SETUP', 'Run setup() once to add the Request ID and Status columns.');
  return { sh, head, map, width: lastCol };
}

function findRequestRow_(ds, reqId) {
  const last = ds.sh.getLastRow();
  if (last < 2 || !reqId) return null;
  const ids = ds.sh.getRange(2, ds.map.reqId + 1, last - 1, 1).getValues();
  for (let i = ids.length - 1; i >= 0; i--) if (String(ids[i][0]) === reqId) return i + 2;
  return null;
}

function readRow_(ds, row) {
  const v = ds.sh.getRange(row, 1, 1, ds.width).getValues()[0];
  const d = ds.sh.getRange(row, 1, 1, ds.width).getDisplayValues()[0];
  const g = f => (ds.map[f] == null ? '' : v[ds.map[f]]);
  const gd = f => (ds.map[f] == null ? '' : d[ds.map[f]]);
  const date = g('date');
  return {
    row, reqId: String(g('reqId')), status: String(g('status') || ''), id: idText_(g('id')),
    en: String(g('name') || ''), kh: String(g('kh') || ''),
    date: date instanceof Date ? fmt_(date, 'yyyy-MM-dd') : '', dateText: gd('date'),
    from: gd('from'), to: gd('to'), hours: g('hours'), reason: String(g('reason') || ''),
    approver: String(g('approver') || ''), reviewed: String(g('reviewed') || ''),
    decided: gd('decided'), rejectReason: String(g('rejectReason') || ''), tgRef: String(g('tgRef') || ''),
    submitted: gd('record'), note: String(g('note') || ''),
  };
}

function setCells_(ds, row, fields) {
  Object.keys(fields).forEach(f => { if (ds.map[f] != null) ds.sh.getRange(row, ds.map[f] + 1).setValue(fields[f]); });
}

// ---------------------------------------------------------------- submit
function newRequestId_(ds) {
  const day = fmt_(new Date(), 'yyMMdd');
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  for (let t = 0; t < 10; t++) {
    let s = '';
    for (let i = 0; i < 5; i++) s += abc[Math.floor(Math.random() * abc.length)];
    const id = 'OT-' + day + '-' + s;
    if (!findRequestRow_(ds, id)) return id;
  }
  fail_('BUSY', 'Could not create a Request ID. Please try again.');
}

function validate_(p, cfg) {
  const date = String(p.date || '');
  const serial = serialOf_(date);
  if (serial == null) fail_('INVALID', 'Please choose a valid OT date.');
  const s = minutesOf_(p.start), e = minutesOf_(p.end);
  if (s == null) fail_('INVALID', 'Please enter a valid start time.');
  if (e == null) fail_('INVALID', 'Please enter a valid end time.');
  if (s === e) fail_('INVALID', 'Start and end time cannot be the same.');
  const overnight = e < s;
  if (overnight && !cfg.overnight) fail_('INVALID', 'End time must be after start time.');
  const minutes = overnight ? e + 1440 - s : e - s;
  const hours = Math.round(minutes / 60 * 100) / 100;
  if (cfg.maxHours != null && hours > cfg.maxHours) fail_('INVALID', 'OT cannot be more than ' + cfg.maxHours + ' hours in one request.');
  const today = serialOf_(todayYmd_());
  if (cfg.maxPast != null && serial < today - cfg.maxPast) fail_('INVALID', 'The OT date is too far in the past (limit ' + cfg.maxPast + ' days).');
  if (cfg.maxFuture != null && serial > today + cfg.maxFuture) fail_('INVALID', 'The OT date is too far ahead (limit ' + cfg.maxFuture + ' days).');
  const reason = String(p.reason || '').trim().replace(/\s+/g, ' ');
  if (reason.length < 3) fail_('INVALID', 'Please enter the OT reason.');
  if (reason.length > 500) fail_('INVALID', 'The reason is too long (500 characters at most).');
  let latlong = '';
  if (cfg.site) {
    const lat = +p.lat, lng = +p.lng;
    if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) fail_('GPS', 'Location is needed. Please allow location and try again.');
    const dist = distanceM_(lat, lng, cfg.site.lat, cfg.site.lng);
    if (dist > cfg.site.radius) fail_('GPS', 'You are ' + Math.round(dist) + ' m from the site. OT can only be requested within ' + cfg.site.radius + ' m.');
    latlong = lat.toFixed(6) + ', ' + lng.toFixed(6);
  }
  return { date, serial, s, e, overnight, minutes, hours, reason, latlong };
}

function distanceM_(a, b, c, d) {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(c - a), dLng = rad(d - b);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Same employee, same time already on file (any status but Rejected) → refuse, so a request is never entered twice.
function findOverlap_(ds, id, v) {
  const last = ds.sh.getLastRow();
  if (last < 2) return null;
  const n = last - 1, m = ds.map;
  const ids = ds.sh.getRange(2, m.id + 1, n, 1).getValues();
  const dates = ds.sh.getRange(2, m.date + 1, n, 1).getValues();
  const from = ds.sh.getRange(2, m.from + 1, n, 1).getDisplayValues();
  const to = ds.sh.getRange(2, m.to + 1, n, 1).getDisplayValues();
  const st = ds.sh.getRange(2, m.status + 1, n, 1).getValues();
  const rq = ds.sh.getRange(2, m.reqId + 1, n, 1).getValues();
  const start = v.serial * 1440 + v.s, end = start + v.minutes;
  for (let i = 0; i < n; i++) {
    if (idText_(ids[i][0]) !== id || String(st[i][0]) === STATUS.REJECTED) continue;
    const d = dates[i][0];
    if (!(d instanceof Date)) continue;
    const ds0 = serialOf_(fmt_(d, 'yyyy-MM-dd'));
    if (ds0 == null || Math.abs(ds0 - v.serial) > 1) continue;
    const a = minutesOf_(from[i][0]), b = minutesOf_(to[i][0]);
    if (a == null || b == null) continue;
    const s2 = ds0 * 1440 + a, e2 = s2 + (b <= a ? b + 1440 - a : b - a);
    if (start < e2 && s2 < end) return { row: i + 2, reqId: String(rq[i][0] || ''), from: from[i][0], to: to[i][0] };
  }
  return null;
}

function submit_(p) {
  const key = String(p.key || '');
  if (!/^[A-Za-z0-9-]{12,64}$/.test(key)) fail_('INVALID', 'Please reload the page and try again.');
  const id = idText_(p.id);
  if (!/^[A-Za-z0-9-]{1,20}$/.test(id)) fail_('INVALID', 'Please enter a valid Employee ID.');

  // Light flood guard: at most 12 submissions per Employee ID per hour.
  const cache = CacheService.getScriptCache();
  const rk = 'rate_' + id, count = +(cache.get(rk) || 0);
  if (count >= 12) fail_('LIMIT', 'Too many requests for this Employee ID. Please wait and try again later.');

  const cfg = settings_();
  const v = validate_(p, cfg);

  const saved = withLock_(() => {
    // Same form sent again (double tap, refresh, retry after a dropped connection) → the first result, never a 2nd row.
    const prev = cache.get('key_' + key) || findKeyInLog_(key);
    if (prev) return { again: true, reqId: prev };

    const employees = readEmployees_();
    const route = resolveApprover_(id, employees, readApprovers_());
    if (!route.ok && (route.code === 'NOTFOUND' || route.code === 'DUPLICATE')) fail_(route.code, route.msg);
    const emp = route.emp;
    const ds = dataSheet_();
    const clash = findOverlap_(ds, id, v);
    if (clash) fail_('DUPLICATE_OT', 'You already have OT on this date from ' + clash.from + ' to ' + clash.to + (clash.reqId ? ' (' + clash.reqId + ')' : '') + '.');

    const reqId = newRequestId_(ds);
    const now = new Date();
    const kh = emp.kh || khmerFromHistory_()[emp.id] || '';
    const last = ds.sh.getLastRow();
    const row = last + 1;
    const vals = new Array(ds.width).fill('');
    const put = (f, x) => { if (ds.map[f] != null) vals[ds.map[f]] = x; };
    let no = '';
    if (ds.map.no != null && last > 1) {
      const prevNo = ds.sh.getRange(last, ds.map.no + 1).getValue();
      if (typeof prevNo === 'number') no = prevNo + 1;
    } else if (ds.map.no != null) no = 1;
    put('no', no);
    put('date', v.serial);
    put('id', typeof emp.raw === 'number' ? emp.raw : emp.id);   // same cell type as the employee list, so lookups and pivots keep matching
    put('name', emp.en);
    put('kh', kh);
    put('from', v.s / 1440);
    put('to', v.e / 1440);
    put('hours', v.hours);
    put('reason', v.reason);
    put('record', now);
    put('latlong', v.latlong);
    put('reqId', reqId);
    put('status', route.ok ? STATUS.PENDING : STATUS.FOLLOW);
    put('approver', emp.manager);
    put('note', route.ok ? '' : route.msg);

    ensureRows_(ds.sh, row);
    if (last >= 2) ds.sh.getRange(last, 1, 1, ds.width).copyTo(ds.sh.getRange(row, 1, 1, ds.width), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    ds.sh.getRange(row, 1, 1, ds.width).setValues([vals]);
    if (ds.map.date != null) ds.sh.getRange(row, ds.map.date + 1).setNumberFormat('d-mmm-yy');
    if (ds.map.from != null) ds.sh.getRange(row, ds.map.from + 1).setNumberFormat('h:mm am/pm');
    if (ds.map.to != null) ds.sh.getRange(row, ds.map.to + 1).setNumberFormat('h:mm am/pm');
    if (ds.map.record != null) ds.sh.getRange(row, ds.map.record + 1).setNumberFormat('d-mmm-yy h:mm am/pm');
    SpreadsheetApp.flush();

    // Read back: success is reported only for a row that is really in the sheet.
    if (findRequestRow_(ds, reqId) !== row) fail_('SAVE', 'The request could not be saved. Please try again.');
    log_(reqId, 'SUBMITTED', id + ' ' + emp.en, v.date + ' ' + hhmm12_(v.s) + '–' + hhmm12_(v.e) + ' (' + v.hours + ' h) → ' + emp.manager, key);
    if (!route.ok) log_(reqId, 'FOLLOW_UP', 'system', route.code + ': ' + route.msg);
    try { cache.put('key_' + key, reqId, 21600); } catch (e) { /* log is the fallback */ }
    cache.put(rk, String(count + 1), 3600);
    return { row, reqId, route, emp, kh, v };
  });

  if (saved.again) {
    const ds = dataSheet_();
    const r = findRequestRow_(ds, saved.reqId);
    const rec = r ? readRow_(ds, r) : null;
    return { reqId: saved.reqId, status: rec ? rec.status : STATUS.PENDING, repeated: true };
  }

  // Saved. Now the Telegram message goes to that employee's own line manager only.
  let status = saved.route.ok ? STATUS.PENDING : STATUS.FOLLOW;
  if (saved.route.ok) {
    try {
      notifyApprover_(saved.reqId, saved.route.chatId);
    } catch (err) {
      status = STATUS.FOLLOW;
      withLock_(() => {
        const ds = dataSheet_();
        const row = findRequestRow_(ds, saved.reqId);
        const rec = row && readRow_(ds, row);
        if (rec && rec.status === STATUS.PENDING && !rec.tgRef) setCells_(ds, row, { status: STATUS.FOLLOW, note: 'Telegram send failed: ' + safeErr_(err) });
      });
      log_(saved.reqId, 'NOTIFY_FAILED', 'system', safeErr_(err));
    }
  }
  return { reqId: saved.reqId, status, manager: saved.emp.manager, problem: saved.route.ok ? '' : saved.route.code };
}

function findKeyInLog_(key) {
  const sh = ss_().getSheetByName(OT.LOG);
  if (!sh || sh.getLastRow() < 2) return '';
  const n = Math.min(800, sh.getLastRow() - 1), start = sh.getLastRow() - n + 1;
  const v = sh.getRange(start, 1, n, LOG_COLS.length).getValues();
  for (let i = v.length - 1; i >= 0; i--) if (String(v[i][5]) === key && String(v[i][2]) === 'SUBMITTED') return String(v[i][1]);
  return '';
}

// ---------------------------------------------------------------- status (employee view)
// An employee sees a request only when both their Employee ID and the Request ID match.
function statusFor_(p) {
  const id = idText_(p.id);
  const ids = (Array.isArray(p.requests) ? p.requests : [p.requestId]).map(x => String(x || '').trim().toUpperCase()).filter(x => /^OT-\d{6}-[A-Z0-9]{5}$/.test(x)).slice(0, 30);
  if (!id || !ids.length) return { items: [] };
  const ds = dataSheet_();
  const last = ds.sh.getLastRow();
  if (last < 2) return { items: [] };
  const all = ds.sh.getRange(2, ds.map.reqId + 1, last - 1, 1).getValues();
  const items = [];
  for (let i = all.length - 1; i >= 0; i--) {
    const rq = String(all[i][0]);
    if (ids.indexOf(rq) < 0) continue;
    const r = readRow_(ds, i + 2);
    if (r.id !== id) continue;
    items.push({
      reqId: r.reqId, status: r.status || STATUS.PENDING, date: r.date, dateText: r.dateText, from: r.from, to: r.to, hours: r.hours,
      reason: r.reason, manager: r.approver, reviewed: r.reviewed, decided: r.decided, rejectReason: r.rejectReason, submitted: r.submitted,
    });
  }
  return { items };
}

// ---------------------------------------------------------------- Telegram
function tg_(method, payload) {
  const token = prop_('OT_BOT_TOKEN');
  if (!token) throw new Error('OT_BOT_TOKEN is not set in Script Properties');
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true,
  });
  let data = {};
  try { data = JSON.parse(res.getContentText()); } catch (e) { /* not JSON */ }
  if (!data.ok) throw new Error('Telegram ' + method + ': ' + (data.description || ('HTTP ' + res.getResponseCode())));
  return data.result;
}
// Error text without the bot token, for the sheet and logs.
const safeErr_ = e => String(e && e.message || e).replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot***').slice(0, 300);

function requestText_(rec, header) {
  return [
    header,
    '',
    '• Request ID: <b>' + esc_(rec.reqId) + '</b>',
    '• Employee ID: ' + esc_(rec.id),
    '• Employee Name: ' + esc_(rec.en),
    '• Khmer Name: ' + esc_(rec.kh || '-'),
    '• OT Date: ' + esc_(rec.dateText || rec.date),
    '• OT Time: ' + esc_(rec.from) + ' – ' + esc_(rec.to),
    '• Total OT Hours: <b>' + esc_(rec.hours) + '</b>',
    '• Reason: ' + esc_(rec.reason || '-'),
  ].join('\n');
}

const KEYBOARD_ = reqId => ({ inline_keyboard: [[{ text: '✅ Approve', callback_data: 'a:' + reqId }, { text: '❌ Reject', callback_data: 'r:' + reqId }]] });

function notifyApprover_(reqId, chatId) {
  const ds = dataSheet_();
  const row = findRequestRow_(ds, reqId);
  if (!row) throw new Error('Request not found');
  const rec = readRow_(ds, row);
  const msg = tg_('sendMessage', {
    chat_id: chatId, parse_mode: 'HTML', disable_web_page_preview: true,
    text: requestText_(rec, '🕒 <b>New OT Request — Pending Approval</b>') + '\n\nPlease review this request.',
    reply_markup: KEYBOARD_(reqId),
  });
  withLock_(() => {
    const ds2 = dataSheet_();
    const r = findRequestRow_(ds2, reqId);
    if (r) setCells_(ds2, r, { tgRef: chatId + ':' + msg.message_id });
  });
  log_(reqId, 'NOTIFIED', 'system', 'Telegram sent to ' + rec.approver + ' (chat ' + chatId + ')');
}

function handleTelegram_(body) {
  const secret = prop_('OT_WEBHOOK_SECRET');
  if (!secret || String(body.secret || '') !== secret) { console.warn('Telegram call with a wrong secret was ignored'); return; }
  const u = body.update || {};
  // Telegram may send the same update twice; handle each update_id once.
  const cache = CacheService.getScriptCache();
  if (u.update_id != null) {
    const k = 'upd_' + u.update_id;
    if (cache.get(k)) return;
    cache.put(k, '1', 21600);
  }
  try {
    if (u.callback_query) return onButton_(u.callback_query);
    if (u.message) return onMessage_(u.message);
  } catch (err) {
    console.error('Telegram update failed: ' + safeErr_(err));
  }
}

function onMessage_(m) {
  if (!m.chat || m.chat.type !== 'private') return;   // approvals happen in private chats only
  const text = String(m.text || '').trim();
  const from = m.from || {};
  if (m.reply_to_message && !/^\//.test(text)) return onRejectReason_(m);
  if (/^\/start\b/i.test(text) || /^\/register\b/i.test(text)) return registerApprover_(m);
  if (/^\/myid\b/i.test(text)) return tg_('sendMessage', { chat_id: m.chat.id, text: 'Your Telegram chat ID: ' + from.id + (from.username ? '\nUsername: @' + from.username : '') });
  tg_('sendMessage', { chat_id: m.chat.id, text: 'This bot sends OT requests to line managers for approval.\n\n/start — register as an approver\n/myid — show your Telegram ID' });
}

function registerApprover_(m) {
  const from = m.from || {};
  const chatId = String(m.chat.id);
  const username = normUser_(from.username);
  if (!username) {
    return tg_('sendMessage', { chat_id: chatId, text: 'Please set a Telegram username first (Settings → Username), then press /start again.' });
  }
  const employees = readEmployees_();
  let manager = '';
  Object.keys(employees).some(k => employees[k].some(e => { if (normUser_(e.telegram) === username) { manager = e.manager; return true; } return false; }));
  if (!manager) {
    log_('', 'REGISTER_REFUSED', '@' + username + ' (' + chatId + ')', 'Not listed as an approver');
    return tg_('sendMessage', { chat_id: chatId, text: '@' + username + ' is not listed as a line manager in the OT system. Ask HR to put your Telegram username in "' + OT.EMP + '".' });
  }
  const result = withLock_(() => {
    const sh = ensureSheet_(OT.APPROVERS, APPROVER_COLS);
    const list = readApprovers_();
    const same = list.filter(a => a.username === username);
    const other = same.find(a => a.chatId && a.chatId !== chatId && a.active);
    if (other) return 'conflict';
    const tgName = [from.first_name, from.last_name].filter(Boolean).join(' ');
    const row = same.length ? same[0].row : sh.getLastRow() + 1;
    ensureRows_(sh, row);
    sh.getRange(row, 1, 1, APPROVER_COLS.length).setValues([['@' + username, manager, chatId, tgName, new Date(), 'Yes']]);
    sh.getRange(row, 3).setNumberFormat('@');
    return same.length && same[0].chatId === chatId ? 'again' : 'new';
  });
  if (result === 'conflict') {
    log_('', 'REGISTER_REFUSED', '@' + username + ' (' + chatId + ')', 'Username already registered to another Telegram account');
    return tg_('sendMessage', { chat_id: chatId, text: '@' + username + ' is already registered to another Telegram account. Ask the admin to clear the old row in "' + OT.APPROVERS + '", then press /start again.' });
  }
  log_('', 'REGISTERED', '@' + username + ' (' + chatId + ')', manager);
  tg_('sendMessage', { chat_id: chatId, text: '✅ Registered. OT requests from your team (' + manager + ') will come here for approval.' });
  resendFollowUps_();
}

function onButton_(q) {
  const data = String(q.data || '');
  const m = data.match(/^([ar]):(OT-\d{6}-[A-Z0-9]{5})$/);
  const answer = (text, alert) => { try { tg_('answerCallbackQuery', { callback_query_id: q.id, text, show_alert: !!alert }); } catch (e) { /* expired */ } };
  if (!m) return answer('Unknown action.', true);
  const approve = m[1] === 'a', reqId = m[2];
  const who = String(q.from && q.from.id || '');
  const whoName = (q.from && (q.from.username ? '@' + q.from.username : q.from.first_name)) || who;

  const out = withLock_(() => {
    const ds = dataSheet_();
    const row = findRequestRow_(ds, reqId);
    if (!row) return { err: 'This request was not found.' };
    const rec = readRow_(ds, row);
    // Check the approver against today's mapping, not against whatever the message says.
    const route = resolveApprover_(rec.id, readEmployees_(), readApprovers_());
    if (!route.ok || route.chatId !== who) {
      log_(reqId, 'DENIED', whoName + ' (' + who + ')', (approve ? 'approve' : 'reject') + ' refused: not the assigned line manager');
      return { err: 'Only the assigned line manager can approve or reject this request.' };
    }
    if (rec.status !== STATUS.PENDING && rec.status !== STATUS.FOLLOW) return { done: rec };
    const now = new Date();
    setCells_(ds, row, { status: approve ? STATUS.APPROVED : STATUS.REJECTED, reviewed: route.manager, decided: now });
    if (ds.map.decided != null) ds.sh.getRange(row, ds.map.decided + 1).setNumberFormat('d-mmm-yy h:mm am/pm');
    SpreadsheetApp.flush();
    log_(reqId, approve ? 'APPROVED' : 'REJECTED', route.manager + ' (' + who + ')', '');
    return { rec: readRow_(ds, row) };
  });

  if (out.err) return answer(out.err, true);
  const msgRef = q.message ? { chat_id: q.message.chat.id, message_id: q.message.message_id } : null;
  if (out.done) {
    answer('This request has already been processed (' + out.done.status + ').', true);
    if (msgRef) try { tg_('editMessageReplyMarkup', Object.assign({ reply_markup: { inline_keyboard: [] } }, msgRef)); } catch (e) { /* already edited */ }
    return;
  }
  const r = out.rec;
  const line = r.status === STATUS.APPROVED ? '✅ <b>Approved</b> by ' + esc_(r.reviewed) + ' · ' + esc_(r.decided) : '❌ <b>Rejected</b> by ' + esc_(r.reviewed) + ' · ' + esc_(r.decided);
  if (msgRef) {
    try {
      tg_('editMessageText', Object.assign({ parse_mode: 'HTML', disable_web_page_preview: true, text: requestText_(r, r.status === STATUS.APPROVED ? '✅ <b>OT Request — Approved</b>' : '❌ <b>OT Request — Rejected</b>') + '\n\n' + line, reply_markup: { inline_keyboard: [] } }, msgRef));
    } catch (e) { console.warn('edit failed: ' + safeErr_(e)); }
  }
  answer(r.status === STATUS.APPROVED ? 'Approved ✅' : 'Rejected ❌');
  if (r.status === STATUS.REJECTED && msgRef) {
    try {
      const ask = tg_('sendMessage', { chat_id: msgRef.chat_id, text: '✍️ Reason for rejecting ' + reqId + '? Reply to this message (optional).', reply_markup: { force_reply: true, input_field_placeholder: 'Rejection reason' } });
      PropertiesService.getScriptProperties().setProperty('rr_' + msgRef.chat_id + '_' + ask.message_id, reqId);
    } catch (e) { /* the rejection stands without a reason */ }
  }
}

function onRejectReason_(m) {
  const props = PropertiesService.getScriptProperties();
  const k = 'rr_' + m.chat.id + '_' + m.reply_to_message.message_id;
  const reqId = props.getProperty(k);
  if (!reqId) return;
  const reason = String(m.text || '').trim().slice(0, 500);
  if (!reason) return;
  const who = String(m.from && m.from.id || '');
  const ok = withLock_(() => {
    const ds = dataSheet_();
    const row = findRequestRow_(ds, reqId);
    if (!row) return false;
    const rec = readRow_(ds, row);
    const route = resolveApprover_(rec.id, readEmployees_(), readApprovers_());
    if (!route.ok || route.chatId !== who || rec.status !== STATUS.REJECTED) return false;
    setCells_(ds, row, { rejectReason: reason });
    log_(reqId, 'REJECT_REASON', route.manager + ' (' + who + ')', reason);
    return true;
  });
  props.deleteProperty(k);
  tg_('sendMessage', { chat_id: m.chat.id, text: ok ? 'Reason saved for ' + reqId + '.' : 'The reason could not be saved for ' + reqId + '.' });
}

// Requests waiting on a manager who was not reachable: send them now if the manager can be reached.
// Runs after each new registration and every 15 minutes (trigger made by setup()).
function resendFollowUps_() {
  let ds;
  try { ds = dataSheet_(); } catch (e) { return; }
  const last = ds.sh.getLastRow();
  if (last < 2) return;
  const st = ds.sh.getRange(2, ds.map.status + 1, last - 1, 1).getValues();
  const rq = ds.sh.getRange(2, ds.map.reqId + 1, last - 1, 1).getValues();
  const todo = [];
  st.forEach((s, i) => { if (String(s[0]) === STATUS.FOLLOW && rq[i][0]) todo.push(String(rq[i][0])); });
  if (!todo.length) return;
  const employees = readEmployees_(), approvers = readApprovers_();
  todo.slice(0, 30).forEach(reqId => {
    const claimed = withLock_(() => {
      const d = dataSheet_();
      const row = findRequestRow_(d, reqId);
      if (!row) return null;
      const rec = readRow_(d, row);
      if (rec.status !== STATUS.FOLLOW) return null;
      const route = resolveApprover_(rec.id, employees, approvers);
      if (!route.ok) { if (rec.note !== route.msg) setCells_(d, row, { note: route.msg }); return null; }
      setCells_(d, row, { status: STATUS.PENDING, note: '', approver: route.manager });
      return route;
    });
    if (!claimed) return;
    try { notifyApprover_(reqId, claimed.chatId); }
    catch (err) {
      withLock_(() => { const d = dataSheet_(); const row = findRequestRow_(d, reqId); if (row) setCells_(d, row, { status: STATUS.FOLLOW, note: 'Telegram send failed: ' + safeErr_(err) }); });
      log_(reqId, 'NOTIFY_FAILED', 'system', safeErr_(err));
    }
  });
}
function retryFollowUps() { resendFollowUps_(); }

// ---------------------------------------------------------------- audit log
function log_(reqId, event, by, detail, key) {
  try {
    const sh = ensureSheet_(OT.LOG, LOG_COLS);
    sh.appendRow([new Date(), reqId || '', event, by || '', detail || '', key || '']);
  } catch (e) { console.error('log failed: ' + e); }
}

// ---------------------------------------------------------------- setup (run from the editor)
function ensureSheet_(name, cols) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Step 1. Adds the missing columns and tabs, makes the webhook secret and the 15-minute retry trigger. Safe to run again. */
function setup() {
  const ss = ss_();
  const data = sheet_(OT.DATA);
  const head = data.getRange(1, 1, 1, data.getLastColumn()).getValues()[0];
  const have = head.map(norm_);
  const add = NEW_DATA_COLS.filter(c => have.indexOf(norm_(c)) < 0);
  if (add.length) {
    const start = data.getLastColumn() + 1;
    if (data.getMaxColumns() < start + add.length - 1) data.insertColumnsAfter(data.getMaxColumns(), start + add.length - 1 - data.getMaxColumns());
    const hdr = data.getRange(1, start, 1, add.length);
    data.getRange(1, start - 1).copyTo(hdr, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);   // same look as the old headers
    hdr.setValues([add]);
  }
  ensureSheet_(OT.APPROVERS, APPROVER_COLS).getRange('C:C').setNumberFormat('@');
  ensureSheet_(OT.LOG, LOG_COLS);
  if (!ss.getSheetByName(OT.SETTINGS)) {
    const s = ss.insertSheet(OT.SETTINGS);
    s.getRange(1, 1, SETTING_ROWS.length, 3).setValues(SETTING_ROWS);
    s.getRange(1, 1, 1, 3).setFontWeight('bold');
    s.setFrozenRows(1);
    s.setColumnWidth(1, 210); s.setColumnWidth(2, 180); s.setColumnWidth(3, 520);
  }
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('OT_WEBHOOK_SECRET')) props.setProperty('OT_WEBHOOK_SECRET', Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
  if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'retryFollowUps')) {
    ScriptApp.newTrigger('retryFollowUps').timeBased().everyMinutes(15).create();
  }
  console.log('Setup done. Added OT Data columns: ' + (add.join(', ') || 'none (already there)'));
  console.log(checkData());
}

/** Step 3 (after deploying the web app). Points the bot at this script through the Cloudflare relay. */
function connectTelegram() {
  // Apps Script often reports the editor's /dev address here, so the /exec URL in OT_WEB_APP_URL wins when set.
  const url = String(prop_('OT_WEB_APP_URL') || ScriptApp.getService().getUrl() || '').trim();
  const m = url.match(/\/macros\/(?:a\/[^/]+\/)?s\/([A-Za-z0-9_-]+)\/exec\b/) || url.match(/\/macros\/s\/([A-Za-z0-9_-]+)\/exec\b/);
  if (!m) throw new Error('Deploy the web app first (Deploy → New deployment → Web app). If this still fails, put the /exec URL in Script Property OT_WEB_APP_URL.');
  const me = tg_('getMe', {});
  tg_('setWebhook', {
    url: OT.RELAY_URL + '?to=' + m[1], secret_token: prop_('OT_WEBHOOK_SECRET'),
    allowed_updates: ['message', 'callback_query'], drop_pending_updates: true,
  });
  tg_('setMyCommands', { commands: [{ command: 'start', description: 'Register as an OT approver' }, { command: 'myid', description: 'Show my Telegram ID' }] });
  console.log('Connected @' + me.username + '. Managers open https://t.me/' + me.username + ' and press Start.');
  console.log(JSON.stringify(tg_('getWebhookInfo', {})));
}

/** Health check: duplicate IDs, missing names, missing approvers or Telegram, managers not yet registered. */
function checkData() {
  const employees = readEmployees_();
  const approvers = readApprovers_();
  const kh = khmerFromHistory_();
  const ids = Object.keys(employees);
  const dup = ids.filter(k => employees[k].length > 1);
  const one = ids.filter(k => employees[k].length === 1).map(k => employees[k][0]);
  const noEn = one.filter(e => !e.en).map(e => e.id);
  const noKh = one.filter(e => !e.kh && !kh[e.id]).map(e => e.id);
  const noMgr = one.filter(e => !e.manager).map(e => e.id);
  const noTg = one.filter(e => e.manager && !normUser_(e.telegram)).map(e => e.id);
  const users = Array.from(new Set(one.map(e => normUser_(e.telegram)).filter(Boolean)));
  const unreg = users.filter(u => !approvers.some(a => a.username === u && a.active && a.chatId));
  const lines = [
    'Employees: ' + ids.length,
    'Duplicate IDs: ' + (dup.join(', ') || 'none'),
    'Missing English name: ' + (noEn.join(', ') || 'none'),
    'Missing Khmer name (none in old OT rows either): ' + noKh.length,
    'Missing line manager: ' + (noMgr.join(', ') || 'none'),
    'Missing manager Telegram: ' + (noTg.join(', ') || 'none'),
    'Approver Telegram accounts: ' + users.map(u => '@' + u).join(', '),
    'Not yet registered on the bot: ' + (unreg.map(u => '@' + u).join(', ') || 'none'),
  ];
  return lines.join('\n');
}
