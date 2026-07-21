/**
 * functions_email_alert.js — 未完成事項 Email 主動提醒
 *
 * 【使用方式】把這個檔案內容整合進你現有的 functions/index.js
 *（或另存一個檔案再 export * from './functions_email_alert.js'）
 *
 * 【需要安裝的套件】在 functions 資料夾下執行：
 *   npm install nodemailer
 *
 * 【需要的環境變數】用以下指令設定，值不要寫進程式碼、不要進 repo：
 *   firebase functions:secrets:set GMAIL_USER      ← 用來寄信的 Gmail 帳號，例如 xxx@gmail.com
 *   firebase functions:secrets:set GMAIL_APP_PASS  ← Google「應用程式密碼」，不是登入密碼本身
 *
 * 應用程式密碼申請方式：Google 帳號 → 安全性 → 兩步驟驗證（須先開啟）→ 應用程式密碼 → 產生
 *
 * 【部署】
 *   firebase deploy --only functions:checkUnfinishedAndNotifyEmail
 */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const GMAIL_USER     = defineSecret('GMAIL_USER');
const GMAIL_APP_PASS = defineSecret('GMAIL_APP_PASS');

const normLoc = s => (s || '').replace(/鋪/g, '舖').replace(/\s/g, '').trim();
const twToday = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const twNowHM = () => {
  const d = new Date(Date.now() + 8 * 3600000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

// ── 依模組權限 + 店面歸屬，解析該收到通知的人（admin/consultant 全域；manager 限自己店）──
// 回傳 [{email, name}]，只挑有填 alertEmail 的人
async function resolveRecipients(moduleKey, storeName /* null = 不限店面 */) {
  const permSnap = await db.doc('settings/permissions').get();
  const modules = permSnap.exists ? (permSnap.data().modules || {}) : {};
  const allowedRoles = (modules[moduleKey] && modules[moduleKey].roles) || ['admin'];

  const usersSnap = await db.collection('users').get();
  const targetNorm = storeName ? normLoc(storeName) : null;
  const out = [];

  usersSnap.forEach(d => {
    const u = d.data();
    if (u.disabled) return;
    if (!u.alertEmail) return;
    if (!allowedRoles.includes(u.role)) return;
    if (u.role === 'admin' || u.role === 'consultant') {
      out.push({ email: u.alertEmail, name: u.name || '' });
    } else if (u.role === 'manager') {
      const locs = (u.locations || []).map(normLoc);
      if (!targetNorm || locs.includes(targetNorm)) out.push({ email: u.alertEmail, name: u.name || '' });
    }
  });
  // 去重（同一 email 只留一筆）
  const seen = new Set();
  return out.filter(r => (seen.has(r.email) ? false : seen.add(r.email)));
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

async function checkDateReport(collectionName, dateField) {
  const today = twToday();
  const hs = await db.doc('hr/settings').get();
  const allStores = hs.exists ? (hs.data().workLocations || []).filter(Boolean) : [];
  if (!allStores.length) return [];
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

const CHECKERS = {
  task:     { label: '📌 店務追蹤有逾期未完成任務', run: checkTask },
  price:    { label: '🥬 菜價回報今日尚未填寫',     run: () => checkDateReport('price_reports', 'date') },
  cctv:     { label: '📹 監視器回報今日尚未填寫',   run: () => checkDateReport('cctv_reports', 'date') },
  delivery: { label: '🚚 配送人員回報明日尚未填寫', run: checkDelivery },
};

// ── 依店面分組後，彙整成「每個收件人一封信」，避免一人被轟炸多封 ──
async function buildRecipientMessages(enabledItems) {
  const perRecipient = new Map(); // email -> {name, lines:Set}

  for (const key of Object.keys(CHECKERS)) {
    if (!enabledItems[key]) continue;
    const { label, run } = CHECKERS[key];
    let stores = [];
    try { stores = await run(); } catch (e) { console.error(`[alert] ${key} 檢查失敗`, e); continue; }
    if (!stores.length) continue;

    const add = (r, line) => {
      if (!perRecipient.has(r.email)) perRecipient.set(r.email, { name: r.name, lines: new Set() });
      perRecipient.get(r.email).lines.add(line);
    };

    // 全域收件人（admin/consultant，不分店面都通知一次）
    const globalRecipients = await resolveRecipients(key, null);
    const globalEmails = new Set(globalRecipients.map(r => r.email));
    globalRecipients.forEach(r => add(r, `${label}：${stores.join('、')}`));

    // 各店店長：只提該店自己的問題
    for (const store of stores) {
      const storeRecipients = await resolveRecipients(key, store);
      storeRecipients.forEach(r => {
        if (globalEmails.has(r.email)) return; // 已在全域清單收過，不重複
        add(r, `${label}：${store}`);
      });
    }
  }
  return perRecipient;
}

// ── 排程：每 10 分鐘檢查一次「現在時間是否到了設定的檢查時間」，避免改時間就要重新部署 ──
exports.checkUnfinishedAndNotifyEmail = onSchedule(
  { schedule: 'every 10 minutes', timeZone: 'Asia/Taipei', secrets: [GMAIL_USER, GMAIL_APP_PASS] },
  async () => {
    const cfgSnap = await db.doc('settings/alert_config').get();
    const cfg = cfgSnap.exists ? cfgSnap.data() : null;
    if (!cfg || !cfg.enabled) return;

    const today = twToday();
    if (cfg.lastSentDate === today) return; // 今天已經發過

    const nowHM = twNowHM();
    if (nowHM < (cfg.checkTime || '23:00')) return; // 還沒到設定時間

    const perRecipient = await buildRecipientMessages(cfg.items || {});
    if (!perRecipient.size) {
      await db.doc('settings/alert_config').set(
        { lastSentDate: today, lastSentCount: 0, lastSentAt: new Date().toISOString() },
        { merge: true }
      );
      return;
    }

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER.value(), pass: GMAIL_APP_PASS.value() },
    });

    let sent = 0;
    for (const [email, { name, lines }] of perRecipient) {
      const listHtml = [...lines].map(l => `<li>${l}</li>`).join('');
      try {
        await transporter.sendMail({
          from: `鑫系統提醒 <${GMAIL_USER.value()}>`,
          to: email,
          subject: '🔔 鑫系統｜今日尚有未完成事項',
          html: `<p>${name ? name + ' 您好，' : ''}以下事項到指定時間仍未完成：</p><ul>${listHtml}</ul><p>請盡快至系統確認處理。</p>`,
        });
        sent++;
      } catch (e) {
        console.error('[alert] 寄信失敗', email, e);
      }
    }

    await db.doc('settings/alert_config').set(
      { lastSentDate: today, lastSentCount: sent, lastSentAt: new Date().toISOString() },
      { merge: true }
    );
    console.log('[alert] 本次發送完成，共', sent, '封');
  }
);
