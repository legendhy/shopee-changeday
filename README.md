# 蝦皮備貨天數一鍵改 1 天

一個 Chrome 擴充功能（MV3），**每周自動把蝦皮台灣（蝦皮台灣 / Shopee TW）賣場所有商品的「備貨天數」重置為 1 天**。

工具驅動蝦皮賣家中心自帶的「更新商品資料」批次工具，完整跑通：
**登入 → 下載備貨天數模板（zip，內含多個 xlsx）→ 把每個 xlsx 的備貨天數改 1 → 切到上傳 tab、逐個上傳**。

> ⚠️ 本工具僅供個人自動化管理自己的賣場使用。請遵守蝦皮服務條款，自行承擔使用風險。

---

## 功能特色

- **一鍵全自動**：登入、下載、改值、上傳全流程，按一下就跑完。
- **繞過難搞的 hover 下拉**：直接導航到更新商品資料頁，不靠脆弱的下拉選單。
- **瀏覽器內改值**：用 JSZip 直接修改 xlsx 的 sheet XML（不是重新生成），格式原樣保留，蝦皮可順利回傳。
- **串行上傳 + 失敗重傳**：一次只傳一份（符合蝦皮限制），部分失敗（如 499/500）自動重傳。
- **每周定時**：安裝時自動建立每周鬧鐘。
- **SPC_F 免登入**：優先用 cookie 還原 session，帳密 only 備援。

## 安裝

1. 下載或 `git clone` 本倉庫。
2. 開啟 Chrome → 網址列輸入 `chrome://extensions`。
3. 右上角開啟**「開發人員模式」**。
4. 點 **「載入未封裝項目」** → 選本倉庫的 [`extension/`](extension/) 資料夾。
5. 把擴充功能釘選到工具列。

> Firefox / Edge 也可載入（需支援 MV3），但僅在 Chrome 上測試過。

## 設定

點擴充功能圖示，在彈窗填入：

| 欄位 | 說明 |
|---|---|
| **蝦皮帳號** / **密碼** | 登入備援用（SPC_F 失效時才會用到） |
| **SPC_F cookie** | 優先用它免登入。從已登入蝦皮的瀏覽器 cookie 裡複製 `SPC_F` 的值 |

點「**儲存設定**」。憑證只存在本機 `chrome.storage.local`，不會外傳。

## 使用

點「**▶ 立即執行**」。彈窗下方即時顯示進度記錄，流程跑完會跳出通知。

## 運作流程

```
登入(SPC_F) → 進「更新商品資料 / 下載」
   → 勾選備貨天數 → 點下載產生模板 → 輪詢直到檔案產出 → 下載 zip
   → 解壓（11 個分片 xlsx）→ 把備貨天數欄(et_title_product_dts, 第 I 欄)全改 1
   → 切到「上傳」→ 逐個上傳 xlsx（每個等完成再傳下一個）
   → 部分失敗自動重傳 → 完成
```

## 目錄結構

```
extension/
├── manifest.json          # MV3 設定
├── config.js              # 所有 URL / selector / 常數集中於此（改版只改這裡）
├── background.js          # service worker：cookie 注入、下載抓取、解壓改值、周鬧鐘、記錄
├── content.js             # 頁內狀態機（跨頁面刷新續跑）：登入/生成/輪詢/下載/逐個上傳
├── popup.html / popup.js  # 設定 + 一鍵執行 + 即時記錄
├── lib/jszip.min.js       # 瀏覽器內解壓 / 改 xlsx
├── icons/icon128.png
└── README.md              # 擴充功能詳細說明
```

> `app/` 目錄是早期的 Python + Playwright 原型，**已廢棄**，保留僅供參考。目前以 `extension/` 為準。

## 架構筆記

- **跨頁面刷新的狀態機**：登入、進入賣家中心、進批次頁都是整頁刷新，會銷毀 content script。`content.js` 把運行狀態存在 `chrome.storage.local`，每次頁面載入依 `step` 續跑（`login → goto_mass → download`）。下載/上傳流程在同一個 content 實例內跑完（下載↔上傳 tab 切換是 SPA 客戶端路由，不刷新）。
- **xlsx 採 XML 層修改**：用 JSZip 打開 xlsx，直接改 `xl/worksheets/sheet1.xml` 裡備貨天數欄的值，其餘位元原樣保留 → 蝦皮回傳不會報格式錯。同時避開 `activePane="bottom_left"` 之類的解析相容性坑。
- **下載抓取**：content 點擊列下載按鈕 → background 的 `chrome.downloads.onCreated` 比對 `mass_update_dts` → fetch 原始 zip → 解壓改值 → 回傳給 content 上傳。

## 狀態與限制

- ✅ 全流程已手動驗證（透過 Chrome MCP 實測 4949 個商品成功改為 1 天）。
- ⏳ 擴充功能本身已寫完並通過語法校驗，**尚未在實際 Chrome 環境跑端到端**；首次實跑可能有 1–2 處 selector 需微調（集中在 [`config.js`](extension/config.js)）。
- 登入偶爾會卡驗證碼/簡訊，這時需人工在瀏覽器完成再重跑。
- 蝦皮改版導致 selector 失效時，改 [`extension/config.js`](extension/config.js) 即可，邏輯不用動。

## 授權

MIT
