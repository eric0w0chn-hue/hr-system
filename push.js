/**
 * push.js — 梁平鑫系統 PWA 推播（FCM Web Push）
 * 由 dashboard.html 底部以 <script type="module" src="./push.js?v=1"></script> 載入。
 *
 * 設計重點：
 *  1. 不另開 firebase-messaging-sw.js。GitHub Pages 是子路徑 /hr-system/，
 *     FCM 預設去抓根目錄 /firebase-messaging-sw.js 會 404。
 *     解法：getToken 時把現有的 SW registration 傳進 serviceWorkerRegistration。
 *  2. messaging SDK 採「按需動態 import」，不支援的裝置完全不會下載，零負擔。
 *  3. token 寫 push_tokens/{uid}（不動 users/{uid}，避免撞既有權限規則）。
 */

const VAPID_KEY = 'BFob5TAF6uPb6FgfFiyznRof-PX3M-6Nl-bxtqg0GuJJLWbGSks2tbtX6G_6rYw1hy_5FCt05W-IjiH813XtMEc';
const SDK = 'https://www.gstatic.com/firebasejs/10.12.0/';

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
                     window.navigator.standalone === true;

function supported(){
  return ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window);
}

function setBtn(text, title, disabled){
  const b = document.getElementById('pushBtn');
  if(!b) return;
  b.textContent = text;
  b.title = title || '';
  b.disabled = !!disabled;
  b.style.opacity = disabled ? '.45' : '1';
}

// 等 dashboard 的 module script 初始化完 __lpAuth（同一份 App 實例）
function waitAuth(ms = 8000){
  return new Promise(resolve => {
    const t0 = Date.now();
    (function tick(){
      const a = window.__lpAuth;
      if(a && a.currentUser) return resolve(a.currentUser);
      if(a && Date.now() - t0 > 2500) return resolve(a.currentUser || null);
      if(Date.now() - t0 > ms) return resolve(null);
      setTimeout(tick, 200);
    })();
  });
}

async function getReg(){
  // 用既有的 sw.js registration，不另外註冊
  let reg = await navigator.serviceWorker.getRegistration('./');
  if(!reg) reg = await navigator.serviceWorker.ready;
  return reg;
}

async function saveToken(token){
  const user = window.__lpAuth && window.__lpAuth.currentUser;
  if(!user || !token) return;
  const [{ getApp }, fs] = await Promise.all([
    import(SDK + 'firebase-app.js'),
    import(SDK + 'firebase-firestore.js')
  ]);
  const db = fs.getFirestore(getApp());
  await fs.setDoc(fs.doc(db, 'push_tokens', user.uid), {
    uid: user.uid,
    tokens: fs.arrayUnion(token),
    ua: navigator.userAgent.slice(0, 180),
    updatedAt: new Date().toISOString()
  }, { merge: true });
}

async function register(interactive){
  const reg = await getReg();
  const { getMessaging, getToken } = await import(SDK + 'firebase-messaging.js');
  const { getApp } = await import(SDK + 'firebase-app.js');
  const messaging = getMessaging(getApp());
  const token = await getToken(messaging, {
    vapidKey: VAPID_KEY,
    serviceWorkerRegistration: reg
  });
  if(!token) throw new Error('未取得 token');
  await saveToken(token);
  setBtn('🔔 已開啟', '推播已開啟（本裝置）', true);
  if(interactive) alert('推播已開啟 ✅\n未完成事項會直接推到這支裝置。');
}

// 使用者手動點擊
window.lpTogglePush = async function(){
  if(!supported()){
    alert('這個瀏覽器不支援推播通知。\n建議改用 Chrome（Android）或 Safari 16.4 以上（iPhone）。');
    return;
  }
  if(isIOS && !isStandalone){
    alert('iPhone / iPad 需要先「加入主畫面」才能開啟推播：\n\n'
        + '1. 點 Safari 下方的「分享」圖示 ⬆\n'
        + '2. 選「加入主畫面」\n'
        + '3. 從桌面的鑫系統圖示開啟，再按一次這顆鈴鐺\n\n'
        + '（這是 Apple 的限制，在 Safari 分頁內無法開啟通知）');
    return;
  }
  if(Notification.permission === 'denied'){
    alert('通知權限先前被拒絕了。\n請到瀏覽器（或手機設定 → 鑫系統 → 通知）改成允許後再試。');
    return;
  }
  setBtn('⏳', '處理中', true);
  try{
    const perm = await Notification.requestPermission();
    if(perm !== 'granted'){ setBtn('🔔', '開啟推播通知', false); return; }
    await register(true);
  }catch(err){
    console.warn('[push] 註冊失敗:', err);
    setBtn('🔔', '開啟推播通知', false);
    alert('推播開啟失敗：' + (err && err.message ? err.message : err));
  }
};

// 頁面載入後的靜默處理
(async function init(){
  if(!supported()){ setBtn('🔕', '此裝置不支援推播', true); return; }
  await waitAuth();
  if(!(window.__lpAuth && window.__lpAuth.currentUser)) return;

  if(Notification.permission === 'granted'){
    // 已授權 → 靜默刷新 token（換手機／token 過期時自動補回）
    try{ await register(false); }
    catch(err){ console.warn('[push] token 刷新失敗:', err); setBtn('🔔', '開啟推播通知', false); }
  }else{
    setBtn('🔔', isIOS && !isStandalone ? '請先加入主畫面' : '開啟推播通知', false);
  }
})();
