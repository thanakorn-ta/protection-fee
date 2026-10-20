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
  register, login, logout, changePassword, getAppData, addLogEntry, addLogEntries, getDashboard, recalcCosts, listBookings, saveBooking, reviewBooking, cancelBooking, logBooking,
  addLocation, listUsers, updateUser, resetPassword,
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
    recent: { exat: recentFor_(exat.recent, user), bem: recentFor_(bem.recent, user) },
    rates: readRates_().map(r => ({ provider: r.provider, expressways: r.expressways, rate: r.rate, every: r.every, food: r.food, from: r.from })),
    bookingPending: user.role === 'admin' ? readBookings_(bookingsSheet_(false)).filter(b => b.status === 'pending').length : 0,
  };
}

/* ------------------------------------------------------------------ */
/* บันทึกการใช้รถคุ้มครอง (EXAT / BEM)                                   */
/* ------------------------------------------------------------------ */

function addLogEntry(token, key, form) {
  checkLogKey_(key);
  const user = requireUser_(token);
  const f = validateLogForm_(key, form);
  const r = addLogRow_(user, key, f);
  afterLogSaved_(key, [String(f.date)]);
  return { row: r.row, no: r.no, recent: recentFor_(readLog_(key).recent, user) };
}

/**
 * บันทึกหลายจุดในวันเดียวกันพร้อมกัน — common = วันที่/ผู้เข้างาน/ประเภทงาน, places = [{ place, expressway, project, fee | feeText, payment }]
 * ตรวจครบทุกจุดก่อนเขียน เพื่อไม่ให้บันทึกไปแค่บางจุดเพราะข้อมูลผิด
 */
function addLogEntries(token, key, common, places) {
  checkLogKey_(key);
  const user = requireUser_(token);
  if (!Array.isArray(places) || !places.length) throw new Error('กรุณาเลือกสถานที่อย่างน้อย 1 จุด');
  if (places.length > 30) throw new Error('บันทึกได้ครั้งละไม่เกิน 30 จุด');
  const forms = places.map((p, i) => {
    try {
      return validateLogForm_(key, Object.assign({}, common || {}, p || {}));
    } catch (err) {
      throw new Error('จุดที่ ' + (i + 1) + ': ' + err.message);
    }
  });
  const saved = forms.map(f => addLogRow_(user, key, f));
  afterLogSaved_(key, uniq_(forms.map(f => String(f.date))));
  return { saved, recent: recentFor_(readLog_(key).recent, user) };
}

/** รายการล่าสุดในตาราง — ผู้ดูแลระบบเห็นทุกแถว ผู้ใช้ทั่วไปได้แค่ยอดสรุปเดือนล่าสุดและหัวตาราง */
function recentFor_(recent, user) {
  if (user.role === 'admin') return recent;
  return { headers: recent.headers, rows: [], summary: recent.summary };
}

function checkLogKey_(key) {
  if (key !== 'exat' && key !== 'bem') throw new Error('ประเภทตารางไม่ถูกต้อง');
}

function validateLogForm_(key, form) {
  form = form || {};
  const date = parseDate_(form.date);
  const labels = { worker: 'ผู้เข้างาน', place: 'สถานที่', expressway: 'สายทาง', project: 'โครงการ', jobType: 'ประเภทงาน' };
  Object.keys(labels).forEach(k => {
    if (!String(form[k] || '').trim()) throw new Error('กรุณากรอก' + labels[k]);
  });
  let fee = 0;
  if (key === 'exat') {
    fee = Number(form.fee);
    if (form.fee === '' || form.fee === null || form.fee === undefined || !isFinite(fee) || fee < 0) {
      throw new Error('ค่าอาหาร/รถคุ้มครองต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป');
    }
  }
  return Object.assign({}, form, { dateObj: date, feeNum: fee });
}

/** เขียน 1 แถวต่อจากแถวล่าสุดที่มีวันที่ (form ผ่าน validateLogForm_ แล้ว) */
function addLogRow_(user, key, form) {
  const date = form.dateObj;
  const fee = form.feeNum;
  return withLock_(() => {
    const t = findTable_(key);
    const sh = t.sheet;
    const c = name => colIndex_(t.headers, name);
    const last = lastLogRow_(t);
    const target = last + 1;
    const prev = last > t.headerRow ? sh.getRange(last, 1, 1, t.width).getValues()[0] : null;
    if (prev) sh.getRange(last, 1, 1, t.width).copyTo(sh.getRange(target, 1, 1, t.width), { formatOnly: true });

    // เตรียมค่าทุกคอลัมน์ก่อน แล้วค่อยเขียน — ถ้าเขียนไม่สำเร็จจะล้างแถวคืน ไม่ให้เหลือแถวครึ่ง ๆ กลาง ๆ
    const values = [];
    const put = (name, value) => {
      const i = c(name);
      if (i >= 0) values.push([i + 1, value]);
    };

    // บางแถวมีเลขลำดับเตรียมไว้ล่วงหน้า — ใช้เลขเดิมถ้ามี
    const noIdx = c('ลำดับ');
    let no = sh.getRange(target, noIdx + 1).getValue();
    if (no === '' || no === null) {
      const p = prev ? Number(prev[noIdx]) : 0;
      no = (isFinite(p) ? p : 0) + 1;
      put('ลำดับ', no);
    }
    put('เดือน', monthValue_(date, prev ? prev[c('เดือน')] : ''));
    put('วันที่', dateValue_(date, prev ? prev[c('วันที่')] : ''));
    put('รถคุ้มครอง', key === 'exat' ? 'EXAT' : 'BEM');
    put('สายทาง', text_(form.expressway));
    put('โครงการ', text_(form.project));
    put('สถานที่', text_(form.place));
    put('ประเภทงาน', text_(form.jobType));
    put('ผู้เข้างาน', text_(form.worker));
    if (key === 'exat') {
      put('ค่าอาหาร/รถคุ้มครอง', fee);
    } else {
      put('ค่ารถคุ้มครอง', text_(form.feeText));
      put('การชำระเงิน', text_(form.payment));
    }

    const warnings = [];
    const written = [];
    try {
      values.forEach(([col, value]) => {
        written.push(col);
        writeCellValidated_(sh.getRange(target, col), value, t.rawHeaders[col - 1] || '', warnings);
      });
    } catch (err) {
      written.forEach(col => sh.getRange(target, col).clearContent());
      SpreadsheetApp.flush();
      throw new Error('บันทึกไม่สำเร็จ (ยังไม่ได้เขียนลงชีท): ' + err.message);
    }

    audit_(user.username, 'add_' + key, sh.getName(), target, { no, date: form.date, place: form.place, warnings });
    SpreadsheetApp.flush();
    return { row: target, no, place: String(form.place), warnings };
  });
}

