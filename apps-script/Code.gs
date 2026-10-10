/**
 * Fuel Refill App – Google Sheets backend (Apps Script web app).
 * The Netlify front end POSTs {action, token, payload} here as text/plain JSON.
 * Data lives in the sheets of the spreadsheet this script is bound to.
 */

const SHEETS = {
  REFILL: 'Fuel Refill',
  TYPES: 'Type of Refill',
  DRIVER_TRUCK: 'Driver & Truck',
  EQUIPMENT: 'Equipment',
  USERS: 'Users',
  SETTINGS: 'Settings',
};

// Column headers in the "Fuel Refill" sheet. Columns are found by header text, so order can change.
const COL = {
  ID_FR: 'ID_FR',
  TYPE: 'ចាក់សាំងសម្រាប់៖',
  PLATE: 'ផ្លាកលេខឡាន',
  DRIVER: 'ឈ្មោះតៃកុង',
  ODO_PHOTO: 'រូបថតកុងទ័រឡាន',
  KM: 'លេខកុងទ័រ (Km)',
  PUMP_PHOTO: 'រូបថតកុងទ័រសាំង',
  LITRES: 'ចំនួនចាក់ (លីត្រ)',
  SIGNATURE: 'ហត្ថលេខា',
  NOTE: 'សំគាល់',
  ID: 'ID',
  DATE: 'Date of Record',
  DATETIME: 'Date & Time of Record',
  LATLONG: 'LatLong',
  USER: 'User',
  STATUS: 'Review Status',
  REVIEWED_BY: 'Reviewed By',
  REVIEWED_AT: 'Reviewed At',
  HOUR: 'Hour Meter',
  HOUR_PHOTO: 'Hour Meter Photo',
  UPDATED_AT: 'Updated At',
};

// Columns in the "Driver & Truck" sheet used for the dropdowns.
const DT_DRIVER = 'ឈ្មោះតៃកុង';
const DT_PLATE = 'CODE';
const MIN_KM = 1000;
// "Odometer Broken?" column in Driver & Truck: Yes = this truck's odometer is broken.
const DT_BROKEN = /odometer\s*broken/i;

const STATUS_OK = 'ត្រឹមត្រូវ';
const STATUS_BAD = 'មិនត្រឹមត្រូវ';
const PHOTO_FOLDER_NAME = 'Fuel Refill_Images (Web App)';

// ---------- HTTP entry points ----------

function doGet() {
  return json_({ ok: true, app: 'Fuel Refill API' });
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const action = ACTIONS[req.action];
    // Signed in with Google but not (yet) in the Users sheet: these two only need the sign-in.
    if (req.action === 'requestAccess') return json_({ ok: true, data: requestAccess_(req.token, req.payload || {}) });
    if (req.action === 'requestForm') return json_({ ok: true, data: requestForm_(req.token) });
    if (!action) throw new Error('Unknown action: ' + req.action);
    if (req.action === 'home') ensureAppColumns_();
    const user = authenticate_(req.token);
    // Each app checks its own tick box in the Users sheet (admins can open everything).
    const app = ACTION_APP[req.action];
    if (app && !canUse_(user, app)) throw new Error('NOACCESS: ' + user.email + ' has no access to ' + appTitle_(app) + '. Ask the admin to tick it in the Users sheet.');
    const out = { ok: true, data: action(req.payload || {}, user) };
    if (user.session) out.session = user.session;   // the apps save it in place of the Google sign-in
    return json_(out);
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

const ACTIONS = {
  config: getConfig_,
  submit: submitRefill_,
  update: updateRefill_,
  mine: listMine_,
  all: listAll_,
  review: reviewRefill_,
  photo: getPhoto_,
  dashboard: dashboardData_,
  dashboardSave: dashboardSave_,
  home: homeApps_,
};

// ---------- Home menu: which apps each user can open ----------
// One tick box column per app in the Users sheet. Keys match the tiles in web/home.js.
const HOME_APPS = [
  { key: 'fuel', col: 'ចាក់សាំង' },
  { key: 'transport', col: 'ដឹកជញ្ជូន' },
  { key: 'overtime', col: 'ថែមម៉ោង' },
  { key: 'location', col: 'ទីតាំងថ្មី' },
  { key: 'dashboard', col: 'Dashboard' },
];
// Ticked for every user by default (Kim, 10 Oct 2026). Dashboard stays for reviewers and admins.
const DEFAULT_APPS = ['fuel', 'transport', 'overtime', 'location'];
const ACTION_APP = {
  config: 'fuel', submit: 'fuel', update: 'fuel', mine: 'fuel', all: 'fuel', review: 'fuel',
  dashboard: 'dashboard', dashboardSave: 'dashboard',
};

function appTitle_(key) {
  const a = HOME_APPS.find(x => x.key === key);
  return a ? a.col : key;
}

/** True when the user may open the app. A missing column means the menu isn't set up yet: everyone keeps today's access. */
function canUse_(user, key) {
  if (user.role === 'admin') return true;
  if (user.apps[key] === undefined) return key === 'dashboard' ? isReviewer_(user) : true;
  return user.apps[key];
}

function homeApps_(p, user) {
  ensureRecapTrigger_();
  ensureTelegramSettings_();
  const out = {
    user: { name: user.name, role: user.role },
    apps: HOME_APPS.map(a => a.key).filter(k => canUse_(user, k)),
  };
  // Reviewers see how many entries wait for them on the Fuel Refill tile.
  if (isReviewer_(user) && canUse_(user, 'fuel')) {
    const n = pendingCount_();
    if (n) out.badges = { fuel: n };
  }
  return out;
}

/**
 * Adds the app tick box columns to the Users sheet the first time the home menu is opened.
 * Starting values: the DEFAULT_APPS ticked for everyone, Dashboard for reviewers and admins.
 * Also ticks the DEFAULT_APPS once for the users already in the sheet (Script Property APPS_DEFAULT_DONE).
 */
function ensureAppColumns_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.USERS);
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const missing = HOME_APPS.filter(a => header.indexOf(a.col) < 0);
  const props = PropertiesService.getScriptProperties();
  if (!missing.length && props.getProperty('APPS_DEFAULT_DONE')) return;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const now = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
    const roleCol = now.indexOf('Role');
    const rows = Math.max(sheet.getLastRow() - 1, 0);
    const roles = !rows ? [] : roleCol >= 0 ? sheet.getRange(2, roleCol + 1, rows, 1).getValues().map(r => String(r[0]).trim().toLowerCase()) : new Array(rows).fill('');
    missing.filter(a => now.indexOf(a.col) < 0).forEach(a => {
      const c = sheet.getLastColumn() + 1;
      sheet.getRange(1, c).setValue(a.col).setFontWeight('bold');
      // Only the rows that exist: blank tick boxes below would count as data and push new rows down the sheet.
      if (rows) sheet.getRange(2, c, rows, 1).insertCheckboxes().setValues(roles.map(r =>
        [DEFAULT_APPS.indexOf(a.key) >= 0 || (a.key === 'dashboard' && (r === 'reviewer' || r === 'admin'))]));
    });
    if (!props.getProperty('APPS_DEFAULT_DONE')) {
      const cols = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
      if (rows) HOME_APPS.filter(a => DEFAULT_APPS.indexOf(a.key) >= 0).forEach(a => {
        const c = cols.indexOf(a.col) + 1;
        if (c > 0) sheet.getRange(2, c, rows, 1).insertCheckboxes().setValues(roles.map(() => [true]));
      });
      props.setProperty('APPS_DEFAULT_DONE', new Date().toISOString());
    }
  } finally {
    lock.releaseLock();
  }
  delete tableCache_[SHEETS.USERS];
}

// ---------- Auth ----------

/**
 * Checks the sign-in (Google ID token or this app's own session) and returns the matching active user
 * from the Users sheet. A Google sign-in only lasts 1 hour, so it is swapped for a 30-day session that
 * renews itself while the person keeps using the apps. Setting Active to No still blocks them at once.
 */
function authenticate_(token) {
  if (!token) throw new Error('AUTH: Please sign in.');
  let email, session = null;
  const own = readSession_(token);
  if (own) {
    email = own.email;
    if (own.exp - Math.floor(Date.now() / 1000) < SESSION_RENEW_DAYS * 86400) session = makeSession_(email);
  } else {
    const cache = CacheService.getScriptCache();
    const key = 'tok_' + Utilities.base64EncodeWebSafe(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
    email = cache.get(key);
    if (!email) {
      const info = verifyToken_(token);
      email = info.email;
      const secondsLeft = Number(info.exp) - Math.floor(Date.now() / 1000);
      if (secondsLeft > 60) cache.put(key, email, Math.min(secondsLeft - 30, 3000));
    }
    session = makeSession_(email);
  }
  const user = readTable_(SHEETS.USERS).find(u =>
    String(u['Email']).trim().toLowerCase() === email && isYes_(u['Active']));
  if (!user) throw new Error('NOACCESS: ' + email + ' is not allowed to use this app. Ask the admin to add you to the Users sheet.');
  const apps = {};
  HOME_APPS.forEach(a => { if (a.col in user) apps[a.key] = isYes_(user[a.col]); });
  return { email: email, name: user['Name'] || '', role: String(user['Role'] || 'user').toLowerCase(), apps: apps, session: session };
}

// ---------- Sessions: stay signed in ----------
// Shaped like a Google token (header.body.signature) so the apps read the email and expiry the same way.
// Signed with SESSION_SECRET, which the script creates once in Script Properties; deleting it signs everyone out.
const SESSION_DAYS = 30;
const SESSION_RENEW_DAYS = 15;   // used within the last 15 days: a fresh 30 days is sent back

function sessionSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('SESSION_SECRET');
  if (secret) return secret;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    secret = props.getProperty('SESSION_SECRET');
    if (!secret) {
      secret = Utilities.getUuid() + Utilities.getUuid();
      props.setProperty('SESSION_SECRET', secret);
    }
  } finally {
    lock.releaseLock();
  }
  return secret;
}

const b64url_ = data => Utilities.base64EncodeWebSafe(data).replace(/=+$/, '');
const b64urlText_ = s => Utilities.newBlob(Utilities.base64DecodeWebSafe(s + '==='.slice((s.length + 3) % 4))).getDataAsString();
const SESSION_HEAD = b64url_(JSON.stringify({ alg: 'HS256', typ: 'STEEL' }));

function sessionSig_(text) {
  return b64url_(Utilities.computeHmacSha256Signature(text, sessionSecret_()));
}

function makeSession_(email) {
  const now = Math.floor(Date.now() / 1000);
  const body = b64url_(Utilities.newBlob(JSON.stringify({ email: email, iat: now, exp: now + SESSION_DAYS * 86400 })).getBytes());
  return SESSION_HEAD + '.' + body + '.' + sessionSig_(SESSION_HEAD + '.' + body);
}

/** This app's own session: returns {email, exp}, null for a Google token, or throws AUTH when expired or tampered with. */
function readSession_(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3 || parts[0] !== SESSION_HEAD) return null;
  if (sessionSig_(parts[0] + '.' + parts[1]) !== parts[2]) throw new Error('AUTH: Sign-in expired. Please sign in again.');
  const body = JSON.parse(b64urlText_(parts[1]));
  if (!(body.exp * 1000 > Date.now())) throw new Error('AUTH: Sign-in expired. Please sign in again.');
  return { email: String(body.email).toLowerCase(), exp: body.exp };
}

