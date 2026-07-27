require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const {
  parseTaskFromMessage,
  parseInvoiceFromFile,
  parseExpenseFromText,
} = require("./claude");
const { registerArchiveBot } = require("./archive");
const {
  createTaskPage,
  createExpensePage,
  updateClaimStatus,
  updatePaidStatus,
  convertExpenseToNote,
  appendFileToPage,
} = require("./notion");

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
app.post("/webhook", line.middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);
  const events = req.body.events;
  for (const event of events) {
    try {
      if (event.type === "postback") {
        await handlePostback(event);
      } else if (event.type === "message") {
        await handleEvent(event);
      }
    } catch (err) {
      console.error("處理事件錯誤：", err?.body || err);
      // 不讓錯誤靜默：至少回報使用者一則失敗訊息
      const uid = event?.source?.userId;
      if (uid) {
        try {
          await lineClient.pushMessage({
            to: uid,
            messages: [
              {
                type: "text",
                text: "⚠️ 剛才那筆處理時發生錯誤，沒有存進去。可以再傳一次，或改用文字「記帳 品項 金額」。",
              },
            ],
          });
        } catch (notifyErr) {
          console.error("錯誤通知也失敗：", notifyErr?.body || notifyErr);
        }
      }
    }
  }
});

async function handleEvent(event) {
  const userId = event.source.userId;
  const message = event.message;

  // ── 使用者回覆「合併」或「分開」──────────────────
  if (message.type === "text") {
    const text = message.text.trim();

    if (text === "合併" || text === "1" || text === "分開" || text === "2") {
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

      const messages = pendingDecision.get(userId);
      pendingDecision.delete(userId);
      if (text === "合併" || text === "1") {
        await processMerged(userId, messages);
      } else {
        await processSeparate(userId, messages);
      }
      return;
    }

    // 手動記帳指令：「記帳 午餐 150」
    if (text.startsWith("記帳")) {
      await handleTextExpense(userId, text.replace(/^記帳[:：\s]*/, ""));
      return;
    }

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
    const buffer = await collectStream(await blobClient.getMessageContent(message.id));
    return {
      type: "image",
      buffer,
      mimeType: "image/jpeg",
      fileName: `image_${Date.now()}.jpg`,
    };
  }

  if (message.type === "file") {
    const buffer = await collectStream(await blobClient.getMessageContent(message.id));
    const fileName = message.fileName || `檔案_${Date.now()}`;
    return {
      type: "file",
      buffer,
      mimeType: getMimeType(fileName),
      fileName,
    };
  }

  return null;
}

async function collectStream(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
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

// 合併 → 一律存進 note database（使用者明確要求彙整成一頁筆記）
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
        const dueDateStr = result.due_date
          ? `📅 截止：${result.due_date}`
          : "📅 截止日期：未設定";
        results.push(`✅ ${result.title}\n${dueDateStr}\n🔗 ${page.url}`);
      } else {
        const title = `備忘 ${todayDisplay}`;
        const page = await createTaskPage(title, today, msg.content);
        results.push(`📓 ${title}\n🔗 ${page.url}`);
      }
    }

    // 圖片/檔案 → 先辨識是否為發票/繳款單
    if (msg.type === "image" || msg.type === "file") {
      const outcome = await tryHandleAsExpense(userId, msg);
      if (outcome.handled) continue; // 已送出記帳卡片，不再列入 note 結果

      // 非消費憑證（或記帳流程失敗）→ 存進 note database，並附上退回原因供診斷
      const isImage = msg.type === "image";
      const title = isImage
        ? `圖片附件 ${todayDisplay}`
        : `${msg.fileName} ${todayDisplay}`;
      const page = await createTaskPage(title, today);
      await appendFileToPage(page.id, msg.buffer, msg.mimeType, msg.fileName);
      const reasonLine = outcome.reason ? `\nℹ️ ${outcome.reason}` : "";
      results.push(`${isImage ? "🖼️" : "📎"} ${title}${reasonLine}\n🔗 ${page.url}`);
    }
  }

  if (results.length === 0) return;

  await lineClient.pushMessage({
    to: userId,
    messages: [
      {
        type: "text",
        text: `✅ 已分開儲存至 Notion！\n\n${results.join("\n\n")}`,
      },
    ],
  });
}

// 嘗試把圖片/PDF 當成發票/繳款單處理。
// 回傳 { handled: true } = 已送出記帳卡片；
//     { handled: false, reason } = 未當成記帳（reason 供診斷用）。
async function tryHandleAsExpense(userId, msg) {
  let parsed;
  try {
    parsed = await parseInvoiceFromFile(msg.buffer, msg.mimeType);
  } catch (err) {
    console.error("發票辨識失敗，改存 note：", err);
    return { handled: false, reason: `辨識出錯（${err.message || err}）` };
  }

  if (!parsed || !parsed.is_expense) {
    return { handled: false, reason: "AI 判斷這不是消費憑證" };
  }

  const data = {
    title: parsed.title || "未命名支出",
    amount: parsed.amount != null ? Number(parsed.amount) : null,
    category: parsed.category || null,
    date: parsed.date || getTodayISO(),
    dueDate: parsed.due_date || null,
    note: parsed.note || null,
  };

  // 建立記帳頁面。失敗（例如選項驗證）就退回 note 流程，讓使用者至少存到檔案 + 有回覆。
  let page;
  try {
    page = await createExpensePage(data);
  } catch (err) {
    console.error("建立記帳頁面失敗，改存 note：", err?.body || err);
    const detail = err?.body || err?.message || String(err);
    return { handled: false, reason: `寫入記帳庫失敗（${String(detail).slice(0, 120)}）` };
  }

  // 附上原始照片/PDF。附檔失敗不影響已建立的記帳頁，僅記錄。
  try {
    await appendFileToPage(page.id, msg.buffer, msg.mimeType, msg.fileName);
  } catch (err) {
    console.error("記帳頁附檔失敗（頁面已建立）：", err?.body || err);
  }

  await lineClient.pushMessage({
    to: userId,
    messages: [buildExpenseFlex(page, data)],
  });
  return { handled: true };
}

