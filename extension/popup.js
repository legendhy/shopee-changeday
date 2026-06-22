// popup.js
const $ = (id) => document.getElementById(id);
const logEl = $("log");
const statusEl = $("status");

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

async function loadConfig() {
  const { config = {} } = await chrome.storage.local.get("config");
  $("account").value = config.account || "";
  $("password").value = config.password || "";
  $("spc_f").value = config.spc_f || "";
}

$("save").addEventListener("click", async () => {
  const config = {
    account: $("account").value.trim(),
    password: $("password").value,
    spc_f: $("spc_f").value.trim(),
  };
  await chrome.storage.local.set({ config });
  statusEl.textContent = "✓ 設定已儲存";
});

$("run").addEventListener("click", async () => {
  const { config = {} } = await chrome.storage.local.get("config");
  if (!config.spc_f && !config.account) {
    statusEl.textContent = "請先填入 SPC_F 或帳號並儲存";
    return;
  }
  statusEl.textContent = "啟動中…";
  const resp = await chrome.runtime.sendMessage({ type: "START_RUN", background: false });
  statusEl.textContent = resp && resp.ok ? "已啟動，請看記錄" : "啟動失敗";
});

$("clear").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "CLEAR_LOGS" });
  logEl.innerHTML = "";
});

$("reset").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "RESET" });
  statusEl.textContent = "已重置狀態（可重新執行）";
  $("run").disabled = false;
});

let lastCount = 0;
async function refresh() {
  const resp = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  if (!resp) return;
  const logs = resp.logs || [];
  if (logs.length !== lastCount) {
    lastCount = logs.length;
    logEl.innerHTML = logs
      .map(
        (e) =>
          `<span class="e-${e.level}">[${new Date(e.ts).toLocaleTimeString()}] ${esc(e.msg)}</span>`
      )
      .join("\n");
    logEl.scrollTop = logEl.scrollHeight;
  }
  if (resp.state && resp.state.running) {
    statusEl.textContent = "執行中…";
    $("run").disabled = true;
  } else {
    $("run").disabled = false;
  }
}

loadConfig();
refresh();
setInterval(refresh, 1200);