/**
 * เขียนค่าลงเซลล์ให้ผ่านกฎตรวจสอบข้อมูล (data validation) ของชีท
 * - ค่าที่ต่างจากรายการแค่ช่องว่าง/ขึ้นบรรทัด → ใช้ค่าตามรายการในชีท
 * - ค่าที่ไม่มีในรายการจริง ๆ (เช่น BEM สายทางที่ไม่ใช่ ศรีรัช) → ยังบันทึก แต่เปลี่ยนกฎของเซลล์นั้นเป็น "แสดงคำเตือน"
 */
function writeCellValidated_(cell, value, header, warnings) {
  const rule = cell.getDataValidation();
  if (rule && typeof value === 'string' && value !== '') {
    const allowed = validationList_(rule);
    if (allowed) {
      const key = norm_(value);
      const hit = allowed.find(a => norm_(a) === key);
      if (hit !== undefined) {
        value = hit;
      } else if (!rule.getAllowInvalid()) {
        cell.setDataValidation(rule.copy().setAllowInvalid(true).build());
        warnings.push(header + ' “' + value + '” ไม่อยู่ในรายการของชีท');
      }
    }
  }
  try {
    cell.setValue(value);
  } catch (err) {
    if (!rule || rule.getAllowInvalid()) throw err;
    cell.setDataValidation(rule.copy().setAllowInvalid(true).build());
    warnings.push(header + ' ไม่ผ่านกฎตรวจสอบของชีท');
    cell.setValue(value);
  }
}

