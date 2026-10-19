/**
 * Protection Fee — ระบบบันทึกการใช้รถคุ้มครอง
 * Google Apps Script web app ที่ใช้ Google Sheet เป็นฐานข้อมูล
 */

const CONFIG = {
  // ID ของ Google Sheet — เว้นว่างได้ถ้าตั้ง Script Property "SPREADSHEET_ID" หรือสร้างสคริปต์จากเมนู Extensions ของชีท
  SPREADSHEET_ID: '1GZimBywY01PTFBtHd_Is5J4G-ZXguTrgIeH8U8_vC_E',
  // ชื่อแท็บของแต่ละตาราง — เว้นว่าง = ค้นหาอัตโนมัติจากหัวตาราง
  SHEETS: { locations: '', exat: '', bem: '' },
  USERS_SHEET: 'Users',
  AUDIT_SHEET: 'AuditLog',
  TIMEZONE: 'Asia/Bangkok',
  SESSION_SECONDS: 6 * 60 * 60, // สูงสุดของ CacheService
  HASH_ROUNDS: 300,
  MAX_LOGIN_FAILS: 5,
  LOCKOUT_SECONDS: 15 * 60,
  RECENT_ROWS: 15,
  HEADER_SCAN_ROWS: 20,
};

// หัวคอลัมน์ที่ใช้ระบุแต่ละตาราง
const TABLES = {
  locations: { label: 'DataBase Locations', required: ['ป้าย', 'Media Site', 'บริเวณ'] },
  exat: { label: 'รถคุ้มครอง EXAT', required: ['ลำดับ', 'วันที่', 'รถคุ้มครอง', 'ค่าอาหาร/รถคุ้มครอง'] },
  bem: { label: 'รถคุ้มครอง BEM', required: ['ลำดับ', 'วันที่', 'รถคุ้มครอง', 'การชำระเงิน'] },
};

const USER_HEADERS = ['username', 'passwordHash', 'salt', 'fullName', 'email', 'role', 'status', 'createdAt', 'lastLogin'];
const AUDIT_HEADERS = ['timestamp', 'username', 'action', 'sheet', 'row', 'detail'];
const ROLES = ['user', 'admin'];
const STATUSES = ['pending', 'active', 'disabled'];
const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const PROJECTS = ['Flyover 2.0 EXAT', 'Flyover 2.0 BEM', 'Gateway EXAT', 'Gateway BEM'];
const EXPRESSWAYS = ['เฉลิมมหานคร', 'ศรีรัช', 'ฉลองรัช', 'บูรพาวิถี', 'กาญจนาภิเษก', 'อุดรรัถยา'];
const BEM_FEES = ['คิดค่ารถ 1 คืน', 'BEM ไม่ได้คิดค่ารถ'];
const PAYMENT_STATUSES = ['รอออก PR', 'เรียบร้อย', 'ฟรี'];
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ------------------------------------------------------------------ */
/* Web app                                                             */
/* ------------------------------------------------------------------ */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Protection Fee')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ------------------------------------------------------------------ */
/* JSON API — ให้หน้าเว็บบน Vercel เรียกฟังก์ชันเดียวกับ google.script.run */
/* POST { fn: 'login', args: [ ... ] } → { ok: true, result } หรือ { ok: false, error } */
/* ------------------------------------------------------------------ */

const API_FUNCTIONS = {
  register, login, logout, changePassword, getAppData, addLogEntry, addLocation, listUsers, updateUser, resetPassword,
};

function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const fn = API_FUNCTIONS[req.fn];
    if (!fn || !Object.prototype.hasOwnProperty.call(API_FUNCTIONS, req.fn)) throw new Error('ไม่รู้จักคำสั่ง ' + req.fn);
    const result = fn.apply(null, Array.isArray(req.args) ? req.args : []);
    out = { ok: true, result: result === undefined ? null : result };
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------ */
/* สมัครสมาชิก / เข้าสู่ระบบ                                             */
/* ------------------------------------------------------------------ */

