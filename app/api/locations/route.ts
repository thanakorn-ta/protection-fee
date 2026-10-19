import { requireUser } from '@/lib/auth';
import { addLocation, readLocations, type Location } from '@/lib/db';
import { body, ok, route } from '@/lib/http';

/** เพิ่มสถานที่ (ผู้ดูแลระบบ) */
export const POST = route(async req => {
  const user = await requireUser(true);
  const form = await body<Partial<Location>>(req);
  const result = await addLocation(form, user.email);
  return ok({ ...result, locations: await readLocations() });
});
