const { setGlobalOptions } = require("firebase-functions");
const { onCall, HttpsError, onRequest } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");
const https = require("https");
const axios = require("axios");

admin.initializeApp();
setGlobalOptions({ maxInstances: 10 });

const OMADA_CLIENT_ID = { value: () => process.env.OMADA_CLIENT_ID };
const OMADA_CLIENT_SECRET = { value: () => process.env.OMADA_CLIENT_SECRET };
const OMADA_BASE_URL = "https://52.68.0.26";
const OMADA_ID = "1B5596";

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

async function getOmadaToken(clientId, clientSecret) {
  const response = await axios.post(
    `${OMADA_BASE_URL}/openapi/authorize/token?grant_type=client_credentials`,
    {},
    { auth: { username: clientId, password: clientSecret }, httpsAgent }
  );
  return response.data.result.accessToken;
}

async function getConnectedClients(token, siteId) {
  const response = await axios.get(
    `${OMADA_BASE_URL}/openapi/v1/${OMADA_ID}/sites/${siteId}/clients`,
    {
      headers: { Authorization: `AccessToken=${token}` },
      params: { filters: { active: true }, pageSize: 200, page: 1 },
      httpsAgent,
    }
  );
  return response.data.result.data || [];
}

async function getAllSites(token) {
  const response = await axios.get(
    `${OMADA_BASE_URL}/openapi/v1/${OMADA_ID}/sites`,
    {
      headers: { Authorization: `AccessToken=${token}` },
      params: { pageSize: 50, page: 1 },
      httpsAgent,
    }
  );
  return response.data.result.data || [];
}

// ── verifyMac ──
exports.verifyMac = onRequest({}, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  const authHeader = req.headers.authorization || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!idToken) { res.status(401).json({ error: "未提供驗證 Token" }); return; }
  try { await admin.auth().verifyIdToken(idToken); }
  catch (e) { res.status(401).json({ error: "Token 驗證失敗" }); return; }
  const { mac, siteId } = req.body;
  if (!mac) { res.status(400).json({ error: "MAC 碼不能為空" }); return; }
  res.status(200).json({ online: true });
});

// ── getSites ──
exports.getSites = onCall({}, async (request) => {
  try {
    const clientId = OMADA_CLIENT_ID.value();
    const clientSecret = OMADA_CLIENT_SECRET.value();
    const token = await getOmadaToken(clientId, clientSecret);
    const sites = await getAllSites(token);
    return { sites: sites.map((s) => ({ id: s.siteId, name: s.name })) };
  } catch (error) {
    logger.error("getSites error", error);
    throw new HttpsError("internal", "取得站點失敗");
  }
});

// ── addToOmadaWhitelist ──
exports.addToOmadaWhitelist = onCall({}, async (request) => {
  const { mac, siteId, name } = request.data;
  if (!mac || !siteId) throw new HttpsError("invalid-argument", "MAC 和 siteId 不能為空");
  try {
    const clientId = OMADA_CLIENT_ID.value();
    const clientSecret = OMADA_CLIENT_SECRET.value();
    const token = await getOmadaToken(clientId, clientSecret);
    await axios.post(
      `${OMADA_BASE_URL}/openapi/v1/${OMADA_ID}/sites/${siteId}/setting/network/macfilter`,
      { mac, name: name || mac, type: 0 },
      { headers: { Authorization: `AccessToken=${token}` }, httpsAgent }
    );
    return { success: true };
  } catch (error) {
    logger.error("addToOmadaWhitelist error", error);
    throw new HttpsError("internal", "加入白名單失敗");
  }
});

