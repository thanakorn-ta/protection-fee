import { NextResponse } from 'next/server';
import { allowedDomains } from './config';
import { findUser, updateUser, audit } from './db';
import { HttpError, publicUser, rememberSignup, startSession, type GoogleProfile } from './auth';
import { nowStamp } from './dates';

/** หลังยืนยันตัวตนกับ Google แล้ว: เข้าสู่ระบบ / รออนุมัติ / ไปกรอกใบสมัคร */
export async function signIn(p: GoogleProfile): Promise<NextResponse> {
  const user = await findUser(p.email, true);

  if (!user) {
    const domains = allowedDomains();
    if (domains.length && !domains.includes(p.email.split('@')[1])) {
      throw new HttpError(403, 'สมัครได้เฉพาะอีเมล @' + domains.join(', @'));
    }
    const res = NextResponse.json({ state: 'signup', profile: { email: p.email, name: p.name } });
    await rememberSignup(res, p);
    return res;
  }
  if (user.googleId && p.sub && user.googleId !== p.sub) throw new HttpError(403, 'บัญชี Google ไม่ตรงกับที่สมัครไว้');
  if (user.status === 'pending' || user.status === 'rejected') {
    return NextResponse.json({ state: 'waiting', user: publicUser(user), createdAt: user.createdAt });
  }
  if (user.status !== 'active') throw new HttpError(403, 'บัญชีถูกระงับ กรุณาติดต่อผู้ดูแลระบบ');

  await updateUser(user.email, { lastLogin: nowStamp(), ...(user.googleId ? {} : { googleId: p.sub }) });
  await audit(user.email, 'login', '', 0, {});
  const res = NextResponse.json({ state: 'ok', user: publicUser(user) });
  await startSession(res, user.email);
  return res;
}