/** Checks a Google Sign-In ID token with Google; returns its details with a lower-case email. */
function verifyToken_(token) {
  if (!token) throw new Error('AUTH: Please sign in.');
  const res = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token),
    { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('AUTH: Sign-in expired. Please sign in again.');
  const info = JSON.parse(res.getContentText());
  const clientId = getSetting_('GOOGLE_CLIENT_ID');
  if (!clientId || info.aud !== clientId) throw new Error('AUTH: Sign-in is not set up for this app.');
  if (String(info.email_verified) !== 'true') throw new Error('AUTH: Google email is not verified.');
  info.email = String(info.email).toLowerCase();
  return info;
}

// ---------- Request to Admin ----------
// A person signed in with Google but not allowed yet fills in a short form (full name, employee ID,
// department from the "Departments" sheet). The answers go into the Users sheet with Active = No, the
// usual apps already ticked, and a note goes to the Telegram group. The admin switches Active to Yes.

const DEPT_SHEET = 'Departments';
const REQ_COLS = ['Employee ID', 'Department'];

/** Who is signed in (Google token or this app's session), without needing a Users row. */
function identity_(token) {
  const own = readSession_(token);
  return own ? { email: own.email, name: '' } : verifyToken_(token);
}

/** Department names for the drop-down: column "Department" of the Departments sheet (Active = No hides one). */
function departments_() {
  const ss = SpreadsheetApp.getActive();
  if (!ss.getSheetByName(DEPT_SHEET)) {
    const sheet = ss.insertSheet(DEPT_SHEET);
    sheet.getRange(1, 1, 1, 2).setValues([['Department', 'Active']]).setFontWeight('bold');
    return [];
  }
  const seen = {};
  return readTable_(DEPT_SHEET)
    .filter(r => !isNo_(r['Active']))
    .map(r => String(r['Department'] || '').trim())
    .filter(d => d && !seen[d] && (seen[d] = true));
}

/** What the request form needs: the departments and anything this person already sent. */
function requestForm_(token) {
  const info = identity_(token);
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.USERS);
  const values = sheet.getDataRange().getValues();
  const header = values[0].map(h => String(h).trim());
  const col = h => header.indexOf(h);
  const row = values.slice(1).find(r => String(r[col('Email')]).trim().toLowerCase() === info.email);
  const get = (r, h) => (r && col(h) >= 0 ? String(r[col(h)] || '').trim() : '');
  return {
    email: info.email,
    status: row && isYes_(row[col('Active')]) ? 'active' : row ? 'requested' : 'new',
    fullName: get(row, 'Name') || String(info.name || '').trim(),
    employeeId: get(row, 'Employee ID'),
    department: get(row, 'Department'),
    departments: departments_(),
  };
}

function requestAccess_(token, p) {
  const info = identity_(token);
  const email = info.email;
  // The form sends fullName, employeeId and department; older app versions send nothing.
  const form = p && p.fullName !== undefined;
  const name = String((form ? p.fullName : info.name) || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const empId = form ? String(p.employeeId || '').trim().slice(0, 40) : '';
  const dept = form ? String(p.department || '').trim().slice(0, 100) : '';
  if (form) {
    if (!name) throw new Error('Full name is required. / សូមបញ្ចូលឈ្មោះពេញ។');
    if (!empId) throw new Error('Employee ID is required. / សូមបញ្ចូលលេខសម្គាល់បុគ្គលិក។');
    if (!dept) throw new Error('Department is required. / សូមជ្រើសរើសផ្នែក។');
    const list = departments_();
    if (list.length && list.indexOf(dept) < 0) throw new Error('Choose a department from the list. / សូមជ្រើសរើសផ្នែកពីបញ្ជី។');
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let added = false, changed = false;
  try {
    const sheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.USERS);
    let header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
    if (form) REQ_COLS.filter(h => header.indexOf(h) < 0).forEach(h => {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(h).setFontWeight('bold');
      header.push(h);
    });
    const col = h => header.indexOf(h);
    const values = sheet.getDataRange().getValues();
    const i = values.findIndex((r, k) => k > 0 && String(r[col('Email')]).trim().toLowerCase() === email);
    if (i > 0 && isYes_(values[i][col('Active')])) return { status: 'active' };
    let r;
    if (i < 0) {
      sheet.appendRow(header.map(h => ({ Email: email, Name: name, Role: 'user', Active: 'No' })[h] || ''));
      r = sheet.getLastRow();
      // App tick boxes on the new row: the default apps ticked, so the admin only switches Active to Yes.
      HOME_APPS.forEach(a => { const c = col(a.col); if (c >= 0) sheet.getRange(r, c + 1).insertCheckboxes().setValue(DEFAULT_APPS.indexOf(a.key) >= 0); });
      added = true;
    } else {
      r = i + 1;
      if (form && name) sheet.getRange(r, col('Name') + 1).setValue(name);
    }
    if (form) {
      const old = i > 0 ? [String(values[i][col('Employee ID')] || ''), String(values[i][col('Department')] || '')] : ['', ''];
      changed = added || old[0] !== empId || old[1] !== dept;
      // Kept as text so IDs like 00123 keep their zeros.
      sheet.getRange(r, col('Employee ID') + 1).setNumberFormat('@').setValue(empId);
      sheet.getRange(r, col('Department') + 1).setValue(dept);
    }
  } finally {
    lock.releaseLock();
    delete tableCache_[SHEETS.USERS];
  }
  // One Telegram note per account every 6 hours (or when the details change), so repeated taps don't flood the group.
  const cache = CacheService.getScriptCache();
  if (telegramReady_() && (added || changed || !cache.get('req_' + email))) {
    cache.put('req_' + email, '1', 21600);
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    try {
      telegram_('sendMessage', { chat_id: getSetting_('TELEGRAM_CHAT_ID'), parse_mode: 'HTML', text: [
        '🔑 <b>ស្នើសុំប្រើកម្មវិធី / Access request</b>',
        '👤 ' + esc(name || '-'),
        empId ? '🪪 ' + esc(empId) : null,
        dept ? '🏢 ' + esc(dept) : null,
        '📧 ' + esc(email),
        '',
        'Users sheet: Active = Yes ដើម្បីអនុញ្ញាត (កម្មវិធីធម្មតាបានធីករួច) / set Active = Yes to allow (the usual apps are already ticked).',
      ].filter(x => x !== null).join('\n') });
    } catch (e) { /* the request is saved in the sheet even if Telegram fails */ }
  }
  return { status: 'requested' };
}

function isReviewer_(user) {
  return user.role === 'reviewer' || user.role === 'admin';
}

// ---------- Actions ----------

function getConfig_(payload, user) {
  const lists = driverTruck_();
  return {
    user: user,
    types: readTypes_(),
    plates: lists.plates,
    drivers: lists.drivers,
    brokenPlates: lists.brokenPlates,
    equipment: equipmentByType_(),
    litreLimit: Number(getSetting_('LITRE_LIMIT')) || 250,
    lastReadings: lastReadings_(),
    pendingCount: isReviewer_(user) ? pendingCount_() : undefined,
  };
}

function submitRefill_(p, user) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let tgPost = null;
  try {
    // The phone sends each entry with a ref and may send it again if the answer got lost: save it once.
    const ref = String(p.ref || '').slice(0, 64);
    const refs = ref ? JSON.parse(PropertiesService.getScriptProperties().getProperty('SUBMIT_REFS') || '{}') : {};
    if (ref && refs[ref]) return { id: refs[ref], duplicate: true };

    const sheet = refillSheet_();
    const cols = headerIndex_(sheet);
    addNewNames_(p);
    const clean = validate_(p, null);
    // The time Submit was pressed on the phone (it may be sent a little later); server time if it looks wrong.
    const taken = Number(p.takenAt);
    const now = taken && taken <= Date.now() + 5 * 60 * 1000 && taken >= Date.now() - 3 * 24 * 3600 * 1000
      ? new Date(taken) : new Date();
    const id = newId_(sheet, cols, now);
    const values = new Array(sheet.getLastColumn()).fill('');
    const set = (name, v) => { if (cols[name] !== undefined) values[cols[name]] = v; };

    set(COL.ID_FR, id);
    set(COL.ID, id);
    set(COL.TYPE, clean.type);
    set(COL.PLATE, clean.plate);
    set(COL.DRIVER, clean.driver);
    set(COL.KM, clean.km === null ? '' : clean.km);
    set(COL.HOUR, clean.hour === null ? '' : clean.hour);
    set(COL.LITRES, clean.litres);
    set(COL.NOTE, clean.note);
    set(COL.DATE, new Date(now.getFullYear(), now.getMonth(), now.getDate()));
    set(COL.DATETIME, now);
    set(COL.LATLONG, clean.latLong);
    set(COL.USER, user.email);
    set(COL.ODO_PHOTO, savePhoto_(p.odoPhoto, id, 'odometer'));
    set(COL.HOUR_PHOTO, savePhoto_(p.hourPhoto, id, 'hourmeter'));
    set(COL.PUMP_PHOTO, savePhoto_(p.pumpPhoto, id, 'pump'));
    set(COL.SIGNATURE, savePhoto_(p.signature, id, 'signature'));

    sheet.appendRow(values);
    pendingChanged_();
    if (ref) {
      refs[ref] = id;
      const keys = Object.keys(refs);
      keys.slice(0, Math.max(0, keys.length - 300)).forEach(k => delete refs[k]);   // keep the last 300
      PropertiesService.getScriptProperties().setProperty('SUBMIT_REFS', JSON.stringify(refs));
    }
    if (telegramReady_() || alertsReady_()) {
      tgPost = { id: id, type: clean.type, plate: clean.plate, driver: clean.driver, km: clean.km, hour: clean.hour,
        litres: clean.litres, dateTime: now.getTime(), note: clean.note,
        odoPhoto: p.odoPhoto, hourPhoto: p.hourPhoto, pumpPhoto: p.pumpPhoto };
    }
    return { id: id, plate: clean.plate, driver: clean.driver };
  } finally {
    lock.releaseLock();
    // Posted straight away (a few seconds), using the photos already in hand. Google's timed triggers can
    // take minutes to run, so the queue + trigger is only the fallback when Telegram fails.
    if (tgPost) {
      try { alertUnusual_(tgPost, allRefills_(), telegramReady_() ? postRefillToTelegram_(tgPost) : null); }
      catch (e) { console.error('Telegram post failed for ' + tgPost.id + ': ' + e); queueTelegram_(tgPost.id); }
    }
  }
}

function updateRefill_(p, user) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = refillSheet_();
    const cols = headerIndex_(sheet);
    const rowNum = findRow_(sheet, cols, p.id);
    const row = sheet.getRange(rowNum, 1, 1, sheet.getLastColumn()).getValues()[0];
    // Reviewers and admins can correct any entry; others only their own entries before review.
    if (!isReviewer_(user)) {
      if (String(row[cols[COL.USER]]).toLowerCase() !== user.email) throw new Error('You can only edit your own entries.');
      if (row[cols[COL.STATUS]]) throw new Error('This entry has already been reviewed and can no longer be edited.');
    }
    const entryTime = row[cols[COL.DATETIME]] instanceof Date ? row[cols[COL.DATETIME]].getTime() : null;
    addNewNames_(p);
    const clean = validate_(p, p.id, entryTime);
    const put = (name, v) => { if (cols[name] !== undefined) row[cols[name]] = v; };
    put(COL.TYPE, clean.type);
    put(COL.PLATE, clean.plate);
    put(COL.DRIVER, clean.driver);
    put(COL.KM, clean.km === null ? '' : clean.km);
    put(COL.HOUR, clean.hour === null ? '' : clean.hour);
    put(COL.LITRES, clean.litres);
    put(COL.NOTE, clean.note);
    put(COL.UPDATED_AT, new Date());
    // New photos replace old ones; missing photos keep what is already saved.
    if (p.odoPhoto) put(COL.ODO_PHOTO, savePhoto_(p.odoPhoto, p.id, 'odometer'));
    if (p.hourPhoto) put(COL.HOUR_PHOTO, savePhoto_(p.hourPhoto, p.id, 'hourmeter'));
    if (p.pumpPhoto) put(COL.PUMP_PHOTO, savePhoto_(p.pumpPhoto, p.id, 'pump'));
    if (p.signature) put(COL.SIGNATURE, savePhoto_(p.signature, p.id, 'signature'));
    if (clean.meterRequired && clean.meter === 'km' && !clean.meterBroken && !row[cols[COL.ODO_PHOTO]]) throw new Error('Odometer photo is required.');
    if (clean.meterRequired && clean.meter === 'hour' && !row[cols[COL.HOUR_PHOTO]]) throw new Error('Hour meter photo is required.');

    sheet.getRange(rowNum, 1, 1, row.length).setValues([row]);
    return { id: p.id, plate: clean.plate, driver: clean.driver };
  } finally {
    lock.releaseLock();
  }
}

