// Protection Fee — service worker: ให้ติดตั้งเป็นแอปได้ทุกเบราว์เซอร์ และเปิดแอปได้แม้ไม่มีเน็ต
// หน้าเว็บ: โหลดจากเซิร์ฟเวอร์ก่อนเสมอ (ได้เวอร์ชันล่าสุด) เก็บสำเนาไว้ใช้เฉพาะตอนออฟไลน์
// — แอปจะแสดงข้อมูลล่าสุดที่เคยโหลดพร้อมแจ้งว่าออฟไลน์ (ดู startApp ใน apps-script/Index.html)
// คำขออื่น (Apps Script, รูป, ฟอนต์) ไม่ผ่านตัวนี้ ข้อมูลจึงไม่ค้าง
const CACHE = 'pf-shell-v1';
const SHELL = '/';
const OFFLINE = '/offline.html';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll([SHELL, OFFLINE])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.mode !== 'navigate' || req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const isApp = url.pathname === '/' || url.pathname === '/legacy';
  e.respondWith(fetch(req).then(res => {
    if (isApp && res.ok) {
      const copy = res.clone();
      e.waitUntil(caches.open(CACHE).then(c => c.put(SHELL, copy)));
    }
    return res;
  }).catch(() => caches.open(CACHE).then(c => (isApp ? c.match(SHELL) : Promise.resolve(undefined))
    .then(hit => hit || c.match(OFFLINE)))));
});
