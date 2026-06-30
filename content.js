// Threadmate content script — AI-reply panel + template library for Threads & X.
// Human-in-the-loop: it only DRAFTS into the composer; you review and press Post.
//
// Capturing which post you're replying to is unreliable on Threads/X (obfuscated,
// changing markup), so the AI panel pre-fills a best-effort guess into an EDITABLE
// box — you can fix it or paste the target text before generating.

(() => {
  const host = location.hostname;
  const PLATFORM = host.includes("threads")
    ? "threads"
    : host.includes("x.com") || host.includes("twitter.com")
    ? "x"
    : null;
  if (!PLATFORM) return;
  try {
    console.log("[Threadmate] content script loaded — v" + chrome.runtime.getManifest().version);
  } catch (e) {}

  let settings = {};
  let lastEditor = null; // remember the composer we should insert into
  // data-insight state (features 1–4, all local, no backend)
  let collected = [];
  const collectedIds = new Set();
  let collecting = false;
  let collectTimer = null;
  let hlObserver = null;
  let hlKeywords = [];
  // auto-engagement engine (feature 7, no anti-detection — deliberately)
  let engineRunning = false;
  let engineTimer = null;
  let engineCfg = null;
  let engineFeedUrl = null; // the feed (河道) we started on, to return to after threads
  const engineProcessed = new Set();
  const engineLog = [];
  const loadSettings = async () => {
    settings = await chrome.storage.local.get(null);
  };

  // ---- editor + post extraction ------------------------------------------
  function isVisible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // Composer selector — richer form fused from Threads Insight: prefer the
  // role=textbox / Lexical editor before the bare contenteditable.
  const COMPOSER_SEL =
    '[role="textbox"][contenteditable="true"], div[contenteditable="true"][data-lexical-editor], div[contenteditable="true"]';

  function getActiveEditor() {
    if (PLATFORM === "x") {
      return document.querySelector('[data-testid="tweetTextarea_0"]');
    }
    const dialog = [...document.querySelectorAll('[role="dialog"]')].pop();
    const scope = dialog || document;
    const editors = [...scope.querySelectorAll(COMPOSER_SEL)].filter(isVisible);
    const focused = editors.find(
      (e) => e === document.activeElement || e.contains(document.activeElement)
    );
    return focused || editors[0] || null;
  }

  // Extract a Threads post's text from its container element.
  // Verified against live threads.com DOM (2026-06): current Threads has NO
  // <article>/[role="article"]/[data-testid] (older reference extensions assumed
  // those — they're gone). Posts are div[data-pressable-container="true"], each
  // with one time[datetime]. Exclude time/buttons/author-links, join body spans.
  function extractPostText(container) {
    const isMeta = (t) =>
      !t ||
      t.length < 2 ||
      /^@?[\w.]+$/.test(t) || // bare @handle / username
      /^\d[\d,.\s]*[KkMm萬]?$/.test(t) || // counts
      /^\d{4}[-/]\d/.test(t) || // dates
      /^(翻譯|Translate|See translation|Reply|Repost|Share|More|Like|Following|Edited|Pinned|Verified)$/i.test(t);
    const spans = [...container.querySelectorAll('span[dir="auto"]')]
      .filter(
        (s) =>
          !s.closest("time") &&
          !s.closest('[role="button"]') &&
          !s.closest('a[href^="/@"]') && // author name / mention links
          !s.closest('div[contenteditable="true"]')
      )
      .map((s) => s.innerText.trim())
      .filter((t) => !isMeta(t));
    const body = spans.filter((t) => t.length >= 12);
    const text = body.length ? body.join("\n") : spans.sort((a, b) => b.length - a.length)[0] || "";
    return text.replace(/\s*(翻譯|Translate|See translation)\s*$/i, "").trim();
  }

  // Fallback when div[data-pressable-container] isn't matched: walk up from a
  // timestamp until the subtree would contain >1 post — that boundary is the
  // single-post container (scanning higher grabs unrelated posts).
  function postContainerFromTime(timeEl) {
    let node = timeEl;
    let container = timeEl.parentElement || timeEl;
    while (node.parentElement) {
      node = node.parentElement;
      if (node.querySelectorAll("time[datetime]").length === 1) container = node;
      else break;
    }
    return container;
  }

  // Best-effort guess of the post being replied to. Used only as a pre-fill —
  // the user can correct it in the panel.
  function guessPostText(editor) {
    if (PLATFORM === "x") {
      const dialog = [...document.querySelectorAll('[role="dialog"]')].pop();
      const scope = dialog || document;
      const tt = scope.querySelector('[data-testid="tweetText"]');
      return tt ? tt.innerText.trim() : "";
    }
    // Threads — primary anchor: the post container (fused from Threads Insight).
    const dialog = editor && editor.closest('[role="dialog"]');
    let container = editor && editor.closest('div[data-pressable-container="true"]');
    if (!container && dialog) container = dialog.querySelector('div[data-pressable-container="true"]');
    // Fallback: nearest single post via timestamp anchor.
    if (!container) {
      let scope = editor;
      while (scope && scope.parentElement && scope.querySelectorAll("time[datetime]").length === 0) {
        scope = scope.parentElement;
      }
      const times = scope ? scope.querySelectorAll("time[datetime]") : [];
      if (times.length === 1) container = postContainerFromTime(times[0]);
    }
    return container ? extractPostText(container) : "";
  }

  function insertIntoEditor(text) {
    let editor = lastEditor && document.contains(lastEditor) ? lastEditor : getActiveEditor();
    if (!editor) {
      toast("找不到回覆框，請先點開回覆。", "error");
      return false;
    }
    fillEditor(editor, text);
    chrome.runtime.sendMessage({ type: "stat", event: "inserted" }).catch(() => {});
    return true;
  }

  // Fill a Lexical (Threads) / DraftJS (X) composer reliably. beforeinput+insertText
  // is the canonical Lexical listener (verified via Threads Insight) and fixes the
  // execCommand truncation bug; paste + execCommand are layered fallbacks, run only
  // if beforeinput didn't take. Shared by manual reply AND auto-comment.
  function fillEditor(editor, text) {
    if (!editor) return false;
    editor.focus();
    // Put the caret IN the editor: select-all to replace if it has content, else a
    // collapsed caret at the end — execCommand insertText needs a caret inside it.
    try {
      const sel = window.getSelection();
      if ((editor.textContent || "").length) {
        sel.selectAllChildren(editor);
      } else {
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch (e) {}
    const planted = () =>
      (editor.textContent || "").replace(/\s+/g, "").length >=
      Math.min(3, text.replace(/\s+/g, "").length);
    // execCommand insertText fires TRUSTED beforeinput+input events, so Lexical
    // (Threads) / DraftJS (X) fully commit their state AND enable the submit/發佈
    // button. (The earlier "truncation" was the API max_tokens cap, not this.)
    try {
      document.execCommand("insertText", false, text);
    } catch (e) {}
    // Fallbacks only if execCommand didn't take.
    setTimeout(() => {
      if (planted()) return;
      try {
        editor.dispatchEvent(
          new InputEvent("beforeinput", { inputType: "insertText", data: text, bubbles: true, cancelable: true })
        );
      } catch (e) {}
      setTimeout(() => {
        if (planted()) return;
        try {
          const dt = new DataTransfer();
          dt.setData("text/plain", text);
          editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
        } catch (e) {
          editor.textContent = text;
          editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
        }
      }, 60);
    }, 60);
    return true;
  }

  // ---- styles -------------------------------------------------------------
  function injectStyles() {
    if (document.getElementById("threadmate-style")) return;
    const css = `
      #threadmate-wrap{position:fixed;right:18px;bottom:18px;z-index:2147483646;
        display:flex;align-items:flex-end;gap:6px}
      #threadmate-fab,#threadmate-caret,#threadmate-data-btn{font:600 13px/1 -apple-system,system-ui,sans-serif;
        color:#fff;cursor:pointer;background:#1d9bf0;border:none;
        box-shadow:0 4px 14px rgba(0,0,0,.25);transition:transform .1s,opacity .2s;opacity:.92}
      #threadmate-fab{border-radius:999px;padding:10px 14px}
      #threadmate-caret,#threadmate-data-btn{border-radius:999px;width:34px;height:34px;font-size:14px}
      #threadmate-fab:hover,#threadmate-caret:hover,#threadmate-data-btn:hover{transform:translateY(-1px);opacity:1}
      #threadmate-fab:disabled{opacity:.6;cursor:default}
      .tm-pop{position:absolute;right:0;bottom:48px;width:300px;max-height:60vh;overflow:auto;
        background:#fff;color:#1a1a1a;border:1px solid #e4e7ec;border-radius:12px;
        box-shadow:0 8px 24px rgba(0,0,0,.18);padding:10px;
        font:13px/1.45 -apple-system,system-ui,sans-serif}
      .tm-pop .tm-h{font-size:12px;color:#475467;font-weight:700;margin:0 0 6px}
      .tm-pop textarea{width:100%;box-sizing:border-box;border:1px solid #e4e7ec;border-radius:8px;
        padding:8px;font:13px/1.4 inherit;resize:vertical;min-height:90px}
      .tm-pop .tm-go{width:100%;margin-top:8px;border:none;background:#1d9bf0;color:#fff;
        border-radius:8px;padding:9px;font:600 13px/1 inherit;cursor:pointer}
      .tm-pop .tm-go:disabled{opacity:.6;cursor:default}
      .tm-pop .tm-tip{font-size:11px;color:#98a2b3;margin:6px 0 0}
      .tm-pop .tm-item{display:block;width:100%;text-align:left;border:none;background:none;
        padding:8px;border-radius:8px;cursor:pointer;color:#1a1a1a;font:inherit}
      .tm-pop .tm-item:hover{background:#f2f4f7}
      .tm-pop .tm-empty{color:#98a2b3;padding:8px}
      .tm-pop .tm-manage{display:block;width:100%;text-align:center;border-top:1px solid #eee;
        margin-top:4px;padding:8px;background:none;color:#1d9bf0;cursor:pointer;font:600 12px/1 inherit}
      #threadmate-toast{position:fixed;right:18px;bottom:64px;z-index:2147483647;max-width:300px;
        font:500 13px/1.4 -apple-system,system-ui,sans-serif;color:#fff;background:#222;
        border-radius:10px;padding:10px 12px;box-shadow:0 4px 14px rgba(0,0,0,.3);
        opacity:0;transition:opacity .2s;pointer-events:none}
      #threadmate-toast[data-kind="ok"]{background:#1a7f37}
      #threadmate-toast[data-kind="error"]{background:#b42318}
      .tm-pop .tm-drow{display:flex;gap:6px;align-items:center;margin:6px 0}
      .tm-pop .tm-drow label{font-size:12px;color:#475467}
      .tm-pop .tm-drow button{flex:1;border:1px solid #e4e7ec;background:#fff;border-radius:8px;
        padding:7px;font:600 12px/1 inherit;cursor:pointer}
      .tm-pop .tm-drow button.tm-go{background:#1d9bf0;color:#fff;border:none}
      .tm-pop .tm-hr{border:none;border-top:1px solid #eee;margin:8px 0}
      #threadmate-data textarea{width:100%;box-sizing:border-box;border:1px solid #e4e7ec;border-radius:8px;
        padding:8px;font:13px/1.4 inherit;resize:vertical;min-height:70px}
      .tm-hl{outline:2px solid #ffd400 !important;outline-offset:2px;border-radius:8px;
        background:rgba(255,212,0,.08) !important}
      #threadmate-auto-btn{font:600 14px/1 -apple-system,system-ui,sans-serif;color:#fff;cursor:pointer;
        background:#1d9bf0;border:none;border-radius:999px;width:34px;height:34px;opacity:.92;
        box-shadow:0 4px 14px rgba(0,0,0,.25);transition:transform .1s,opacity .2s}
      #threadmate-auto-btn:hover{transform:translateY(-1px);opacity:1}
      #threadmate-auto-btn[data-on="1"]{background:#b42318}
      .tm-pop .tm-warn{background:#fff4f2;border:1px solid #f3c2bd;color:#9a2a1c;border-radius:8px;
        padding:8px;font-size:11px;line-height:1.4;margin:0 0 8px}
      .tm-pop .tm-ck{display:flex;align-items:center;gap:7px;font-size:13px;margin:5px 0}
      .tm-pop .tm-ck input{width:auto}
      .tm-log{margin-top:8px;max-height:120px;overflow:auto;font:11px/1.5 ui-monospace,monospace;
        background:#0b0b0c;color:#d6f5d6;border-radius:8px;padding:8px}
      .tm-log div[data-bad="1"]{color:#ffb4ab}
      /* dark-mode proofing: Threads' dark theme overrides text to white — force readable colors */
      .tm-pop{color-scheme:light}
      .tm-pop .tm-h{color:#475467 !important}
      .tm-pop .tm-tip{color:#98a2b3 !important}
      .tm-pop .tm-drow label{color:#475467 !important}
      .tm-pop .tm-ck{color:#1a1a1a !important}
      .tm-pop .tm-drow button{color:#1a1a1a !important}
      .tm-pop .tm-go,.tm-pop .tm-drow button.tm-go{color:#fff !important}
      .tm-pop input,.tm-pop textarea{color:#1a1a1a !important;background:#fff !important}
      .tm-pop .tm-item{color:#1a1a1a !important}
      .tm-pop .tm-manage{color:#1d9bf0 !important}
      #tm-hover-menu{position:fixed;z-index:2147483647;min-width:150px;background:#fff;color:#1a1a1a;
        border:1px solid #e4e7ec;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:5px;
        font:13px/1.4 -apple-system,system-ui,sans-serif;color-scheme:light}
      #tm-hover-menu .tm-hm-item{display:block;width:100%;text-align:left;border:none;background:none;
        padding:7px 9px;border-radius:7px;cursor:pointer;color:#1a1a1a !important;font:inherit;white-space:nowrap}
      #tm-hover-menu .tm-hm-item:hover{background:#f2f4f7}
      #tm-hover-menu .tm-hm-sep{font-size:11px;color:#98a2b3 !important;padding:5px 9px 2px}
      #tm-review{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483647;
        width:min(420px,92vw);background:#fff;color:#1a1a1a;border:1px solid #e4e7ec;border-radius:14px;
        box-shadow:0 10px 30px rgba(0,0,0,.28);padding:12px 14px;color-scheme:light;
        font:13px/1.5 -apple-system,system-ui,sans-serif}
      #tm-review .tm-rv-head{font-weight:700;font-size:13px;margin-bottom:6px;color:#1a1a1a !important}
      #tm-review .tm-rv-text{background:#f7f8fa;border:1px solid #eef0f3;border-radius:8px;padding:8px 10px;
        max-height:120px;overflow:auto;white-space:pre-wrap;margin-bottom:10px;color:#1a1a1a !important}
      #tm-review .tm-rv-btns{display:flex;gap:8px}
      #tm-review .tm-rv-btns button{flex:1;border:1px solid #e4e7ec;background:#fff;color:#1a1a1a !important;
        border-radius:9px;padding:9px;font:600 13px/1 inherit;cursor:pointer}
      #tm-review .tm-rv-btns button.tm-rv-send{background:#1a7f37;color:#fff !important;border:none}
      #tm-review .tm-rv-btns button:hover{filter:brightness(.97)}
    `;
    const style = document.createElement("style");
    style.id = "threadmate-style";
    style.textContent = css;
    document.documentElement.appendChild(style);
  }

  // ---- floating UI --------------------------------------------------------
  function ensureButton() {
    if (document.getElementById("threadmate-wrap")) return;
    const wrap = document.createElement("div");
    wrap.id = "threadmate-wrap";

    const genPanel = document.createElement("div");
    genPanel.id = "threadmate-gen";
    genPanel.className = "tm-pop";
    genPanel.hidden = true;
    genPanel.innerHTML = `
      <p class="tm-h">要回覆的貼文內容（自動抓取，可修改或直接貼上）</p>
      <textarea id="tm-src" placeholder="貼上你要回覆的貼文…"></textarea>
      <button class="tm-go" id="tm-go">✨ 生成回覆</button>
      <p class="tm-tip">生成後會插入回覆框，請檢查後再用平台按鈕送出。Ctrl/⌘+Enter 也可生成。</p>
      <div id="tm-result" hidden>
        <p class="tm-h" style="margin-top:8px">AI 草稿（完整內容，可複製）</p>
        <textarea id="tm-result-text" readonly></textarea>
        <div class="tm-drow"><button id="tm-copy">📋 複製</button><button id="tm-reinsert">↩︎ 再次插入</button></div>
      </div>`;

    const tplPanel = document.createElement("div");
    tplPanel.id = "threadmate-panel";
    tplPanel.className = "tm-pop";
    tplPanel.hidden = true;

    const fab = document.createElement("button");
    fab.id = "threadmate-fab";
    fab.type = "button";
    fab.textContent = "✨ AI 回覆";
    fab.title = "用 AI 草擬回覆";
    fab.addEventListener("click", () => toggleGen());

    const caret = document.createElement("button");
    caret.id = "threadmate-caret";
    caret.type = "button";
    caret.textContent = "📋";
    caret.title = "範本庫";
    caret.addEventListener("click", () => toggleTemplates());

    const dataPanel = document.createElement("div");
    dataPanel.id = "threadmate-data";
    dataPanel.className = "tm-pop";
    dataPanel.hidden = true;

    const dataBtn = document.createElement("button");
    dataBtn.id = "threadmate-data-btn";
    dataBtn.type = "button";
    dataBtn.textContent = "📊";
    dataBtn.title = "數據洞察（採集 / CSV / AI 分析 / 關鍵字海巡）";
    dataBtn.addEventListener("click", () => toggleData());

    const autoPanel = document.createElement("div");
    autoPanel.id = "threadmate-auto";
    autoPanel.className = "tm-pop";
    autoPanel.hidden = true;

    const autoBtn = document.createElement("button");
    autoBtn.id = "threadmate-auto-btn";
    autoBtn.type = "button";
    autoBtn.textContent = "⚡";
    autoBtn.title = "自動互動（無人值守 · 風險自負）";
    autoBtn.addEventListener("click", () => toggleAuto());

    wrap.append(genPanel, tplPanel, dataPanel, autoPanel, fab, caret, dataBtn, autoBtn);
    document.body.appendChild(wrap);

    genPanel.querySelector("#tm-go").addEventListener("click", runGenerate);
    genPanel.querySelector("#tm-src").addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") runGenerate();
    });
    genPanel.querySelector("#tm-copy").addEventListener("click", () => {
      const t = genPanel.querySelector("#tm-result-text").value;
      navigator.clipboard
        .writeText(t)
        .then(() => toast("已複製完整草稿", "ok"))
        .catch(() => toast("複製失敗", "error"));
    });
    genPanel.querySelector("#tm-reinsert").addEventListener("click", () => {
      insertIntoEditor(genPanel.querySelector("#tm-result-text").value);
      toast("已再次插入", "ok");
    });

    document.addEventListener("click", (e) => {
      if (!wrap.contains(e.target)) hidePanels();
    });
  }

  function hidePanels() {
    ["threadmate-gen", "threadmate-panel", "threadmate-data", "threadmate-auto"].forEach((id) => {
      // keep the engine panel (and its live log) open while it's running — the
      // engine's own programmatic clicks would otherwise trigger this and hide it.
      if (id === "threadmate-auto" && engineRunning) return;
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    });
  }

  function toggleGen() {
    const gen = document.getElementById("threadmate-gen");
    const wasHidden = gen.hidden;
    hidePanels();
    if (wasHidden) {
      lastEditor = getActiveEditor();
      if (!lastEditor) {
        toast("找不到回覆框，請先點開一則貼文的回覆。", "error");
        return;
      }
      gen.querySelector("#tm-src").value = guessPostText(lastEditor);
      gen.hidden = false;
      gen.querySelector("#tm-src").focus();
    }
  }

  let busy = false;
  async function runGenerate() {
    if (busy) return;
    const gen = document.getElementById("threadmate-gen");
    const postText = gen.querySelector("#tm-src").value.trim();
    if (!postText) {
      toast("請先填入要回覆的貼文內容。", "error");
      return;
    }
    busy = true;
    const go = gen.querySelector("#tm-go");
    go.textContent = "⏳ 生成中…";
    go.disabled = true;
    try {
      const res = await chrome.runtime.sendMessage({ type: "generate", postText, platform: PLATFORM });
      if (res && res.ok) {
        gen.querySelector("#tm-result-text").value = res.text;
        gen.querySelector("#tm-result").hidden = false;
        insertIntoEditor(res.text);
        toast("已生成。完整草稿在面板裡，可複製或再次插入 ✅", "ok");
      } else {
        toast("生成失敗：" + (res?.error || "未知錯誤"), "error");
      }
    } catch (e) {
      toast("生成失敗：" + e.message, "error");
    } finally {
      busy = false;
      go.textContent = "✨ 生成回覆";
      go.disabled = false;
    }
  }

  // ---- templates ----------------------------------------------------------
  function renderTemplates() {
    const panel = document.getElementById("threadmate-panel");
    if (!panel) return;
    const templates = settings.templates || [];
    panel.innerHTML = '<p class="tm-h">📋 範本（點一下插入，不花 AI 費用）</p>';
    if (!templates.length) {
      const e = document.createElement("div");
      e.className = "tm-empty";
      e.textContent = "尚無範本，到設定新增。";
      panel.appendChild(e);
    } else {
      templates.forEach((t) => {
        const b = document.createElement("button");
        b.className = "tm-item";
        b.textContent = t.label || t.text.slice(0, 30);
        b.title = t.text;
        b.addEventListener("click", () => {
          lastEditor = getActiveEditor();
          if (insertIntoEditor(t.text)) {
            panel.hidden = true;
            toast("已插入範本，請檢查後再送出 ✅", "ok");
          }
        });
        panel.appendChild(b);
      });
    }
    const manage = document.createElement("button");
    manage.className = "tm-manage";
    manage.textContent = "＋ 管理範本";
    manage.addEventListener("click", () =>
      chrome.runtime.sendMessage({ type: "openOptions" }).catch(() => {})
    );
    panel.appendChild(manage);
  }

  function toggleTemplates() {
    const tpl = document.getElementById("threadmate-panel");
    const wasHidden = tpl.hidden;
    hidePanels();
    if (wasHidden) {
      renderTemplates();
      tpl.hidden = false;
    }
  }

  // ---- toast --------------------------------------------------------------
  function toast(msg, kind = "info") {
    let t = document.getElementById("threadmate-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "threadmate-toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.dataset.kind = kind;
    t.style.opacity = "1";
    clearTimeout(t._timer);
    t._timer = setTimeout(() => (t.style.opacity = "0"), 4500);
  }

  // ---- experimental: default to the chronological "Following" feed --------
  function maybeSwitchFollowing() {
    if (PLATFORM !== "threads" || !settings.followingFeed) return;
    if (location.pathname !== "/") return;
    let tries = 0;
    const iv = setInterval(() => {
      if (++tries > 8) return clearInterval(iv);
      const cand = [
        ...document.querySelectorAll('[role="tab"],[role="menuitem"],[role="link"] [dir="auto"]'),
      ].find((el) => el.textContent.trim() === "Following");
      if (cand) {
        cand.click();
        clearInterval(iv);
      }
    }, 800);
  }

  // ---- keyboard shortcut (from background commands) -----------------------
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "trigger-generate") toggleGen();
  });

  // ---- data insight: collect / CSV / AI prompt / keyword patrol ----------
  // (features fused from Threads Insight #6 — reimplemented; all local, BYOK)
  function normNum(raw) {
    if (!raw) return 0;
    const m = raw.match(/[\d,.]+\s*[KkMm萬]?/);
    if (!m) return 0;
    let s = m[0].replace(/,/g, "").trim();
    let mult = 1;
    if (/萬$/.test(s)) { mult = 10000; s = s.replace("萬", ""); }
    else if (/[Kk]$/.test(s)) { mult = 1000; s = s.replace(/[Kk]/, ""); }
    else if (/[Mm]$/.test(s)) { mult = 1000000; s = s.replace(/[Mm]/, ""); }
    return Math.round((parseFloat(s) || 0) * mult);
  }

  // Verified live (2026-06): each post's like/reply/repost/share count is the
  // innerText of the [role=button] whose [aria-label] is exactly 讚/回覆/轉發/分享.
  function parseCount(container, label) {
    const el = [...container.querySelectorAll("[aria-label]")].find(
      (b) => (b.getAttribute("aria-label") || "") === label
    );
    if (!el) return 0;
    const btn = el.closest('[role="button"]') || el.closest("a") || el;
    return normNum((btn.innerText || "").trim());
  }

  function scrapeVisible() {
    let added = 0;
    document.querySelectorAll('div[data-pressable-container="true"]').forEach((c) => {
      const link = [...c.querySelectorAll('a[href*="/post/"]')].map((a) => a.getAttribute("href"))[0];
      if (!link) return;
      const id = (link.split("/post/")[1] || "").split(/[?#]/)[0];
      if (!id || collectedIds.has(id)) return;
      const content = extractPostText(c);
      if (!content) return;
      const author = (link.match(/^\/@([^/]+)/) || [])[1] || "";
      collectedIds.add(id);
      collected.push({
        id,
        author,
        url: "https://www.threads.com" + link,
        content,
        likes: parseCount(c, "讚"),
        replies: parseCount(c, "回覆"),
        reposts: parseCount(c, "轉發"),
        shares: parseCount(c, "分享"),
      });
      added++;
    });
    return added;
  }

  function updateDataStatus() {
    const el = document.getElementById("tm-data-status");
    if (el) el.textContent = `已採集 ${collected.length} 篇` + (collecting ? " · 採集中…" : "");
  }

  function startCollect(target) {
    collecting = true;
    updateDataStatus();
    const tick = () => {
      if (!collecting) return;
      scrapeVisible();
      updateDataStatus();
      if (collected.length >= target) return stopCollect();
      const cs = document.querySelectorAll('div[data-pressable-container="true"]');
      if (cs.length) cs[cs.length - 1].scrollIntoView({ behavior: "smooth", block: "center" });
      else window.scrollBy(0, 800);
      collectTimer = setTimeout(tick, 1500);
    };
    tick();
  }

  function stopCollect() {
    collecting = false;
    if (collectTimer) { clearTimeout(collectTimer); collectTimer = null; }
    updateDataStatus();
  }

  function downloadCSV() {
    if (!collected.length) return toast("還沒有採集到資料", "error");
    const q = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""').replace(/[\r\n]+/g, " ") + '"';
    let csv = '﻿"作者","連結","內文","讚","留言","轉發","分享"\n';
    collected.forEach((p) => {
      csv += [q(p.author), q(p.url), q(p.content), p.likes, p.replies, p.reposts, p.shares].join(",") + "\n";
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    a.download = "threads_data_" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast(`已下載 ${collected.length} 篇 CSV`, "ok");
  }

  function copyAIPrompt() {
    if (!collected.length) return toast("還沒有採集到資料", "error");
    const promo = (settings.promo || "").trim();
    const rows = collected
      .map(
        (p, i) =>
          `[貼文${i + 1}] @${p.author}\n連結:${p.url}\n讚${p.likes}|留言${p.replies}|轉發${p.reposts}|分享${p.shares}\n內文:\n${p.content}\n---`
      )
      .join("\n\n");
    const prompt =
      `你是一位有 10 年經驗的社群媒體行銷總監與爆文分析師。以下是從 Threads 採集的 ${collected.length} 篇貼文數據。\n\n` +
      `請分析:\n1. 這些貼文共同的「爆紅鉤子」與開頭手法\n2. 主題分類，以及哪一類互動最高\n3. 貼文結構／長度／排版的規律\n4. 可立即複製的發文模式（條列）\n` +
      (promo ? `5. 針對以下產品，給 3 個能切入這些熱門話題的貼文或回覆點子:「${promo}」\n` : "") +
      `\n注意:數字若因網頁動態載入而重複(如 '123123' 視為 '123')請自行修正，極端離群值忽略。\n\n數據:\n${rows}`;
    navigator.clipboard
      .writeText(prompt)
      .then(() => toast(`已複製 AI 分析 prompt（${collected.length} 篇），貼到 ChatGPT/Claude 即可`, "ok"))
      .catch(() => toast("複製失敗", "error"));
  }

  function scanHighlight(root) {
    const list = [];
    if (root.matches && root.matches('div[data-pressable-container="true"]')) list.push(root);
    if (root.querySelectorAll) list.push(...root.querySelectorAll('div[data-pressable-container="true"]'));
    list.forEach((c) => {
      const txt = c.innerText || "";
      if (hlKeywords.some((k) => k && txt.includes(k))) c.classList.add("tm-hl");
    });
  }

  function startHighlight(keywords) {
    hlKeywords = keywords;
    scanHighlight(document);
    if (hlObserver) hlObserver.disconnect();
    hlObserver = new MutationObserver((muts) =>
      muts.forEach((m) => m.addedNodes.forEach((n) => n.nodeType === 1 && scanHighlight(n)))
    );
    hlObserver.observe(document.body, { childList: true, subtree: true });
  }

  function stopHighlight() {
    if (hlObserver) { hlObserver.disconnect(); hlObserver = null; }
    document.querySelectorAll(".tm-hl").forEach((e) => e.classList.remove("tm-hl"));
  }

  function toggleData() {
    const data = document.getElementById("threadmate-data");
    const wasHidden = data.hidden;
    hidePanels();
    if (wasHidden) {
      renderData();
      updateDataStatus();
      data.hidden = false;
    }
  }

  function renderData() {
    const d = document.getElementById("threadmate-data");
    if (d.dataset.built) return;
    d.dataset.built = "1";
    d.innerHTML = `
      <p class="tm-h">📊 數據洞察（全部存本機）</p>
      <div class="tm-drow"><label>目標篇數</label><input id="tm-target" type="number" value="50" min="5" max="500" style="width:64px"></div>
      <div class="tm-drow"><button class="tm-go" id="tm-collect">▶ 開始採集</button><button id="tm-collect-stop">停止</button></div>
      <p class="tm-tip" id="tm-data-status">已採集 0 篇</p>
      <div class="tm-drow"><button id="tm-csv">⬇️ CSV</button><button id="tm-aiprompt">🤖 複製 AI 分析</button></div>
      <hr class="tm-hr">
      <p class="tm-h">🖍️ 關鍵字海巡（一行一個）</p>
      <textarea id="tm-hl-kw" placeholder="找球友&#10;揪羽球&#10;三缺一"></textarea>
      <div class="tm-drow"><button id="tm-hl-start">開始標亮</button><button id="tm-hl-stop">停止</button></div>`;
    d.querySelector("#tm-collect").onclick = () =>
      startCollect(Math.max(5, parseInt(d.querySelector("#tm-target").value, 10) || 50));
    d.querySelector("#tm-collect-stop").onclick = stopCollect;
    d.querySelector("#tm-csv").onclick = downloadCSV;
    d.querySelector("#tm-aiprompt").onclick = copyAIPrompt;
    d.querySelector("#tm-hl-start").onclick = () => {
      const kw = d.querySelector("#tm-hl-kw").value.split("\n").map((s) => s.trim()).filter(Boolean);
      if (!kw.length) return toast("請輸入至少一個關鍵字", "error");
      startHighlight(kw);
      toast("已標亮含關鍵字的貼文（往下捲新貼文也會標）", "ok");
    };
    d.querySelector("#tm-hl-stop").onclick = () => {
      stopHighlight();
      toast("已停止標亮", "ok");
    };
  }

  // ---- auto-engagement engine (feature 7) --------------------------------
  // NO anti-detection by design. Conservative caps + random pacing + kill switch
  // + local log. Comment reuses the Threads reply→fill→submit flow verified from
  // Threads Insight (#6). Pacing exists to brake the user, not to evade detection.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => Math.floor(a + Math.random() * (b - a));

  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }
  async function getAutoStats() {
    const { autoStats } = await chrome.storage.local.get("autoStats");
    if (!autoStats || autoStats.date !== todayStr()) return { date: todayStr(), like: 0, follow: 0, comment: 0 };
    return autoStats;
  }
  async function bumpAuto(field) {
    const s = await getAutoStats();
    s[field] = (s[field] || 0) + 1;
    await chrome.storage.local.set({ autoStats: s });
    updateAutoStatus(s);
    return s;
  }

  function logAuto(msg, bad) {
    engineLog.unshift({ ts: new Date().toTimeString().slice(0, 8), msg, bad: !!bad });
    if (engineLog.length > 80) engineLog.pop();
    const box = document.getElementById("tm-a-log");
    if (box) box.innerHTML = engineLog.map((e) => `<div data-bad="${e.bad ? 1 : 0}">[${e.ts}] ${e.msg}</div>`).join("");
  }

  function postIdOf(c) {
    const link = [...c.querySelectorAll('a[href*="/post/"]')].map((a) => a.getAttribute("href"))[0];
    return link ? (link.split("/post/")[1] || "").split(/[?#]/)[0] : "";
  }

  function clickByAria(container, label) {
    const el = [...container.querySelectorAll("[aria-label]")].find(
      (b) => (b.getAttribute("aria-label") || "") === label
    );
    const btn = el && el.closest('[role="button"]');
    if (!btn) return false;
    btn.click();
    return true;
  }

  function waitFor(fn, interval, tries) {
    return new Promise((res) => {
      let n = 0;
      const t = setInterval(() => {
        let v = null;
        try { v = fn(); } catch (e) {}
        if (v) { clearInterval(t); res(v); }
        else if (++n >= tries) { clearInterval(t); res(null); }
      }, interval);
    });
  }

  async function autoComment(container, cfg) {
    const startUrl = location.href;
    // Grab the post text NOW — once we navigate into the post, this feed element
    // becomes detached/stale and extraction would return nothing.
    const postText = extractPostText(container);

    // The reply button "jumps into" the post when you're NOT on its page, but pops a
    // redundant floating window when you ARE already on it. So only click it to
    // navigate in from the feed; if we're already on a post page, the inline composer
    // is already present — use it directly (don't click, per the user's finding).
    if (!location.pathname.includes("/post/")) {
      const svg = container.querySelector('svg[aria-label*="回覆"], svg[aria-label*="Reply"]');
      const btn = svg && svg.closest('[role="button"]');
      if (!btn) return logAuto("留言：找不到回覆鈕", true);
      btn.click();
      await waitFor(() => location.pathname.includes("/post/") || null, 150, 20);
      await sleep(rand(600, 1000));
    }

    const input = await waitFor(
      () => {
        const c = document.querySelector(
          '[role="textbox"][contenteditable="true"], div[contenteditable="true"][data-lexical-editor], div[contenteditable="true"]'
        );
        return c && c.offsetParent !== null ? c : null;
      },
      150,
      25
    );
    if (!input) { logAuto("留言：回覆框沒出現", true); await returnToFeed(startUrl); return; }

    let replyText;
    if (cfg.commentText) {
      replyText = cfg.commentText;
    } else {
      if (!postText) { logAuto("留言：抓不到貼文內容，跳過", true); clearAndClose(input); await returnToFeed(startUrl); return; }
      const res = await chrome.runtime.sendMessage({ type: "generate", postText, platform: "threads" });
      if (!res || !res.ok) { logAuto("留言：AI 失敗 " + ((res && res.error) || ""), true); clearAndClose(input); await returnToFeed(startUrl); return; }
      replyText = res.text;
    }
    fillEditor(input, replyText);
    await sleep(rand(1000, 2000));
    // Capture the send (↑) button NOW — while the composer is focused and it's shown.
    // Clicking the review bar later blurs the composer and Threads hides the button,
    // so we keep this reference and click it directly on approval.
    let submitBtn = findSubmitButton(input);

    let decision = "send";
    if (!cfg.autoSend) {
      logAuto("已帶入草稿，等你審核…");
      decision = await showReview(replyText);
    }
    if (decision === "send") {
      if (!submitBtn || !document.contains(submitBtn)) {
        input.focus();
        await sleep(rand(350, 650));
        submitBtn = await waitFor(() => findSubmitButton(input), 150, 25);
      }
      if (submitBtn) {
        submitBtn.click();
        await bumpAuto("comment");
        logAuto("✅ 已送出留言");
        await sleep(rand(700, 1400));
      } else {
        logAuto("送出鈕找不到，略過此篇", true);
        clearAndClose(input);
      }
    } else {
      logAuto("⏭️ 已跳過此篇");
      clearAndClose(input);
    }
    await returnToFeed(startUrl);
  }

  // If replying navigated us into the post's thread, return to the feed (河道).
  // history.back() is SPA client-side — it does NOT reload, so engine state survives.
  async function returnToFeed(startUrl) {
    if (location.href !== startUrl) {
      // navigated into the thread → go back to the feed (single back; verified reliable)
      logAuto("↩︎ 退回動態流");
      history.back();
      await waitFor(() => !location.pathname.includes("/post/") || null, 150, 16);
      await sleep(rand(700, 1300));
    } else if (document.querySelector('[role="dialog"], [aria-modal="true"]')) {
      // modal case (no navigation) → close it
      escDialog();
      await sleep(rand(400, 800));
    }
  }

  function findSubmitButton(input) {
    // The reply composer's send button is a div[role="button"] whose CHILD svg has
    // aria-label "回覆" (an ↑ icon) — no text/aria of its own. Match text OR aria OR
    // child-svg aria-label.
    const SUBMIT = ["發佈", "發布", "回覆", "傳送", "送出", "Post", "Send", "Reply", "Publish"];
    const isSubmit = (b) => {
      if (b.tagName === "BUTTON" && b.disabled) return false;
      if (b.getAttribute("aria-disabled") === "true") return false;
      const t = (b.innerText || "").trim();
      const al = (b.getAttribute("aria-label") || "").trim();
      const svg = b.querySelector("svg");
      const sal = (svg && svg.getAttribute("aria-label")) || "";
      return SUBMIT.includes(t) || SUBMIT.includes(al) || SUBMIT.includes(sal);
    };
    const modal = input.closest('[role="dialog"]') || input.closest('[aria-modal="true"]');
    if (modal) return [...modal.querySelectorAll('button, [role="button"]')].find(isSubmit) || null;
    // Thread page: walk UP from the composer to the nearest ancestor that holds a
    // submit button (the composer's OWN toolbar). This avoids other posts'/comments'
    // reply buttons and the top "new thread" composer's 發佈 button.
    const ir = input.getBoundingClientRect();
    let node = input;
    for (let i = 0; i < 12 && node.parentElement; i++) {
      node = node.parentElement;
      const btns = [...node.querySelectorAll('button, [role="button"]')].filter(isSubmit);
      if (btns.length) {
        btns.sort((a, b) => {
          const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          return Math.abs(ra.top - ir.top) + Math.abs(ra.left - ir.right) - (Math.abs(rb.top - ir.top) + Math.abs(rb.left - ir.right));
        });
        return btns[0];
      }
    }
    return null;
  }

  function clearAndClose(input) {
    // remove the draft so the close won't trigger a "discard?" prompt, then close
    try {
      input.focus();
      window.getSelection().selectAllChildren(input);
      document.execCommand("delete", false, null);
    } catch (e) {}
    escDialog();
  }

  function escDialog() {
    try {
      const dlg = document.querySelector('[role="dialog"], [aria-modal="true"]');
      if (dlg) {
        const x = [...dlg.querySelectorAll("[aria-label]")].find((b) =>
          /^(關閉|Close|取消|Cancel|捨棄|Discard)$/i.test((b.getAttribute("aria-label") || "").trim())
        );
        const btn = x && (x.closest('[role="button"]') || x);
        if (btn) return btn.click();
      }
      document.activeElement && document.activeElement.blur();
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
    } catch (e) {}
  }

  // ---- per-comment review bar (review mode) ------------------------------
  let reviewResolve = null;
  function ensureReviewBar() {
    let r = document.getElementById("tm-review");
    if (r) return r;
    r = document.createElement("div");
    r.id = "tm-review";
    r.hidden = true;
    r.innerHTML = `
      <div class="tm-rv-head">⚡ 審核這則 AI 留言（送出前可直接在回覆框修改）</div>
      <div id="tm-rv-text" class="tm-rv-text"></div>
      <div class="tm-rv-btns">
        <button id="tm-rv-send" class="tm-rv-send">✅ 送出並繼續</button>
        <button id="tm-rv-skip">⏭️ 跳過</button>
        <button id="tm-rv-stop">✋ 全停</button>
      </div>`;
    document.body.appendChild(r);
    r.querySelector("#tm-rv-send").onclick = () => resolveReview("send");
    r.querySelector("#tm-rv-skip").onclick = () => resolveReview("skip");
    r.querySelector("#tm-rv-stop").onclick = () => stopEngine(); // resolves pending review as skip
    return r;
  }
  function showReview(text) {
    return new Promise((resolve) => {
      reviewResolve = resolve;
      const r = ensureReviewBar();
      r.querySelector("#tm-rv-text").textContent = text;
      r.hidden = false;
    });
  }
  function resolveReview(decision) {
    const r = document.getElementById("tm-review");
    if (r) r.hidden = true;
    if (reviewResolve) {
      const f = reviewResolve;
      reviewResolve = null;
      f(decision);
    }
  }

  async function actOnPost(container, cfg, stats) {
    if (cfg.like && stats.like < cfg.cap.like) {
      if (clickByAria(container, "讚")) { stats = await bumpAuto("like"); logAuto("已按讚"); await sleep(rand(1500, 4000)); }
    }
    if (engineRunning && cfg.follow && stats.follow < cfg.cap.follow) {
      if (clickByAria(container, "追蹤")) { stats = await bumpAuto("follow"); logAuto("已追蹤"); await sleep(rand(1500, 4000)); }
    }
    if (engineRunning && cfg.comment && stats.comment < cfg.cap.comment) {
      await autoComment(container, cfg);
    }
  }

  function capsAllReached(cfg, s) {
    return (!cfg.like || s.like >= cfg.cap.like) && (!cfg.follow || s.follow >= cfg.cap.follow) && (!cfg.comment || s.comment >= cfg.cap.comment);
  }

  async function engineStep() {
    if (!engineRunning) return;
    const cfg = engineCfg;
    const stats = await getAutoStats();
    if (capsAllReached(cfg, stats)) { logAuto("已達每日上限，自動停止 ✅"); return stopEngine(); }
    const list = [...document.querySelectorAll('div[data-pressable-container="true"]')];
    const next = list.find((c) => {
      const id = postIdOf(c);
      if (!id || engineProcessed.has(id)) return false;
      if (cfg.keywords.length && !cfg.keywords.some((k) => (c.innerText || "").includes(k))) return false;
      return true;
    });
    if (!next) {
      // no unprocessed post in view → scroll down to load more
      window.scrollBy(0, 1200);
      engineTimer = setTimeout(engineStep, 2000);
      return;
    }
    engineProcessed.add(postIdOf(next));
    next.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(rand(500, 1200));
    try { await actOnPost(next, cfg, stats); } catch (e) { logAuto("動作出錯：" + e.message, true); }
    if (!engineRunning) return;
    engineTimer = setTimeout(engineStep, rand(cfg.delayMin, cfg.delayMax) * 1000);
  }

  function startEngine(cfg) {
    engineCfg = cfg;
    engineRunning = true;
    engineFeedUrl = location.href;
    const b = document.getElementById("threadmate-auto-btn");
    if (b) b.dataset.on = "1";
    logAuto(`▶ 開始（讚:${cfg.like ? "開" : "關"} 追:${cfg.follow ? "開" : "關"} 留:${cfg.comment ? "開" : "關"}）`);
    engineStep();
  }
  function stopEngine() {
    engineRunning = false;
    resolveReview("skip"); // unblock any pending review so autoComment can clean up
    if (engineTimer) { clearTimeout(engineTimer); engineTimer = null; }
    const b = document.getElementById("threadmate-auto-btn");
    if (b) b.dataset.on = "0";
    logAuto("⏹ 已全停");
    updateAutoStatus();
  }

  async function updateAutoStatus(stats) {
    const el = document.getElementById("tm-a-status");
    if (!el) return;
    const s = stats || (await getAutoStats());
    el.textContent = (engineRunning ? "運轉中…" : "未啟動") + ` · 今日 讚${s.like}/留${s.comment}/追${s.follow}`;
  }

  function toggleAuto() {
    const auto = document.getElementById("threadmate-auto");
    const wasHidden = auto.hidden;
    hidePanels();
    if (wasHidden) {
      renderAuto();
      updateAutoStatus();
      auto.hidden = false;
    }
  }

  function autoDefaults() {
    return {
      like: true, follow: false, comment: false, source: "ai", autoSend: false,
      keywords: "", capLike: 50, capFollow: 10, capComment: 8, delayMin: 30, delayMax: 90,
    };
  }

  function buildSourceOptions(selected) {
    let html = `<option value="ai"${selected === "ai" ? " selected" : ""}>AI 生成</option>`;
    (settings.templates || []).forEach((t, i) => {
      const v = "tpl:" + i;
      html += `<option value="${v}"${selected === v ? " selected" : ""}>範本：${esc(t.label || t.text.slice(0, 14))}</option>`;
    });
    return html;
  }

  function saveAuto7() {
    const d = document.getElementById("threadmate-auto");
    if (!d || !d.dataset.built) return;
    const a7 = {
      like: d.querySelector("#tm-a-like").checked,
      follow: d.querySelector("#tm-a-follow").checked,
      comment: d.querySelector("#tm-a-comment").checked,
      source: d.querySelector("#tm-a-source").value,
      autoSend: d.querySelector("#tm-a-autosend").checked,
      keywords: d.querySelector("#tm-a-kw").value,
      capLike: +d.querySelector("#tm-a-caplike").value || 50,
      capFollow: +d.querySelector("#tm-a-capfollow").value || 10,
      capComment: +d.querySelector("#tm-a-capcomment").value || 8,
      delayMin: +d.querySelector("#tm-a-dmin").value || 30,
      delayMax: +d.querySelector("#tm-a-dmax").value || 90,
    };
    settings.auto7 = a7;
    chrome.storage.local.set({ auto7: a7 });
  }

  function applyAuto7(d) {
    const a = { ...autoDefaults(), ...(settings.auto7 || {}) };
    d.querySelector("#tm-a-like").checked = a.like;
    d.querySelector("#tm-a-follow").checked = a.follow;
    d.querySelector("#tm-a-comment").checked = a.comment;
    d.querySelector("#tm-a-source").innerHTML = buildSourceOptions(a.source);
    d.querySelector("#tm-a-autosend").checked = a.autoSend;
    d.querySelector("#tm-a-kw").value = a.keywords;
    d.querySelector("#tm-a-caplike").value = a.capLike;
    d.querySelector("#tm-a-capfollow").value = a.capFollow;
    d.querySelector("#tm-a-capcomment").value = a.capComment;
    d.querySelector("#tm-a-dmin").value = a.delayMin;
    d.querySelector("#tm-a-dmax").value = a.delayMax;
  }

  function renderAuto() {
    const d = document.getElementById("threadmate-auto");
    if (!d.dataset.built) {
      d.dataset.built = "1";
      const num = (id, w) => `<input id="${id}" type="number" style="width:${w}px">`;
      d.innerHTML = `
        <p class="tm-h">⚡ 自動互動（無人值守）</p>
        <div class="tm-warn">⚠️ 這會用你的帳號真的互動／<b>公開發文</b>。大量自動行為可能被 Threads 限流或封號，促銷洗版也傷品牌。<b>風險自負</b>。</div>
        <label class="tm-ck"><input type="checkbox" id="tm-a-like"> 自動按讚</label>
        <label class="tm-ck"><input type="checkbox" id="tm-a-follow"> 自動追蹤</label>
        <label class="tm-ck"><input type="checkbox" id="tm-a-comment"> 自動留言</label>
        <div class="tm-drow"><label>留言用</label><select id="tm-a-source" style="flex:1"></select></div>
        <label class="tm-ck"><input type="checkbox" id="tm-a-autosend"> 自動送出（取消＝每則跳出審核條，你一鍵送出或跳過）</label>
        <p class="tm-tip" style="margin-top:6px">只對含關鍵字的貼文（留空＝全部，強烈建議填）</p>
        <textarea id="tm-a-kw" placeholder="找球友&#10;揪羽球&#10;三缺一"></textarea>
        <div class="tm-drow"><label>每日上限 讚</label>${num("tm-a-caplike", 48)}<label>追</label>${num("tm-a-capfollow", 42)}<label>留</label>${num("tm-a-capcomment", 42)}</div>
        <div class="tm-drow"><label>每則間隔秒 min</label>${num("tm-a-dmin", 48)}<label>max</label>${num("tm-a-dmax", 48)}</div>
        <div class="tm-drow"><button class="tm-go" id="tm-a-start">▶ 開始</button><button id="tm-a-stop">⏹ 全停</button></div>
        <p class="tm-tip" id="tm-a-status">未啟動</p>
        <div id="tm-a-log" class="tm-log"></div>`;
      d.addEventListener("change", saveAuto7);
      d.querySelector("#tm-a-start").onclick = () => {
        saveAuto7();
        const I = (id, def) => Math.max(0, parseInt(d.querySelector("#" + id).value, 10) || def);
        const dmin = I("tm-a-dmin", 30);
        const src = d.querySelector("#tm-a-source").value;
        let commentText = null;
        if (src.indexOf("tpl:") === 0) {
          const t = (settings.templates || [])[+src.slice(4)];
          commentText = t && t.text;
        }
        const cfg = {
          like: d.querySelector("#tm-a-like").checked,
          follow: d.querySelector("#tm-a-follow").checked,
          comment: d.querySelector("#tm-a-comment").checked,
          commentText,
          autoSend: d.querySelector("#tm-a-autosend").checked,
          keywords: d.querySelector("#tm-a-kw").value.split("\n").map((s) => s.trim()).filter(Boolean),
          cap: { like: I("tm-a-caplike", 50), follow: I("tm-a-capfollow", 10), comment: I("tm-a-capcomment", 8) },
          delayMin: dmin,
          delayMax: Math.max(dmin + 1, I("tm-a-dmax", 90)),
        };
        if (!cfg.like && !cfg.follow && !cfg.comment) return toast("至少勾一個動作", "error");
        if (cfg.comment && cfg.autoSend && !confirm("自動留言會用你的帳號『公開發文』並自動送出，無反偵測、風險自負。確定開始？")) return;
        startEngine(cfg);
      };
      d.querySelector("#tm-a-stop").onclick = stopEngine;
    }
    applyAuto7(d);
  }

  // ---- hover quick-reply menu on a post's reply button -------------------
  // Hover the 回覆 button → small menu (AI / templates) → opens the composer and
  // fills the chosen text. Does NOT auto-submit — you review and post.
  let hoverMenu = null;
  let hoverTarget = null;
  let hoverHideTimer = null;
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function ensureHoverMenu() {
    if (hoverMenu) return hoverMenu;
    hoverMenu = document.createElement("div");
    hoverMenu.id = "tm-hover-menu";
    hoverMenu.hidden = true;
    hoverMenu.addEventListener("mouseenter", () => clearTimeout(hoverHideTimer));
    hoverMenu.addEventListener("mouseleave", scheduleHideMenu);
    document.body.appendChild(hoverMenu);
    return hoverMenu;
  }
  function scheduleHideMenu() {
    clearTimeout(hoverHideTimer);
    hoverHideTimer = setTimeout(() => {
      if (hoverMenu) hoverMenu.hidden = true;
    }, 260);
  }
  function findReplyButtonFrom(el) {
    if (!el || !el.closest) return null;
    if (PLATFORM === "x") return el.closest('[data-testid="reply"]');
    const btn = el.closest('[role="button"]');
    return btn && btn.querySelector('svg[aria-label*="回覆"], svg[aria-label*="Reply"]') ? btn : null;
  }
  function showHoverMenu(btn, container) {
    const menu = ensureHoverMenu();
    clearTimeout(hoverHideTimer);
    if (hoverTarget && hoverTarget.btn === btn && !menu.hidden) return;
    hoverTarget = { btn, container };
    const tmpl = settings.templates || [];
    let html = '<button class="tm-hm-item" data-act="ai">✨ AI 回覆</button>';
    if (tmpl.length) {
      html += '<div class="tm-hm-sep">範本</div>';
      tmpl.forEach((t, i) => {
        html += `<button class="tm-hm-item" data-act="tpl" data-i="${i}">📋 ${esc(t.label || t.text.slice(0, 18))}</button>`;
      });
    }
    menu.innerHTML = html;
    menu.querySelectorAll(".tm-hm-item").forEach((b) => {
      b.onclick = () => {
        menu.hidden = true;
        if (b.dataset.act === "ai") semiReply("ai");
        else {
          const t = (settings.templates || [])[+b.dataset.i];
          semiReply("tpl", t && t.text);
        }
      };
    });
    const r = btn.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 210)) + "px";
    menu.hidden = false;
    const mh = menu.offsetHeight;
    menu.style.top = (r.top - mh - 6 > 8 ? r.top - mh - 6 : r.bottom + 6) + "px";
  }
  async function semiReply(mode, tplText) {
    if (!hoverTarget) return;
    const { btn, container } = hoverTarget;
    const postText = extractPostText(container);
    if (mode === "ai" && (!postText || postText.trim().length < 2)) {
      return toast("抓不到這篇貼文內容（可能是純圖片/影片），請改用 ✨ 面板手動貼上。", "error");
    }
    btn.click();
    const sel =
      PLATFORM === "x"
        ? '[data-testid="tweetTextarea_0"]'
        : '[role="textbox"][contenteditable="true"], div[contenteditable="true"][data-lexical-editor], div[contenteditable="true"]';
    const input = await waitFor(() => {
      const c = document.querySelector(sel);
      return c && c.offsetParent !== null ? c : null;
    }, 150, 25);
    if (!input) return toast("回覆框沒出現，可能改版了", "error");
    if (mode === "tpl") {
      if (!tplText) return toast("範本是空的", "error");
      fillEditor(input, tplText);
      return toast("已帶入範本，檢查後自行送出 ✅", "ok");
    }
    toast("AI 生成中…");
    const res = await chrome.runtime.sendMessage({ type: "generate", postText, platform: PLATFORM });
    if (!res || !res.ok) return toast("生成失敗：" + ((res && res.error) || ""), "error");
    fillEditor(input, res.text);
    toast("已帶入 AI 草稿，檢查後自行送出 ✅", "ok");
  }
  function onReplyHover(e) {
    const btn = findReplyButtonFrom(e.target);
    if (btn) {
      const container =
        PLATFORM === "x" ? btn.closest("article") : btn.closest('div[data-pressable-container="true"]');
      if (container) return showHoverMenu(btn, container);
    }
    if (hoverMenu && hoverMenu.contains(e.target)) {
      clearTimeout(hoverHideTimer);
      return;
    }
    if (hoverMenu && !hoverMenu.hidden) scheduleHideMenu();
  }

  // ---- init ---------------------------------------------------------------
  async function init() {
    await loadSettings();
    if (settings.featureEnabled === false) return;
    injectStyles();
    ensureButton();
    ensureHoverMenu();
    document.addEventListener("mouseover", onReplyHover);
    maybeSwitchFollowing();
    new MutationObserver(() => ensureButton()).observe(document.body, {
      childList: true,
      subtree: true,
    });
    chrome.storage.onChanged.addListener(async () => {
      await loadSettings();
      const panel = document.getElementById("threadmate-panel");
      if (panel && !panel.hidden) renderTemplates();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
