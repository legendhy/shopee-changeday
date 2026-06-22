// config.js — shared constants for the Shopee 備貨天數 extension.
// Loaded before content.js (and importable by background via importScripts).

const CONFIG = {
  // --- URLs ---
  SELLER_HOME: "https://seller.shopee.tw/",
  LOGIN_URL:
    "https://accounts.shopee.tw/seller/login?next=https%3A%2F%2Fseller.shopee.tw%2F",
  MASS_UPDATE_URL: "https://seller.shopee.tw/portal/product/mass-update",
  DOWNLOAD_TAB_URL:
    "https://seller.shopee.tw/portal/product-mass/mass-update/download",
  UPLOAD_TAB_URL:
    "https://seller.shopee.tw/portal/product-mass/mass-update/upload",
  COOKIE_DOMAIN: ".shopee.tw",

  // --- APIs (cookie-authenticated; SPC_CDS is added by the page, but works without it too) ---
  API_GENERATE_TEMPLATE:
    "https://seller.shopee.tw/api/mass/mpsku/generate_template",
  API_RECORD_LIST:
    "https://seller.shopee.tw/api/tool/mass_product/get_mass_record_list/",

  // --- Field to update ---
  DTS_FIELD_KEY: "et_title_product_dts", // 備貨天數 column key in xlsx row 1
  DTS_VALUE: 1,

  // --- Polling ---
  GEN_POLL_INTERVAL_MS: 3000,
  GEN_POLL_TIMEOUT_MS: 240000, // generation can take a few minutes for big shops
  UPLOAD_SETTLE_TIMEOUT_MS: 180000, // per-file upload processing
  UPLOAD_MAX_RETRIES: 3, // re-upload a file if it ends partial (N<M), e.g. 499/500

  // --- Selectors (Traditional Chinese UI) ---
  SEL: {
    loginAccount: 'input[type="text"]', // placeholder 電話號碼/使用者名稱/Email
    loginPassword: 'input[type="password"]',
    loginSubmit: 'button[type="submit"]', // text 登入

    // download tab
    dtsRadioText: "備貨天數",
    generateBtn: "button.generate-btn", // 主「下載」(生成模板)

    // tabs
    tabContainer: ".eds-tabs__nav-tab", // each tab; pick by text 下載/上傳

    // upload
    fileInput: 'input[type="file"]',
  },

  TEXT: {
    login: "登入",
    downloadTab: "下載",
    uploadTab: "上傳",
    dts: "備貨天數",
    done: "完成",
  },
};

// expose for service worker context
if (typeof globalThis !== "undefined") globalThis.CONFIG = CONFIG;