// ── checkDepartures ──
exports.checkDepartures = onRequest({}, async (req, res) => {
  try {
    const db = admin.firestore();
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const snap = await db.collection("punch_records").where("checkOut", "==", null).get();
    const alerts = [];
    for (const doc of snap.docs) {
      const data = doc.data();
      const checkIn = data.checkIn?.toDate?.();
      if (checkIn && checkIn < twoHoursAgo) {
        const minutesSince = Math.floor((now - checkIn) / 60000);
        alerts.push({ uid: data.uid, punchId: doc.id, minutesSince });
        await db.collection("departure_alerts").add({
          uid: data.uid, punchId: doc.id,
          minutesSince, notifiedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }
    res.status(200).json({ checked: snap.size, alerts: alerts.length });
  } catch (e) {
    logger.error("checkDepartures error", e);
    res.status(500).json({ error: e.message });
  }
});

// ── onDeviceApproved ──
exports.onDeviceApproved = onDocumentWritten(
  { document: "devices/{deviceId}" },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!after) return;
    if (before?.status === after.status) return;
    if (after.status !== "approved") return;
    const { mac, siteId, uid } = after;
    if (!mac || !siteId) return;
    try {
      const clientId = OMADA_CLIENT_ID.value();
      const clientSecret = OMADA_CLIENT_SECRET.value();
      const token = await getOmadaToken(clientId, clientSecret);
      await axios.post(
        `${OMADA_BASE_URL}/openapi/v1/${OMADA_ID}/sites/${siteId}/setting/network/macfilter`,
        { mac, name: uid || mac, type: 0 },
        { headers: { Authorization: `AccessToken=${token}` }, httpsAgent }
      );
      await event.data.after.ref.update({
        omadaWhitelisted: true,
        omadaWhitelistedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      logger.info("MAC 白名單加入成功", { mac, siteId });
    } catch (error) {
      logger.error("onDeviceApproved whitelist error", error);
    }
  }
);

// ── dailyHrBackup ──
const KEEP_DAYS = 30;

exports.dailyHrBackup = onSchedule(
  { schedule: "0 16 * * *", timeZone: "UTC", region: "asia-east1" },
  async () => {
    const db = admin.firestore();
    const [ivSnap, evSnap, rsSnap] = await Promise.all([
      db.doc("hr/interviews").get(),
      db.doc("hr/employees").get(),
      db.doc("hr/resigned").get(),
    ]);
    const interviews = ivSnap.exists ? ivSnap.data().list ?? [] : [];
    const employees  = evSnap.exists ? evSnap.data().list ?? [] : [];
    const resigned   = rsSnap.exists ? rsSnap.data().list ?? [] : [];

    // 備份 users collection（uid → email → empId 對應表，供帳號消失時還原用）
    const usersSnap = await db.collection('users').get();
    const users = usersSnap.docs.map(d => ({
      uid:       d.id,
      email:     d.data().email     || '',
      empId:     d.data().empId     || '',
      idNo:      d.data().idNo      || '',
      name:      d.data().name      || '',
      role:      d.data().role      || '',
      locations: d.data().locations || [],
    }));

    const now   = new Date();
    const twNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const dateLabel = twNow.toISOString().slice(0, 10);

    await db.doc(`hr_backups/${dateLabel}`).set({
      date: dateLabel, createdAt: now.toISOString(), manual: false,
      employees, resigned, interviews, users,
      counts: {
        employees:  employees.length,
        resigned:   resigned.length,
        interviews: interviews.length,
        users:      users.length,
      },
    });

    logger.info(`[dailyHrBackup] ${dateLabel} 完成 — 在職:${employees.length} 離職:${resigned.length} 求職:${interviews.length} 帳號:${users.length}`);

    const cutoff = new Date(twNow);
    cutoff.setDate(cutoff.getDate() - KEEP_DAYS);
    const cutoffLabel = cutoff.toISOString().slice(0, 10);
    const oldSnaps = await db.collection("hr_backups").where("date", "<", cutoffLabel).get();
    if (!oldSnaps.empty) {
      const batch = db.batch();
      oldSnaps.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      logger.info(`[dailyHrBackup] 清除 ${oldSnaps.size} 筆舊備份`);
    }
  }
);

// ── cleanupOldCctvVideos ──
exports.cleanupOldCctvVideos = onSchedule(
  { schedule: "0 19 * * *", timeZone: "UTC", region: "asia-east1" },
  async () => {
    const { getStorage } = require("firebase-admin/storage");
    const { getFirestore } = require("firebase-admin/firestore");
    const bucket = getStorage().bucket("liangpinghri.firebasestorage.app");
    const db = getFirestore();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 3);
    const [files] = await bucket.getFiles({ prefix: "cctv_videos/" });
    for (const file of files) {
      const [meta] = await file.getMetadata();
      if (new Date(meta.timeCreated) < cutoff) await file.delete();
    }
    const snap = await db.collection("cctv_reports")
      .where("videosExpired", "==", false)
      .where("createdAt", "<", cutoff).get();
    const batch = db.batch();
    snap.docs.forEach(d => batch.update(d.ref, { videosExpired: true }));
    if (!snap.empty) await batch.commit();
  }
);

// ── deleteAuthUser ──
exports.deleteAuthUser = onCall({}, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "未登入");
  const callerSnap = await admin.firestore()
    .collection("users").doc(request.auth.uid).get();
  if (!callerSnap.exists || callerSnap.data().role !== "admin") {
    throw new HttpsError("permission-denied", "權限不足");
  }
  const { uid } = request.data;
  if (!uid) throw new HttpsError("invalid-argument", "缺少 uid");
  try {
    await admin.auth().deleteUser(uid);
    return { success: true };
  } catch (e) {
    if (e.code === "auth/user-not-found") {
      return { success: true, note: "帳號不存在，略過" };
    }
    throw new HttpsError("internal", e.message);
  }
});

// ── 每日完整 Firestore 備份到 Cloud Storage ──
exports.dailyFirestoreBackup = onSchedule(
  { schedule: '0 17 * * *', timeZone: 'UTC', region: 'asia-east1' },
  // UTC 17:00 = 台灣時間凌晨 01:00
  async () => {
    const client = new (require('@google-cloud/firestore').v1.FirestoreAdminClient)();
    const projectId = 'liangpinghri';
    const databaseName = client.databasePath(projectId, '(default)');
    const bucket = `gs://liangpinghri-backups`;
    const now = new Date();
    const twNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const dateLabel = twNow.toISOString().slice(0, 10);
    const outputUri = `${bucket}/${dateLabel}`;
    try {
      const [operation] = await client.exportDocuments({
        name: databaseName,
        outputUriPrefix: outputUri,
        collectionIds: [], // 空陣列 = 備份全部 collections
      });
      logger.info(`[dailyFirestoreBackup] ${dateLabel} 備份完成 → ${outputUri}`);
    } catch (e) {
      logger.error('[dailyFirestoreBackup] 備份失敗', e);
      throw e;
    }
  }
);

