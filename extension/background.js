// background.js — MV3 service worker.
// Responsibilities:
//   • inject SPC_F cookie (session restore)
//   • open/navigate the seller tab
//   • capture the dts zip download, fetch bytes, unzip + edit each xlsx (備貨天數=1)
//   • hand edited files to the content script for sequential upload
//   • weekly alarm
//   • store config + logs for the popup

importScripts("config.js", "lib/jszip.min.js");

const ALARM_WEEKLY = "shopee-dts-weekly";
const LOG_KEY = "shopee_dts_logs";
const STATE_KEY = "shopee_dts_state";
const MAX_LOGS = 400;

// ---------------------------------------------------------------------------
// logging (persisted ring buffer, shown in popup)
// ---------------------------------------------------------------------------
async function log(msg, level = "info") {
  const ts = Date.now();
  const entry = { ts, level, msg };
  const { [LOG_KEY]: logs = [] } = await chrome.storage.local.get(LOG_KEY);
  logs.push(entry);
  while (logs.length > MAX_LOGS) logs.shift();
  await chrome.storage.local.set({ [LOG_KEY]: logs });
  // also push to live state for popup polling
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
// cookie injection
// ---------------------------------------------------------------------------
async function injectSpcF() {
  const { config } = await chrome.storage.local.get("config");
  if (!config || !config.spc_f) return false;
  try {
    await chrome.cookies.set({
      url: "https://shopee.tw",
      name: "SPC_F",
      value: config.spc_f,
      domain: CONFIG.COOKIE_DOMAIN,
      path: "/",
      secure: true,
      sameSite: "no_restriction",
    });
    await log("SPC_F cookie injected");
    return true;
  } catch (e) {
    await log("cookie inject failed: " + e.message, "error");
    return false;
  }
}

// ---------------------------------------------------------------------------
// open / focus the seller tab (one tab reused across runs)
// ---------------------------------------------------------------------------
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
// download capture + zip/xlsx processing
// ---------------------------------------------------------------------------
let downloadWaiter = null; // { resolve, reject, timer }
let lastEditedFiles = null; // cache: if download arrives before waiter, hand it out later
let lastEditedAt = 0;

function matchesDtsDownload(item) {
  const f = item.filename || "";
  const u = item.url || "";
  // at onCreated time the filename may be empty and the url a signed CDN link,
  // so match generously: any shopee zip, or anything dts-related.
  return (
    /mass_update_dts/i.test(f) ||
    /mass_update_dts/i.test(u) ||
    /\.zip$/i.test(f) ||
    (/shopee/i.test(u) && /\.zip/i.test(u))
  );
}

// Log EVERY download while we're waiting, so we can see what the page produces
// even if it doesn't match the matcher.
chrome.downloads.onCreated.addListener(async (item) => {
  const matched = matchesDtsDownload(item);
  if (downloadWaiter && !matched) {
    await log(
      "download seen (non-matching, but waiter active — accepting): " +
        (item.filename || item.url),
      "warn"
    );
  } else if (!matched) {
    return; // unrelated download, ignore
  } else {
    await log("captured download: " + (item.filename || item.url));
  }
  // If we're actively waiting, accept ANY download (we just clicked, so it's ours).
  const target = downloadWaiter ? item : matched ? item : null;
  if (!target) return;
  const edited = await fetchAndProcess(item);
  if (!edited) return;
  lastEditedFiles = edited;
  lastEditedAt = Date.now();
  if (downloadWaiter) {
    const w = downloadWaiter;
    downloadWaiter = null;
    clearTimeout(w.timer);
    w.resolve(edited);
  }
});

async function fetchAndProcess(item) {
  let bytes;
  try {
    const resp = await fetch(item.url, { credentials: "include" });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    bytes = await resp.arrayBuffer();
  } catch (e) {
    try {
      const r2 = await fetch(item.finalUrl || item.url, { credentials: "include" });
      bytes = await r2.arrayBuffer();
    } catch (e2) {
      await log("failed to fetch download bytes: " + e2.message, "error");
      if (downloadWaiter) {
        const w = downloadWaiter;
        downloadWaiter = null;
        clearTimeout(w.timer);
        w.reject(e2);
      }
      return null;
    }
  }
  try {
    const edited = await processZip(bytes);
    await log(`processed zip → ${edited.length} edited xlsx files`);
    return edited;
  } catch (e) {
    await log("zip processing failed: " + e.message, "error");
    if (downloadWaiter) {
      const w = downloadWaiter;
      downloadWaiter = null;
      clearTimeout(w.timer);
      w.reject(e);
    }
    return null;
  }
}

async function awaitDownload(timeoutMs = 120000) {
  // if a download was already processed just now, hand it back immediately
  if (lastEditedFiles && Date.now() - lastEditedAt < 120000) {
    const f = lastEditedFiles;
    lastEditedFiles = null;
    return f;
  }
  return new Promise((resolve, reject) => {
    downloadWaiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        downloadWaiter = null;
        reject(new Error("download capture timed out"));
      }, timeoutMs),
    };
  });
}

// --- zip → edited xlsx files ----------------------------------------------
async function processZip(zipBytes) {
  const zip = await JSZip.loadAsync(zipBytes);
  const out = [];
  const names = Object.keys(zip.files).filter(
    (n) => !zip.files[n].dir && /\.xlsx$/i.test(n)
  );
  names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const name of names) {
    const buf = await zip.files[name].async("arraybuffer");
    const edited = await editDtsInXlsx(buf);
    out.push({ name: name.split("/").pop(), bytes: edited });
  }
  return out;
}

