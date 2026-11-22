// ฝังหน้าเว็บ apps-script/Index.html ลงในโค้ด Next.js ตอน build — หน้า /legacy ใช้หน้าตาเดียวกับ Apps Script
// พร้อมเวอร์ชันของระบบ (LEGACY_BUILD): เปลี่ยนเมื่อ Index.html / Code.gs / release-notes.json เปลี่ยน
// หน้าเว็บที่เปิดค้างไว้เทียบกับ /api/version แล้วขึ้นแถบ "อัปเดตตอนนี้" · Apps Script ใช้แจ้งเตือนสมาชิกทุกคน
import crypto from 'node:crypto';
import fs from 'node:fs';

const html = fs.readFileSync('apps-script/Index.html', 'utf8');
const code = fs.existsSync('apps-script/Code.gs') ? fs.readFileSync('apps-script/Code.gs', 'utf8') : '';
let notes = [];
try { notes = JSON.parse(fs.readFileSync('release-notes.json', 'utf8')); } catch { notes = []; }
const latest = (Array.isArray(notes) && notes[0]) || {};
const id = crypto.createHash('sha256').update(html).update('\0').update(code).update('\0').update(JSON.stringify(latest)).digest('hex').slice(0, 12);
const build = { id, date: String(latest.date || ''), note: String(latest.note || '') };

fs.mkdirSync('lib/generated', { recursive: true });
fs.writeFileSync(
  'lib/generated/legacy-html.ts',
  '// สร้างอัตโนมัติจาก apps-script/Index.html โดย scripts/embed-legacy.mjs — อย่าแก้ไฟล์นี้\n' +
    'export const LEGACY_HTML = ' + JSON.stringify(html) + ';\n' +
    'export const LEGACY_BUILD = ' + JSON.stringify(build) + ';\n',
);
console.log('embedded apps-script/Index.html (' + html.length + ' chars) · build ' + id);
