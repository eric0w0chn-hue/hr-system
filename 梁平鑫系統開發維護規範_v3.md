# 梁平鑫系統 — 開發維護規範 v3（2026/07/16）

> 本文件是系統的**唯一權威參考**。新增功能、修 bug、效能調校前先讀相關章節。
> v3 變更：打卡系統整組下線（7 頁移除）、新增獎金補助模組（bonus）、
> auth-guard iframe 導向修正、sw 快取 v4、薪資 same_month 投保模式。

---

## 一、系統概觀

| 項目 | 說明 |
|---|---|
| 部署 | 靜態 HTML → GitHub Pages（repo: `eric0w0chn-hue/hr-system`） |
| 後端 | Firebase 專案 `liangpinghri`（Firestore + Auth + Storage + Cloud Functions） |
| 使用者 | 約 30 位管理職，**80%+ 手機存取** |
| 店面 | 約 14 間（含央廚與門市兩種 locationType） |
| CDN | GitHub Pages 上傳後 5–15 分鐘同步；`raw.githubusercontent.com` 即時 |
| Functions | Node.js 20（→ 2026/10/30 前升 22），每日備份 `dailyFirestoreBackup` UTC 17:00（台灣 01:00） |

### 檔案清單（2026/07 現況）

| 類型 | 檔案 |
|---|---|
| 主框架 | `dashboard.html`（SPA 主框架）、`index.html`（登入）、`welcome.html`（歡迎頁） |
| 核心 JS | `auth-guard.js`（權限守衛+Auth 借用）、`sw.js`（Service Worker，現為 `lp-xin-v4`） |
| 人事 | `hr.html`、`batch_accounts.html` |
| 排班薪資獎金 | `schedule.html`、`salary.html`、`bonus.html`（獎金補助） |
| 回報 | `price.html`、`cctv_report.html`、`delivery_report.html`、`meeting.html`（含 Google Sheets 同步） |
| 帳號權限 | `account.html`、`store_accounts.html`、`permissions.html` |
| 系統 | `task.html`（店務追蹤，含照片）、`oplog.html`、`backup.html`、`restore.html`、`checkout.html` |

> 🗑 **2026/07/16 打卡系統整組下線**：`clock / attendance / anomaly / anomaly_query /
> realtime / temp_clock / device_approval` 七頁已自 repo 刪除，權限與首頁入口同步移除。
> Firestore 的 `attendance*` 集合資料仍在（無頁面引用，無害）。oplog 的
> `anomaly` 標籤保留，讓歷史日誌能正常顯示。

---

## 二、SPA iframe 架構

```
dashboard.html（主框架，永遠顯示）
├── topbar（含 iframeActionBar + 使用者資訊 + 登出）
├── sidebar（功能選單，分群組）
├── announce-bar（公告橫幅）
└── <iframe id="contentFrame">
      └── 功能頁（topbar 被隱藏）
```

- 側邊欄點擊 → `goTo(page)` → 設 iframe src（帶 `embed=1&v=N` 快取參數）
- `checkout.html` 例外：整頁跳轉，不進 iframe
- LOGO 點擊 → 回 welcome 頁，iframeActionBar 清空

### 2-1 Topbar 隱藏機制

iframe 載入後 dashboard 的 `frame.onload` 同源設定 `data-embed="1"`，
功能頁 CSS `[data-embed="1"] .topbar` 隱藏。

> ⚠️ **不能**用 URLSearchParams 判斷 embed——iframe 內會被瀏覽器安全政策 block。

功能頁**必加**的 CSS：
```css
[data-embed="1"] .topbar,[data-embed="1"] .topbar *{display:none!important;height:0!important;min-height:0!important;overflow:hidden!important}
```

> ⚠️ **salary.html 用的是另一種等效寫法**——不依賴 dashboard 設定 `data-embed`，
> 而是頁面自己在載入時判斷 `window.self!==window.top`，用 JS 內聯 style 直接隱藏
> `#pageTopbar`，並同步調整 `.sheet-hd{top:0}`（配合 topbar 高度的定位）：
> ```javascript
> if(window.self!==window.top){
>   var _tb=document.getElementById('pageTopbar');
>   if(_tb){ _tb.style.cssText='display:none!important;height:0!important;...'; }
>   // 同步調整依賴 topbar 高度的其他定位（如 .sheet-hd）
> }
> ```
> 兩種寫法效果相同、互不衝突，**這是已知的合理特例，不要用 `[data-embed]` CSS 覆蓋或「統一」它**——
> JS 判斷式更早生效，且處理了 CSS 版本沒顧到的 `.sheet-hd` 定位細節。
> 新頁面預設仍用 `[data-embed]` CSS（全站主流寫法），只有已用 JS 判斷式且運作正常的頁面才維持現狀。

