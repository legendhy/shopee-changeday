// background.js — MV3 service worker (pure-API orchestrator).
//
// The ENTIRE Shopee flow runs here via direct API calls (cookie-authenticated).
// content.js only handles browser login (when SPC_F alone won't restore session).
//
// APIs (all under seller.shopee.tw, cookies only, no anti-bot signature headers):
//   1. POST /api/mass/mpsku/generate_template        body {is_query:false,template_type:4}
//   2. GET  /api/tool/mass_product/get_mass_record_list?operation_type=3   (poll download)
//   3. GET  /api/tool/mass_product/download_record_file?record_id=<id>     (zip)
//   4. POST /api/mass/mpsku/upload_edit_template      multipart {file, operation_type:4}
//   5. GET  /api/tool/mass_product/get_mass_record_list?operation_type=4   (poll upload)

importScripts("config.js", "lib/jszip.min.js");

const ALARM_WEEKLY = "shopee-dts-weekly";
const LOG_KEY = "shopee_dts_logs";
const STATE_KEY = "shopee_dts_state";

// ---------------------------------------------------------------------------
// logging + state
// ---------------------------------------------------------------------------
async function log(msg, level = "info") {
  const entry = { ts: Date.now(), level, msg };
  const { [LOG_KEY]: logs = [] } = await chrome.storage.local.get(LOG_KEY);
  logs.push(entry);
  while (logs.length > 400) logs.shift();
  await chrome.storage.local.set({ [LOG_KEY]: logs });
  const { [STATE_KEY]: state = {} } = await chrome.storage.local.get(STATE_KEY);
  state.lastLog = entry;
  await chrome.storage.local.set({ [STATE_KEY]: state });
  console.log(`[shopee-dts][${level}] ${msg}`);
}

async function setState(patch) {
  const { [STATE_KEY]: state = {} } = await chrome.storage.local.get(STATE_KEY);
  Object.assign(state, patch);
  await chrome.storage.local.set({ [STATE_KEY]: state });
}

// ---------------------------------------------------------------------------
// cookie + tab
// ---------------------------------------------------------------------------
async function injectSpcF() {
  const { config } = await chrome.storage.local.get("config");
  if (!config || !config.spc_f) return false;
  try {
    await chrome.cookies.set({
      url: "https://shopee.tw", name: "SPC_F", value: config.spc_f,
      domain: ".shopee.tw", path: "/", secure: true, sameSite: "no_restriction",
    });
    return true;
  } catch (e) {
    await log("cookie inject failed: " + e.message, "error");
    return false;
  }
}

async function getOrCreateSellerTab(url) {
  const tabs = await chrome.tabs.query({ url: "https://seller.shopee.tw/*" });
  if (tabs.length) {
    const tab = tabs[0];
    if (url) await chrome.tabs.update(tab.id, { url, active: true });
    else await chrome.tabs.update(tab.id, { active: true });
    return tab.id;
  }
  const tab = await chrome.tabs.create({ url: url || CONFIG.SELLER_HOME, active: true });
  return tab.id;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
function cds() {
  // SPC_CDS is a frontend tracking param; any uuid works.
  let u;
  try { u = crypto.randomUUID(); } catch (e) {
    u = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
  return { SPC_CDS: u, SPC_CDS_VER: 2 };
}

async function apiGenerate() {
  const url = CONFIG.API_GENERATE_TEMPLATE + "?" + new URLSearchParams(cds());
  const r = await fetch(url, {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json;charset=UTF-8" },
    body: JSON.stringify({ is_query: false, template_type: CONFIG.DTS_TEMPLATE_TYPE }),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status !== 200 || j.code !== 0) throw new Error(`generate failed: HTTP ${r.status} ${JSON.stringify(j).slice(0,120)}`);
  const recs = await apiList(3);
  return recs.length ? Math.max(...recs.map((x) => x.id)) : 0;
}

async function apiList(op) {
  const url = CONFIG.API_RECORD_LIST + "?" + new URLSearchParams({ ...cds(), page_number: 1, page_size: 10, operation_type: op });
  try {
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) return [];          // 403/anti-bot → empty, caller retries
    const j = await r.json();
    return (j && j.data && j.data.list) || [];
  } catch (e) { return []; }
}

async function apiDownloadZip(recordId) {
  const url = CONFIG.API_DOWNLOAD_FILE + "?" + new URLSearchParams({ ...cds(), record_id: recordId, timestamp: Date.now() });
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error("download HTTP " + r.status);
  return new Uint8Array(await r.arrayBuffer());
}

async function apiUpload(filename, bytes) {
  const url = CONFIG.API_UPLOAD_TEMPLATE + "?" + new URLSearchParams(cds());
  const fd = new FormData();
  fd.append("file", new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), filename);
  fd.append("operation_type", "4");
  const r = await fetch(url, { method: "POST", credentials: "include", body: fd });
  const j = await r.json().catch(() => ({}));
  if (r.status !== 200 || j.code !== 0) throw new Error(`upload ${filename} failed: HTTP ${r.status} ${JSON.stringify(j).slice(0,120)}`);
  const recs = await apiList(4);
  return recs.length ? Math.max(...recs.map((x) => x.id)) : 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs, intervalMs = 3000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try { const v = await predicate(); if (v) return v; } catch (e) {}
    await sleep(intervalMs);
  }
  throw new Error("timeout");
}

