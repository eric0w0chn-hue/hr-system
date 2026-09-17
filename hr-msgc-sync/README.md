# hr-msgc-sync — 人資 × 訊息中心 同步原型（可交接）

版本 1.0.0｜2026/09/17（權限政策核定並實作；Rules 已部署）｜人資端（`liangpinghri` / `eric0w0chn-hue/hr-system`）

> **⚠ 這不是正式部署程式。** 本套件是**離線原型 + 測試**，用途是讓訊息中心端
> 能獨立重現人資端宣稱的行為，並核對 HMAC 簽章。
> **正式同步 Cloud Functions 尚未實作／部署，未影響招募系統。**
> **Firestore Rules 提權修補已於 2026/09/17 部署，模擬器 29 項測試通過**；
> 部署狀態以 `CODEX交接文件_梁平鑫系統.md` §4 為準。

---

## 快速開始

```bash
node test/run-all.js                # 125 項測試（無外部相依）
node tools/http-fake-receiver.js   # 假接收端，僅綁 127.0.0.1:8787
HR_FAKE_STATE=1 node tools/http-fake-receiver.js   # 另開 /_state 除錯端點
```

Node 18+ ，**無 npm 相依**（僅用內建 `crypto` / `assert` / `http`）。

---

## 目錄

| 路徑 | 內容 |
|---|---|
| `src/projection.js` | 權限投影：四個來源 → `accessStatus` / `scope` / `storeIds`；版本遞增、outbox、驗證紀錄、門市 diff |
| `src/hmac.js` | HR-SYNC-V1 簽章與驗簽（含固定時間比較、nonce 原子登記） |
| `src/snapshot.js` | 全量快照（**實體化為不可變資料**）＋ outbox 重送 |
| `tools/fake-receiver.js` | 假接收端（程式內用）：驗簽→防重播→事件去重→版本防倒退 |
| `tools/http-fake-receiver.js` | 同上的 HTTP 版，`GET /_state` 可看已套用狀態與日誌 |
| `test/vectors.json` | **HMAC 測試向量**（含假密鑰、簽章基底字串、預期簽章） |
| `rules/firestore.rules.candidate` | **2026/09/17 已部署的 Rules**（保留原檔名供測試使用；同步至 repo `firestore.rules`，移除未使用函式並更新註記） |
| `rules/rules.test.js` | Rules 模擬器測試（**29 項通過**，見下） |

---

## 測試結果（本輪實際執行）

```
node test/run-all.js  →  125 passed, 0 failed
```

| 組 | 範圍 | 項數 |
|---|---|---|
| A | 投影規則（含門市停用／法人／Auth 三態） | 16 |
| B | 版本、亂序、tombstone、verifiedAt | 10 |
| C | 門市主檔 diff（storeId / active / type） | 3 |
| D | HMAC 簽章、時差、重播、密鑰分離、測試向量 | 13 |
| E | 端到端：重試、重播拒絕、原事件重送、亂序、驗證紀錄 | 8 |
| F | 全量快照一致性（跨頁異動）、degraded、缺頁 | 4 |
| **G** | **回歸：訊息中心回報的 6 個缺陷** | **24** |
| **H** | **HTTP 假接收端綁定（含實際啟動驗證）** | **3** |
| **K** | **回歸（第二輪）：事件完整性與查核時間一致性** | **18** |
| **L** | **回歸（第三輪）：新鮮度不得阻擋撤權、驗證綁定 revision** | **12** |
| **M** | **權限政策驗收（2026/09/17 負責人核定）** | **14** |

### v0.6 修正對照

| # | 回報內容 | 修正 | 回歸測試 |
|---|---|---|---|
| 1 | 同 eventId 同版本、內容不同仍被當成重送 | 去重表改存 `{revision, contentHash}`，內容不符一律 409 | G1, G2 |
| 2 | 衝突事件第一次 409、第二次 200 | `seenEvents` 改為【驗證通過且已套用後】才寫入；送出端把 409 標為 `needsManual` 不重試 | G3, G4, G5 |
| 3 | 驗證紀錄未檢查投影內容與時間 | 核對 `projectionHash`／ISO 格式／未來時間／時間倒退；HTTP 路徑一併驗簽與防重播 | G6–G11 |
| 4 | 舊 Auth 查核被當成本次新鮮查核 | `authState.checkedAt` 超過 `maxAuthAgeSec`(預設 900s) 即 `stale`；`verifiedAt` 取各來源實際查核時間的**最舊值**；`lastVerifiedAt` 只能前進 | G12–G15 |
| 5 | Auth 查核失敗在快照中被隱藏 | 每筆保留 `sourceErrors`／`authFresh`／`authCheckedAt`，快照層加 `rowErrorCounts`，任一筆不健康即 `degraded:true` | G16–G19 |
| 6 | 真正的網路例外沒有重試 | `sendOutbox` 加 try/catch，區分可重試（例外／timeout／5xx）與需人工（409／401），新增「已套用但回應遺失」情境 | G20–G24 |
| — | HTTP 假接收端未綁定位址 | 明確綁 `127.0.0.1`；`/_state` 預設停用，需 `HR_FAKE_STATE=1` 且僅限本機 | H1–H3 |