function register(form) {
  form = form || {};
  const username = cleanUsername_(form.username);
  const password = String(form.password || '');
  const fullName = String(form.fullName || '').trim();
  const email = String(form.email || '').trim();

  if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
    throw new Error('ชื่อผู้ใช้ต้องเป็น a-z, 0-9, . _ - ยาว 3–30 ตัวอักษร');
  }
  validatePassword_(password);
  if (!fullName) throw new Error('กรุณากรอกชื่อ-นามสกุล');
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('รูปแบบอีเมลไม่ถูกต้อง');

  return withLock_(() => {
    const sh = usersSheet_();
    const users = readUsers_(sh);
    if (users.some(u => u.username === username)) throw new Error('ชื่อผู้ใช้นี้ถูกใช้แล้ว');

    // ผู้สมัครคนแรกเป็นผู้ดูแลระบบ คนถัดไปต้องรออนุมัติ
    const isFirst = users.length === 0;
    const salt = Utilities.getUuid();
    const role = isFirst ? 'admin' : 'user';
    const status = isFirst ? 'active' : 'pending';
    sh.appendRow([username, hash_(password, salt), salt, text_(fullName), text_(email), role, status, new Date(), '']);
    audit_(username, 'register', CONFIG.USERS_SHEET, sh.getLastRow(), { role, status });

    return {
      status,
      message: isFirst
        ? 'สมัครสำเร็จ — คุณเป็นผู้ดูแลระบบคนแรก เข้าสู่ระบบได้เลย'
        : 'สมัครสำเร็จ — รอผู้ดูแลระบบอนุมัติก่อนเข้าใช้งาน',
    };
  });
}