// ---------------------------------------------------------------------------
// zip / xlsx editing (XML layer, preserves format; shared + inline strings)
// ---------------------------------------------------------------------------
function colToNum(letters) { let n = 0; for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64); return n; }

async function processZip(zipBytes) {
  const zip = await JSZip.loadAsync(zipBytes);
  const out = [];
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir && /\.xlsx$/i.test(n));
  names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const name of names) {
    const buf = await zip.files[name].async("arraybuffer");
    out.push({ name: name.split("/").pop(), bytes: await editDtsInXlsx(buf) });
  }
  return out;
}

async function editDtsInXlsx(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const sheetPath = Object.keys(zip.files).find((n) => /xl\/worksheets\/sheet1\.xml$/i.test(n));
  if (!sheetPath) throw new Error("no sheet xml");
  let xml = await zip.file(sheetPath).async("string");

  let shared = [];
  const ssFile = Object.keys(zip.files).find((n) => /xl\/sharedstrings\.xml$/i.test(n));
  if (ssFile) {
    const ssXml = await zip.file(ssFile).async("string");
    shared = [...ssXml.matchAll(/<si\b[\s\S]*?<\/si>/g)].map((m) =>
      (m[0].match(/<t\b[^>]*>[\s\S]*?<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, "")).join(""));
  }
  const cellVal = (inner) => {
    const im = inner.match(/<is\b[^>]*>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/);
    if (im) return im[1];                       // inline string
    const vm = inner.match(/<v>([^<]*)<\/v>/);
    if (vm) { const v = vm[1]; return /^\d+$/.test(v) && +v < shared.length ? shared[+v] : v; }
    return null;
  };

  // find target column from row 1
  const row1 = xml.match(/<row\b[^>]*\br="1"[^>]*>([\s\S]*?)<\/row>/);
  if (!row1) throw new Error("row 1 not found");
  let target = null;
  const cellRe = /<c\b[^>]*\br="([A-Z]+)1"[^>]*>([\s\S]*?)<\/c>|<c\b[^>]*\br="([A-Z]+)1"[^>]*\/>/g;
  let cm;
  while ((cm = cellRe.exec(row1[1])) !== null) {
    if (cellVal(cm[2] || "") === CONFIG.DTS_FIELD_KEY) { target = cm[1] || cm[3]; break; }
  }
  if (!target) throw new Error("et_title_product_dts column not found");
  const tnum = colToNum(target);

  // rewrite data rows (row >= 5)
  xml = xml.replace(/<row\b([^>]*)>([\s\S]*?)<\/row>/g, (full, attrs, inner) => {
    const rM = attrs.match(/\br="(\d+)"/); if (!rM) return full;
    const rn = +rM[1]; if (rn < 5) return full;
    const cells = [...inner.matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"[^>]*(?:\/>|>[\s\S]*?<\/c>)/g)]
      .map((m) => ({ num: colToNum(m[1]), raw: m[0] }));
    const nc = `<c r="${target}${rn}"><v>${CONFIG.DTS_VALUE}</v></c>`;
    const idx = cells.findIndex((c) => c.num === tnum);
    if (idx >= 0) cells[idx].raw = nc;
    else { let at = cells.length; for (let i = 0; i < cells.length; i++) if (cells[i].num > tnum) { at = i; break; } cells.splice(at, 0, { raw: nc }); }
    return `<row${attrs}>${cells.map((c) => c.raw).join("")}</row>`;
  });

  zip.file(sheetPath, xml);
  return await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
}

// ---------------------------------------------------------------------------
// the flow
// ---------------------------------------------------------------------------
async function runFlow() {
  await log("=== API flow start ===");

  // 1) generate
  await log("requesting template generation (備貨天數)…");
  const maxId = await apiGenerate();
  await log("generate requested, baseline id=" + maxId);

  // 2) poll download until ready
  const dl = await waitFor(async () => {
    const recs = await apiList(3);
    const n = recs.filter((x) => x.id > maxId).sort((a, b) => b.id - a.id)[0];
    if (n && n.record_status === 1 && n.result_file_name) return n;
    if (n) await log("  gen " + (n.handled_count || 0) + "/" + (n.total_count || 0));
    return null;
  }, CONFIG.GEN_POLL_TIMEOUT_MS);
  await log("template ready: " + dl.result_file_name);

  // 3) download + edit
  const zipBytes = await apiDownloadZip(dl.id);
  await log("downloaded zip: " + Math.round(zipBytes.length / 1024) + " KB");
  const files = await processZip(zipBytes);
  await log("edited " + files.length + " xlsx (備貨天數=1)");

  // 4) upload sequentially (Shopee processes one at a time)
  for (const f of files) {
    const upId = await apiUpload(f.name, f.bytes);
    await log("uploaded " + f.name + " (record " + upId + "), waiting for 完成…");
    const ok = await waitFor(async () => {
      const recs = await apiList(4);
      const n = recs.filter((x) => x.id >= upId).sort((a, b) => b.id - a.id)[0];
      if (!n) return null;
      if (n.record_status === 1) {
        if ((n.handled_count || 0) >= (n.total_count || 0)) return "done";
        return "partial";
      }
      return null;
    }, CONFIG.UPLOAD_SETTLE_TIMEOUT_MS);
    if (ok === "done") await log("✓ " + f.name + " 完成");
    else if (ok === "partial") {
      await log("⚠ " + f.name + " 部分失敗，重傳一次", "warn");
      const upId2 = await apiUpload(f.name, f.bytes);
      await waitFor(async () => {
        const recs = await apiList(4);
        const n = recs.filter((x) => x.id >= upId2).sort((a, b) => b.id - a.id)[0];
        return n && n.record_status === 1 ? true : null;
      }, CONFIG.UPLOAD_SETTLE_TIMEOUT_MS).catch(() => {});
      await log("重傳 " + f.name + " 已提交");
    }
  }

  await log("=== flow complete ===");
  await notify("蝦皮備貨天數", "全部上傳完成");
}

function notify(title, body) {
  try { chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title, message: body }); } catch (e) {}
}