/** รายการค่าที่กฎอนุญาต (dropdown จากรายการหรือจากช่วงเซลล์) — กฎแบบอื่นคืน null */
function validationList_(rule) {
  const type = rule.getCriteriaType();
  const vals = rule.getCriteriaValues() || [];
  const C = SpreadsheetApp.DataValidationCriteria;
  if (type === C.VALUE_IN_LIST) return (vals[0] || []).map(String);
  if (type === C.VALUE_IN_RANGE && vals[0] && vals[0].getDisplayValues) {
    return [].concat.apply([], vals[0].getDisplayValues()).map(String).filter(s => s !== '');
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* แดชบอร์ดสรุปรายปี                                                     */
/* ------------------------------------------------------------------ */

const DASH_CACHE_KEY = 'dash_v3';

/* ------------------------------------------------------------------ */
/* ค่าใช้จ่ายตามอัตรา                                                     */
/* EXAT: จุดละ 3,000 หักค่าอาหาร 400 จากจุดแรกของคืน (4 จุด = 11,600)        */
/* BEM : 2,000 ต่อคืน ใช้ต่อได้สูงสุด 5 จุด (จุดที่ 6 เริ่มคิดใหม่)              */
/* อัตราแก้ได้ในแท็บ "อัตราค่ารถคุ้มครอง"                                      */
/* ------------------------------------------------------------------ */

const RATE_SHEET = 'อัตราค่ารถคุ้มครอง';
const RATE_HEADERS = ['รถคุ้มครอง', 'สายทาง (คั่นด้วย ,)', 'ค่ารถ (บาท)', 'คิดค่ารถทุกกี่จุด', 'หักค่าอาหารจุดแรก (บาท)', 'ใช้ตั้งแต่วันที่ (ว่าง = ทุกวัน)', 'หมายเหตุ'];
const RATE_DEFAULTS = [
  ['EXAT', 'เฉลิมมหานคร, ฉลองรัช, ศรีรัช', 3000, 1, 400, '', 'จุดละ 3,000 บาท หักค่าอาหาร 400 จากจุดแรกของคืน — เช่น 4 จุด = 2,600 + 3,000 + 3,000 + 3,000 = 11,600 บาท'],
  ['BEM', 'ศรีรัช', 2000, 5, 0, '', '2,000 บาท/คืน ไม่มีค่าอาหาร ใช้ต่อได้สูงสุด 5 จุด (จุดที่ 2–5 = 0) จุดที่ 6 เริ่มคิดใหม่'],
];
const COST_HEADER = 'ค่าใช้จ่ายตามอัตรา (บาท)';
const SUMMARY_SHEET = 'สรุปค่าใช้จ่ายรายเดือน';

function ratesSheet_() {
  const ss = spreadsheet_();
  let sh = ss.getSheetByName(RATE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(RATE_SHEET);
    sh.getRange(1, 1, 1, RATE_HEADERS.length).setValues([RATE_HEADERS]).setFontWeight('bold');
    sh.getRange(2, 1, RATE_DEFAULTS.length, RATE_HEADERS.length).setValues(RATE_DEFAULTS);
    sh.setFrozenRows(1);
  }
  return sh;
}

/** อัตราทั้งหมด เรียงจากที่ใช้ตั้งแต่วันที่ล่าสุดก่อน */
function readRates_() {
  const values = ratesSheet_().getDataRange().getValues();
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    const provider = String(r[0] || '').trim().toUpperCase();
    if (provider !== 'EXAT' && provider !== 'BEM') continue;
    const from = r[5] instanceof Date ? Utilities.formatDate(r[5], sheetTz_(), 'yyyy-MM-dd') : dateIsoOf_('', r[5]);
    out.push({
      provider,
      expressways: String(r[1] || '').split(/[,\n]/).map(norm_).filter(Boolean),
      expresswayText: String(r[1] || '').trim(),
      rate: Number(r[2]) || 0,
      every: Math.max(1, Math.floor(Number(r[3]) || 1)),
      food: Number(r[4]) || 0,
      from: from || '',
    });
  }
  return out.sort((a, b) => (b.from || '').localeCompare(a.from || ''));
}

function ruleFor_(rates, provider, expressway, iso) {
  const e = norm_(expressway);
  return rates.find(r => r.provider === provider && r.expressways.indexOf(e) >= 0 && (!r.from || iso >= r.from)) || null;
}

/**
 * คิดค่าใช้จ่ายทีละจุด — rows เรียงตามลำดับในชีท [{ iso, expressway, fee, feeText, payment }]
 * 1 คืน = รถคุ้มครอง 1 คัน: เริ่มคืนใหม่เมื่อวันที่เปลี่ยน หรือเมื่อแถวนั้นเป็นจุดแรกของรถอีกคัน
 *   EXAT: กรอกค่าอาหาร (มากกว่า 0) = จุดแรกของรถคันนั้น
 *   BEM : "คิดค่ารถ ..." = จุดแรกของรถคันนั้น / "ไม่ได้คิดค่ารถ" หรือการชำระเงิน "ฟรี" = 0 บาท
 */
function computeCosts_(rates, provider, rows) {
  const counters = {};
  return rows.map(r => {
    if (!r.iso) return { cost: '', note: 'no-date' };
    const rule = ruleFor_(rates, provider, r.expressway, r.iso);
    if (!rule) return { cost: '', note: 'no-rate' };
    const feeText = String(r.feeText || '');
    if (provider === 'BEM' && (/ไม่ได้คิด/.test(feeText) || /ฟรี/.test(String(r.payment || '')))) {
      return { cost: 0, food: 0, note: 'free' };
    }
    const k = r.iso + '|' + rates.indexOf(rule);
    const startsVehicle = provider === 'EXAT' ? Number(r.fee) > 0 : /คิดค่ารถ/.test(feeText);
    if (startsVehicle) counters[k] = 0;
    const i = counters[k] = (counters[k] || 0) + 1;
    const charged = (i - 1) % rule.every === 0;
    let cost = charged ? rule.rate : 0;
    let food = 0;
    if (i === 1 && rule.food) { cost -= rule.food; food = rule.food; }
    return { cost, food, index: i, charged, night: i === 1 };
  });
}

/** อ่านแถวในตาราง EXAT / BEM พร้อมวันที่ (ISO) และเดือนที่ลงบัญชี */
function logRows_(key) {
  const t = findTable_(key);
  const last = lastLogRow_(t);
  if (last <= t.headerRow) return { t, rows: [] };
  // อ่านแค่ getValues (เร็วกว่า getDisplayValues ราวครึ่ง) — วันที่ได้เป็น Date ข้อความได้เป็น string อยู่แล้ว
  const raw = t.sheet.getRange(t.headerRow + 1, 1, last - t.headerRow, t.width).getValues();
  const c = name => colIndex_(t.headers, name);
  const ci = {
    month: c('เดือน'), date: c('วันที่'), project: c('โครงการ'), expressway: c('สายทาง'), place: c('สถานที่'),
    worker: c('ผู้เข้างาน'), fee: c('ค่าอาหาร/รถคุ้มครอง'), feeText: c('ค่ารถคุ้มครอง'), payment: c('การชำระเงิน'),
  };
  const str = v => (v instanceof Date ? Utilities.formatDate(v, sheetTz_(), 'd/M/yyyy') : String(v === null || v === undefined ? '' : v));
  const pick = (r, i) => (i >= 0 ? str(r[i]).trim() : '');
  const rows = raw.map(r => {
    const has = ci.date >= 0 && r[ci.date] !== '' && r[ci.date] !== null;
    return {
      has,
      iso: has ? dateIsoOf_(r[ci.date], str(r[ci.date])) : '',
      ym: has ? ((ci.month >= 0 && ymOf_(r[ci.month], str(r[ci.month]))) || ymOf_(r[ci.date], str(r[ci.date]))) : null,
      expressway: pick(r, ci.expressway), project: pick(r, ci.project), place: pick(r, ci.place), worker: pick(r, ci.worker),
      fee: ci.fee < 0 ? 0 : typeof r[ci.fee] === 'number' ? r[ci.fee] : Number(str(r[ci.fee]).replace(/[^\d.-]/g, '')) || 0,
      feeText: pick(r, ci.feeText), payment: pick(r, ci.payment),
    };
  });
  return { t, rows };
}

/** เพิ่มคอลัมน์ "ค่าใช้จ่ายตามอัตรา (บาท)" ต่อท้ายตาราง ถ้ายังไม่มี */
function ensureCostColumn_(key) {
  const t = findTable_(key);
  if (colIndex_(t.headers, COST_HEADER) >= 0) return t;
  const sh = t.sheet;
  const col = t.width + 1;
  if (sh.getMaxColumns() < col) sh.insertColumnAfter(sh.getMaxColumns());
  sh.getRange(t.headerRow, t.width).copyTo(sh.getRange(t.headerRow, col), { formatOnly: true });
  sh.getRange(t.headerRow, col).setValue(COST_HEADER);
  sh.setColumnWidth(col, 170);
  delete tableCache_[key];
  return findTable_(key);
}

/**
 * คำนวณค่าใช้จ่ายลงคอลัมน์ "ค่าใช้จ่ายตามอัตรา" และสร้างแท็บสรุปรายเดือนใหม่
 * onlyDates = { exat: ['2026-10-20'], bem: [] } → เขียนเฉพาะแถวของวันที่นั้น (หลังบันทึก — เร็วกว่าเขียนทั้งคอลัมน์)
 */
function recalcCosts_(onlyDates) {
  return withLock_(() => {
    const rates = readRates_();
    const result = {};
    const ctx = {};
    ['exat', 'bem'].forEach(key => {
      const t = ensureCostColumn_(key);
      const rows = logRows_(key).rows;
      const costs = computeCosts_(rates, key.toUpperCase(), rows);
      ctx[key] = { rows, costs };
      const col = colIndex_(t.headers, COST_HEADER) + 1;
      const value = i => (rows[i].has && costs[i].cost !== '' ? costs[i].cost : '');
      if (!onlyDates) {
        if (rows.length) {
          const range = t.sheet.getRange(t.headerRow + 1, col, rows.length, 1);
          range.setValues(costs.map((c, i) => [value(i)]));
          range.setNumberFormat('#,##0');
        }
      } else {
        const dates = onlyDates[key] || [];
        rows.forEach((r, i) => {
          if (r.iso && dates.indexOf(r.iso) >= 0) t.sheet.getRange(t.headerRow + 1 + i, col).setValue(value(i)).setNumberFormat('#,##0');
        });
      }
      result[key] = {
        rows: rows.filter(r => r.has).length,
        priced: costs.filter(c => c.cost !== '').length,
        noRate: costs.filter(c => c.note === 'no-rate').length,
        total: costs.reduce((s, c) => s + (Number(c.cost) || 0), 0),
      };
    });
    result.months = writeMonthlySummary_(ctx);
    CacheService.getScriptCache().remove(DASH_CACHE_KEY);
    SpreadsheetApp.flush();
    return result;
  });
}

/** สรุปค่าใช้จ่ายรายเดือน (ตามคอลัมน์ "เดือน") — ctx = { exat: { rows, costs }, bem: {...} } */
function monthlyCosts_(ctx) {
  const months = {};
  ['exat', 'bem'].forEach(key => {
    const rows = ctx[key].rows;
    const costs = ctx[key].costs;
    rows.forEach((r, i) => {
      if (!r.has || !r.ym) return;
      const k = r.ym.y + '-' + String(r.ym.m).padStart(2, '0');
      const m = months[k] || (months[k] = {
        ym: k,
        exat: { points: 0, nights: 0, charges: 0, cost: 0, food: 0, noRate: 0 },
        bem: { points: 0, nights: 0, charges: 0, cost: 0, food: 0, noRate: 0 },
      });
      const p = m[key];
      const c = costs[i];
      p.points++;
      if (c.cost === '') { p.noRate++; return; }
      p.cost += c.cost;
      p.food += c.food || 0;
      if (c.night) p.nights++;
      if (c.charged) p.charges++;
    });
  });
  return Object.keys(months).sort().map(k => months[k]);
}

function writeMonthlySummary_(ctx) {
  const list = monthlyCosts_(ctx);
  const ss = spreadsheet_();
  const sh = ss.getSheetByName(SUMMARY_SHEET) || ss.insertSheet(SUMMARY_SHEET);
  const head = ['เดือน', 'EXAT จุด', 'EXAT คืน', 'EXAT ค่าใช้จ่าย (บาท)', 'EXAT หักค่าอาหาร (บาท)',
    'BEM จุด', 'BEM คิดค่ารถ (ครั้ง)', 'BEM ค่าใช้จ่าย (บาท)', 'รวมค่าใช้จ่าย (บาท)', 'จุดที่ไม่มีอัตรา'];
  const body = list.map(m => {
    const [y, mo] = m.ym.split('-').map(Number);
    return [THAI_MONTHS[mo - 1] + ' ' + (y + 543),
      m.exat.points, m.exat.nights, m.exat.cost, m.exat.food,
      m.bem.points, m.bem.charges, m.bem.cost,
      m.exat.cost + m.bem.cost, m.exat.noRate + m.bem.noRate];
  });
  sh.clearContents();
  sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
  if (body.length) {
    sh.getRange(2, 1, body.length, head.length).setValues(body);
    sh.getRange(2, 2, body.length, head.length - 1).setNumberFormat('#,##0');
  }
  sh.getRange(body.length + 3, 1).setValue('สร้างอัตโนมัติจากแท็บ EXAT / BEM ตามแท็บ "' + RATE_SHEET + '" — อัปเดตล่าสุด ' + nowText_() + ' (ห้ามแก้ในแท็บนี้ ระบบจะเขียนทับ)');
  sh.setFrozenRows(1);
  return list.length;
}

/** หลังบันทึกการใช้รถ — คิดค่าใช้จ่ายใหม่ ถ้าล้มเหลวไม่ให้กระทบการบันทึก */
function afterLogSaved_(key, dates) {
  CacheService.getScriptCache().remove(DASH_CACHE_KEY);
  try {
    const only = { exat: [], bem: [] };
    only[key] = dates;
    recalcCosts_(only);
  } catch (err) {
    console.error('recalcCosts_ failed', err);
  }
}

/** ผู้ดูแลระบบสั่งคำนวณใหม่ทั้งหมด (เช่นหลังแก้อัตราในชีท) */
function recalcCosts(token) {
  requireUser_(token, true);
  return recalcCosts_();
}

/** กด Run ในหน้า Apps Script เพื่อคำนวณใหม่ทั้งหมด (ไม่ต้องเข้าสู่ระบบ) */
function recalcCostsNow() {
  const r = recalcCosts_();
  console.log(JSON.stringify(r));
  return r;
}

/** วันที่จากเซลล์ → "2026-10-21" — Date, "5 พ.ค. 22", "16/9/2026", "2026-09-16" */
function dateIsoOf_(raw, disp) {
  if (raw instanceof Date && !isNaN(raw.getTime())) return Utilities.formatDate(raw, sheetTz_(), 'yyyy-MM-dd');
  const s = String(disp || raw || '').trim();
  if (!s) return '';
  const iso = (y, m, d) => y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (m) { const ym = ym_(m[3], m[2]); return ym ? iso(ym.y, ym.m, Number(m[1])) : ''; }
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) { const ym = ym_(m[1], m[2]); return ym ? iso(ym.y, ym.m, Number(m[3])) : ''; }
  m = /^(\d{1,2})\s*(\D+?)\s*(\d{2,4})$/.exec(s);
  if (m) { const ym = ymOf_('', m[2] + ' ' + m[3]); return ym ? iso(ym.y, ym.m, Number(m[1])) : ''; }
  return '';
}

