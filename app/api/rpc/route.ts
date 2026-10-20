import { appsScriptUrl } from '@/lib/config';
import { body, ok, route } from '@/lib/http';

/** ฟังก์ชันใน apps-script/Code.gs ที่หน้าเว็บเรียกได้ (ตรงกับ API_FUNCTIONS) */
const ALLOWED = new Set(['register', 'login', 'logout', 'changePassword', 'getAppData', 'addLogEntry', 'addLogEntries', 'getDashboard', 'addLocation', 'listUsers', 'updateUser', 'resetPassword']);

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
