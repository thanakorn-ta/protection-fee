import { NextResponse, type NextRequest } from 'next/server';
import { HttpError } from './auth';

type Handler = (req: NextRequest) => Promise<NextResponse>;

/** ครอบ route handler — แปลง error เป็น JSON และกันคำขอข้ามเว็บ (CSRF) สำหรับคำขอที่เขียนข้อมูล */
export function route(fn: Handler): Handler {
  return async req => {
    try {
      if (req.method !== 'GET' && !sameOrigin(req)) throw new HttpError(403, 'คำขอไม่ได้มาจากหน้าเว็บนี้');
      return await fn(req);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 400;
      const message = e instanceof Error ? e.message : String(e);
      if (!(e instanceof HttpError)) console.error(req.method, req.nextUrl.pathname, e);
      return NextResponse.json({ error: message }, { status });
    }
  };
}

function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return req.headers.get('sec-fetch-site') !== 'cross-site';
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function body<T = Record<string, unknown>>(req: NextRequest): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, 'ข้อมูลที่ส่งมาไม่ถูกต้อง');
  }
}

export const ok = (data: unknown = { ok: true }) => NextResponse.json(data);