/* ------------------------------------------------------------------ */
/* แดชบอร์ดสรุปรายปี                                                     */
/* ------------------------------------------------------------------ */

/**
 * สรุปตาราง EXAT / BEM แยกปีและเดือน (ใช้คอลัมน์ "เดือน" = เดือนที่ลงบัญชี ถ้าว่างใช้ "วันที่")
 * cost = ค่าใช้จ่ายตามอัตรา, amount = ค่าอาหาร/รถคุ้มครองที่กรอกในชีท (EXAT)
 */
function getDashboard(token, fresh) {
  requireUser_(token);
  const cache = CacheService.getScriptCache();
  const hit = fresh ? null : cache.get(DASH_CACHE_KEY);
  if (hit) return JSON.parse(hit);

  const rates = readRates_();
  const byYear = {};
  const newPart = () => ({
    count: 0, amount: 0, nights: 0, pending: 0, cost: 0, food: 0, charges: 0, noRate: 0,
    months: Array.from({ length: 12 }, () => ({ count: 0, amount: 0, nights: 0, cost: 0, food: 0, charges: 0, pending: 0 })),
  });
  // แยกตามหมวด รายเดือน: dims[หมวด][ชื่อ] = { e: { เดือน: [จุด, บาท] }, b: {...} } — เก็บเฉพาะเดือนที่มีข้อมูล
  const newDims = () => ({ place: {}, project: {}, expressway: {}, worker: {} });
  const add = (dims, dim, name, side, m, cost) => {
    name = String(name || '').replace(/\s+/g, ' ').trim() || '(ไม่ระบุ)';
    const d = dims[dim][name] || (dims[dim][name] = {});
    const s = d[side] || (d[side] = {});
    const cell = s[m] || (s[m] = [0, 0]);
    cell[0]++;
    cell[1] += cost;
  };
  let unknown = 0;

  ['exat', 'bem'].forEach(key => {
    const rows = logRows_(key).rows;
    const costs = computeCosts_(rates, key.toUpperCase(), rows);
    const side = key === 'exat' ? 'e' : 'b';
    rows.forEach((r, i) => {
      if (!r.has) return;
      if (!r.ym) { unknown++; return; }
      const year = byYear[r.ym.y] || (byYear[r.ym.y] = { exat: newPart(), bem: newPart(), dims: newDims() });
      const part = year[key];
      const month = part.months[r.ym.m - 1];
      const c = costs[i];
      const cost = c.cost === '' ? 0 : c.cost;
      part.count++;
      month.count++;
      if (c.cost === '') part.noRate++;
      else {
        part.cost += cost;
        month.cost += cost;
        part.food += c.food || 0;
        month.food += c.food || 0;
        if (c.charged) { part.charges++; month.charges++; }
      }
      if (key === 'exat') {
        part.amount += r.fee;
        month.amount += r.fee;
      } else {
        if (/คิดค่ารถ/.test(r.feeText)) { part.nights++; month.nights++; }
        if (/^\s*รอ/.test(r.payment)) { part.pending++; month.pending++; }
      }
      add(year.dims, 'place', r.place, side, r.ym.m, cost);
      add(year.dims, 'project', r.project, side, r.ym.m, cost);
      add(year.dims, 'expressway', r.expressway, side, r.ym.m, cost);
      add(year.dims, 'worker', r.worker, side, r.ym.m, cost);
    });
  });

  const out = {
    updatedAt: Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'dd/MM/yyyy HH:mm'),
    years: Object.keys(byYear).map(Number).sort((a, b) => b - a),
    byYear,
    unknown,
    rates: rates.map(r => ({ provider: r.provider, expressways: r.expresswayText, rate: r.rate, every: r.every, food: r.food, from: r.from })),
  };
  const json = JSON.stringify(out);
  if (json.length < 95000) cache.put(DASH_CACHE_KEY, json, 300);
  return out;
}

