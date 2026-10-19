import { NextResponse } from 'next/server';
import { endSession } from '@/lib/auth';
import { route } from '@/lib/http';

export const POST = route(async () => {
  const res = NextResponse.json({ ok: true });
  endSession(res);
  return res;
});
