# 傳送圖片：實測失敗調查紀錄

最後更新：2026-11-26
狀態：**未解決。** 個人與群組聊天的加密圖片（Letter Sealing）被 LINE 拒絕；OpenChat 與官方帳號尚未實測。

功能說明見 [CLI.md › Sending images](../CLI.md#sending-images)。

---

## 1. 測試環境

| 項目 | 內容 |
|---|---|
| 程式 | 本 fork，commit `d02f671` 起 |
| SDK | `@evex/linejs` 3.4.2（原專案釘死的版本） |
| 執行環境 | Windows 11，Node.js 24 |
| LINE 登入身分 | `IOSIPAD`（iPad 次要裝置） |
| 收件者 | 一個已開放的一對一聊天（direct，`u…` MID） |
| 圖片 | 831×213 JPEG，約 123 KB，無 EXIF |

作法：停止原本安裝的 LineBridge 0.7.16，備份資料夾，再讓 fork 版接同一份資料夾、同樣連接埠啟動（沿用既有配對，不必重新掃 QR）。由使用者在 Chrome 的儀表板親手選圖並確認送出。測完換回安裝版。

---

## 2. 結果

| 次序 | 程式狀態 | LINE 回應 |
|---|---|---|
| 1 | linejs 原樣的圖片欄位 | `E2EE_INVALID_VERSION`（當時未保留原因字串） |
| 2 | 額外在 `contentMetadata` 補 `contentType:"1"`、`e2eeMark:"2"` | `E2EE_INVALID_VERSION`（此修改無效，已撤回） |
| 3 | 同第 1 次，另保留 LINE 原因字串（commit `30dbd26`） | `E2EE_INVALID_VERSION`，原因 **`not allowed contentType`** |
| 對照 | 同一帳號、同一聊天，傳 Letter Sealing **文字** | **成功** |

三次圖片都是 LINE 明確拒絕（`line_send_rejected`），**沒有送達**。加密後的圖片物件已上傳到 OBS，但沒有訊息指向它。

---

## 3. 已排除

- **金鑰問題**：同一帳號對同一收件者傳加密文字成功。
- **`contentType` 欄位漏送**（linejs [#255](https://github.com/evex-dev/linejs/issues/255) 的原因，同一錯誤碼與原因字串）：攔下實際送出的 thrift 資料，Message 有帶 `[8,15,1]`（IMAGE）。
- **欄位格式與其他實作不同**：與 CHRLINE（Python）`uploadMediaByE2EE` 送出的 Message 欄位與 `contentMetadata`（`SID`、`OID`、`e2eeVersion`、`MEDIA_CONTENT_INFO`）一致。
- **linejs 版本差異**：3.4.2 與上游最新版的 `encryptE2EEMessage`、`uploadMediaByE2EE`（圖片部分）、`uploadObjectForService` 相同；`IOSIPAD` 宣告的 App 版本兩版都是 26.7.2。

---

## 4. 推測（未證實）

linejs [#291](https://github.com/evex-dev/linejs/issues/291) 回報者以 **`ANDROIDSECONDARY`** 登入，用同樣的 `uploadMediaByE2EE` 傳圖片與檔案「在官方用戶端都能正常顯示」。本次唯一明顯差異是登入身分 **`IOSIPAD`**。推測 LINE 伺服器不允許此身分送出加密的非文字訊息。

---

## 5. 下一步

1. **以 `ANDROIDSECONDARY` 另開測試配對驗證**：全新資料夾、另一組連接埠，fork 版 `serve`，儀表板新增帳號選「Android 次要裝置」並掃 QR，傳同一張圖。
   - 成功：證實是身分限制，正式帳號需改用 Android 次要裝置重新配對。
   - 失敗：依新的原因字串續查。
   - 注意：理論上不會擠掉現有 iPad 登入或電腦版 LINE，但無法事先保證。
2. 比對 FILE 類型（`emf`、contentType 14）是否同樣被拒，判斷是否所有加密媒體都受限。
3. OpenChat（reqseq 上傳）與官方帳號的傳圖尚未實測。

---

## 6. 實測注意事項

- 被拒原因存在資料庫 `sends` 表的 `result` 欄（JSON），可唯讀讀取：
  ```powershell
  node --input-type=module -e "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1],{readOnly:true});for(const r of db.prepare('SELECT state,result,at FROM sends ORDER BY at DESC LIMIT 4').all())console.log(r.at,r.state,r.result)" "資料夾\bridge.sqlite"
  ```
- 儀表板的確認視窗是瀏覽器原生 `confirm()`。內嵌式瀏覽器（例如 AI 工具內建的預覽面板）可能直接擋掉並回傳「取消」，畫面不會有任何提示；請用一般 Chrome／Edge。
- 正常停止服務會刪除資料夾裡的 `service.json`。若有自訂的「沒在跑才啟動」腳本依賴這個檔案，換回原版時要直接用原本的 `serve` 參數啟動。
- linejs 的 OBS 上傳網址是 `https://obs.line-apps.com//r/...`（雙斜線），為 SDK 原本行為。
- 並行跑全部測試時，`tests/maintenance.test.mjs` 偶爾逾時失敗（原版亦同），單獨執行可通過。