/** เดือน/ปี จากเซลล์ — Date, "พ.ค.-22", "5 พ.ค. 22", "Sep-26", "16/9/2026" → { y: ค.ศ., m: 1–12 } */
function ymOf_(raw, disp) {
  if (raw instanceof Date && !isNaN(raw.getTime())) {
    return { y: Number(Utilities.formatDate(raw, sheetTz_(), 'yyyy')), m: Number(Utilities.formatDate(raw, sheetTz_(), 'M')) };
  }
  const s = String(disp || raw || '').trim();
  if (!s) return null;
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (m) return ym_(m[3], m[2]);
  m = /^(\d{4})-(\d{1,2})/.exec(s);
  if (m) return ym_(m[1], m[2]);
  const year = /(\d{2,4})\s*$/.exec(s);
  if (!year) return null;
  const flat = s.replace(/\./g, '');
  let mo = 0;
  THAI_MONTHS.forEach((t, i) => { if (!mo && flat.indexOf(t.replace(/\./g, '')) >= 0) mo = i + 1; });
  if (!mo) {
    const en = /([A-Za-z]{3})/.exec(s);
    if (en) mo = EN_MONTHS.findIndex(x => x.toLowerCase() === en[1].toLowerCase()) + 1;
  }
  return mo ? ym_(year[1], mo) : null;
}