function listMine_(p, user) {
  const since = Date.now() - 45 * 24 * 3600 * 1000;
  return allRefills_()
    .filter(r => r.user === user.email && r.dateTime && r.dateTime >= since)
    .sort((a, b) => b.dateTime - a.dateTime)
    .slice(0, 60);
}

/** Every entry, newest first, for the reviewer tab (grouped by year / month / day on the phone). */
function listAll_(p, user) {
  if (!isReviewer_(user)) throw new Error('Only reviewers can see this list.');
  return allRefills_().sort((a, b) => (b.dateTime || 0) - (a.dateTime || 0));
}

function reviewRefill_(p, user) {
  if (!isReviewer_(user)) throw new Error('Only reviewers can review entries.');
  if (p.status !== STATUS_OK && p.status !== STATUS_BAD) throw new Error('Invalid review status.');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = refillSheet_();
    const cols = headerIndex_(sheet);
    const rowNum = findRow_(sheet, cols, p.id);
    sheet.getRange(rowNum, cols[COL.STATUS] + 1).setValue(p.status);
    sheet.getRange(rowNum, cols[COL.REVIEWED_BY] + 1).setValue(user.email);
    sheet.getRange(rowNum, cols[COL.REVIEWED_AT] + 1).setValue(new Date());
    pendingChanged_();
    if (p.note) {
      const cell = sheet.getRange(rowNum, cols[COL.NOTE] + 1);
      const old = String(cell.getValue() || '');
      cell.setValue((old ? old + ' | ' : '') + 'Review: ' + p.note);
    }
    return { id: p.id, status: p.status };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Returns a photo as a data URL. New photos are Drive links inside the app's photo folder.
 * Old AppSheet photos ("Fuel Refill_Images/name.jpg") are looked up by file name in the folder
 * set as OLD_PHOTO_FOLDER_ID in the Settings sheet. Nothing outside those two folders is served.
 */
function getPhoto_(p, user) {
  const url = String(p.url || '');
  let file = null;
  const fileId = fileIdFromUrl_(url);
  if (fileId) {
    const f = DriveApp.getFileById(fileId);
    if (inFolder_(f, photoFolder_().getId())) file = f;
  } else if (url) {
    const oldId = getSetting_('OLD_PHOTO_FOLDER_ID');
    if (oldId) {
      const name = url.split('/').pop();
      const it = DriveApp.getFolderById(oldId).getFilesByName(name);
      if (it.hasNext()) file = it.next();
    }
  }
  if (!file) return { dataUrl: null };
  const blob = file.getBlob();
  return { dataUrl: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
}

function inFolder_(file, folderId) {
  const parents = file.getParents();
  while (parents.hasNext()) if (parents.next().getId() === folderId) return true;
  return false;
}

// ---------- Fuel dashboard (read only) ----------
// The dashboard only reads "Fuel Refill". Its own settings (targets, vehicle types, fuel price)
// are kept as JSON in a separate "Dashboard Settings" sheet.

const DASH_SHEET = 'Dashboard Settings';
const DASH_FIELDS = [
  ['id', COL.ID_FR], ['type', COL.TYPE], ['plate', COL.PLATE], ['driver', COL.DRIVER],
  ['km', COL.KM], ['litres', COL.LITRES], ['dateTime', COL.DATETIME], ['status', COL.STATUS],
  ['user', COL.USER], ['hour', COL.HOUR], ['note', COL.NOTE],
  ['odoPhoto', COL.ODO_PHOTO], ['pumpPhoto', COL.PUMP_PHOTO], ['hourPhoto', COL.HOUR_PHOTO],
];

function dashboardData_(p, user) {
  if (!canUse_(user, 'dashboard')) throw new Error('NOACCESS: Only users with Dashboard ticked in the Users sheet can open the dashboard.');
  const raw = dashboardRaw_();
  raw.user = { name: user.name, role: user.role };
  return raw;
}

/** Everything the dashboard reads (also used for the Telegram monthly recap). */
function dashboardRaw_() {
  const sheet = refillSheet_();
  const values = sheet.getDataRange().getValues();
  const header = values.shift().map(h => String(h).trim());
  const idx = DASH_FIELDS.map(f => header.indexOf(f[1]));
  // "Entered by" goes out as the person's name from the Users sheet, never the email.
  const userCol = DASH_FIELDS.findIndex(f => f[0] === 'user');
  const names = {};
  readTable_(SHEETS.USERS).forEach((u, i) => {
    const email = String(u['Email'] || '').trim().toLowerCase();
    if (email) names[email] = String(u['Name'] || '').trim() || 'No name (Users row ' + (i + 2) + ')';
  });
  const nameOf = email => {
    const e = String(email || '').trim().toLowerCase();
    return !e ? '' : names[e] || 'Not in Users sheet';
  };
  const rows = [];
  values.forEach(r => {
    if (idx[0] < 0 || r[idx[0]] === '') return;
    rows.push(idx.map((i, k) => {
      if (i < 0) return '';
      const v = r[i];
      if (k === userCol) return nameOf(v);
      if (v instanceof Date) return v.getTime();
      // Drive photo links shortened to "d:<file id>" to keep the download small; the dashboard expands them.
      return typeof v === 'string' ? v.replace(/^https:\/\/drive\.google\.com\/file\/d\/([\w-]+)\/view.*$/, 'd:$1') : v;
    }));
  });
  return {
    columns: DASH_FIELDS.map(f => f[0]),
    rows: rows,
    types: readTable_(SHEETS.TYPES).map(t => ({
      name: String(t['Type of Refill'] || '').trim(),
      meter: String(t['Meter'] || '').trim().toLowerCase(),
    })).filter(t => t.name),
    drivers: readTable_(SHEETS.DRIVER_TRUCK).map(d => ({
      no: d['ID_DL'], name: String(d['ឈ្មោះ'] || '').trim(),
      label: String(d[DT_DRIVER] || '').trim(), plate: String(d[DT_PLATE] || '').trim(),
    })).filter(d => d.label || d.name),
    brokenPlates: driverTruck_().brokenPlates,
    settings: dashSettings_(),
    generatedAt: Date.now(),
  };
}

function dashboardSave_(p, user) {
  if (!canUse_(user, 'dashboard')) throw new Error('NOACCESS: Only users with Dashboard ticked in the Users sheet can change dashboard settings.');
  const text = JSON.stringify(p.settings || {});
  if (text.length > 45000) throw new Error('Settings are too large.');
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(DASH_SHEET) || ss.insertSheet(DASH_SHEET);
  sheet.getRange(1, 1, 3, 2).setValues([
    ['Key', 'Value'],
    ['settings', text],
    ['updated', user.email + ' ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')],
  ]);
  const odo = p.odometer && typeof p.odometer === 'object' ? p.odometer : {};
  return { saved: true, odometer: setOdometer_(odo) };
}

/**
 * Dashboard Settings › Plates › Good / Odometer Broken: writes Yes (broken) or No (good) in the
 * "Odometer Broken?" column of Driver & Truck for every row with that plate. Only that column changes.
 */
function setOdometer_(odo) {
  const plates = Object.keys(odo).map(k => String(k).trim().toUpperCase()).filter(Boolean);
  if (!plates.length) return { updated: 0, missing: [] };
  const want = {};
  Object.keys(odo).forEach(k => { want[String(k).trim().toUpperCase()] = odo[k] === 'broken' ? 'Yes' : 'No'; });
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.DRIVER_TRUCK);
    const lastCol = sheet.getLastColumn();
    const header = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
    const codeCol = header.indexOf(DT_PLATE);
    if (codeCol < 0) throw new Error('CODE column not found in Driver & Truck.');
    let col = header.findIndex(h => DT_BROKEN.test(h));
    if (col < 0) { col = lastCol; sheet.getRange(1, col + 1).setValue('Odometer Broken?'); }
    const n = sheet.getLastRow() - 1;
    if (n < 1) return { updated: 0, missing: plates };
    const codes = sheet.getRange(2, codeCol + 1, n, 1).getValues();
    const cells = sheet.getRange(2, col + 1, n, 1);
    const vals = cells.getValues();
    const found = {};
    let updated = 0;
    codes.forEach((c, i) => {
      const code = String(c[0] || '').trim().toUpperCase();
      if (!want[code]) return;
      found[code] = true;
      if (String(vals[i][0]).trim() !== want[code]) { vals[i][0] = want[code]; updated++; }
    });
    if (updated) cells.setValues(vals);
    delete tableCache_[SHEETS.DRIVER_TRUCK];
    return { updated: updated, missing: plates.filter(x => !found[x]) };
  } finally {
    lock.releaseLock();
  }
}

function dashSettings_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(DASH_SHEET);
  if (!sheet) return null;
  try { return JSON.parse(String(sheet.getRange(2, 2).getValue() || 'null')); } catch (e) { return null; }
}

// ---------- Telegram notifications ----------
// Each new entry is posted to a Telegram group with a short summary and its photos.
// The bot token is kept in Script Properties (TELEGRAM_BOT_TOKEN), not in the sheet, so sheet users can't see it.
// The group's chat ID is saved in the Settings sheet (TELEGRAM_CHAT_ID) by telegramConnect(); clear it to stop posting.
// Posting happens a few seconds after saving, from a one-off trigger, so the app doesn't wait for Telegram.

const TG_HANDLER = 'sendTelegramQueue';
const TG_QUEUE = 'TG_QUEUE';
const TG_DUE = 'TG_DUE';

/**
 * Adds a new entry to the Telegram queue (called while submitRefill_ holds the lock).
 * Returns 'now' when no trigger could be scheduled, so the caller posts straight away instead.
 */
function queueTelegram_(id) {
  try {
    if (!telegramReady_()) return '';
    const props = PropertiesService.getScriptProperties();
    const queue = JSON.parse(props.getProperty(TG_QUEUE) || '[]');
    queue.push({ id: id, tries: 0 });
    props.setProperty(TG_QUEUE, JSON.stringify(queue));
    return scheduleTelegram_(5) ? 'queued' : 'now';
  } catch (e) {
    console.error(e);
    return '';
  }
}

/** Makes sure a one-off trigger will run sendTelegramQueue soon. Returns false if triggers aren't allowed. */
function scheduleTelegram_(seconds) {
  const props = PropertiesService.getScriptProperties();
  const due = Number(props.getProperty(TG_DUE)) || 0;
  if (due && Date.now() - due < 10 * 60 * 1000) return true;   // one is already on its way
  try {
    deleteTelegramTriggers_();
    ScriptApp.newTrigger(TG_HANDLER).timeBased().after(seconds * 1000).create();
    props.setProperty(TG_DUE, String(Date.now()));
    return true;
  } catch (e) {
    console.error('Telegram trigger not created: ' + e);
    return false;
  }
}

function deleteTelegramTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === TG_HANDLER)
    .forEach(t => ScriptApp.deleteTrigger(t));
}

