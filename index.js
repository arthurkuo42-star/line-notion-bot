require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const { parseTaskFromMessage } = require("./claude");
const { createTaskPage, appendImageToPage } = require("./notion");

const app = express();

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

const blobClient = new line.messagingApi.MessagingApiBlobClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

app.post(
  "/webhook",
  line.middleware(lineConfig),
  async (req, res) => {
    res.sendStatus(200);

    const events = req.body.events;
    for (const event of events) {
      try {
        await handleEvent(event);
      } catch (err) {
        console.error("處理事件錯誤：", err);
      }
    }
  }
);

async function handleEvent(event) {
  if (event.type !== "message") return;

  const replyToken = event.replyToken;
  const message = event.message;

  // ── 文字訊息 ──────────────────────────────────────
  if (message.type === "text") {
    const userText = message.text;

    const result = await parseTaskFromMessage(userText);

    if (result.is_task) {
      // 待辦事項：解析標題和截止日期
      const { title, due_date } = result;
      const page = await createTaskPage(title, due_date);

      const dueDateStr = due_date
        ? `📅 截止：${due_date}`
        : "📅 截止日期：未設定";

      await lineClient.replyMessage({
        replyToken,
        messages: [
          {
            type: "text",
            text: `✅ 待辦已新增！\n\n📝 ${title}\n${dueDateStr}\n\n🔗 ${page.url}`,
          },
        ],
      });

    } else {
      // 備忘筆記：直接存成 Notion 頁面
      const title = `備忘 ${new Date().toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei" })}`;
      const page = await createTaskPage(title, null, userText);

      await lineClient.replyMessage({
        replyToken,
        messages: [
          {
            type: "text",
            text: `📓 備忘已儲存至 Notion！\n\n📝 ${title}\n\n🔗 ${page.url}`,
          },
        ],
      });
    }
  }

  // ── 圖片訊息 ──────────────────────────────────────
  if (message.type === "image") {
const stream = await blobClient.getMessageContent(message.id);
const chunks = [];
for await (const chunk of stream) {
  chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
}
const imageBuffer = Buffer.concat(chunks);

    const title = `圖片附件 ${new Date().toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei" })}`;
    const page = await createTaskPage(title, null);

    await appendImageToPage(page.id, imageBuffer, "image/jpeg");

    await lineClient.replyMessage({
      replyToken,
      messages: [
        {
          type: "text",
          text: `🖼️ 圖片已儲存至 Notion！\n\n📝 ${title}\n\n🔗 ${page.url}`,
        },
      ],
    });
  }
}

app.get("/", (req, res) => res.send("LINE Notion Bot 運作中 ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));