function login(form) {
  form = form || {};
  const username = cleanUsername_(form.username);
  const password = String(form.password || '');
  const cache = CacheService.getScriptCache();
  const failKey = 'fail_' + username;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= CONFIG.MAX_LOGIN_FAILS) throw new Error('ใส่รหัสผ่านผิดหลายครั้ง กรุณารอ 15 นาทีแล้วลองใหม่');

  const sh = usersSheet_();
  const user = readUsers_(sh).find(u => u.username === username);
  if (!user || !verify_(password, user)) {
    cache.put(failKey, String(fails + 1), CONFIG.LOCKOUT_SECONDS);
    throw new Error('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  }
  cache.remove(failKey);
  if (user.status === 'pending') throw new Error('บัญชียังรอผู้ดูแลระบบอนุมัติ');
  if (user.status !== 'active') throw new Error('บัญชีถูกระงับ กรุณาติดต่อผู้ดูแลระบบ');

  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  cache.put('sess_' + token, username, CONFIG.SESSION_SECONDS);
  sh.getRange(user.row, USER_HEADERS.indexOf('lastLogin') + 1).setValue(new Date());
  return { token, user: publicUser_(user) };
}

function logout(token) {
  if (token) CacheService.getScriptCache().remove('sess_' + token);
  return true;
}

function changePassword(token, oldPassword, newPassword) {
  const user = requireUser_(token);
  if (!verify_(String(oldPassword || ''), user)) throw new Error('รหัสผ่านเดิมไม่ถูกต้อง');
  validatePassword_(String(newPassword || ''));
  setPassword_(user, String(newPassword));
  audit_(user.username, 'change_password', CONFIG.USERS_SHEET, user.row, {});
  return true;
}

/* ------------------------------------------------------------------ */
/* ข้อมูลสำหรับหน้าเว็บ                                                  */
/* ------------------------------------------------------------------ */

function getAppData(token) {
  const user = requireUser_(token);
  const locations = readLocations_();
  const exat = readLog_('exat');
  const bem = readLog_('bem');
  return {
    user: publicUser_(user),
    locations,
    options: {
      projects: PROJECTS,
      expressways: uniq_(EXPRESSWAYS.concat(locations.map(l => l.expressway))),
      places: uniq_(locations.map(l => l.area).concat(exat.places, bem.places)),
      jobTypes: uniq_(exat.jobTypes.concat(bem.jobTypes)),
      workers: uniq_(exat.workers.concat(bem.workers)),
      bemFees: uniq_(BEM_FEES.concat(bem.fees)),
      payments: uniq_(PAYMENT_STATUSES.concat(bem.payments)),
      mediaSites: uniq_(PROJECTS.concat(locations.map(l => l.mediaSite))),
    },
    recent: { exat: exat.recent, bem: bem.recent },
  };
}

/* ------------------------------------------------------------------ */
/* บันทึกการใช้รถคุ้มครอง (EXAT / BEM)                                   */
/* ------------------------------------------------------------------ */

function addLogEntry(token, key, form) {
  if (key !== 'exat' && key !== 'bem') throw new Error('ประเภทตารางไม่ถูกต้อง');
  const user = requireUser_(token);
  form = form || {};
  const date = parseDate_(form.date);
  const labels = { expressway: 'สายทาง', project: 'โครงการ', place: 'สถานที่', jobType: 'ประเภทงาน', worker: 'ผู้เข้างาน' };
  Object.keys(labels).forEach(k => {
    if (!String(form[k] || '').trim()) throw new Error('กรุณากรอก' + labels[k]);
  });
  let fee = 0;
  if (key === 'exat') {
    fee = Number(form.fee);
    if (!isFinite(fee) || fee < 0) throw new Error('ค่าอาหาร/รถคุ้มครองต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป');
  }

  return withLock_(() => {
    const t = findTable_(key);
    const sh = t.sheet;
    const c = name => colIndex_(t.headers, name);
    const last = lastLogRow_(t);
    const target = last + 1;
    const prev = last > t.headerRow ? sh.getRange(last, 1, 1, t.width).getValues()[0] : null;
    if (prev) sh.getRange(last, 1, 1, t.width).copyTo(sh.getRange(target, 1, 1, t.width), { formatOnly: true });

    const set = (name, value) => {
      const i = c(name);
      if (i >= 0) sh.getRange(target, i + 1).setValue(value);
    };

    // บางแถวมีเลขลำดับเตรียมไว้ล่วงหน้า — ใช้เลขเดิมถ้ามี
    const noIdx = c('ลำดับ');
    let no = sh.getRange(target, noIdx + 1).getValue();
    if (no === '' || no === null) {
      const p = prev ? Number(prev[noIdx]) : 0;
      no = (isFinite(p) ? p : 0) + 1;
      set('ลำดับ', no);
    }
    set('เดือน', monthValue_(date, prev ? prev[c('เดือน')] : ''));
    set('วันที่', dateValue_(date, prev ? prev[c('วันที่')] : ''));
    set('รถคุ้มครอง', key === 'exat' ? 'EXAT' : 'BEM');
    set('สายทาง', text_(form.expressway));
    set('โครงการ', text_(form.project));
    set('สถานที่', text_(form.place));
    set('ประเภทงาน', text_(form.jobType));
    set('ผู้เข้างาน', text_(form.worker));
    if (key === 'exat') {
      set('ค่าอาหาร/รถคุ้มครอง', fee);
    } else {
      set('ค่ารถคุ้มครอง', text_(form.feeText));
      set('การชำระเงิน', text_(form.payment));
    }

    audit_(user.username, 'add_' + key, sh.getName(), target, { no, date: form.date, place: form.place });
    SpreadsheetApp.flush();
    return { row: target, no, recent: readLog_(key).recent };
  });
}

/* ------------------------------------------------------------------ */
/* สถานที่ (DataBase Locations)                                          */
/* ------------------------------------------------------------------ */

const LOCATION_FIELDS = [
  ['pack', 'Pack', 0],
  ['code', 'ป้าย', 0],
  ['mediaSite', 'Media Site', 0],
  ['area', 'บริเวณ', 0],
  ['operator', 'เขตพื้นที่', 0],
  ['expressway', 'เขตพื้นที่', 1],
  ['size', 'Size.', 0],
  ['count', 'จำนวนป้าย', 0],
  ['road', 'ถนน', 0],
  ['district', 'เขตพื้นที่ กทม.', 0],
  ['meetingPoint', 'จุดนัดพบ', 0],
  ['police', 'อยู่ในพื้นที่ สน.', 0],
];

function addLocation(token, form) {
  const user = requireUser_(token, true);
  form = form || {};
  if (!String(form.code || '').trim()) throw new Error('กรุณากรอกรหัสป้าย');
  if (!String(form.area || '').trim()) throw new Error('กรุณากรอกบริเวณ');

  return withLock_(() => {
    const t = findTable_('locations');
    const sh = t.sheet;
    const existing = readLocations_();
    if (existing.some(l => l.code === String(form.code).trim())) throw new Error('มีรหัสป้ายนี้แล้ว');

    const last = lastLocationRow_(t);
    let target = last + 1;
    const below = sh.getRange(target, 1, 1, t.width).getDisplayValues()[0];
    if (below.some(v => v !== '')) {
      // มีข้อมูลอื่น (เช่นคำอธิบาย) อยู่ใต้ตาราง — แทรกแถวใหม่แทนการเขียนทับ
      sh.insertRowAfter(last);
    }
    if (last > t.headerRow) sh.getRange(last, 1, 1, t.width).copyTo(sh.getRange(target, 1, 1, t.width), { formatOnly: true });

    LOCATION_FIELDS.forEach(([field, header, nth]) => {
      const i = colIndex_(t.headers, header, nth);
      if (i < 0 || form[field] === undefined || form[field] === '') return;
      const value = field === 'count' && isFinite(Number(form[field])) ? Number(form[field]) : text_(form[field]);
      sh.getRange(target, i + 1).setValue(value);
    });

    audit_(user.username, 'add_location', sh.getName(), target, { code: form.code, area: form.area });
    SpreadsheetApp.flush();
    return { row: target, locations: readLocations_() };
  });
}

/* ------------------------------------------------------------------ */
/* จัดการผู้ใช้ (admin)                                                  */
/* ------------------------------------------------------------------ */

function listUsers(token) {
  requireUser_(token, true);
  return readUsers_(usersSheet_()).map(u => Object.assign(publicUser_(u), {
    email: u.email,
    status: u.status,
    createdAt: formatDateTime_(u.createdAt),
    lastLogin: formatDateTime_(u.lastLogin),
  }));
}

function updateUser(token, username, changes) {
  const admin = requireUser_(token, true);
  changes = changes || {};
  username = cleanUsername_(username);
  if (username === admin.username) throw new Error('ไม่สามารถเปลี่ยนสิทธิ์หรือสถานะของตัวเองได้');

  return withLock_(() => {
    const sh = usersSheet_();
    const user = readUsers_(sh).find(u => u.username === username);
    if (!user) throw new Error('ไม่พบผู้ใช้');
    if (changes.role !== undefined) {
      if (ROLES.indexOf(changes.role) < 0) throw new Error('สิทธิ์ไม่ถูกต้อง');
      sh.getRange(user.row, USER_HEADERS.indexOf('role') + 1).setValue(changes.role);
    }
    if (changes.status !== undefined) {
      if (STATUSES.indexOf(changes.status) < 0) throw new Error('สถานะไม่ถูกต้อง');
      sh.getRange(user.row, USER_HEADERS.indexOf('status') + 1).setValue(changes.status);
    }
    audit_(admin.username, 'update_user', CONFIG.USERS_SHEET, user.row, { username, changes });
    return true;
  });
}

function resetPassword(token, username) {
  const admin = requireUser_(token, true);
  username = cleanUsername_(username);
  return withLock_(() => {
    const user = readUsers_(usersSheet_()).find(u => u.username === username);
    if (!user) throw new Error('ไม่พบผู้ใช้');
    const temp = randomPassword_();
    setPassword_(user, temp);
    audit_(admin.username, 'reset_password', CONFIG.USERS_SHEET, user.row, { username });
    return temp;
  });
}

/* ------------------------------------------------------------------ */
/* Helpers — ผู้ใช้ / session                                            */
/* ------------------------------------------------------------------ */

function requireUser_(token, adminOnly) {
  const cache = CacheService.getScriptCache();
  const username = token ? cache.get('sess_' + token) : null;
  if (!username) throw new Error('SESSION_EXPIRED: กรุณาเข้าสู่ระบบใหม่');
  const user = readUsers_(usersSheet_()).find(u => u.username === username);
  if (!user || user.status !== 'active') throw new Error('SESSION_EXPIRED: บัญชีนี้ใช้งานไม่ได้แล้ว');
  if (adminOnly && user.role !== 'admin') throw new Error('เฉพาะผู้ดูแลระบบเท่านั้น');
  cache.put('sess_' + token, username, CONFIG.SESSION_SECONDS);
  return user;
}

function usersSheet_() {
  const ss = spreadsheet_();
  let sh = ss.getSheetByName(CONFIG.USERS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.USERS_SHEET);
    sh.getRange(1, 1, 1, USER_HEADERS.length).setValues([USER_HEADERS]);
    sh.getRange('A:E').setNumberFormat('@');
    sh.setFrozenRows(1);
  }
  return sh;
}