**額外修正（連帶）**：`projKey()` 改為 SHA-256 hex，欄位與順序與接收端
`projectionHashOf()` 完全一致，否則 `projectionHash` 永遠對不上（#3 的前提）。

### v0.7 修正對照（第二輪回報）

| # | 回報內容 | 修正 | 回歸測試 |
|---|---|---|---|
| 1 | 事件去重只檢查 `user`，改 subject 仍回 duplicate | 新增 `eventHash()`，摘要涵蓋完整不可變事件（schemaVersion / eventId / issuer / subject / revision / eventType / 各時間欄位 / user） | K1–K4 |
| 2 | `user.snapshot` 路徑可繞過驗證時間檢查 | 未來時間在入口即擋（400）；同版本同內容換 eventId 一律 `same_revision_ignored` 且不更新 `verifiedAt`；新版本的 `verifiedAt` 不得早於既有值 | K5–K8 |
| 3 | 缺少事件格式驗證，`revision:"invalid"` 被接受 | 新增 `validateSnapshotEvent()`，在套用與寫入去重紀錄**之前**驗證；版本比較改用 `BigInt`（`cmpRevision`） | K9–K14 |
| 4 | 重新查核後快照時間不一致 | 查核資訊改存於 state 的 `lastAuthCheckedAt` / `lastAuthFresh` / `lastCheckedAt`，與投影內容分離；快照輸出取最新查核紀錄，outbox 既有事件維持不可變 | K15–K18 |

### v0.9 修正對照（第三輪回報）

| # | 回報內容 | 修正 | 回歸測試 |
|---|---|---|---|
| 1 | **較新的停權事件被 verifiedAt 檢查擋住** | 跨版本一律不因 `verifiedAt` 較早而拒絕；倒退檢查只適用**同一 revision** 的 verification 流程。權限內容依 revision 判斷，新鮮度另行判斷，**永遠不得阻擋撤權** | L1–L4 |
| 2 | 新版本沒有驗證時間卻繼承舊版 | 驗證資訊綁定 `verifiedRevision` + `verifiedProjectionHash`；換版本即重新綁定，未驗證者一律 `null`；歷史成功時間另存 `lastVerifiedAtEver`，僅供排查 | L5–L12 |

> ⚠️ 第 1 項是 v0.7 的**退化**：v0.6 的「時間不得倒退」被誤套用到跨版本，
> 造成撤權可被一筆較早的驗證時間阻擋。這是最糟的失效方向，已修正並加測試。

**連帶修正（自有測試發現）**：`accessStatus: 'unknown'` 原本可能被判為「已驗證」
（四個來源都讀得到、Auth 也新鮮，但 empId 對不上員工時人的狀態仍屬未知）。
現在 `unknown` 一律不計為有效驗證。

## 權限政策（2026/09/17 負責人核定，已實作）

| # | 政策 | 實作 | 驗收測試 |
|---|---|---|---|
| 1 | 訊息中心只開放管理職，一般同仁不開放 | 非管理職一律 `suspended` + `not_management`（**不再送 eligible + scope:none**，避免接收端誤判為「有資格待分配」） | M1–M4 |
| 2 | 留職停薪一律停權，復職依正式分配恢復 | `suspended` + `unpaid_leave`；復職時重新依當下 `locations` 計算，不回復留停前範圍 | M5–M7 |
| 3 | 不設臨時跨店或個別例外授權 | 投影不含任何例外欄位；調店後舊門市立即消失 | M8–M9 |
| 4 | 不得僅因角色名稱自動取得全部 | **顧問未分配門市不再視為全店**，改 `scope:'none'` + `unassignedStores:true`；admin 的 `all_stores` 僅為候選範圍且 `storeIds` 為空 | M10–M14 |

