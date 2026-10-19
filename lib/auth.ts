import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { googleClientId, isProd } from './config';
import { findUser, type User } from './db';

const SESSION_COOKIE = 'pf_session';
const SIGNUP_COOKIE = 'pf_signup';
const SESSION_HOURS = 12;

function secret(): Uint8Array {
  const s = process.env.SESSION_SECRET || '';
  if (s.length < 32) {
    if (isProd) throw new Error('SESSION_SECRET ต้องยาวอย่างน้อย 32 ตัวอักษร');
    return new TextEncoder().encode('dev-only-secret-do-not-use-in-production!!');
  }
  return new TextEncoder().encode(s);
}

const cookieBase = { httpOnly: true, secure: isProd, sameSite: 'lax' as const, path: '/' };

/* ---------------- Google Sign-In ---------------- */

const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export interface GoogleProfile { email: string; name: string; sub: string; picture?: string }

/** ตรวจ ID token จากปุ่ม Sign in with Google */
export async function verifyGoogleCredential(credential: string): Promise<GoogleProfile> {
  const aud = googleClientId();
  if (!aud) throw new Error('ยังไม่ได้ตั้งค่า GOOGLE_CLIENT_ID');
  const { payload } = await jwtVerify(credential, googleKeys, {
    audience: aud,
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
  });
  if (!payload.email || payload.email_verified !== true) throw new Error('บัญชี Google นี้ยังไม่ได้ยืนยันอีเมล');
  return { email: String(payload.email).toLowerCase(), name: String(payload.name || ''), sub: String(payload.sub), picture: payload.picture as string | undefined };
}

/* ---------------- session cookie ---------------- */

async function sign(payload: Record<string, unknown>, seconds: number) {
  return new SignJWT(payload).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + seconds).sign(secret());
}

async function read(name: string): Promise<Record<string, unknown> | null> {
  const value = (await cookies()).get(name)?.value;
  if (!value) return null;
  try {
    return (await jwtVerify(value, secret(), { algorithms: ['HS256'] })).payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function startSession(res: NextResponse, email: string) {
  res.cookies.set(SESSION_COOKIE, await sign({ email, kind: 'session' }, SESSION_HOURS * 3600), { ...cookieBase, maxAge: SESSION_HOURS * 3600 });
  res.cookies.set(SIGNUP_COOKIE, '', { ...cookieBase, maxAge: 0 });
}

export function endSession(res: NextResponse) {
  res.cookies.set(SESSION_COOKIE, '', { ...cookieBase, maxAge: 0 });
  res.cookies.set(SIGNUP_COOKIE, '', { ...cookieBase, maxAge: 0 });
}

/** จำโปรไฟล์ Google ไว้ 15 นาที ระหว่างกรอกใบสมัคร */
export async function rememberSignup(res: NextResponse, p: GoogleProfile) {
  res.cookies.set(SIGNUP_COOKIE, await sign({ ...p, kind: 'signup' }, 15 * 60), { ...cookieBase, maxAge: 15 * 60 });
}

export async function pendingSignup(): Promise<GoogleProfile | null> {
  const p = await read(SIGNUP_COOKIE);
  if (!p || p.kind !== 'signup' || !p.email) return null;
  return { email: String(p.email), name: String(p.name || ''), sub: String(p.sub || ''), picture: p.picture as string | undefined };
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** ผู้ใช้ที่เข้าสู่ระบบอยู่ — ตรวจสถานะ/สิทธิ์ล่าสุดจากแท็บ Users ทุกครั้ง */
export async function requireUser(adminOnly = false): Promise<User> {
  const s = await read(SESSION_COOKIE);
  if (!s || s.kind !== 'session' || !s.email) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ');
  const user = await findUser(String(s.email));
  if (!user || user.status !== 'active') throw new HttpError(401, 'บัญชีนี้ใช้งานไม่ได้แล้ว กรุณาเข้าสู่ระบบใหม่');
  if (adminOnly && user.role !== 'admin') throw new HttpError(403, 'เฉพาะผู้ดูแลระบบเท่านั้น');
  return user;
}

export function publicUser(u: User) {
  return { email: u.email, fullName: u.fullName, nickname: u.nickname, phone: u.phone, role: u.role, status: u.status };
}
