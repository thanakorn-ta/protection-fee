// ฝังหน้าเว็บ apps-script/Index.html ลงในโค้ด Next.js ตอน build — หน้า /legacy ใช้หน้าตาเดียวกับ Apps Script
import fs from 'node:fs';

const html = fs.readFileSync('apps-script/Index.html', 'utf8');
fs.mkdirSync('lib/generated', { recursive: true });
fs.writeFileSync(
  'lib/generated/legacy-html.ts',
  '// สร้างอัตโนมัติจาก apps-script/Index.html โดย scripts/embed-legacy.mjs — อย่าแก้ไฟล์นี้\n' +
    'export const LEGACY_HTML = ' + JSON.stringify(html) + ';\n',
);
console.log('embedded apps-script/Index.html (' + html.length + ' chars)');