function readUsers_(sh) {
  const values = sh.getDataRange().getValues();
  const users = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (!r[0]) continue;
    const u = { row: i + 1 };
    USER_HEADERS.forEach((h, j) => { u[h] = r[j]; });
    u.username = String(u.username).trim().toLowerCase();
    users.push(u);
  }
  return users;
}

function publicUser_(u) {
  return { username: u.username, fullName: String(u.fullName || ''), role: u.role };
}

function setPassword_(user, password) {
  const sh = usersSheet_();
  const salt = Utilities.getUuid();
  sh.getRange(user.row, USER_HEADERS.indexOf('passwordHash') + 1, 1, 2).setValues([[hash_(password, salt), salt]]);
}

function hash_(password, salt, rounds) {
  rounds = rounds || CONFIG.HASH_ROUNDS;
  let digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + password, Utilities.Charset.UTF_8);
  for (let i = 1; i < rounds; i++) {
    digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, digest);
  }
  return rounds + '$' + Utilities.base64Encode(digest);
}

function verify_(password, user) {
  const stored = String(user.passwordHash || '');
  const rounds = Number(stored.split('$')[0]);
  if (!rounds) return false;
  return hash_(password, String(user.salt), rounds) === stored;
}

function validatePassword_(password) {
  if (password.length < 8) throw new Error('รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร');
}

