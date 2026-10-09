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
    if (!action) throw new Error('Unknown action: ' + req.action);
    const user = authenticate_(req.token);
    return json_({ ok: true, data: action(req.payload || {}, user) });
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
};

// ---------- Auth ----------

/** Verifies a Google Sign-In ID token and returns the matching active user from the Users sheet. */
function authenticate_(token) {
  if (!token) throw new Error('AUTH: Please sign in.');
  const cache = CacheService.getScriptCache();
  const key = 'tok_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  let email = cache.get(key);
  if (!email) {
    const res = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token),
      { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('AUTH: Sign-in expired. Please sign in again.');
    const info = JSON.parse(res.getContentText());
    const clientId = getSetting_('GOOGLE_CLIENT_ID');
    if (!clientId || info.aud !== clientId) throw new Error('AUTH: Sign-in is not set up for this app.');
    if (String(info.email_verified) !== 'true') throw new Error('AUTH: Google email is not verified.');
    email = String(info.email).toLowerCase();
    const secondsLeft = Number(info.exp) - Math.floor(Date.now() / 1000);
    if (secondsLeft > 60) cache.put(key, email, Math.min(secondsLeft - 30, 3000));
  }
  const user = readTable_(SHEETS.USERS).find(u =>
    String(u['Email']).trim().toLowerCase() === email && isYes_(u['Active']));
  if (!user) throw new Error('NOACCESS: ' + email + ' is not allowed to use this app. Ask the admin to add you to the Users sheet.');
  return { email: email, name: user['Name'] || '', role: String(user['Role'] || 'user').toLowerCase() };
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
    equipment: equipmentByType_(),
    litreLimit: Number(getSetting_('LITRE_LIMIT')) || 250,
    lastReadings: lastReadings_(),
  };
}

