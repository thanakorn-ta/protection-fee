import { LEGACY_HTML } from '@/lib/generated/legacy-html';

export const dynamic = 'force-static';

/**
 * หน้าเว็บเดียวกับ Apps Script (apps-script/Index.html) แต่เปิดบน Vercel
 * แทน google.script.run ด้วยตัวเรียก /api/rpc ซึ่งส่งต่อไป doPost ของ Apps Script
 */
const SHIM = `<script>
(function () {
  function runner() {
    var ok = function () {}, fail = function () {};
    var p = new Proxy({}, {
      get: function (_, fn) {
        if (fn === 'withSuccessHandler') return function (f) { ok = f; return p; };
        if (fn === 'withFailureHandler') return function (f) { fail = f; return p; };
        if (fn === 'withUserObject') return function () { return p; };
        return function () {
          var args = Array.prototype.slice.call(arguments);
          fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fn: fn, args: args }) })
            .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง (' + r.status + ')' }; }); })
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
