/**
 * sw.js — 梁平鑫系統 Service Worker
 * 策略：
 *   - Firebase SDK (gstatic CDN)：Cache First（版本固定，永遠快取）
 *   - 本站 HTML / JS / CSS：Stale While Revalidate（快取版先顯示，背景更新）
 *   - Firestore / Auth API：不快取（必須走網路取最新資料）
 */

const CACHE_NAME = 'lp-xin-v4';

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
