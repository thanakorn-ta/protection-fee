import { createGoogleSheets } from './sheets/google';
import { createFileMock } from './sheets/mock';
import type { SheetsApi } from './sheets/types';

export const isProd = process.env.NODE_ENV === 'production';

/** ใช้ชีทจำลองเมื่อสั่ง SHEETS_BACKEND=mock หรือรัน dev โดยยังไม่มี service account */
export function useMock(): boolean {
  if (process.env.SHEETS_BACKEND === 'mock') return true;
  return !isProd && !process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
}

let client: SheetsApi | null = null;

export function sheets(): SheetsApi {
  if (client) return client;
  if (useMock()) {
    if (isProd && process.env.ALLOW_MOCK_IN_PRODUCTION !== '1') throw new Error('ห้ามใช้ชีทจำลองบน production — ตั้งค่า GOOGLE_SERVICE_ACCOUNT_JSON');
    client = createFileMock();
  } else {
    const id = (process.env.SPREADSHEET_ID || '').trim();
    if (!id) throw new Error('ยังไม่ได้ตั้งค่า SPREADSHEET_ID');
    client = createGoogleSheets(id);
  }
  return client;
}

/** สำหรับทดสอบ */
export function setSheetsForTest(api: SheetsApi | null) {
  client = api;
}

export function googleClientId(): string {
  return (process.env.GOOGLE_CLIENT_ID || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '').trim();
}

/** ปุ่มเข้าสู่ระบบทดสอบ (ไม่ต้องใช้ Google) — เปิดได้เฉพาะ `npm run dev` */
export function devLoginEnabled(): boolean {
  return !isProd && process.env.DEV_LOGIN === '1';
}

export function adminEmails(): string[] {
  return splitList(process.env.ADMIN_EMAILS);
}

/** โดเมนอีเมลที่สมัครได้ เช่น planbmedia.co.th — เว้นว่าง = ทุกบัญชี Google */
export function allowedDomains(): string[] {
  return splitList(process.env.ALLOWED_EMAIL_DOMAINS).map(d => d.replace(/^@/, ''));
}

function splitList(v: string | undefined): string[] {
  return String(v || '').split(/[,\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
}

/** ชื่อแท็บ — เว้นว่าง = ค้นหาอัตโนมัติจากหัวตาราง */
export const SHEET_NAMES = {
  locations: process.env.SHEET_LOCATIONS || '',
  exat: process.env.SHEET_EXAT || '',
  bem: process.env.SHEET_BEM || '',
};
export const USERS_SHEET = process.env.SHEET_USERS || 'Users';
export const AUDIT_SHEET = process.env.SHEET_AUDIT || 'AuditLog';