function randomPassword_() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid());
  let out = '';
  for (let i = 0; i < 10; i++) out += chars[(bytes[i] + 128) % chars.length];
  return out;
}

function cleanUsername_(v) {
  return String(v || '').trim().toLowerCase();
}

/* ------------------------------------------------------------------ */
/* Helpers — ตารางใน Google Sheet                                        */
/* ------------------------------------------------------------------ */

let spreadsheetCache_ = null;
const tableCache_ = {};

function spreadsheet_() {
  if (spreadsheetCache_) return spreadsheetCache_;
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || CONFIG.SPREADSHEET_ID;
  const ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('ยังไม่ได้ตั้งค่า SPREADSHEET_ID');
  spreadsheetCache_ = ss;
  return ss;
}

/** หาแท็บและแถวหัวตาราง จากชื่อแท็บใน CONFIG หรือจากหัวคอลัมน์ที่ต้องมี */
function findTable_(key) {
  if (tableCache_[key]) return tableCache_[key];
  const ss = spreadsheet_();
  const def = TABLES[key];
  const name = CONFIG.SHEETS[key];
  const sheets = name ? [ss.getSheetByName(name)] : ss.getSheets();
  const required = def.required.map(norm_);

  for (const sh of sheets) {
    if (!sh) continue;
    const lastRow = sh.getLastRow();
    const lastCol = sh.getLastColumn();
    if (!lastRow || !lastCol) continue;
    const rows = sh.getRange(1, 1, Math.min(CONFIG.HEADER_SCAN_ROWS, lastRow), lastCol).getDisplayValues();
    for (let r = 0; r < rows.length; r++) {
      const normalized = rows[r].map(norm_);
      if (required.every(h => normalized.indexOf(h) >= 0)) {
        let width = rows[r].length;
        while (width > 0 && !String(rows[r][width - 1]).trim()) width--;
        const raw = rows[r].slice(0, width).map(h => String(h).trim());
        tableCache_[key] = { sheet: sh, headerRow: r + 1, headers: raw.map(norm_), rawHeaders: raw, width };
        return tableCache_[key];
      }
    }
  }
  throw new Error('ไม่พบตาราง "' + def.label + '" ในชีท — ตรวจหัวคอลัมน์ หรือกำหนดชื่อแท็บใน CONFIG.SHEETS');
}

