// content.js — runs on seller.shopee.tw / accounts.shopee.tw / shopee.tw.
//
// The flow spans page reloads (login → seller center → mass-update), so it uses
// a persisted state machine in chrome.storage.local key `run`:
//   { running, step, startedAt, readyFilename }
// On each page load, if a run is active, content resumes from `step`.
//
// Steps:
//   "login"       → on login page: fill creds + submit (reload). Else go to "goto_mass".
//   "goto_mass"   → navigate to the mass-update download tab (reload). On arrival → "download".
//   "download"    → select 備貨天數, generate, poll, click row download, hand to bg,
//                   then switch to upload tab (client-side, no reload) and upload all.
// When done → clear run.

(() => {
  "use strict";

  const RUN_KEY = "shopee_dts_run";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function bg(msg) {
    return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
  }
  async function log(msg, level = "info") {
    console.log(`[shopee-dts][${level}] ${msg}`);
    await bg({ type: "LOG", msg, level }).catch(() => {});
  }
  async function getRun() {
    const { [RUN_KEY]: run } = await chrome.storage.local.get(RUN_KEY);
    return run || null;
  }
  async function setRun(patch) {
    const run = (await getRun()) || {};
    Object.assign(run, patch);
    await chrome.storage.local.set({ [RUN_KEY]: run });
    return run;
  }
  async function clearRun() {
    await chrome.storage.local.remove(RUN_KEY);
    await bg({ type: "RUN_DONE" }).catch(() => {});
  }
  async function getConfig() {
    const { config } = await chrome.storage.local.get("config");
    return config || {};
  }

  async function waitFor(predicate, timeoutMs = 60000, intervalMs = 800) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const v = await predicate();
        if (v) return v;
      } catch (e) {}
      await sleep(intervalMs);
    }
    throw new Error("waitFor timeout (" + timeoutMs + "ms)");
  }

  // -------------------------------------------------------------------------
  // LOGIN
  // -------------------------------------------------------------------------
  function onLoginPage() {
    return /\/login|account\/login/i.test(location.href);
  }

  async function doLogin() {
    const cfg = await getConfig();
    await log("login page — filling credentials");
    if (!cfg.account || !cfg.password) {
      throw new Error("missing account/password in config — cannot log in");
    }

    // account input: try several selectors (placeholder text is the most stable)
    const accIn = await waitFor(() => {
      return (
        document.querySelector('input[placeholder*="電話"]') ||
        document.querySelector('input[placeholder*="Email"]') ||
        document.querySelector('input[placeholder*="帳號"]') ||
        document.querySelector('input[type="text"]:not([type="password"])') ||
        document.querySelector(CONFIG.SEL.loginAccount)
      );
    }, 15000);
    const pwIn = await waitFor(
      () => document.querySelector('input[type="password"]'),
      15000
    );
    await log("found login inputs");

    // Framework forms (Vue/React) ignore direct `.value =`; use the native setter
    // so the framework's onChange actually fires and the submit button enables.
    const setVal = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      ).set;
      setter.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    setVal(accIn, cfg.account);
    setVal(pwIn, cfg.password);
    await log("filled account/password");

    // wait until the 登入 button becomes enabled
    const btn = await waitFor(() => {
      return [...document.querySelectorAll("button")]
        .filter((b) => b.textContent.trim() === CONFIG.TEXT.login)
        .find((b) => !b.disabled && b.getBoundingClientRect().width > 0);
    }, 8000).catch(async () => {
      await log("login button still disabled — clicking anyway", "warn");
      return [...document.querySelectorAll("button")].find(
        (b) => b.textContent.trim() === CONFIG.TEXT.login
      );
    });

    await setRun({ step: "goto_mass" }); // after reload, resume here

    // Submit. Framework buttons often ignore a synthetic .click(), so try
    // several strategies and stop at the first that navigates away.
    const stillOnLogin = () => /\/login|account\/login/i.test(location.href);

    const form = pwIn.form || accIn.form || document.querySelector("form");
    const strategies = [];
    // 1) press Enter on the password field (most native form submit)
    strategies.push(["enter-key", async () => {
      for (const type of ["keydown", "keypress", "keyup"]) {
        pwIn.dispatchEvent(
          new KeyboardEvent(type, {
            key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true,
          })
        );
      }
    }]);
    // 2) form.requestSubmit()
    strategies.push(["form-submit", async () => {
      if (form && typeof form.requestSubmit === "function") form.requestSubmit();
      else if (form) form.submit();
    }]);
    // 3) click the button
    strategies.push(["button-click", async () => { if (btn) btn.click(); }]);

    for (const [name, fn] of strategies) {
      await log("login submit attempt: " + name);
      try { await fn(); } catch (e) { await log("  " + name + " error: " + e.message, "warn"); }
      // give the page a moment to navigate
      await sleep(2500);
      if (!stillOnLogin()) { await log("login succeeded via " + name); return; }
    }
    await log("all login strategies exhausted — still on login page", "error");
  }

  // -------------------------------------------------------------------------
  // DOWNLOAD phase (all within one content instance on the download tab)
  // -------------------------------------------------------------------------
  function spcCds() {
    try {
      return crypto.randomUUID();
    } catch (e) {
      return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });
    }
  }

  async function fetchRecords() {
    const url =
      CONFIG.API_RECORD_LIST +
      "?SPC_CDS=" +
      spcCds() +
      "&SPC_CDS_VER=2&page_number=1&page_size=20&operation_type=3";
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) return []; // 403/anti-bot: treat as empty, caller retries on next tick
    const j = await r.json();
    return (j && j.data && j.data.list) || [];
  }

  function findDtsRadio() {
    return [...document.querySelectorAll("label.eds-radio, [class*='eds-radio']")]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && e.textContent.trim() === CONFIG.TEXT.dts;
      })
      .find((e) => e.querySelector("input"));
  }

  async function selectDts() {
    const radio = findDtsRadio();
    if (!radio) throw new Error("備貨天數 radio not found");
    radio.click();
    await waitFor(() => {
      const r = findDtsRadio();
      return r && r.querySelector("input") && r.querySelector("input").checked;
    }, 5000);
    await log("備貨天數 selected");
  }

  async function generateAndWaitDownload() {
    const before = (await fetchRecords()).map((r) => r.id);
    const maxIdBefore = before.length ? Math.max(...before) : 0;

    const btn = await waitFor(
      () => document.querySelector(CONFIG.SEL.generateBtn),
      20000
    );
    btn.click();
    await log("clicked generate (下載)");

    const ready = await waitFor(async () => {
      const recs = await fetchRecords();
      return recs.find(
        (r) =>
          r.id > maxIdBefore &&
          r.record_status === 1 &&
          r.result_file_name
      );
    }, CONFIG.GEN_POLL_TIMEOUT_MS, 3000); // poll every 3s (faster hits anti-bot 403)
    await log("template ready: " + ready.result_file_name);
    return ready;
  }

  async function clickRowDownload(filename) {
    const fileCell = await waitFor(() =>
      [...document.querySelectorAll('abbr.file, [class*="file"]')].find(
        (e) => e.textContent.trim() === filename
      )
    );
    let row = fileCell.closest("tr");
    if (!row) {
      let n = fileCell.parentElement;
      for (let i = 0; i < 6 && n; i++) {
        if (n.querySelector("button")) {
          row = n;
          break;
        }
        n = n.parentElement;
      }
    }
    const dlBtn = [...(row ? row.querySelectorAll("button") : [])].find(
      (b) => b.textContent.trim() === CONFIG.TEXT.downloadTab
    );
    if (!dlBtn) throw new Error("row 下載 button not found for " + filename);
    dlBtn.click();
    await log("clicked row 下載 for " + filename);
  }

  // -------------------------------------------------------------------------
  // UPLOAD phase
  // -------------------------------------------------------------------------
  function findTab(text) {
    return [...document.querySelectorAll(CONFIG.SEL.tabContainer)].find(
      (e) => e.textContent.trim() === text && e.getBoundingClientRect().width > 0
    );
  }

  async function gotoUploadTab() {
    if (/mass-update\/upload/.test(location.href)) {
      await waitFor(() => document.querySelector(CONFIG.SEL.fileInput), 20000);
      return;
    }
    const tab = await waitFor(() => findTab(CONFIG.TEXT.uploadTab), 20000);
    tab.click();
    await waitFor(() => /mass-update\/upload/.test(location.href), 20000);
    await waitFor(() => document.querySelector(CONFIG.SEL.fileInput), 20000);
  }

  function findUploadRow(filename) {
    const rows = [...document.querySelectorAll("table tr")];
    // newest record is the FIRST data row (table is newest-first); return latest match
    return rows.find((r) => {
      const t = r.textContent.replace(/\s+/g, " ");
      return new RegExp("\\b" + filename.replace(/\./g, "\\.") + "\\b").test(t);
    });
  }

  function newestRowText() {
    const rows = [...document.querySelectorAll("table tr")];
    // rows[0] is the header; rows[1] is the newest data record
    return rows[1] ? rows[1].textContent.replace(/\s+/g, " ") : "";
  }

  async function submitFile(file) {
    const before = newestRowText(); // snapshot so we can detect the NEW record
    const input = document.querySelector(CONFIG.SEL.fileInput);
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    // wait until a new record row actually appears (avoid reading the old one)
    await waitFor(() => newestRowText() !== before, 15000);
  }

  // wait until the newest row for this file settles; returns "done" | "partial"
  async function waitSettle(filename) {
    await waitFor(async () => {
      const row = findUploadRow(filename);
      if (!row) return false;
      const t = row.textContent.replace(/\s+/g, " ");
      if (/完成/.test(t)) return true;
      if (/\d+\s*\/\s*\d+/.test(t) && /下載/.test(t)) return true; // N/M + failure-download link
      return false;
    }, CONFIG.UPLOAD_SETTLE_TIMEOUT_MS);
    const row = findUploadRow(filename);
    const t = row ? row.textContent.replace(/\s+/g, " ") : "";
    return /完成/.test(t) ? "done" : "partial";
  }

  async function uploadOne(file) {
    const maxRetries = CONFIG.UPLOAD_MAX_RETRIES;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      await submitFile(file);
      await log(
        "uploaded " + file.name + (attempt > 1 ? ` (重传 #${attempt})` : "") + " — waiting"
      );
      const status = await waitSettle(file.name);

      if (status === "done") {
        await log("✓ " + file.name + " 完成" + (attempt > 1 ? ` (第${attempt}次重传后成功)` : ""));
        return;
      }
      // partial (e.g. 499/500) — retry the same file
      const row = findUploadRow(file.name);
      const m = row
        ? row.textContent.replace(/\s+/g, " ").match(/(\d+)\s*\/\s*(\d+)/)
        : null;
      const frac = m ? m[1] + "/" + m[2] : "?/?";
      if (attempt < maxRetries) {
        await log(
          "⚠ " + file.name + " " + frac + " 部分失败，3秒后重传 (" + attempt + "/" + (maxRetries - 1) + ")",
          "warn"
        );
        await sleep(3000);
      } else {
        await log(
          "⚠ " + file.name + " " + frac + " 重传上限后仍部分失败（可手动下载失败明细）",
          "warn"
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // RESUME driver
  // -------------------------------------------------------------------------
  async function resume() {
    const run = await getRun();
    if (!run || !run.running) return;
    const loginAttempts = run.loginAttempts || 0;
    await log("content resume: step=" + run.step + " attempts=" + loginAttempts + " url=" + location.pathname);

    try {
      switch (run.step) {
        case "login": {
          if (!onLoginPage()) {
            // already authenticated (SPC_F worked or already logged in)
            await setRun({ step: "goto_mass", loginAttempts: 0 });
            location.href = CONFIG.MASS_UPDATE_URL;
            return;
          }
          if (loginAttempts >= 3) {
            throw new Error("登入失敗超過 3 次（可能卡驗證碼 / SPC_F 失效 / 帳密錯）— 停止");
          }
          await setRun({ loginAttempts: loginAttempts + 1 });
          await doLogin(); // navigates → instance dies → resume on next load
          return;
        }

        case "goto_mass": {
          // ⚠️ if we ended up back on the login page, the session is invalid.
          // Do NOT keep redirecting to the download tab (that loops forever);
          // fall back to a fresh form login.
          if (onLoginPage()) {
            await log("在登入頁（session 失效）→ 改走表單登入", "warn");
            if (loginAttempts >= 3) throw new Error("登入迴圈 — 停止");
            await setRun({ step: "login", loginAttempts: loginAttempts + 1 });
            // ask background to clear any stale SPC_F so it won't interfere
            await bg({ type: "CLEAR_SPC_F" }).catch(() => {});
            await doLogin();
            return;
          }
          if (!/mass-update\/download/.test(location.href)) {
            location.href = CONFIG.DOWNLOAD_TAB_URL;
            return;
          }
          await setRun({ step: "download", loginAttempts: 0 });
          await runDownloadAndUpload();
          return;
        }

        case "download": {
          if (onLoginPage()) {
            await setRun({ step: "login" });
            return; // next load handles login
          }
          if (!/mass-update\/download/.test(location.href)) {
            location.href = CONFIG.DOWNLOAD_TAB_URL;
            return;
          }
          await runDownloadAndUpload();
          return;
        }
      }
    } catch (e) {
      await log("FLOW ERROR (" + run.step + "): " + e.message, "error");
      await bg({
        type: "NOTIFY",
        title: "蝦皮備貨天數 失敗",
        body: String(e.message).slice(0, 200),
      });
      await clearRun();
    }
  }

  async function runDownloadAndUpload() {
    // ---- download ----
    await waitFor(() => findDtsRadio(), 30000);
    await selectDts();
    const ready = await generateAndWaitDownload();
    await setRun({ readyFilename: ready.result_file_name });

    // fetch the zip directly via the download API (no button click, no race)
    await log("asking background to fetch & edit the zip…");
    const resp = await bg({
      type: "FETCH_ZIP",
      recordId: ready.id,
      filename: ready.result_file_name,
    });
    if (!resp || !resp.ok) throw new Error("zip fetch/edit failed: " + (resp && resp.error));
    const files = resp.files;
    await log("got " + files.length + " edited xlsx; switching to 上傳");

    // ---- upload (sequential, one at a time, wait between) ----
    await gotoUploadTab();
    for (const f of files) {
      const blob = new Blob([f.bytes], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const file = new File([blob], f.name, { type: blob.type });
      await uploadOne(file);
    }

    await log("=== flow complete ===");
    await bg({ type: "NOTIFY", title: "蝦皮備貨天數", body: "全部上傳完成" });
    await clearRun();
  }

  // listen for explicit kick (background START_RUN already set run+opened tab)
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "RUN_FLOW") {
      sendResponse({ ok: true });
      resume();
    }
  });

  // signal that content is alive (helps confirm injection worked)
  console.log("[shopee-dts] content script loaded on", location.href);
  // auto-resume on load if a run is mid-flight (covers reloads between steps)
  setTimeout(resume, 600);
})();
