const $ = (id) => document.getElementById(id);
const PROVIDER_LABEL = { gemini: "Gemini", openai: "OpenAI", anthropic: "Claude" };

async function render() {
  const s = await chrome.storage.local.get(null);
  const provider = s.provider || "gemini";
  const hasKey = !!(s.apiKeys && (s.apiKeys[provider] || "").trim());
  $("enabled").checked = s.featureEnabled !== false;
  $("state").innerHTML = hasKey
    ? `供應商：<b>${PROVIDER_LABEL[provider]}</b> · 金鑰已設定 ✅`
    : `供應商：<b>${PROVIDER_LABEL[provider]}</b> · <span class="warn">尚未設定金鑰 ⚠️</span>`;

  const r = await chrome.runtime.sendMessage({ type: "getStats" }).catch(() => null);
  if (r) $("stats").textContent = `📊 今天 生成 ${r.today.generated} · 插入 ${r.today.inserted}（僅本機）`;
}

$("enabled").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ featureEnabled: e.target.checked });
});
$("open").addEventListener("click", () => chrome.runtime.openOptionsPage());
render();
