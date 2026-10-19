/** วันที่ทั้งหมดใช้เวลาไทย (Asia/Bangkok) และเก็บเป็นปี-เดือน-วัน แบบ ISO "2026-09-24" */

export const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
export const THAI_MONTHS_LONG = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
export const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad2 = (n: number) => String(n).padStart(2, '0');

export interface Ymd { y: number; m: number; d: number } // m เริ่มที่ 1

export function parseIso(iso: string): Ymd | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

export function toIso(p: Ymd): string {
  return p.y + '-' + pad2(p.m) + '-' + pad2(p.d);
}

/** วันที่ → serial number ของ Google Sheets (นับวันจาก 30 ธ.ค. 1899) */
export function toSerial(p: Ymd): number {
  return Date.UTC(p.y, p.m - 1, p.d) / 86400000 + 25569;
}

export function fromSerial(serial: number): Ymd {
  const dt = new Date(Math.round((Math.floor(serial) - 25569) * 86400000));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** "Sep-26" */
export function sheetMonthText(p: Ymd): string {
  return EN_MONTHS[p.m - 1] + '-' + pad2(p.y % 100);
}

/** "1 ก.ย. 69" */
export function thaiShort(p: Ymd): string {
  return p.d + ' ' + THAI_MONTHS[p.m - 1] + ' ' + pad2((p.y + 543) % 100);
}

/** "กันยายน 2569" จาก "2026-09" */
export function monthLong(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  return THAI_MONTHS_LONG[m - 1] + ' ' + (y + 543);
}

/** ตัวเลขปีสองหลัก/สี่หลัก ทั้ง พ.ศ. และ ค.ศ. → ค.ศ. */
function normalizeYear(y: number): number {
  if (y < 100) y += y >= 40 ? 2500 : 2000; // 65 → 2565 (พ.ศ.), 26 → 2026
  if (y > 2400) y -= 543;
  return y;
}

/**
 * อ่านวันที่จากเซลล์ในชีท — serial number, "3 พ.ค. 65", "16/9/2026", "2026-09-16"
 * คืน null ถ้าอ่านไม่ออก
 */
export function parseSheetDate(raw: unknown): Ymd | null {
  if (typeof raw === 'number' && isFinite(raw) && raw > 1000) return fromSerial(raw);
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
  if (m) return valid(normalizeYear(Number(m[3])), Number(m[2]), Number(m[1]));
  m = /^(\d{1,2})\s*([^\d\s]+)\s*(\d{2,4})$/.exec(s);
  if (m) {
    const key = m[2].replace(/\s/g, '');
    let mo = THAI_MONTHS.findIndex(t => t === key || t.replace(/\./g, '') === key.replace(/\./g, '')) + 1;
    if (!mo) mo = THAI_MONTHS_LONG.findIndex(t => t === key) + 1;
    if (!mo) mo = EN_MONTHS.findIndex(t => t.toLowerCase() === key.slice(0, 3).toLowerCase()) + 1;
    if (mo) return valid(normalizeYear(Number(m[3])), mo, Number(m[1]));
  }
  return null;
}

/** อ่านเดือนจากคอลัมน์ "เดือน" — serial number, "Sep-26" หรือ "พ.ค.-22" → "2026-09" */
export function parseSheetMonth(raw: unknown): string {
  if (typeof raw === 'number' && isFinite(raw) && raw > 1000) {
    const p = fromSerial(raw);
    return p.y + '-' + pad2(p.m);
  }
  const s = String(raw ?? '').trim();
  const m = /^([^\d\s-/]+)\s*[-\s/]\s*(\d{2,4})$/.exec(s);
  if (m) {
    const key = m[1].replace(/\./g, '').toLowerCase();
    let mo = THAI_MONTHS.findIndex(t => t.replace(/\./g, '') === key) + 1;
    if (!mo) mo = THAI_MONTHS_LONG.findIndex(t => t === m[1]) + 1;
    if (!mo) mo = EN_MONTHS.findIndex(t => t.toLowerCase() === key.slice(0, 3)) + 1;
    if (mo) return normalizeYear(Number(m[2])) + '-' + pad2(mo);
  }
  const d = parseSheetDate(s);
  return d ? d.y + '-' + pad2(d.m) : '';
}

/* ---- เขียนเดือน/วันที่เป็นข้อความ ให้หน้าตาเหมือนแถวก่อนหน้า ---- */

/** ปีท้ายข้อความเดิมเป็น พ.ศ. หรือ ค.ศ. กี่หลัก — "22" → ค.ศ. 2 หลัก, "69" → พ.ศ. 2 หลัก, "2569" → พ.ศ. 4 หลัก */
function yearLike(prev: string, y: number): string {
  const m = /(\d{2,4})\s*$/.exec(prev);
  const digits = m ? m[1] : '';
  const be = digits.length === 4 ? Number(digits) > 2400 : digits.length === 2 && Number(digits) >= 40;
  const year = be ? y + 543 : y;
  return digits.length === 4 ? String(year) : pad2(year % 100);
}

function monthNameLike(prev: string, m: number): string {
  if (/[ก-๙]/.test(prev)) return THAI_MONTHS[m - 1];
  return EN_MONTHS[m - 1];
}

/** คอลัมน์เดือน: "พ.ค.-22", "Sep-26" ฯลฯ ตามแบบของแถวก่อนหน้า */
export function monthTextLike(prev: string, p: Ymd): string {
  const sep = /\s/.test(prev.trim()) && !/-/.test(prev) ? ' ' : '-';
  return monthNameLike(prev, p.m) + sep + yearLike(prev, p.y);
}

/** คอลัมน์วันที่: "5 พ.ค. 22", "1 ก.ย. 69" ฯลฯ ตามแบบของแถวก่อนหน้า */
export function dateTextLike(prev: string, p: Ymd): string {
  const slash = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.exec(prev.trim());
  if (slash) return p.d + '/' + p.m + '/' + yearLike(prev, p.y);
  return p.d + ' ' + monthNameLike(prev, p.m) + ' ' + yearLike(prev, p.y);
}

function valid(y: number, m: number, d: number): Ymd | null {
  return parseIso(y + '-' + pad2(m) + '-' + pad2(d));
}

/** วันนี้ตามเวลาไทย */
export function todayBangkok(): Ymd {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return parseIso(s)!;
}

/** "2026-10-19 16:40" ตามเวลาไทย — ใช้ในแท็บ Users / AuditLog */
export function nowStamp(): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find(p => p.type === t)?.value || '';
  return get('year') + '-' + get('month') + '-' + get('day') + ' ' + get('hour').replace('24', '00') + ':' + get('minute');
}
