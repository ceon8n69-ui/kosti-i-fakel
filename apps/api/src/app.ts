import { existsSync } from "node:fs";
import { resolve } from "node:path";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { AuthTelegramRequestSchema, type AuthTelegramResponse, type UserProfile } from "@kf/schema";
import { eq, sql } from "drizzle-orm";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { InitDataValidationError, verifyInitData } from "./auth/initData.js";
import { issueSession, readSession, type SessionPayload } from "./auth/session.js";
import type { Db } from "./db/client.js";
import { analyticsEvents, users } from "./db/schema.js";
import type { Env } from "./env.js";
import { pickLocale } from "./locale.js";
import { Hub } from "./game/hub.js";
import { gameRoutes } from "./game/routes.js";
import { GameService } from "./game/service.js";

export interface AppDeps {
  env: Env;
  db: Db;
  /** Обработчик вебхука бота; подключается, если бот работает в режиме webhook. */
  botWebhook?: (update: unknown) => Promise<void>;
  now?: () => number;
  game?: GameService;
  hub?: Hub;
}

type UserRow = typeof users.$inferSelect;

export function toProfile(u: UserRow): UserProfile {
  return {
    id: u.id,
    telegramId: u.telegramId.toString(),
    firstName: u.firstName,
    lastName: u.lastName,
    username: u.username,
    language: pickLocale(u.language),
    timezone: u.timezone,
    authorLevel: u.authorLevel,
    fame: u.fame,
    settings: u.settings,
    createdAt: u.createdAt.toISOString(),
  };
}

declare module "fastify" {
  interface FastifyRequest {
    session?: SessionPayload;
  }
  interface FastifyInstance {
    game: GameService;
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { env, db } = deps;
  const nowSec = () => Math.floor((deps.now?.() ?? Date.now()) / 1000);

  const app = Fastify({
    logger:
      env.NODE_ENV === "test"
        ? false
        : { level: env.LOG_LEVEL, redact: ["req.headers.authorization", "req.body.initData"] },
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });

  // Лимиты считаются по пользователю (подпись токена), а не по IP: игроки за одним NAT не мешают друг другу.
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (req) => {
      const h = req.headers.authorization;
      const s = h?.startsWith("Bearer ") ? readSession(h.slice(7), env.SESSION_SECRET, nowSec()) : null;
      return s ? `u:${s.uid}` : `ip:${req.ip}`;
    },
  });

  app.get("/health", async () => {
    await db.execute(sql`select 1`);
    return { ok: true };
  });

  app.post(
    "/auth/telegram",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = AuthTelegramRequestSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request" });

      let verified;
      try {
        verified = verifyInitData(body.data.initData, env.BOT_TOKEN, {
          maxAgeSec: env.AUTH_MAX_AGE_SEC,
          nowSec: nowSec(),
        });
      } catch (e) {
        if (e instanceof InitDataValidationError) {
          req.log.warn({ code: e.code }, "initData rejected");
          return reply.code(401).send({ error: "invalid_init_data", message: e.code });
        }
        throw e;
      }

      const tg = verified.user;
      const [row] = await db
        .insert(users)
        .values({
          telegramId: BigInt(tg.id),
          firstName: tg.first_name,
          lastName: tg.last_name ?? null,
          username: tg.username ?? null,
          language: pickLocale(tg.language_code),
        })
        .onConflictDoUpdate({
          target: users.telegramId,
          set: {
            firstName: tg.first_name,
            lastName: tg.last_name ?? null,
            username: tg.username ?? null,
            lastSeenAt: new Date(),
          },
        })
        .returning();
      if (!row) throw new Error("upsert user failed");

      await db.insert(analyticsEvents).values({
        userId: row.id,
        name: "app_open",
        payload: { startParam: verified.startParam, chatType: verified.chatType },
      });

      const exp = nowSec() + env.SESSION_TTL_SEC;
      const token = issueSession({ uid: row.id, tg: row.telegramId.toString(), exp }, env.SESSION_SECRET);
      const res: AuthTelegramResponse = {
        token,
        expiresAt: new Date(exp * 1000).toISOString(),
        user: toProfile(row),
        startParam: verified.startParam,
      };
      return res;
    },
  );

  const requireSession = async (req: FastifyRequest, reply: import("fastify").FastifyReply) => {
    const h = req.headers.authorization;
    const token = h?.startsWith("Bearer ") ? h.slice(7) : undefined;
    const s = token ? readSession(token, env.SESSION_SECRET, nowSec()) : null;
    if (!s) return reply.code(401).send({ error: "unauthorized" });
    req.session = s;
  };

  app.get("/me", { preHandler: requireSession }, async (req, reply) => {
    const [row] = await db.select().from(users).where(eq(users.id, req.session!.uid));
    if (!row) return reply.code(401).send({ error: "unauthorized" });
    return toProfile(row);
  });

  const game = deps.game ?? new GameService(db);
  const hub = deps.hub ?? new Hub();
  app.decorate("game", game);
  await gameRoutes(app, { db, game, hub, secret: env.SESSION_SECRET, nowSec, requireSession });

  if (deps.botWebhook) {
    const hook = deps.botWebhook;
    app.post("/bot/webhook", async (req, reply) => {
      const secret = req.headers["x-telegram-bot-api-secret-token"];
      if (secret !== env.WEBHOOK_SECRET) return reply.code(401).send({ error: "unauthorized" });
      await hook(req.body);
      return { ok: true };
    });
  }

  if (env.WEB_DIST) {
    const root = resolve(env.WEB_DIST);
    if (existsSync(root)) {
      // Файлы ищутся на диске при каждом запросе; хешированные ассеты кэшируются надолго.
      await app.register(fastifyStatic, {
        root,
        setHeaders: (res, path) => {
          res.setHeader("cache-control", path.includes(`${"/"}assets${"/"}`) ? "public, max-age=31536000, immutable" : "no-cache");
        },
      });
      app.setNotFoundHandler((req, reply) => {
        const api = ["/auth", "/me", "/sessions", "/ws", "/health", "/bot", "/assets", "/art"];
        if (req.method === "GET" && !api.some((p) => req.url.startsWith(p)))
          return reply.header("cache-control", "no-cache").sendFile("index.html");
        return reply.code(404).send({ error: "not_found" });
      });
    } else {
      app.log.warn({ root }, "WEB_DIST не найден, статика не раздаётся");
    }
  }

  return app;
}
