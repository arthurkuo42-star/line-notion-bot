// 泓品法律事務所 LINE 檔案自動歸檔模組
// 獨立的第二個 LINE channel（泓品收發官方帳號），與記帳/待辦 bot 互不干擾。
// 客戶群組傳的圖片/影片/語音/檔案 → 即時下載 → 上傳 Dropbox 永久保存。
//
// 需要的環境變數（缺任一項則模組不啟動，不影響原有 bot）：
//   ARCHIVE_CHANNEL_SECRET       泓品收發 channel secret
//   ARCHIVE_CHANNEL_ACCESS_TOKEN 泓品收發 channel access token
//   DROPBOX_APP_KEY / DROPBOX_APP_SECRET / DROPBOX_REFRESH_TOKEN
// 選填：
//   ARCHIVE_ROOT           歸檔根目錄（預設 /泓品法律事務所/00_LINE收發室）
//   ARCHIVE_ALERT_USER_ID  歸檔失敗時推播通知的 LINE userId（律師本人）
const line = require("@line/bot-sdk");
const dropbox = require("./dropbox");

const ARCHIVE_ROOT = (process.env.ARCHIVE_ROOT || "/泓品法律事務所/00_LINE收發室").replace(
  /\/+$/,
  ""
);
const GROUP_MAP_PATH = `${ARCHIVE_ROOT}/.group-map.json`;
const ARCHIVED_TYPES = new Set(["image", "video", "audio", "file"]);

function registerArchiveBot(app) {
  const channelSecret = process.env.ARCHIVE_CHANNEL_SECRET;
  const channelAccessToken = process.env.ARCHIVE_CHANNEL_ACCESS_TOKEN;

  if (!channelSecret || !channelAccessToken) {
    console.log("ℹ️ 歸檔模組未啟用（尚未設定 ARCHIVE_CHANNEL_SECRET / ARCHIVE_CHANNEL_ACCESS_TOKEN）");
    return;
  }
  if (
    !process.env.DROPBOX_APP_KEY ||
    !process.env.DROPBOX_APP_SECRET ||
    !process.env.DROPBOX_REFRESH_TOKEN
  ) {
    console.error("⚠️ 歸檔模組未啟用：LINE channel 已設定但缺 Dropbox 金鑰（DROPBOX_APP_KEY / DROPBOX_APP_SECRET / DROPBOX_REFRESH_TOKEN）");
    return;
  }

  const client = new line.messagingApi.MessagingApiClient({ channelAccessToken });
  const blobClient = new line.messagingApi.MessagingApiBlobClient({ channelAccessToken });

  app.post(
    "/archive/webhook",
    line.middleware({ channelSecret, channelAccessToken }),
    async (req, res) => {
      res.sendStatus(200);
      for (const event of req.body.events || []) {
        try {
          await handleArchiveEvent(client, blobClient, event);
        } catch (err) {
          console.error("🗂 歸檔事件處理錯誤：", err.response?.data || err);
          await alertAdmin(client, `⚠️ 歸檔失敗：${describeEvent(event)}\n請到 LINE 對話確認檔案是否需要手動另存。`);
        }
      }
    }
  );

  console.log(`🗂 歸檔模組已啟用 → ${ARCHIVE_ROOT}`);
}

async function handleArchiveEvent(client, blobClient, event) {
  // bot 被拉進群組 → 打聲招呼，讓所內同仁確認歸檔已生效
  if (event.type === "join" && event.replyToken) {
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [
        {
          type: "text",
          text: "🗂 泓品法律事務所檔案保存服務已啟用。\n本群組傳送的圖片與檔案將自動保存，避免因 LINE 檔案過期而遺失。",
        },
      ],
    });
    return;
  }

  if (event.type !== "message" || !ARCHIVED_TYPES.has(event.message?.type)) return;

  const folder = await resolveFolder(client, event.source);
  const buffer = await withRetry(
    () => collectStream(blobClient.getMessageContent(event.message.id)),
    3
  );
  const senderName = await getSenderName(client, event.source);
  const fileName = buildFileName(event, senderName);
  const path = `${ARCHIVE_ROOT}/${folder}/${fileName}`;

  await withRetry(() => dropbox.uploadFile(path, buffer), 3);
  console.log(`🗂 已歸檔：${path}（${(buffer.length / 1024).toFixed(0)} KB）`);
}

// ── 資料夾解析（每個群組/私訊一夾，改名不斷檔）────────────
// 對照表存在 Dropbox 的 .group-map.json，Railway 重啟也不會遺失。
// 結構：{ "group:C1234...": "王小明委任案件討論群", "user:U5678...": "林太太_私訊" }
let groupMapCache = null;

async function loadGroupMap() {
  if (groupMapCache) return groupMapCache;
  groupMapCache = (await dropbox.downloadJson(GROUP_MAP_PATH)) || {};
  return groupMapCache;
}

