import { NextResponse, type NextRequest } from 'next/server';

/**
 * ยังไม่ได้ตั้งค่า Google (GOOGLE_CLIENT_ID, GOOGLE_SERVICE_ACCOUNT_JSON, SESSION_SECRET) →
 * หน้าแรกแสดงระบบแบบ Apps Script (/legacy) บนโดเมน Vercel เดิม
 * ตั้งครบเมื่อไร (และ Redeploy) หน้าแรกจะเป็นแอป Next.js ที่เข้าสู่ระบบด้วย Google
 */
export function middleware(req: NextRequest) {
  const ready = !!(process.env.GOOGLE_CLIENT_ID || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID)
    && !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    && (process.env.SESSION_SECRET || '').length >= 32;
  if (!ready) return NextResponse.rewrite(new URL('/legacy', req.url));
  return NextResponse.next();
}

export const config = { matcher: '/' };
