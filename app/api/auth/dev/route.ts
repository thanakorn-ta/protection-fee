import { devLoginEnabled } from '@/lib/config';
import { HttpError } from '@/lib/auth';
import { body, route } from '@/lib/http';
import { signIn } from '@/lib/signin';

/** เข้าสู่ระบบทดสอบโดยไม่ใช้ Google — ใช้ได้เฉพาะ `npm run dev` ที่ตั้ง DEV_LOGIN=1 */
export const POST = route(async req => {
  if (!devLoginEnabled()) throw new HttpError(404, 'Not found');
  const { email, name } = await body<{ email?: string; name?: string }>(req);
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('รูปแบบอีเมลไม่ถูกต้อง');
  return signIn({ email: e, name: String(name || e.split('@')[0]), sub: '' });
});
