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

// ── 狀態管理 ──────────────────────────────────────
const messageBuffer = new Map();
const pendingDecision = new Map();

const BUFFER_WINDOW = 7000;

// ── Webhook ────────────────────────────────────────
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

  const userId = event.source.userId;
  const message = event.message;

  // ── 使用者回覆「合併」或「分開」──────────────────
  if (message.type === "text") {
    const text = message.text.trim();

    if (text === "合併" || text === "1" || text === "分開" || text === "2") {
      // 找不到待處理狀態（伺服器重啟或逾時）
      if (!pendingDecision.has(userId)) {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [
            {
              type: "text",
              text: "⚠️ 操作已逾時或伺服器重啟，請重新傳送內容後再選擇合併或分開。",
            },
          ],
        });
        return;
      }

      if (text === "合併" || text === "1") {
        const messages = pendingDecision.get(userId);
        pendingDecision.delete(userId);
        await processMerged(userId, messages);
        return;
      }

      if (text === "分開" || text === "2") {
        const messages = pendingDecision.get(userId);
        pendingDecision.delete(userId);
        await processSeparate(userId, messages);
        return;
      }
    }

    // 有 pendingDecision 但輸入不是合併/分開，清除等待狀態繼續正常處理
    if (pendingDecision.has(userId)) {
      pendingDecision.delete(userId);
    }
  }

  // ── 下載並存入緩衝區 ──────────────────────────────
  const bufferedMessage = await downloadMessage(message);
  if (!bufferedMessage) return;

  addToBuffer(userId, bufferedMessage);
}

async function downloadMessage(message) {
  if (message.type === "text") {
    return { type: "text", content: message.text };
  }

  if (message.type === "image") {
    const stream = await blobClient.getMessageContent(message.id);
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return {
      type: "image",
      buffer: Buffer.concat(chunks),
      mimeType: "image/jpeg",
      fileName: `image_${Date.now()}.jpg`,
    };
  }

  if (message.type === "file") {
    const stream = await blobClient.getMessageContent(message.id);
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const fileName = message.fileName || `檔案_${Date.now()}`;
    return {
      type: "file",
      buffer: Buffer.concat(chunks),
      mimeType: getMimeType(fileName),
      fileName,
    };
  }

  return null;
}

function addToBuffer(userId, message) {
  if (!messageBuffer.has(userId)) {
    messageBuffer.set(userId, { messages: [], timer: null });
  }

  const buffer = messageBuffer.get(userId);
  buffer.messages.push(message);

  if (buffer.timer) clearTimeout(buffer.timer);
  buffer.timer = setTimeout(() => flushBuffer(userId), BUFFER_WINDOW);
}

async function flushBuffer(userId) {
  if (!messageBuffer.has(userId)) return;

  const { messages } = messageBuffer.get(userId);
  messageBuffer.delete(userId);

  if (messages.length === 0) return;

  if (messages.length === 1) {
    await processSeparate(userId, messages);
    return;
  }

  pendingDecision.set(userId, messages);

  await lineClient.pushMessage({
    to: userId,
    messages: [
      {
        type: "text",
        text: `📨 偵測到 ${messages.length} 則內容，請問要如何處理？\n\n1️⃣ 合併 → 存成同一個 Notion 頁面\n2️⃣ 分開 → 各自建立不同頁面\n\n請回覆「合併」或「分開」`,
      },
    ],
  });
}

async function processMerged(userId, messages) {
  const today = getTodayISO();
  const todayDisplay = getTodayDisplay();

  let title = `合併內容 ${todayDisplay}`;
  let textContent = "";

  for (const msg of messages) {
    if (msg.type === "text") {
      if (!textContent) title = msg.content.slice(0, 30);
      textContent += (textContent ? "\n\n" : "") + msg.content;
    }
  }

  const page = await createTaskPage(title, today, textContent || null);

  for (const msg of messages) {
    if (msg.type === "image" || msg.type === "file") {
      await appendFileToPage(page.id, msg.buffer, msg.mimeType, msg.fileName);
    }
  }

  await lineClient.pushMessage({
    to: userId,
    messages: [
      {
        type: "text",
        text: `✅ 已合併儲存至 Notion！\n\n📝 ${title}\n📅 截止：${today}\n\n🔗 ${page.url}`,
      },
    ],
  });
}

async function processSeparate(userId, messages) {
  const today = getTodayISO();
  const todayDisplay = getTodayDisplay();
  const results = [];

  for (const msg of messages) {
    if (msg.type === "text") {
      const result = await parseTaskFromMessage(msg.content);

      if (result.is_task) {
        const page = await createTaskPage(result.title, result.due_date);
        const dueDateStr = result.due_date ? `📅 截止：${result.due_date}` : "📅 截止日期：未設定";
        results.push(`✅ ${result.title}\n${dueDateStr}\n🔗 ${page.url}`);
      } else {
        const title = `備忘 ${todayDisplay}`;
        const page = await createTaskPage(title, today, msg.content);
        results.push(`📓 ${title}\n🔗 ${page.url}`);
      }
    }

    if (msg.type === "image") {
      const title = `圖片附件 ${todayDisplay}`;
      const page = await createTaskPage(title, today);
      await appendFileToPage(page.id, msg.buffer, msg.mimeType, msg.fileName);
      results.push(`🖼️ ${title}\n🔗 ${page.url}`);
    }

    if (msg.type === "file") {
      const title = `${msg.fileName} ${todayDisplay}`;
      const page = await createTaskPage(title, today);
      await appendFileToPage(page.id, msg.buffer, msg.mimeType, msg.fileName);
      results.push(`📎 ${title}\n🔗 ${page.url}`);
    }
  }

  const summary = results.join("\n\n");
  await lineClient.pushMessage({
    to: userId,
    messages: [
      {
        type: "text",
        text: `✅ 已分開儲存至 Notion！\n\n${summary}`,
      },
    ],
  });
}

function getTodayISO() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });
}

function getTodayDisplay() {
  return new Date().toLocaleDateString("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

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