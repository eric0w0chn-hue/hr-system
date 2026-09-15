/**
 * auth-guard.js — 梁平鑫系統集中式權限守衛
 *
 * 用法（每個功能頁面，只需這一段）：
 *
 *   import { authGuard } from './auth-guard.js';
 *
 *   authGuard('meeting', ({ user, role, locations, userData, db, auth }) => {
 *     // 通過驗證後的邏輯
 *     currentRole = role;
 *     userLocations = locations;
 *     loadRecords();
 *   });
 *
 * moduleKey 對應 Firestore settings/permissions.modules 的 key。
 * 若 Firestore 無此 key 的設定，預設只有 admin 可進入。
 */

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, doc, getDoc, collection, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyAg_dfvoxA1dQYqHzdqPtEot8wT-wKZal4",
  authDomain:        "liangpinghri.firebaseapp.com",
  projectId:         "liangpinghri",
  storageBucket:     "liangpinghri.firebasestorage.app",
  messagingSenderId: "410255807470",
  appId:             "1:410255807470:web:dc08ba070c7db4f083f4ff"
};

// 避免重複初始化（多個頁面共用時）
const app  = getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db   = getFirestore(app);

// 將 auth 實例掛到 window，供同源 iframe 子頁借用已驗證狀態
// （主框架 dashboard 載入後，iframe 內的 authGuard 可透過 window.parent.__lpAuth
//   取得已就緒的登入狀態，省去每次換頁重新初始化 Auth 的等待）
try { window.__lpAuth = auth; } catch (_) {}

// ── 跨頁快取（sessionStorage）──
// permissions 和 userData 在同一 session 只讀一次，換頁不重打
const PERM_KEY     = 'lp_perm_v1';
const USERDATA_KEY = 'lp_user_v1';
const STORE_KEY    = 'lp_store_v1';
const CACHE_TTL    = 5 * 60 * 1000; // 5 分鐘

