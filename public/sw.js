// Protection Fee — service worker: ให้ติดตั้งเป็นแอปได้ทุกเบราว์เซอร์ เปิดแอปได้แม้ไม่มีเน็ต และรับแจ้งเตือน
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

// แจ้งเตือน: Apps Script ส่ง push แบบไม่มีเนื้อหา → ถามข้อความล่าสุดของเครื่องนี้ (pushInbox) ผ่าน /api/rpc
// แล้วแสดงแจ้งเตือน + ตัวเลขบนไอคอน (iPhone / iPad / Mac / Windows) — Android แสดงจุดบนไอคอนตามแจ้งเตือน
self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let msg = null;
    try { if (e.data) msg = e.data.json(); } catch (err) { msg = null; }
    if (!msg) {
      try {
        const sub = await self.registration.pushManager.getSubscription();
        if (sub) {
          const r = await fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fn: 'pushInbox', args: [sub.endpoint] }) });
          const d = await r.json();
          if (d && d.ok) msg = d.result;
        }
      } catch (err) { msg = null; }
    }
    msg = msg || { title: 'Protection Fee', body: 'มีการอัปเดตการจองรถคุ้มครอง', url: '/' };
    if (typeof msg.badge === 'number' && self.navigator.setAppBadge) {
      try { await (msg.badge > 0 ? self.navigator.setAppBadge(msg.badge) : self.navigator.clearAppBadge()); } catch (err) { /* ไม่รองรับ */ }
    }
    await self.registration.showNotification(msg.title || 'Protection Fee', {
      body: msg.body || '', tag: msg.tag || 'pf', renotify: true,
      icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: msg.url || '/' },
    });
  })());
});

// กดแจ้งเตือน → เปิดการจองนั้นในแอป (ใช้หน้าต่างที่เปิดอยู่ถ้ามี)
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const win = list.find(c => new URL(c.url).origin === self.location.origin);
    if (win) return win.navigate(url).then(c => (c || win).focus()).catch(() => self.clients.openWindow(url));
    return self.clients.openWindow(url);
  }));
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
