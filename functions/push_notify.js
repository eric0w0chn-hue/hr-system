/**
 * push_notify.js — 推播寄送 helper（放進 functions/ 資料夾，與 index.js 同層）
 *
 * 用法（在 index.js 頂部）：
 *   const { notifyUser } = require('./push_notify');
 *
 * 在既有的 checkUnfinishedAndNotifyEmail 裡，算出某位使用者有未完成事項時：
 *   const pushed = await notifyUser({
 *     uid,
 *     module: 'task',                    // task / price / cctv / delivery
 *     title: '店務追蹤有逾期任務',
 *     body : `${storeName} 有 ${n} 筆任務逾期未完成`,
 *     page : 'task.html'
 *   });
 *   if (!pushed) { /* 沒有推播 token → 照舊寄 email（fallback） *\/ }
 *
 * 設計：
 *  - data-only 訊息（不帶 notification 欄位），由 sw.js 決定顯示方式，避免重複通知
 *  - 每個 uid + 日期 + module 一天只推一次（排程每 5 分鐘也不會洗版）
 *  - 自動清除失效 token
 */

const admin = require('firebase-admin');

function twToday() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

/**
 * @returns {Promise<boolean>} true = 已推播（或今天已推過）；false = 沒有可用 token，呼叫端應改寄 email
 */
async function notifyUser({ uid, module: mod, title, body, page, lines }) {
  const db = admin.firestore();

  // 1. 取 token
  const snap = await db.collection('push_tokens').doc(uid).get();
  const tokens = (snap.exists && Array.isArray(snap.data().tokens)) ? snap.data().tokens : [];
  if (!tokens.length) return false;

  // 2. 當日去重
  // ⚠ 這裡回 true 代表「今天已推過，不必再寄 email」。
  //   只有真正推播成功才會寫這筆記錄（見函式結尾），所以推播失敗的那天
  //   不會留下記錄，隔一輪排程仍會重試或退回 email，不會靜默漏掉。
  const logId = `${uid}_${twToday()}_${mod}`;
  const logRef = db.collection('push_log').doc(logId);
  const logSnap = await logRef.get();
  if (logSnap.exists) {
    console.log(`[push] uid=${uid} module=${mod} 今日已推播過，略過`);
    return true;
  }

  // 3. 送出（data-only）
  // ⚠ 必須帶 notification 欄位，不能只送 data。
  //   iOS Safari 規定每則 push 都要有可見通知，data-only 訊息會被直接丟棄，
  //   連 service worker 的 push 事件都不會觸發（2026/09 實測踩過）。
  //   重複顯示的問題改由 sw.js 那邊處理（偵測到已有系統通知就不再自行顯示）。
  const res = await admin.messaging().sendEachForMulticast({
    tokens,
    webpush: {
      headers: { Urgency: 'high', TTL: '3600' },
      notification: {
        title: String(title || '鑫系統提醒'),
        body : String(body || ''),
        icon : 'https://eric0w0chn-hue.github.io/hr-system/icons/icon-192.png',
        badge: 'https://eric0w0chn-hue.github.io/hr-system/icons/icon-192.png',
        tag  : `lp-${mod}`,
        requireInteraction: true
      },
      fcmOptions: {
        link: `https://eric0w0chn-hue.github.io/hr-system/dashboard.html?go=${page}`
      },
      data: {
        title: String(title || '鑫系統提醒'),
        body : String(body || ''),
        page : String(page || 'dashboard.html'),
        tag  : `lp-${mod}`
      }
    }
  });

  // 4. 清掉失效 token
  const dead = [];
  res.responses.forEach((r, i) => {
    if (r.success) return;
    const code = r.error && r.error.code;
    if (code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-argument' ||
        code === 'messaging/invalid-registration-token') {
      dead.push(tokens[i]);
    }
  });
  if (dead.length) {
    await snap.ref.update({ tokens: admin.firestore.FieldValue.arrayRemove(...dead) })
      .catch(e => console.warn('[push] 清除失效 token 失敗', e));
  }

  console.log(`[push] uid=${uid} module=${mod} ok=${res.successCount} fail=${res.failureCount} dead=${dead.length}`);

  if (res.successCount === 0) return false;   // 全失敗 → 退回 email

  await logRef.set({
    uid, module: mod, date: twToday(),
    sentAt: admin.firestore.FieldValue.serverTimestamp(),
    ok: res.successCount
  });

  // 通知列只放得下兩三行，完整清單另外存一份，
  // 使用者點通知進系統後由 dashboard 讀出來完整顯示。
  if (Array.isArray(lines) && lines.length) {
    await db.collection('push_inbox').doc(uid).set({
      uid,
      title: String(title || '未完成事項'),
      lines,
      date: twToday(),
      createdAt: new Date().toISOString(),
      readAt: null
    }).catch(e => console.warn('[push] push_inbox 寫入失敗', e));
  }
  return true;
}

module.exports = { notifyUser };