// ---------------------------------------------------------------------------
// login coordination: open tab → wait for content to confirm login → run flow
// ---------------------------------------------------------------------------
let loginResolver = null;
function awaitLogin(timeoutMs = 120000) {
  return new Promise((resolve, reject) => { loginResolver = { resolve, reject }; });
}

async function startRun(fromBackground) {
  await setState({ running: true, startedAt: Date.now(), error: null });
  await log(fromBackground ? "weekly run triggered" : "manual run triggered");
  await injectSpcF();
  const tabId = await getOrCreateSellerTab(CONFIG.SELLER_HOME);

  // wait for content.js to confirm login (it logs in if needed), then run API flow
  let done = false;
  awaitLogin().then(async () => {
    done = true;
    try { await runFlow(); }
    catch (e) { await log("FLOW ERROR: " + e.message, "error"); await notify("蝦皮備貨天數 失敗", String(e.message).slice(0, 200)); }
    finally { await setState({ running: false, finishedAt: Date.now() }); }
  });
  // kick content script in case auto-detect didn't fire
  setTimeout(() => { chrome.tabs.sendMessage(tabId, { type: "CHECK_LOGIN" }).catch(() => {}); }, 4000);
  setTimeout(() => { if (!done && loginResolver) { loginResolver = null; } }, timeoutMs + 5000);
}

// ---------------------------------------------------------------------------
// message router (popup + content)
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case "LOG": await log(msg.msg, msg.level); sendResponse({ ok: true }); return;
      case "NOTIFY": notify(msg.title, msg.body); sendResponse({ ok: true }); return;
      case "GET_STATE": {
        const { [LOG_KEY]: logs = [], [STATE_KEY]: state = {} } = await chrome.storage.local.get([LOG_KEY, STATE_KEY]);
        sendResponse({ logs, state }); return;
      }
      case "CLEAR_LOGS": await chrome.storage.local.set({ [LOG_KEY]: [] }); sendResponse({ ok: true }); return;
      case "START_RUN": startRun(msg.background); sendResponse({ ok: true }); return;
      case "RESET": await setState({ running: false }); await log("state reset", "warn"); sendResponse({ ok: true }); return;
      case "LOGGED_IN":
        if (loginResolver) { const r = loginResolver; loginResolver = null; r.resolve(); }
        sendResponse({ ok: true }); return;
      default: sendResponse({ ok: false });
    }
  })();
  return true;
});

// ---------------------------------------------------------------------------
// weekly alarm
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.get(ALARM_WEEKLY, (a) => { if (!a) chrome.alarms.create(ALARM_WEEKLY, { periodInMinutes: 10080 }); });
});
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM_WEEKLY) startRun(true); });