### 2-2 iframeActionBar（功能按鈕同步）

`_syncIframeActions(frame)` 掃描 iframe `.topbar-right` 的按鈕（排除 back-btn / role-chip），
在主框架建立代理按鈕，點擊轉發 `origBtn.click()`，MutationObserver 同步 disabled/文字。

目前同步的按鈕：oplog（匯出CSV/重新整理）、store_accounts（新增帳號）、
task（新增任務）、backup（立即備份）、permissions（儲存變更）。

### 2-3 返回按鈕（postMessage）

```javascript
onclick="if(window.self!==window.top){window.parent.postMessage({type:'navigate',page:'dashboard.html'},'*');}else{window.location.href='dashboard.html';}"
```

### 2-4 紅點提醒契約（dashboard 未完成事項）

dashboard 登入後背景執行 `checkUnfinishedAlerts()`，檢查：

| 檢查項 | 條件 | 依賴欄位 |
|---|---|---|
| task | store_tasks 有 pending/in_progress 且 dueDate < 今天（已用 `where('status','in',...)` 條件查詢） | `status`、`dueDate`、`store` |
| price | price_reports 今日轄下店面未填 | `date`（YYYY-MM-DD）、`store` |
| cctv | cctv_reports 今日轄下店面未填 | `date`、`store` |
| delivery | delivery_reports 明日央廚未填 | `deliveryDate`、店名欄位 |

> ⚠️ **新增回報類模組時**，若要納入紅點提醒，文件必須有 `date`（YYYY-MM-DD 字串）
> 與店名欄位，並在 `checkUnfinishedAlerts()` 加一段檢查。

---

## 三、Auth 與權限系統

### 3-1 auth-guard.js 三層放行策略（2026/06 底新增，效能關鍵）

iframe 每次換頁是全新 context，Firebase Auth 重新初始化要等 1–2 秒。
解法：**借用主框架已就緒的登入狀態**。

```
① auth.currentUser 已有值（同頁重複呼叫）→ 直接放行
② window.parent.__lpAuth.currentUser 有值（iframe 借用主框架）→ 直接放行 ⭐ 換頁走這條
③ 都沒有（冷啟動）→ onAuthStateChanged 等待
```

配套：
- `dashboard.html` 初始化後執行 `window.__lpAuth = auth`（暴露給子頁）
- `auth-guard.js` 頂部也會 `window.__lpAuth = auth`（直接開功能頁時自保）
- 借用後仍掛一個 onAuthStateChanged 監聽登出事件
- token 若失效，Firestore 讀取會失敗 → catch → 導回登入頁（安全）

> ⚠️ 改 auth-guard.js 後**必須 bump sw.js 的 CACHE_NAME**（見第五節），否則 SW 快取舊版。

**iframe 導向修正（2026/07）**：auth-guard 所有導回登入頁/無權限頁的跳轉，
在 iframe 內一律 `window.top.location.href`（跳最上層），避免登入頁被嵌進 iframe 造成畫中畫。

### 3-2 權限三層

| 層 | 負責 | 設定處 |
|---|---|---|
| role toggle | 哪些角色能進功能 | permissions.html |
| locationType | 央廚/門市/全部 | permissions.html |
| locations | 進去後看哪些店 | auth-guard 回傳，已過濾，直接用 |

- 快取：sessionStorage TTL 5 分鐘；permissions.html 儲存後清 `lp_perm_v1`
- admin/consultant 的 `userData.locations` 為空陣列 → 需全店清單讀 `hr/settings.workLocations`
- Firestore 無該 moduleKey 設定時，預設只有 admin 可進

### 3-3 標準頁面入口

