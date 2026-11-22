import { LEGACY_BUILD } from '@/lib/generated/legacy-html';

// เวอร์ชันของระบบที่ deploy อยู่ตอนนี้ — หน้าเว็บที่เปิดค้างไว้เทียบกับเวอร์ชันของตัวเองแล้วขึ้นแถบ "อัปเดตตอนนี้"
// Apps Script (updateWatchJob) อ่านค่านี้ทุก 15 นาทีเพื่อแจ้งสมาชิกทุกคนเมื่อมีเวอร์ชันใหม่
export const dynamic = 'force-static';

export function GET() {
  return new Response(JSON.stringify(LEGACY_BUILD), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
