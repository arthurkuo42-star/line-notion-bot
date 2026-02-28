const { Client } = require("@notionhq/client");
const axios = require("axios");
const FormData = require("form-data");

const notion = new Client({ auth: process.env.NOTION_TOKEN });

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
    parent: { database_id: process.env.NOTION_DATABASE_ID },
    properties,
  };

  if (process.env.NOTION_TEMPLATE_ID) {
    createParams.template = { id: process.env.NOTION_TEMPLATE_ID };
  }

  if (content) {
    createParams.children = [
      {
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content } }],
        },
      },
    ];
  }

  const page = await notion.pages.create(createParams);
  return page;
}

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

module.exports = { createTaskPage, appendFileToPage };