async function saveGroupMap() {
  await dropbox.uploadJson(GROUP_MAP_PATH, groupMapCache);
}

async function resolveFolder(client, source) {
  const map = await loadGroupMap();

  let key;
  let desiredName;

  if (source.type === "group") {
    key = `group:${source.groupId}`;
    try {
      const summary = await client.getGroupSummary(source.groupId);
      desiredName = sanitizeName(summary.groupName);
    } catch {
      desiredName = map[key] || `群組_${source.groupId.slice(-6)}`;
    }
  } else if (source.type === "room") {
    // 多人聊天室沒有名稱
    key = `room:${source.roomId}`;
    desiredName = map[key] || `聊天室_${source.roomId.slice(-6)}`;
  } else {
    // 1對1 私訊官方帳號
    key = `user:${source.userId}`;
    try {
      const profile = await client.getProfile(source.userId);
      desiredName = `${sanitizeName(profile.displayName)}_私訊`;
    } catch {
      desiredName = map[key] || `私訊_${source.userId.slice(-6)}`;
    }
  }

  const current = map[key];

  if (!current) {
    map[key] = desiredName;
    await saveGroupMap();
    return desiredName;
  }

  if (current !== desiredName) {
    // 群組改名（或使用者改暱稱）→ 把整個資料夾一起改名，檔案不分家
    const moved = await dropbox
      .moveFolder(`${ARCHIVE_ROOT}/${current}`, `${ARCHIVE_ROOT}/${desiredName}`)
      .catch((err) => {
        console.error("🗂 資料夾改名失敗，沿用舊名：", err.response?.data || err.message);
        return false;
      });
    if (moved) {
      map[key] = desiredName;
      await saveGroupMap();
      console.log(`🗂 資料夾改名：${current} → ${desiredName}`);
      return desiredName;
    }
    return current;
  }

  return current;
}

// ── 檔名 ─────────────────────────────────────────────
function buildFileName(event, senderName) {
  const ts = taipeiTimestamp(event.timestamp);
  const msg = event.message;

  let base;
  if (msg.type === "image") base = `圖片_${msg.id}.jpg`;
  else if (msg.type === "video") base = `影片_${msg.id}.mp4`;
  else if (msg.type === "audio") base = `語音_${msg.id}.m4a`;
  else base = sanitizeName(msg.fileName) || `檔案_${msg.id}`;

  return `${ts}_${senderName}_${base}`;
}

async function getSenderName(client, source) {
  try {
    if (source.type === "group") {
      const p = await client.getGroupMemberProfile(source.groupId, source.userId);
      return sanitizeName(p.displayName);
    }
    if (source.type === "room") {
      const p = await client.getRoomMemberProfile(source.roomId, source.userId);
      return sanitizeName(p.displayName);
    }
    const p = await client.getProfile(source.userId);
    return sanitizeName(p.displayName);
  } catch {
    return "成員";
  }
}

// 檔名/資料夾名消毒：防路徑穿越與 Dropbox/Windows 不允許的字元
function sanitizeName(name) {
  if (!name) return "";
  return (
    String(name)
      .replace(/[\\/:*?"<>|]/g, "_") // 路徑與保留字元
      .replace(/[\u0000-\u001f\u007f]/g, "") // 控制字元
      .replace(/\.\.+/g, "_") // 連續點（防 ../）
      .replace(/^[.\s]+|[.\s]+$/g, "") // 頭尾的點與空白
      .slice(0, 80) || ""
  );
}

function taipeiTimestamp(ms) {
  const d = new Date(ms);
  const date = d.toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });
  const time = d
    .toLocaleTimeString("zh-TW", {
      timeZone: "Asia/Taipei",
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    })
    .replace(":", "");
  return `${date}_${time}`;
}

// ── 工具 ─────────────────────────────────────────────
async function collectStream(streamPromise) {
  const stream = await streamPromise;
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

async function withRetry(fn, times) {
  const delays = [1000, 3000, 7000];
  let lastErr;
  for (let i = 0; i < times; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < times - 1) await new Promise((r) => setTimeout(r, delays[i] || 5000));
    }
  }
  throw lastErr;
}

async function alertAdmin(client, text) {
  const adminId = process.env.ARCHIVE_ALERT_USER_ID;
  if (!adminId) return;
  try {
    await client.pushMessage({ to: adminId, messages: [{ type: "text", text }] });
  } catch (err) {
    console.error("🗂 推播警示失敗：", err.response?.data || err.message);
  }
}

function describeEvent(event) {
  const type = event.message?.type || event.type;
  const src = event.source?.type || "unknown";
  return `類型 ${type}（來源 ${src}）`;
}

module.exports = { registerArchiveBot };