```javascript
import { authGuard, db, writeOpLog } from './auth-guard.js?v=2';
authGuard('moduleKey', ({ user, uid, role, locations, userData, db }) => {
  // locations 已過濾完畢；role: admin/consultant/manager/employee
});
```

### 3-4 模組 key 對照（現況）

hr、schedule（含 employee）、price、meeting、salary、bonus、account、cctv、
delivery_report（央廚限定）、oplog（admin）、permissions（admin）、backup（admin）、
checkout、store_accounts、task

（clock 系列六項與 device 已於 2026/07/16 隨打卡系統移除）

---

## 四、Firestore 資料與查詢規範

### 4-1 主要路徑

| 模組 | 路徑 |
|---|---|
| hr | `hr/employees`（list 陣列，~136人 101KB）、`hr/settings`、`hr/interviews`、`hr/resigned` |
| salary | `salary_records/{empId}_{yyyy-mm}`、`salary_settings/config`、`salary_settings/store_ot` |
| schedule | `schedules/{yyyy-mm}_{location}`、`shift_types/{storeName}` |
| 回報 | `price_reports`、`cctv_reports`、`meeting_records`、`delivery_reports`、`delivery_personnel` |
| bonus | `hr/bonus_log`（獎金發放記錄，掛在 hr 文件下） |
| 帳號 | `users/{uid}`、`store_accounts`、`settings/store_accounts_hidden` |
| 任務 | `store_tasks`（append-only updates 陣列） |
| 日誌 | `sys_oplogs`（主）、`hr_oplogs`（hr 雙寫，oplog 頁合併讀） |
| 設定 | `settings/permissions`、`settings/announcement`、`settings/delivery_vehicles` |
| Storage | 任務照片 `task_photos/{taskId}/before|after`；勿動既有 `storagePath` 欄位 |

外部整合：meeting 的 Google Sheets 同步走 Apps Script（URL 寫死在 meeting.html
`SHEETS_SCRIPT_URL`，換部署要改這裡）。

### 4-2 查詢鐵律

**① 絕不全集合讀取後前端 filter**
```javascript
// ❌ getDocs(collection(db,'attendance')) 後 .filter(...)
// ✅ getDocs(query(collection(db,'attendance'), where('date','==',today)))
```

**② 絕不在迴圈裡逐一 await 讀取**（2026/06 salary 實測：13人序列 546ms → 並行 46ms）
```javascript
// ❌ for(const e of emps){ const rec = await loadRec(e.id); }
// ✅ const recs = await Promise.all(emps.map(e => loadRec(e.id)));
```

**③ 獨立讀取一律 Promise.all 並行**
```javascript
const [a, b, c] = await Promise.all([getDoc(...), getDoc(...), getDocs(...)]);
```

**④ 店名不可用 where 比對**（舖/鋪 異體字會漏資料）
→ 用 `date` 在 Firestore 端壓縮資料量，店名留前端 `normLoc()` filter。

**⑤ 無條件查詢加 limit 上限保護**
```javascript
const _qc=[collection(db,'attendance_anomaly')];
if(date) _qc.push(where('date','==',date));
else     _qc.push(orderBy('occurredAt','desc'), limit(500));
const snap=await getDocs(query(..._qc));
```

### 4-3 寫入端契約

回報類（price/cctv/delivery）每筆需 `date`（YYYY-MM-DD 字串）＋店名欄位
（紅點提醒依賴，見 2-4）。新增任何「依日期查詢」的集合時，一律比照：
`date` 字串欄位給查詢用、ISO 時間戳欄位給排序用。

### 4-4 複合索引

加 `where`+`orderBy` 首次查詢會報錯附建立連結，點擊等 1–2 分鐘。
在低流量時段做；索引建立期間該查詢會失敗。

---

## 五、Service Worker（sw.js）

| 資源 | 策略 |
|---|---|
| Firebase SDK（gstatic） | Cache First（版本固定，永久快取） |
| 本站 HTML/JS/CSS | Stale While Revalidate（快取先回、背景更新） |
| Firestore/Auth API（googleapis） | 不介入，永遠走網路 |

**維護規則：**
- 改 `auth-guard.js` 或想強制全站更新 → **bump `CACHE_NAME`**（現為 `lp-xin-v4` → v5…），
  activate 會清舊快取強制重抓
