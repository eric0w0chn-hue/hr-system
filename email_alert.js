/**
 * email_alert.js — 未完成事項提醒（PWA 推播）
 *
 * 2026/09 變更：
 *   - Email 寄送已移除，全面改為 PWA 推播。未開啟推播的人不會收到通知，
 *     名單寫進 log（`[alert] 以下 N 筆未推達…`）供追人。
 *   - 每個模組獨立推播時間、獨立推播，不再彙整成一則。
 *     時間設定在 settings/alert_config.checkTimes[模組key]，
 *     由 alert_settings.html 維護。
 *   - 當日去重改靠 push_log/{uid}_{date}_{模組key}（push_notify 負責），
 *     所以同一模組一天只推一次，不同模組互不影響。
 *   - 完整清單另存 push_inbox/{uid}，使用者點通知進系統後由 dashboard 顯示
 *     （通知列只放得下兩三行）。
 *
 * 【部署】
 *   firebase deploy --only functions:checkUnfinishedAndNotifyEmail
 *
 * 註：函式名稱保留 checkUnfinishedAndNotifyEmail 不改 —— 改名等於刪掉舊函式
 *     再建新的，排程會斷，不值得為了名稱好看冒這個險。
 */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const { notifyUser } = require('./push_notify');   // ← PWA 推播


