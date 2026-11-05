import { Bot, InlineKeyboard } from "grammy";
import type { Update } from "grammy/types";
import { t } from "./texts.js";

export interface BotConfig {
  token: string;
  username: string;
  /** Короткое имя Mini App из /newapp. Пусто — используется Main App бота (t.me/<bot>?startapp=). */
  appShortName: string;
  /** https-адрес Mini App. Если задан, в личке используется кнопка web_app. */
  webAppUrl?: string;
}

const START_PARAM_RE = /^(t|d|f|r)_[A-Za-z0-9_-]{1,60}$/;

/** Прямая ссылка на Mini App. В группах только она: кнопки web_app там не работают. */
export function directLink(cfg: Pick<BotConfig, "username" | "appShortName">, startParam?: string): string {
  const base = cfg.appShortName
    ? `https://t.me/${cfg.username}/${cfg.appShortName}`
    : `https://t.me/${cfg.username}`;
  const sp = startParam && START_PARAM_RE.test(startParam) ? startParam : "";
  // Для Main App параметр startapp обязателен (может быть пустым), иначе откроется чат с ботом.
  if (!cfg.appShortName) return `${base}?startapp${sp ? `=${sp}` : ""}`;
  return sp ? `${base}?startapp=${sp}` : base;
}

export function openButton(cfg: BotConfig, chatType: string | undefined, startParam?: string): InlineKeyboard {
  if (chatType === "private" && cfg.webAppUrl) {
    const url = new URL(cfg.webAppUrl);
    if (startParam && START_PARAM_RE.test(startParam)) url.searchParams.set("tgWebAppStartParam", startParam);
    return new InlineKeyboard().webApp(t("start.open"), url.toString());
  }
  return new InlineKeyboard().url(t("start.open"), directLink(cfg, startParam));
}

export function createBot(cfg: BotConfig): Bot {
  const bot = new Bot(cfg.token);

  bot.command("start", async (ctx) => {
    const payload = ctx.match?.trim() || undefined;
    await ctx.reply(t("start.greeting"), { reply_markup: openButton(cfg, ctx.chat.type, payload) });
  });

  bot.command("help", (ctx) => ctx.reply(t("help.text")));

  bot.command("table", async (ctx) => {
    if (ctx.chat.type === "private") return ctx.reply(t("table.privateOnly"));
    // Этап 0: стол ещё не создаётся в БД, кнопка просто открывает игру. Полная логика — этап 2.
    await ctx.reply(t("table.created"), {
      reply_markup: new InlineKeyboard().url(t("table.join"), directLink(cfg)),
    });
  });

  bot.command("terms", (ctx) => ctx.reply(t("terms.text")));
  bot.command("paysupport", (ctx) => ctx.reply(t("paysupport.text")));

  bot.catch((err) => {
    console.error("bot error", err.error);
  });

  return bot;
}

export const BOT_COMMANDS = [
  { command: "start", description: "Открыть игру" },
  { command: "help", description: "Помощь" },
  { command: "table", description: "Создать стол в группе" },
  { command: "terms", description: "Условия использования" },
  { command: "paysupport", description: "Помощь с оплатой" },
];

export async function startWebhookBot(cfg: BotConfig, webhookUrl: string, secret: string) {
  const bot = createBot(cfg);
  await bot.init();
  await bot.api.setWebhook(webhookUrl, {
    secret_token: secret,
    allowed_updates: ["message", "callback_query", "inline_query", "pre_checkout_query"],
  });
  await bot.api.setMyCommands(BOT_COMMANDS);
  return { bot, handle: (update: unknown) => bot.handleUpdate(update as Update) };
}