function colIndex_(headers, name, nth) {
  const target = norm_(name);
  let seen = 0;
  for (let i = 0; i < headers.length; i++) {
    if (headers[i] === target) {
      if (seen === (nth || 0)) return i;
      seen++;
    }
  }
  return -1;
}

function norm_(s) {
  return String(s === null || s === undefined ? '' : s).replace(/\s+/g, '').toLowerCase();
}

/** แถวสุดท้ายที่มีวันที่ (แถวที่มีแค่เลขลำดับเตรียมไว้ไม่นับ) */
function lastLogRow_(t) {
  const lastRow = t.sheet.getLastRow();
  const start = t.headerRow + 1;
  if (lastRow < start) return t.headerRow;
  const col = colIndex_(t.headers, 'วันที่') + 1;
  const values = t.sheet.getRange(start, col, lastRow - start + 1, 1).getValues();
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i][0] !== '' && values[i][0] !== null) return start + i;
  }
  return t.headerRow;
}

function readLog_(key) {
  const t = findTable_(key);
  const out = {
    places: [], jobTypes: [], workers: [], fees: [], payments: [],
    recent: { headers: t.rawHeaders, rows: [], summary: { month: '', count: 0, amount: 0, unpaid: 0 } },
  };
  const last = lastLogRow_(t);
  if (last <= t.headerRow) return out;
  const values = t.sheet.getRange(t.headerRow + 1, 1, last - t.headerRow, t.width).getDisplayValues();
  const tail = values.slice(-300);
  const pick = name => {
    const i = colIndex_(t.headers, name);
    return i < 0 ? [] : tail.map(r => r[i]);
  };
  out.places = pick('สถานที่');
  out.jobTypes = pick('ประเภทงาน');
  out.workers = pick('ผู้เข้างาน');
  out.fees = pick('ค่ารถคุ้มครอง');
  out.payments = pick('การชำระเงิน');
  out.recent.rows = values.slice(-CONFIG.RECENT_ROWS).reverse();

  // สรุปเดือนล่าสุด: จำนวนครั้ง, ยอดเงิน (EXAT), รายการที่ยังไม่ชำระ (BEM)
  const mi = colIndex_(t.headers, 'เดือน');
  const fi = colIndex_(t.headers, 'ค่าอาหาร/รถคุ้มครอง');
  const pi = colIndex_(t.headers, 'การชำระเงิน');
  if (mi >= 0) {
    const month = values[values.length - 1][mi];
    const rows = values.filter(r => r[mi] === month);
    out.recent.summary = {
      month,
      count: rows.length,
      amount: fi < 0 ? 0 : rows.reduce((s, r) => s + (Number(String(r[fi]).replace(/[^\d.-]/g, '')) || 0), 0),
      unpaid: pi < 0 ? 0 : rows.filter(r => /^\s*รอ/.test(String(r[pi]))).length, // เช่น รอออก PR
    };
  }
  return out;
}

function isLocationRow_(r, ci) {
  const area = String(r[ci.area] || '').trim();
  const code = ci.code >= 0 ? String(r[ci.code] || '').trim() : '';
  const size = ci.size >= 0 ? String(r[ci.size] || '').trim() : '';
  return !!area && !!(code || size);
}

function locationColumns_(t) {
  const ci = {};
  LOCATION_FIELDS.forEach(([field, header, nth]) => { ci[field] = colIndex_(t.headers, header, nth); });
  return ci;
}

function lastLocationRow_(t) {
  const lastRow = t.sheet.getLastRow();
  if (lastRow <= t.headerRow) return t.headerRow;
  const ci = locationColumns_(t);
  const values = t.sheet.getRange(t.headerRow + 1, 1, lastRow - t.headerRow, t.width).getDisplayValues();
  for (let i = values.length - 1; i >= 0; i--) {
    if (isLocationRow_(values[i], ci)) return t.headerRow + 1 + i;
  }
  return t.headerRow;
}