/** Posts every queued entry to the group. Run by the trigger; you can also run it from the editor. */
function sendTelegramQueue() {
  const props = PropertiesService.getScriptProperties();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let queue;
  try {
    try { deleteTelegramTriggers_(); } catch (e) { /* no trigger permission: posting inline */ }
    queue = JSON.parse(props.getProperty(TG_QUEUE) || '[]');
    props.deleteProperty(TG_QUEUE);
    props.deleteProperty(TG_DUE);
  } finally {
    lock.releaseLock();
  }
  if (!queue.length || !telegramReady_()) return;

  const rows = allRefills_();
  const retry = [];
  queue.forEach(item => {
    const r = rows.find(x => x.id === item.id);
    if (!r) return;
    try {
      alertUnusual_(r, rows, postRefillToTelegram_(r));
    } catch (e) {
      console.error('Telegram post failed for ' + item.id + ': ' + e);
      if (item.tries < 3) retry.push({ id: item.id, tries: item.tries + 1 });
    }
  });
  if (retry.length) {
    lock.waitLock(30000);
    try {
      const later = JSON.parse(props.getProperty(TG_QUEUE) || '[]');
      props.setProperty(TG_QUEUE, JSON.stringify(retry.concat(later)));
      scheduleTelegram_(60);
    } finally {
      lock.releaseLock();
    }
  }
}

/** Sends one entry: an album when it has 2+ photos, one photo with caption, or a text message. */
function postRefillToTelegram_(r) {
  const chatId = getSetting_('TELEGRAM_CHAT_ID');
  const caption = telegramCaption_(r);
  const photos = [r.odoPhoto, r.hourPhoto, r.pumpPhoto].map(telegramPhoto_).filter(Boolean);
  if (!photos.length) {
    return telegram_('sendMessage', { chat_id: chatId, text: caption, parse_mode: 'HTML' });
  }
  if (photos.length === 1) {
    return telegram_('sendPhoto', { chat_id: chatId, photo: photos[0], caption: caption, parse_mode: 'HTML' });
  }
  const payload = { chat_id: chatId };
  payload.media = JSON.stringify(photos.map((blob, i) => {
    payload['p' + i] = blob;
    const m = { type: 'photo', media: 'attach://p' + i };
    if (i === 0) { m.caption = caption; m.parse_mode = 'HTML'; }
    return m;
  }));
  return telegram_('sendMediaGroup', payload);
}

function telegramPhoto_(url) {
  // A photo just sent from the phone (data URL) is used as is; saved entries load it from Drive.
  const m = /^data:(image\/(jpeg|png));base64,(.+)$/.exec(String(url || ''));
  if (m) return Utilities.newBlob(Utilities.base64Decode(m[3]), m[1], 'photo.' + (m[2] === 'png' ? 'png' : 'jpg'));
  const id = fileIdFromUrl_(url);
  if (!id) return null;
  try {
    const blob = DriveApp.getFileById(id).getBlob();
    return blob.setName(blob.getName() || 'photo.jpg');
  } catch (e) {
    return null;
  }
}

function telegramCaption_(r) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const num = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const type = readTypes_().find(t => t.name === r.type) || { meter: 'none' };
  const when = r.dateTime
    ? Utilities.formatDate(new Date(r.dateTime), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm') : '';
  const lines = [
    '⛽ <b>ចាក់សាំងថ្មី / New fuel refill</b>',
    '<b>' + esc(r.type) + '</b>',
    '',
    (type.meter === 'km' ? '🚚 ផ្លាកលេខ / Plate: ' : '🔧 ឧបករណ៍ / Equipment: ') + '<b>' + esc(r.plate) + '</b>',
    '👤 តៃកុង / Driver: ' + esc(r.driver),
  ];
  if (r.km) lines.push('📏 កុងទ័រ / Km: <b>' + num(r.km) + '</b>');
  if (r.hour) lines.push('⏱ ម៉ោង / Hours: <b>' + num(r.hour) + '</b>');
  lines.push('🛢 ចំនួនចាក់ / Litres: <b>' + num(r.litres) + ' L</b>');
  if (when) lines.push('🕒 ' + when);
  if (r.note) lines.push('📝 សំគាល់ / Note: ' + esc(r.note.length > 300 ? r.note.slice(0, 300) + '…' : r.note));
  lines.push('🆔 <code>' + esc(r.id) + '</code>');
  return lines.join('\n');
}

function telegramReady_() {
  return !!(telegramToken_() && getSetting_('TELEGRAM_CHAT_ID'));
}

function telegramToken_() {
  return String(PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN') || '').trim();
}

/** Calls the Telegram Bot API. Follows the group if Telegram upgraded it to a supergroup (new chat ID). */
function telegram_(method, payload) {
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + telegramToken_() + '/' + method,
    { method: 'post', payload: payload, muteHttpExceptions: true });
  let body = {};
  try { body = JSON.parse(res.getContentText()); } catch (e) { /* not JSON */ }
  if (body.ok) return body.result;
  const moved = body.parameters && body.parameters.migrate_to_chat_id;
  if (moved && payload.chat_id) {
    ['TELEGRAM_CHAT_ID', 'TELEGRAM_ALERT_CHAT_ID'].forEach(k => { if (getSetting_(k) === String(payload.chat_id)) setSetting_(k, String(moved)); });
    payload.chat_id = String(moved);
    return telegram_(method, payload);
  }
  throw new Error('Telegram ' + method + ': ' + (body.description || 'HTTP ' + res.getResponseCode()));
}

// ---------- Waiting for review ----------
// Count of entries with no Review Status, for the reviewer badges. Kept for a minute so the
// home menu stays fast; a new entry or a review clears it straight away.
const PENDING_CACHE = 'PENDING_COUNT';

function pendingCount_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(PENDING_CACHE);
  if (hit !== null) return Number(hit) || 0;
  const sheet = refillSheet_();
  const cols = headerIndex_(sheet);
  const n = sheet.getLastRow() - 1;
  if (n < 1 || cols[COL.STATUS] === undefined) return 0;
  const ids = sheet.getRange(2, cols[COL.ID_FR] + 1, n, 1).getValues();
  const status = sheet.getRange(2, cols[COL.STATUS] + 1, n, 1).getValues();
  let count = 0;
  ids.forEach((r, i) => { if (r[0] !== '' && String(status[i][0]).trim() === '') count++; });
  cache.put(PENDING_CACHE, String(count), 60);
  return count;
}

function pendingChanged_() {
  try { CacheService.getScriptCache().remove(PENDING_CACHE); } catch (e) { /* the count catches up within a minute */ }
}

// ---------- Unusual refill alerts (Telegram) ----------
// Sent to the alerts group (TELEGRAM_ALERT_CHAT_ID, connect it with telegramConnectAlerts) when a refill looks out of the ordinary:
//  · litres well above that truck's usual refill (1.5 × the median of its last 10, and at least 20 L more),
//  · a second refill for the same plate on the same day,
//  · km since the last refill above the dashboard's "Maximum km between refills" (Settings, default 2,000).
// Worded "Requires Investigation": it never says anyone did something wrong.
// Turn off by setting TELEGRAM_ALERTS = No in the Settings sheet.
const ALERT_LITRES_X = 1.5;

function median_(list) {
  const a = list.slice().sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** What is unusual about entry r, compared with the earlier entries of the same plate. */
function unusualRefill_(r, rows) {
  const out = { usual: null, sameDay: 0, kmGap: null };
  if (!r.plate || !r.dateTime) return out;
  const tz = Session.getScriptTimeZone();
  const day = t => Utilities.formatDate(new Date(t), tz, 'yyyy-MM-dd');
  const before = rows
    .filter(x => x.id !== r.id && x.plate === r.plate && x.type === r.type && x.status !== STATUS_BAD && x.dateTime && x.dateTime < r.dateTime)
    .sort((a, b) => b.dateTime - a.dateTime);

  const recent = before.filter(x => x.litres > 0).slice(0, 10).map(x => x.litres);
  if (recent.length >= 3) {
    const usual = median_(recent);
    if (r.litres > usual * ALERT_LITRES_X && r.litres - usual >= 20) out.usual = usual;
  }
  out.sameDay = before.filter(x => day(x.dateTime) === day(r.dateTime)).length;

  const broken = driverTruck_().brokenPlates.indexOf(r.plate) >= 0;
  const last = before.find(x => x.km > 1);
  if (r.km > 1 && last && !broken) {
    const maxJump = Number((dashSettings_() || {}).maxJumpKm) || 2000;
    if (r.km - last.km > maxJump) out.kmGap = r.km - last.km;
  }
  return out;
}

/** Posts the alert when something is unusual. replyTo: what Telegram returned for the entry's own post. */
function alertUnusual_(r, rows, replyTo) {
  try {
    if (!alertsReady_() || isNo_(getSetting_('TELEGRAM_ALERTS'))) return;
    const u = unusualRefill_(r, rows);
    if (u.usual === null && !u.sameDay && u.kmGap === null) return;
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const num = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
    const lines = [
      '⚠️ <b>ការចាក់ខុសធម្មតា · Unusual refill</b>',
      '🚚 <b>' + esc(r.plate) + '</b> · ' + esc(r.driver),
      '⛽ <b>' + num(r.litres) + ' L</b>' + (u.usual !== null ? ' (ធម្មតា / usual ~' + num(u.usual) + ' L)' : ''),
    ];
    if (u.sameDay) lines.push('🔁 ចាក់លើកទី ' + (u.sameDay + 1) + ' នៅថ្ងៃនេះ / refill no. ' + (u.sameDay + 1) + ' today');
    if (u.kmGap !== null) lines.push('📏 ' + num(u.kmGap) + ' km ពីលើកមុន / since the last refill');
    lines.push('👉 Requires Investigation · <a href="' + appUrl_() + '/dashboard/">Dashboard</a>');
    if (r.dateTime) lines.push('🕒 ' + Utilities.formatDate(new Date(r.dateTime), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm'));
    lines.push('🆔 <code>' + esc(r.id) + '</code>');
    const chatId = getSetting_('TELEGRAM_ALERT_CHAT_ID');
    const payload = { chat_id: chatId, text: lines.join('\n'), parse_mode: 'HTML', disable_web_page_preview: true };
    // Shown as a reply under the entry's post only if alerts ever go to the same group.
    const first = Array.isArray(replyTo) ? replyTo[0] : replyTo;
    if (first && first.message_id && chatId === getSetting_('TELEGRAM_CHAT_ID')) {
      payload.reply_parameters = JSON.stringify({ message_id: first.message_id, allow_sending_without_reply: true });
    }
    telegram_('sendMessage', payload);
  } catch (e) {
    console.error('Unusual refill alert failed for ' + r.id + ': ' + e);   // never blocks the entry's own post
  }
}

/** Alerts and the recap go to their own group (TELEGRAM_ALERT_CHAT_ID, set by telegramConnectAlerts). */
function alertsReady_() {
  return !!(telegramToken_() && getSetting_('TELEGRAM_ALERT_CHAT_ID'));
}

function appUrl_() {
  return (getSetting_('APP_URL') || 'https://isteel-app.pages.dev').replace(/\/+$/, '');
}

// ---------- Monthly recap (Telegram) ----------
// On the 1st of each month at about 08:00, last month's figures go to the alerts group (TELEGRAM_ALERT_CHAT_ID). The numbers come from
// the dashboard's own engine (FuelEngine at the end of this file), so they match the dashboard.
// The timer is created automatically the first time someone opens the home menu after this update.
// Turn off by setting TELEGRAM_RECAP = No in the Settings sheet. To try it now, run telegramSendRecap.
const RECAP_HANDLER = 'sendMonthlyRecap';
const MONTHS_KM = ['មករា', 'កុម្ភៈ', 'មីនា', 'មេសា', 'ឧសភា', 'មិថុនា', 'កក្កដា', 'សីហា', 'កញ្ញា', 'តុលា', 'វិច្ឆិកា', 'ធ្នូ'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function ensureRecapTrigger_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('RECAP_TRIGGER')) return;
  if (Date.now() - (Number(props.getProperty('RECAP_TRIGGER_TRIED')) || 0) < 24 * 3600 * 1000) return;   // failed: try again tomorrow
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    if (props.getProperty('RECAP_TRIGGER')) return;
    if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === RECAP_HANDLER)) {
      ScriptApp.newTrigger(RECAP_HANDLER).timeBased().onMonthDay(1).atHour(8).create();
    }
    props.setProperty('RECAP_TRIGGER', String(Date.now()));
  } catch (e) {
    props.setProperty('RECAP_TRIGGER_TRIED', String(Date.now()));
    console.error('Monthly recap timer not created: ' + e);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Adds the TELEGRAM_ALERTS and TELEGRAM_RECAP rows (Yes) to the Settings sheet once, so they are easy to find.
 * Change a value to No to stop that message. Rows already there are left as they are.
 */
function ensureTelegramSettings_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('TG_SETTINGS_ROWS')) return;
  try {
    const sheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.SETTINGS);
    if (!sheet) return;
    const keys = sheet.getDataRange().getValues().map(r => String(r[0]).trim());
    [['TELEGRAM_ALERTS', 'Yes', 'Unusual refill alerts in the Telegram group. No = off.'],
     ['TELEGRAM_RECAP', 'Yes', 'Monthly recap in the Telegram group on the 1st at 08:00. No = off.']]
      .forEach(row => { if (keys.indexOf(row[0]) < 0) sheet.appendRow(row); });
    delete tableCache_[SHEETS.SETTINGS];
    props.setProperty('TG_SETTINGS_ROWS', String(Date.now()));
  } catch (e) {
    console.error('Telegram settings rows not added: ' + e);
  }
}