// --- edit one xlsx: set et_title_product_dts column = 1 for all data rows ---
async function editDtsInXlsx(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const sheetPath =
    Object.keys(zip.files).find(
      (n) => /xl\/worksheets\/sheet1\.xml$/i.test(n)
    ) || Object.keys(zip.files).find((n) => /xl\/worksheets\/.*\.xml$/i.test(n));
  if (!sheetPath) throw new Error("no sheet xml in xlsx");

  let sheetXml = await zip.file(sheetPath).async("string");

  // shared strings for resolving row-1 keys
  let shared = [];
  const ssFile = Object.keys(zip.files).find((n) =>
    /xl\/sharedstrings\.xml$/i.test(n)
  );
  if (ssFile) {
    const ssXml = await zip.file(ssFile).async("string");
    shared = [...ssXml.matchAll(/<si\b[\s\S]*?<\/si>/g)].map((m) =>
      (m[0].match(/<t\b[^>]*>[\s\S]*?<\/t>/g) || [])
        .map((t) => t.replace(/<[^>]+>/g, ""))
        .join("")
    );
  }

  // find target column letter from row 1
  const row1 = sheetXml.match(/<row\b[^>]*\br="1"[^>]*>([\s\S]*?)<\/row>/);
  if (!row1) throw new Error("row 1 (key row) not found");
  let targetCol = null;
  const cellRe = /<c\b[^>]*\br="([A-Z]+)1"[^>]*>([\s\S]*?)<\/c>|<c\b[^>]*\br="([A-Z]+)1"[^>]*\/>/g;
  let cm;
  while ((cm = cellRe.exec(row1[1])) !== null) {
    const col = cm[1] || cm[3];
    const inner = cm[2] || "";
    const vMatch = inner.match(/<v>([^<]*)<\/v>/);
    if (vMatch) {
      const val = shared[parseInt(vMatch[1], 10)] ?? vMatch[1];
      if (val === CONFIG.DTS_FIELD_KEY) {
        targetCol = col;
        break;
      }
    }
  }
  if (!targetCol) throw new Error("et_title_product_dts column not found in row 1");
  const targetNum = colToNum(targetCol);

  // edit data rows (row >= 5: 4 frozen header rows)
  sheetXml = sheetXml.replace(
    /<row\b([^>]*)>([\s\S]*?)<\/row>/g,
    (full, attrs, inner) => {
      const rM = attrs.match(/\br="(\d+)"/);
      if (!rM) return full;
      const rownum = parseInt(rM[1], 10);
      if (rownum < 5) return full;
      const cells = [...inner.matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"[^>]*(?:\/>|>[\s\S]*?<\/c>)/g)].map(
        (m) => {
          const col = m[1];
          return { col, num: colToNum(col), raw: m[0] };
        }
      );
      const newCell = `<c r="${targetCol}${rownum}"><v>${CONFIG.DTS_VALUE}</v></c>`;
      const idx = cells.findIndex((c) => c.num === targetNum);
      if (idx >= 0) {
        cells[idx].raw = newCell;
      } else {
        let at = cells.length;
        for (let i = 0; i < cells.length; i++) {
          if (cells[i].num > targetNum) {
            at = i;
            break;
          }
        }
        cells.splice(at, 0, { col: targetCol, num: targetNum, raw: newCell });
      }
      return `<row${attrs}>${cells.map((c) => c.raw).join("")}</row>`;
    }
  );

  zip.file(sheetPath, sheetXml);
  return await zip.generateAsync({
    type: "arraybuffer",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    compression: "DEFLATE",
  });
}

function colToNum(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

// ---------------------------------------------------------------------------
// message router (popup + content)
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case "INJECT_COOKIE":
          sendResponse({ ok: await injectSpcF() });
          return;
        case "AWAIT_DOWNLOAD":
          try {
            const files = await awaitDownload(msg.timeoutMs || 120000);
            sendResponse({ ok: true, files });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
          return;
        case "LOG":
          await log(msg.msg, msg.level);
          sendResponse({ ok: true });
          return;
        case "GET_STATE": {
          const { [LOG_KEY]: logs = [], [STATE_KEY]: state = {} } =
            await chrome.storage.local.get([LOG_KEY, STATE_KEY]);
          sendResponse({ logs, state });
          return;
        }
        case "CLEAR_LOGS":
          await chrome.storage.local.set({ [LOG_KEY]: [] });
          sendResponse({ ok: true });
          return;
        case "START_RUN":
          await startRun(msg.background);
          sendResponse({ ok: true });
          return;
        case "RUN_DONE":
          await setState({ running: false, finishedAt: Date.now() });
          sendResponse({ ok: true });
          return;
        case "NOTIFY":
          notify(msg.title, msg.body);
          sendResponse({ ok: true });
          return;
        default:
          sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // async
});

function notify(title, body) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message: body,
    });
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// run orchestration: open the tab + tell content script to execute the flow
// ---------------------------------------------------------------------------
async function startRun(fromBackground) {
  await setState({ running: true, startedAt: Date.now(), error: null });
  // persisted flow state for the content-script state machine
  await chrome.storage.local.set({
    shopee_dts_run: { running: true, step: "login", startedAt: Date.now() },
  });
  await log(fromBackground ? "weekly run triggered" : "manual run triggered");
  await injectSpcF();
  const tabId = await getOrCreateSellerTab(CONFIG.LOGIN_URL);
  // content auto-resumes on load; also kick it explicitly as backup
  setTimeout(() => {
    chrome.tabs.sendMessage(tabId, { type: "RUN_FLOW" }).catch(() => {});
  }, 4000);
}

// ---------------------------------------------------------------------------
// weekly alarm
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.get(ALARM_WEEKLY, (a) => {
    if (!a) chrome.alarms.create(ALARM_WEEKLY, { periodInMinutes: 10080 }); // 7 days
  });
  log("extension installed; weekly alarm armed");
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM_WEEKLY) startRun(true);
});
