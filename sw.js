/**
 * sw.js — 梁平鑫系統 Service Worker
 * 策略：
 *   - Firebase SDK (gstatic CDN)：Cache First（版本固定，永遠快取）
 *   - 本站 HTML / JS / CSS：Stale While Revalidate（快取版先顯示，背景更新）
 *   - Firestore / Auth API：不快取（必須走網路取最新資料）
 */

const CACHE_NAME = 'lp-xin-v15';

// 預先快取的靜態資源（Firebase SDK 四個模組 + auth-guard）
const PRECACHE = [
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js',
  './auth-guard.js',
];

// 不快取的網域（Firebase API、Firestore、Auth 後端）
const NETWORK_ONLY = [
  'firebaseio.com',
  'googleapis.com',
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
];

// ── install：預先快取 Firebase SDK ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(PRECACHE).catch(err => {
        console.warn('[SW] precache 部分失敗（不影響運作）:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// ── activate：清除舊版快取 ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── fetch：攔截請求 ──
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // 1. Firebase API — 永遠走網路，不介入
  if(NETWORK_ONLY.some(d => url.includes(d))) return;

  // 2. Firebase SDK (gstatic) — Cache First
  if(url.includes('www.gstatic.com/firebasejs/')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if(cached) return cached;
        return fetch(event.request).then(resp => {
          if(resp.ok){
            const clone = resp.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return resp;
        });
      })
    );
    return;
  }

  // 3. 本站靜態資源（HTML / JS / CSS / 圖片）— Stale While Revalidate
  //    快取版立刻回傳，同時背景更新快取
  if(url.includes('eric0w0chn-hue.github.io') || url.startsWith(self.location.origin)) {
    // 只快取 GET
    if(event.request.method !== 'GET') return;

    event.respondWith(
      caches.open(CACHE_NAME).then(cache => {
        return cache.match(event.request).then(cached => {
          const fetchPromise = fetch(event.request).then(resp => {
            if(resp.ok) cache.put(event.request, resp.clone());
            return resp;
          }).catch(() => null);

          // 有快取 → 立即回傳快取，背景更新
          // 沒快取 → 等網路
          return cached || fetchPromise;
        });
      })
    );
    return;
  }
});

// ── Web Push（FCM）────────────────────────────────────────────
// 後端一律送「data-only」訊息（不帶 notification 欄位），
// 由這裡決定怎麼顯示，避免瀏覽器自動顯示 + 本 handler 重複顯示造成雙份通知。
// 取得該通知要導向的功能頁。
// FCM 送來的 payload 依版本/平台可能把資訊放在不同位置，逐一嘗試。
function pickPage(d, p){
  if (p && p.page) return p.page;
  const link = (d.fcmOptions && d.fcmOptions.link)
            || (d.notification && d.notification.click_action)
            || '';
  const m = String(link).match(/[?&]go=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch(_) {} }
  return 'dashboard.html';
}

self.addEventListener('push', event => {
  let d = {};
  try { d = (event.data && event.data.json()) || {}; } catch(_) {}

  // ⚠ 一律由 SW 自己顯示。
  //   標準 Web Push 中瀏覽器不會自動顯示任何東西，FCM 的 notification payload
  //   是靠 firebase-messaging 的 SW SDK 代為顯示的；本專案為了避開
  //   GitHub Pages 子路徑的 /firebase-messaging-sw.js 404 問題並未載入該 SDK，
  //   所以這裡不能「交給瀏覽器處理」，否則不會有任何通知。（2026/09 實測踩過）
  const n = d.notification || {};
  const p = d.data || {};
  const title = n.title || p.title || '鑫系統提醒';
  const opts = {
    body: n.body || p.body || '',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: n.tag || p.tag || 'lp-alert',
    renotify: false,
    requireInteraction: true,
    data: { page: pickPage(d, p) }
  };
  console.log('[SW push] 顯示通知:', title, '|', opts.body);
  event.waitUntil(
    self.registration.showNotification(title, opts)
      .then(() => self.registration.getNotifications({ tag: opts.tag }))
      .then(list => {
        console.log('[SW push] 完成，實際存在的通知數 =', list.length);
        if (!list.length) console.warn('[SW push] ⚠ 通知已建立但系統未保留 → 作業系統層攔截');
      })
      .catch(err => console.error('[SW push] showNotification 失敗', err))
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const page = (event.notification.data && event.notification.data.page) || 'dashboard.html';

  // ⚠ 一律用 openWindow 開新視窗，並帶上時間戳。
  //   先前用 Client.navigate() 導向已開啟的分頁，若該分頁網址剛好相同
  //   （例如已經是 ?go=price.html），瀏覽器視為沒有變化，不會重新載入，
  //   load 事件不觸發 → 看起來像「點了沒反應」。（2026/09 反覆踩過）
  //   時間戳確保每次都是不同網址，必定重新載入並執行 ?go= 處理器。
  const target = new URL(
    './dashboard.html?go=' + encodeURIComponent(page) + '&_n=' + Date.now(),
    self.location.href
  ).href;

  console.log('[SW click] 開啟', target);
  event.waitUntil(self.clients.openWindow(target));
});