/** Run by the monthly timer: sends last month's recap. */
function sendMonthlyRecap() {
  if (!alertsReady_() || isNo_(getSetting_('TELEGRAM_RECAP'))) return;
  const now = new Date();
  const recap = FuelEngine.monthlyRecap(dashboardRaw_(), now.getFullYear(), now.getMonth() - 1);
  telegram_('sendMessage', { chat_id: getSetting_('TELEGRAM_ALERT_CHAT_ID'), text: recapText_(recap), parse_mode: 'HTML', disable_web_page_preview: true });
}

/** Run from the editor to send last month's recap now (to try it). */
function telegramSendRecap() {
  if (!alertsReady_()) throw new Error('The alerts group is not connected yet: run telegramConnectAlerts first.');
  ensureTelegramSettings_();
  sendMonthlyRecap();
}

function recapText_(r) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const n0 = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const n1 = n => Number(n).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const prevName = MONTHS_EN[(r.month + 11) % 12];
  const lines = ['🏆 <b>សង្ខេបប្រចាំខែ' + MONTHS_KM[r.month] + ' · ' + MONTHS_EN[r.month] + ' ' + r.year + ' recap</b>', ''];
  lines.push('⛽ <b>' + n0(r.litres) + ' L</b>' + (r.spent !== null ? ' · <b>' + esc(r.currency) + n0(r.spent) + '</b>' : '') + ' · ' + n0(r.refills) + ' refills');
  if (r.prevLitres > 0) {
    const d = (r.litres / r.prevLitres - 1) * 100;
    lines.push('    ' + (Math.abs(d) < 1 ? 'about the same as ' : (d > 0 ? '▲ ' : '▼ ') + n0(Math.abs(d)) + '% vs ') + prevName);
  }
  if (r.l100 !== null) {
    let line = '📈 <b>' + n1(r.l100) + ' L/100 km</b>';
    if (r.prevL100) {
      const d = (r.l100 / r.prevL100 - 1) * 100;
      line += ' (' + (Math.abs(d) < 1 ? 'same as ' : (d > 0 ? '▲ ' : '▼ ') + n0(Math.abs(d)) + '% vs ') + prevName + ')';
    }
    lines.push(line);
  }
  if (r.budget > 0 && r.spent !== null) {
    const diff = r.spent - r.budget;
    lines.push('💰 Budget ' + esc(r.currency) + n0(r.budget) + ': ' + (diff > 0 ? '▲ ' + esc(r.currency) + n0(diff) + ' over' : '▼ ' + esc(r.currency) + n0(-diff) + ' under'));
  }
  lines.push('');
  if (r.savers.length) {
    lines.push('<b>Fuel Saver of the Month</b>');
    const medals = ['🥇', '🥈', '🥉'];
    r.savers.forEach((s, i) => lines.push(medals[i] + ' ' + esc(s.driver) + ' · ' + n1(s.l100) + ' L/100 km'));
    lines.push('');
  }
  lines.push('⭐ Complete Data: <b>' + n0(r.clean) + '</b> ' + (r.clean === 1 ? 'driver' : 'drivers') + ' with no data problems');
  if (r.investigate.length) {
    lines.push('🔎 Requires Investigation: ' + r.investigate.length + ' ' + (r.investigate.length === 1 ? 'vehicle' : 'vehicles')
      + ' (' + esc(r.investigate.slice(0, 5).join(', ')) + (r.investigate.length > 5 ? ' …' : '') + ')');
  }
  if (r.pending) lines.push('🧾 ' + n0(r.pending) + ' refills still waiting for review (not counted yet)');
  lines.push('🎉 អរគុណ! Thank you all!');
  lines.push('👉 <a href="' + appUrl_() + '/dashboard/">Dashboard</a>');
  return lines.join('\n');
}

/**
 * Run once from the editor (Kim's request, 9 Oct 2026): makes every driver name in "Fuel Refill"
 * match the numbered name in Driver & Truck column C, e.g. "សេង រដ្ឋា" → "15.សេង រដ្ឋា", 36 → "36.ខាត់ ស៊ីហា".
 * Only the driver column changes. Every change (and any name it can't match) is listed in a new
 * "Driver name fixes" sheet, which also keeps the old values.
 */
function fixDriverNames() {
  const plain = s => String(s).replace(/^\s*[0-9០-៩]+\s*[.)\-]?\s*/, '').replace(/\s+/g, ' ').trim();
  const byNo = {}, byName = {}, labels = {};
  readTable_(SHEETS.DRIVER_TRUCK).forEach(r => {
    const label = String(r[DT_DRIVER] || '').trim();
    if (!label) return;
    labels[label] = true;
    const m = label.match(/^\s*([0-9០-៩]+)\s*\./);
    const no = m ? toNumber_(m[1]) : toNumber_(r['ID_DL']);
    if (no && !byNo[no]) byNo[no] = label;
    const key = plain(label);
    (byName[key] = byName[key] || []).push({ label: label, plate: String(r[DT_PLATE] || '').trim() });
  });

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = refillSheet_();
    const cols = headerIndex_(sheet);
    const n = sheet.getLastRow() - 1;
    if (n < 1) return 'No rows.';
    const all = sheet.getRange(2, 1, n, sheet.getLastColumn()).getValues();
    const drv = cols[COL.DRIVER], plateCol = cols[COL.PLATE], idCol = cols[COL.ID_FR];
    const out = all.map(r => [r[drv]]);
    const log = [];
    all.forEach((r, i) => {
      const v = String(r[drv] === null ? '' : r[drv]).trim();
      if (!v || labels[v]) return;
      let next = '';
      if (/^[0-9០-៩]+(\.0+)?$/.test(v)) {
        next = byNo[toNumber_(v)] || '';
      } else {
        const list = byName[plain(v)] || [];
        const plate = String(r[plateCol] || '').trim();
        next = (list.find(x => x.plate === plate) || list[0] || {}).label || '';
      }
      log.push([i + 2, r[idCol], v, next || '(not found, left as is)']);
      if (next) out[i][0] = next;
    });
    if (log.length) {
      sheet.getRange(2, drv + 1, n, 1).setValues(out);
      const ss = SpreadsheetApp.getActive();
      const logSheet = ss.getSheetByName('Driver name fixes') || ss.insertSheet('Driver name fixes');
      logSheet.clear();
      logSheet.getRange(1, 1, 1, 4).setValues([['Row', 'ID_FR', 'Old name', 'New name']]).setFontWeight('bold');
      logSheet.getRange(2, 1, log.length, 4).setValues(log);
    }
    const fixed = log.filter(x => x[3].indexOf('(not found') !== 0).length;
    const msg = 'Driver names fixed: ' + fixed + '. Not found: ' + (log.length - fixed) + '.';
    console.log(msg);
    return msg;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Run once from the editor: finds the group the bot was added to, saves its chat ID in the
 * Settings sheet and posts a test message there. Before running it, add the bot to the group
 * and send /start@<bot name> in the group.
 */
function telegramConnect() {
  const found = telegramGroups_();
  const chatId = found.ids[found.ids.length - 1];
  setSetting_('TELEGRAM_CHAT_ID', chatId);
  telegram_('sendMessage', { chat_id: chatId,
    text: '✅ Fuel Refill App ភ្ជាប់រួចរាល់។ ការចាក់សាំងថ្មីនឹងបង្ហាញនៅទីនេះ។\nFuel Refill App is connected. New refills will be posted here.' });
  Logger.log('Connected to "' + found.groups[chatId] + '" (' + chatId + ') as @' + found.bot.username);
}

/**
 * Run once from the editor to send unusual-refill alerts and the monthly recap to a second group
 * (Kim, 10 Oct 2026): add the same bot to that group, send /start@<bot> there, then run this.
 * It picks the most recently active group that is not the new-refill group.
 */
function telegramConnectAlerts() {
  const found = telegramGroups_();
  const main = getSetting_('TELEGRAM_CHAT_ID');
  const ids = found.ids.filter(id => id !== main);
  if (!ids.length) {
    throw new Error('Only the new-refill group was found. Add @' + found.bot.username + ' to the alerts group, send /start@' +
      found.bot.username + ' in that group, then run telegramConnectAlerts again.');
  }
  const chatId = ids[ids.length - 1];
  setSetting_('TELEGRAM_ALERT_CHAT_ID', chatId);
  telegram_('sendMessage', { chat_id: chatId,
    text: '✅ ក្រុមនេះនឹងទទួលការជូនដំណឹងចាក់ខុសធម្មតា និងសង្ខេបប្រចាំខែ។\nThis group will get unusual refill alerts and the monthly recap.' });
  Logger.log('Alerts and recap go to "' + found.groups[chatId] + '" (' + chatId + ')');
}

/** Groups the bot has seen recently, oldest first by last activity. */
function telegramGroups_() {
  if (!telegramToken_()) throw new Error('Add TELEGRAM_BOT_TOKEN in Project Settings → Script Properties first.');
  const bot = telegram_('getMe', {});
  let updates;
  try {
    updates = telegram_('getUpdates', { limit: '100' });
  } catch (e) {
    if (/webhook/i.test(e.message)) throw new Error('This bot has a webhook set by another tool. Remove it first, then run this again.');
    throw e;
  }
  const groups = {};
  updates.forEach(u => {
    const m = u.message || u.my_chat_member || u.channel_post || u.edited_message;
    const chat = m && m.chat;
    if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return;
    delete groups[chat.id];                       // keep the most recently active group last
    groups[chat.id] = chat.title || String(chat.id);
  });
  const ids = Object.keys(groups);
  if (!ids.length) {
    throw new Error('No group found. Add @' + bot.username + ' to the group, send /start@' + bot.username +
      ' in the group, then run this again.');
  }
  if (ids.length > 1) Logger.log('Groups seen: ' + ids.map(id => groups[id] + ' (' + id + ')').join(', '));
  return { bot: bot, groups: groups, ids: ids };
}

