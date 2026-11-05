import { BOT_COMMANDS, createBot } from "./index.js";

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN не задан");
const bot = createBot({
  token,
  username: process.env.BOT_USERNAME ?? "",
  appShortName: process.env.MINI_APP_SHORT_NAME ?? "",
  webAppUrl: process.env.PUBLIC_URL,
});
await bot.api.deleteWebhook();
await bot.api.setMyCommands(BOT_COMMANDS);
console.log("bot polling…");
await bot.start();