/** ปี 2 หลัก: ต่ำกว่า 40 = ค.ศ. (22 → 2022) ไม่งั้น พ.ศ. (65 → 2022) / ปี 4 หลักที่เกิน 2400 = พ.ศ. */
function ym_(y, m) {
  y = Number(y);
  m = Number(m);
  if (y < 100) y += y >= 40 ? 2500 : 2000;
  if (y > 2400) y -= 543;
  return m >= 1 && m <= 12 ? { y, m } : null;
}

/* ------------------------------------------------------------------ */
/* ตารางจองรถคุ้มครอง (แท็บ Bookings) — ผู้จองส่งคำขอ ผู้ดูแลระบบอนุมัติ     */
/* ------------------------------------------------------------------ */

const BOOKING_SHEET = 'Bookings';
const BOOKING_HEADERS = [
  'id', 'title', 'date', 'time', 'mediaType', 'provider', 'expressway', 'meetingPoint', 'places', 'jobType', 'worker', 'note',
  'status', 'requestedBy', 'requestedByName', 'requestedAt', 'reviewedBy', 'reviewedByName', 'reviewedAt', 'reviewNote', 'updatedAt',
  'loggedRows', 'loggedAt', // แถวที่บันทึกลงตาราง EXAT / BEM แล้ว (กันบันทึกซ้ำ)
];
const BOOKING_FIELDS = ['title', 'date', 'time', 'mediaType', 'provider', 'expressway', 'meetingPoint', 'places', 'jobType', 'worker', 'note'];
const MEDIA_TYPES = ['Flyover 2.0', 'Gateway Billboard', 'Mainline'];

function bookingsSheet_(create) {
  const ss = spreadsheet_();
  let sh = ss.getSheetByName(BOOKING_SHEET);
  if (!sh && create !== false) {
    sh = ss.insertSheet(BOOKING_SHEET);
    sh.getRange(1, 1, 1, BOOKING_HEADERS.length).setValues([BOOKING_HEADERS]);
    sh.getRange(1, 1, sh.getMaxRows(), BOOKING_HEADERS.length).setNumberFormat('@'); // เก็บเป็นข้อความ ไม่ให้ชีทแปลงวันที่เอง
    sh.setFrozenRows(1);
  } else if (sh && sh.getLastColumn() < BOOKING_HEADERS.length) {
    // แท็บเดิมก่อนมีคอลัมน์ใหม่ — เขียนหัวตารางให้ครบ (ลำดับคอลัมน์เดิมไม่เปลี่ยน)
    sh.getRange(1, 1, 1, BOOKING_HEADERS.length).setValues([BOOKING_HEADERS]);
  }
  return sh;
}

function readBookings_(sh) {
  if (!sh || sh.getLastRow() < 2) return [];
  const values = sh.getDataRange().getDisplayValues();
  const head = values[0].map(h => String(h).trim());
  const idx = {};
  BOOKING_HEADERS.forEach(h => { idx[h] = head.indexOf(h); });
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (idx.id < 0 || !String(r[idx.id]).trim()) continue;
    const b = { row: i + 1 };
    BOOKING_HEADERS.forEach(h => { b[h] = idx[h] >= 0 ? String(r[idx[h]]) : ''; });
    out.push(b);
  }
  return out;
}

function writeBooking_(sh, row, b) {
  const range = sh.getRange(row, 1, 1, BOOKING_HEADERS.length);
  range.setNumberFormat('@');
  range.setValues([BOOKING_HEADERS.map(h => longText_(b[h]))]);
}

