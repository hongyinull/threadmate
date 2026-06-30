// Builds the system + user prompt from the user's tone / language / niche settings.

const TONES = {
  friendly: "親切、溫暖、像朋友聊天",
  professional: "專業、有見地、可信",
  witty: "機智、幽默、帶點俏皮",
  supportive: "鼓勵、支持、正向",
  question: "用一個有深度的問題回應，引發對話",
  contrarian: "禮貌但提出不同觀點，促進討論",
  congrats: "真誠祝賀、替對方開心",
};

export function buildPrompt({ platform, postText, tone, language, niche, customInstr, promo }) {
  const isX = platform === "x";
  const limit = isX ? 280 : 500;
  const toneDesc = TONES[tone] || TONES.friendly;

  const langLine =
    !language || language === "auto"
      ? "用與原貼文相同的語言回覆。"
      : `一律用「${language}」回覆。`;
  const nicheLine = niche ? `以「${niche}」的身分與口吻回覆。` : "";
  const promoLine = promo
    ? `若與貼文主題自然相關，可順勢、低調地帶到以下推廣（一兩句即可，先真誠回應貼文，不要像硬塞廣告或整段照貼）：「${promo}」`
    : "";
  const extra = customInstr ? `額外要求：${customInstr}` : "";

  const system = [
    `你是一位擅長社群互動的助理，幫使用者替一則 ${isX ? "X (Twitter)" : "Threads"} 貼文寫「一則」回覆。`,
    `語氣：${toneDesc}。`,
    langLine,
    nicheLine,
    promoLine,
    "規則：",
    `- 簡短：只寫 1 到 2 句、盡量 60 字以內（絕不超過 ${limit} 字元）。短而精準勝過長。`,
    "- 要具體呼應貼文內容，像真人留言，不要空泛或罐頭。",
    "- 不要用 hashtag，除非很自然；emoji 最多一個，或不用。",
    "- 不要用引號把整句框起來，不要任何解說，只輸出回覆本身。",
    "- ⚠️ 只輸出「一則」最終回覆的純文字。嚴禁給多個選項、嚴禁出現「Option 1/2」「選項一/二」「Drafting Options」這類字眼、嚴禁 Markdown（不要 *、**、#、- 條列、不要程式碼框）、嚴禁前言或思考過程。若不確定要回什麼，就直接寫一則最合理的回覆，絕不列選項。",
    extra,
  ]
    .filter(Boolean)
    .join("\n");

  const user = `貼文內容：\n"""\n${postText}\n"""\n\n請寫出回覆。`;
  return { system, user };
}