/** Optional: posts the newest entry to the group so you can see what a notification looks like. */
function telegramSendLatest() {
  const latest = allRefills_().sort((a, b) => (b.dateTime || 0) - (a.dateTime || 0))[0];
  if (!latest) throw new Error('No entries yet.');
  postRefillToTelegram_(latest);
}

// ---------- Validation ----------

function validate_(p, editingId, entryTime) {
  const type = readTypes_().find(t => t.name === String(p.type || ''));
  if (!type) throw new Error('Choose what the fuel is for.');
  const meter = type.meter;
  const lists = driverTruck_();

  // Trucks pick a plate from the CODE column; every other type is free text.
  const plate = String(p.plate || '').trim();
  if (!plate) throw new Error(meter === 'km' ? 'Plate number is required.' : 'Equipment / purpose is required.');
  if (meter === 'km' && lists.plates.indexOf(plate) < 0) {
    throw new Error('Plate "' + plate + '" is not in the CODE column of the Driver & Truck sheet.');
  }
  const equipList = equipmentByType_()[type.name];
  if (meter !== 'km' && equipList && equipList.indexOf(plate) < 0) {
    throw new Error('Equipment "' + plate + '" is not in the Equipment sheet.');
  }

  const driver = String(p.driver || '').trim();
  if (!driver) throw new Error('Driver name is required.');
  if (!lists.drivers.some(d => d.name === driver)) {
    throw new Error('Driver "' + driver + '" is not in the Driver & Truck sheet.');
  }

  const litres = toNumber_(p.litres);
  if (!(litres > 0)) throw new Error('Litres must be more than 0.');

  // "Meter broken" ticked in the app: no km and no odometer photo; the note says so for the reviewer.
  const broken = meter === 'km' && !!p.meterBroken;
  const brokenText = 'កុងទ័រខូច / Odometer broken';
  let note = String(p.note || '').trim();
  if (broken && note.indexOf(brokenText) !== 0) note = brokenText + (note ? ' · ' + note : '');
  const limit = Number(getSetting_('LITRE_LIMIT')) || 250;
  if (litres > limit && !note) throw new Error('More than ' + limit + ' L: please add a note.');

  let km = null, hour = null;
  const last = lastReadings_(editingId, entryTime)[plate] || {};
  if (meter === 'km') {
    km = broken ? null : toNumber_(p.km);
    if (isNaN(km)) km = null;
    if (type.required && !broken && !(km > 0)) throw new Error('Odometer (km) is required, or tick Meter broken.');
    if (type.required && !broken && !editingId && !p.odoPhoto) throw new Error('Odometer photo is required.');
    // 0, 1, 100… typed because the meter can't be read: ask for the tick box instead. New trucks (last reading under 1,000) are fine.
    if (km > 0 && km < MIN_KM && !(last.km && last.km < MIN_KM)) throw new Error('Km ' + km + ' looks wrong (under ' + MIN_KM + '). If the odometer is broken, tick Meter broken.');
    if (km && last.km && km <= last.km && !note) throw new Error('Km is not higher than the last reading (' + last.km + '): please add a note.');
  }
  if (meter === 'hour') {
    hour = toNumber_(p.hour);
    if (isNaN(hour)) hour = null;
    if (type.required && !(hour > 0)) throw new Error('Hour meter reading is required.');
    if (type.required && !editingId && !p.hourPhoto) throw new Error('Hour meter photo is required.');
    if (hour && last.hour && hour <= last.hour && !note) throw new Error('Hour meter is not higher than the last reading (' + last.hour + '): please add a note.');
  }

  if (!editingId && !p.pumpPhoto) throw new Error('Fuel pump photo is required.');

  let latLong = '';
  if (!editingId) {
    const lat = Number(p.lat), lng = Number(p.lng);
    if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) throw new Error('GPS location is required. Turn on location and try again.');
    latLong = lat.toFixed(6) + ', ' + lng.toFixed(6);
  }

  return { type: type.name, meter: meter, meterRequired: type.required, plate: plate, driver: driver,
           km: km, hour: hour, litres: litres, note: note, latLong: latLong, meterBroken: broken };
}

// ---------- Data helpers ----------

/** Refill types. Meter: km | hour | none. Meter Required: Yes/No. Default Equipment: pre-filled text. */
function readTypes_() {
  return readTable_(SHEETS.TYPES)
    .filter(t => t['Type of Refill'])
    .map(t => {
      const meter = String(t['Meter'] || 'none').trim().toLowerCase();
      const req = t['Meter Required'];
      return {
        name: String(t['Type of Refill']).trim(),
        meter: meter,
        required: meter !== 'none' && (req === undefined || req === '' || isYes_(req)),
        defaultEquipment: String(t['Default Equipment'] || '').trim(),
      };
    });
}

/**
 * A driver or truck typed in the app that is not in the lists yet (newDriver / newPlate flags) is
 * added to the "Driver & Truck" sheet first. A new driver gets the next number, written like the
 * existing rows: ID_DL 39, ឈ្មោះ "មាស តារា", ឈ្មោះតៃកុង "39.មាស តារា". Runs inside the submit lock.
 */
function addNewNames_(p) {
  const wantDriver = p.newDriver && String(p.driver || '').trim();
  const wantPlate = p.newPlate && String(p.plate || '').trim();
  if (!wantDriver && !wantPlate) return;
  const type = readTypes_().find(t => t.name === String(p.type || ''));
  const lists = driverTruck_();
  const row = {};

  if (wantPlate && type && type.meter === 'km') {
    const plate = cleanPlate_(p.plate);
    if (!/^[A-Z0-9][A-Z0-9.\-]{1,19}$/.test(plate)) throw new Error('Plate "' + p.plate + '" does not look like a plate number.');
    const key = x => String(x).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const same = lists.plates.find(x => key(x) === key(plate));
    p.plate = same || plate;
    if (!same) row[DT_PLATE] = plate;
  }

  if (wantDriver) {
    // Typed names may carry a number already ("39. មាស តារា"): keep only the name.
    const name = String(p.driver).replace(/^\s*[0-9០-៩]+\s*[.)\-]?\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name) throw new Error('Driver name is required.');
    const plain = s => String(s).replace(/^\s*[0-9០-៩]+\s*[.)\-]?\s*/, '').replace(/\s+/g, ' ').trim();
    const same = lists.drivers.find(d => plain(d.name) === name);
    if (same) {
      p.driver = same.name;
    } else {
      const rows = readTable_(SHEETS.DRIVER_TRUCK);
      let max = 0, last = null;
      rows.forEach(r => {
        const m = String(r[DT_DRIVER] || '').match(/^\s*([0-9០-៩]+)\s*\./);
        const n = Math.max(toNumber_(r['ID_DL']) || 0, m ? toNumber_(m[1]) || 0 : 0);
        if (n >= max) { max = n; last = r; }
      });
      const no = max + 1;
      const label = (no < 10 ? '0' : '') + no + '.' + name;
      row['ID_DL'] = no;
      row['ឈ្មោះ'] = name;
      row[DT_DRIVER] = label;
      if (last && last['ក្រុមហ៊ុន']) row['ក្រុមហ៊ុន'] = last['ក្រុមហ៊ុន'];
      if (!row[DT_PLATE] && type && type.meter === 'km' && p.plate) row[DT_PLATE] = String(p.plate).trim();
      p.driver = label;
    }
  }

  if (!row[DT_PLATE] && !row[DT_DRIVER]) return;
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.DRIVER_TRUCK);
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  sheet.appendRow(header.map(h => row[h] === undefined ? '' : row[h]));
  delete tableCache_[SHEETS.DRIVER_TRUCK];
}

/** "3f 8691" or "3F8691" → "3F-8691", the way plates are written in the CODE column. */
function cleanPlate_(v) {
  const s = String(v || '').toUpperCase().trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-');
  const m = s.match(/^(\d[A-Z]{1,2})-?(\d{4})$/);
  return m ? m[1] + '-' + m[2] : s;
}

/** Dropdown lists from the "Driver & Truck" sheet: unique plates (CODE) and drivers with their plate. */
function driverTruck_() {
  const rows = readTable_(SHEETS.DRIVER_TRUCK);
  const plates = [], drivers = [];
  rows.forEach(r => {
    const name = String(r[DT_DRIVER] || '').trim();
    const code = String(r[DT_PLATE] || '').trim();
    if (code && plates.indexOf(code) < 0) plates.push(code);
    if (name && !drivers.some(d => d.name === name)) drivers.push({ name: name, plate: code });
  });
  plates.sort();
  return { plates: plates, drivers: drivers, brokenPlates: brokenPlates_(rows) };
}

/** Plates whose "Odometer Broken?" cell says Yes (also accepts Y, True, ខូច). */
function brokenPlates_(rows) {
  const out = [];
  rows.forEach(r => {
    const key = Object.keys(r).find(k => DT_BROKEN.test(k));
    const v = key ? String(r[key] || '').trim().toLowerCase() : '';
    const code = String(r[DT_PLATE] || '').trim();
    if (code && /^(yes|y|true|ខូច|បាទ|ចាស)$/.test(v) && out.indexOf(code) < 0) out.push(code);
  });
  return out;
}

/** Equipment dropdowns per refill type from the "Equipment" sheet. Types without rows use free text. */
function equipmentByType_() {
  const out = {};
  readTable_(SHEETS.EQUIPMENT).forEach(r => {
    const name = String(r['Equipment'] || '').trim();
    const type = String(r['Type of Refill'] || '').trim();
    if (!name || !type || (r['Active'] !== undefined && r['Active'] !== '' && !isYes_(r['Active']))) return;
    (out[type] || (out[type] = [])).push(name);
  });
  return out;
}

function refillSheet_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.REFILL);
  if (!sheet) throw new Error('Sheet "' + SHEETS.REFILL + '" not found.');
  return sheet;
}

const headerCache_ = {};

function headerIndex_(sheet) {
  if (headerCache_[sheet.getName()]) return headerCache_[sheet.getName()];
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const idx = {};
  header.forEach((h, i) => { if (h !== '') idx[String(h).trim()] = i; });
  [COL.HOUR, COL.HOUR_PHOTO, COL.UPDATED_AT].forEach(name => {
    if (idx[name] === undefined) {               // add missing app columns once
      const c = sheet.getLastColumn() + 1;
      sheet.getRange(1, c).setValue(name);
      idx[name] = c - 1;
    }
  });
  return (headerCache_[sheet.getName()] = idx);
}

// Each small sheet is read at most once per request; setSetting_ clears the Settings copy.
const tableCache_ = {};

function readTable_(name) {
  if (!tableCache_[name]) tableCache_[name] = readTableNow_(name);
  return tableCache_[name];
}

function readTableNow_(name) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getDataRange().getValues();
  const header = values.shift().map(h => String(h).trim());
  return values.map(r => {
    const o = {};
    header.forEach((h, i) => { if (h) o[h] = r[i]; });
    return o;
  });
}