// ════════════════════════════════════════════════════════════
// 招募系統求職者資料匯入 — 代理 Function
//
// 前端（hr.html）不直接碰招募系統的 x-api-key。
// 密鑰只存在 Function 環境，前端只呼叫這支 callable。
//
// 部署前置作業：
//   1. 設定密鑰（執行後貼上同事給的共享密鑰，Enter）
//      firebase functions:secrets:set TALENT_API_KEY
//   2. 部署（務必帶函式名稱，不要整組部署）
//      firebase deploy --only functions:importTalentApplications
// ════════════════════════════════════════════════════════════

const TALENT_ENDPOINT =
  "https://asia-east1-liangping-talent.cloudfunctions.net/getTalentApplications";

// 允許呼叫匯入的角色
const TALENT_ALLOWED_ROLES = ["admin", "consultant"];

exports.importTalentApplications = onCall(
  { secrets: ["TALENT_API_KEY"], timeoutSeconds: 30 },
  async (request) => {
    // ── ① 必須已登入 ──
    if (!request.auth) throw new HttpsError("unauthenticated", "請先登入");
    const uid = request.auth.uid;

    // ── ② 檢查角色（讀 users/{uid}.role）──
    let role = "";
    try {
      const snap = await admin.firestore().collection("users").doc(uid).get();
      role = snap.exists ? (snap.data().role || "") : "";
    } catch (e) {
      logger.error("importTalentApplications 讀取角色失敗", e);
      throw new HttpsError("internal", "無法確認權限");
    }
    if (!TALENT_ALLOWED_ROLES.includes(role)) {
      throw new HttpsError("permission-denied", "僅管理員與顧問可執行匯入");
    }

    // ── ③ 代呼叫招募系統 endpoint ──
    const apiKey = process.env.TALENT_API_KEY;
    if (!apiKey) {
      logger.error("importTalentApplications: TALENT_API_KEY 未設定");
      throw new HttpsError("failed-precondition", "尚未設定招募系統密鑰");
    }

    const status = request.data && request.data.status;
    const url = status
      ? `${TALENT_ENDPOINT}?status=${encodeURIComponent(status)}`
      : TALENT_ENDPOINT;

    let res;
    try {
      res = await axios.get(url, {
        headers: { "x-api-key": apiKey },
        timeout: 20000,
        validateStatus: () => true,
      });
    } catch (e) {
      logger.error("招募系統連線失敗", e.message);
      throw new HttpsError("unavailable", "招募系統連線失敗，請稍後再試");
    }

    if (res.status < 200 || res.status >= 300) {
      logger.error("招募系統回應異常", res.status, JSON.stringify(res.data).slice(0, 500));
      if (res.status === 401 || res.status === 403) {
        throw new HttpsError("permission-denied", "招募系統驗證失敗，請確認共享密鑰");
      }
      throw new HttpsError("internal", `招募系統回應異常（${res.status}）`);
    }

    const json = res.data;
    if (!json || json.ok !== true || !Array.isArray(json.items)) {
      logger.error("招募系統回傳結構不符", JSON.stringify(json).slice(0, 500));
      throw new HttpsError("internal", "招募系統回傳結構不符預期");
    }

    // ── ④ 只回傳需要的欄位 ──
    const items = json.items
      .map((r) => ({
        talentId: r.talentId || "",
        id: r.id || null,
        name: r.name || "",
        location: r.location || "",
        storeId: r.storeId || "",
        date: r.date || "",
        source: r.source || "",
        status: r.status || "",
        email: r.email || "",
        phone: r.phone || "",
        age: (r.age === 0 || r.age) ? r.age : null,
        military: r.military || "",
        experience: r.experience || "",
        fit: r.fit || "",
        note: r.note || "",
        resumeUrl: r.resumeUrl || "",
      }))
      .filter((r) => r.talentId && r.name);

    logger.info(`importTalentApplications: uid=${uid} role=${role} count=${items.length}`);

    return { ok: true, count: items.length, items };
  }
);


// ════════════════════════════════════════════════════════════
// 招募系統管理員同步
//
// users/{uid} 的 role / locations / email / name 變動時，
// 自動同步到招募系統的 admins/{uid}（用我方 uid 當文件 ID）。
//
// 對照：admin/consultant → hq、manager → store、其他 → 移除
//
// 走對方的 upsertAdminFromHR endpoint（方式 A），
// 共用既有的 TALENT_API_KEY，不需要 Service Account 金鑰。
//
// 部署：
//   firebase deploy --only functions:syncTalentAdmin
//   firebase deploy --only functions:resyncAllTalentAdmins
// ════════════════════════════════════════════════════════════

