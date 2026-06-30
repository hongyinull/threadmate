const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  provider: "gemini",
  apiKeys: { openai: "", anthropic: "", gemini: "" },
  models: { openai: "gpt-5.4-mini", anthropic: "claude-haiku-4-5", gemini: "gemini-flash-latest" },
  tone: "friendly",
  language: "auto",
  niche: "",
  customInstr: "",
  promo: "",
  followingFeed: false,
  featureEnabled: true,
};

function showProviderBlocks() {
  const p = $("provider").value;
  document.querySelectorAll(".provider-block").forEach((b) => {
    b.style.display = b.dataset.provider === p ? "" : "none";
  });
}

async function load() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(null)) };
  const keys = { ...DEFAULTS.apiKeys, ...(s.apiKeys || {}) };
  const models = { ...DEFAULTS.models, ...(s.models || {}) };

  $("provider").value = s.provider;
  $("key-gemini").value = keys.gemini;
  $("key-openai").value = keys.openai;
  $("key-anthropic").value = keys.anthropic;
  $("model-gemini").value = models.gemini;
  $("model-openai").value = models.openai;
  $("model-anthropic").value = models.anthropic;
  $("tone").value = s.tone;
  $("language").value = s.language;
  $("niche").value = s.niche;
  $("promo").value = s.promo;
  $("customInstr").value = s.customInstr;
  $("featureEnabled").checked = s.featureEnabled !== false;
  $("followingFeed").checked = !!s.followingFeed;
  showProviderBlocks();
}

async function save() {
  const data = {
    provider: $("provider").value,
    apiKeys: {
      gemini: $("key-gemini").value.trim(),
      openai: $("key-openai").value.trim(),
      anthropic: $("key-anthropic").value.trim(),
    },
    models: {
      gemini: $("model-gemini").value.trim() || DEFAULTS.models.gemini,
      openai: $("model-openai").value.trim() || DEFAULTS.models.openai,
      anthropic: $("model-anthropic").value.trim() || DEFAULTS.models.anthropic,
    },
    tone: $("tone").value,
    language: $("language").value.trim() || "auto",
    niche: $("niche").value.trim(),
    promo: $("promo").value.trim(),
    customInstr: $("customInstr").value.trim(),
    featureEnabled: $("featureEnabled").checked,
    followingFeed: $("followingFeed").checked,
  };
  await chrome.storage.local.set(data);
  status("已儲存 ✅");
}

function status(msg, isError) {
  const el = $("status");
  el.textContent = msg;
  el.className = "status" + (isError ? " error" : "");
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.textContent = ""), 3000);
}

async function test() {
  await save();
  status("生成中…");
  const out = $("testOut");
  out.hidden = false;
  out.textContent = "⏳ 請稍候…";
  const res = await chrome.runtime.sendMessage({ type: "test" });
  if (res && res.ok) {
    out.textContent = "範例貼文：「Just shipped a tiny open-source tool…」\n\nAI 草稿：\n" + res.text;
    status("成功 ✅");
  } else {
    out.textContent = "❌ " + (res?.error || "未知錯誤");
    status("失敗", true);
  }
}

// ---- templates -----------------------------------------------------------
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function renderTemplates() {
  const { templates = [] } = await chrome.storage.local.get("templates");
  const list = $("templateList");
  list.innerHTML = "";
  if (!templates.length) {
    list.innerHTML = '<p class="hint">尚無範本。</p>';
    return;
  }
  templates.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "tpl-row";
    const meta = document.createElement("div");
    meta.className = "tpl-meta";
    meta.innerHTML = `<b>${escapeHtml(t.label || "(無標籤)")}</b><span>${escapeHtml(t.text)}</span>`;
    const del = document.createElement("button");
    del.textContent = "刪除";
    del.className = "tpl-del";
    del.addEventListener("click", () => removeTemplate(i));
    row.append(meta, del);
    list.appendChild(row);
  });
}

async function addTemplate() {
  const label = $("tplLabel").value.trim();
  const text = $("tplText").value.trim();
  if (!text) {
    status("範本內容不能空白", true);
    return;
  }
  const { templates = [] } = await chrome.storage.local.get("templates");
  templates.push({ id: Date.now().toString(36), label, text });
  await chrome.storage.local.set({ templates });
  $("tplLabel").value = "";
  $("tplText").value = "";
  renderTemplates();
  status("已新增範本 ✅");
}

async function removeTemplate(i) {
  const { templates = [] } = await chrome.storage.local.get("templates");
  templates.splice(i, 1);
  await chrome.storage.local.set({ templates });
  renderTemplates();
}

async function loadStats() {
  const r = await chrome.runtime.sendMessage({ type: "getStats" });
  if (r) {
    $("statsLine").textContent =
      `📊 今天：生成 ${r.today.generated} · 插入 ${r.today.inserted}　|　` +
      `總共：生成 ${r.total.generated} · 插入 ${r.total.inserted}（僅存本機，不上傳）`;
  }
}

// ---- import / export -----------------------------------------------------
const EXPORT_KEYS = [
  "provider", "apiKeys", "models", "tone", "language", "niche",
  "promo", "customInstr", "templates", "followingFeed", "featureEnabled", "auto7",
];

async function gatherExport(includeKeys) {
  await save(); // persist current form first
  const s = await chrome.storage.local.get(null);
  const out = {};
  EXPORT_KEYS.forEach((k) => {
    if (k in s) out[k] = s[k];
  });
  if (!includeKeys) delete out.apiKeys; // omit entirely so import won't wipe theirs
  return {
    app: "threadmate",
    version: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    settings: out,
  };
}

async function downloadExport() {
  const obj = await gatherExport($("expKeys").checked);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" }));
  a.download = "threadmate-settings.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  status("已下載設定檔" + ($("expKeys").checked ? "（含金鑰）" : "（不含金鑰）"));
}

async function copyExport() {
  const obj = await gatherExport($("expKeys").checked);
  try {
    await navigator.clipboard.writeText(JSON.stringify(obj));
    status("已複製設定文字，可直接貼給同事");
  } catch (e) {
    status("複製失敗，請改用下載", true);
  }
}

async function applyImport(obj) {
  if (!obj || obj.app !== "threadmate" || !obj.settings) {
    return status("不是有效的 Threadmate 設定檔", true);
  }
  const toSet = {};
  EXPORT_KEYS.forEach((k) => {
    if (obj.settings[k] !== undefined) toSet[k] = obj.settings[k];
  });
  await chrome.storage.local.set(toSet);
  await load();
  renderTemplates();
  loadStats();
  status("已匯入設定 ✅");
}

$("provider").addEventListener("change", showProviderBlocks);
$("save").addEventListener("click", save);
$("test").addEventListener("click", test);
$("tplAdd").addEventListener("click", addTemplate);
$("expDownload").addEventListener("click", downloadExport);
$("expCopy").addEventListener("click", copyExport);
$("impFileBtn").addEventListener("click", () => $("impFile").click());
$("impFile").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      applyImport(JSON.parse(r.result));
    } catch (err) {
      status("檔案不是有效的 JSON", true);
    }
  };
  r.readAsText(f);
  e.target.value = "";
});
$("impPasteBtn").addEventListener("click", () => {
  const txt = $("impPaste").value.trim();
  if (!txt) return status("請貼上設定文字，或用「從檔案匯入」", true);
  try {
    applyImport(JSON.parse(txt));
  } catch (e) {
    status("貼上的不是有效的 JSON", true);
  }
});
load();
renderTemplates();
loadStats();
