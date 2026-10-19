import { requireUser } from '@/lib/auth';
import { addEntry, deleteLastEntry, readLogs, uniq, type EntryInput, type LogKey } from '@/lib/db';
import { body, ok, route } from '@/lib/http';

function logKey(v: unknown): LogKey {
  const k = String(v || '').toLowerCase();
  if (k !== 'exat' && k !== 'bem') throw new Error('ประเภทตารางไม่ถูกต้อง');
  return k;
}

/** รายการรายเดือน: ?key=exat&month=2026-09 (ไม่ใส่เดือน = เดือนล่าสุด) */
export const GET = route(async req => {
  await requireUser();
  const key = logKey(req.nextUrl.searchParams.get('key'));
  const list = (await readLogs([key]))[key];
  const months = uniq(list.map(e => e.month).filter(Boolean).sort().reverse());
  const wanted = req.nextUrl.searchParams.get('month') || '';
  const month = months.includes(wanted) ? wanted : months[0] || '';
  return ok({
    months,
    month,
    entries: list.filter(e => e.month === month),
    lastRow: list.length ? list[list.length - 1].row : 0,
  });
});

/** บันทึกการใช้รถ: { key: 'exat' | 'bem', ...ฟอร์ม } */
export const POST = route(async req => {
  const user = await requireUser();
  const form = await body<EntryInput & { key?: string }>(req);
  const key = logKey(form.key);
  const result = await addEntry(key, form, user.email);
  return ok(result);
});

/** ลบรายการล่าสุด: ?key=exat&row=123 */
export const DELETE = route(async req => {
  const user = await requireUser();
  const key = logKey(req.nextUrl.searchParams.get('key'));
  const row = Number(req.nextUrl.searchParams.get('row'));
  if (!Number.isInteger(row) || row < 1) throw new Error('แถวไม่ถูกต้อง');
  await deleteLastEntry(key, row, user);
  return ok();
});
