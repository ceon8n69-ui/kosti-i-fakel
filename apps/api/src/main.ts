import { createBot, sendTurnReminder, startWebhookBot, type BotConfig } from "@kf/bot";
import { eq, inArray } from "drizzle-orm";
import { buildApp } from "./app.js";
import { createDb, runMigrations } from "./db/client.js";
import { users } from "./db/schema.js";
import { loadEnv } from "./env.js";
import { createTable } from "./game/tables.js";
import { pickLocale } from "./locale.js";

const env = loadEnv();
if (env.RUN_MIGRATIONS) await runMigrations(env.DATABASE_URL);
const { db, close } = createDb(env.DATABASE_URL);

const botCfg: BotConfig = {
  token: env.BOT_TOKEN,
  username: env.BOT_USERNAME,
  appShortName: env.MINI_APP_SHORT_NAME,
  webAppUrl: env.PUBLIC_URL,
  // /table в группе: игрок, позвавший бота, становится хозяином стола.
  createTable: async (from, chatId) => {
    const [u] = await db
      .insert(users)
      .values({ telegramId: BigInt(from.id), firstName: from.first_name, lastName: from.last_name ?? null, username: from.username ?? null, language: pickLocale(from.language_code) })
      .onConflictDoUpdate({ target: users.telegramId, set: { firstName: from.first_name } })
      .returning();
    const t = await createTable(db, u!.id, { biome: "forest", mode: "async", chatId: BigInt(chatId) });
    return typeof t === "string" ? null : t.id;
  },
};

let botWebhook: ((u: unknown) => Promise<void>) | undefined;
let bot: ReturnType<typeof createBot> | null = null;
if (env.BOT_MODE === "webhook") {
  const started = await startWebhookBot(botCfg, new URL("/bot/webhook", env.PUBLIC_URL!).toString(), env.WEBHOOK_SECRET!);
  botWebhook = started.handle;
  bot = started.bot;
}

const app = await buildApp({
  env,
  db,
  botWebhook,
  notifier: {
    async turn(userIds, sessionId, title) {
      if (!bot) return;
      const rows = await db.select({ tg: users.telegramId, settings: users.settings }).from(users).where(inArray(users.id, userIds));
      for (const r of rows) {
        if ((r.settings as { notifyTurn?: boolean }).notifyTurn === false) continue;
        await sendTurnReminder(bot, botCfg, Number(r.tg), `Твой ход в походе «${title}». Партия ждёт.`).catch(() => {});
      }
      void sessionId;
    },
  },
});
await app.listen({ port: env.PORT, host: "0.0.0.0" });

// Таймеры ходов: хранятся в БД (sessions.turn_deadline) и исполняются здесь — переживают рестарт.
// Один экземпляр API; при масштабировании переносится в отдельный воркер.
const timer = setInterval(async () => {
  try {
    for (const { id } of await app.game.dueTimers()) {
      const r = await app.game.timeout(id);
      if (r.ok) app.hub.publish(id, r.seq, r.events, r.state);
    }
  } catch (e) {
    app.log.error(e, "timer tick failed");
  }
}, 5000);

for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, async () => {
    app.log.info({ sig }, "shutting down");
    clearInterval(timer);
    await app.close();
    await close();
    process.exit(0);
  });
void eq;
