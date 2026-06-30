# ✨ Threadmate

**免費、開源、自帶金鑰（BYOK）的 Threads / X AI 回覆助手。**
按一下，AI 幫你草擬一則貼合貼文的回覆 —— 預設只「插入草稿」，由你檢查後送出。

零後端、零追蹤、金鑰只存你本機。沒有付費牆、沒有點數、沒有把你的資料偷偷上傳。

> 📥 [下載最新版](https://github.com/hongyinull/threadmate/releases/latest)　·　🔒 [隱私權政策](PRIVACY.md)　·　授權 [MIT](LICENSE)

---

## 為什麼做這個

市面上的 Threads 成長外掛常見毛病：把 AI 鎖在自家後端按點數收費、偷偷把你的活動紀錄上傳第三方、甚至硬編碼別人的金鑰與 Telegram bot。Threadmate 反過來：

- **BYOK**：填你自己的 OpenAI / Anthropic / Gemini 金鑰，前端直連，永久免費。
- **零後端**：沒有伺服器 = 沒有帳單 = 沒有資料外洩面。
- **人在迴路為預設**：預設只草擬、由你送出；進階的「自動互動」是選用功能、**預設關閉**，並附風險警語。

## 功能

- 🤖 **AI 回覆草稿**（Threads 與 X / Twitter）：按 ✨ 彈出可編輯貼文框 → 生成 → 帶入回覆框；面板顯示完整草稿可複製。
- 🎚️ **語氣與風格**：親切 / 專業 / 幽默 / 提問 …，可設語言、領域人設、品牌推廣帶入。
- 📋 **範本庫**：常用回覆一鍵插入，不花 AI 費用。
- ⌨️ **快捷鍵** `Ctrl/⌘ + Shift + Y`；深色模式支援。
- 📊 **數據洞察**：採集貼文（作者/連結/內文/讚/留言/轉發/分享）→ 匯出 CSV → 一鍵產生「爆文分析」prompt 丟給 AI；🖍️ 關鍵字海巡標亮。全部存本機。
- 🔁 **匯入／匯出設定**：一鍵打包傳給同事，他匯入就能直接用（可選含/不含金鑰）。
- 🧭 （實驗）Threads 開啟時自動切到「追蹤中」時間軸。
- ⚡ **自動互動（進階／高風險，預設關閉）**：無人值守自動讚/追蹤/AI 留言，可關鍵字鎖定，內建每日上限、隨機間隔、總開關、本地操作 log。⚠️ 違反平台 ToS、可能被限流/封號，**風險自負**。
- 🔒 金鑰本機儲存、AI 呼叫全走背景、金鑰不進入網頁。

## 下載與安裝

1. **取得檔案**：到 [Releases](https://github.com/hongyinull/threadmate/releases/latest) 下載 `threadmate-*.zip` 並解壓；或 `git clone` 本 repo。
2. Chrome → `chrome://extensions` → 右上角開「**開發人員模式**」。
3. 點「**載入未封裝項目**」→ 選 `threadmate` 資料夾。
4. 第一次安裝會自動開設定頁；選供應商、貼上你自己的 API 金鑰、儲存。
5. 到 [threads.com](https://www.threads.com) 或 [x.com](https://x.com)，點開貼文回覆框，按右下角「✨ AI 回覆」。

### 去哪拿金鑰
- **Gemini**（推薦新手，有免費額度）：<https://aistudio.google.com/apikey>
- **OpenAI**：<https://platform.openai.com/api-keys>
- **Anthropic**：<https://console.anthropic.com/settings/keys>

## 隱私

金鑰存在 `chrome.storage.local`（**只在你本機**）；生成請求由背景 service worker **直接**送到你選的供應商，沒有任何 Threadmate 伺服器；零分析、零遙測。完整說明見 [PRIVACY.md](PRIVACY.md)。

## 這是怎麼「集大成」來的

Threadmate 借鑑了多個現有 Threads 外掛各自的長處，但**只重新實作技術手法**，不複製任何閉源原始碼：

| 借鑑點 | 來源 | 授權處理 |
|---|---|---|
| 填入 Lexical 回覆框（`execCommand` / `beforeinput`） | Comment Generator / Threads Insight | 私有 → 重寫手法 |
| 語氣 / 回覆類型 / 領域人設 參數化 | Comment Generator + Thriendly | 私有 → 重寫概念 |
| 跨平台（Threads + X）注入 | Thriendly | 私有 → 重寫 |
| 貼文容器 `div[data-pressable-container]` / 數據採集 / CSV | Threads Insight | 私有 → 重寫手法 |
| 切換「追蹤中」時間軸 | Default-to-Following（MIT 油猴腳本） | MIT → 可自由借鑑 |
| 自動互動架構觀念 | Threads Engagement Automation | 私有 → 只學架構，不抄碼 |

**刻意不做**前述外掛的後端代理收費、靜默上傳活動紀錄、硬編碼金鑰 / Telegram。自動互動雖有實作但**預設關閉、附警語，且不含反偵測**。

## 已知限制

Threads / X 的 DOM class 名稱是亂數且常改版。若按鈕抓不到貼文或插入失敗，多半是官方改了 selector —— 歡迎更新 `content.js` 的 `extractPostText()` / `getActiveEditor()` / `findSubmitButton()` 後送 PR。

## 貢獻 / 回報

歡迎 issue 與 PR：<https://github.com/hongyinull/threadmate/issues>

## 授權

[MIT](LICENSE)。自由使用、修改、散布。