- SWR 特性：使用者第一次載入可能仍是舊版，第二次才是新版；急更新就 bump 版本
- 測試：`Ctrl+Shift+R` 強制重整讓 SW 更新；Console 檢查
  `caches.open('lp-xin-vN').then(c=>c.keys())`

---

## 六、Topbar 與 UI 規格

### 6-1 Topbar HTML（功能頁標配）

```html
<div class="topbar">
  <div class="topbar-left">
    <button class="back-btn" onclick="...postMessage 機制(見2-3)...">← 主選單</button>
    <div class="tb-dv"></div>
    <h1><img src="LOGO" style="width:28px;height:28px;border-radius:7px;...">EMOJI 頁面名稱</h1>
  </div>
  <div class="topbar-right">
    <!-- 功能按鈕（選用） -->
    <span class="role-chip" id="roleChip">—</span>
  </div>
</div>
```

- 分隔線：新頁面**一律 `tb-dv`**。`.dv` 是舊頁遺留，hr.html 內容區用 `.dv` 會撞名
- role-chip 對照：admin=管理員、consultant=顧問、manager=店長/副店長、employee=同仁
- 功能按鈕放 role-chip 前 → 會被 iframeActionBar 自動同步到主框架

### 6-2 CSS 變數（全站統一）

```css
:root{--bg:#ECEEF2;--surface:#fff;--surface2:#F4F5F8;--border:#DDE1E9;--border2:#C8CDD8;
--text:#1A1D23;--text2:#5A6175;--text3:#9AA0B4;--accent:#2D3142;--accent-light:#F0F2F5}
```

### 6-3 RWD

- 單一斷點 600px；觸控目標 ≥44px
- 手機 table：thead 隱藏、tr 改 block、td 用 data-label
- Modal：手機 bottom-sheet（圓角上緣）、桌面置中
- iOS 陷阱：原生 select 不能多行 → 自訂下拉；onclick 內巢狀反引號會 crash iOS Safari；
  PWA safe-area 的 toast 用 opacity/visibility 不用 translateY
- `draggable="true"` 一律動態設定（mousedown 在把手才設），否則擋手機捲動；
  既有靜態 draggable 的清單項（如 hr/price 的 `.cdd-item`）已加 `touch-action:pan-y` 保住垂直捲動，新元件比照

---

## 七、操作日誌（oplog）

```javascript
writeOpLog({ editor:currentUserName, role:currentRole, module:'moduleKey',
  action:'新增同仁' /*中文動詞+名詞*/, detail:'王小明' /*對象*/ });
```

- addDoc→新增、update/setDoc→編輯、deleteDoc→刪除、批次→記一次 detail 寫「N筆」
- 寫 `sys_oplogs`；hr.html 雙寫 `hr_oplogs`；oplog.html 合併讀＋去重

---

## 八、新增功能頁 SOP（七步）

1. **建功能頁 HTML**：用第六節 topbar + embed CSS + postMessage 返回 + authGuard 入口
2. **permissions.html** `ALL_MODULES` 加 `{key,icon,name,desc,page,active}`（先 grep 防重複）
3. **permissions.html** `DEFAULT_PERMISSIONS` 加 `新key:{roles:[...]}`
4. **dashboard.html** `ALL_MODULES` 加同一筆（首頁卡片）
5. **oplog.html** 補 dropdown `<option>` + `MODULE_MAP`（若會寫日誌）
6. **紅點提醒**（選用）：回報類模組要納入提醒 → dashboard `checkUnfinishedAlerts()` 加檢查
7. **permissions.html 介面設定** role toggle / 店面類型，儲存

> 頁面模板直接複製既有簡單頁（如 task.html）改，比從零寫穩。

---

## 九、AI 協作工作流程（給 Claude / 開發助手）

### 9-1 檔案版本鐵律
- **一律以使用者最新上傳的檔案或 repo raw 最新版為底**，絕不用 Claude 上次輸出的版本
  （版本錯亂曾多次造成功能被覆蓋）
- 抓檔帶 cache-bust：`curl "$RAW/檔案?_t=$(date +%s)"`
- 動手前先 diff / grep 確認基底版本含最新功能（如 `grep -c serviceWorker`）

