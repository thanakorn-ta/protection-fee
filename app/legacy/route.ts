import { appsScriptUrl } from '@/lib/config';
import { LEGACY_HTML } from '@/lib/generated/legacy-html';

export const dynamic = 'force-static';

/**
 * หน้าเว็บเดียวกับ Apps Script (apps-script/Index.html) แต่เปิดบน Vercel
 * แทน google.script.run ด้วยตัวเรียก /api/rpc ซึ่งส่งต่อไป doPost ของ Apps Script
 * ยกเว้นไฟล์แนบ (ภาพ / วิดีโอ) ที่ใหญ่เกินขีดจำกัดของ Vercel (~4.5 MB) — ส่งตรงไป Apps Script แทน
 */
const SHIM = `<script>
(function () {
  var APPS_SCRIPT_URL = ${JSON.stringify(appsScriptUrl())};
  var DIRECT = { uploadCancelFile: 1, getCancelFile: 1 };
  function call(url, headers, fn, args) {
    return fetch(url, { method: 'POST', headers: headers, body: JSON.stringify({ fn: fn, args: args }), redirect: 'follow' })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง (' + r.status + ')' }; }); });
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
          (DIRECT[fn] ? call(APPS_SCRIPT_URL, { 'Content-Type': 'text/plain;charset=utf-8' }, fn, args).catch(viaVercel) : viaVercel())
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

const PAGE = LEGACY_HTML.includes('<head>') ? LEGACY_HTML.replace('<head>', '<head>\n' + SHIM) : SHIM + LEGACY_HTML;

export function GET() {
  return new Response(PAGE, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=0, must-revalidate',
    },
  });
}