/** เหมือน text_ แต่ยาวได้ถึง 2,000 ตัวอักษร (รายละเอียด / จุดที่ไปหลายบรรทัด) */
function longText_(v) {
  let s = String(v === null || v === undefined ? '' : v).trim().slice(0, 2000);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

function canEditBooking_(b, user) {
  if (b.status === 'cancelled') return false;
  if (user.role === 'admin') return true;
  return b.requestedBy === user.username && (b.status === 'pending' || b.status === 'rejected');
}

function bookingOut_(b, user) {
  const out = {};
  BOOKING_HEADERS.forEach(h => { out[h] = b[h] || ''; });
  out.mine = b.requestedBy === user.username;
  out.canEdit = canEditBooking_(b, user);
  out.canCancel = b.status !== 'cancelled' && (out.mine || user.role === 'admin');
  out.canReview = user.role === 'admin' && b.status !== 'cancelled';
  out.canLog = user.role === 'admin' && b.status === 'approved' && !b.loggedRows;
  return out;
}

function validateBooking_(form) {
  form = form || {};
  const f = {};
  BOOKING_FIELDS.forEach(k => { f[k] = String(form[k] === undefined || form[k] === null ? '' : form[k]).trim(); });
  if (!f.title) throw new Error('กรุณากรอกลูกค้า / สินค้า');
  parseDate_(f.date);
  if (f.provider !== 'EXAT' && f.provider !== 'BEM') throw new Error('กรุณาเลือกแจ้งใช้รถ EXAT หรือ BEM');
  if (!f.mediaType) throw new Error('กรุณาเลือก Media Type');
  f.places = f.places.split(/\r?\n/).map(s => s.trim()).filter(Boolean).join('\n');
  if (!f.places) throw new Error('กรุณากรอกจุดที่ไปอย่างน้อย 1 จุด');
  return f;
}

function nowText_() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm');
}

/** การจองช่วงวันที่ from–to (ISO) + รายการรออนุมัติทั้งหมด (เฉพาะผู้ดูแลระบบ) */
function listBookings(token, from, to) {
  const user = requireUser_(token);
  const all = readBookings_(bookingsSheet_(false));
  const inRange = all.filter(b => (!from || b.date >= from) && (!to || b.date <= to));
  const pending = all.filter(b => b.status === 'pending').sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return {
    bookings: inRange.map(b => bookingOut_(b, user)),
    pending: user.role === 'admin' ? pending.map(b => bookingOut_(b, user)) : [],
  };
}

/** สร้าง (ไม่มี id) หรือแก้ไขการจอง */
function saveBooking(token, form) {
  const user = requireUser_(token);
  const f = validateBooking_(form);
  const id = String((form && form.id) || '').trim();
  return withLock_(() => {
    const sh = bookingsSheet_();
    const now = nowText_();
    let b;
    if (id) {
      b = readBookings_(sh).find(x => x.id === id);
      if (!b) throw new Error('ไม่พบการจองนี้ อาจถูกลบไปแล้ว');
      if (!canEditBooking_(b, user)) throw new Error('แก้ไขได้เฉพาะการจองของคุณที่ยังไม่ได้อนุมัติ — ติดต่อผู้ดูแลระบบ');
      Object.assign(b, f, { updatedAt: now });
      if (user.role !== 'admin' && b.status === 'rejected') {
        b.status = 'pending'; // แก้แล้วส่งขออนุมัติใหม่
        b.reviewedAt = '';
      }
      writeBooking_(sh, b.row, b);
      audit_(user.username, 'update_booking', BOOKING_SHEET, b.row, { id: b.id, status: b.status });
    } else {
      b = Object.assign({
        id: 'B' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 36 * 36).toString(36).toUpperCase(),
        status: 'pending', requestedBy: user.username, requestedByName: user.fullName || user.username, requestedAt: now,
        reviewedBy: '', reviewedByName: '', reviewedAt: '', reviewNote: '', updatedAt: now,
      }, f);
      b.row = Math.max(sh.getLastRow(), 1) + 1;
      writeBooking_(sh, b.row, b);
      audit_(user.username, 'create_booking', BOOKING_SHEET, b.row, { id: b.id, date: b.date, title: b.title });
    }
    return bookingOut_(b, user);
  });
}

/** ผู้ดูแลระบบอนุมัติ / ไม่อนุมัติ */
function reviewBooking(token, id, decision, note) {
  const user = requireUser_(token, true);
  if (decision !== 'approved' && decision !== 'rejected') throw new Error('ผลการพิจารณาไม่ถูกต้อง');
  const reviewed = withLock_(() => {
    const sh = bookingsSheet_();
    const b = readBookings_(sh).find(x => x.id === String(id || ''));
    if (!b) throw new Error('ไม่พบการจองนี้');
    if (b.status === 'cancelled') throw new Error('การจองนี้ถูกยกเลิกแล้ว');
    const now = nowText_();
    Object.assign(b, {
      status: decision, reviewedBy: user.username, reviewedByName: user.fullName || user.username,
      reviewedAt: now, reviewNote: String(note || '').trim(), updatedAt: now,
    });
    writeBooking_(sh, b.row, b);
    audit_(user.username, decision === 'approved' ? 'approve_booking' : 'reject_booking', BOOKING_SHEET, b.row, { id: b.id, note: b.reviewNote });
    return b;
  });
  // อนุมัติแล้ว → บันทึกลงตาราง EXAT / BEM ทันที (ถ้ายังไม่เคยบันทึก)
  if (decision === 'approved' && !reviewed.loggedRows) return logBookingSafe_(reviewed, user);
  return bookingOut_(reviewed, user);
}

/** ผู้ดูแลระบบสั่งบันทึกการจองที่อนุมัติแล้วลงตาราง EXAT / BEM (สำหรับการจองที่อนุมัติก่อนมีระบบนี้) */
function logBooking(token, id) {
  const user = requireUser_(token, true);
  const b = readBookings_(bookingsSheet_()).find(x => x.id === String(id || ''));
  if (!b) throw new Error('ไม่พบการจองนี้');
  if (b.status !== 'approved') throw new Error('บันทึกลงตารางได้เฉพาะการจองที่อนุมัติแล้ว');
  if (b.loggedRows) throw new Error('การจองนี้บันทึกลงตารางแล้ว: ' + b.loggedRows);
  return logBookingSafe_(b, user);
}

