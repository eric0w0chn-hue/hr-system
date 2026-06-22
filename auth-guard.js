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

// ── 跨頁快取（sessionStorage）──
// permissions 和 userData 在同一 session 只讀一次，換頁不重打
const PERM_KEY     = 'lp_perm_v1';
const USERDATA_KEY = 'lp_user_v1';
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
  try { sessionStorage.removeItem(PERM_KEY); sessionStorage.removeItem(USERDATA_KEY); } catch {}
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
 * 取得已快取的店面類型設定（central/store），供 dashboard 等頁面共用，
 * 避免重複讀取 settings/permissions。優先用 session 快取。
 * @returns {Promise<Object>} locationTypes 物件，如 { '梁平鑫央廚':'central', ... }
 */
export async function getLocationTypes() {
  const modules = await fetchPermissions();
  return modules['__locationTypes__'] || {};
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

  onAuthStateChanged(auth, async user => {
    // ① 未登入
    if (!user) {
      window.location.href = redirectTo;
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
          window.location.href = redirectTo + '?disabled=1';
          return;
        }
        userData = snap.data();
        cacheSet(cacheKey, userData);
      }
    } catch (e) {
      console.error('[auth-guard] 讀取使用者失敗', e);
      window.location.href = redirectTo;
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
      window.location.href = noPermRedirect;
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
        window.location.href = noPermRedirect;
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
  });
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