// 文字記帳指令
async function handleTextExpense(userId, body) {
  if (!body.trim()) {
    await lineClient.pushMessage({
      to: userId,
      messages: [{ type: "text", text: "請在「記帳」後面接內容，例如：記帳 午餐 150" }],
    });
    return;
  }

  let parsed;
  try {
    parsed = await parseExpenseFromText(body);
  } catch (err) {
    console.error("文字記帳解析失敗：", err);
    await lineClient.pushMessage({
      to: userId,
      messages: [{ type: "text", text: "⚠️ 記帳解析失敗，請再試一次。" }],
    });
    return;
  }

  const data = {
    title: parsed.title || body.slice(0, 20),
    amount: parsed.amount != null ? Number(parsed.amount) : null,
    category: parsed.category || null,
    date: parsed.date || getTodayISO(),
    dueDate: null,
    note: parsed.note || null,
  };

  const page = await createExpensePage(data);

  await lineClient.pushMessage({
    to: userId,
    messages: [buildExpenseFlex(page, data)],
  });
}

// ── Postback：按鈕改狀態 ─────────────────────────────
async function handlePostback(event) {
  const params = new URLSearchParams(event.postback.data);
  const action = params.get("action");
  const pageId = params.get("page");
  if (!action || !pageId) return;

  let replyText = "";
  try {
    if (action === "claim_done") {
      await updateClaimStatus(pageId, "已請款");
      replyText = "✅ 已標記為「已請款」";
    } else if (action === "claim_none") {
      await updateClaimStatus(pageId, "不需請款");
      replyText = "✅ 已標記為「不需請款」";
    } else if (action === "paid") {
      await updatePaidStatus(pageId, true);
      replyText = "✅ 已標記為「已繳費／已入帳」";
    } else if (action === "not_expense") {
      await convertExpenseToNote(pageId, "改存備忘");
      replyText = "↩️ 已從記帳移除，改存為備忘筆記。";
    } else {
      return;
    }
  } catch (err) {
    console.error("更新狀態失敗：", err);
    replyText = "⚠️ 更新失敗，請稍後再試或直接到 Notion 修改。";
  }

  await lineClient.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: "text", text: replyText }],
  });
}

// ── Flex 記帳確認卡片 ────────────────────────────────
function buildExpenseFlex(page, data) {
  const amountStr =
    data.amount != null ? `NT$ ${data.amount.toLocaleString("en-US")}` : "金額未辨識";

  const rows = [];
  const addRow = (label, value) => {
    if (!value) return;
    rows.push({
      type: "box",
      layout: "baseline",
      spacing: "sm",
      contents: [
        { type: "text", text: label, color: "#999999", size: "sm", flex: 2 },
        { type: "text", text: String(value), size: "sm", flex: 5, wrap: true },
      ],
    });
  };
  addRow("分類", data.category);
  addRow("日期", data.date);
  addRow("繳款截止", data.dueDate);
  addRow("備註", data.note);

  const data0 = `page=${page.id}`;

  return {
    type: "flex",
    altText: `已記帳：${data.title} ${amountStr}`,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "📥 已記帳", weight: "bold", color: "#1DB446", size: "sm" },
          { type: "text", text: data.title, weight: "bold", size: "lg", wrap: true },
          { type: "text", text: amountStr, weight: "bold", size: "xl", color: "#333333" },
          { type: "separator", margin: "md" },
          { type: "box", layout: "vertical", margin: "md", spacing: "sm", contents: rows },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "box",
            layout: "horizontal",
            spacing: "sm",
            contents: [
              flexButton("不需請款", `action=claim_none&${data0}`, "secondary"),
              flexButton("已請款", `action=claim_done&${data0}`, "primary"),
            ],
          },
          flexButton("💰 已繳費／已入帳", `action=paid&${data0}`, "primary"),
          flexButton("❌ 這不是記帳", `action=not_expense&${data0}`, "link"),
        ],
      },
    },
  };
}

function flexButton(label, data, style) {
  return {
    type: "button",
    style,
    height: "sm",
    action: { type: "postback", label, data, displayText: label },
  };
}

// ── 工具 ─────────────────────────────────────────────
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

// 泓品收發：LINE 檔案自動歸檔（第二個 channel，環境變數未設定時不啟動）
registerArchiveBot(app);

app.get("/", (req, res) => res.send("LINE Notion Bot 運作中 ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
