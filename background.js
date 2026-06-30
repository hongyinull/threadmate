// Background service worker (MV3, module).
// All AI calls happen here so the API key never enters the page context.

import { buildPrompt } from "./src/prompt.js";
import { generate } from "./src/providers.js";

const DEFAULTS = {
  provider: "gemini", // most generous free tier → best default for a "free for everyone" tool
  apiKeys: { openai: "", anthropic: "", gemini: "" },
  models: {
    // current as of 2026-06 (verified against official docs); all user-editable
    openai: "gpt-5.4-mini",
    anthropic: "claude-haiku-4-5",
    gemini: "gemini-flash-latest", // alias → always the latest flash, never goes stale
  },
  tone: "friendly",
  language: "auto",
  niche: "",
  customInstr: "",
  promo: "",
  followingFeed: false,
  featureEnabled: true,
  templates: [],
};

chrome.runtime.onInstalled.addListener(async (details) => {
  const cur = await chrome.storage.local.get(null);
  await chrome.storage.local.set({ ...DEFAULTS, ...cur });
  // Open the settings page on first install — and also if no API key is configured
  // yet (so a colleague who just loaded it lands on setup, even if the install event
  // was missed). Won't bother users who already have a key set.
  const keys = cur.apiKeys || {};
  const hasAnyKey = ["gemini", "openai", "anthropic"].some((p) => (keys[p] || "").trim());
  if (details.reason === "install" || !hasAnyKey) {
    chrome.runtime.openOptionsPage();
  }
});

async function getSettings() {
  const s = await chrome.storage.local.get(null);
  return {
    ...DEFAULTS,
    ...s,
    apiKeys: { ...DEFAULTS.apiKeys, ...(s.apiKeys || {}) },
    models: { ...DEFAULTS.models, ...(s.models || {}) },
  };
}

// ---- local-only usage stats (no telemetry; never leaves the device) -------
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function bumpStat(field) {
  const { stats } = await chrome.storage.local.get("stats");
  const s = stats || { byDay: {}, total: { generated: 0, inserted: 0 } };
  const k = todayKey();
  s.byDay[k] = s.byDay[k] || { generated: 0, inserted: 0 };
  s.byDay[k][field] = (s.byDay[k][field] || 0) + 1;
  s.total[field] = (s.total[field] || 0) + 1;
  // keep only the last 30 days
  const days = Object.keys(s.byDay).sort();
  while (days.length > 30) delete s.byDay[days.shift()];
  await chrome.storage.local.set({ stats: s });
}

async function getStats() {
  const { stats } = await chrome.storage.local.get("stats");
  const s = stats || { byDay: {}, total: { generated: 0, inserted: 0 } };
  return { today: s.byDay[todayKey()] || { generated: 0, inserted: 0 }, total: s.total };
}

// Some models ignore "single reply only" and return a meta list like
// "Drafting Options:\n* Option 1: ...". Strip that scaffolding to a clean reply.
function cleanReply(t) {
  if (!t) return t;
  let s = t.trim();
  // strip markdown emphasis / bullets / code ticks / headings FIRST, so the option
  // detection below isn't broken by "**Option 1**:" style formatting.
  s = s.replace(/\*\*/g, "").replace(/^\s*[\*\-•]\s+/gm, "").replace(/[`#]/g, "");
  // drop a leading preamble line ("Drafting Options:", "Here are options:", "選項：")
  s = s.replace(/^\s*(drafting options|here('?s| are)[^\n]*options?|options?|草稿選項|選項)\s*[:：][^\n]*\n+/i, "");
  // if it's still an options list, keep only the FIRST option's text
  if (/(?:option|選項)\s*\d/i.test(s)) {
    const m = s.match(/(?:option|選項)\s*\d+\s*[:：.\)]\s*([^\n]+)/i);
    if (m) s = m[1];
  }
  // strip wrapping quotes
  s = s.replace(/^\s*["'「『]+/, "").replace(/["'」』]+\s*$/, "");
  return s.trim();
}

async function handleGenerate({ postText, platform }) {
  const s = await getSettings();
  const provider = s.provider;
  const apiKey = (s.apiKeys[provider] || "").trim();
  if (!apiKey) {
    return { ok: false, error: `尚未設定 ${provider} 的 API 金鑰，請在設定頁填入。` };
  }
  const model = s.models[provider];
  const { system, user } = buildPrompt({
    platform,
    postText,
    tone: s.tone,
    language: s.language,
    niche: s.niche,
    customInstr: s.customInstr,
    promo: s.promo,
  });
  try {
    const text = cleanReply(await generate({ provider, apiKey, model, system, user }));
    await bumpStat("generated");
    return { ok: true, text: text.trim() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---- keyboard shortcut → tell the active tab to generate ------------------
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "generate-reply") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "trigger-generate" }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "generate") {
    handleGenerate({ postText: msg.postText, platform: msg.platform }).then(sendResponse);
    return true; // keep the channel open for the async response
  }
  if (msg?.type === "test") {
    const sample =
      msg.sample ||
      "Just shipped a tiny open-source tool after months of doubt. Nervous but excited to share it.";
    handleGenerate({ postText: sample, platform: "threads" }).then(sendResponse);
    return true;
  }
  if (msg?.type === "stat") {
    bumpStat(msg.event === "inserted" ? "inserted" : "generated").then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "getStats") {
    getStats().then(sendResponse);
    return true;
  }
  if (msg?.type === "openOptions") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
});