const TALENT_ADMIN_ENDPOINT =
  "https://asia-east1-liangping-talent.cloudfunctions.net/upsertAdminFromHR";

// 我方店名開頭關鍵字 → 對方 storeId（13 間，quanzhou/tianjin 已停用移除）
// ⚠ 用「開頭比對」而非「部分包含」：
//   「梁鑫雞肉飯專門店」含有「鑫雞肉」，用 includes 會同時對上
//   liangxin 與 xinjirou，導致店長拿到錯誤的店管理權。
const TALENT_STORE_KEYWORDS = {
  jingxin:   "景新",
  xingfu:    "幸福",
  xindian:   "心惦",
  xinying:   "鑫營",
  xiangri:   "巷日",
  fucheng:   "福城",
  xinyaoxin: "鑫耀鑫",
  liangxin:  "梁鑫",
  fuzhong:   "府中",
  dazhi:     "大直",
  xinjirou:  "鑫雞肉",
  huaan:     "華安",
  xinzhuang: "新莊",
};

// 店名正規化（舖/鋪 異體字）
function tNormLoc(s) {
  return String(s || "").replace(/鋪/g, "舖").replace(/\s+/g, "").trim();
}

// 店名 → storeId。對不到回 null（呼叫端負責記 log）
function toTalentStoreId(locName) {
  const n = tNormLoc(locName);
  if (!n) return null;
  // ① 開頭比對（主要）
  const starts = Object.entries(TALENT_STORE_KEYWORDS)
    .filter(([, kw]) => n.startsWith(tNormLoc(kw)));
  if (starts.length === 1) return starts[0][0];
  if (starts.length > 1) {
    // 多個相符時取最長的關鍵字（最具體）
    starts.sort((a, b) => tNormLoc(b[1]).length - tNormLoc(a[1]).length);
    return starts[0][0];
  }
  // ② 部分包含（回退）— 只在唯一相符時採用
  const incl = Object.entries(TALENT_STORE_KEYWORDS)
    .filter(([, kw]) => n.includes(tNormLoc(kw)));
  if (incl.length === 1) return incl[0][0];
  return null;
}

// 從員工資料取聯絡 email
//
// ⚠ 為什麼不用 users/{uid}.email：
//   建帳號時多數人沒提供真實 email，users 文件裡存的是產生出來的假信箱，
//   拿去寄信收不到。真實 email 在 hr/employees 的 emails 陣列（多 email，
//   emails[0] 為主）。關聯鍵是 users/{uid}.empId → employees[].id。
function pickEmployeeEmail(emp) {
  if (!emp) return "";
  if (Array.isArray(emp.emails)) {
    const first = emp.emails.filter(Boolean)[0];
    if (first) return String(first).trim();
  }
  return emp.email ? String(emp.email).trim() : "";
}

// 讀 hr/employees 一次，建 empId → {email, name} 對照
async function loadEmployeeContactMap() {
  const map = {};
  try {
    const snap = await admin.firestore().doc("hr/employees").get();
    const list = snap.exists ? (snap.data().list || []) : [];
    list.forEach((e) => {
      if (e && e.id) {
        map[e.id] = {
          email: pickEmployeeEmail(e),
          name: e.name || "",
          title: e.title || "",        // 職稱（店長／副店長／廚房主管…）
        };
      }
    });
  } catch (e) {
    logger.error("[syncTalentAdmin] 讀取 hr/employees 失敗", e.message);
  }
  return map;
}

// 讀 settings/stores 主檔，建 正規化店名 → storeId 對照
//
// 主檔由 store_manage.html 維護，是 storeId 的權威來源。
// 讀不到（主檔未建立 / 讀取失敗）時回傳 null，呼叫端自動回退到
// 寫死的 TALENT_STORE_KEYWORDS 關鍵字推導。
async function loadStoreIdMap() {
  try {
    const snap = await admin.firestore().doc("settings/stores").get();
    if (!snap.exists) return null;
    const list = snap.data().list;
    if (!Array.isArray(list) || !list.length) return null;
    const map = {};
    list.forEach((s) => {
      if (!s || !s.name || !s.storeId) return;
      if (s.active === false) return;          // 停用的店不給管理權
      if (s.type === "corporate") return;      // 法人實體不是店
      map[tNormLoc(s.name)] = String(s.storeId);
    });
    return Object.keys(map).length ? map : null;
  } catch (e) {
    logger.error("[storeIdMap] 讀取 settings/stores 失敗，回退關鍵字推導", e.message);
    return null;
  }
}

