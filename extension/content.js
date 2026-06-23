// content.js — LOGIN ONLY.
//
// The whole Shopee flow now runs in background.js via pure API. This script's
// only job: when the background opens the seller tab, detect whether we're
// logged in. If we are → tell background "LOGGED_IN". If we bounced to the
// login page (SPC_F alone wasn't enough) → fill the form + submit, then tell
// background "LOGGED_IN" after landing in the seller center.

(() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function bg(msg) { return new Promise((res) => chrome.runtime.sendMessage(msg, res)); }

  const onLoginPage = () => /\/login|account\/login/i.test(location.href);

  async function waitFor(pred, timeoutMs = 20000, intervalMs = 400) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try { const v = await pred(); if (v) return v; } catch (e) {}
      await sleep(intervalMs);
    }
    return null;
  }

  async function ready(minDelay = 600) {
    while (document.readyState !== "complete") await sleep(150);
    await sleep(minDelay);
  }
  const humanPause = (min = 700, max = 1500) => sleep(min + Math.floor(Math.random() * (max - min)));

  async function getConfig() {
    const { config } = await chrome.storage.local.get("config");
    return config || {};
  }

  async function doLogin() {
    const cfg = await getConfig();
    console.log("[shopee-dts] login page — filling credentials");
    await ready(800);
    const accIn = await waitFor(() => document.querySelector(CONFIG.SEL.loginAccount), 20000);
    const pwIn = await waitFor(() => document.querySelector(CONFIG.SEL.loginPassword), 20000);
    if (!accIn || !pwIn || !cfg.account || !cfg.password) {
      console.error("[shopee-dts] cannot login: inputs or credentials missing");
      return false;
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(accIn, cfg.account); accIn.dispatchEvent(new Event("input", { bubbles: true }));
    await humanPause(300, 700);
    setter.call(pwIn, cfg.password); pwIn.dispatchEvent(new Event("input", { bubbles: true }));
    await humanPause();

    // submit via Enter (most reliable on framework forms)
    for (const t of ["keydown", "keypress", "keyup"]) {
      pwIn.dispatchEvent(new KeyboardEvent(t, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
    // fallback: click the 登入 button
    await sleep(2500);
    if (onLoginPage()) {
      const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === CONFIG.TEXT.login && !b.disabled);
      if (btn) btn.click();
    }
    return true;
  }

  async function checkAndLogin() {
    if (onLoginPage()) {
      const ok = await doLogin();
      if (!ok) return;
      // wait until we leave the login page
      await waitFor(() => !onLoginPage(), 60000);
    }
    // we're in the seller center (or already were) → tell background to run the API flow
    await bg({ type: "LOGGED_IN" }).catch(() => {});
    console.log("[shopee-dts] logged in → background notified");
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "CHECK_LOGIN") { sendResponse({ ok: true }); checkAndLogin(); }
  });

  console.log("[shopee-dts] content loaded on", location.href);
  // auto-check on load (covers the initial open + reloads)
  setTimeout(checkAndLogin, 800);
  window.addEventListener("load", () => setTimeout(checkAndLogin, 500));
})();
