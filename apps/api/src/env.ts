import { z } from "zod";

const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_URL: z.string().url(),
  /** Токен бота от @BotFather. Им же подписывается initData. */
  BOT_TOKEN: z.string().min(20),
  /** Имя бота без @ — для прямых ссылок t.me/<bot>/<app>. */
  BOT_USERNAME: z.string().min(1),
  /** Короткое имя Mini App, заданное в @BotFather (/newapp). */
  MINI_APP_SHORT_NAME: z.string().min(1).default("play"),
  /** Публичный https-адрес сервиса (Railway). Нужен для вебхука и кнопки web_app. */
  PUBLIC_URL: z.string().url().optional(),
  /** Секрет для подписи сессионных токенов, минимум 32 символа. */
  SESSION_SECRET: z.string().min(32),
  SESSION_TTL_SEC: z.coerce.number().int().positive().default(3600),
  /** Максимальный возраст initData (auth_date). */
  AUTH_MAX_AGE_SEC: z.coerce.number().int().positive().default(86400),
  /** webhook — прод, polling — локально, off — бот не запускается в этом процессе. */
  BOT_MODE: z.enum(["webhook", "polling", "off"]).default("off"),
  WEBHOOK_SECRET: z.string().min(16).optional(),
  /** Путь к собранной Mini App; если задан, API раздаёт статику. */
  WEB_DIST: z.string().optional(),
  RUN_MIGRATIONS: bool.default(true),
});
export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(src: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(src);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Некорректные переменные окружения: ${issues}`);
  }
  const env = parsed.data;
  if (env.BOT_MODE === "webhook" && (!env.PUBLIC_URL || !env.WEBHOOK_SECRET))
    throw new Error("BOT_MODE=webhook требует PUBLIC_URL и WEBHOOK_SECRET");
  return env;
}
