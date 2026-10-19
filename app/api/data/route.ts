import { publicUser, requireUser } from '@/lib/auth';
import { BEM_FEES, EXPRESSWAYS, PAYMENT_STATUSES, PROJECTS, isUnpaid, readLocations, readLogs, readUsers, uniq, type Entry } from '@/lib/db';
import { ok, route } from '@/lib/http';

const RECENT_ROWS = 10;

/** ข้อมูลหน้าบันทึกการใช้รถ: สถานที่, ตัวเลือก, รายการล่าสุด, สรุปเดือนล่าสุด */
export const GET = route(async () => {
  const user = await requireUser();
  const [locations, logs, { users }] = await Promise.all([readLocations(), readLogs(['exat', 'bem']), readUsers()]);
  const all = [...logs.exat, ...logs.bem];

  const summary = (list: Entry[]) => {
    const month = list.length ? list[list.length - 1].month : '';
    const rows = list.filter(e => e.month === month);
    return {
      month,
      count: rows.length,
      amount: rows.reduce((s, e) => s + e.fee, 0),
      unpaid: rows.filter(e => isUnpaid(e.payment)).length,
    };
  };

  return ok({
    user: publicUser(user),
    locations,
    options: {
      projects: PROJECTS,
      expressways: uniq([...EXPRESSWAYS, ...locations.map(l => l.expressway)]),
      places: uniq([...locations.map(l => l.area), ...all.map(e => e.place)]),
      jobTypes: uniq(all.slice().reverse().map(e => e.jobType)).slice(0, 200),
      workers: uniq([...users.filter(u => u.status === 'active').map(u => u.nickname), ...all.slice().reverse().map(e => e.worker)]),
      bemFees: uniq([...BEM_FEES, ...logs.bem.map(e => e.feeText)]),
      payments: uniq([...PAYMENT_STATUSES, ...logs.bem.map(e => e.payment)]),
    },
    recent: {
      exat: logs.exat.slice(-RECENT_ROWS).reverse(),
      bem: logs.bem.slice(-RECENT_ROWS).reverse(),
    },
    summary: { exat: summary(logs.exat), bem: summary(logs.bem) },
    pendingCount: user.role === 'admin' ? users.filter(u => u.status === 'pending').length : 0,
  });
});
