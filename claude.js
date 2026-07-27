const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

// 記帳資料庫現有的選項（讓 AI 只能從中挑，避免產生新選項）
const CATEGORY_OPTIONS = [
  "房貸", "青創貸款", "汽車貸款", "信用卡帳單", "投資",
  "生活", "保險", "交通", "稅費", "BNI",
];

function todayInTaipei() {
  return new Date().toLocaleDateString("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
  });
}

function extractJson(text) {
  const cleaned = text
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    // 模型偶爾夾帶說明文字，退而求其次抓第一個 {...} 區塊
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("無法從回應解析 JSON：" + cleaned.slice(0, 200));
  }
}

// ── 文字訊息：判斷待辦/備忘（原有功能）─────────────────
async function parseTaskFromMessage(message) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: `你是一個法律事務所助理，負責判斷訊息類型並萃取資訊。

今天是：${todayInTaipei()}

請判斷以下訊息是否為「待辦事項」：
- 待辦事項：包含需要完成的任務、行動、提醒、截止日期等
- 備忘筆記：單純的記錄、想法、資訊、沒有明確任務的文字

若是「待辦事項」，請萃取：
1. 待辦事項名稱（title）：簡潔描述任務，50字以內
2. 截止日期（due_date）：格式為 YYYY-MM-DD，若有提到日期請推算；若無則填 null

請只回傳 JSON，不要有其他文字：

若是待辦事項：
{
  "is_task": true,
  "title": "任務名稱",
  "due_date": "YYYY-MM-DD 或 null"
}

若是備忘筆記：
{
  "is_task": false
}

訊息內容：${message}`,
      },
    ],
  });

  return extractJson(response.content[0].text.trim());
}

// ── 圖片/PDF：辨識是否為發票/繳款單並抽取欄位 ───────────
// buffer: 檔案內容；mimeType: image/* 或 application/pdf
async function parseInvoiceFromFile(buffer, mimeType) {
  const base64 = buffer.toString("base64");
  const isPdf = mimeType === "application/pdf";

  const fileBlock = isPdf
    ? {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: base64 },
      }
    : {
        type: "image",
        source: { type: "base64", media_type: mimeType, data: base64 },
      };

  const instruction = `你是記帳助理。請判斷這份文件是否為「發票、收據、繳款單、帳單或消費憑證」。

今天是：${todayInTaipei()}

如果是，請萃取以下欄位並只回傳 JSON：
{
  "is_expense": true,
  "title": "店家或項目名稱，20字以內",
  "amount": 總金額數字（只填數字，不含符號逗號；抓不到填 null）,
  "category": 從這個清單擇一最貼切者，抓不準填 null：${JSON.stringify(CATEGORY_OPTIONS)},
  "date": "消費/開立日期 YYYY-MM-DD，抓不到填 null",
  "due_date": "繳款截止日 YYYY-MM-DD（帳單/繳款單才有），沒有填 null",
  "note": "發票號碼、期別、卡號末四碼等可補充的備註，沒有填 null"
}

分類判斷提示：水電瓦斯電信/一般消費→生活；停車加油過路→交通；各類保費→保險；信用卡帳單→信用卡帳單；所得稅牌照稅房屋稅→稅費；BNI相關費用→BNI。

如果不是消費憑證（例如是一般照片、文件、合約、筆記），只回傳：
{
  "is_expense": false
}

請只回傳 JSON，不要有其他文字。`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [fileBlock, { type: "text", text: instruction }],
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const raw = (textBlock ? textBlock.text : "").trim();
  console.log("發票辨識原始回應：", raw.slice(0, 500));
  return extractJson(raw);
}

// ── 文字指令記帳：「記帳 午餐 150」之類 ────────────────
async function parseExpenseFromText(message) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: `你是記帳助理。使用者用文字記一筆帳，請萃取欄位。

今天是：${todayInTaipei()}

請只回傳 JSON：
{
  "title": "項目名稱，20字以內",
  "amount": 金額數字（抓不到填 null）,
  "category": 從清單擇一，抓不準填 null：${JSON.stringify(CATEGORY_OPTIONS)},
  "date": "日期 YYYY-MM-DD，沒提到就用今天",
  "note": "補充備註或 null"
}

訊息內容：${message}`,
      },
    ],
  });

  return extractJson(response.content[0].text.trim());
}

module.exports = {
  parseTaskFromMessage,
  parseInvoiceFromFile,
  parseExpenseFromText,
};