function cacheGet(key) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL) { sessionStorage.removeItem(key); return null; }
    return data;
  } catch { return null; }
}
function cacheSet(key, data) {
  try { sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch {}
}
export function clearAuthCache() {
  try { sessionStorage.removeItem(PERM_KEY); sessionStorage.removeItem(USERDATA_KEY); sessionStorage.removeItem(STORE_KEY); } catch {}
}

let _permFetch = null;
async function fetchPermissions() {
  const cached = cacheGet(PERM_KEY);
  if (cached) return cached;
  if (_permFetch) return _permFetch;

  _permFetch = getDoc(doc(db, 'settings', 'permissions')).then(snap => {
    const result = {};
    if (snap.exists()) {
      Object.assign(result, snap.data().modules || {});
      result['__locationTypes__'] = snap.data().locationTypes || {};
    }
    cacheSet(PERM_KEY, result);
    _permFetch = null;
    return result;
  }).catch(() => { _permFetch = null; return {}; });
  return _permFetch;
}

/**
 * 取得已快取的店面類型設定，供 dashboard 等頁面共用，避免重複讀取 settings/permissions
 */
export async function getLocationTypes() {
  const modules = await fetchPermissions();
  return modules['__locationTypes__'] || {};
}

/* ══════════════════════════════════════════════════════════════
 * 店名顯示層（displayName）
 *
 * 【為什麼需要這個】
 * 店名字串是全系統的關聯鍵：
 *   schedules/{yyyy-mm}_{店名}、shift_types/{店名} 是文件 ID
 *   users/{uid}.locations[]、hr/employees[].workLocation 是陣列值
 *   各類回報的 store、salary_records 的 empSnapshot.workLocation 是欄位值
 * 直接改店名會讓歷史資料全部查不到，且 Firestore 文件 ID 無法重新命名。
 *
 * 【解法】識別與顯示分離
 *   settings/stores 的 name        = 內部關聯鍵，建立後永遠不變
 *   settings/stores 的 displayName = 對外顯示名稱，隨時可改
 * 資料一律寫 name，畫面一律顯示 dispStore(name)。
 * 改名只動 displayName → 排班、薪資、回報、員工歸屬零影響、零手動調整。
 *
 * 【使用方式】
 *   import { authGuard, dispStore, initStoreDisplay } from './auth-guard.js?v=5';
 *   authGuard('moduleKey', async ({ ... }) => {
 *     await initStoreDisplay();        // 載入一次（有快取，很便宜）
 *     el.textContent = dispStore(rec.store);   // 同步取用
 *   });
 *
 * ⚠ 只改顯示，不要用 dispStore() 的結果當查詢條件或寫入值。
 * ══════════════════════════════════════════════════════════════ */

// 店名正規化（舖/鋪 異體字、空白），與各模組的 normLoc() 行為一致
function _normLoc(s) {
  return String(s == null ? '' : s).replace(/鋪/g, '舖').replace(/\s+/g, '').trim();
}

let _storeOrder = null;    // 主檔順序（正規化 name 陣列）
let _storeMap = null;      // { 正規化name: displayName }
let _storeMeta = null;     // { 正規化name: { storeId, type, area, active } }
let _storeFetch = null;

async function fetchStoreMaster() {
  const cached = cacheGet(STORE_KEY);
  if (cached) return cached;
  if (_storeFetch) return _storeFetch;

  _storeFetch = getDoc(doc(db, 'settings', 'stores')).then(snap => {
    const result = { disp: {}, meta: {}, order: [] };
    if (snap.exists()) {
      const list = snap.data().list;
      if (Array.isArray(list)) {
        list.forEach(s => {
          if (!s || !s.name) return;
          const k = _normLoc(s.name);
          // displayName 沒填就沿用 name，等於沒改名
          result.disp[k] = (s.displayName && String(s.displayName).trim()) || String(s.name);
          result.order.push(k);
          result.meta[k] = {
            storeId: s.storeId || '',
            code:    s.code    || '',
            type:    s.type    || 'store',
            area:    s.area    || '',
            active:  s.active !== false,
          };
        });
      }
    }
    cacheSet(STORE_KEY, result);
    _storeFetch = null;
    return result;
  }).catch(() => { _storeFetch = null; return { disp: {}, meta: {} }; });
  return _storeFetch;
}

/**
 * 載入店家主檔（帶 5 分鐘 sessionStorage 快取）
 * 呼叫 dispStore() 之前要先 await 這個
 */
/**
 * 清除店家主檔快取
 * store_manage.html 儲存後必須呼叫，否則其他頁面在 5 分鐘內仍讀到舊的顯示名稱
 */
export function clearStoreCache() {
  try { sessionStorage.removeItem(STORE_KEY); } catch {}
  _storeMap = null; _storeMeta = null; _storeOrder = null; _storeFetch = null;
}

export async function initStoreDisplay() {
  const r = await fetchStoreMaster();
  _storeMap   = r.disp  || {};
  _storeMeta  = r.meta  || {};
  _storeOrder = r.order || [];
  return _storeMap;
}

/**
 * 依店家管理的排列順序排序店名陣列
 * 不在主檔中的店名排在最後，彼此維持原本順序（不做字母排序，避免亂插）
 * 主檔未載入時原樣回傳，不改變順序
 */
export function sortStores(names) {
  if (!Array.isArray(names)) return names;
  if (!_storeOrder || !_storeOrder.length) return names.slice();
  const idx = new Map(_storeOrder.map((k, i) => [k, i]));
  return names.slice().sort((a, b) => {
    const ia = idx.has(_normLoc(a)) ? idx.get(_normLoc(a)) : Number.MAX_SAFE_INTEGER;
    const ib = idx.has(_normLoc(b)) ? idx.get(_normLoc(b)) : Number.MAX_SAFE_INTEGER;
    return ia - ib;
  });
}

/**
 * 內部店名 → 顯示名稱（同步）
 * 主檔未載入、查不到、或 displayName 未設定時，一律原樣回傳，絕不吞資料
 */
export function dispStore(name) {
  if (name == null || name === '') return '';
  if (!_storeMap) return String(name);
  return _storeMap[_normLoc(name)] || String(name);
}

/** 店名陣列 → 顯示名稱字串，預設以「、」連接 */
export function dispStores(names, sep = '、') {
  if (!Array.isArray(names)) return dispStore(names);
  return names.map(dispStore).filter(Boolean).join(sep);
}

/** 取得某店的主檔資料（storeId / type / area / active），查不到回 null */
export function storeMeta(name) {
  if (!_storeMeta || name == null) return null;
  return _storeMeta[_normLoc(name)] || null;
}

/**
 * 是否為法人實體（非店面，不納入回報/統計/招募）
 * ⚠ 主檔查不到時回傳 null，呼叫端應自行回退到原本的寫死清單，不要當成 false
 */
export function isCorporate(name) {
  const m = storeMeta(name);
  return m ? m.type === 'corporate' : null;
}

/**
 * 是否為央廚
 * ⚠ 主檔查不到時回傳 null，語意同上
 */
export function isKitchen(name) {
  const m = storeMeta(name);
  return m ? m.type === 'kitchen' : null;
}

/** 顯示名稱 → 內部店名（反查，供搜尋框比對用）。查不到原樣回傳 */
export function realStore(displayName) {
  if (displayName == null || displayName === '') return '';
  if (!_storeMap) return String(displayName);
  const t = _normLoc(displayName);
  for (const k in _storeMap) {
    if (_normLoc(_storeMap[k]) === t) return k;
  }
  return String(displayName);
}

/**
 * 集中式權限守衛
 *
 * @param {string}   moduleKey  - 對應 settings/permissions.modules 的 key
 * @param {Function} onReady    - 驗證通過後的 callback
 *                                帶入 { user, role, locations, userData, db, auth }
 * @param {Object}   [options]
 * @param {string}   [options.redirectTo]     未登入時導向，預設 /hr-system/index.html
 * @param {string}   [options.noPermRedirect] 無權限時導向，預設 /hr-system/dashboard.html
 */
export async function authGuard(moduleKey, onReady, options = {}) {
  const {
    redirectTo     = '/hr-system/index.html',
    noPermRedirect = '/hr-system/dashboard.html',
    timeoutMs      = 8000,
  } = options;

  // ── 看門狗：超時未完成驗證就顯示重試，不再無限轉圈 ──
  let _settled = false;
  const _watchdog = setTimeout(() => {
    if (_settled) return;
    const loadingEl = document.getElementById('loading');
    if (loadingEl) {
      loadingEl.innerHTML =
        '<div style="text-align:center;padding:24px;color:#5A6175;font-size:14px;line-height:1.8">' +
        '連線逾時，請檢查網路<br>' +
        '<button onclick="location.reload()" style="margin-top:12px;padding:10px 24px;' +
        'font-size:14px;border-radius:8px;border:1px solid #C8CDD8;background:#2D3142;' +
        'color:#fff;cursor:pointer;font-family:inherit;min-height:44px">↻ 重新載入</button>' +
        '</div>';
    }
  }, timeoutMs);
  const _clearWatchdog = () => { _settled = true; clearTimeout(_watchdog); };

  async function handleUser(user) {
    // ① 未登入
    if (!user) {
      if (window.self !== window.top) { try { window.top.location.href = redirectTo; } catch(_){} } else { window.location.href = redirectTo; }
      return;
    }

    // ② 讀取使用者資料（優先從 sessionStorage 快取）
    let userData;
    try {
      const cacheKey = USERDATA_KEY + '_' + user.uid;
      const cached = cacheGet(cacheKey);
      if (cached) {
        userData = cached;
      } else {
        const snap = await getDoc(doc(db, 'users', user.uid));
        if (!snap.exists() || snap.data().disabled) {
          await signOut(auth);
          if (window.self !== window.top) { try { window.top.location.href = redirectTo + '?disabled=1'; } catch(_){} } else { window.location.href = redirectTo + '?disabled=1'; }
          return;
        }
        userData = snap.data();
        cacheSet(cacheKey, userData);
      }
    } catch (e) {
      console.error('[auth-guard] 讀取使用者失敗', e);
      if (window.self !== window.top) { try { window.top.location.href = redirectTo; } catch(_){} } else { window.location.href = redirectTo; }
      return;
    }

    const role      = userData.role || 'employee';
    const locations = userData.locations || (userData.workLocation ? [userData.workLocation] : []);

    // ③ 讀取集中權限設定
    const modules = await fetchPermissions();

    // ④ 判斷權限
    //    - Firestore 無此 key → 預設只有 admin 可進
    //    - roles 為空陣列 → 視為不限制（全部可進）
    const modPerm  = modules[moduleKey];
    const allowed  = modPerm?.roles;
    if (allowed !== undefined && allowed.length > 0 && !allowed.includes(role)) {
      // iframe 內：跳到最上層避免嵌套；獨立開：直接跳
      if (window.self !== window.top) {
        try { window.top.location.href = noPermRedirect; } catch(_){ window.parent.postMessage({type:'navigate',page:'dashboard.html'},'*'); }
      } else {
        window.location.href = noPermRedirect;
      }
      return;
    }

    // ⑤ 判斷店面類型限制（locationType: 'all' | 'central' | 'store'）
    //    admin 不受店面類型限制
    const locType = modPerm?.locationType;
    if (locType && locType !== 'all' && role !== 'admin') {
      // 讀取 locationTypes 設定
      const locationTypes = modules['__locationTypes__'] || {};
      // 取得該 user 負責的店面中，是否有符合類型的店
      const hasMatch = locations.some(loc => {
        const t = locationTypes[loc] || 'store';
        return t === locType;
      });
      if (!hasMatch) {
        if (window.self !== window.top) {
          try { window.top.location.href = noPermRedirect; } catch(_){ window.parent.postMessage({type:'navigate',page:'dashboard.html'},'*'); }
        } else {
          window.location.href = noPermRedirect;
        }
        return;
      }
    }

    // ⑤ 通過，回傳 context
    // ⑥ 過濾 locations：只回傳符合 locationType 的店面
    //    功能設 'all' 不過濾；admin 也依 locationType 過濾（但不影響能否進入）
    const locationTypes = modules['__locationTypes__'] || {};
    const allOfType     = modPerm?.allOfType === true;
    let filteredLocations;
    if (!locType || locType === 'all') {
      // 不限制，回傳全部
      filteredLocations = locations;
    } else if (allOfType) {
      // 開放看全部同類型：回傳 locationTypes 裡所有符合類型的店面
      filteredLocations = Object.entries(locationTypes)
        .filter(([, t]) => t === locType)
        .map(([loc]) => loc);
    } else {
      // 預設：只回傳 user 自己 locations 裡符合類型的店面
      filteredLocations = locations.filter(loc => (locationTypes[loc] || 'store') === locType);
    }

    _clearWatchdog();
    onReady({
      user,
      uid: user.uid,
      role,
      locations: filteredLocations,
      userData,
      db,
      auth,
    });
  }

  // ── Auth 放行策略（三層，由快到慢）──
  // ① 自己的 currentUser 已就緒（同頁內再次呼叫）→ 直接放行
  // ② iframe 場景：借用主框架(dashboard)已驗證的 user，跳過 iframe 內
  //    Auth SDK 重新初始化的等待（這段在新 iframe context 約需 1-2 秒，是換頁卡頓主因）
  // ③ 冷啟動（首次開啟、無 parent 或 parent 尚未就緒）→ 掛 onAuthStateChanged 等待
  // 若 token 實際已失效，後續 Firestore 讀取會失敗並走 catch 導回登入頁，安全。
  if (auth.currentUser) {
    handleUser(auth.currentUser);
    return;
  }

  // ② 嘗試借用主框架的已登入 user
  let parentUser = null;
  try {
    if (window.parent && window.parent !== window) {
      // 主框架與 iframe 同源，可直接存取 parent 的 Firebase Auth 狀態
      const parentAuth = window.parent.__lpAuth;
      if (parentAuth && parentAuth.currentUser) {
        parentUser = parentAuth.currentUser;
      }
    }
  } catch (_) { /* 跨源或尚未就緒，忽略 */ }

  if (parentUser) {
    handleUser(parentUser);
    // 背景仍掛一次 onAuthStateChanged，確保狀態變動（登出等）能反映
    onAuthStateChanged(auth, user => { if (!user) { window.location.href = redirectTo; } });
    return;
  }

  // ③ 冷啟動才等
  onAuthStateChanged(auth, user => { handleUser(user); });
}

/**
 * 寫入系統操作日誌至 sys_oplogs
 */
export async function writeOpLog({ editor, role, module: mod, action, detail = '' }) {
  try {
    await addDoc(collection(db, 'sys_oplogs'), {
      ts:     serverTimestamp(),
      editor: editor || '—',
      role:   role   || '—',
      module: mod    || '—',
      action,
      detail,
    });
  } catch (e) {
    console.warn('[writeOpLog] 寫入失敗', e);
  }
}

/**
 * 直接取得 db / auth 實例，供頁面其他地方使用
 * （不需要再自己 initializeApp）
 */
export { db, auth };
