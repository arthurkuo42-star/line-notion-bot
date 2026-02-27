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
        content: `你是一個法律事務所助理，負責判斷訊息類型並萃取資訊。

今天是：${today}

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

  const text = response.content[0].text.trim();
  const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  const json = JSON.parse(cleaned);
  return json;
}

module.exports = { parseTaskFromMessage };