const normLoc = s => (s || '').replace(/鋪/g, '舖').replace(/\s/g, '').trim();
const twToday = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const twNowHM = () => {
  const d = new Date(Date.now() + 8 * 3600000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

// ── 依模組權限 + 店面歸屬，解析該收到通知的人（admin/consultant 全域；manager 限自己店）──
// 回傳 [{uid, email, name}]。uid 是推播的唯一識別，email 僅保留供未來 fallback。
async function resolveRecipients(moduleKey, storeName /* null = 不限店面 */, globalOnly = false) {
  const permSnap = await db.doc('settings/permissions').get();
  const modules = permSnap.exists ? (permSnap.data().modules || {}) : {};
  const allowedRoles = (modules[moduleKey] && modules[moduleKey].roles) || ['admin'];

  const usersSnap = await db.collection('users').get();
  const targetNorm = storeName ? normLoc(storeName) : null;
  const out = [];

  usersSnap.forEach(d => {
    const u = d.data();
    if (u.disabled) return;
    if (!allowedRoles.includes(u.role)) return;
    // ⚠ 2026/09：原本這裡要求 `u.alertEmail` 才納入收件人，那是 email 時代的條件。
    //   email_bind.html 已下線，新進管理職沒有地方設定 alertEmail，
    //   再擋就會變成「開了推播也永遠收不到」。
    //   現在改由 notifyUser 判斷——沒有 push token 自然推不到，不需要前置條件。
    if (globalOnly) {
      // 全域清單：只有 admin（看得到全部店面）
      if (u.role === 'admin') out.push({ uid: d.id, email: u.alertEmail || '', name: u.name || '' });
    } else {
      // 各店清單：admin 以外的角色（consultant/manager），只收自己 locations 範圍內的店
      if (u.role === 'admin') return; // admin 已在全域清單，不重複
      const locs = (u.locations || []).map(normLoc);
      if (!targetNorm || locs.includes(targetNorm)) out.push({ uid: d.id, email: u.alertEmail || '', name: u.name || '' });
    }
  });
  // 去重改用 uid（alertEmail 已非必填，可能為空或重複）
  const seen = new Set();
  return out.filter(r => (seen.has(r.uid) ? false : seen.add(r.uid)));
}

// ── 各模組檢查：回傳「有問題的店面清單」──
async function checkTask() {
  const today = twToday();
  const snap = await db.collection('store_tasks')
    .where('status', 'in', ['pending', 'in_progress']).get();
  const stores = new Set();
  snap.forEach(d => {
    const t = d.data();
    if (t.dueDate && t.dueDate < today) stores.add(t.store || '');
  });
  return [...stores];
}

async function checkDateReport(collectionName, dateField, opts = {}) {
  const today = twToday();
  const hs = await db.doc('hr/settings').get();
  let allStores = hs.exists ? (hs.data().workLocations || []).filter(Boolean) : [];
  if (!allStores.length) return [];

  // 排除公司主體（非實體店面，不需回報）
  allStores = allStores.filter(s => normLoc(s) !== normLoc('梁平有限公司'));

  // 排除央廚（例如菜價回報僅門市需填）
  if (opts.excludeCentral) {
    const permSnap = await db.doc('settings/permissions').get();
    const locTypes = permSnap.exists ? (permSnap.data().locationTypes || {}) : {};
    const centralNorm = new Set(
      Object.entries(locTypes).filter(([, t]) => t === 'central').map(([l]) => normLoc(l))
    );
    allStores = allStores.filter(s => !centralNorm.has(normLoc(s)));
  }

  const snap = await db.collection(collectionName).where(dateField, '==', today).get();
  const filled = new Set();
  snap.forEach(d => filled.add(normLoc(d.data().store || d.data().workLocation || '')));
  return allStores.filter(s => !filled.has(normLoc(s)));
}

async function checkDelivery() {
  const tomorrow = new Date(Date.now() + 8 * 3600000 + 86400000).toISOString().slice(0, 10);
  const permSnap = await db.doc('settings/permissions').get();
  const locTypes = permSnap.exists ? (permSnap.data().locationTypes || {}) : {};
  const centralStores = Object.entries(locTypes).filter(([, t]) => t === 'central').map(([l]) => l);
  if (!centralStores.length) return [];
  const snap = await db.collection('delivery_reports').where('deliveryDate', '==', tomorrow).get();
  const filled = new Set();
  snap.forEach(d => filled.add(normLoc(d.data().store || '')));
  return centralStores.filter(s => !filled.has(normLoc(s)));
}

// ── 獎金補助：完全比照 bonus.html 前端 pendingBonusesOf 判斷邏輯 ──
const FESTIVALS = {
  2026:{duanwu:'2026-06-19',midautumn:'2026-09-25'},
  2027:{duanwu:'2027-06-09',midautumn:'2027-09-15'},
  2028:{duanwu:'2028-05-27',midautumn:'2028-10-03'},
  2029:{duanwu:'2029-06-16',midautumn:'2029-09-22'},
  2030:{duanwu:'2030-06-05',midautumn:'2030-09-12'},
};

function needsBonus(title){
  const t = title || '';
  return t.includes('正職') || t.includes('兼職');
}
function tenureAmount(years){
  if(years < 2) return 0;
  if(years === 2) return 3000;
  if(years === 3) return 5000;
  if(years === 4) return 7000;
  if(years === 5) return 10000;
  return 10000 + (years - 5) * 1000;
}
function calcYearsMonths(startDate){
  if(!startDate) return {years:0, months:0, totalMonths:0};
  const p = startDate.split('-');
  const sd = new Date(+p[0], +p[1]-1, +p[2]);
  const td = new Date(Date.now() + 8 * 3600000);
  let years = td.getUTCFullYear() - sd.getFullYear();
  let months = td.getUTCMonth() - sd.getMonth();
  if(td.getUTCDate() < sd.getDate()) months--;
  if(months < 0){ years--; months += 12; }
  const totalMonths = years*12 + months;
  return {years, months, totalMonths};
}

// 忠實移植前端 empBonusInfo
function empBonusInfo(e){
  const fi = e.fixedBonuses || {};
  const ym = calcYearsMonths(e.startDate);
  const over3mo = ym.totalMonths >= 3;
  let startPlus3moStr = '';
  if(e.startDate){
    const _p3 = e.startDate.split('-');
    const _s3 = new Date(+_p3[0], +_p3[1]-1+3, +_p3[2]);
    startPlus3moStr = _s3.getFullYear()+'-'+String(_s3.getMonth()+1).padStart(2,'0')+'-'+String(_s3.getDate()).padStart(2,'0');
  }
  const td = new Date(Date.now() + 8 * 3600000);
  const yr = td.getUTCFullYear();
  const todayFullStr = td.toISOString().slice(0,10);
  const reached3mo = !!(startPlus3moStr && startPlus3moStr <= todayFullStr);

  const shoeKey = 'shoe';
  const healthKey = 'health_' + yr;
  const shoePaid = fi[shoeKey] || false;
  const healthPaid = fi[healthKey] || false;

  const birthdayStr = e.birthday ? e.birthday.slice(5,10) : '';
  const birthdayThisYear = birthdayStr ? (yr + '-' + birthdayStr) : '';
  const isBirthday = birthdayThisYear && startPlus3moStr && birthdayThisYear >= startPlus3moStr && birthdayThisYear <= todayFullStr;
  const birthdayKey = 'birthday_' + yr;
  const birthdayPaid = fi[birthdayKey] || false;

  const sd = e.startDate ? (()=>{const p=e.startDate.split('-'); return new Date(+p[0],+p[1]-1,+p[2]);})() : null;
  const annivThisYear = sd && !isNaN(sd.getTime()) ? (yr + '-' + String(sd.getMonth()+1).padStart(2,'0') + '-' + String(sd.getDate()).padStart(2,'0')) : '';
  const annivReached = annivThisYear && annivThisYear <= todayFullStr;
  const yearsAtAnniv = sd ? (yr - sd.getFullYear()) : 0;
  const isTenureToday = annivReached && yearsAtAnniv >= 2;
  const tenureKey = 'tenure_' + yr;
  const tenurePaid = fi[tenureKey] || false;

  const healthTriggerStr = (annivThisYear && startPlus3moStr)
    ? (annivThisYear >= startPlus3moStr ? annivThisYear : startPlus3moStr) : '';
  const isHealthDue = !!(healthTriggerStr && healthTriggerStr <= todayFullStr);

  const fest = FESTIVALS[yr] || {};
  const isDuanwu = fest.duanwu && startPlus3moStr && fest.duanwu >= startPlus3moStr && fest.duanwu <= todayFullStr;
  const isMidautumn = fest.midautumn && startPlus3moStr && fest.midautumn >= startPlus3moStr && fest.midautumn <= todayFullStr;
  const duanwuKey = 'duanwu_' + yr;
  const midautumnKey = 'midautumn_' + yr;
  const duanwuPaid = fi[duanwuKey] || false;
  const midautumnPaid = fi[midautumnKey] || false;

  return {
    reached3mo, shoePaid,
    healthPaid, isHealthDue,
    isBirthday, birthdayPaid,
    isTenureToday, tenurePaid,
    isDuanwu, duanwuPaid,
    isMidautumn, midautumnPaid
  };
}

// 忠實移植前端 pendingBonusesOf（回傳是否有任何待發放項目）
function hasPendingBonus(e){
  const i = empBonusInfo(e);
  if(i.reached3mo && !i.shoePaid) return true;
  // 健檢補助刻意不納入 Email 提醒條件（僅頁面紅點顯示，不寄信）
  // if(i.isHealthDue && !i.healthPaid) return true;
  if(i.isBirthday && !i.birthdayPaid) return true;
  if(i.isTenureToday && !i.tenurePaid) return true;
  if(i.isDuanwu && !i.duanwuPaid) return true;
  if(i.isMidautumn && !i.midautumnPaid) return true;
  if((e.bonuses||[]).some(b => b.status !== '已發放')) return true;
  return false;
}

async function checkBonus() {
  const empSnap = await db.doc('hr/employees').get();
  const allEmployees = empSnap.exists ? (empSnap.data().list || []) : [];
  const storesWithPending = new Set();
  for (const e of allEmployees) {
    if (!needsBonus(e.title)) continue;      // 只看正職/兼職
    if (hasPendingBonus(e) && e.workLocation) storesWithPending.add(normLoc(e.workLocation));
  }
  // 依 hr/settings.workLocations 原始順序排序（與其他項目一致）
  const hs = await db.doc('hr/settings').get();
  const order = hs.exists ? (hs.data().workLocations || []).filter(Boolean) : [];
  const ordered = order.filter(s => storesWithPending.has(normLoc(s)));
  // 補上不在 workLocations 清單內的（保底，理論上不會有）
  const known = new Set(ordered.map(normLoc));
  const rest = [...storesWithPending].filter(s => !known.has(s));
  return [...ordered, ...rest];
}

// page：推播點擊後要開哪一頁（Email 不需要，純推播用）
const CHECKERS = {
  task:     { label: '📌 店務追蹤有逾期未完成任務', page: 'task.html',            run: checkTask },
  price:    { label: '🥬 菜價回報今日尚未填寫',     page: 'price.html',           run: () => checkDateReport('price_reports', 'date', { excludeCentral: true }) },
  cctv:     { label: '📹 監視器回報今日尚未填寫',   page: 'cctv_report.html',     run: () => checkDateReport('cctv_reports', 'date') },
  delivery: { label: '🚚 配送人員回報明日尚未填寫', page: 'delivery_report.html', run: checkDelivery },
  bonus:    { label: '💰 獎金補助有待發放項目',      page: 'bonus.html',           run: checkBonus },
};

// ── 解析單一模組的收件人 ──
// 每個模組獨立推播、獨立時間，不再彙整成一則（2026/09 調整）。
async function buildRecipientsForModule(key) {
  const perRecipient = new Map(); // uid -> {name, lines:Set, page}
  const { label, run, page } = CHECKERS[key];

  let stores = [];
  try { stores = await run(); }
  catch (e) { console.error(`[alert] ${key} 檢查失敗`, e); return perRecipient; }
  if (!stores.length) return perRecipient;

  const add = (r, line) => {
    if (!r.uid) return;
    if (!perRecipient.has(r.uid)) {
      perRecipient.set(r.uid, { uid: r.uid, name: r.name, lines: new Set(), page });
    }
    perRecipient.get(r.uid).lines.add(line);
  };

  // ⚠ 內文只放店名，不重複 label —— 通知標題與彈窗標題已經是 label 了，
  //   再帶一次會變成「獎金補助有待發放項目：獎金補助有待發放項目：梁鑫…」。

  // 全域收件人（只有 admin，一次看到所有店）
  const globalRecipients = await resolveRecipients(key, null, true);
  const globalUids = new Set(globalRecipients.map(r => r.uid));
  globalRecipients.forEach(r => stores.forEach(st => add(r, st)));

  // 各店店長：只提該店自己的問題
  for (const store of stores) {
    const storeRecipients = await resolveRecipients(key, store);
    storeRecipients.forEach(r => {
      if (globalUids.has(r.uid)) return;
      add(r, store);
    });
  }
  return perRecipient;
}

// ── 排程：每 5 分鐘跑一次，逐模組判斷「是否已過該模組的推播時間」 ──
//
// 2026/09 改為每模組獨立時間、獨立推播（不合併）。
//   - 時間設定：settings/alert_config.checkTimes[模組key]（alert_settings.html 維護）
//   - 當日去重：push_notify 的 push_log/{uid}_{date}_{模組key}，所以同一模組
//     一天只會推一次，不必再靠 alert_config.lastSentDate 擋整批。
const DEFAULT_TIMES = { task:'10:00', price:'14:00', cctv:'21:00', delivery:'18:00', bonus:'09:00' };

exports.checkUnfinishedAndNotifyEmail = onSchedule(
  { schedule: 'every 5 minutes', timeZone: 'Asia/Taipei' },
  async () => {
    const cfgSnap = await db.doc('settings/alert_config').get();
    const cfg = cfgSnap.exists ? cfgSnap.data() : null;
    if (!cfg || !cfg.enabled) return;

    const today = twToday();
    const nowHM = twNowHM();
    const items = cfg.items || {};
    const times = cfg.checkTimes || {};

    let pushed = 0, missed = 0;
    const missedNames = [];
    const ranModules = [];

    for (const key of Object.keys(CHECKERS)) {
      if (!items[key]) continue;

      // 該模組的推播時間還沒到就跳過（沿用舊的單一 checkTime 當回退）
      const hm = times[key] || cfg.checkTime || DEFAULT_TIMES[key];
      if (nowHM < hm) continue;

      const perRecipient = await buildRecipientsForModule(key);
      if (!perRecipient.size) continue;
      ranModules.push(key);

      for (const [uid, { name, lines, page }] of perRecipient) {
        const arr = [...lines];
        let ok = false;
        if (uid) {
          try {
            ok = await notifyUser({
              uid,
              module: key,                       // 去重鍵含模組，各模組互不影響
              title: CHECKERS[key].label,
              body: arr.slice(0, 3).join('、')
                    + (arr.length > 3 ? ` …等共 ${arr.length} 間，點開查看完整清單` : ''),
              lines: arr,
              page,
            });
          } catch (e) {
            console.error(`[alert] ${key} 推播失敗`, name || uid, e);
            ok = false;
          }
        }
        if (ok) pushed++;
        else { missed++; missedNames.push(`${name || uid}(${key})`); }
      }
    }

    if (!ranModules.length) return;   // 沒有任何模組到點或有事項，不寫狀態

    if (missedNames.length) {
      console.warn(`[alert] 以下 ${missedNames.length} 筆未推達（未開啟推播）：${missedNames.join('、')}`);
    }

    await db.doc('settings/alert_config').set(
      {
        lastSentDate: today,
        lastSentAt: new Date().toISOString(),
        lastSentPush: pushed,
        lastSentMissed: missed,
        lastSentModules: ranModules,
      },
      { merge: true }
    );
    console.log(`[alert] 完成 — 模組[${ranModules.join(',')}] 推播 ${pushed} 人、未推達 ${missed} 人`);
  }
);
