/**
 * sw.js — 梁平鑫系統 Service Worker
 * 策略：
 *   - Firebase SDK (gstatic CDN)：Cache First（版本固定，永遠快取）
 *   - HR 受控寫入九頁與 helper：同版本 Network First（混版拒絕、離線僅回本版）
 *   - 其餘本站 HTML / JS / CSS：Stale While Revalidate
 *   - Firestore / Auth API：不快取（必須走網路取最新資料）
 */

const CACHE_NAME = 'lp-xin-v19-hr-source-r5';
const SDK_CACHE_NAME = 'lp-xin-firebase-sdk';
const HR_SOURCE_RELEASE = 'hr-source-r5-20260919';
const HR_SOURCE_FILES = new Set(['hr.html','account.html','backup.html','batch_accounts.html','annual_leave.html','salary.html','schedule.html','bonus.html','set_ins_location.html','hr-source-client.js']);
const SOURCE_BASE = new URL('./',self.location.href);
const isSdkUrl = value => {const url=new URL(value);return url.protocol==='https:'&&url.hostname==='www.gstatic.com'&&url.pathname.startsWith('/firebasejs/');};
function sourceFile(request){
  const url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==SOURCE_BASE.origin||!url.pathname.startsWith(SOURCE_BASE.pathname))return null;
  const file=url.pathname.slice(SOURCE_BASE.pathname.length);
  return HR_SOURCE_FILES.has(file)?file:null;
}
async function sameSourceRelease(response,file){
  if(!response||response.status!==200)return false;
  const text=await response.clone().text();
  return file==='hr-source-client.js'
    ? text.includes("export const HR_SOURCE_RELEASE = '"+HR_SOURCE_RELEASE+"';")
    : text.includes('<meta name="hr-source-release" content="'+HR_SOURCE_RELEASE+'">');
}
function sourceUnavailable(){return new Response('HR 系統版本更新中或目前離線。請保留其他分頁的未儲存內容，稍後手動重新載入。',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}});}
async function sourceNetworkFirst(request,file){
  let response;
  try{response=await fetch(request,{cache:'no-store'});}catch{
    try{const cached=await (await caches.open(CACHE_NAME)).match(request);if(await sameSourceRelease(cached,file))return cached;}catch{}
    return sourceUnavailable();
  }
  if(!response.ok)return response;
  if(!await sameSourceRelease(response,file))return sourceUnavailable();
  try{await (await caches.open(CACHE_NAME)).put(request,response.clone());}catch{}
  return response;
}
async function preserveSdkAndCleanOldCaches(){
  const sdk=await caches.open(SDK_CACHE_NAME);
  const old=(await caches.keys()).filter(key=>/^lp-xin-v\d+(?:-|$)/.test(key)&&key!==CACHE_NAME);
  await Promise.all(old.map(async key=>{
    try{
      const cache=await caches.open(key);
      for(const request of await cache.keys())if(isSdkUrl(request.url)){
        const response=await cache.match(request);if(response)await sdk.put(request,response);
      }
      await caches.delete(key);
    }catch{console.warn('[SW] SDK 快取保留未完成，保留舊快取');}
  }));
}
function announceSourceRelease(client){client?.postMessage({type:'HR_SOURCE_RELEASE',release:HR_SOURCE_RELEASE});}

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
    Promise.all(PRECACHE.map(async url=>{
      try{
        const sdk=isSdkUrl(new URL(url,self.location.href).href);
        const cache=await caches.open(sdk?SDK_CACHE_NAME:CACHE_NAME);
        if(sdk){const cached=await caches.match(url);if(cached){await cache.put(url,cached);return;}}
        await cache.addAll([url]);
      }catch{console.warn('[SW] precache 部分失敗（不影響運作）');}
    })).then(() => self.skipWaiting())
  );
});

// ── activate：清除舊版快取 ──
self.addEventListener('activate', event => {
  event.waitUntil(
    preserveSdkAndCleanOldCaches().then(() => self.clients.claim())
      .then(()=>self.clients.matchAll({type:'window',includeUncontrolled:true}))
      .then(clients=>clients.forEach(announceSourceRelease))
  );
});

self.addEventListener('message',event=>{if(event.data?.type==='HR_SOURCE_RELEASE_REQUEST')announceSourceRelease(event.source);});

// ── fetch：攔截請求 ──
self.addEventListener('fetch', event => {
  const url = event.request.url;

  const criticalFile=sourceFile(event.request);
  if(criticalFile){event.respondWith(sourceNetworkFirst(event.request,criticalFile));return;}

  // 1. Firebase API — 永遠走網路，不介入
  if(NETWORK_ONLY.some(d => url.includes(d))) return;

  // 2. Firebase SDK (gstatic) — Cache First
  if(event.request.method==='GET'&&isSdkUrl(url)) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if(cached) return cached;
        return fetch(event.request).then(resp => {
          if(resp.ok){
            const clone = resp.clone();
            caches.open(SDK_CACHE_NAME).then(c => c.put(event.request, clone));
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

  // ⚠ 直接開功能頁，不繞 dashboard 的 ?go= 機制。
  //   功能頁本來就能獨立開啟（自帶 topbar + authGuard + 返回鈕），
  //   繞過 dashboard 就沒有載入時序、網址相同不重載、iframe 誤判等問題。
  //   （2026/09 用 navigate / postMessage / ?go= 都失敗，改用這個做法）
  const target = new URL('./' + page + '?_n=' + Date.now(), self.location.href).href;

  console.log('[SW click] 開啟功能頁', target);
  event.waitUntil(self.clients.openWindow(target));
});