function submitRefill_(p, user) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let sendNow = false;
  try {
    // The phone sends each entry with a ref and may send it again if the answer got lost: save it once.
    const ref = String(p.ref || '').slice(0, 64);
    const refs = ref ? JSON.parse(PropertiesService.getScriptProperties().getProperty('SUBMIT_REFS') || '{}') : {};
    if (ref && refs[ref]) return { id: refs[ref], duplicate: true };

    const sheet = refillSheet_();
    const cols = headerIndex_(sheet);
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
    if (ref) {
      refs[ref] = id;
      const keys = Object.keys(refs);
      keys.slice(0, Math.max(0, keys.length - 300)).forEach(k => delete refs[k]);   // keep the last 300
      PropertiesService.getScriptProperties().setProperty('SUBMIT_REFS', JSON.stringify(refs));
    }
    sendNow = queueTelegram_(id) === 'now';
    return { id: id };
  } finally {
    lock.releaseLock();
    if (sendNow) try { sendTelegramQueue(); } catch (e) { console.error(e); }
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
    if (clean.meterRequired && clean.meter === 'km' && !row[cols[COL.ODO_PHOTO]]) throw new Error('Odometer photo is required.');
    if (clean.meterRequired && clean.meter === 'hour' && !row[cols[COL.HOUR_PHOTO]]) throw new Error('Hour meter photo is required.');

    sheet.getRange(rowNum, 1, 1, row.length).setValues([row]);
    return { id: p.id };
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
  if (!isReviewer_(user)) throw new Error('NOACCESS: Only reviewers and admins can open the dashboard.');
  const sheet = refillSheet_();
  const values = sheet.getDataRange().getValues();
  const header = values.shift().map(h => String(h).trim());
  const idx = DASH_FIELDS.map(f => header.indexOf(f[1]));
  const rows = [];
  values.forEach(r => {
    if (idx[0] < 0 || r[idx[0]] === '') return;
    rows.push(idx.map(i => {
      if (i < 0) return '';
      const v = r[i];
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
    settings: dashSettings_(),
    user: user,
    generatedAt: Date.now(),
  };
}

function dashboardSave_(p, user) {
  if (!isReviewer_(user)) throw new Error('NOACCESS: Only reviewers and admins can change dashboard settings.');
  const text = JSON.stringify(p.settings || {});
  if (text.length > 45000) throw new Error('Settings are too large.');
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(DASH_SHEET) || ss.insertSheet(DASH_SHEET);
  sheet.getRange(1, 1, 3, 2).setValues([
    ['Key', 'Value'],
    ['settings', text],
    ['updated', user.email + ' ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')],
  ]);
  return { saved: true };
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
      postRefillToTelegram_(r);
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
    setSetting_('TELEGRAM_CHAT_ID', String(moved));
    payload.chat_id = String(moved);
    return telegram_(method, payload);
  }
  throw new Error('Telegram ' + method + ': ' + (body.description || 'HTTP ' + res.getResponseCode()));
}

/**
 * Run once from the editor: finds the group the bot was added to, saves its chat ID in the
 * Settings sheet and posts a test message there. Before running it, add the bot to the group
 * and send /start@<bot name> in the group.
 */
function telegramConnect() {
  if (!telegramToken_()) throw new Error('Add TELEGRAM_BOT_TOKEN in Project Settings → Script Properties first.');
  const bot = telegram_('getMe', {});
  let updates;
  try {
    updates = telegram_('getUpdates', { limit: '100' });
  } catch (e) {
    if (/webhook/i.test(e.message)) throw new Error('This bot has a webhook set by another tool. Remove it first, then run telegramConnect again.');
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
      ' in the group, then run telegramConnect again.');
  }
  const chatId = ids[ids.length - 1];
  if (ids.length > 1) Logger.log('Groups seen: ' + ids.map(id => groups[id] + ' (' + id + ')').join(', '));
  setSetting_('TELEGRAM_CHAT_ID', chatId);
  telegram_('sendMessage', { chat_id: chatId,
    text: '✅ Fuel Refill App ភ្ជាប់រួចរាល់។ ការចាក់សាំងថ្មីនឹងបង្ហាញនៅទីនេះ។\nFuel Refill App is connected. New refills will be posted here.' });
  Logger.log('Connected to "' + groups[chatId] + '" (' + chatId + ') as @' + bot.username);
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

  const note = String(p.note || '').trim();
  const limit = Number(getSetting_('LITRE_LIMIT')) || 250;
  if (litres > limit && !note) throw new Error('More than ' + limit + ' L: please add a note.');

  let km = null, hour = null;
  const last = lastReadings_(editingId, entryTime)[plate] || {};
  if (meter === 'km') {
    km = toNumber_(p.km);
    if (isNaN(km)) km = null;
    if (type.required && !(km > 0)) throw new Error('Odometer (km) is required.');
    if (type.required && !editingId && !p.odoPhoto) throw new Error('Odometer photo is required.');
    if (km && last.km && km <= last.km && !note) throw new Error('Km is not higher than the last reading (' + last.km + '): please add a note.');
  }
  if (meter === 'hour') {
    hour = toNumber_(p.hour);
    if (isNaN(hour)) hour = null;
    if (type.required && !(hour > 0)) throw new Error('Hour meter reading is required.');
    if (type.required && !editingId && !p.hourPhoto) throw new Error('Hour meter photo is required.');
    if (hour && last.hour && hour <= last.hour && !note) throw new Error('Hour meter is not higher than the last reading (' + last.hour + '): please add a note.');
  }

  let latLong = '';
  if (!editingId) {
    const lat = Number(p.lat), lng = Number(p.lng);
    if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) throw new Error('GPS location is required. Turn on location and try again.');
    latLong = lat.toFixed(6) + ', ' + lng.toFixed(6);
  }

  return { type: type.name, meter: meter, meterRequired: type.required, plate: plate, driver: driver,
           km: km, hour: hour, litres: litres, note: note, latLong: latLong };
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
  return { plates: plates, drivers: drivers };
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
