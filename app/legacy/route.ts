import { appsScriptUrl } from '@/lib/config';
import { LEGACY_HTML } from '@/lib/generated/legacy-html';

export const dynamic = 'force-static';

/**
 * หน้าเว็บเดียวกับ Apps Script (apps-script/Index.html) แต่เปิดบนโฮสต์ Next.js (Vercel หรือ Netlify)
 * แทน google.script.run ด้วยตัวเรียก doPost ของ Apps Script (ตรง หรือผ่าน /api/rpc — ดู RPC_MODE)
 * ไฟล์แนบ (ภาพ / วิดีโอ) ส่งตรงไป Apps Script เสมอ เพราะใหญ่เกินขีดจำกัดของโฮสต์ (~4.5–6 MB)
 */
// RPC_MODE=direct (ค่าเริ่มต้น): เบราว์เซอร์เรียก Apps Script ตรง ถ้าไม่สำเร็จค่อยผ่าน /api/rpc
//   — ไม่ขึ้นกับเวลาจำกัดของฟังก์ชันบนโฮสต์ (Netlify 10 วินาที, Vercel ตามแพ็กเกจ) ใช้ได้ทั้ง Vercel / Netlify
// RPC_MODE=proxy: ผ่าน /api/rpc ทุกคำสั่ง ยกเว้นไฟล์แนบที่ใหญ่เกินขีดจำกัดของโฮสต์
const RPC_MODE = (process.env.RPC_MODE || 'direct').trim().toLowerCase() === 'proxy' ? 'proxy' : 'direct';

const SHIM = `<script>
(function () {
  var APPS_SCRIPT_URL = ${JSON.stringify(appsScriptUrl())};
  var MODE = ${JSON.stringify(RPC_MODE)};
  var DIRECT = { uploadCancelFile: 1, getCancelFile: 1 };
  function call(url, headers, fn, args, strict) {
    return fetch(url, { method: 'POST', headers: headers, body: JSON.stringify({ fn: fn, args: args }), redirect: 'follow' })
      .then(function (r) {
        return r.json().catch(function () {
          if (strict) throw new Error('not json'); // ได้หน้า HTML กลับมา → ลองอีกเส้นทาง
          return { ok: false, error: 'เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง (' + r.status + ')' };
        });
      });
  }
  function runner() {
    var ok = function () {}, fail = function () {};
    var p = new Proxy({}, {
      get: function (_, fn) {
        if (fn === 'withSuccessHandler') return function (f) { ok = f; return p; };
        if (fn === 'withFailureHandler') return function (f) { fail = f; return p; };
        if (fn === 'withUserObject') return function () { return p; };
        return function () {
          var args = Array.prototype.slice.call(arguments);
          var viaVercel = function () { return call('/api/rpc', { 'Content-Type': 'application/json' }, fn, args); };
          var direct = MODE === 'direct' || DIRECT[fn];
          (direct ? call(APPS_SCRIPT_URL, { 'Content-Type': 'text/plain;charset=utf-8' }, fn, args, true).catch(viaVercel) : viaVercel())
            .then(function (d) { if (d && d.ok) ok(d.result); else fail(new Error((d && d.error) || 'เกิดข้อผิดพลาด')); })
            .catch(function () { fail(new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองใหม่')); });
        };
      },
    });
    return p;
  }
  window.google = window.google || {};
  window.google.script = { get run() { return runner(); } };
})();
</script>`;

/**
 * ติดตั้งเป็นแอปได้ (PWA) — "เพิ่มไปยังหน้าจอโฮม" บน iOS / Android และติดตั้งบน Chrome / Edge
 * ไม่มี service worker: ข้อมูลมาจากเซิร์ฟเวอร์ทุกครั้ง ไม่เสี่ยงแสดงข้อมูลเก่า
 */
const APP_HEAD = [
  '<link rel="manifest" href="/manifest.webmanifest">',
  '<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png">',
  '<link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png">',
  '<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-title" content="Protection Fee">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="default">',
  '<meta name="application-name" content="Protection Fee">',
].join('\n');

const HEAD = APP_HEAD + '\n' + SHIM;
const PAGE = LEGACY_HTML.includes('<head>') ? LEGACY_HTML.replace('<head>', '<head>\n' + HEAD) : HEAD + LEGACY_HTML;

export function GET() {
  return new Response(PAGE, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=0, must-revalidate',
    },
  });
}
