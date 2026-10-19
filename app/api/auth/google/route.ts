import { verifyGoogleCredential } from '@/lib/auth';
import { body, route } from '@/lib/http';
import { signIn } from '@/lib/signin';

export const POST = route(async req => {
  const { credential } = await body<{ credential?: string }>(req);
  if (!credential) throw new Error('ไม่ได้รับข้อมูลจาก Google');
  return signIn(await verifyGoogleCredential(credential));
});
