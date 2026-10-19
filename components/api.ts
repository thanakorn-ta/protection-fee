/** ชนิดข้อมูลและตัวเรียก API ฝั่งหน้าเว็บ */

export type Role = 'user' | 'admin';
export type Status = 'pending' | 'active' | 'disabled' | 'rejected';
export type Mode = 'EXAT' | 'BEM';

export interface User { email: string; fullName: string; nickname: string; phone: string; role: Role; status: Status }
export interface Member extends User { createdAt: string; lastLogin: string; approvedBy: string }

export interface Location {
  pack: string; code: string; mediaSite: string; area: string; operator: string; expressway: string;
  size: string; count: string; road: string; district: string; meetingPoint: string; police: string;
}

export interface Entry {
  row: number; no: string; date: string; month: string; dateText: string; expressway: string; project: string;
  place: string; jobType: string; worker: string; fee: number; feeText: string; payment: string;
}

export interface Summary { month: string; count: number; amount: number; unpaid: number }

export interface AppData {
  user: User;
  locations: Location[];
  options: { projects: string[]; expressways: string[]; places: string[]; jobTypes: string[]; workers: string[]; bemFees: string[]; payments: string[] };
  recent: { exat: Entry[]; bem: Entry[] };
  summary: { exat: Summary; bem: Summary };
  pendingCount: number;
}

export interface AuthResult {
  state: 'ok' | 'signup' | 'waiting';
  user?: User;
  profile?: { email: string; name: string };
  createdAt?: string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

export async function api<T = { ok: true }>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองใหม่');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/') && path !== '/api/me') onUnauthorized();
    throw new ApiError(res.status, data.error || 'เกิดข้อผิดพลาด (' + res.status + ')');
  }
  return data as T;
}

export const STATUS_LABEL: Record<Status, string> = { active: 'ใช้งาน', pending: 'รออนุมัติ', disabled: 'ระงับ', rejected: 'ไม่อนุมัติ' };
export const ROLE_LABEL: Record<Role, string> = { admin: 'ผู้ดูแลระบบ', user: 'ผู้ใช้งาน' };

export function money(n: number) {
  return Number(n || 0).toLocaleString('th-TH');
}

export function norm(s: string) {
  return String(s || '').replace(/\s+/g, '').toLowerCase();
}

/** "2026-10-19 16:40" → "19/10/2569 16:40" */
export function stampThai(s: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}:\d{2}))?/.exec(s || '');
  if (!m) return s || '—';
  return m[3] + '/' + m[2] + '/' + (Number(m[1]) + 543) + (m[4] ? ' ' + m[4] : '');
}
