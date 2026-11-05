import { startWebhookBot } from "@kf/bot";
import { buildApp } from "./app.js";
import { createDb, runMigrations } from "./db/client.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
if (env.RUN_MIGRATIONS) await runMigrations(env.DATABASE_URL);
const { db, close } = createDb(env.DATABASE_URL);

let botWebhook: ((u: unknown) => Promise<void>) | undefined;
if (env.BOT_MODE === "webhook") {
  const { handle } = await startWebhookBot(
    {
      token: env.BOT_TOKEN,
      username: env.BOT_USERNAME,
      appShortName: env.MINI_APP_SHORT_NAME,
      webAppUrl: env.PUBLIC_URL,
    },
    new URL("/bot/webhook", env.PUBLIC_URL!).toString(),
    env.WEBHOOK_SECRET!,
  );
  botWebhook = handle;
}

const app = await buildApp({ env, db, botWebhook });
await app.listen({ port: env.PORT, host: "0.0.0.0" });

for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, async () => {
    app.log.info({ sig }, "shutting down");
    await app.close();
    await close();
    process.exit(0);
  });