/**
 * แปลงการจองเป็นแถวในตาราง EXAT / BEM (1 จุดที่ไป = 1 แถว)
 * สถานที่ที่ตรงกับแท็บ DataBase ใช้ชื่อ สายทาง และโครงการจากฐานข้อมูล
 * จุดแรกของคืน: EXAT ค่าอาหาร 400 / BEM "คิดค่ารถ 1 คืน" + "รอออก PR" — จุดถัดไป 0 / เว้นว่าง
 */
function bookingToForms_(b) {
  const key = b.provider === 'BEM' ? 'bem' : 'exat';
  const locs = readLocations_();
  const worker = String(b.worker || '').replace(/\s*[0-9][0-9\-\s]{6,}$/, '').trim() || b.requestedByName;
  const places = String(b.places || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const forms = places.map((p, i) => {
    const np = norm_(p);
    const loc = locs.find(l => norm_(l.area) === np) ||
      locs.find(l => l.code && norm_(l.code) === np) ||
      locs.find(l => np.length >= 6 && norm_(l.area).indexOf(np) >= 0);
    const owner = loc ? (/^BEM/i.test(loc.operator) || /BECL|BEM/i.test(loc.mediaSite) ? 'BEM' : 'EXAT') : b.provider;
    const gateway = loc ? /gateway/i.test(loc.mediaSite) : /gateway/i.test(b.mediaType);
    const f = {
      date: b.date, worker, jobType: b.jobType || b.title,
      place: loc ? loc.area : p,
      expressway: (loc && loc.expressway) || b.expressway,
      project: (gateway ? 'Gateway ' : 'Flyover 2.0 ') + owner,
    };
    if (key === 'exat') f.fee = i === 0 ? 400 : 0;
    else { f.feeText = i === 0 ? 'คิดค่ารถ 1 คืน' : ''; f.payment = i === 0 ? 'รอออก PR' : ''; }
    return f;
  });
  return { key, forms };
}

/** บันทึกการจองลงตาราง แล้วจดเลขลำดับไว้ในการจอง — ถ้าล้มเหลว การอนุมัติยังอยู่ และแจ้งข้อผิดพลาดกลับไป */
function logBookingSafe_(b, user) {
  let logError = '';
  let warnings = [];
  try {
    const { key, forms } = bookingToForms_(b);
    if (!forms.length) throw new Error('การจองนี้ไม่มีจุดที่ไป');
    const valid = forms.map((f, i) => {
      try { return validateLogForm_(key, f); } catch (err) { throw new Error('จุดที่ ' + (i + 1) + ': ' + err.message); }
    });
    const saved = valid.map(f => addLogRow_(user, key, f));
    afterLogSaved_(key, [b.date]);
    warnings = uniq_([].concat.apply([], saved.map(s => s.warnings || [])));
    b.loggedRows = key.toUpperCase() + ' ลำดับ ' + saved.map(s => s.no).join(', ');
    b.loggedAt = nowText_();
    withLock_(() => {
      const sh = bookingsSheet_();
      const cur = readBookings_(sh).find(x => x.id === b.id);
      if (cur) {
        cur.loggedRows = b.loggedRows;
        cur.loggedAt = b.loggedAt;
        writeBooking_(sh, cur.row, cur);
      }
    });
    audit_(user.username, 'log_booking', BOOKING_SHEET, b.row, { id: b.id, rows: b.loggedRows });
  } catch (err) {
    logError = String(err && err.message || err);
  }
  return Object.assign(bookingOut_(b, user), { logError, logWarnings: warnings });
}

/** ผู้จองหรือผู้ดูแลระบบยกเลิกการจอง */
function cancelBooking(token, id) {
  const user = requireUser_(token);
  return withLock_(() => {
    const sh = bookingsSheet_();
    const b = readBookings_(sh).find(x => x.id === String(id || ''));
    if (!b) throw new Error('ไม่พบการจองนี้');
    if (b.requestedBy !== user.username && user.role !== 'admin') throw new Error('ยกเลิกได้เฉพาะการจองของคุณ');
    if (b.status === 'cancelled') return bookingOut_(b, user);
    b.status = 'cancelled';
    b.updatedAt = nowText_();
    writeBooking_(sh, b.row, b);
    audit_(user.username, 'cancel_booking', BOOKING_SHEET, b.row, { id: b.id });
    return bookingOut_(b, user);
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
  return sheetDate_(date.getFullYear(), date.getMonth() + 1, 1);
}

/** เที่ยงคืนตามเขตเวลาของชีท (ไม่ใช่ของสคริปต์) — กันวันที่/เดือนเลื่อนเมื่อชีทตั้งเขตเวลาอื่น */
function sheetDate_(y, m, d) {
  return Utilities.parseDate(y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'), sheetTz_(), 'yyyy-MM-dd');
}

let sheetTzCache_ = '';
function sheetTz_() {
  if (!sheetTzCache_) sheetTzCache_ = spreadsheet_().getSpreadsheetTimeZone() || CONFIG.TIMEZONE;
  return sheetTzCache_;
}

/** วันที่ — ถ้าแถวก่อนหน้าเป็นข้อความ (เช่น "5 พ.ค. 22") เขียนเป็นข้อความแบบเดียวกัน ไม่งั้นเขียนเป็นวันที่ */
function dateValue_(date, prev) {
  if (typeof prev === 'string' && prev !== '') {
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(prev.trim())) return date.getDate() + '/' + (date.getMonth() + 1) + '/' + yearLike_(prev, date);
    return date.getDate() + ' ' + monthNameLike_(prev, date) + ' ' + yearLike_(prev, date);
  }
  return sheetDate_(date.getFullYear(), date.getMonth() + 1, date.getDate());
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
