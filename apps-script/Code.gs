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

const USER_HEADERS = ['username', 'passwordHash', 'salt', 'fullName', 'email', 'role', 'status', 'createdAt', 'lastLogin', 'requestedRole', 'reviewedBy', 'reviewedAt'];
const AUDIT_HEADERS = ['timestamp', 'username', 'action', 'sheet', 'row', 'detail'];
const ROLES = ['user', 'admin'];
const STATUSES = ['pending', 'active', 'disabled', 'rejected'];
const ROLE_TEXT = { admin: 'ผู้ดูแลระบบ (admin)', user: 'ผู้ใช้งาน (user)' };
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
  register, login, logout, changePassword, requestPasswordReset, resetPasswordWithToken, getAppData, addLogEntry, addLogEntries, getDashboard, recalcCosts, listBookings, saveBooking, reviewBooking, cancelBooking, logBooking, uploadCancelFile, listCancelled, getCancelFile,
  getAccrue, downloadAccrue, sendAccrueNow, saveAccrueSettings, getClear, downloadClear, sendClearNow,
  listHolidays, saveHoliday, deleteHoliday,
  addLocation, listUsers, updateUser, reviewUser, resetPassword,
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
  const requested = form.role === 'admin' ? 'admin' : 'user'; // ประเภทที่ขอ — ผู้ดูแลระบบเป็นผู้ยืนยัน

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

    // ผู้สมัครคนแรกเป็นผู้ดูแลระบบทันที (ต้องมีคนอนุมัติคนถัดไป) — คนถัดไปรอผู้ดูแลระบบยืนยัน
    // สิทธิ์จริงยังเป็น user จนกว่าผู้ดูแลระบบจะกดอนุมัติ (และเลือกประเภทได้ตอนอนุมัติ)
    const isFirst = users.length === 0;
    const salt = Utilities.getUuid();
    const role = isFirst ? 'admin' : 'user';
    const status = isFirst ? 'active' : 'pending';
    const want = isFirst ? 'admin' : requested;
    sh.appendRow([username, hash_(password, salt), salt, text_(fullName), text_(email), role, status, new Date(), '', want, isFirst ? '(ผู้สมัครคนแรก)' : '', isFirst ? new Date() : '']);
    audit_(username, 'register', CONFIG.USERS_SHEET, sh.getLastRow(), { role, status, requestedRole: want });

    return {
      status,
      message: isFirst
        ? 'สมัครสำเร็จ — คุณเป็นผู้ดูแลระบบคนแรก เข้าสู่ระบบได้เลย'
        : 'สมัครสำเร็จ (ขอเป็น ' + ROLE_TEXT[want] + ') — รอผู้ดูแลระบบยืนยันก่อนเข้าใช้งาน',
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
  if (fails >= CONFIG.MAX_LOGIN_FAILS) throw new Error('RESET_AVAILABLE: ใส่รหัสผ่านผิด ' + fails + ' ครั้ง บัญชีถูกล็อก 15 นาที — ขอลิงก์ตั้งรหัสผ่านใหม่ได้');

  const sh = usersSheet_();
  const user = readUsers_(sh).find(u => u.username === username);
  if (!user || !verify_(password, user)) {
    const n = fails + 1;
    cache.put(failKey, String(n), CONFIG.LOCKOUT_SECONDS);
    // ผิดครบ 3 ครั้ง → เสนอให้รีเซ็ตรหัสผ่าน · ครบ 5 ครั้ง → ล็อก 15 นาที
    if (n >= RESET_OFFER_AFTER) throw new Error('RESET_AVAILABLE: ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง (ผิด ' + n + ' ครั้ง' + (n < CONFIG.MAX_LOGIN_FAILS ? ' · ครบ ' + CONFIG.MAX_LOGIN_FAILS + ' ครั้งจะถูกล็อก 15 นาที' : ' · ล็อก 15 นาที') + ') — ลืมรหัสผ่าน? ขอลิงก์ตั้งรหัสผ่านใหม่ได้');
    throw new Error('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  }
  cache.remove(failKey);
  if (user.status === 'pending') throw new Error('บัญชียังรอผู้ดูแลระบบยืนยัน (ขอเป็น ' + (ROLE_TEXT[user.requestedRole] || ROLE_TEXT.user) + ')');
  if (user.status === 'rejected') throw new Error('ผู้ดูแลระบบไม่อนุมัติบัญชีนี้ — กรุณาติดต่อผู้ดูแลระบบ');
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
  const user = requireUser_(token, true); // บันทึกการใช้รถ: เฉพาะผู้ดูแลระบบ
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
  const user = requireUser_(token, true); // บันทึกการใช้รถ: เฉพาะผู้ดูแลระบบ
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
  if (form.jobCategory !== undefined) {
    const cat = String(form.jobCategory || '').trim();
    if (!cat) throw new Error('กรุณาเลือกประเภทงาน');
    if (JOB_CATEGORIES.indexOf(cat) < 0 && cat !== JOB_OTHER) throw new Error('ประเภทงานไม่ถูกต้อง');
    form = Object.assign({}, form, { jobType: composeJobType_(cat, form.jobDetail) });
  }
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

const DASH_CACHE_KEY = 'dash_v4';

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
    no: c('ลำดับ'), jobType: c('ประเภทงาน'),
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
      no: pick(r, ci.no), jobType: pick(r, ci.jobType),
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
  requireUser_(token, true); // แดชบอร์ด: เฉพาะผู้ดูแลระบบ
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
  const newDims = () => ({ place: {}, project: {}, expressway: {}, worker: {}, category: {} });
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
      add(year.dims, 'category', jobCategoryOf_(r.jobType), side, r.ym.m, cost);
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
  'phone', // เบอร์ติดต่อผู้เข้างาน
  'prevStatus', 'cancelReason', 'cancelFiles', 'cancelledBy', 'cancelledByName', 'cancelledAt', 'removedRows', // การยกเลิก
  'jobCategory', // ประเภทงาน (หมวด) — ไว้กรองงาน ข้อความเต็มอยู่ใน jobType
];

// ประเภทงาน: เลือกหมวด + พิมพ์รายละเอียดเพิ่ม → บันทึกเป็นข้อความเดียว เช่น "งานติดตั้งสินค้า COM7"
// (ตาราง EXAT / BEM, File Accrue, File Clear ใช้ข้อความเต็มเหมือนเดิม — ข้อความขึ้นต้นด้วยหมวด จึงกรองในชีทได้)
const JOB_CATEGORIES = ['งานติดตั้งสินค้า', 'งานตรวจสอบโครงสร้างประจำปี', 'งานตรวจสอบระบบไฟฟ้า'];
const JOB_OTHER = 'อื่น ๆ';

function composeJobType_(category, detail) {
  const cat = String(category || '').trim();
  const d = String(detail || '').replace(/\s+/g, ' ').trim();
  if (JOB_CATEGORIES.indexOf(cat) < 0) return d;
  if (d && jobCategoryOf_(d) === cat) return d; // ข้อความบอกหมวดอยู่แล้ว (พิมพ์เอง / ข้อมูลเก่า เช่น "งานติดตั้งงานสินค้า D7")
  return (cat + ' ' + d).trim();
}

/** หมวดของข้อความประเภทงาน (ใช้กับข้อมูลเก่าที่ไม่ได้เลือกหมวด) */
function jobCategoryOf_(text) {
  const t = norm_(text);
  for (let i = 0; i < JOB_CATEGORIES.length; i++) if (t.indexOf(norm_(JOB_CATEGORIES[i])) === 0) return JOB_CATEGORIES[i];
  if (/ตรวจสอบโครงสร้าง|โครงสร้างประจำปี/.test(t)) return JOB_CATEGORIES[1];
  if (/ไฟฟ้า|ระบบไฟ|ไฟส่องสว่าง/.test(t)) return JOB_CATEGORIES[2];
  if (/ติดตั้ง|สินค้า/.test(t)) return JOB_CATEGORIES[0];
  return JOB_OTHER;
}
const BOOKING_FIELDS = ['title', 'date', 'time', 'mediaType', 'provider', 'expressway', 'meetingPoint', 'places', 'jobType', 'worker', 'phone', 'note'];
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
  out.canCancel = canCancelBooking_(b, user);
  out.cancelNeedsProof = cancelNeedsProof_(b);
  out.cancelFiles = cancelFilesOut_(b.cancelFiles);
  out.canReview = user.role === 'admin' && b.status !== 'cancelled';
  out.canLog = user.role === 'admin' && b.status === 'approved' && !b.loggedRows;
  return out;
}

function validateBooking_(form) {
  form = form || {};
  const f = {};
  BOOKING_FIELDS.forEach(k => { f[k] = String(form[k] === undefined || form[k] === null ? '' : form[k]).trim(); });
  if (form.jobCategory !== undefined) {
    const cat = String(form.jobCategory || '').trim();
    if (!cat) throw new Error('กรุณาเลือกประเภทงาน');
    if (JOB_CATEGORIES.indexOf(cat) < 0 && cat !== JOB_OTHER) throw new Error('ประเภทงานไม่ถูกต้อง');
    f.jobType = text_(composeJobType_(cat, form.jobDetail));
    f.jobCategory = cat;
  } else {
    f.jobCategory = jobCategoryOf_(f.jobType);
  }
  if (!f.jobType) throw new Error('กรุณากรอกประเภทงาน');
  if (!f.title) f.title = f.jobType; // ไม่มีช่องลูกค้า/สินค้าแล้ว — ใช้ประเภทงานเป็นชื่อการจอง
  if (!f.worker) throw new Error('กรุณากรอกชื่อผู้เข้างาน');
  if (!f.phone) throw new Error('กรุณากรอกเบอร์ติดต่อผู้เข้างาน');
  if (!/^[0-9+][0-9\-\s]{7,14}$/.test(f.phone)) throw new Error('เบอร์ติดต่อไม่ถูกต้อง เช่น 061-895-3563');
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
  const inRange = all.filter(b => b.status !== 'cancelled' && (!from || b.date >= from) && (!to || b.date <= to));
  const pending = all.filter(b => b.status === 'pending').sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return {
    bookings: inRange.map(b => bookingOut_(b, user)),
    pending: user.role === 'admin' ? pending.map(b => bookingOut_(b, user)) : [],
    holidays: holidaysBetween_(from, to),
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
      date: b.date, worker, jobType: b.jobType || b.title, // ไม่ใส่เบอร์โทรลงตาราง EXAT / BEM
      place: loc ? loc.area : p,
      expressway: (loc && loc.expressway) || b.expressway,
      project: (gateway ? 'Gateway ' : 'Flyover 2.0 ') + owner,
    };
    if (key === 'exat') f.fee = i === 0 ? 400 : 0;
    else { f.feeText = i === 0 ? 'คิดค่ารถ 1 คืน' : ''; f.payment = i === 0 ? 'รอออก PR' : ''; }
    return f;
  });
  // จุดที่ไม่อยู่ในฐานข้อมูลและการจองไม่ได้ระบุสายทาง: ใช้สายทางของจุดอื่นในการจองเดียวกัน
  const knownWay = (forms.find(f => f.expressway) || {}).expressway || (key === 'bem' ? 'ศรีรัช' : '');
  forms.forEach(f => { if (!f.expressway) f.expressway = knownWay; });
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

/* ------------------------------------------------------------------ */
/* ยกเลิกการจอง — เหตุผล + ไฟล์แนบ (ภาพ / วิดีโอ) และย้ายออกจากตาราง EXAT / BEM */
/* ------------------------------------------------------------------ */

const CANCEL_SHEET = 'ยกเลิกการใช้รถคุ้มครอง';
const CANCEL_HEADERS = [
  'วันที่ยกเลิก', 'รหัสการจอง', 'วันที่ใช้รถ', 'แจ้งใช้รถ', 'ประเภทงาน', 'จุดที่ไป', 'ผู้เข้างาน', 'เบอร์ติดต่อ',
  'สถานะก่อนยกเลิก', 'เหตุผลที่ยกเลิก', 'ไฟล์แนบ', 'ยกเลิกโดย', 'แถวที่นำออกจากตาราง', 'ข้อมูลแถวเดิม',
];
const CANCEL_FOLDER_NAME = 'Protection Fee – ไฟล์แนบการยกเลิก';
const MAX_UPLOAD_MB = 25;
const MAX_CANCEL_FILES = 5;

