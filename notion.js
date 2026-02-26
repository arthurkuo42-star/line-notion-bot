const { Client } = require("@notionhq/client");
const axios = require("axios");

const notion = new Client({ auth: process.env.NOTION_TOKEN });

async function createTaskPage(title, dueDate) {
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

  const page = await notion.pages.create(createParams);
  return page;
}

async function appendImageToPage(pageId, imageBuffer, mimeType) {
  const uploadResponse = await axios.post(
    "https://api.notion.com/v1/file-uploads",
    { name: `image_${Date.now()}.jpg`, content_type: mimeType },
    {
      headers: {
        Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
    }
  );

  const { upload_url, id: fileUploadId } = uploadResponse.data;

  await axios.put(upload_url, imageBuffer, {
    headers: { "Content-Type": mimeType },
  });

  await notion.blocks.children.append({
    block_id: pageId,
    children: [
      {
        type: "image",
        image: {
          type: "file_upload",
          file_upload: { id: fileUploadId },
        },
      },
    ],
  });
}

module.exports = { createTaskPage, appendImageToPage };