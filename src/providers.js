// Provider adapters — called only from the background service worker.
// Each takes the user's own API key and talks DIRECTLY to the provider.
// No proxy, no backend. Returns the reply text, or throws with a useful message.

// Generous headroom so replies never get cut mid-sentence — including on
// "thinking" models (e.g. gemini-2.5-flash) where internal reasoning ALSO spends
// output tokens. The prompt keeps the actual reply short (1–2 sentences), so this
// only widens the ceiling; it doesn't make replies longer. CJK uses ≥1 token/char.
const MAX_TOKENS = 2048;
const TEMPERATURE = 0.9;

export async function generate({ provider, apiKey, model, system, user }) {
  if (provider === "openai") return openai({ apiKey, model, system, user });
  if (provider === "anthropic") return anthropic({ apiKey, model, system, user });
  if (provider === "gemini") return gemini({ apiKey, model, system, user });
  throw new Error("未知的 AI 供應商：" + provider);
}

async function openai({ apiKey, model, system, user }) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      // GPT-5 family uses max_completion_tokens and rejects custom temperature.
      max_completion_tokens: MAX_TOKENS,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${data?.error?.message || r.statusText}`);
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI 回傳空內容");
  return text;
}

async function anthropic({ apiKey, model, system, user }) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // Required for direct browser/extension-origin calls to the Anthropic API.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${data?.error?.message || r.statusText}`);
  if (data?.stop_reason === "refusal") throw new Error("Anthropic 基於安全政策拒絕了此請求");
  const text = (data?.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new Error("Anthropic 回傳空內容");
  return text;
}

async function gemini({ apiKey, model, system, user }) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
    `:generateContent?key=${encodeURIComponent(apiKey)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: MAX_TOKENS, temperature: TEMPERATURE },
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${data?.error?.message || r.statusText}`);
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("");
  if (!text) throw new Error("Gemini 回傳空內容（可能觸發安全阻擋或配額用盡）");
  return text;
}
