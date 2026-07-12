// Dropbox 上傳模組（供 archive.js 使用）
// 認證方式：refresh token（永久有效），每次自動換短效 access token
const axios = require("axios");

let cachedToken = null; // { token, expiresAt }

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }

  const res = await axios.post(
    "https://api.dropboxapi.com/oauth2/token",
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: process.env.DROPBOX_REFRESH_TOKEN,
      client_id: process.env.DROPBOX_APP_KEY,
      client_secret: process.env.DROPBOX_APP_SECRET,
    })
  );

  cachedToken = {
    token: res.data.access_token,
    // 提前 5 分鐘視為過期，避免邊界失效
    expiresAt: Date.now() + (res.data.expires_in - 300) * 1000,
  };
  return cachedToken.token;
}

// Dropbox-API-Arg header 只吃 ASCII，中文路徑要轉 \uXXXX
function headerSafeJson(obj) {
  return JSON.stringify(obj).replace(/[\u007f-\uffff]/g, (c) => {
    return "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4);
  });
}

const CHUNK_SIZE = 8 * 1024 * 1024; // 分段上傳每段 8MB
const SESSION_THRESHOLD = 100 * 1024 * 1024; // 超過 100MB 走分段上傳

async function uploadFile(dropboxPath, buffer, { overwrite = false } = {}) {
  const mode = overwrite ? "overwrite" : "add";

  if (buffer.length <= SESSION_THRESHOLD) {
    const token = await getAccessToken();
    const res = await axios.post("https://content.dropboxapi.com/2/files/upload", buffer, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": headerSafeJson({
          path: dropboxPath,
          mode,
          autorename: !overwrite, // 同名檔案自動加 (1)，不覆蓋
          mute: true,
        }),
      },
      maxBodyLength: Infinity,
    });
    return res.data;
  }

  // 大檔分段上傳
  let token = await getAccessToken();
  const startRes = await axios.post(
    "https://content.dropboxapi.com/2/files/upload_session/start",
    buffer.subarray(0, CHUNK_SIZE),
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": headerSafeJson({ close: false }),
      },
      maxBodyLength: Infinity,
    }
  );
  const sessionId = startRes.data.session_id;
  let offset = Math.min(CHUNK_SIZE, buffer.length);

  while (buffer.length - offset > CHUNK_SIZE) {
    token = await getAccessToken();
    await axios.post(
      "https://content.dropboxapi.com/2/files/upload_session/append_v2",
      buffer.subarray(offset, offset + CHUNK_SIZE),
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": headerSafeJson({
            cursor: { session_id: sessionId, offset },
            close: false,
          }),
        },
        maxBodyLength: Infinity,
      }
    );
    offset += CHUNK_SIZE;
  }

  token = await getAccessToken();
  const finishRes = await axios.post(
    "https://content.dropboxapi.com/2/files/upload_session/finish",
    buffer.subarray(offset),
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": headerSafeJson({
          cursor: { session_id: sessionId, offset },
          commit: { path: dropboxPath, mode, autorename: !overwrite, mute: true },
        }),
      },
      maxBodyLength: Infinity,
    }
  );
  return finishRes.data;
}

// 讀 JSON 檔（不存在回傳 null）
async function downloadJson(dropboxPath) {
  const token = await getAccessToken();
  try {
    const res = await axios.post("https://content.dropboxapi.com/2/files/download", null, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Dropbox-API-Arg": headerSafeJson({ path: dropboxPath }),
      },
      responseType: "arraybuffer",
    });
    return JSON.parse(Buffer.from(res.data).toString("utf8"));
  } catch (err) {
    const summary = err.response?.data
      ? Buffer.from(err.response.data).toString("utf8")
      : "";
    if (err.response?.status === 409 && summary.includes("not_found")) return null;
    throw err;
  }
}

async function uploadJson(dropboxPath, obj) {
  const buffer = Buffer.from(JSON.stringify(obj, null, 2), "utf8");
  return uploadFile(dropboxPath, buffer, { overwrite: true });
}

// 搬移/改名資料夾。成功回傳 true；目標已存在等衝突回傳 false（呼叫端沿用舊名）
async function moveFolder(fromPath, toPath) {
  const token = await getAccessToken();
  try {
    await axios.post(
      "https://api.dropboxapi.com/2/files/move_v2",
      { from_path: fromPath, to_path: toPath, autorename: false },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );
    return true;
  } catch (err) {
    const summary = JSON.stringify(err.response?.data || "");
    // 來源不存在（還沒收過檔）→ 視為改名成功，直接用新名字
    if (summary.includes("not_found")) return true;
    // 目標已存在等衝突 → 保守起見沿用舊資料夾
    if (err.response?.status === 409) return false;
    throw err;
  }
}

module.exports = { uploadFile, downloadJson, uploadJson, moveFolder };