function canCancelBooking_(b, user) {
  return b.status !== 'cancelled' && (b.requestedBy === user.username || user.role === 'admin');
}

/** การจองที่อนุมัติแล้ว (หรือบันทึกลงตารางแล้ว) ต้องมีเหตุผลและไฟล์แนบเมื่อยกเลิก */
function cancelNeedsProof_(b) {
  return b.status === 'approved' || !!b.loggedRows;
}

function cancelFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('CANCEL_FOLDER_ID');
  if (id) {
    try {
      const f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (err) { /* ถูกลบไปแล้ว — สร้างใหม่ */ }
  }
  // เก็บไว้ในโฟลเดอร์เดียวกับ Google Sheet ถ้าเข้าถึงได้
  let parent = null;
  try {
    const parents = DriveApp.getFileById(spreadsheet_().getId()).getParents();
    if (parents.hasNext()) parent = parents.next();
  } catch (err) { /* ใช้ My Drive */ }
  const folder = parent ? parent.createFolder(CANCEL_FOLDER_NAME) : DriveApp.createFolder(CANCEL_FOLDER_NAME);
  props.setProperty('CANCEL_FOLDER_ID', folder.getId());
  return folder;
}

function safeFileName_(name, mime) {
  let s = String(name || '').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').trim().slice(-80);
  if (!s) s = (/^video\//.test(mime) ? 'video' : 'image') + '.' + (String(mime).split('/')[1] || 'bin');
  return s;
}

/** อัปโหลดไฟล์แนบการยกเลิก 1 ไฟล์ (base64) ไปที่ Google Drive — เรียกก่อน cancelBooking */
function uploadCancelFile(token, id, file) {
  const user = requireUser_(token);
  const b = readBookings_(bookingsSheet_(false)).find(x => x.id === String(id || ''));
  if (!b) throw new Error('ไม่พบการจองนี้');
  if (!canCancelBooking_(b, user)) throw new Error('ยกเลิกได้เฉพาะการจองของคุณที่ยังไม่ถูกยกเลิก');
  file = file || {};
  const mime = String(file.mime || '').toLowerCase();
  if (!/^(image|video)\/[\w.+-]+$/.test(mime)) throw new Error('แนบได้เฉพาะไฟล์ภาพหรือวิดีโอ');
  const bytes = Utilities.base64Decode(String(file.data || '').replace(/^data:[^,]*,/, ''));
  if (!bytes.length) throw new Error('ไฟล์ว่างเปล่า');
  if (bytes.length > MAX_UPLOAD_MB * 1024 * 1024) throw new Error('ไฟล์ใหญ่เกิน ' + MAX_UPLOAD_MB + ' MB');
  const name = safeFileName_(file.name, mime);
  const f = cancelFolder_().createFile(Utilities.newBlob(bytes, mime, b.date + '_' + b.id + '_' + name));
  f.setDescription('cancel:' + b.id + ' by ' + user.username); // ไฟล์เป็นส่วนตัวใน Drive ของเจ้าของชีท — เปิดดูผ่านเว็บด้วย getCancelFile
  return { id: f.getId(), name, mime, size: bytes.length };
}

/** ตรวจว่าไฟล์เป็นไฟล์แนบของการจองนี้จริง */
function cancelFileInfo_(fileId, bookingId) {
  let f;
  try { f = DriveApp.getFileById(String(fileId || '')); } catch (err) { throw new Error('ไม่พบไฟล์แนบ กรุณาแนบใหม่'); }
  if (String(f.getDescription() || '').indexOf('cancel:' + bookingId + ' ') !== 0) throw new Error('ไฟล์แนบไม่ใช่ของการจองนี้');
  const prefix = /^\d{4}-\d{2}-\d{2}_[A-Z0-9]+_/;
  return { id: f.getId(), name: f.getName().replace(prefix, ''), mime: f.getMimeType() };
}

function cancelFilesOut_(json) {
  let list = [];
  try { list = JSON.parse(json || '[]'); } catch (err) { list = []; }
  return (Array.isArray(list) ? list : []).filter(x => x && x.id).map(x => ({
    id: x.id, name: x.name || '', mime: x.mime || '',
    url: 'https://drive.google.com/file/d/' + encodeURIComponent(x.id) + '/view', // เปิดได้เฉพาะผู้ที่มีสิทธิ์ใน Drive
  }));
}

/** เปิดไฟล์แนบของการจองที่ยกเลิกแล้ว (ผู้ใช้ที่เข้าสู่ระบบ) — คืนค่าเป็น base64 */
function getCancelFile(token, id, fileId) {
  requireUser_(token);
  const b = readBookings_(bookingsSheet_(false)).find(x => x.id === String(id || ''));
  if (!b || b.status !== 'cancelled') throw new Error('ไม่พบการยกเลิกนี้');
  const info = cancelFilesOut_(b.cancelFiles).find(x => x.id === String(fileId || ''));
  if (!info) throw new Error('ไม่พบไฟล์แนบนี้');
  const blob = DriveApp.getFileById(info.id).getBlob();
  return { name: info.name, mime: blob.getContentType() || info.mime, data: Utilities.base64Encode(blob.getBytes()) };
}

/**
 * นำแถวของการจองออกจากตาราง EXAT / BEM (ล้างข้อมูล คงเลขลำดับไว้ให้แถวถัดไปใช้ต่อ)
 * ล้างเฉพาะแถวที่เลขลำดับและวันที่ตรงกับการจอง — ถ้ามีคนแก้ชีทไปแล้วจะข้ามและแจ้งเตือน
 */
function removeLoggedRows_(b) {
  const empty = { key: '', removed: [], skipped: [], snapshot: [] };
  const m = /^(EXAT|BEM)\s*ลำดับ\s*(.+)$/.exec(String(b.loggedRows || '').trim());
  if (!m) return empty;
  const key = m[1].toLowerCase();
  const nos = m[2].split(/[,\s]+/).map(Number).filter(n => isFinite(n) && n > 0);
  return withLock_(() => {
    const t = findTable_(key);
    const sh = t.sheet;
    const noCol = colIndex_(t.headers, 'ลำดับ');
    const dateCol = colIndex_(t.headers, 'วันที่');
    const lastRow = sh.getLastRow();
    if (noCol < 0 || dateCol < 0 || lastRow <= t.headerRow) return Object.assign(empty, { key, skipped: nos.map(n => n + ' (ไม่พบแถว)') });
    const range = sh.getRange(t.headerRow + 1, 1, lastRow - t.headerRow, t.width);
    const vals = range.getValues();
    const disp = range.getDisplayValues();
    const out = { key, removed: [], skipped: [], snapshot: [] };
    nos.forEach(no => {
      const i = vals.findIndex(r => Number(r[noCol]) === no);
      if (i < 0) { out.skipped.push(no + ' (ไม่พบแถว)'); return; }
      if (dateIsoOf_(vals[i][dateCol], disp[i][dateCol]) !== b.date) { out.skipped.push(no + ' (วันที่ในชีทไม่ตรงกับการจอง)'); return; }
      out.snapshot.push(disp[i].map(v => String(v).trim()).filter(Boolean).join(' | '));
      const row = t.headerRow + 1 + i;
      if (noCol > 0) sh.getRange(row, 1, 1, noCol).clearContent();
      if (noCol + 1 < t.width) sh.getRange(row, noCol + 2, 1, t.width - noCol - 1).clearContent();
      out.removed.push(no);
    });
    SpreadsheetApp.flush();
    return out;
  });
}

function cancelSheet_() {
  const ss = spreadsheet_();
  let sh = ss.getSheetByName(CANCEL_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CANCEL_SHEET);
    sh.getRange(1, 1, 1, CANCEL_HEADERS.length).setValues([CANCEL_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function appendCancelLog_(b, rem, files) {
  const sh = cancelSheet_();
  const row = Math.max(sh.getLastRow(), 1) + 1;
  const range = sh.getRange(row, 1, 1, CANCEL_HEADERS.length);
  range.setNumberFormat('@');
  range.setValues([[
    b.cancelledAt, b.id, b.date, b.provider, b.jobType || b.title, b.places, b.worker, b.phone,
    BOOKING_STATUS_TEXT_[b.prevStatus] || b.prevStatus, b.cancelReason,
    files.map(f => f.name + ' ' + f.url).join('\n'),
    b.cancelledByName, b.removedRows + (rem.skipped.length ? (b.removedRows ? '\n' : '') + 'ไม่ได้ลบ: ' + rem.skipped.join(', ') : ''),
    rem.snapshot.join('\n'),
  ].map(longText_)]);
}

const BOOKING_STATUS_TEXT_ = { pending: 'รออนุมัติ', approved: 'อนุมัติแล้ว', rejected: 'ไม่อนุมัติ', cancelled: 'ยกเลิกแล้ว' };

/**
 * ผู้จองหรือผู้ดูแลระบบยกเลิกการจอง
 * การจองที่อนุมัติแล้วต้องระบุเหตุผล + แนบภาพ/วิดีโออย่างน้อย 1 ไฟล์ (อัปโหลดด้วย uploadCancelFile ก่อน)
 * ถ้าบันทึกลงตาราง EXAT / BEM แล้ว จะนำแถวออก และเก็บประวัติไว้ในแท็บ "ยกเลิกการใช้รถคุ้มครอง"
 */
function cancelBooking(token, id, reason, fileIds) {
  const user = requireUser_(token);
  const b0 = readBookings_(bookingsSheet_()).find(x => x.id === String(id || ''));
  if (!b0) throw new Error('ไม่พบการจองนี้');
  if (b0.status === 'cancelled') return bookingOut_(b0, user);
  if (!canCancelBooking_(b0, user)) throw new Error('ยกเลิกได้เฉพาะการจองของคุณ');
  const why = String(reason === null || reason === undefined ? '' : reason).trim().slice(0, 1000);
  const ids = uniq_((Array.isArray(fileIds) ? fileIds : []).map(String).filter(Boolean)).slice(0, MAX_CANCEL_FILES);
  const files = ids.map(fid => cancelFileInfo_(fid, b0.id));
  if (cancelNeedsProof_(b0)) {
    if (why.length < 5) throw new Error('กรุณาระบุเหตุผลที่ยกเลิก (อย่างน้อย 5 ตัวอักษร)');
    if (!files.length) throw new Error('การจองที่อนุมัติแล้ว ต้องแนบภาพหรือวิดีโอประกอบการยกเลิกอย่างน้อย 1 ไฟล์');
  }

  const rem = b0.loggedRows ? removeLoggedRows_(b0) : { key: '', removed: [], skipped: [], snapshot: [] };
  if (rem.removed.length) afterLogSaved_(rem.key, [b0.date]);

  const b = withLock_(() => {
    const sh = bookingsSheet_();
    const cur = readBookings_(sh).find(x => x.id === b0.id);
    if (!cur) throw new Error('ไม่พบการจองนี้');
    const now = nowText_();
    Object.assign(cur, {
      prevStatus: cur.status, status: 'cancelled', updatedAt: now,
      cancelReason: why, cancelFiles: JSON.stringify(files),
      cancelledBy: user.username, cancelledByName: user.fullName || user.username, cancelledAt: now,
      removedRows: rem.removed.length ? rem.key.toUpperCase() + ' ลำดับ ' + rem.removed.join(', ') : '',
    });
    writeBooking_(sh, cur.row, cur);
    return cur;
  });
  try {
    appendCancelLog_(b, rem, cancelFilesOut_(b.cancelFiles));
  } catch (err) {
    console.error('appendCancelLog_ failed', err);
  }
  audit_(user.username, 'cancel_booking', BOOKING_SHEET, b.row, { id: b.id, prev: b.prevStatus, files: files.length, removed: b.removedRows, skipped: rem.skipped });
  return Object.assign(bookingOut_(b, user), { removeWarnings: rem.skipped });
}

/** รายการที่ยกเลิกแล้วทั้งหมด (ล่าสุดก่อน) — แสดงในหน้า "รายการยกเลิก" แยกจากตารางจอง */
function listCancelled(token) {
  const user = requireUser_(token);
  return readBookings_(bookingsSheet_(false))
    .filter(b => b.status === 'cancelled')
    .sort((a, b) => String(b.cancelledAt || b.updatedAt).localeCompare(String(a.cancelledAt || a.updatedAt)))
    .map(b => bookingOut_(b, user));
}

/* ------------------------------------------------------------------ */
/* File Accrue ค่ารถคุ้มครองรายเดือน (EXAT / BEM) + ส่งอีเมลทุกวันที่ 21 — เฉพาะผู้ดูแลระบบ */
/* ------------------------------------------------------------------ */

const ACCRUE_PROP = 'ACCRUE_SETTINGS';
const ACCRUE_DEFAULTS = {
  to: 'teraporn.ru@planbmedia.co.th', cc: '',
  greeting: 'น้องหม่อง', ccLabel: 'ผู้เกี่ยวข้อง', signOff: 'ขอบคุณครับ',
  checker: 'นายณัฐวุฒิ อู่ยายโสม', timeIn: '22', timeOut: '4',
  autoSend: true, sendDays: '21, 25, 27, 30, 31', sendHour: 9,
  clearAuto: true, clearDay: 25, // File Clear ของเดือนก่อนหน้า
};
const ACCRUE_JOB = 'accrueMonthlyJob';
const ACCRUE_LOG_SHEET = 'ประวัติส่ง File Accrue';
const ACCRUE_LOG_HEADERS = ['วันที่ส่ง', 'เดือน', 'ส่งโดย', 'ถึง', 'สำเนา', 'EXAT (บาท)', 'BEM (บาท)', 'ไฟล์', 'สถานะ'];
const ACCRUE_FOLDER_NAME = 'Protection Fee – File Accrue';
const TH_MONTHS_FULL = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const ACCRUE_FONT = 'Cordia New';

function accrueSettings_() {
  let saved = {};
  try { saved = JSON.parse(PropertiesService.getScriptProperties().getProperty(ACCRUE_PROP) || '{}'); } catch (err) { saved = {}; }
  return Object.assign({}, ACCRUE_DEFAULTS, saved);
}

function emailList_(s) {
  return uniq_(String(s || '').split(/[\s,;]+/).map(x => x.trim()).filter(Boolean));
}

function checkEmails_(list, label) {
  list.forEach(e => { if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error(label + ': รูปแบบอีเมลไม่ถูกต้อง — ' + e); });
  return list;
}

/** "กันยายน 69" */
function accrueMonthShort_(y, m) { return TH_MONTHS_FULL[m - 1] + ' ' + String((y + 543) % 100).padStart(2, '0'); }

/** "1 ก.ค. 69" — ตามรูปแบบในไฟล์ตัวอย่าง */
function accrueDateText_(iso) {
  const p = String(iso || '').split('-').map(Number);
  return p.length === 3 ? p[2] + ' ' + THAI_MONTHS[p[1] - 1] + ' ' + String((p[0] + 543) % 100).padStart(2, '0') : String(iso || '');
}

function hourOf_(time, fallback) {
  const m = /(\d{1,2})\s*[.:]?\s*(\d{2})?/.exec(String(time || ''));
  return m ? String(Number(m[1])) : fallback;
}

/**
 * รายการ Accrue ทั้งปี: EXAT = แถวละ 1 จุด ราคาเต็มตามอัตรา (ไม่หักค่าอาหาร — เป็นทดรองจ่ายแยก)
 * BEM = แถวละ 1 คืน (รถ 1 คัน) เฉพาะคืนที่คิดค่ารถ — หลายจุดในคืนเดียวรวมเป็นแถวเดียว
 * นับตามคอลัมน์ "เดือน" ในชีท (เดือนที่ลงบัญชี)
 */
function accrueYear_(y) {
  const rates = readRates_();
  const s = accrueSettings_();
  const timeOf = {};
  readBookings_(bookingsSheet_(false)).forEach(b => {
    const mm = /^(EXAT|BEM)\s*ลำดับ\s*(.+)$/.exec(String(b.loggedRows || '').trim());
    if (mm && b.status !== 'cancelled') mm[2].split(/[,\s]+/).filter(Boolean).forEach(n => { timeOf[mm[1] + ':' + n] = b.time; });
  });
  const months = [];
  for (let m = 1; m <= 12; m++) months.push({ m, exat: [], bem: [] });

  ['exat', 'bem'].forEach(key => {
    const P = key.toUpperCase();
    const rows = logRows_(key).rows;
    const costs = computeCosts_(rates, P, rows);
    let night = null;
    rows.forEach((r, i) => {
      const c = costs[i];
      if (!r.has || !r.ym || r.ym.y !== y) { if (c && c.night) night = null; return; }
      const bucket = months[r.ym.m - 1];
      if (key === 'exat') {
        const price = c.cost === '' ? 0 : (Number(c.cost) || 0) + (Number(c.food) || 0);
        bucket.exat.push({
          no: r.no, iso: r.iso, project: r.project, expressway: r.expressway, jobType: r.jobType, place: r.place,
          worker: r.worker, qty: 1, price, amount: price, noRate: c.note === 'no-rate',
          food: c.cost === '' ? 0 : Number(c.food) || 0, // ค่าอาหาร (จุดแรกของคืน) — ใช้ใน File Clear
        });
        return;
      }
      if (c.note === 'free' || c.cost === '') { if (c.night || c.note === 'free') night = null; return; }
      if (c.night || !night || night.iso !== r.iso || night.m !== r.ym.m) {
        night = { m: r.ym.m, iso: r.iso, no: r.no, jobs: [], places: [], amount: 0,
          timeIn: hourOf_(timeOf['BEM:' + r.no], s.timeIn), timeOut: s.timeOut };
        bucket.bem.push(night);
      }
      night.jobs.push(r.jobType);
      night.places.push(r.place);
      night.amount += Number(c.cost) || 0;
    });
  });

  months.forEach(b => {
    b.exat.sort((a, c) => a.iso.localeCompare(c.iso));
    b.bem = b.bem.filter(n => n.amount > 0).sort((a, c) => a.iso.localeCompare(c.iso));
    b.exatTotal = b.exat.reduce((t, x) => t + x.amount, 0);
    b.bemTotal = b.bem.reduce((t, x) => t + x.amount, 0);
  });
  return months;
}

function accrueFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('ACCRUE_FOLDER_ID');
  if (id) {
    try {
      const f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (err) { /* สร้างใหม่ */ }
  }
  let parent = null;
  try {
    const parents = DriveApp.getFileById(spreadsheet_().getId()).getParents();
    if (parents.hasNext()) parent = parents.next();
  } catch (err) { /* ใช้ My Drive */ }
  const folder = parent ? parent.createFolder(ACCRUE_FOLDER_NAME) : DriveApp.createFolder(ACCRUE_FOLDER_NAME);
  props.setProperty('ACCRUE_FOLDER_ID', folder.getId());
  return folder;
}

function accrueFileName_(key, y, m, total) {
  const mon = TH_MONTHS_FULL[m - 1] + String((y + 543) % 100).padStart(2, '0');
  return (key === 'exat' ? 'ค่ารถคุ้มครองEXAT' : 'ค่ารถคุ้มครอง BEM') + ' (' + mon + ') = ' + Number(total).toLocaleString('en-US') + ' บาท';
}

/** สร้าง Google Sheet ตามรูปแบบไฟล์ตัวอย่าง (เก็บไว้ในโฟลเดอร์ File Accrue) แล้วส่งออกเป็น .xlsx */
function buildAccrueFile_(key, y, m, bucket) {
  const s = accrueSettings_();
  const total = key === 'exat' ? bucket.exatTotal : bucket.bemTotal;
  const name = accrueFileName_(key, y, m, total);
  const ss = SpreadsheetApp.create(name);
  try { ss.setSpreadsheetLocale('th_TH'); ss.setSpreadsheetTimeZone(CONFIG.TIMEZONE); } catch (err) { /* ใช้ค่าเริ่มต้น */ }
  const sh = ss.getSheets()[0];
  if (key === 'exat') layoutExatAccrue_(sh, y, m, bucket.exat, s);
  else layoutBemAccrue_(sh, y, m, bucket.bem);
  SpreadsheetApp.flush();
  const blob = archiveAndExport_(ss, 'ACCRUE_FILE_' + key + '_' + y + '_' + m, name);
  return { key, name: name + '.xlsx', total, count: (key === 'exat' ? bucket.exat : bucket.bem).length, url: ss.getUrl(), blob };
}

/** เก็บไฟล์ไว้ในโฟลเดอร์ File Accrue (แทนไฟล์เดิมของเดือนเดียวกัน) แล้วส่งออกเป็น .xlsx */
function archiveAndExport_(ss, prop, name) {
  const props = PropertiesService.getScriptProperties();
  const old = props.getProperty(prop);
  const file = DriveApp.getFileById(ss.getId());
  try { file.moveTo(accrueFolder_()); } catch (err) { /* อยู่ใน My Drive */ }
  if (old && old !== ss.getId()) { try { DriveApp.getFileById(old).setTrashed(true); } catch (err) { /* ลบไปแล้ว */ } }
  props.setProperty(prop, ss.getId());
  const res = UrlFetchApp.fetch('https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=xlsx', {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('ส่งออกไฟล์ Excel ไม่สำเร็จ (HTTP ' + res.getResponseCode() + ')');
  return res.getBlob().setName(name + '.xlsx');
}

function styleBlock_(range, opts) {
  range.setFontFamily(ACCRUE_FONT).setFontSize(opts.size || 16).setVerticalAlignment('middle');
  if (opts.bold) range.setFontWeight('bold');
  if (opts.align) range.setHorizontalAlignment(opts.align);
  if (opts.wrap) range.setWrap(true);
  if (opts.bg) range.setBackground(opts.bg);
  if (opts.border) range.setBorder(true, true, true, true, true, true, '#000000', SpreadsheetApp.BorderStyle.SOLID);
  return range;
}

function layoutExatAccrue_(sh, y, m, items, s) {
  sh.setName('All');
  const W = 12;
  const n = items.length;
  sh.getRange(1, 3, 1, W - 2).merge().setValue('รายการค่ารถคุ้มครองการทางพิเศษแห่งประเทศไทย ประจำเดือน : ' + TH_MONTHS_FULL[m - 1] + ' ' + (y + 543));
  styleBlock_(sh.getRange(1, 1, 1, W), { size: 20, bold: true, align: 'center' });
  sh.setRowHeight(1, 52);
  const head = ['ลำดับ', 'วันที่', 'โครงการ', 'รถคุ้มครอง', 'พื้นที่', 'ประเภทป้าย', 'ประเภทงาน', 'สถานที่', 'จำนวน\n(จุด)', 'ราคา / จุด', 'จำนวน\n(บาท)', 'ผู้ควบคุมงาน'];
  sh.getRange(3, 1, 1, W).setValues([head]);
  styleBlock_(sh.getRange(3, 1, 1, W), { bold: true, align: 'center', wrap: true, bg: '#FCE4D6', border: true });
  sh.setRowHeight(3, 48);
  if (n) {
    const values = items.map((x, i) => [i + 1, accrueDateText_(x.iso), x.project, 'EXAT', x.expressway, x.project, x.jobType, x.place, x.qty, x.price, '', x.worker]);
    sh.getRange(4, 1, n, W).setValues(values);
    sh.getRange(4, 11, n, 1).setFormulas(items.map((x, i) => ['=I' + (4 + i) + '*J' + (4 + i)]));
    styleBlock_(sh.getRange(4, 1, n, W), { align: 'center', border: true });
    styleBlock_(sh.getRange(4, 7, n, 2), { align: 'left', wrap: true });
    sh.getRange(4, 10, n, 2).setNumberFormat('#,##0');
  }
  const tr = 4 + n;
  sh.getRange(tr, 8).setValue('รวมเป็นเงินทั้งสิ้น');
  sh.getRange(tr, 11).setFormula(n ? '=SUM(K4:K' + (tr - 1) + ')' : '=0').setNumberFormat('#,##0');
  styleBlock_(sh.getRange(tr, 8, 1, 5), { bold: true, align: 'center' });
  sh.getRange(tr, 11).setBorder(null, null, true, null, null, null, '#000000', SpreadsheetApp.BorderStyle.DOUBLE);
  const sign = [
    ['ค่าใช้จ่ายดังกล่าวได้มีการตรวจสอบเรียบร้อยสามารถทำการเบิกจ่ายได้'],
    ['___________________________________\n(' + s.checker + ')'],
    ['ผู้ตรวจสอบ'],
  ];
  sign.forEach((v, i) => sh.getRange(tr + 2 + i, 8, 1, 5).merge().setValue(v[0]));
  styleBlock_(sh.getRange(tr + 2, 8, 3, 5), { align: 'center', wrap: true });
  sh.setRowHeight(tr + 3, 110);
  [62, 110, 150, 95, 105, 150, 430, 380, 80, 95, 105, 150].forEach((w, i) => sh.setColumnWidth(i + 1, w));
  sh.setFrozenRows(3);
}

function layoutBemAccrue_(sh, y, m, nights) {
  sh.setName('BEM');
  const W = 7;
  const n = nights.length;
  sh.getRange(1, 1, 1, W).merge().setValue('ตารางสรุปการใช้บริการรถคุ้มครอง บริษัท ทางด่วนและรถไฟฟ้ากรุงเทพ จำกัด(มหาชน)');
  sh.getRange(2, 1, 1, W).merge().setValue('รายละเอียดการใช้รถคุ้มครอง เดือน ' + accrueMonthShort_(y, m));
  sh.getRange(3, 1, 1, W).merge().setValue('รายละเอียดการใช้รถคุ้มครอง');
  styleBlock_(sh.getRange(1, 1, 2, W), { size: 18, bold: true, align: 'center' });
  styleBlock_(sh.getRange(3, 1, 1, W), { bold: true, align: 'center', bg: '#DDEBF7', border: true });
  sh.getRange(4, 1, 2, W).setValues([
    ['ที่', 'วันที่', 'เวลาทำงาน', '', 'รายละเอียดงาน', 'สถานที่', 'ค่าบริการ(บาท)'],
    ['', '', 'เข้า', 'ออก', '', '', ''],
  ]);
  [[4, 1, 2, 1], [4, 2, 2, 1], [4, 3, 1, 2], [4, 5, 2, 1], [4, 6, 2, 1], [4, 7, 2, 1]].forEach(a => sh.getRange(a[0], a[1], a[2], a[3]).merge());
  styleBlock_(sh.getRange(4, 1, 2, W), { bold: true, align: 'center', bg: '#DDEBF7', border: true });
  if (n) {
    const num = v => (/^\d+$/.test(String(v)) ? Number(v) : v);
    sh.getRange(6, 1, n, W).setValues(nights.map((x, i) => [i + 1, accrueDateText_(x.iso), num(x.timeIn), num(x.timeOut), x.jobs.join('\n'), x.places.join('\n'), x.amount]));
    styleBlock_(sh.getRange(6, 1, n, W), { align: 'center', border: true });
    styleBlock_(sh.getRange(6, 5, n, 2), { align: 'left', wrap: true });
    sh.getRange(6, 7, n, 1).setNumberFormat('#,##0.00');
  }
  const tr = 6 + n;
  sh.getRange(tr, 1, 1, 6).merge().setValue('รวมทั้งสิ้น');
  sh.getRange(tr, 7).setFormula(n ? '=SUM(G6:G' + (tr - 1) + ')' : '=0').setNumberFormat('#,##0.00');
  styleBlock_(sh.getRange(tr, 1, 1, W), { bold: true, align: 'center', border: true, bg: '#FFF2CC' });
  [50, 95, 70, 60, 300, 440, 120].forEach((w, i) => sh.setColumnWidth(i + 1, w));
}

function accrueLogSheet_() {
  const ss = spreadsheet_();
  let sh = ss.getSheetByName(ACCRUE_LOG_SHEET);
  if (!sh) {
    sh = ss.insertSheet(ACCRUE_LOG_SHEET);
    sh.getRange(1, 1, 1, ACCRUE_LOG_HEADERS.length).setValues([ACCRUE_LOG_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function logAccrue_(row) {
  const sh = accrueLogSheet_();
  const r = Math.max(sh.getLastRow(), 1) + 1;
  const range = sh.getRange(r, 1, 1, ACCRUE_LOG_HEADERS.length);
  range.setNumberFormat('@');
  range.setValues([row.map(longText_)]);
}

/** อีเมลแจ้ง — ครั้งแรกของเดือนตามรูปแบบเดิม · ส่งซ้ำเพราะข้อมูลเปลี่ยน = "RE: … แก้ไขเพิ่มเติม" ตามตัวอย่าง */
function accrueEmail_(y, m, s, revised) {
  const label = accrueMonthShort_(y, m);
  const base = 'นำส่ง File Accrue ค่ารถคุ้มครอง เดือน' + label;
  const subject = (revised ? 'RE: ' : '') + base;
  const lines = [['เรียน', s.greeting], ['สำเนา', s.ccLabel]];
  if (revised) lines.push(['เรื่อง', 'นำส่ง File Accrue แก้ไขเพิ่มเติม ค่ารถคุ้มครอง เดือน' + label], ['', base + '  รายละเอียดตามไฟล์แนบ']);
  else lines.push(['เรื่อง', base + '  รายละเอียดตามไฟล์แนบ']);
  const plain = lines.map(l => l[0] + '\t' + l[1]).join('\n') + '\n\n\t\t' + s.signOff;
  const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = '<div style="font-family:Tahoma,sans-serif;font-size:14px;line-height:1.9">' +
    '<table style="border-collapse:collapse">' + lines.map(l => '<tr><td style="padding:2px 28px 2px 0;vertical-align:top">' + esc(l[0]) + '</td><td style="padding:2px 0">' + esc(l[1]) + '</td></tr>').join('') + '</table>' +
    '<p style="margin:28px 0 0 120px">' + esc(s.signOff) + '</p></div>';
  return { subject, plain, html };
}

/** ลายนิ้วมือของข้อมูลเดือนนั้น — ถ้าเหมือนครั้งที่ส่งล่าสุด = ไม่มีการอัปเดต ไม่ต้องส่งซ้ำ */
function accrueHash_(bucket) {
  const data = {
    exat: bucket.exat.map(x => [x.iso, x.project, x.expressway, x.jobType, x.place, x.worker, x.qty, x.price]),
    bem: bucket.bem.map(x => [x.iso, x.timeIn, x.timeOut, x.jobs, x.places, x.amount]),
  };
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(data), Utilities.Charset.UTF_8));
}

/** สร้างไฟล์ EXAT / BEM ของเดือนนั้นแล้วส่งอีเมล — คืนผลการส่ง */
function sendAccrue_(y, m, by, bucket) {
  const s = accrueSettings_();
  const to = checkEmails_(emailList_(s.to), 'ถึง');
  const cc = checkEmails_(emailList_(s.cc), 'สำเนา');
  if (!to.length) throw new Error('ยังไม่ได้ตั้งอีเมลผู้รับ (ถึง)');
  bucket = bucket || accrueYear_(y)[m - 1];
  const props = PropertiesService.getScriptProperties();
  const revised = !!props.getProperty('ACCRUE_SENT_' + y + '_' + m);
  const files = [];
  if (bucket.exat.length) files.push(buildAccrueFile_('exat', y, m, bucket));
  if (bucket.bem.length) files.push(buildAccrueFile_('bem', y, m, bucket));
  const when = nowText_();
  const label = accrueMonthShort_(y, m);
  if (!files.length) {
    logAccrue_([when, label, by, to.join(', '), cc.join(', '), '0', '0', '', 'ไม่ได้ส่ง — ไม่มีการใช้รถคุ้มครองในเดือนนี้']);
    return { sent: false, reason: 'ไม่มีการใช้รถคุ้มครองในเดือน ' + label };
  }
  const mail = accrueEmail_(y, m, s, revised);
  const msg = { to: to.join(','), subject: mail.subject, body: mail.plain, htmlBody: mail.html, attachments: files.map(f => f.blob) };
  if (cc.length) msg.cc = cc.join(',');
  MailApp.sendEmail(msg);
  logAccrue_([when, label, by, to.join(', '), cc.join(', '), String(bucket.exatTotal), String(bucket.bemTotal), files.map(f => f.name + ' ' + f.url).join('\n'), revised ? 'ส่งแล้ว (แก้ไขเพิ่มเติม)' : 'ส่งแล้ว']);
  props.setProperty('ACCRUE_SENT_' + y + '_' + m, when);
  props.setProperty('ACCRUE_HASH_' + y + '_' + m, accrueHash_(bucket));
  return { sent: true, at: when, to, cc, subject: mail.subject, revised, files: files.map(f => ({ name: f.name, total: f.total, count: f.count })) };
}

/** วันที่ที่ตั้งให้ส่ง เช่น "21, 25, 27, 30, 31" → [21, 25, 27, 30, 31] */
function accrueDays_(s) {
  const list = String(s.sendDays || '').split(/[\s,;]+/).map(Number).filter(d => d >= 1 && d <= 31);
  return uniq_(list.length ? list : [21]).sort((a, b) => a - b);
}

/**
 * วันนี้เป็นวันส่งหรือไม่ — เดือนที่ไม่มีวันที่ 30 / 31 (เช่น ก.พ.) วันนั้นเลื่อนมาเป็นวันสุดท้ายของเดือน
 * เพื่อให้ข้อมูลที่อัปเดตช่วงปลายเดือนยังถูกส่ง
 */
function isAccrueDay_(s, y, m, d) {
  const last = new Date(y, m, 0).getDate();
  return accrueDays_(s).some(x => Math.min(x, last) === d);
}

/**
 * ตัวตั้งเวลา (ทำงานทุกวัน ช่วงเวลาที่ตั้งไว้): ถ้าวันนี้เป็นวันส่ง
 * - ยังไม่เคยส่งเดือนนี้ → ส่ง
 * - เคยส่งแล้ว และข้อมูลเปลี่ยนจากครั้งที่ส่งล่าสุด → ส่ง "แก้ไขเพิ่มเติม"
 * - ข้อมูลไม่เปลี่ยน → ไม่ส่งซ้ำ
 */
function accrueMonthlyJob() {
  const s = accrueSettings_();
  if (!s.autoSend && !s.clearAuto) return;
  const now = new Date();
  const y = Number(Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy'));
  const m = Number(Utilities.formatDate(now, CONFIG.TIMEZONE, 'M'));
  const d = Number(Utilities.formatDate(now, CONFIG.TIMEZONE, 'd'));
  const props = PropertiesService.getScriptProperties();
  const dayKey = 'ACCRUE_DAY_' + y + '_' + m + '_' + d;
  // กันส่งซ้อน (ตัวตั้งเวลาเก่า/ใหม่ หรือสั่งรันจากตัวแก้ไขพร้อมกัน)
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5 * 60 * 1000)) return;
  let error = null;
  try {
    // File Accrue ของเดือนนี้ (วันที่ตั้งไว้ · เฉพาะเมื่อข้อมูลเปลี่ยน)
    if (s.autoSend && isAccrueDay_(s, y, m, d) && !props.getProperty(dayKey)) {
      try { accrueDailyCheck_(s, y, m, props, dayKey); } catch (err) { error = err; }
    }
    // File Clear ของเดือนก่อนหน้า (วันที่ 25 · ครั้งเดียว)
    try { clearDailyCheck_(s, y, m, d, props); } catch (err) { error = error || err; }
  } finally {
    lock.releaseLock();
  }
  if (error) throw error;
}

function accrueDailyCheck_(s, y, m, props, dayKey) {
  try {
    const bucket = accrueYear_(y)[m - 1];
    const hash = accrueHash_(bucket);
    const sentAt = props.getProperty('ACCRUE_SENT_' + y + '_' + m);
    const lastHash = props.getProperty('ACCRUE_HASH_' + y + '_' + m);
    if (sentAt && !lastHash) {
      // ส่งไปก่อนมีระบบตรวจการเปลี่ยนแปลง — ใช้ข้อมูลตอนนี้เป็นจุดเริ่ม ไม่ส่งซ้ำ
      props.setProperty('ACCRUE_HASH_' + y + '_' + m, hash);
    } else if (sentAt && lastHash === hash) {
      // ไม่มีการอัปเดต
    } else if (bucket.exat.length || bucket.bem.length) {
      sendAccrue_(y, m, 'ส่งอัตโนมัติ', bucket);
    }
    props.setProperty(dayKey, nowText_());
  } catch (err) {
    logAccrue_([nowText_(), accrueMonthShort_(y, m), 'ส่งอัตโนมัติ', s.to, s.cc, '', '', '', 'ส่งไม่สำเร็จ: ' + String(err && err.message || err)]);
    throw err;
  }
}

/** เปิด / ปิด ตัวตั้งเวลา (ทำงานทุกวันตามชั่วโมงที่ตั้ง แล้วตรวจเองว่าวันนี้เป็นวันส่งหรือไม่) */
function ensureAccrueTrigger_(s) {
  const sig = s.autoSend || s.clearAuto ? 'daily@' + s.sendHour : '';
  const props = PropertiesService.getScriptProperties();
  const existing = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === ACCRUE_JOB);
  if (existing.length && props.getProperty('ACCRUE_TRIGGER') === sig) return;
  existing.forEach(t => ScriptApp.deleteTrigger(t));
  if (sig) ScriptApp.newTrigger(ACCRUE_JOB).timeBased().everyDays(1).atHour(s.sendHour).inTimezone(CONFIG.TIMEZONE).create();
  props.setProperty('ACCRUE_TRIGGER', sig);
}

/** วันส่งถัดไป (วันนี้นับด้วย ถ้ายังไม่ถึงเวลาส่ง) เป็น ISO */
function nextAccrueDay_(s, now) {
  let y = Number(Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy'));
  let m = Number(Utilities.formatDate(now, CONFIG.TIMEZONE, 'M'));
  let d = Number(Utilities.formatDate(now, CONFIG.TIMEZONE, 'd'));
  if (Number(Utilities.formatDate(now, CONFIG.TIMEZONE, 'H')) > Number(s.sendHour)) d++;
  for (let i = 0; i < 62; i++) {
    const last = new Date(y, m, 0).getDate();
    if (d > last) { d = 1; m++; if (m > 12) { m = 1; y++; } continue; }
    if (isAccrueDay_(s, y, m, d)) return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    d++;
  }
  return '';
}

function accrueTriggerOn_() {
  try { return ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === ACCRUE_JOB); } catch (err) { return false; }
}

/** ประวัติการส่ง — kind = 'accrue' หรือ 'clear' (แถว File Clear ขึ้นต้นด้วย "File Clear") */
function readAccrueLog_(kind) {
  const sh = spreadsheet_().getSheetByName(ACCRUE_LOG_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, ACCRUE_LOG_HEADERS.length).getDisplayValues()
    .map(r => ({ at: r[0], month: r[1], by: r[2], to: r[3], cc: r[4], exat: Number(r[5]) || 0, bem: Number(r[6]) || 0, files: r[7], status: r[8] }))
    .filter(x => !kind || (kind === 'clear') === /^File Clear/.test(x.month))
    .reverse().slice(0, 24);
}

function accrueSettingsOut_() {
  const s = accrueSettings_();
  return Object.assign({}, s, { triggerOn: accrueTriggerOn_() });
}

/** หน้า File Accrue: สรุปทั้งปี + รายการของเดือนที่เลือก + ตัวอย่างอีเมล */
function getAccrue(token, y, m) {
  requireUser_(token, true);
  const now = new Date();
  y = Number(y) || Number(Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy'));
  m = Number(m) || Number(Utilities.formatDate(now, CONFIG.TIMEZONE, 'M'));
  const months = accrueYear_(y);
  const props = PropertiesService.getScriptProperties();
  const b = months[m - 1];
  const s = accrueSettingsOut_();
  return {
    y, m, label: accrueMonthShort_(y, m),
    exat: { items: b.exat, total: b.exatTotal, name: accrueFileName_('exat', y, m, b.exatTotal) + '.xlsx' },
    bem: { items: b.bem, total: b.bemTotal, name: accrueFileName_('bem', y, m, b.bemTotal) + '.xlsx' },
    summary: months.map(x => {
      const sentAt = props.getProperty('ACCRUE_SENT_' + y + '_' + x.m) || '';
      const last = props.getProperty('ACCRUE_HASH_' + y + '_' + x.m);
      return { m: x.m, exatCount: x.exat.length, exatTotal: x.exatTotal, bemCount: x.bem.length, bemTotal: x.bemTotal, sentAt,
        changed: !!(sentAt && last && last !== accrueHash_(x)) };
    }),
    email: Object.assign(accrueEmail_(y, m, s, !!props.getProperty('ACCRUE_SENT_' + y + '_' + m)), { to: s.to, cc: s.cc }),
    nextSend: nextAccrueDay_(s, now),
    settings: s,
    log: readAccrueLog_('accrue'),
  };
}

/** ดาวน์โหลดไฟล์ .xlsx (base64) */
function downloadAccrue(token, y, m, key) {
  requireUser_(token, true);
  if (key !== 'exat' && key !== 'bem') throw new Error('ประเภทไฟล์ไม่ถูกต้อง');
  y = Number(y); m = Number(m);
  if (!(m >= 1 && m <= 12) || !(y > 2000)) throw new Error('เดือนไม่ถูกต้อง');
  const bucket = accrueYear_(y)[m - 1];
  const f = buildAccrueFile_(key, y, m, bucket);
  return { name: f.name, mime: f.blob.getContentType(), data: Utilities.base64Encode(f.blob.getBytes()), url: f.url };
}

/** ผู้ดูแลระบบสั่งส่งอีเมล File Accrue ทันที */
function sendAccrueNow(token, y, m) {
  const user = requireUser_(token, true);
  y = Number(y); m = Number(m);
  if (!(m >= 1 && m <= 12) || !(y > 2000)) throw new Error('เดือนไม่ถูกต้อง');
  const res = withLock_(() => sendAccrue_(y, m, user.fullName || user.username));
  audit_(user.username, 'send_accrue', ACCRUE_LOG_SHEET, '', { y, m, sent: res.sent });
  return res;
}

function saveAccrueSettings(token, form) {
  const user = requireUser_(token, true);
  form = form || {};
  const s = accrueSettings_();
  const str = (k, max) => String(form[k] === undefined || form[k] === null ? s[k] : form[k]).trim().slice(0, max || 200);
  const next = {
    to: checkEmails_(emailList_(str('to', 1000)), 'ถึง').join(', '),
    cc: checkEmails_(emailList_(str('cc', 2000)), 'สำเนา').join(', '),
    greeting: str('greeting'), ccLabel: str('ccLabel'), signOff: str('signOff'), checker: str('checker'),
    timeIn: str('timeIn', 10), timeOut: str('timeOut', 10),
    autoSend: form.autoSend === undefined ? s.autoSend : form.autoSend === true || form.autoSend === 'true' || form.autoSend === 'on',
    sendDays: accrueDays_({ sendDays: form.sendDays === undefined ? s.sendDays : form.sendDays }).join(', '),
    sendHour: Math.min(23, Math.max(0, Math.floor(Number(form.sendHour === undefined ? s.sendHour : form.sendHour)))),
    clearAuto: form.clearAuto === undefined ? s.clearAuto : form.clearAuto === true || form.clearAuto === 'true' || form.clearAuto === 'on',
    clearDay: Math.min(31, Math.max(1, Math.floor(Number(form.clearDay) || s.clearDay || 25))),
  };
  if (!next.to) throw new Error('กรุณากรอกอีเมลผู้รับ (ถึง)');
  PropertiesService.getScriptProperties().setProperty(ACCRUE_PROP, JSON.stringify(next));
  ensureAccrueTrigger_(next);
  audit_(user.username, 'accrue_settings', '', '', { to: next.to, cc: next.cc, autoSend: next.autoSend, days: next.sendDays, hour: next.sendHour });
  return accrueSettingsOut_();
}

/** รันครั้งเดียวจากตัวแก้ไข: ให้สิทธิ์ (อีเมล / ตัวตั้งเวลา / ส่งออกไฟล์) และเปิดการส่งอัตโนมัติทุกวันที่ 21 */
function setupAccrue() {
  ensureAccrueTrigger_(accrueSettings_());
  accrueFolder_();
  UrlFetchApp.fetch('https://www.googleapis.com/discovery/v1/apis', { muteHttpExceptions: true });
  console.log('MailApp เหลือโควตาวันนี้: ' + MailApp.getRemainingDailyQuota() + ' ฉบับ · ตัวตั้งเวลา: ' + (accrueTriggerOn_() ? 'เปิด' : 'ปิด'));
}

/* ------------------------------------------------------------------ */
/* File Clear — สรุป EXAT ของเดือนก่อนหน้า เพื่อสั่งจ่ายเช็คให้การทางพิเศษฯ (ส่งทุกวันที่ 25)    */
/* ------------------------------------------------------------------ */

const CLEAR_WAYS = ['ฉลองรัช', 'เฉลิมมหานคร', 'ศรีรัช'];

function prevMonth_(y, m) { return m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 }; }

function money_(n) { return Number(n || 0).toLocaleString('en-US'); }

/** รายการ EXAT ของเดือน + สรุปแยกสายทาง (จำนวน − ค่าอาหาร = คงเหลือ ที่ต้องสั่งจ่าย) */
function clearData_(bucket) {
  const items = bucket.exat;
  const ways = CLEAR_WAYS.slice();
  items.forEach(x => { if (x.expressway && !ways.some(w => norm_(w) === norm_(x.expressway))) ways.push(x.expressway); });
  const byWay = ways.map(w => {
    const xs = items.filter(x => norm_(x.expressway) === norm_(w));
    const amount = xs.reduce((t, x) => t + x.price, 0);
    const food = xs.reduce((t, x) => t + (x.food || 0), 0);
    return { way: w, amount, food, net: amount - food };
  });
  const amount = items.reduce((t, x) => t + x.price, 0);
  const food = items.reduce((t, x) => t + (x.food || 0), 0);
  return { items, byWay, amount, food, net: amount - food };
}

function clearFileName_(y, m) {
  return 'File Clear ค่ารถคุ้มครองเดือน ' + THAI_MONTHS[m - 1] + ' ' + String((y + 543) % 100).padStart(2, '0');
}

function layoutClear_(sh, y, m, data) {
  sh.setName('All');
  const W = 12;
  const items = data.items;
  const n = items.length;
  sh.getRange(1, 1, 1, W).merge().setValue('รายการค่ารถคุ้มครองการทางพิเศษแห่งประเทศไทย ประจำเดือน : ' + TH_MONTHS_FULL[m - 1] + ' ' + (y + 543));
  styleBlock_(sh.getRange(1, 1, 1, W), { size: 20, bold: true, align: 'center' });
  sh.setRowHeight(1, 52);
  const head = ['ลำดับ', 'วันที่', 'โครงการ', 'EXAT/BEM', 'พื้นที่', 'ประเภทป้าย', 'ประเภทงาน', 'สถานที่', 'จำนวน\n(จุด)', 'ราคา / จุด', 'ค่าอาหาร', 'ผู้ควบคุมงาน'];
  sh.getRange(3, 1, 1, W).setValues([head]);
  styleBlock_(sh.getRange(3, 1, 1, W), { bold: true, align: 'center', wrap: true, bg: '#FCE4D6', border: true });
  sh.setRowHeight(3, 48);
  if (n) {
    sh.getRange(4, 1, n, W).setValues(items.map((x, i) => [i + 1, accrueDateText_(x.iso), x.project, 'EXAT', x.expressway, x.project, x.jobType, x.place, x.qty, x.price, x.food || 0, x.worker]));
    styleBlock_(sh.getRange(4, 1, n, W), { align: 'center', border: true });
    styleBlock_(sh.getRange(4, 7, n, 2), { align: 'left', wrap: true });
    sh.getRange(4, 10, n, 2).setNumberFormat('#,##0');
  }
  const tr = 4 + n;
  sh.getRange(tr, 8).setValue('รวม');
  sh.getRange(tr, 10).setFormula(n ? '=SUM(J4:J' + (tr - 1) + ')' : '=0');
  sh.getRange(tr, 11).setFormula(n ? '=SUM(K4:K' + (tr - 1) + ')' : '=0');
  sh.getRange(tr, 10, 1, 2).setNumberFormat('#,##0');
  styleBlock_(sh.getRange(tr, 8, 1, 4), { bold: true, align: 'center' });

  // สรุปแยกสายทาง (คงเหลือ = จำนวน − ค่าอาหาร = ยอดสั่งจ่ายเช็ค)
  const s0 = tr + 5;
  sh.getRange(s0, 8, 1, 4).setValues([['สายทาง', 'จำนวน', 'ค่าอาหาร', 'คงเหลือ']]);
  styleBlock_(sh.getRange(s0, 8, 1, 4), { bold: true, align: 'center', bg: '#DDEBF7', border: true });
  const k = data.byWay.length;
  sh.getRange(s0 + 1, 8, k, 3).setValues(data.byWay.map(w => [w.way, w.amount, w.food]));
  sh.getRange(s0 + 1, 11, k, 1).setFormulas(data.byWay.map((w, i) => ['=I' + (s0 + 1 + i) + '-J' + (s0 + 1 + i)]));
  const st = s0 + 1 + k;
  sh.getRange(st, 8).setValue('รวม');
  sh.getRange(st, 9, 1, 3).setFormulas([['=SUM(I' + (s0 + 1) + ':I' + (st - 1) + ')', '=SUM(J' + (s0 + 1) + ':J' + (st - 1) + ')', '=SUM(K' + (s0 + 1) + ':K' + (st - 1) + ')']]);
  styleBlock_(sh.getRange(s0 + 1, 8, k + 1, 4), { align: 'center', border: true });
  styleBlock_(sh.getRange(st, 8, 1, 4), { bold: true, bg: '#FFF2CC' });
  sh.getRange(s0 + 1, 9, k + 1, 3).setNumberFormat('#,##0');
  [62, 110, 150, 95, 105, 150, 380, 430, 80, 95, 95, 150].forEach((w, i) => sh.setColumnWidth(i + 1, w));
  sh.setFrozenRows(3);
}

function buildClearFile_(y, m, bucket) {
  const data = clearData_(bucket);
  const name = clearFileName_(y, m);
  const ss = SpreadsheetApp.create(name);
  try { ss.setSpreadsheetLocale('th_TH'); ss.setSpreadsheetTimeZone(CONFIG.TIMEZONE); } catch (err) { /* ใช้ค่าเริ่มต้น */ }
  layoutClear_(ss.getSheets()[0], y, m, data);
  SpreadsheetApp.flush();
  const blob = archiveAndExport_(ss, 'CLEAR_FILE_' + y + '_' + m, name);
  return { name: name + '.xlsx', data, url: ss.getUrl(), blob };
}

/** อีเมล File Clear ตามข้อความที่กำหนด */
function clearEmail_(y, m, s, data, revised) {
  const mon = TH_MONTHS_FULL[m - 1];
  const yr = y + 543;
  const subject = (revised ? 'RE: ' : '') + 'นำส่ง File Clear ค่ารถคุ้มครอง เดือน' + mon + ' ปี ' + yr;
  const intro = (revised ? 'นำส่ง File Clear แก้ไขเพิ่มเติม ค่ารถคุ้มครอง เดือน ' : 'นำส่ง File Clear ค่ารถคุ้มครอง เดือน ') + mon + ' ปี ' + yr + ' พร้อมรายละเอียดดังนี้';
  const detail = ['สรุปค่ารถคุ้มครอง เดือน ' + mon + ' ' + yr]
    .concat(data.byWay.map(w => '- ' + w.way + ' จำนวน ' + money_(w.net) + ' บาท'));
  const total = 'รวม ' + money_(data.net) + ' บาท';
  const plain = 'เรียน\t' + s.greeting + '\nสำเนา\t' + s.ccLabel + '\nเรื่อง\tนำส่ง File Clear ค่ารถคุ้มครอง เดือน' + mon + ' ปี ' + yr +
    '\n\t' + intro + '\n\nรายละเอียด\n\n' + detail.join('\n') + '\n\n' + total + '\n\n\t\t' + s.signOff;
  const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const row = (a, b) => '<tr><td style="padding:2px 28px 2px 0;vertical-align:top">' + esc(a) + '</td><td style="padding:2px 0">' + esc(b) + '</td></tr>';
  const html = '<div style="font-family:Tahoma,sans-serif;font-size:14px;line-height:1.9">' +
    '<table style="border-collapse:collapse">' + row('เรียน', s.greeting) + row('สำเนา', s.ccLabel) +
    row('เรื่อง', 'นำส่ง File Clear ค่ารถคุ้มครอง เดือน' + mon + ' ปี ' + yr) + row('', intro) + '</table>' +
    '<p style="margin:16px 0 4px"><b>รายละเอียด</b></p>' +
    '<p style="margin:0">' + detail.map(esc).join('<br>') + '</p>' +
    '<p style="margin:12px 0 0"><b>' + esc(total) + '</b></p>' +
    '<p style="margin:28px 0 0 120px">' + esc(s.signOff) + '</p></div>';
  return { subject, plain, html };
}

/** สร้าง File Clear ของเดือน y/m แล้วส่งอีเมล */
function sendClear_(y, m, by) {
  const s = accrueSettings_();
  const to = checkEmails_(emailList_(s.to), 'ถึง');
  const cc = checkEmails_(emailList_(s.cc), 'สำเนา');
  if (!to.length) throw new Error('ยังไม่ได้ตั้งอีเมลผู้รับ (ถึง)');
  const bucket = accrueYear_(y)[m - 1];
  const props = PropertiesService.getScriptProperties();
  const when = nowText_();
  const label = 'File Clear ' + accrueMonthShort_(y, m);
  if (!bucket.exat.length) {
    logAccrue_([when, label, by, to.join(', '), cc.join(', '), '0', '', '', 'ไม่ได้ส่ง — ไม่มีการใช้รถคุ้มครอง EXAT ในเดือนนี้']);
    return { sent: false, reason: 'ไม่มีการใช้รถคุ้มครอง EXAT ในเดือน ' + accrueMonthShort_(y, m) };
  }
  const revised = !!props.getProperty('CLEAR_SENT_' + y + '_' + m);
  const f = buildClearFile_(y, m, bucket);
  const mail = clearEmail_(y, m, s, f.data, revised);
  const msg = { to: to.join(','), subject: mail.subject, body: mail.plain, htmlBody: mail.html, attachments: [f.blob] };
  if (cc.length) msg.cc = cc.join(',');
  MailApp.sendEmail(msg);
  logAccrue_([when, label, by, to.join(', '), cc.join(', '), String(f.data.net), '', f.name + ' ' + f.url, revised ? 'ส่งแล้ว (แก้ไขเพิ่มเติม)' : 'ส่งแล้ว']);
  props.setProperty('CLEAR_SENT_' + y + '_' + m, when);
  return { sent: true, at: when, to, cc, subject: mail.subject, revised, file: f.name, net: f.data.net };
}

/**
 * ตรวจรายวัน: ตั้งแต่วันที่ส่ง (ค่าเริ่มต้น 25) ของเดือนนี้ ถ้ายังไม่เคยส่ง File Clear ของเดือนก่อนหน้า → ส่ง (ครั้งเดียว)
 * ส่งไม่สำเร็จจะลองใหม่วันถัดไป
 */
function clearDailyCheck_(s, y, m, d, props) {
  if (!s.clearAuto) return;
  const last = new Date(y, m, 0).getDate();
  if (d < Math.min(Number(s.clearDay) || 25, last)) return;
  const p = prevMonth_(y, m);
  if (props.getProperty('CLEAR_SENT_' + p.y + '_' + p.m)) return;
  const dayKey = 'CLEAR_DAY_' + y + '_' + m + '_' + d;
  if (props.getProperty(dayKey)) return;
  props.setProperty(dayKey, nowText_());
  try {
    const res = sendClear_(p.y, p.m, 'ส่งอัตโนมัติ');
    if (!res.sent) props.setProperty('CLEAR_SENT_' + p.y + '_' + p.m, 'ไม่มีรายการ ' + nowText_()); // ไม่ต้องตรวจซ้ำทุกวัน
  } catch (err) {
    logAccrue_([nowText_(), 'File Clear ' + accrueMonthShort_(p.y, p.m), 'ส่งอัตโนมัติ', s.to, s.cc, '', '', '', 'ส่งไม่สำเร็จ: ' + String(err && err.message || err)]);
    throw err;
  }
}

/** วันส่ง File Clear ของเดือน y/m (วันที่ตั้งไว้ของเดือนถัดไป) เป็น ISO */
function clearDueDate_(y, m, s) {
  const due = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  const d = Math.min(Number(s.clearDay) || 25, new Date(due.y, due.m, 0).getDate());
  return due.y + '-' + String(due.m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

/** หน้า File Clear: สรุปทั้งปี + รายการ EXAT ของเดือนที่เลือก + ตัวอย่างอีเมล */
function getClear(token, y, m) {
  requireUser_(token, true);
  const now = new Date();
  if (!Number(y) || !Number(m)) { // ค่าเริ่มต้น = เดือนก่อนหน้า (เดือนที่จะส่ง File Clear รอบถัดไป)
    const p = prevMonth_(Number(Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy')), Number(Utilities.formatDate(now, CONFIG.TIMEZONE, 'M')));
    y = Number(y) || p.y;
    m = Number(m) || p.m;
  }
  y = Number(y); m = Number(m);
  const months = accrueYear_(y);
  const props = PropertiesService.getScriptProperties();
  const s = accrueSettingsOut_();
  const data = clearData_(months[m - 1]);
  const sentAt = props.getProperty('CLEAR_SENT_' + y + '_' + m) || '';
  return {
    y, m, label: accrueMonthShort_(y, m),
    items: data.items, byWay: data.byWay, amount: data.amount, food: data.food, net: data.net,
    name: clearFileName_(y, m) + '.xlsx', sentAt, dueDate: clearDueDate_(y, m, s),
    email: Object.assign(clearEmail_(y, m, s, data, !!sentAt), { to: s.to, cc: s.cc }),
    summary: months.map(x => {
      const d = clearData_(x);
      return { m: x.m, count: d.items.length, amount: d.amount, food: d.food, net: d.net,
        sentAt: props.getProperty('CLEAR_SENT_' + y + '_' + x.m) || '', dueDate: clearDueDate_(y, x.m, s) };
    }),
    settings: s,
    log: readAccrueLog_('clear'),
  };
}

/** ดาวน์โหลด File Clear (.xlsx) ของเดือน y/m */
function downloadClear(token, y, m) {
  requireUser_(token, true);
  y = Number(y); m = Number(m);
  if (!(m >= 1 && m <= 12) || !(y > 2000)) throw new Error('เดือนไม่ถูกต้อง');
  const f = buildClearFile_(y, m, accrueYear_(y)[m - 1]);
  return { name: f.name, mime: f.blob.getContentType(), data: Utilities.base64Encode(f.blob.getBytes()), url: f.url };
}

/** ผู้ดูแลระบบสั่งส่ง File Clear ของเดือน y/m ทันที */
function sendClearNow(token, y, m) {
  const user = requireUser_(token, true);
  y = Number(y); m = Number(m);
  if (!(m >= 1 && m <= 12) || !(y > 2000)) throw new Error('เดือนไม่ถูกต้อง');
  const res = withLock_(() => sendClear_(y, m, user.fullName || user.username));
  audit_(user.username, 'send_clear', ACCRUE_LOG_SHEET, '', { y, m, sent: res.sent, net: res.net || 0 });
  return res;
}


/* ------------------------------------------------------------------ */
/* วันหยุดนักขัตฤกษ์ — เก็บในแท็บ "วันหยุดนักขัตฤกษ์" (แก้ไข/เพิ่มได้จากหน้า ตารางจอง โดยผู้ดูแลระบบ) */
/* ------------------------------------------------------------------ */

const HOLIDAY_SHEET = 'วันหยุดนักขัตฤกษ์';
const HOLIDAY_HEADERS = ['วันที่', 'ชื่อวันหยุด', 'ประเภท', 'ที่มา'];
const HOLIDAY_TYPES = ['วันหยุด', 'ชดเชย', 'พิเศษ', 'บริษัท']; // บริษัท = วันหยุดของบริษัท (คำสั่งบริษัท)
const BOT_2569 = 'ประกาศ ธปท. ที่ 31/2568 (วันหยุดสถาบันการเงิน ปี 2569)';
const BOT_2570 = 'ประกาศ ธปท. ที่ 37/2569 (วันหยุดสถาบันการเงิน ปี 2570)';
const BOT_WEEKEND = ' — ตรงวันหยุดสุดสัปดาห์ (ระบุในวันชดเชยของประกาศ)';
// ที่มา: หน้า "วันหยุดของสถาบันการเงิน" ของธนาคารแห่งประเทศไทย (bot.or.th) ตรวจเมื่อ 21 ต.ค. 2569
const HOLIDAY_SEED = [
  ['2026-01-01', 'วันขึ้นปีใหม่', 'วันหยุด', BOT_2569],
  ['2026-01-02', 'วันหยุดพิเศษ (เพิ่มเป็นกรณีพิเศษ)', 'พิเศษ', BOT_2569],
  ['2026-03-03', 'วันมาฆบูชา', 'วันหยุด', BOT_2569],
  ['2026-04-06', 'วันจักรี', 'วันหยุด', BOT_2569],
  ['2026-04-13', 'วันสงกรานต์', 'วันหยุด', BOT_2569],
  ['2026-04-14', 'วันสงกรานต์', 'วันหยุด', BOT_2569],
  ['2026-04-15', 'วันสงกรานต์', 'วันหยุด', BOT_2569],
  ['2026-05-01', 'วันแรงงานแห่งชาติ', 'วันหยุด', BOT_2569],
  ['2026-05-04', 'วันฉัตรมงคล', 'วันหยุด', BOT_2569],
  ['2026-05-31', 'วันวิสาขบูชา', 'วันหยุด', BOT_2569 + BOT_WEEKEND],
  ['2026-06-01', 'ชดเชยวันวิสาขบูชา', 'ชดเชย', BOT_2569],
  ['2026-06-03', 'วันเฉลิมพระชนมพรรษา พระบรมราชินี', 'วันหยุด', BOT_2569],
  ['2026-07-28', 'วันเฉลิมพระชนมพรรษา พระบาทสมเด็จพระเจ้าอยู่หัว', 'วันหยุด', BOT_2569],
  ['2026-07-29', 'วันอาสาฬหบูชา', 'วันหยุด', BOT_2569],
  ['2026-08-12', 'วันแม่แห่งชาติ', 'วันหยุด', BOT_2569],
  ['2026-10-13', 'วันนวมินทรมหาราช', 'วันหยุด', BOT_2569],
  ['2026-10-16', 'วันหยุดพิเศษ สถาบันการเงินในกรุงเทพฯ', 'พิเศษ', 'ประกาศ ธปท. ที่ 26/2569'],
  ['2026-10-23', 'วันปิยมหาราช', 'วันหยุด', BOT_2569],
  ['2026-12-05', 'วันพ่อแห่งชาติ', 'วันหยุด', BOT_2569 + BOT_WEEKEND],
  ['2026-12-07', 'ชดเชยวันพ่อแห่งชาติ', 'ชดเชย', BOT_2569],
  ['2026-12-10', 'วันรัฐธรรมนูญ', 'วันหยุด', BOT_2569],
  ['2026-12-31', 'วันสิ้นปี', 'วันหยุด', BOT_2569],
  ['2027-01-01', 'วันขึ้นปีใหม่', 'วันหยุด', BOT_2570],
  ['2027-02-21', 'วันมาฆบูชา', 'วันหยุด', BOT_2570 + BOT_WEEKEND],
  ['2027-02-22', 'ชดเชยวันมาฆบูชา', 'ชดเชย', BOT_2570],
  ['2027-04-06', 'วันจักรี', 'วันหยุด', BOT_2570],
  ['2027-04-13', 'วันสงกรานต์', 'วันหยุด', BOT_2570],
  ['2027-04-14', 'วันสงกรานต์', 'วันหยุด', BOT_2570],
  ['2027-04-15', 'วันสงกรานต์', 'วันหยุด', BOT_2570],
  ['2027-05-01', 'วันแรงงานแห่งชาติ', 'วันหยุด', BOT_2570 + BOT_WEEKEND],
  ['2027-05-03', 'ชดเชยวันแรงงานแห่งชาติ', 'ชดเชย', BOT_2570],
  ['2027-05-04', 'วันฉัตรมงคล', 'วันหยุด', BOT_2570],
  ['2027-05-20', 'วันวิสาขบูชา', 'วันหยุด', BOT_2570],
  ['2027-06-03', 'วันเฉลิมพระชนมพรรษา พระบรมราชินี', 'วันหยุด', BOT_2570],
  ['2027-07-18', 'วันอาสาฬหบูชา', 'วันหยุด', BOT_2570 + BOT_WEEKEND],
  ['2027-07-19', 'ชดเชยวันอาสาฬหบูชา', 'ชดเชย', BOT_2570],
  ['2027-07-28', 'วันเฉลิมพระชนมพรรษา พระบาทสมเด็จพระเจ้าอยู่หัว', 'วันหยุด', BOT_2570],
  ['2027-08-12', 'วันแม่แห่งชาติ', 'วันหยุด', BOT_2570],
  ['2027-10-13', 'วันนวมินทรมหาราช', 'วันหยุด', BOT_2570],
  ['2027-10-23', 'วันปิยมหาราช', 'วันหยุด', BOT_2570 + BOT_WEEKEND],
  ['2027-10-25', 'ชดเชยวันปิยมหาราช', 'ชดเชย', BOT_2570],
  ['2027-12-05', 'วันพ่อแห่งชาติ', 'วันหยุด', BOT_2570 + BOT_WEEKEND],
  ['2027-12-06', 'ชดเชยวันพ่อแห่งชาติ', 'ชดเชย', BOT_2570],
  ['2027-12-10', 'วันรัฐธรรมนูญ', 'วันหยุด', BOT_2570],
  ['2027-12-31', 'วันสิ้นปี', 'วันหยุด', BOT_2570],
];

// วันหยุดของบริษัท (แพลน บี มีเดีย และบริษัทในเครือ) — คำสั่งบริษัท ที่ 006/2568 ลงวันที่ 21 ต.ค. 2568
const COMPANY_2569 = 'คำสั่งบริษัท ที่ 006/2568 (วันหยุดประจำปี 2569)';
const HOLIDAY_SEED_COMPANY_2569 = [
  ['2026-01-01', 'วันขึ้นปีใหม่'],
  ['2026-03-03', 'วันมาฆบูชา'],
  ['2026-04-13', 'วันสงกรานต์'],
  ['2026-04-14', 'วันสงกรานต์'],
  ['2026-04-15', 'วันสงกรานต์'],
  ['2026-05-01', 'วันแรงงานแห่งชาติ'],
  ['2026-06-03', 'วันเฉลิมพระชนมพรรษา พระบรมราชินี'],
  ['2026-07-28', 'วันเฉลิมพระชนมพรรษา พระบาทสมเด็จพระเจ้าอยู่หัว'],
  ['2026-07-29', 'วันอาสาฬหบูชา'],
  ['2026-08-12', 'วันแม่แห่งชาติ'],
  ['2026-10-13', 'วันนวมินทรมหาราช'],
  ['2026-10-23', 'วันปิยมหาราช'],
  ['2026-12-07', 'ชดเชยวันพ่อแห่งชาติ'],
  ['2026-12-10', 'วันรัฐธรรมนูญ'],
  ['2026-12-30', 'วันสิ้นปี (เพิ่มเติม)'],
  ['2026-12-31', 'วันสิ้นปี'],
].map(r => [r[0], r[1], 'บริษัท', COMPANY_2569]);
// ชุดข้อมูลที่เพิ่มภายหลัง — ใส่ลงแท็บที่มีอยู่แล้วครั้งเดียว (ถ้าผู้ดูแลระบบลบภายหลัง จะไม่ถูกเพิ่มกลับ)
const HOLIDAY_SEED_EXTRA = [{ key: 'HOLIDAY_SEED_COMPANY_2569', rows: HOLIDAY_SEED_COMPANY_2569 }];

/** แท็บวันหยุด — สร้างพร้อมข้อมูลปี 2569–2570 ครั้งแรก และเติมชุดข้อมูลใหม่ที่ยังไม่เคยใส่ */
function holidaySheet_() {
  const ss = spreadsheet_();
  let sh = ss.getSheetByName(HOLIDAY_SHEET);
  if (!sh) {
    sh = ss.insertSheet(HOLIDAY_SHEET);
    sh.getRange(1, 1, 1, HOLIDAY_HEADERS.length).setValues([HOLIDAY_HEADERS]).setFontWeight('bold');
    sh.getRange(2, 1, HOLIDAY_SEED.length, HOLIDAY_HEADERS.length).setNumberFormat('@').setValues(HOLIDAY_SEED);
    sh.setFrozenRows(1);
  }
  const props = PropertiesService.getScriptProperties();
  HOLIDAY_SEED_EXTRA.forEach(seed => {
    if (props.getProperty(seed.key)) return;
    const have = {};
    if (sh.getLastRow() >= 2) {
      sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach(r => {
        const d = r[0] instanceof Date ? Utilities.formatDate(r[0], sheetTz_(), 'yyyy-MM-dd') : String(r[0]).trim();
        have[d + '|' + String(r[1]).trim() + '|' + String(r[2]).trim()] = 1;
      });
    }
    const rows = seed.rows.filter(r => !have[r[0] + '|' + r[1] + '|' + r[2]]);
    if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, HOLIDAY_HEADERS.length).setNumberFormat('@').setValues(rows);
    props.setProperty(seed.key, nowText_());
  });
  return sh;
}

function readHolidays_() {
  const sh = holidaySheet_();
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, HOLIDAY_HEADERS.length).getValues().map((r, i) => {
    const date = r[0] instanceof Date ? Utilities.formatDate(r[0], sheetTz_(), 'yyyy-MM-dd') : dateIsoOf_('', String(r[0]).trim()) || String(r[0]).trim();
    return { row: i + 2, date, name: String(r[1] || '').trim(), type: String(r[2] || '').trim() || 'วันหยุด', source: String(r[3] || '').trim() };
  }).filter(h => /^\d{4}-\d{2}-\d{2}$/.test(h.date) && h.name)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function holidaysBetween_(from, to) {
  return readHolidays_().filter(h => (!from || h.date >= from) && (!to || h.date <= to))
    .map(h => ({ date: h.date, name: h.name, type: h.type, source: h.source }));
}

/** ผู้ดูแลระบบเพิ่ม / แก้ไขวันหยุด (วันเดียวกันชื่อเดียวกัน = แก้ไข) */
function saveHoliday(token, form) {
  const user = requireUser_(token, true);
  form = form || {};
  const date = String(form.date || '').trim();
  parseDate_(date);
  const name = text_(form.name).slice(0, 120);
  if (!name) throw new Error('กรุณากรอกชื่อวันหยุด');
  const type = HOLIDAY_TYPES.indexOf(form.type) >= 0 ? form.type : 'พิเศษ';
  const source = text_(form.source || ('เพิ่มโดย ' + (user.fullName || user.username))).slice(0, 200);
  return withLock_(() => {
    const sh = holidaySheet_();
    const cur = readHolidays_().find(h => h.date === date && h.type === type && (h.name === name || form.original === h.name));
    const row = cur ? cur.row : Math.max(sh.getLastRow(), 1) + 1;
    sh.getRange(row, 1, 1, HOLIDAY_HEADERS.length).setNumberFormat('@').setValues([[date, name, type, source]]);
    audit_(user.username, cur ? 'update_holiday' : 'add_holiday', HOLIDAY_SHEET, row, { date, name, type });
    return holidaysBetween_(date.slice(0, 4) + '-01-01', date.slice(0, 4) + '-12-31');
  });
}

function deleteHoliday(token, date, name, type) {
  const user = requireUser_(token, true);
  date = String(date || '').trim();
  return withLock_(() => {
    const sh = holidaySheet_();
    const cur = readHolidays_().find(h => h.date === date && h.name === String(name || '').trim() && (!type || h.type === type));
    if (!cur) throw new Error('ไม่พบวันหยุดนี้');
    sh.deleteRow(cur.row);
    audit_(user.username, 'delete_holiday', HOLIDAY_SHEET, cur.row, { date, name: cur.name, type: cur.type });
    return holidaysBetween_(date.slice(0, 4) + '-01-01', date.slice(0, 4) + '-12-31');
  });
}

/** วันหยุดทั้งปี (สำหรับรายการจัดการ) */
function listHolidays(token, year) {
  requireUser_(token);
  const y = Number(year) || Number(Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy'));
  return holidaysBetween_(y + '-01-01', y + '-12-31');
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
    requestedRole: u.requestedRole === 'admin' ? 'admin' : 'user',
    reviewedBy: String(u.reviewedBy || ''),
    reviewedAt: formatDateTime_(u.reviewedAt),
    resetRequestedAt: PropertiesService.getScriptProperties().getProperty('RESET_REQ_' + u.username) || '',
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
    if (user.status === 'pending' || user.status === 'rejected') throw new Error('บัญชีนี้ยังไม่ได้รับการยืนยัน — ใช้ปุ่มอนุมัติ / ไม่อนุมัติ');
    if (changes.status !== undefined && changes.status !== 'active' && changes.status !== 'disabled') throw new Error('สถานะไม่ถูกต้อง');
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

/**
 * ผู้ดูแลระบบยืนยันผู้สมัคร: decision = approve (เลือกประเภท admin / user ได้) หรือ reject
 * ยืนยันได้เฉพาะบัญชีที่รออนุมัติหรือเคยไม่อนุมัติ — บันทึกผู้ยืนยัน เวลา และประเภทลง AuditLog
 */
function reviewUser(token, username, decision, role) {
  const admin = requireUser_(token, true);
  username = cleanUsername_(username);
  if (username === admin.username) throw new Error('ไม่สามารถยืนยันบัญชีของตัวเองได้');
  if (decision !== 'approve' && decision !== 'reject') throw new Error('ผลการพิจารณาไม่ถูกต้อง');
  return withLock_(() => {
    const sh = usersSheet_();
    const user = readUsers_(sh).find(u => u.username === username);
    if (!user) throw new Error('ไม่พบผู้ใช้');
    if (user.status !== 'pending' && user.status !== 'rejected') throw new Error('บัญชีนี้ได้รับการยืนยันไปแล้ว');
    const requested = user.requestedRole === 'admin' ? 'admin' : 'user';
    const finalRole = decision === 'approve' ? (ROLES.indexOf(role) >= 0 ? role : requested) : user.role || 'user';
    const col = h => USER_HEADERS.indexOf(h) + 1;
    if (sh.getLastColumn() < USER_HEADERS.length) sh.getRange(1, 1, 1, USER_HEADERS.length).setValues([USER_HEADERS]);
    sh.getRange(user.row, col('role')).setValue(finalRole);
    sh.getRange(user.row, col('status')).setValue(decision === 'approve' ? 'active' : 'rejected');
    sh.getRange(user.row, col('requestedRole')).setValue(requested);
    sh.getRange(user.row, col('reviewedBy')).setValue(text_(admin.fullName || admin.username));
    sh.getRange(user.row, col('reviewedAt')).setValue(new Date());
    audit_(admin.username, decision === 'approve' ? 'approve_user' : 'reject_user', CONFIG.USERS_SHEET, user.row,
      { username, requestedRole: requested, role: decision === 'approve' ? finalRole : '' });
    return { username, status: decision === 'approve' ? 'active' : 'rejected', role: finalRole };
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
    CacheService.getScriptCache().remove('fail_' + username);
    PropertiesService.getScriptProperties().deleteProperty('RESET_REQ_' + username);
    audit_(admin.username, 'reset_password', CONFIG.USERS_SHEET, user.row, { username });
    return temp;
  });
}

/* ------------------------------------------------------------------ */
/* ลืมรหัสผ่าน — เสนอให้รีเซ็ตเมื่อใส่ผิดครบ 3 ครั้ง (ล็อก 15 นาทีเมื่อครบ 5 ครั้ง)          */
/* ------------------------------------------------------------------ */

const RESET_OFFER_AFTER = 3;
const RESET_TOKEN_SECONDS = 30 * 60;
const RESET_REQUEST_GAP_SECONDS = 5 * 60; // ส่งคำขอได้ 1 ครั้งต่อ 5 นาทีต่อชื่อผู้ใช้
const DEFAULT_APP_URL = 'https://protectionfee.vercel.app/';
const RESET_SENT_MESSAGE = 'ถ้ามีบัญชีนี้ ระบบส่งลิงก์รีเซ็ตรหัสผ่านไปที่อีเมลของบัญชีแล้ว (ใช้ได้ 30 นาที) — ถ้าบัญชีไม่มีอีเมล ระบบแจ้งผู้ดูแลระบบให้รีเซ็ตให้';

function sha256_(s) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8));
}

/** ลิงก์ในอีเมลใช้ที่อยู่เว็บที่ตั้งไว้เท่านั้น (Script Property APP_URL) — ไม่รับจากผู้ร้องขอ */
function appUrl_() {
  const u = String(PropertiesService.getScriptProperties().getProperty('APP_URL') || DEFAULT_APP_URL).trim();
  return u.replace(/[?#].*$/, '');
}

/** ขอรีเซ็ตรหัสผ่าน — ตอบข้อความเดียวกันเสมอ ไม่บอกว่ามีชื่อผู้ใช้นี้หรือไม่ */
function requestPasswordReset(username) {
  username = cleanUsername_(username);
  if (!username) throw new Error('กรุณากรอกชื่อผู้ใช้');
  const cache = CacheService.getScriptCache();
  const gapKey = 'rstgap_' + username;
  if (cache.get(gapKey)) return { message: RESET_SENT_MESSAGE };
  cache.put(gapKey, '1', RESET_REQUEST_GAP_SECONDS);

  const user = readUsers_(usersSheet_()).find(u => u.username === username);
  if (!user || user.status !== 'active') {
    audit_(username, 'reset_request', CONFIG.USERS_SHEET, user ? user.row : '', { result: user ? 'not_active' : 'no_user' });
    return { message: RESET_SENT_MESSAGE };
  }
  const email = String(user.email || '').trim();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    cache.put('rst_' + sha256_(token), username, RESET_TOKEN_SECONDS); // เก็บเฉพาะค่าแฮชของโทเคน
    const link = appUrl_() + '?reset=' + token;
    const name = String(user.fullName || username);
    MailApp.sendEmail({
      to: email,
      subject: 'Protection Fee — ลิงก์ตั้งรหัสผ่านใหม่',
      body: 'เรียน ' + name + '\n\nมีคำขอตั้งรหัสผ่านใหม่สำหรับบัญชี ' + username + '\nกดลิงก์นี้ภายใน 30 นาที (ใช้ได้ครั้งเดียว):\n' + link +
        '\n\nถ้าคุณไม่ได้ขอ ไม่ต้องทำอะไร รหัสผ่านเดิมยังใช้ได้',
      htmlBody: '<div style="font-family:Tahoma,sans-serif;font-size:14px;line-height:1.8">เรียน ' + text_(name).replace(/</g, '&lt;') +
        '<br><br>มีคำขอตั้งรหัสผ่านใหม่สำหรับบัญชี <b>' + username + '</b><br>' +
        '<a href="' + link + '" style="display:inline-block;margin:12px 0;padding:10px 18px;background:#14532d;color:#fff;border-radius:8px;text-decoration:none">ตั้งรหัสผ่านใหม่</a><br>' +
        'ลิงก์ใช้ได้ 30 นาที และใช้ได้ครั้งเดียว — ถ้าคุณไม่ได้ขอ ไม่ต้องทำอะไร รหัสผ่านเดิมยังใช้ได้</div>',
    });
    audit_(username, 'reset_request', CONFIG.USERS_SHEET, user.row, { via: 'email' });
  } else {
    // ไม่มีอีเมล: แจ้งผู้ดูแลระบบ (แสดงในหน้า ผู้ใช้ + อีเมลถึงผู้ดูแลระบบที่มีอีเมล)
    PropertiesService.getScriptProperties().setProperty('RESET_REQ_' + username, nowText_());
    const admins = readUsers_(usersSheet_()).filter(u => u.role === 'admin' && u.status === 'active' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(u.email || '').trim()));
    if (admins.length) {
      try {
        MailApp.sendEmail({
          to: admins.map(a => String(a.email).trim()).join(','),
          subject: 'Protection Fee — ' + username + ' ขอรีเซ็ตรหัสผ่าน',
          body: 'ผู้ใช้ ' + username + ' (' + (user.fullName || '') + ') ใส่รหัสผ่านผิดหลายครั้งและขอรีเซ็ตรหัสผ่าน แต่บัญชีไม่มีอีเมล\n' +
            'เปิดหน้า "ผู้ใช้" ในระบบ แล้วกด "รีเซ็ตรหัสผ่าน" เพื่อสร้างรหัสผ่านชั่วคราวให้ผู้ใช้\n' + appUrl_(),
        });
      } catch (err) { console.error('notify admins failed', err); }
    }
    audit_(username, 'reset_request', CONFIG.USERS_SHEET, user.row, { via: 'admin', notified: admins.length });
  }
  return { message: RESET_SENT_MESSAGE };
}

/** ตั้งรหัสผ่านใหม่จากลิงก์ในอีเมล (ใช้ได้ครั้งเดียว) */
function resetPasswordWithToken(token, newPassword) {
  token = String(token || '').trim();
  if (!/^[0-9a-f]{64}$/i.test(token)) throw new Error('ลิงก์ตั้งรหัสผ่านไม่ถูกต้อง');
  validatePassword_(String(newPassword || ''));
  const cache = CacheService.getScriptCache();
  const key = 'rst_' + sha256_(token);
  return withLock_(() => {
    const username = cache.get(key);
    if (!username) throw new Error('ลิงก์หมดอายุหรือถูกใช้ไปแล้ว — กรุณาขอลิงก์ใหม่');
    cache.remove(key);
    const user = readUsers_(usersSheet_()).find(u => u.username === username);
    if (!user || user.status !== 'active') throw new Error('บัญชีนี้ใช้งานไม่ได้ กรุณาติดต่อผู้ดูแลระบบ');
    setPassword_(user, String(newPassword));
    cache.remove('fail_' + username);
    PropertiesService.getScriptProperties().deleteProperty('RESET_REQ_' + username);
    audit_(username, 'reset_done', CONFIG.USERS_SHEET, user.row, { via: 'email' });
    return { message: 'ตั้งรหัสผ่านใหม่แล้ว — เข้าสู่ระบบด้วยรหัสผ่านใหม่ได้เลย', username };
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
  } else if (sh.getLastColumn() < USER_HEADERS.length) {
    sh.getRange(1, 1, 1, USER_HEADERS.length).setValues([USER_HEADERS]); // เพิ่มคอลัมน์ใหม่ต่อท้าย
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

/** รันครั้งเดียวจากตัวแก้ไข Apps Script เพื่อให้สิทธิ์ Google Drive (เก็บไฟล์แนบการยกเลิก) */
function authorizeDrive() {
  const folder = cancelFolder_();
  console.log('โฟลเดอร์ไฟล์แนบการยกเลิก: ' + folder.getName() + ' — ' + folder.getUrl());
}
