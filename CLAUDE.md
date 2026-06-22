# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose

A **Chrome extension (MV3)** for **Shopee Taiwan (蝦皮台灣) seller center** that, on a weekly schedule, resets the **備貨天數 (days-to-ship)** of every product to **1 day**.

The tool drives the seller center's own "更新商品資料" (batch update) tool end-to-end. The complete flow (fully reverse-engineered and verified against the live site):

1. **Login** — inject the `SPC_F` cookie (session restore, primary); fall back to account/password form login.
2. **Open the update page** — navigate directly to `https://seller.shopee.tw/portal/product/mass-update` (auto-redirects to the 下載 tab). This **bypasses the unclickable hover dropdown** on the product list — see `shopee-mass-update-direct-url` memory.
3. **Download** (下載 tab) — select the 備貨天數 radio, click `button.generate-btn` → `POST /api/mass/mpsku/generate_template` → poll `GET /api/tool/mass_product/get_mass_record_list?operation_type=3` until a new record hits `record_status===1` with a `result_file_name` → click that row's 下載 button → browser downloads `mass_update_dts_info_{shop}_{ts}.zip`.
4. **Edit** — the zip holds **11 sharded `.xlsx`** files (1.xlsx…11.xlsx, one row per variation). Set column `et_title_product_dts` (第 I 欄; rows 1–4 are headers, data from row 5) to **1** for every data row.
5. **Upload** (上傳 tab) — upload the **individual `.xlsx` files (NOT a zip)**. Upload is **automatic on file selection** (no start button) and **strictly sequential**: Shopee processes one file at a time; uploading the next before the previous finishes is rejected with「我們正在處理您上一份檔案」. Wait for each record to reach 完成 (or N/N settled) before the next.
6. **499/500** partial success is normal (~1 product-specific failure per ~500) — the 操作「下載」 link returns a file listing only the failed items. Log it, don't treat as a hard failure.

Detailed findings live in the memory files under `.claude/projects/.../memory/` (login flow, direct-URL trick, download flow, upload + xlsx structure).

## Layout

```
shopee-changeday/
├── extension/              ← THE PRODUCT (Chrome MV3 extension)
│   ├── manifest.json
│   ├── config.js           # all URLs / selectors / constants in one place
│   ├── background.js       # service worker: cookie inject, download capture,
│   │                       #   unzip + xlsx XML edit (JSZip), weekly alarm, logs
│   ├── content.js          # page automation state machine (survives reloads)
│   ├── popup.html / popup.js
│   ├── lib/jszip.min.js
│   ├── icons/icon128.png
│   └── README.md           # install + usage
└── (earlier Python prototype under app/ is ABANDONED — superseded by the extension)
```

## Architecture notes

- **State machine across reloads**: login → seller center → mass-update are full page reloads that destroy the content script. `content.js` persists the run in `chrome.storage.local` key `shopee_dts_run` (`{running, step, startedAt}`) and resumes on each load: steps `login → goto_mass → download`. The download-flow + upload-flow run in a single content instance (tab switches within the SPA are client-side, no reload).
- **xlsx editing is done at the XML layer** (JSZip → patch `xl/worksheets/sheet1.xml` → regen), NOT via SheetJS object model, to preserve format exactly for re-upload. This also sidesteps the openpyxl-style `activePane="bottom_left"` parse issue.
- **Download capture**: content clicks the row 下載 button → `chrome.downloads.onCreated` in background matches `mass_update_dts` → background `fetch(item.url, {credentials:'include'})` → unzip+edit → returns edited ArrayBuffers to content (via `AWAIT_DOWNLOAD` message). The waiter is registered BEFORE the click to avoid a race.
- **Credentials** (`account`, `password`, `spc_f`) live in `chrome.storage.local` key `config`; entered via popup. Never log `spc_f`.

## Working on this repo

- Load `extension/` as an unpacked extension in `chrome://extensions` (dev mode) to test.
- When the seller center UI changes, fix selectors in **`extension/config.js`** only — logic stays put.
- All UI text is Traditional Chinese (繁體中文); match labels exactly.

## Status

Extension scaffolded and syntax-checked; needs a live end-to-end run against the real site to validate the in-browser xlsx XML edit and the content-script state machine. The flow itself was proven manually via Chrome MCP (see memory).
