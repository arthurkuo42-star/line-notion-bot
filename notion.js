const { Client } = require("@notionhq/client");
const axios = require("axios");
const FormData = require("form-data");

const notion = new Client({ auth: process.env.NOTION_TOKEN });

const NOTE_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const EXPENSE_DATABASE_ID = process.env.NOTION_EXPENSE_DATABASE_ID;

// ── note database（原有待辦/備忘）────────────────────
async function createTaskPage(title, dueDate, content = null) {
  const properties = {
    Task: {
      title: [{ text: { content: title } }],
    },
  };

  if (dueDate) {
    properties["Due Date"] = {
      date: { start: dueDate },
    };
  }

  const createParams = {
    parent: { database_id: NOTE_DATABASE_ID },
    properties,
  };

  if (process.env.NOTION_TEMPLATE_ID) {
    createParams.template = { id: process.env.NOTION_TEMPLATE_ID };
  }

  if (content) {
    createParams.children = buildParagraphBlocks(content);
  }

  const page = await notion.pages.create(createParams);
  return page;
}

// ── 記帳資料庫（泓志記帳｜收支與負債）─────────────────
// data 欄位對齊資料庫 schema：
//   名稱(title)、金額(number)、類型(select)、分類(select)、
//   帳戶/負債(select)、日期(date)、付款日(date)、
//   請款狀態(status)、是否已入帳(checkbox)、備註(text)
async function createExpensePage(data) {
  const {
    title,
    amount,
    type = "支出",
    category,
    account,
    date,
    dueDate,
    note,
  } = data;

  const properties = {
    名稱: {
      title: [{ text: { content: title || "未命名支出" } }],
    },
    類型: {
      select: { name: type },
    },
    請款狀態: {
      status: { name: "未請款" },
    },
    是否已入帳: {
      checkbox: false,
    },
  };

  if (typeof amount === "number" && !Number.isNaN(amount)) {
    properties["金額"] = { number: amount };
  }
  if (category) {
    properties["分類"] = { select: { name: category } };
  }
  if (account) {
    properties["帳戶/負債"] = { select: { name: account } };
  }
  if (date) {
    properties["日期"] = { date: { start: date } };
  }
  if (dueDate) {
    properties["付款日"] = { date: { start: dueDate } };
  }
  if (note) {
    properties["備註"] = { rich_text: [{ text: { content: note.slice(0, 2000) } }] };
  }

  const page = await notion.pages.create({
    parent: { database_id: EXPENSE_DATABASE_ID },
    properties,
  });
  return page;
}

// 更新記帳頁面的「請款狀態」（未請款/不需請款/已請款）
async function updateClaimStatus(pageId, statusName) {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      請款狀態: { status: { name: statusName } },
    },
  });
}

// 更新記帳頁面的「是否已入帳」（繳款單是否已繳費）
async function updatePaidStatus(pageId, paid) {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      是否已入帳: { checkbox: !!paid },
    },
  });
}

// 誤判補救：把已建的記帳頁面搬到 note database 不方便（跨庫無法直接 move），
// 改為在 note database 另建一頁保存內容，並封存原記帳頁。
async function convertExpenseToNote(expensePageId, title, content = null) {
  await notion.pages.update({ page_id: expensePageId, archived: true });
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });
  return createTaskPage(title || "改存備忘", today, content);
}

// ── 共用：上傳檔案並附到指定頁面 ─────────────────────
async function appendFileToPage(pageId, fileBuffer, mimeType, fileName) {
  const headers = {
    Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
  };

  // Step 1：建立 file upload 物件
  const createResponse = await axios.post(
    "https://api.notion.com/v1/file_uploads",
    {},
    { headers }
  );

  const { id: fileUploadId, upload_url } = createResponse.data;

  // Step 2：用 multipart/form-data 上傳檔案內容
  const form = new FormData();
  form.append("file", fileBuffer, {
    filename: fileName,
    contentType: mimeType,
  });

  await axios.post(upload_url, form, {
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      ...form.getHeaders(),
    },
  });

  // Step 3：依照 mimeType 決定 block 類型
  const isImage = mimeType.startsWith("image/");
  const isPDF = mimeType === "application/pdf";

  const blockType = isImage ? "image" : isPDF ? "pdf" : "file";

  await notion.blocks.children.append({
    block_id: pageId,
    children: [
      {
        type: blockType,
        [blockType]: {
          type: "file_upload",
          file_upload: { id: fileUploadId },
        },
      },
    ],
  });
}

function buildParagraphBlocks(content) {
  const CHUNK_SIZE = 2000;
  const chunks = [];
  for (let i = 0; i < content.length; i += CHUNK_SIZE) {
    chunks.push(content.slice(i, i + CHUNK_SIZE));
  }
  return chunks.map((chunk) => ({
    type: "paragraph",
    paragraph: {
      rich_text: [{ type: "text", text: { content: chunk } }],
    },
  }));
}

module.exports = {
  createTaskPage,
  createExpensePage,
  updateClaimStatus,
  updatePaidStatus,
  convertExpenseToNote,
  appendFileToPage,
};