// 店名陣列 → storeId 陣列（去重），並回報對不上的店名
//
// 優先序：
//   ① settings/stores 主檔精確比對（含 normLoc 異體字處理）
//   ② 回退到 TALENT_STORE_KEYWORDS 關鍵字推導（主檔未建立時）
//
// ⚠ 新增店面時只要在 store_manage.html 建好並填代號即可，
//   不需要再改這支程式的關鍵字表。
function mapLocationsToStoreIds(locNames, storeMap) {
  const stores = [];
  const unmapped = [];
  (locNames || []).forEach((loc) => {
    let sid = null;
    if (storeMap) sid = storeMap[tNormLoc(loc)] || null;
    if (!sid) sid = toTalentStoreId(loc);      // 回退
    if (sid) { if (!stores.includes(sid)) stores.push(sid); }
    else unmapped.push(loc);
  });
  return { stores, unmapped };
}

// 我方 role → 對方 admins 的寫入內容
// contact: { email, name, title } 來自員工資料，優先於 users 文件
//
// title（職稱）是對方 2026/09 新增的選填欄位，用於「權限指派」頁分組顯示。
// 對方規則：沒帶 title 不會清空舊值（沿用上次同步的職稱），所以取不到時
// 直接省略該欄位，不要送空字串。
function buildTalentAdminPayload(uid, data, contact, storeMap) {
  const role = String((data && data.role) || "");
  const base = {
    id: uid,
    name: (contact && contact.name) || (data && data.name) || "",
    email: (contact && contact.email) || "",   // 只用員工資料的真實 email
    employeeId: (data && data.empId) || "",
  };
  // 職稱：有值才帶。對方未收到 title 時會沿用舊值，送空字串反而可能覆蓋成空
  const _title = (contact && contact.title) || "";
  if (_title) base.title = _title;

  // ⚠ 一律用 users/{uid} 的原始 locations，不是 authGuard 展開後的
  const raw = Array.isArray(data && data.locations) ? data.locations : [];

  // admin：永遠是總公司，看全部店
  if (role === "admin") {
    return { ...base, action: "upsert", role: "hq", stores: [] };
  }

  // consultant（顧問）：看 locations 決定
  //   有指定店面 → 比照店長，只看自己轄下的店（對方會歸到「跨店主管」區）
  //   locations 為空 → 才是真正的總公司層級，看全部店
  //
  // ⚠ 不能一律送 hq。顧問通常只管特定幾間店（例如三間央廚），
  //   送 hq + stores:[] 會讓他在對方系統看到「全部店家」，權限過大。
  //   （規範 3-2：admin/consultant 的 locations 為空陣列才代表全店）
  if (role === "consultant") {
    if (!raw.length) {
      return { ...base, action: "upsert", role: "hq", stores: [] };
    }
    const r = mapLocationsToStoreIds(raw, storeMap);
    return { ...base, action: "upsert", role: "store", stores: r.stores, unmapped: r.unmapped };
  }

  if (role === "manager") {
    const r = mapLocationsToStoreIds(raw, storeMap);
    return { ...base, action: "upsert", role: "store", stores: r.stores, unmapped: r.unmapped };
  }

  // employee 或無 role → 撤銷管理權
  return { id: uid, action: "remove" };
}