function allRefills_() {
  const sheet = refillSheet_();
  const cols = headerIndex_(sheet);
  const values = sheet.getDataRange().getValues();
  values.shift();
  const get = (r, name) => cols[name] === undefined ? '' : r[cols[name]];
  return values.filter(r => get(r, COL.ID_FR)).map(r => {
    const dt = get(r, COL.DATETIME);
    return {
      id: String(get(r, COL.ID_FR)),
      type: String(get(r, COL.TYPE)),
      plate: String(get(r, COL.PLATE)),
      driver: String(get(r, COL.DRIVER)),
      km: get(r, COL.KM) === '' ? null : Number(get(r, COL.KM)),
      hour: get(r, COL.HOUR) === '' ? null : Number(get(r, COL.HOUR)),
      litres: Number(get(r, COL.LITRES)) || 0,
      note: String(get(r, COL.NOTE)),
      latLong: String(get(r, COL.LATLONG)),
      user: String(get(r, COL.USER)).toLowerCase(),
      dateTime: dt instanceof Date ? dt.getTime() : null,
      status: String(get(r, COL.STATUS)),
      reviewedBy: String(get(r, COL.REVIEWED_BY)),
      reviewedAt: get(r, COL.REVIEWED_AT) instanceof Date ? get(r, COL.REVIEWED_AT).getTime() : null,
      updatedAt: get(r, COL.UPDATED_AT) instanceof Date ? get(r, COL.UPDATED_AT).getTime() : null,
      odoPhoto: String(get(r, COL.ODO_PHOTO)),
      hourPhoto: String(get(r, COL.HOUR_PHOTO)),
      pumpPhoto: String(get(r, COL.PUMP_PHOTO)),
      signature: String(get(r, COL.SIGNATURE)),
    };
  });
}

/**
 * Most recent km / hour reading per plate, ignoring rejected entries, placeholder readings (0 or 1),
 * the entry being edited and (optionally) entries at or after beforeTime.
 */
function lastReadings_(excludeId, beforeTime) {
  const out = {};
  allRefills_().forEach(r => {
    if (r.status === STATUS_BAD || r.id === excludeId || !r.plate || !r.dateTime) return;
    if (beforeTime && r.dateTime >= beforeTime) return;   // when correcting an old entry, compare with earlier ones only
    const o = out[r.plate] || (out[r.plate] = { km: 0, kmAt: 0, hour: 0, hourAt: 0 });
    if (r.km > 1 && r.dateTime > o.kmAt) { o.km = r.km; o.kmAt = r.dateTime; }
    if (r.hour > 1 && r.dateTime > o.hourAt) { o.hour = r.hour; o.hourAt = r.dateTime; }
  });
  return out;
}

function findRow_(sheet, cols, id) {
  const ids = sheet.getRange(2, cols[COL.ID_FR] + 1, Math.max(sheet.getLastRow() - 1, 1), 1).getValues();
  const i = ids.findIndex(r => String(r[0]) === String(id));
  if (i < 0) throw new Error('Entry ' + id + ' not found.');
  return i + 2;
}

function newId_(sheet, cols, now) {
  const base = 'FR' + Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyMMdd-HHmmss');
  const ids = new Set(sheet.getRange(2, cols[COL.ID_FR] + 1, Math.max(sheet.getLastRow() - 1, 1), 1)
    .getValues().map(r => String(r[0])));
  let id = base, n = 2;
  while (ids.has(id)) id = base + '-' + n++;
  return id;
}

function getSetting_(key) {
  const row = readTable_(SHEETS.SETTINGS).find(s => String(s['Key']).trim() === key);
  return row ? String(row['Value']).trim() : '';
}

function setSetting_(key, value) {
  delete tableCache_[SHEETS.SETTINGS];
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEETS.SETTINGS);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === key) { sheet.getRange(i + 1, 2).setValue(value); return; }
  }
  sheet.appendRow([key, value]);
}

let photoFolderCache_ = null;

function photoFolder_() {
  if (photoFolderCache_) return photoFolderCache_;
  const id = getSetting_('PHOTO_FOLDER_ID');
  if (id) {
    try { return (photoFolderCache_ = DriveApp.getFolderById(id)); } catch (e) { /* recreate below */ }
  }
  const ssFile = DriveApp.getFileById(SpreadsheetApp.getActive().getId());
  const parents = ssFile.getParents();
  const parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const folder = parent.createFolder(PHOTO_FOLDER_NAME);
  setSetting_('PHOTO_FOLDER_ID', folder.getId());
  return (photoFolderCache_ = folder);
}

/** Saves a data URL image to the photo folder and returns its Drive link ('' when none). */
function savePhoto_(dataUrl, id, label) {
  if (!dataUrl) return '';
  const m = /^data:(image\/(jpeg|png));base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error('Invalid image for ' + label + '.');
  const ext = m[2] === 'png' ? 'png' : 'jpg';
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HHmmss');
  const blob = Utilities.newBlob(Utilities.base64Decode(m[3]), m[1], id + '.' + label + '.' + stamp + '.' + ext);
  const file = photoFolder_().createFile(blob);
  return 'https://drive.google.com/file/d/' + file.getId() + '/view';
}

function fileIdFromUrl_(url) {
  const m = /\/d\/([\w-]{20,})/.exec(String(url || ''));
  return m ? m[1] : null;
}

function toNumber_(v) {
  if (v === null || v === undefined || v === '') return NaN;
  const khmer = '០១២៣៤៥៦៧៨៩';
  const s = String(v).replace(/[០-៩]/g, d => String(khmer.indexOf(d))).replace(/,/g, '').trim();
  return Number(s);
}

function isYes_(v) {
  const s = String(v).trim().toLowerCase();
  return s === 'yes' || s === 'true' || s === 'y' || s === '1';
}

