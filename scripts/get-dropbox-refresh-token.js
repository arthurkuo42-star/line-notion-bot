// 一次性工具：取得 Dropbox refresh token（永久有效）
// 用法：node scripts/get-dropbox-refresh-token.js
// 跟著提示貼上 App Key、App Secret、授權碼即可。
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  console.log("=== Dropbox Refresh Token 取得工具 ===\n");
  console.log("前置：先到 https://www.dropbox.com/developers/apps 建立 App");
  console.log("（Scoped access → Full Dropbox → Permissions 勾 files.content.write、files.content.read）\n");

  const appKey = (await rl.question("1️⃣ 貼上 App key：")).trim();
  const appSecret = (await rl.question("2️⃣ 貼上 App secret：")).trim();

  const authUrl =
    `https://www.dropbox.com/oauth2/authorize?client_id=${encodeURIComponent(appKey)}` +
    `&response_type=code&token_access_type=offline`;

  console.log(`\n3️⃣ 用瀏覽器開這個網址，登入事務所的 Dropbox 帳號並按「允許」：\n\n${authUrl}\n`);
  const code = (await rl.question("4️⃣ 把畫面顯示的授權碼貼過來：")).trim();
  rl.close();

  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: appKey,
      client_secret: appSecret,
    }),
  });

  const data = await res.json();
  if (!res.ok || !data.refresh_token) {
    console.error("\n❌ 失敗：", JSON.stringify(data, null, 2));
    console.error("授權碼只能用一次且很快過期，請重跑本工具再試。");
    process.exit(1);
  }

  console.log("\n✅ 成功！請把下面三個值填進 Railway 的環境變數（不要存進程式碼或傳給任何人）：\n");
  console.log(`DROPBOX_APP_KEY=${appKey}`);
  console.log(`DROPBOX_APP_SECRET=${appSecret}`);
  console.log(`DROPBOX_REFRESH_TOKEN=${data.refresh_token}`);
}

main().catch((err) => {
  console.error("❌ 執行錯誤：", err.message);
  process.exit(1);
});