### 9-2 修改與驗證
- 用 Python `assert old in content` 的字串替換，替換失敗立即發現
- 改完抽出 `<script>` 跑 `node --check`（template literal 含 HTML 的誤報可忽略）
- 加 ALL_MODULES / MODULE_MAP 前先 grep 防重複
- 薪資等數值邏輯改動需人工驗算公式再輸出

### 9-3 部署與快取
- 輸出到 `/mnt/user-data/outputs/`，使用者手動上傳 GitHub
- CDN 5–15 分鐘；驗證用 raw.githubusercontent.com
- 改 auth-guard.js → 同時 bump sw.js CACHE_NAME
- 效能問題優先用 Claude in Chrome 實測（performance API 計時、攔截 Firestore 請求），
  不要純看程式碼猜

### 9-4 已知設計（不是 bug，勿「修」）
- hr.html 保有第二個 Firebase 實例（建帳號用）
- hr.html 無 `#loading/#app` 切換結構（刻意）
- `dv` 分隔線在舊頁沿用（勿全站統一改）
- Storage `storagePath` 欄位勿動
- cctv 有 `EXCLUDE_CCTV_STORES` 排除清單；delivery 為央廚限定

---

## 十、薪資與保險常數（2026）

- 正職公式：底薪 29,500 + 彈性補貼 + 固定加班費 = 目標薪資；不足月以 30 天為基準
- dailyBase 扣款用 BASE_FULL（全月基準），不用 prorated base
- 兼職：實領 = Σ(時數×(時薪+10全勤)) + 加班費(純時薪×倍率) + 加項 − 勞健保 − 扣點
- 雇主負擔：勞保=級距×8.94%、勞退=×6%、健保=級距×5.17%×60%×1.56
- 勞保投保天數：到職日～退保日**含頭尾**；退保日預設=離職當日（非+1）
- 級距表在 salary.html `LABOR_TABLE`，每年公告直接改表不動程式
- 投保級距模式：一般用 `getInsGrade`（依查看月份）；**當月到職＋當月離職**自動切
  `same_month` 模式用 `getHireGrade`（到職當下級距）；`rec.gradeOverride` 手動覆蓋優先於一切
- 獎金補助（bonus.html）依到職日自動算年資，判斷應發項目（廚師鞋/健檢/生日禮金/久任獎金），記錄寫 `hr/bonus_log`

---

## 十一、疑難排解速查

| 症狀 | 先查 |
|---|---|
| 換頁後 topbar 沒隱藏 | 該頁有無 `[data-embed]` CSS；dashboard `frame.onload` 是否最新 |
| 改了檔案但線上沒變 | CDN 未同步（等15分）；SW 快取（bump CACHE_NAME 或 Ctrl+Shift+R） |
| 換頁等 2 秒才有資料 | auth-guard 三層放行是否生效；`window.__lpAuth` 是否存在於主框架 |
| 查詢抓不到資料 | 寫入端欄位是否符合契約（date 格式）；店名異體字（normLoc） |
| Sheets 同步失敗 | meeting.html 的 `SHEETS_SCRIPT_URL` 是否為最新 Apps Script 部署 |
| 權限改了沒生效 | sessionStorage 快取 TTL 5 分鐘 → 開新分頁 |
| 資料越來越慢 | 全集合讀取（4-2①）或迴圈 await（4-2②） |
| iOS 點擊爆版/無反應 | onclick 巢狀反引號；原生 select 多行；draggable 擋 touch |
| 首頁紅點不亮/亂亮 | 該模組文件的 date/store 欄位；normLoc 比對 |

---

## 十二、待辦（2026/10/30 前）

| 項目 | 說明 |
|---|---|
| Node.js 20→22 | functions/package.json engines + `firebase deploy --only functions` |
| Repo 遷移 | 移至 GitHub Org `Liangping-system`（低流量時段） |
| users 共用快取（選作） | account/store_accounts/cctv/schedule 各自全讀 users（~30筆），可在 auth-guard 加 loadAllUsers() sessionStorage 快取共用 |
| Firestore 打卡集合清理（選作） | `attendance*` 集合已無頁面使用，確定不再需要歷史資料時可刪除 |

（Flutter 打卡 app、Omada、attendance/temp_clock 查詢優化等項目已隨打卡系統下線一併撤銷）