function isNo_(v) {
  const s = String(v).trim().toLowerCase();
  return s === 'no' || s === 'false' || s === 'n' || s === '0' || s === 'off';
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Run once from the editor to grant permissions and create the photo folder. */
function setup() {
  headerIndex_(refillSheet_());
  const folder = photoFolder_();
  Logger.log('Photo folder: ' + folder.getUrl());
  Logger.log('Client ID set: ' + (getSetting_('GOOGLE_CLIENT_ID') ? 'yes' : 'NO - fill it in the Settings sheet'));
}

// ==== BEGIN FuelEngine (generated from the dashboard's engine.ts + recap.ts by "npm run engine": do not edit by hand) ====
"use strict";var FuelEngine=(()=>{var U=Object.defineProperty;var le=Object.getOwnPropertyDescriptor;var oe=Object.getOwnPropertyNames;var ue=Object.prototype.hasOwnProperty;var ae=(t,r)=>{for(var n in r)U(t,n,{get:r[n],enumerable:!0})},ce=(t,r,n,i)=>{if(r&&typeof r=="object"||typeof r=="function")for(let l of oe(r))!ue.call(t,l)&&l!==n&&U(t,l,{get:()=>r[l],enumerable:!(i=le(r,l))||i.enumerable});return t};var me=t=>ce(U({},"__esModule",{value:!0}),t);var ye={};ae(ye,{cleanDrivers:()=>ie,monthStart:()=>Y,monthView:()=>q,monthlyRecap:()=>ve,savers:()=>se});var pe="\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C",ge="\u1798\u17B7\u1793\u178F\u17D2\u179A\u17B9\u1798\u178F\u17D2\u179A\u17BC\u179C";var J={minReadingKm:1e3,placeholders:[0,1,100,123,150,200,1234,12345,123455,123456,111111,999999],maxJumpKm:2e3,maxJumpHour:500,minStretches:3,minKm:1e3,investigatePct:20,fuelPrice:0,currency:"$",fuelPrices:[],monthlyBudget:0,defaultType:"Truck",vehicleTypes:[{name:"Truck",target:null,inFleet:!0},{name:"Motorbike",target:null,inFleet:!1}],plateType:{"1HS-1800":"Motorbike","1IG-9159":"Motorbike","1JQ-2735":"Motorbike","1LU-5135":"Motorbike"}};function ee(t){let r={...J,...t||{}};return(!Array.isArray(r.vehicleTypes)||!r.vehicleTypes.length)&&(r.vehicleTypes=J.vehicleTypes),(!r.plateType||typeof r.plateType!="object")&&(r.plateType={}),Array.isArray(r.placeholders)||(r.placeholders=J.placeholders),Array.isArray(r.fuelPrices)||(r.fuelPrices=[]),r.fuelPrices=r.fuelPrices.filter(n=>n&&/^\d{4}-\d{2}-\d{2}$/.test(n.from)&&n.price>0).sort((n,i)=>n.from.localeCompare(i.from)),r}var z=t=>t.fuelPrice>0||t.fuelPrices.length>0;function de(t,r){if(!t.fuelPrices.length)return t.fuelPrice;let n=new Date(r),i=`${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}-${String(n.getDate()).padStart(2,"0")}`,l=t.fuelPrices[0].price;for(let c of t.fuelPrices)if(c.from<=i)l=c.price;else break;return l}var V="(mixed drivers)",E="(no plate)",te="\u17E0\u17E1\u17E2\u17E3\u17E4\u17E5\u17E6\u17E7\u17E8\u17E9";function G(t){if(t==null||t==="")return null;if(typeof t=="number")return isFinite(t)?t:null;let r=String(t).replace(/[០-៩]/g,i=>String(te.indexOf(i))).replace(/,/g,"").trim();if(!r)return null;let n=Number(r);return isFinite(n)?n:null}var R=t=>(t==null?"":String(t)).trim(),W=t=>{let r=R(t);return r.startsWith("d:")?`https://drive.google.com/file/d/${r.slice(2)}/view`:r},Q=t=>t.replace(/[០-៩]/g,r=>String(te.indexOf(r)));function fe(t,r){let n=r.find(l=>l.name===t),i=n?n.meter:"";return i==="km"?"km":i==="hour"?"hour":n?"none":/🚚|ឡាន/.test(t)?"km":"none"}function be(t){var i;let r=new Map,n=new Map;for(let l of t){let c=l.label||l.name,u=Q(c).match(/^0*(\d+)\s*\.\s*(.+)$/),d=(l.name||(u?u[2]:c)).trim();r.set(d,c),r.set(c,c);let b=(i=G(l.no))!=null?i:u?Number(u[1]):null;b!==null&&n.set(b,c)}return l=>{let c=Q(l).replace(/\s+/g," ").trim();if(!c)return{name:"(no driver)",known:!1};if(r.has(c))return{name:r.get(c),known:!0};let u=c.match(/^0*(\d+)\s*[.\-]?\s*(.*)$/);return u&&u[2]&&r.has(u[2].trim())?{name:r.get(u[2].trim()),known:!0}:u&&!u[2]&&n.has(Number(u[1]))?{name:n.get(Number(u[1])),known:!0}:{name:u&&u[2]?u[2].trim():c,known:!1}}}function re(t,r){let n=o=>t.columns.indexOf(o),i={id:n("id"),type:n("type"),plate:n("plate"),driver:n("driver"),km:n("km"),litres:n("litres"),t:n("dateTime"),status:n("status"),user:n("user"),hour:n("hour"),note:n("note"),odo:n("odoPhoto"),pump:n("pumpPhoto"),hourPhoto:n("hourPhoto")},l=(o,p)=>p<0?"":o[p],c=be(t.drivers||[]),u={},d=[],b=[],S=[],K=new Set((t.brokenPlates||[]).map(o=>String(o).trim().toUpperCase()).filter(Boolean)),N=0,F=0;for(let o of t.rows){let p=R(l(o,i.status));if(p!==pe){p===ge?F++:N++;continue}let m=R(l(o,i.type));m in u||(u[m]=fe(m,t.types||[]));let P=l(o,i.t),g=typeof P=="number"?P:P?Date.parse(String(P)):NaN;if(!isFinite(g))continue;let v=c(R(l(o,i.driver))),f=R(l(o,i.plate)).replace(/\s+/g," "),h={id:R(l(o,i.id)),type:m,meter:u[m],plate:f?/^[0-9A-Za-z-]+$/.test(f)?f.toUpperCase():f:E,driverRaw:R(l(o,i.driver)),driver:v.name,km:G(l(o,i.km)),hour:G(l(o,i.hour)),litres:G(l(o,i.litres))||0,t:g,status:p,user:R(l(o,i.user)),note:R(l(o,i.note)),odoPhoto:W(l(o,i.odo)),pumpPhoto:W(l(o,i.pump)),hourPhoto:W(l(o,i.hourPhoto)),dup:!1,role:""};d.push(h),!f&&h.meter!=="none"&&b.push({rec:h,kind:"noPlate",detail:"Plate is empty"}),!v.known&&h.driverRaw&&b.push({rec:h,kind:"unknownDriver",detail:h.driverRaw})}d.sort((o,p)=>o.t-p.t);let I=new Map;for(let o of d){if(o.meter==="none"||o.plate===E)continue;let p=I.get(o.plate);p||I.set(o.plate,p=[]),p.push(o)}let D=[],$=new Set(r.placeholders);for(let[o,p]of I){let m=p[0].meter==="hour"?"hour":"km",P=m==="km"?r.maxJumpKm:r.maxJumpHour,g=null,v=0,f=null,h=0,T=null;for(let a of p){let k=m==="km"?a.km:a.hour;if(T&&a.t-T.t<108e5&&a.litres===T.litres&&(m==="km"?a.km:a.hour)===(m==="km"?T.km:T.hour)&&k!==null){a.dup=!0,b.push({rec:a,kind:"duplicate",detail:`Same reading and litres as ${T.id}`});continue}if(T=a,m==="km"&&K.has(o)){a.role="invalid",S.push({rec:a,kind:"broken",detail:"Marked in Driver & Truck"});continue}let y=null,x="";if(k===null){if(m==="hour"){v+=a.litres,h+=a.litres,a.role="invalid";continue}if(/^\s*(កុងទ័រខូច|Odometer broken)/i.test(a.note)){a.role="invalid",v+=a.litres,h+=a.litres,S.push({rec:a,kind:"broken",detail:"Ticked in the app"});continue}y="missing"}else if(m==="km"&&($.has(k)||k<r.minReadingKm))y="placeholder",x=`Km ${k}`;else if(g){let w=m==="km"?g.km:g.hour;k<w?(y="lower",x=`${C(k)} after ${C(w)}`):k===w?(y="zero",x=`${C(k)} again`):k-w>P&&(y="jump",x=`+${C(k-w)} ${m} since ${C(w)}`)}if(y==="lower"||y==="jump"){let w=f?m==="km"?f.km:f.hour:null;f&&w!==null&&k>w&&k-w<=P?(g=f,g.role="start",v=h,f=null,y=null):(f=a,h=0)}if(y){a.role="invalid",m==="hour"&&y==="zero"||b.push({rec:a,kind:y,detail:x}),v+=a.litres,a!==f&&(h+=a.litres);continue}if(!g){g=a,a.role="start",v=0;continue}let _=m==="km"?g.km:g.hour;D.push({plate:o,meter:m,from:g,to:a,dist:k-_,litres:a.litres+v,carried:v,t:a.t,driver:g.driver===a.driver?a.driver:V}),a.role="stretch",g=a,v=0,f=null,h=0}}D.sort((o,p)=>o.t-p.t);let O=o=>[...new Set(o)].sort((p,m)=>p.localeCompare(m));return{records:d,stretches:D,issues:b,broken:S,brokenPlates:K,pendingCount:N,rejectedCount:F,typeMeter:u,plates:O(d.filter(o=>o.plate!==E).map(o=>o.plate)),drivers:O(d.map(o=>o.driver)),types:O(d.map(o=>o.type)),minT:d.length?d[0].t:0,maxT:d.length?d[d.length-1].t:0}}function C(t){return Math.round(t*10)/10+""}var H={from:null,to:null,type:"",plate:"",driver:"",vtype:""};function he(t,r){let n=r.plateType[t]||r.defaultType;return r.vehicleTypes.find(i=>i.name===n)||{name:n,target:null,inFleet:!0}}var j=(t,r)=>(r.from===null||t>=r.from)&&(r.to===null||t<=r.to);function ke(t){let r=new Date(t),n=(r.getDay()+6)%7;return r.setHours(0,0,0,0),r.setDate(r.getDate()-n),r.getTime()}function ne(t,r,n){let i=new Map,l=e=>{let s=i.get(e);return s||i.set(e,s=he(e,r)),s},c=e=>!e.dup&&j(e.t,n)&&(!n.type||e.type===n.type)&&(!n.plate||e.plate===n.plate)&&(!n.driver||e.driver===n.driver)&&(!n.vtype||e.meter==="km"&&l(e.plate).name===n.vtype),u=t.records.filter(c),d=t.stretches.filter(e=>j(e.t,n)&&(!n.type||e.to.type===n.type)&&(!n.plate||e.plate===n.plate)&&(!n.driver||e.driver===n.driver)&&(!n.vtype||l(e.plate).name===n.vtype)),b=e=>j(e.rec.t,n)&&(!n.type||e.rec.type===n.type)&&(!n.plate||e.rec.plate===n.plate)&&(!n.driver||e.rec.driver===n.driver),S=t.issues.filter(b),K=t.broken.filter(b),N=d.filter(e=>e.meter==="km"),F=N.filter(e=>l(e.plate).inFleet),I=A(F,e=>e.dist),D=A(F,e=>e.litres),$=I>0&&D>0?D/I*100:null,O=u.filter(e=>e.meter==="km"&&l(e.plate).inFleet&&!t.brokenPlates.has(e.plate)),o=A(O,e=>e.litres),p=new Map;for(let e of S)p.set(e.rec.plate,(p.get(e.rec.plate)||0)+1);let m=e=>{let s=l(e).target;return s&&s>0?{ref:s,isTarget:!0}:{ref:$,isTarget:!1}},P=new Map,g=(e,s,M)=>{let L=e.get(s);return L||e.set(s,L={key:s,refills:0,litres:0,stretches:0,dist:0,sLitres:0,l100:null,kmL:null,ref:null,refIsTarget:!1,gapPct:null,enough:!1,status:"nodata",saving:0,issues:0,meterBroken:!1,vtype:M,last:0}),L};for(let e of u){if(e.meter!=="km")continue;let s=g(P,e.plate,l(e.plate).name);s.refills++,s.litres+=e.litres,s.last=Math.max(s.last,e.t)}for(let e of N){let s=g(P,e.plate,l(e.plate).name);s.stretches++,s.dist+=e.dist,s.sLitres+=e.litres}for(let e of P.values()){e.issues=p.get(e.key)||0,e.meterBroken=t.brokenPlates.has(e.key);let s=m(e.key);Z(e,s.ref,s.isTarget,r)}let v=new Map,f=new Map;for(let e of u){let s=g(v,e.driver,"");s.refills++,s.litres+=e.litres,s.last=Math.max(s.last,e.t)}for(let e of F){if(e.driver===V)continue;let s=g(v,e.driver,"");s.stretches++,s.dist+=e.dist,s.sLitres+=e.litres;let M=m(e.plate),L=f.get(e.driver)||{w:0,d:0,target:!0};M.ref!==null&&(L.w+=M.ref*e.dist,L.d+=e.dist),L.target=L.target&&M.isTarget,f.set(e.driver,L)}for(let e of v.values()){let s=f.get(e.key);Z(e,s&&s.d>0?s.w/s.d:null,!!(s&&s.target),r)}let h=new Map;for(let e of u){if(e.meter==="km")continue;let s=g(h,e.plate===E?e.type:e.plate,e.type);s.refills++,s.litres+=e.litres,s.last=Math.max(s.last,e.t)}for(let e of d){if(e.meter!=="hour")continue;let s=g(h,e.plate,e.to.type);s.stretches++,s.dist+=e.dist,s.sLitres+=e.litres}for(let e of h.values())e.l100=e.dist>0&&e.sLitres>0?e.sLitres/e.dist:null;let T=new Map,a=e=>{let s=ke(e),M=T.get(s);return M||T.set(s,M={week:s,litres:0,dist:0,sLitres:0,l100:null,refills:0}),M};for(let e of u){let s=a(e.t);s.litres+=e.litres,s.refills++}for(let e of F){let s=a(e.t);s.dist+=e.dist,s.sLitres+=e.litres}let k=[...T.values()].sort((e,s)=>e.week-s.week);for(let e of k)e.l100=e.dist>0&&e.sLitres>0?e.sLitres/e.dist*100:null;let y=new Map;for(let e of u){let s=y.get(e.type)||{type:e.type,litres:0,refills:0};s.litres+=e.litres,s.refills++,y.set(e.type,s)}let x=[...P.values()],_=[...v.values()],w=x.filter(e=>l(e.key).inFleet),B=A(u,e=>e.litres),X=z(r)?A(u,e=>e.litres*de(r,e.t)):0;return{records:u,stretches:d,issues:S,broken:K,litres:B,refills:u.length,kmLitres:o,spent:X,avgPrice:B>0?X/B:0,dist:I,sLitres:D,fleetL100:$,fleetKmL:$?100/$:null,coverage:o>0?Math.min(1,D/o):null,trucks:x,drivers:_,weeks:k,byType:[...y.values()].sort((e,s)=>s.litres-e.litres),equipment:[...h.values()].sort((e,s)=>s.litres-e.litres),savingLitres:A(w,e=>e.saving),investigate:w.filter(e=>e.status==="investigate").length}}function Z(t,r,n,i){t.l100=t.dist>0&&t.sLitres>0?t.sLitres/t.dist*100:null,t.kmL=t.l100?100/t.l100:null,t.ref=r,t.refIsTarget=n,t.enough=t.stretches>=i.minStretches&&t.dist>=i.minKm,t.gapPct=t.l100!==null&&r?(t.l100/r-1)*100:null,t.l100===null||!t.enough?t.status="nodata":t.gapPct!==null&&t.gapPct>i.investigatePct?t.status="investigate":t.gapPct!==null&&t.gapPct>0?t.status="above":t.status="ok",t.saving=t.enough&&r&&t.l100!==null&&t.l100>r?t.sLitres-t.dist*r/100:0}function A(t,r){let n=0;for(let i of t)n+=r(i);return n}function se(t){return t.drivers.filter(r=>r.key!==V&&r.enough&&r.l100!==null&&r.gapPct!==null&&r.gapPct<=0).sort((r,n)=>r.gapPct-n.gapPct).map(r=>{var l;let n=new Map;for(let c of t.stretches)c.driver===r.key&&n.set(c.plate,(n.get(c.plate)||0)+1);let i=((l=[...n.entries()].sort((c,u)=>u[1]-c[1])[0])==null?void 0:l[0])||"";return{driver:r.key,l100:r.l100,gapPct:r.gapPct,dist:r.dist,plate:i}})}function ie(t){let r=new Set(t.issues.map(n=>n.rec.driver));return new Set(t.records.map(n=>n.driver).filter(n=>n&&!r.has(n))).size}var Y=(t,r)=>new Date(t,r,1).getTime(),q=(t,r,n,i,l)=>ne(t,r,{...n,from:Y(i,l),to:Y(i,l+1)-1});function ve(t,r,n){let i=ee(t.settings),l=re(t,i),c=q(l,i,H,r,n),u=q(l,i,H,r,n-1),d=b=>{var S;return((S=i.vehicleTypes.find(K=>K.name===b))==null?void 0:S.inFleet)!==!1};return{year:new Date(r,n,1).getFullYear(),month:new Date(r,n,1).getMonth(),refills:c.refills,litres:c.litres,spent:z(i)?c.spent:null,currency:i.currency,l100:c.fleetL100,prevL100:u.fleetL100,prevLitres:u.litres,budget:i.monthlyBudget,savers:se(c).slice(0,3),clean:ie(c),investigate:c.trucks.filter(b=>d(b.vtype)&&b.status==="investigate").map(b=>b.key),pending:l.pendingCount}}return me(ye);})();
// ==== END FuelEngine ====
