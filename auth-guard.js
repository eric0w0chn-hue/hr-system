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
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

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

// 權限設定快取（同一頁面生命週期內只讀一次）
let _permCache = null;
let _permFetch  = null;  // 進行中的 fetch promise

async function fetchPermissions() {
  if (_permCache) return _permCache;
  if (_permFetch) return _permFetch;   // 避免同時發多個請求

  _permFetch = getDoc(doc(db, 'settings', 'permissions')).then(snap => {
    if(snap.exists()){
      _permCache = snap.data().modules || {};
      // 把 locationTypes 附掛在 __locationTypes__ key 供判斷用
      _permCache['__locationTypes__'] = snap.data().locationTypes || {};
    } else {
      _permCache = {};
    }
    _permFetch = null;
    return _permCache;
  }).catch(() => {
    _permFetch = null;
    return {};
  });
  return _permFetch;
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
  } = options;

  onAuthStateChanged(auth, async user => {
    // ① 未登入
    if (!user) {
      window.location.href = redirectTo;
      return;
    }

    // ② 讀取使用者資料
    let userData;
    try {
      const snap = await getDoc(doc(db, 'users', user.uid));
      if (!snap.exists() || snap.data().disabled) {
        await signOut(auth);
        window.location.href = redirectTo + '?disabled=1';
        return;
      }
      userData = snap.data();
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
    onReady({
      user,
      uid: user.uid,
      role,
      locations,
      userData,
      db,
      auth,
    });
  });
}

/**
 * 直接取得 db / auth 實例，供頁面其他地方使用
 * （不需要再自己 initializeApp）
 */
export { db, auth };
