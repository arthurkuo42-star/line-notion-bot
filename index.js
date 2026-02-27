require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");
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

  if (message.type === "text") {
    const userText = message.text;

    const { title, due_date } = await parseTaskFromMessage(userText);

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
  }

  if (message.type === "image") {
    const response = await blobClient.getMessageContent(message.id);
    const arrayBuffer = await response.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuffer);

    
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