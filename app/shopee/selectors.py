"""All Shopee Taiwan seller-center UI selectors and labels in ONE place.

The seller center is in **Traditional Chinese (繁體中文)** — labels here match
that, not Simplified.

These are best-guess selectors derived from the described UI. The real DOM
was not verified (no live credentials at build time). When a step fails during
a real run, fix the selector here — the flow logic in download.py / client.py
should not need to change.

Every label string is also exposed because some elements are easier to locate
by visible text than by class names that change between releases.
"""
from __future__ import annotations

# ---- Login page (seller.shopee.tw/account/login or portal) -----------------
LOGIN_ACCOUNT_INPUT = 'input[name="account"], input[placeholder*="帳號"], input[type="text"]'
LOGIN_PASSWORD_INPUT = 'input[name="password"], input[type="password"]'
LOGIN_SUBMIT_BUTTON = 'button:has-text("登入")'

# URLS -----------------------------------------------------------------------
SELLER_HOME = "/seller"          # landing after auth; redirect target if logged in
MY_PRODUCTS_URL = "/portal/product/all"   # 我的商品 → all products view
# 更新商品資料 (Update product info) lives under my products; the exact path
# varies — we navigate via clicks rather than hard URL where possible.

# ---- Sidebar / nav labels (Traditional Chinese) ----------------------------
LABEL_MY_PRODUCTS = "我的商品"
LABEL_UPDATE_PRODUCT_INFO = "更新商品資料"   # could also be "批次更新商品" — try both
LABEL_UPDATE_PRODUCT_INFO_ALT = "批次更新商品"

# ---- Download tab & field selection ----------------------------------------
LABEL_DOWNLOAD_TAB = "下載"
DOWNLOAD_TAB_BUTTON = 'button:has-text("下載"), [role="tab"]:has-text("下載")'

# The field multi-select / checklist to pick which columns to export.
# 备货天数 in Traditional Chinese is 備貨天數 (or "出貨天數" in some versions).
LABEL_DAYS_TO_SHIP = "備貨天數"
LABEL_DAYS_TO_SHIP_ALT = "出貨天數"

# The primary download button on the download tab (triggers export generation).
DOWNLOAD_GENERATE_BUTTON = 'button:has-text("下載"), button:has-text("產生檔案"), button:has-text("生成")'

# After generation, the file appears in a "下載紀錄" (download history) list with
# its own download link/button per row.
LABEL_DOWNLOAD_HISTORY = "下載紀錄"
DOWNLOAD_HISTORY_ROW_LINK = 'a[download], a:has-text("下載"), button:has-text("下載")'

# Column header in the exported spreadsheet for days-to-ship. Confirm against a
# real export file before editing.
XLS_HEADER_DAYS_TO_SHIP = "備貨天數"
XLS_HEADER_DAYS_TO_SHIP_ALT = "出貨天數"
TARGET_DAYS_TO_SHIP = 1