> ⚠️ **第 4 項是行為變更**：原設計「顧問 `locations` 為空 ＝ 看全店」為隱含規則，
> 與本政策衝突，已移除。未分配門市的管理職會以 `unassignedStores: true` 標記，
> 需走正式權限變更補上門市。

### 角色對應表（由 `src/projection.js` 實際執行產出，供核對）

| 人資身分 | 門市分配 | accessStatus | 原因 | scope | 送出的 storeIds |
|---|---|---|---|---|---|
| 管理員 admin | 有/無皆可 | eligible | — | all_stores | （空，僅候選範圍） |
| 顧問（已分配 2 店） | A店, B店 | eligible | — | selected_stores | tw001, tw002 |
| 顧問（未分配） | — | eligible | — | **none**（標記未分配） | — |
| 店長／副店長（已分配） | A店 | eligible | — | selected_stores | tw001 |
| 店長（未分配） | — | eligible | — | **none**（標記未分配） | — |
| 一般同仁 | A店 | **suspended** | not_management | none | — |
| 留職停薪（店長） | A店 | **suspended** | unpaid_leave | none | — |
| 已離職（店長） | A店 | **suspended** | resigned | none | — |
| 帳號已停用 | A店 | **suspended** | disabled | none | — |

> `scope` 只是**候選範圍**，不等於授權。
> 實際可見的聊天室仍由訊息中心逐一分配，人資不介入。

### 回歸測試有效性驗證

**第一輪**：把 `tools/fake-receiver.js` 與 `src/snapshot.js` 還原為 v0.5 後重跑 G/H 組
→ **16 項失敗**（G1, G3–G11, G16–G18, G22–G24）。
（此對照未還原 `src/projection.js`，故 #4 的 G12–G15 不列入。）

**第二輪**：把 `fake-receiver.js`、`projection.js`、`snapshot.js` 全部還原為 v0.6
後重跑 K 組 → **15 項失敗**（K1–K3, K5–K15, K18）。

**第三輪**：同樣三個檔案還原為 v0.8 後重跑 L 組 → **9 項失敗**
（L1, L3, L5–L10, L12）。
確認這些測試會真的抓到缺陷，而非恆真。

## Rules 測試：已於人資端本機執行，29/29 通過；2026/09/17 已部署

```
npx firebase emulators:exec --only firestore --project demo-liangping "node rules/rules.test.js"
→ v0.7 版本：23 passed, 0 failed（Firestore Emulator v1.22.0 / OpenJDK 21）
→ v0.9 版本：23 passed, **3 failed**（G9/G10/G11）← 兜底規則問題，見下
→ **v0.9.2 版本：29 passed, 0 failed**（2026/09/17 人資端本機實測）
```

涵蓋：G 提權防護 14 項、H 本人寫入與停用 5 項、I 缺欄位與文件不存在語意 3 項、
J 受控建立帳號 7 項。

### ⚠ v0.9.1 修正：兜底規則使 users 限制失效

v0.9 的 Rules 測試實測結果為 **23 passed, 3 failed**：

```
FAIL  G9  admin 不得自行修改權限欄位  → Expected request to fail, but it succeeded.
FAIL  G10 admin 不得刪除自己          → Expected request to fail, but it succeeded.
FAIL  G11 admin 仍可寫自己的 lastLoginAt → Null value error
```

原因：檔尾的

```
match /{document=**} { allow read, write: if isAdminA(); }
```

會一併匹配 `/users/{uid}`。**Firestore 多條規則同時匹配時是 OR 語意，
只要任一條 allow 即放行，細規則不會覆蓋粗規則**
（參考 https://firebase.google.com/docs/rules/rules-behavior）。
因此上方新增的「admin 不得自改權限欄位、不得刪除自己」形同虛設。
G11 則是 G10 的連鎖結果——admin 文件已被刪除，後續 update 觸發 `Null value error`。

修正：兜底改為

```
match /{col}/{doc=**} {
  allow read, write: if isAdminA() && col != 'users';
}
```

並新增 G12–G14 三條測試：確認兜底不再繞過 users 限制、
未列舉集合 admin 仍可讀寫（未改過頭）、非 admin 仍被擋。

