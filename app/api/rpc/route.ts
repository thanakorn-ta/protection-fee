import { appsScriptUrl } from '@/lib/config';
import { body, ok, route } from '@/lib/http';

// คำสั่งที่เขียนชีทหลายแถวอาจใช้เวลาหลายวินาที — maxDuration ใช้บน Vercel เท่านั้น
// (Netlify ไม่อ่านค่านี้ ฟังก์ชันจำกัด ~10 วินาที จึงให้หน้าเว็บเรียก Apps Script ตรงเป็นค่าเริ่มต้น — ดู RPC_MODE ใน app/legacy/route.ts)
export const maxDuration = 60;

/** ฟังก์ชันใน apps-script/Code.gs ที่หน้าเว็บเรียกได้ (ตรงกับ API_FUNCTIONS) */
const ALLOWED = new Set(['register', 'login', 'logout', 'changePassword', 'requestPasswordReset', 'resetPasswordWithToken', 'getAppData', 'addLogEntry', 'addLogEntries', 'getDashboard', 'recalcCosts', 'listBookings', 'saveBooking', 'reviewBooking', 'cancelBooking', 'uploadCancelFile', 'listCancelled', 'getCancelFile', 'getAccrue', 'downloadAccrue', 'sendAccrueNow', 'saveAccrueSettings', 'getClear', 'downloadClear', 'sendClearNow', 'listHolidays', 'saveHoliday', 'deleteHoliday', 'logBooking', 'addLocation', 'listUsers', 'updateUser', 'reviewUser', 'resetPassword', 'getNotifySettings', 'saveNotifySettings', 'getPushConfig', 'savePushSub', 'removePushSub', 'pushInbox']);

/** ส่งต่อคำขอจากหน้า /legacy ไป doPost ของ Apps Script ที่อ่าน/เขียน Google Sheet */
export const POST = route(async req => {
  const { fn, args } = await body<{ fn?: string; args?: unknown[] }>(req);
  if (!fn || !ALLOWED.has(fn)) throw new Error('ไม่รู้จักคำสั่ง');

  let res: Response;
  try {
    res = await fetch(appsScriptUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ fn, args: Array.isArray(args) ? args : [] }),
      redirect: 'follow',
      cache: 'no-store',
    });
  } catch {
    throw new Error('ติดต่อ Apps Script ไม่ได้ กรุณาลองใหม่');
  }
  const text = await res.text();
  try {
    return ok(JSON.parse(text));
  } catch {
    // ได้หน้าเข้าสู่ระบบ Google กลับมา = เว็บแอป Apps Script ยังไม่เปิดให้ "ทุกคน" เข้าถึง
    throw new Error('Apps Script ยังไม่เปิดให้เว็บนี้เรียกใช้ — ตั้ง "ผู้ที่มีสิทธิ์เข้าถึง: ทุกคน" ในการทำให้ใช้งานได้ของ Apps Script (HTTP ' + res.status + ')');
  }
});
