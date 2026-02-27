const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function parseTaskFromMessage(message) {
  const today = new Date().toLocaleDateString("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
  });

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: `你是一個法律事務所助理，負責從訊息中萃取待辦事項資訊。

今天是：${today}

請從以下訊息中萃取：
1. 待辦事項名稱（title）：簡潔描述任務，50字以內
2. 截止日期（due_date）：格式為 YYYY-MM-DD，若訊息中有提到日期或時間描述（如「下週五」「月底」「明天」「3/15」）請推算出絕對日期；若沒有提到截止日期則填 null

請只回傳 JSON，不要有其他文字：
{
  "title": "任務名稱",
  "due_date": "YYYY-MM-DD 或 null"
}

訊息內容：${message}`,
      },
    ],
  });

const text = response.content[0].text.trim();
// 移除 Claude 可能回傳的 markdown 標記
const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
const json = JSON.parse(cleaned);
return json;
}

module.exports = { parseTaskFromMessage };