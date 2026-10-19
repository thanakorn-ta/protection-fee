import { redirect } from 'next/navigation';
import App from '@/components/App';
import { appsScriptUrl, devLoginEnabled, googleClientId, webAppReady } from '@/lib/config';

export const dynamic = 'force-dynamic';

export default function Page() {
  // ยังไม่ได้ใส่ค่าตั้ง Google ใน Vercel → ส่งไประบบ Apps Script ที่ต่อชีทจริงอยู่แล้ว
  // ตั้ง GOOGLE_CLIENT_ID, GOOGLE_SERVICE_ACCOUNT_JSON, SESSION_SECRET ครบเมื่อไร หน้านี้ใช้แอปของตัวเองทันที
  if (!webAppReady()) redirect(appsScriptUrl());
  return <App googleClientId={googleClientId()} devLogin={devLoginEnabled()} />;
}
