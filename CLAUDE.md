# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose

A tool for **Shopee Taiwan (蝦皮台灣) seller center** that resets the **備貨天數 (days-to-ship)** of every product to **1 day**. Delivered in **two forms**, both built on the same pure-API core (the Shopee batch-update APIs only need cookies — no anti-bot signature headers):

- **`extension/`** — Chrome MV3 extension (for distribution to others; auto-login; one-click).
- **`script/`** — Python standalone script (for yourself; cron-able; needs exported cookies).

## The flow (pure API, verified end-to-end)

All APIs are under `https://seller.shopee.tw`, cookie-authenticated, take `?SPC_CDS=<uuid>&SPC_CDS_VER=2`:

1. **Generate** — `POST /api/mass/mpsku/generate_template` body `{"is_query":false,"template_type":4}` (4 = 備貨天數/dts_info). NOTE: clicking the UI `generate-btn` only fires `is_query:true` queries — the real generate is `is_query:false`, so do it via direct POST.
2. **Poll download** — `GET /api/tool/mass_product/get_mass_record_list?operation_type=3` every ~3s (faster hits anti-bot 403 — tolerate & retry). Ready when a new record has `record_status===1` + `result_file_name`. `operation_type=3` = download records.
3. **Download zip** — `GET /api/tool/mass_product/download_record_file?record_id=<id>` → `mass_update_dts_info_{shop}_{ts}.zip`.
4. **Edit** — the zip holds 11 sharded `.xlsx` (1–11.xlsx, one row per variation). Set column `et_title_product_dts` (第 I 欄; rows 1–4 headers, data from row 5) to **1** for every data row. Done at the XML layer (JSZip/zipfile patch `xl/worksheets/sheet1.xml`) to preserve format; supports both shared-string (`t="s"`) and inline-string (`t="inlineStr"`) cells.
5. **Upload** — `POST /api/mass/mpsku/upload_edit_template` multipart `{file, operation_type:4}`. **Strictly sequential**: Shopee processes one file at a time; poll `operation_type=4` until `record_status===1` before the next.
6. **499/500 partial** is normal (~1/500 product-specific failure) — retry the same file once.

**Login** is the only step needing a real browser (anti-bot). The extension logs in via its content script (SPC_F injection → form login fallback). The Python script needs a **full cookie export** (Cookie-Editor → `cookies.json`) — SPC_F alone returns 403.

## Layout

```
shopee-changeday/
├── extension/              ← Chrome MV3 extension (distributable)
│   ├── manifest.json       # v1.0.0, pure-API
│   ├── config.js           # all URLs / API constants
│   ├── background.js       # pure-API orchestrator: generate→poll→download→edit→upload
│   ├── content.js          # LOGIN ONLY: detect login page → fill form → signal background
│   ├── popup.html / popup.js
│   ├── lib/jszip.min.js
│   └── icons/icon128.png
├── script/                 ← Python standalone (personal/cron)
│   ├── shopee_dts.py       # requests + zipfile/re XML edit, reads cookies.json
│   ├── requirements.txt
│   └── README.md           # cookie-export instructions
└── app/                    ← ABANDONED early Python+Playwright prototype
```

## Architecture notes

- **Extension**: the entire download/upload flow runs single-threaded in the background service worker via `fetch` (cookies shared with the browser). `content.js` only logs in and signals `LOGGED_IN`. This eliminated the old content-script state machine (source of duplicate/parallel-run bugs).
- **Edit at XML layer** (not SheetJS/openpyxl object model) to preserve format exactly for re-upload; also sidesteps the `activePane="bottom_left"` parse issue.
- **Credentials** (`account`, `password`, `spc_f`) live in `chrome.storage.local` key `config` (extension) or `script/cookies.json` (Python). Never log/commit them.

## Working on this repo

- Load `extension/` unpacked in `chrome://extensions` to test. When Shopee UI changes, fix constants in `config.js` / API paths at the top of `background.js`.
- All UI text is Traditional Chinese (繁體中文).
- Test the Python edit logic with a synthetic xlsx (no network needed); the API part needs reachable `seller.shopee.tw` + valid cookies.

## Status

Both deliverables implemented; APIs verified against the live site. Extension's SW orchestration + Python's API calls benefit from a real end-to-end run on a machine that can reach `seller.shopee.tw`.
