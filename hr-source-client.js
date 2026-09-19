import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';

export const HR_SOURCE_RELEASE = 'hr-source-r5-20260919';
let observedWorkerRelease=null;
let releaseObserverInstalled=false;
function pageRelease(){return typeof document==='undefined'?HR_SOURCE_RELEASE:document.querySelector('meta[name="hr-source-release"]')?.content;}
function showReleaseNotice(){
  if(typeof document==='undefined'||!document.body||document.getElementById('hr-source-release-notice'))return;
  const notice=document.createElement('div');
  notice.id='hr-source-release-notice';notice.setAttribute('role','status');
  notice.style.cssText='position:sticky;top:0;z-index:10000;padding:12px;background:#fff3cd;color:#573e00;border:1px solid #e3c56d;font-size:14px;line-height:1.6';
  notice.textContent='系統版本已更新或不一致。畫面輸入仍保留；請先備存未儲存內容，再手動重新載入本頁。';
  document.body.prepend(notice);
}
function observeRelease(){
  if(releaseObserverInstalled)return;
  releaseObserverInstalled=true;
  if(pageRelease()!==HR_SOURCE_RELEASE)showReleaseNotice();
  if(typeof navigator==='undefined'||!navigator.serviceWorker)return;
  const serviceWorker=navigator.serviceWorker;
  const askRelease=()=>serviceWorker.controller?.postMessage({type:'HR_SOURCE_RELEASE_REQUEST'});
  serviceWorker.addEventListener('message',event=>{
    if(event.source!==serviceWorker.controller||event.data?.type!=='HR_SOURCE_RELEASE')return;
    observedWorkerRelease=event.data.release;
    if(observedWorkerRelease!==HR_SOURCE_RELEASE||pageRelease()!==HR_SOURCE_RELEASE)showReleaseNotice();
  });
  serviceWorker.addEventListener('controllerchange',()=>{observedWorkerRelease=null;askRelease();});
  askRelease();
  // Check an already registered worker; never navigate/reload an open editor.
  serviceWorker.getRegistration?.().then(registration=>registration?.update()).catch(()=>{});
}
function assertRelease(){
  if(pageRelease()!==HR_SOURCE_RELEASE||(observedWorkerRelease!==null&&observedWorkerRelease!==HR_SOURCE_RELEASE)){
    showReleaseNotice();
    throw new Error('SOURCE_RELEASE_MISMATCH：請先備存未儲存內容，再手動重新載入本頁');
  }
}

// The server always repeats authorization and precondition checks. No direct-write fallback.
export function stableSourceJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableSourceJson).join(',') + ']';
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('SOURCE_JSON_REQUIRED');
  const keys = Object.keys(value).sort();
  if (keys.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('SOURCE_UNSAFE_KEY');
  return '{' + keys.map(key => JSON.stringify(key) + ':' + stableSourceJson(value[key])).join(',') + '}';
}
export async function hashData(data) {
  const bytes = new TextEncoder().encode(stableSourceJson(data ?? null));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function hashSnapshot(snapshot) {
  if (!snapshot || typeof snapshot.exists !== 'function' || typeof snapshot.data !== 'function') throw new Error('SOURCE_SNAPSHOT_REQUIRED');
  return hashData(snapshot.exists() ? snapshot.data() : null);
}

export function createHrSourceClient({db, invoke} = {}) {
  if (!db?.app) throw new Error('SOURCE_FIREBASE_APP_REQUIRED');
  observeRelease();
  const call = invoke || httpsCallable(getFunctions(db.app, 'asia-east1'), 'hrSourceWrite', {timeout:60000});
  async function send(data) {
    assertRelease();
    // Validate JSON before Firebase serialization; do not silently strip undefined or functions.
    stableSourceJson(data);
    try {
      const response = await call(data);
      if (response?.data?.ok !== true || !Number.isSafeInteger(response.data.version)) throw new Error('SOURCE_INVALID_RESPONSE');
      return response.data;
    } catch (error) {
      if (/aborted|VERSION_CONFLICT|SOURCE_CONFLICT/i.test(String(error?.code) + ' ' + String(error?.message))) {
        error.isConflict = true;
      }
      throw error;
    }
  }
  return Object.freeze({
    async commit({module,writes,expectedVersion} = {}) {
      if (typeof module !== 'string' || !Array.isArray(writes) || !writes.length) throw new Error('SOURCE_WRITES_REQUIRED');
      for (const write of writes) {
        if (typeof write?.path !== 'string' || !/^[a-f0-9]{64}$/.test(write.expectedHash || '')) throw new Error('SOURCE_PRECONDITION_REQUIRED');
      }
      const data = {module,writes};
      if (expectedVersion !== undefined) {
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('SOURCE_VERSION_REQUIRED');
        data.expectedVersion = expectedVersion;
      }
      return send(data);
    },
    restore(restoreBackupId) {
      if (typeof restoreBackupId !== 'string' || !restoreBackupId || /[\/\u0000-\u001f]/.test(restoreBackupId)) throw new Error('SOURCE_BACKUP_ID_REQUIRED');
      return send({module:'backup',restoreBackupId});
    },
    deleteAccount(deleteUserUid) {
      if (typeof deleteUserUid !== 'string' || !deleteUserUid || deleteUserUid.length > 128 || /[\/\u0000-\u001f]/.test(deleteUserUid)) throw new Error('SOURCE_UID_REQUIRED');
      return send({module:'account',deleteUserUid});
    },
  });
}
