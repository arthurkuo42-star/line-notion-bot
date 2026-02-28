require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const { parseTaskFromMessage } = require("./claude");
const { createTaskPage, appendFileToPage } = require("./notion");

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

  // 取得今天日期（台灣時區）
  const today = new Date().toLocaleDateString("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  // 轉換成 YYYY-MM-DD 格式
  const todayISO = new Date().toLocaleDateString("sv-SE", {
    timeZone: "Asia/Taipei",
  });

  // ── 文字訊息 ──────────────────────────────────────
  if (message.type === "text") {
    const userText = message.text;
    const result = await parseTaskFromMessage(userText);

    if (result.is_task) {
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
      const title = `備忘 ${today}`;
      const page = await createTaskPage(title, todayISO, userText);

      await lineClient.replyMessage({
        replyToken,
        messages: [
          {
            type: "text",
            text: `📓 備忘已儲存至 Notion！\n\n📝 ${title}\n📅 截止：${todayISO}\n\n🔗 ${page.url}`,
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
    const fileBuffer = Buffer.concat(chunks);

    const title = `圖片附件 ${today}`;
    const page = await createTaskPage(title, todayISO);
    await appendFileToPage(page.id, fileBuffer, "image/jpeg", `image_${Date.now()}.jpg`);

    await lineClient.replyMessage({
      replyToken,
      messages: [
        {
          type: "text",
          text: `🖼️ 圖片已儲存至 Notion！\n\n📝 ${title}\n📅 截止：${todayISO}\n\n🔗 ${page.url}`,
        },
      ],
    });
  }

  // ── 檔案訊息（PDF / Word 等）──────────────────────
  if (message.type === "file") {
    const stream = await blobClient.getMessageContent(message.id);
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const fileBuffer = Buffer.concat(chunks);

    const fileName = message.fileName || `檔案_${Date.now()}`;
    const mimeType = getMimeType(fileName);
    const title = `${fileName} ${today}`;
    const page = await createTaskPage(title, todayISO);
    await appendFileToPage(page.id, fileBuffer, mimeType, fileName);

    await lineClient.replyMessage({
      replyToken,
      messages: [
        {
          type: "text",
          text: `📎 檔案已儲存至 Notion！\n\n📝 ${title}\n📅 截止：${todayISO}\n\n🔗 ${page.url}`,
        },
      ],
    });
  }
}

// 依副檔名判斷 MIME type
function getMimeType(fileName) {
  const ext = fileName.split(".").pop().toLowerCase();
  const mimeMap = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
  };
  return mimeMap[ext] || "application/octet-stream";
}

app.get("/", (req, res) => res.send("LINE Notion Bot 運作中 ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));