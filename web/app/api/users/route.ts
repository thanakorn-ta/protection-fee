import { requireUser } from '@/lib/auth';
import { audit, readUsers, updateUser, ROLES, STATUSES, type Role, type Status } from '@/lib/db';
import { body, ok, route } from '@/lib/http';

/** รายชื่อสมาชิก (ผู้ดูแลระบบ) */
export const GET = route(async () => {
  await requireUser(true);
  const { users } = await readUsers(true);
  return ok({
    users: users.map(u => ({
      email: u.email, fullName: u.fullName, nickname: u.nickname, phone: u.phone, role: u.role, status: u.status,
      createdAt: u.createdAt, lastLogin: u.lastLogin, approvedBy: u.approvedBy,
    })),
  });
});

/** อนุมัติ / ไม่อนุมัติ / ระงับ / เปลี่ยนสิทธิ์: { email, role?, status? } */
export const PATCH = route(async req => {
  const admin = await requireUser(true);
  const { email, role, status } = await body<{ email?: string; role?: Role; status?: Status }>(req);
  const target = String(email || '').trim().toLowerCase();
  if (!target) throw new Error('ไม่พบผู้ใช้');
  if (target === admin.email) throw new Error('ไม่สามารถเปลี่ยนสิทธิ์หรือสถานะของตัวเองได้');
  const changes: { role?: string; status?: string; approvedBy?: string } = {};
  if (role !== undefined) {
    if (!ROLES.includes(role)) throw new Error('สิทธิ์ไม่ถูกต้อง');
    changes.role = role;
  }
  if (status !== undefined) {
    if (!STATUSES.includes(status)) throw new Error('สถานะไม่ถูกต้อง');
    changes.status = status;
    if (status === 'active') changes.approvedBy = admin.email;
  }
  if (!Object.keys(changes).length) throw new Error('ไม่มีข้อมูลที่จะเปลี่ยน');
  const user = await updateUser(target, changes);
  await audit(admin.email, 'update_user', 'Users', user.row, { email: target, ...changes });
  return ok();
});