async function pushTalentAdmin(payload) {
  const apiKey = process.env.TALENT_API_KEY;
  if (!apiKey) {
    logger.error("[syncTalentAdmin] TALENT_API_KEY 未設定，同步中止");
    return { ok: false, reason: "no-key" };
  }
  const { unmapped, ...body } = payload;   // unmapped 只用於 log，不傳給對方
  try {
    const res = await axios.post(TALENT_ADMIN_ENDPOINT, body, {
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      timeout: 15000,
      validateStatus: () => true,
    });
    if (res.status < 200 || res.status >= 300) {
      logger.error("[syncTalentAdmin] 對方回應異常", {
        status: res.status,
        uid: body.id,
        body: JSON.stringify(res.data).slice(0, 300),
      });
      return { ok: false, reason: `http-${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    logger.error("[syncTalentAdmin] 連線失敗", { uid: body.id, msg: e.message });
    return { ok: false, reason: "network" };
  }
}

// ── ① Firestore 觸發器：role / locations / email / name 變動時同步 ──
exports.syncTalentAdmin = onDocumentWritten(
  { document: "users/{uid}", secrets: ["TALENT_API_KEY"] },
  async (event) => {
    const uid = event.params.uid;
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();

    // 使用者被刪除 → 撤銷管理權
    if (!after) {
      logger.info(`[syncTalentAdmin] ${before?.name || "(無姓名)"}/${uid} 使用者已刪除 → 撤銷管理權`);
      await pushTalentAdmin({ id: uid, action: "remove" });
      return;
    }

    // 只在關鍵欄位變動時才同步（避免無關寫入觸發大量呼叫）
    if (before) {
      const same =
        before.role === after.role &&
        before.email === after.email &&
        before.name === after.name &&
        before.empId === after.empId &&
        JSON.stringify(before.locations || []) === JSON.stringify(after.locations || []);
      if (same) return;
    }

    // 取員工資料的真實 email（users 文件的 email 是假的，見 pickEmployeeEmail 註解）
    // 與 storeId 主檔一起並行讀取
    const needContact = !!after.empId;
    const [cmap, storeMap] = await Promise.all([
      needContact ? loadEmployeeContactMap() : Promise.resolve({}),
      loadStoreIdMap(),
    ]);
    let contact = null;
    if (needContact) {
      contact = cmap[after.empId] || null;
      if (!contact) {
        logger.warn(`[syncTalentAdmin] empId=${after.empId} 在 hr/employees 找不到對應員工`);
      }
    }
    if (!storeMap) {
      logger.warn("[syncTalentAdmin] settings/stores 主檔不可用，改用關鍵字推導 storeId");
    }

    const payload = buildTalentAdminPayload(uid, after, contact, storeMap);

    if (payload.unmapped && payload.unmapped.length) {
      logger.warn("[syncTalentAdmin] 店名無法對應 storeId", {
        who: `${after.name || "(無姓名)"}/${uid}`,
        unmapped: payload.unmapped,
        mapped: payload.stores,
      });
    }
    if (payload.action === "upsert" && payload.role === "store" && !payload.stores.length) {
      logger.warn(`[syncTalentAdmin] ${after.name || uid} 為 manager 但 stores 為空 → 對方將無法管理任何店（我方店面：[${(after.locations || []).join(",") || "無"}]）`);
    }
    if (payload.action === "upsert" && !payload.email) {
      logger.warn(`[syncTalentAdmin] ${after.name || uid} 員工資料無 email（empId=${after.empId || "無"}）→ 對方無法寄送新應徵通知`);
    }

    const r = await pushTalentAdmin(payload);

    // 詳細 log：姓名、我方 role、對方 role、實際寫入的 stores
    const who = `${after.name || "(無姓名)"}/${uid}`;
    const detail = payload.action === "remove"
      ? "撤銷管理權"
      : `talentRole=${payload.role} title=${payload.title || "(未帶)"} stores=[${(payload.stores || []).join(",")}]`
        + (payload.role === "store" ? ` ← 我方店面[${(after.locations || []).join(",")}]` : "")
        + (payload.role === "hq" ? " ← 總公司層級（全部店）" : "");
    logger.info(
      `[syncTalentAdmin] ${who} role=${after.role || "(空)"} action=${payload.action} ${detail} → ${r.ok ? "OK" : "FAIL:" + r.reason}`
    );
  }
);

// ── ② 手動全量重新同步（後路，供 admin 在同步失敗時補救）──
exports.resyncAllTalentAdmins = onCall(
  { secrets: ["TALENT_API_KEY"], timeoutSeconds: 300 },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "請先登入");
    const callerSnap = await admin.firestore()
      .collection("users").doc(request.auth.uid).get();
    if (!callerSnap.exists || callerSnap.data().role !== "admin") {
      throw new HttpsError("permission-denied", "僅管理員可執行");
    }

    // 迴圈外只讀一次員工資料與店家主檔，迴圈內共用
    // （避免 179 次重複讀取 101KB 的 hr/employees，見規範 4-2 第②條）
    const [snap, cmap, storeMap] = await Promise.all([
      admin.firestore().collection("users").get(),
      loadEmployeeContactMap(),
      loadStoreIdMap(),
    ]);
    if (!storeMap) {
      logger.warn("[resyncAllTalentAdmins] settings/stores 主檔不可用，改用關鍵字推導 storeId");
    }
    const results = {
      total: snap.size, ok: 0, fail: 0, warnings: [],
      storeIdSource: storeMap ? "settings/stores 主檔" : "TALENT_STORE_KEYWORDS 關鍵字（回退）",
    };

    // 序列送出，避免對方 endpoint 被瞬間打爆
    for (const doc of snap.docs) {
      const d = doc.data();
      const payload = buildTalentAdminPayload(doc.id, d, cmap[d.empId] || null, storeMap);
      if (payload.action === "upsert" && !payload.email) {
        results.warnings.push(`${d.name || doc.id}：員工資料無 email，收不到應徵通知`);
      }
      if (payload.action === "upsert" && !payload.title) {
        results.warnings.push(`${d.name || doc.id}：員工資料無職稱，對方顯示為「—」`);
      }
      if (payload.unmapped && payload.unmapped.length) {
        results.warnings.push(`${doc.data().name || doc.id}：店名對不上 ${payload.unmapped.join('、')}`);
      }
      if (payload.action === "upsert" && payload.role === "store" && !payload.stores.length) {
        results.warnings.push(`${doc.data().name || doc.id}：店長但無可管理店面`);
      }
      const r = await pushTalentAdmin(payload);
      const nm = doc.data().name || doc.id;
      logger.info(
        `[resyncAllTalentAdmins] ${nm} role=${doc.data().role || "(空)"} action=${payload.action}`
        + (payload.action === "remove" ? "" : ` talentRole=${payload.role} title=${payload.title || "(未帶)"} stores=[${(payload.stores || []).join(",")}]`)
        + ` → ${r.ok ? "OK" : "FAIL:" + r.reason}`
      );
      if (r.ok) results.ok++; else {
        results.fail++;
        results.warnings.push(`${doc.data().name || doc.id}：同步失敗（${r.reason}）`);
      }
    }

    logger.info(`[resyncAllTalentAdmins] 完成 total=${results.total} ok=${results.ok} fail=${results.fail}`);
    return results;
  }
);


// ════════════════════════════════════════════════════════════
// 招募系統單一登入（SSO）— 簽發 Custom Token
//
// 使用者在本系統登入後，由這支 Function 用招募系統的 Service
// Account 金鑰簽一張 Custom Token，前端再把 token 送進招募系統的
// iframe，讓對方執行 signInWithCustomToken() 完成登入。
//
// ⭐ uid 用「我方 uid」簽：對方的 admins/{uid} 文件本來就是由
//    syncTalentAdmin 用我方 uid 寫入的，天然對齊，不需要 uid 對照表。
//    （這就是「先做管理員同步、後做 SSO」的原因）
//
// 部署前置作業：
//   1. 設定金鑰（貼上 SA 的完整 JSON 內容）
//      firebase functions:secrets:set TALENT_SA_KEY
//   2. 部署
//      firebase deploy --only functions:mintTalentToken
// ════════════════════════════════════════════════════════════

// 允許取得 token 的角色。
// ⚠ 這是「不要只依賴對方判斷」的縱深防禦：對方靠 admins/{uid} 擋人，
//   我方這裡先擋一層，同仁連 token 都拿不到，不會在對方系統產生
//   任何登入紀錄。
const TALENT_SSO_ROLES = ["admin", "consultant", "manager"];

// 招募系統的 Admin App 實例（跨函式呼叫快取，避免重複初始化）
let _talentApp = null;
function getTalentApp() {
  if (_talentApp) return _talentApp;
  const raw = process.env.TALENT_SA_KEY;
  if (!raw) throw new HttpsError("failed-precondition", "尚未設定招募系統金鑰");
  let sa;
  try {
    sa = JSON.parse(raw);
  } catch (e) {
    logger.error("[mintTalentToken] TALENT_SA_KEY 不是合法 JSON");
    throw new HttpsError("failed-precondition", "招募系統金鑰格式錯誤");
  }
  if (sa.project_id !== "liangping-talent") {
    logger.error(`[mintTalentToken] 金鑰的 project_id 非預期：${sa.project_id}`);
    throw new HttpsError("failed-precondition", "招募系統金鑰的專案不符");
  }
  _talentApp = admin.initializeApp(
    { credential: admin.credential.cert(sa) },
    "talentApp"          // 命名實例，不影響預設的 liangpinghri App
  );
  return _talentApp;
}

exports.mintTalentToken = onCall(
  { secrets: ["TALENT_SA_KEY"], timeoutSeconds: 30 },
  async (request) => {
    // ── ① 必須已登入 ──
    if (!request.auth) throw new HttpsError("unauthenticated", "請先登入");
    const uid = request.auth.uid;

    // ── ② 只有管理職能拿 token ──
    let role = "";
    let name = "";
    try {
      const snap = await admin.firestore().collection("users").doc(uid).get();
      if (snap.exists) {
        role = snap.data().role || "";
        name = snap.data().name || "";
      }
    } catch (e) {
      logger.error("[mintTalentToken] 讀取角色失敗", e.message);
      throw new HttpsError("internal", "無法確認權限");
    }
    if (!TALENT_SSO_ROLES.includes(role)) {
      logger.warn(`[mintTalentToken] ${name || uid} role=${role || "(空)"} 非管理職，拒絕簽發`);
      throw new HttpsError("permission-denied", "僅管理職可使用招募系統");
    }

    // ── ③ 用對方的 SA 金鑰簽 Custom Token ──
    try {
      const token = await getTalentApp().auth().createCustomToken(uid, {
        hrRole: role,        // 附帶我方角色，對方要用可以用（非必要）
      });
      logger.info(`[mintTalentToken] ${name || uid} role=${role} → 簽發成功`);
      return { ok: true, token, expiresInSec: 3600 };
    } catch (e) {
      logger.error("[mintTalentToken] 簽發失敗", { uid, msg: e.message });
      throw new HttpsError("internal", "Token 簽發失敗：" + e.message);
    }
  }
);


// ════════════════════════════════════════════════════════════
// 招募系統店家名冊同步
//
// 對方的「店家管理」改由本系統為單一真實來源。
// 店名一律從 hr/settings.workLocations 讀取，不在程式裡寫死，
// 這樣改店名只要改 HR 設定，不用改 code。
//
// storeId 以 settings/stores 主檔為準，主檔不可用時回退關鍵字表，
// 避免兩邊代號不一致造成對方產生重複的店。
//
// 部署：firebase deploy --only functions:syncTalentStores
// ════════════════════════════════════════════════════════════

const TALENT_STORE_ENDPOINT =
  "https://asia-east1-liangping-talent.cloudfunctions.net/upsertStoreFromHR";

// 不是店面、不可推送的實體（法人主體）
const TALENT_STORE_EXCLUDE = ["梁平有限公司"];

// 判斷央廚：本系統的央廚店名一律含「央廚」
function isCentralKitchen(name) {
  return String(name || "").includes("央廚");
}

async function pushTalentStore(body) {
  const apiKey = process.env.TALENT_API_KEY;
  if (!apiKey) return { ok: false, reason: "no-key" };
  try {
    const res = await axios.post(TALENT_STORE_ENDPOINT, body, {
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      timeout: 15000,
      validateStatus: () => true,
    });
    if (res.status < 200 || res.status >= 300) {
      logger.error("[syncTalentStores] 對方回應異常", {
        status: res.status,
        storeId: body.storeId,
        body: JSON.stringify(res.data).slice(0, 300),
      });
      return { ok: false, reason: `http-${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    logger.error("[syncTalentStores] 連線失敗", { storeId: body.storeId, msg: e.message });
    return { ok: false, reason: "network" };
  }
}

exports.syncTalentStores = onCall(
  { secrets: ["TALENT_API_KEY"], timeoutSeconds: 300 },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "請先登入");
    const callerSnap = await admin.firestore()
      .collection("users").doc(request.auth.uid).get();
    if (!callerSnap.exists || callerSnap.data().role !== "admin") {
      throw new HttpsError("permission-denied", "僅管理員可執行");
    }

    // 資料來源優先序：
    //   ① settings/stores 主檔（store_manage.html 維護，含 storeId / type / area）
    //   ② 退回 hr/settings.workLocations + 關鍵字推導（主檔還沒建立時）
    let masterList = null;
    let locs = [];
    try {
      const [stSnap, hrSnap] = await Promise.all([
        admin.firestore().doc("settings/stores").get(),
        admin.firestore().doc("hr/settings").get(),
      ]);
      if (stSnap.exists && Array.isArray(stSnap.data().list) && stSnap.data().list.length) {
        masterList = stSnap.data().list;
      }
      locs = hrSnap.exists ? (hrSnap.data().workLocations || []) : [];
    } catch (e) {
      logger.error("[syncTalentStores] 讀取店面設定失敗", e.message);
      throw new HttpsError("internal", "無法讀取店面清單");
    }
    if (!masterList && !locs.length) {
      throw new HttpsError("failed-precondition", "店面清單為空");
    }

    const results = {
      total: 0, ok: 0, fail: 0,
      stores: 0, kitchens: 0,
      skipped: [], warnings: [], sent: [], source: "",
    };

    const usedIds = {};   // storeId → 已用過的店名（偵測撞號）
    const dryRun = !!(request.data && request.data.dryRun);

    // 統一成 [{name, sid, type}] 再送出
    const queue = [];
    if (masterList) {
      results.source = "settings/stores";
      for (const s of masterList) {
        const name = s && s.name ? String(s.name) : "";
        if (!name) continue;
        if (s.active === false) { results.skipped.push(`${name}（已停用）`); continue; }
        if (s.type === "corporate") { results.skipped.push(`${name}（法人實體，不推送）`); continue; }
        if (!s.storeId) { results.warnings.push(`${name}：主檔未設定代號，未推送`); continue; }
        queue.push({ name, sid: String(s.storeId), type: s.type === "kitchen" ? "kitchen" : "store", area: s.area || "" });
      }
    } else {
      results.source = "hr/settings.workLocations（主檔未建立，用關鍵字推導）";
      for (const name of locs) {
        if (TALENT_STORE_EXCLUDE.some((x) => String(name).includes(x))) {
          results.skipped.push(`${name}（非店面實體，不推送）`);
          continue;
        }
        const sid = toTalentStoreId(name);
        if (!sid) { results.warnings.push(`${name}：找不到對應的 storeId，未推送`); continue; }
        queue.push({ name: String(name), sid, type: isCentralKitchen(name) ? "kitchen" : "store", area: "" });
      }
    }

    for (const item of queue) {
      const name = item.name;
      const sid = item.sid;
      if (usedIds[sid]) {
        results.warnings.push(`${name} 與 ${usedIds[sid]} 都對到 ${sid}，只推送前者`);
        continue;
      }
      usedIds[sid] = name;

      const type = item.type;
      if (type === "kitchen") results.kitchens++; else results.stores++;

      const body = { storeId: sid, name, type, action: "upsert" };
      if (item.area) body.area = item.area;   // 沒有區域就不帶，避免覆蓋對方已編輯的值
      results.total++;
      results.sent.push(`${sid} ← ${name}（${type}）`);

      if (dryRun) { results.ok++; continue; }

      const r = await pushTalentStore(body);
      if (r.ok) results.ok++;
      else {
        results.fail++;
        results.warnings.push(`${name}（${sid}）：推送失敗（${r.reason}）`);
      }
    }

    logger.info(
      `[syncTalentStores] ${dryRun ? "[DRY RUN] " : ""}total=${results.total} ` +
      `ok=${results.ok} fail=${results.fail} 門市=${results.stores} 央廚=${results.kitchens}`
    );
    results.sent.forEach((s) => logger.info(`[syncTalentStores] ${s}`));

    return { ok: true, dryRun, ...results };
  }
);

module.exports = { ...module.exports, ...require('./email_alert') };