function readLocations_() {
  const t = findTable_('locations');
  const lastRow = t.sheet.getLastRow();
  if (lastRow <= t.headerRow) return [];
  const ci = locationColumns_(t);
  const values = t.sheet.getRange(t.headerRow + 1, 1, lastRow - t.headerRow, t.width).getDisplayValues();
  const list = [];
  let pack = '';
  values.forEach(r => {
    if (!isLocationRow_(r, ci)) return;
    const loc = {};
    LOCATION_FIELDS.forEach(([field]) => { loc[field] = ci[field] >= 0 ? String(r[ci[field]]).trim() : ''; });
    // Pack มักเป็น merged cell — ใช้ค่าล่าสุดที่เจอ
    if (loc.pack) pack = loc.pack; else loc.pack = pack;
    list.push(loc);
  });
  return list;
}

/* ------------------------------------------------------------------ */
/* Helpers — ทั่วไป                                                      */
/* ------------------------------------------------------------------ */

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function audit_(username, action, sheetName, row, detail) {
  const ss = spreadsheet_();
  let sh = ss.getSheetByName(CONFIG.AUDIT_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.AUDIT_SHEET);
    sh.getRange(1, 1, 1, AUDIT_HEADERS.length).setValues([AUDIT_HEADERS]);
    sh.setFrozenRows(1);
  }
  sh.appendRow([new Date(), username, action, sheetName, row, JSON.stringify(detail || {})]);
}

/** ข้อความจากผู้ใช้ — ตัดช่องว่าง จำกัดความยาว และกันไม่ให้กลายเป็นสูตร */
function text_(v) {
  let s = String(v === null || v === undefined ? '' : v).trim().slice(0, 500);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

function uniq_(arr) {
  const seen = {};
  const out = [];
  arr.forEach(v => {
    const s = String(v || '').trim();
    if (s && !seen[s]) { seen[s] = true; out.push(s); }
  });
  return out;
}

function parseDate_(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) throw new Error('กรุณาเลือกวันที่');
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getMonth() !== Number(m[2]) - 1) throw new Error('วันที่ไม่ถูกต้อง');
  return d;
}

/** เดือน — ถ้าแถวก่อนหน้าเป็นข้อความ (เช่น "พ.ค.-22", "Sep-26") เขียนเป็นข้อความแบบเดียวกัน ไม่งั้นเขียนเป็นวันที่ */
function monthValue_(date, prev) {
  if (typeof prev === 'string' && prev !== '') {
    const sep = /\s/.test(prev.trim()) && prev.indexOf('-') < 0 ? ' ' : '-';
    return monthNameLike_(prev, date) + sep + yearLike_(prev, date);
  }
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/** วันที่ — ถ้าแถวก่อนหน้าเป็นข้อความ (เช่น "5 พ.ค. 22") เขียนเป็นข้อความแบบเดียวกัน ไม่งั้นเขียนเป็นวันที่ */
function dateValue_(date, prev) {
  if (typeof prev === 'string' && prev !== '') {
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(prev.trim())) return date.getDate() + '/' + (date.getMonth() + 1) + '/' + yearLike_(prev, date);
    return date.getDate() + ' ' + monthNameLike_(prev, date) + ' ' + yearLike_(prev, date);
  }
  return date;
}

/** ปีแบบเดียวกับข้อความเดิม — "22" ค.ศ. 2 หลัก, "69" พ.ศ. 2 หลัก, "2569" พ.ศ. 4 หลัก */
function yearLike_(prev, date) {
  const m = /(\d{2,4})\s*$/.exec(prev);
  const digits = m ? m[1] : '';
  const be = digits.length === 4 ? Number(digits) > 2400 : digits.length === 2 && Number(digits) >= 40;
  const year = date.getFullYear() + (be ? 543 : 0);
  return digits.length === 4 ? String(year) : String(year % 100).padStart(2, '0');
}

function monthNameLike_(prev, date) {
  return /[ก-๙]/.test(prev) ? THAI_MONTHS[date.getMonth()] : EN_MONTHS[date.getMonth()];
}

function formatDateTime_(v) {
  if (!(v instanceof Date)) return String(v || '');
  return Utilities.formatDate(v, CONFIG.TIMEZONE, 'dd/MM/yyyy HH:mm');
}