**驗證結果（2026/09/17 人資端本機，Firestore Emulator v1.22.0 / OpenJDK 21）**：
**29 passed, 0 failed**。四個關鍵項目確認：

| 測試 | 結果 | 模擬器輸出 |
|---|---|---|
| G9 admin 不得自改權限欄位 | PASS | 三條規則皆 false |
| G10 admin 不得刪除自己 | PASS | `false for 'delete' @ L90, false for 'delete' @ L166` |
| G11 admin 仍可寫自己的 lastLoginAt | PASS | — |
| G13 未列舉集合 admin 仍可讀寫 | PASS | 確認兜底未改過頭 |

### ⚠ v0.8 依 Console 實測收緊（重要）

2026/09/17 於 Firebase Console 查得
`settings/permissions.modules.account.roles` 線上實際值為 **`["admin"]`**，
並非 `permissions.html` 預設的 `['admin','consultant']`。

因此 Rules 已修正並部署：
- 權限欄位（`role`/`locations`/`workLocation`/`disabled`/`empId`/`idNo`）
  **僅 admin 可改**，不再開放 consultant（原設計會「補漏洞反而擴權」）
- **admin 亦不得自行修改權限欄位、不得刪除自己**（防單點失守），
  但仍可寫自己的 `lastLoginAt`
- 開放顧問的版本以註解保留在檔內，需管理層核准並同步改
  `settings/permissions` 後才啟用

部署前已於正式專案 `liangpinghri` 執行
`firebase deploy --only firestore:rules --dry-run`，Rules **編譯通過**；
其後於 **2026/09/17 正式部署**，並以 admin 與店長身分完成操作驗證
（依交接文件 §4）。

重現方式（需 Java 21+）：
```bash
npm i -D @firebase/rules-unit-testing firebase-tools
npx firebase emulators:exec --only firestore --project demo-liangping \
  "node rules/rules.test.js"
```
`firebase.json` 已隨套件附上；`demo-` 開頭的專案 ID 代表純本機模擬，
不會連到正式 `liangpinghri`。

> **部署狀態：已修補。** `rules/firestore.rules.candidate` 的規則已於
> **2026/09/17 部署至 `liangpinghri`**，模擬器 **29 passed, 0 failed**。
> repo `firestore.rules` 已同步該版規則，移除未使用的 `targetIsAdmin` 並更新註記；
> 本次同步 repo 不另行部署 Firebase。

## HMAC 測試向量

`test/vectors.json` 含 4 組（一般推送、GET 空 body、帶 cursor、Unicode body），
每組附完整 `signingString` 與 `expectedSignature`，訊息中心可獨立核對。

**密鑰為測試用假值**：`hr-test-key-1` / `TEST_ONLY_fake_shared_secret_do_not_use_in_production`
—— 正式密鑰不經文件或對話交換，只進 Secret Manager。

環境設定（正式網址未部署，先指假接收端）：
```
MSGC_ENDPOINT   = http://127.0.0.1:8787/hr-sync
MSGC_PAGE_SIZE  = 200
MSGC_PUSH_KEY_ID / MSGC_PULL_KEY_ID = <由 Secret Manager 注入>
```

---

## 已知限制（不得當作已解決）

1. **`hr/employees` 是單一文件內的員工陣列** → Rules 無法對陣列元素做欄位級比對，
   「管理職不得修改自己的在職狀態」**現行結構下無法用 Rules 表達**，須後端代理寫入。
2. **Firebase Auth 查核不在 Firestore 交易內** —— 本原型已分開保存
   `authState.checked / ok / exists / disabled` 與查核時間，**不宣稱跨服務原子讀取**。
   競態容忍：以最近一次成功查核為準，查核失敗記 `sourceErrors`，不推論為刪除。
3. 原型為記憶體模擬，**未驗證** Firestore 交易併發（`VERSION_CONFLICT`）與實際延遲。
4. 快照實體化在原型中是記憶體物件；正式版需寫入
   `hr_sync_snapshots/{snapshotId}/rows` 並設 TTL，成本與延遲未實測。
6. `maxAuthAgeSec` 預設 900 秒為**暫定值**，實際容忍時間屬待決策政策，
   需與訊息中心的新鮮度上限一併核准。
5. repo `firestore.rules` 已依交接文件同步 2026/09/17 已部署規則；
   本次僅同步檔案，未重新讀取 Console 線上規則，後續部署前仍需核對線上是否有新異動。
