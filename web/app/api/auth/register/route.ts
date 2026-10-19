import { NextResponse } from 'next/server';
import { adminEmails } from '@/lib/config';
import { HttpError, pendingSignup, publicUser, startSession } from '@/lib/auth';
import { createUser, readUsers, text } from '@/lib/db';
import { body, route } from '@/lib/http';

/** ส่งใบสมัครหลังเข้าสู่ระบบด้วย Google */
export const POST = route(async req => {
  const profile = await pendingSignup();
  if (!profile) throw new HttpError(401, 'หมดเวลากรอกใบสมัคร กรุณาเข้าสู่ระบบด้วย Google อีกครั้ง');
  const form = await body<{ fullName?: string; nickname?: string; phone?: string }>(req);
  const fullName = text(form.fullName, 120);
  const nickname = text(form.nickname, 60);
  const phone = text(form.phone, 30);
  if (!fullName) throw new Error('กรุณากรอกชื่อ-นามสกุล');
  if (!nickname) throw new Error('กรุณากรอกชื่อเล่น ใช้เป็นชื่อในช่องผู้เข้างาน');
  if (phone && !/^[0-9+\-\s()]{6,30}$/.test(phone)) throw new Error('รูปแบบเบอร์โทรไม่ถูกต้อง');

  // อีเมลใน ADMIN_EMAILS หรือผู้สมัครคนแรก → ผู้ดูแลระบบ เข้าใช้ได้ทันที / คนอื่นรออนุมัติ
  const { users } = await readUsers(true);
  const isAdmin = adminEmails().includes(profile.email) || users.length === 0;
  const user = await createUser({
    email: profile.email, fullName, nickname, phone, googleId: profile.sub,
    role: isAdmin ? 'admin' : 'user',
    status: isAdmin ? 'active' : 'pending',
  });

  if (user.status === 'active') {
    const res = NextResponse.json({ state: 'ok', user: publicUser(user) });
    await startSession(res, user.email);
    return res;
  }
  return NextResponse.json({ state: 'waiting', user: publicUser(user), createdAt: user.createdAt });
});
