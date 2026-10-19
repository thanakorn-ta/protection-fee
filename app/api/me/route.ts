import { publicUser, requireUser } from '@/lib/auth';
import { audit, findUser, text, updateUser } from '@/lib/db';
import { body, ok, route } from '@/lib/http';

export const GET = route(async () => {
  const user = await requireUser();
  return ok({ user: publicUser(user) });
});

/** แก้ชื่อ-นามสกุล ชื่อเล่น เบอร์โทรของตัวเอง */
export const PATCH = route(async req => {
  const user = await requireUser();
  const form = await body<{ fullName?: string; nickname?: string; phone?: string }>(req);
  const fullName = text(form.fullName, 120);
  const nickname = text(form.nickname, 60);
  const phone = text(form.phone, 30);
  if (!fullName) throw new Error('กรุณากรอกชื่อ-นามสกุล');
  if (!nickname) throw new Error('กรุณากรอกชื่อเล่น');
  if (phone && !/^[0-9+\-\s()]{6,30}$/.test(phone)) throw new Error('รูปแบบเบอร์โทรไม่ถูกต้อง');
  await updateUser(user.email, { fullName, nickname, phone });
  await audit(user.email, 'update_profile', 'Users', user.row, {});
  return ok({ user: publicUser((await findUser(user.email, true))!) });
});
