// config.js — shared constants for the Shopee 備貨天數 extension.

const CONFIG = {
  // --- URLs ---
  SELLER_HOME: "https://seller.shopee.tw/",
  COOKIE_DOMAIN: ".shopee.tw",

  // --- APIs (cookie-authenticated; SPC_CDS is a frontend tracking param, any uuid works) ---
  API_GENERATE_TEMPLATE: "https://seller.shopee.tw/api/mass/mpsku/generate_template",
  API_RECORD_LIST: "https://seller.shopee.tw/api/tool/mass_product/get_mass_record_list/",
  API_DOWNLOAD_FILE: "https://seller.shopee.tw/api/tool/mass_product/download_record_file/",
  API_UPLOAD_TEMPLATE: "https://seller.shopee.tw/api/mass/mpsku/upload_edit_template/",

  // --- Field / template constants ---
  DTS_TEMPLATE_TYPE: 4,                          // 備貨天數 (dts_info)
  DTS_FIELD_KEY: "et_title_product_dts",         // xlsx row-1 key, column I
  DTS_VALUE: 1,

  // --- Polling ---
  GEN_POLL_TIMEOUT_MS: 240000,                   // generation can take a few minutes
  UPLOAD_SETTLE_TIMEOUT_MS: 180000,              // per-file upload processing

  // --- Login UI (Traditional Chinese) ---
  SEL: {
    loginAccount: 'input[placeholder*="電話"], input[placeholder*="Email"], input[placeholder*="帳號"], input[type="text"]:not([type="password"])',
    loginPassword: 'input[type="password"]',
  },
  TEXT: { login: "登入" },
};

if (typeof globalThis !== "undefined") globalThis.CONFIG = CONFIG;
