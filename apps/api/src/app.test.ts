import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { signInitData } from "./auth/initData.js";
import { createDb, runMigrations } from "./db/client.js";
import { loadEnv } from "./env.js";

const url = process.env.TEST_DATABASE_URL;
const TOKEN = "123456:TEST-token-abcdefghijklmnopqrstuvwxyz";

describe.skipIf(!url)("API этапа 0 (PostgreSQL)", () => {
  const env = loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: url!,
    BOT_TOKEN: TOKEN,
    BOT_USERNAME: "kf_test_bot",
    SESSION_SECRET: "t".repeat(40),
  });
  const { db, close } = createDb(url!);
  let app: Awaited<ReturnType<typeof buildApp>>;
  const now = () => Math.floor(Date.now() / 1000);
  const user = (id: number) => JSON.stringify({ id, first_name: "Тест", username: "tester", language_code: "ru" });

  beforeAll(async () => {
    await runMigrations(url!);
    app = await buildApp({ env, db });
  });
  beforeEach(async () => {
    await db.execute(sql`truncate analytics_events, users restart identity cascade`);
  });
  afterAll(async () => {
    await app?.close();
    await close();
  });

  it("новый пользователь входит, запись создаётся, /me отдаёт профиль", async () => {
    const initData = signInitData({ auth_date: String(now()), user: user(777), start_param: "r_friend" }, TOKEN);
    const res = await app.inject({ method: "POST", url: "/auth/telegram", payload: { initData } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.telegramId).toBe("777");
    expect(body.startParam).toBe("r_friend");

    const rows = await db.execute(sql`select count(*)::int as n from users where telegram_id = 777`);
    expect(rows[0]!.n).toBe(1);
    const ev = await db.execute(sql`select count(*)::int as n from analytics_events where name = 'app_open'`);
    expect(ev[0]!.n).toBe(1);

    const me = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${body.token}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().firstName).toBe("Тест");
  });

  it("повторный вход не создаёт дубль", async () => {
    for (let i = 0; i < 2; i++) {
      const initData = signInitData({ auth_date: String(now()), user: user(5) }, TOKEN);
      expect((await app.inject({ method: "POST", url: "/auth/telegram", payload: { initData } })).statusCode).toBe(200);
    }
    const rows = await db.execute(sql`select count(*)::int as n from users`);
    expect(rows[0]!.n).toBe(1);
  });

  it("подделанная initData отклоняется и пользователь не создаётся", async () => {
    const good = signInitData({ auth_date: String(now()), user: user(1) }, TOKEN);
    const forged = good.replace("%22id%22%3A1", "%22id%22%3A2");
    expect(forged).not.toBe(good);
    const res = await app.inject({ method: "POST", url: "/auth/telegram", payload: { initData: forged } });
    expect(res.statusCode).toBe(401);
    const rows = await db.execute(sql`select count(*)::int as n from users`);
    expect(rows[0]!.n).toBe(0);
  });

  it("/me без токена — 401", async () => {
    expect((await app.inject({ method: "GET", url: "/me" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/me", headers: { authorization: "Bearer junk.junk" } })).statusCode,
    ).toBe(401);
  });

  it("/health отвечает", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ ok: true });
  });
});

describe("раздача Mini App", () => {
  it("несуществующий ассет — 404, а не index.html; маршруты SPA — index.html", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "kf-web-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>kf</title>");
    mkdirSync(join(dir, "assets"));
    const env = loadEnv({ NODE_ENV: "test", DATABASE_URL: "postgres://x:y@localhost:1/z", BOT_TOKEN: TOKEN, BOT_USERNAME: "b", SESSION_SECRET: "s".repeat(40), WEB_DIST: dir });
    const { db, close } = createDb(env.DATABASE_URL);
    const app = await buildApp({ env, db });
    // файл появился после старта (пересборка) — должен отдаваться
    writeFileSync(join(dir, "assets", "late.js"), "console.log(1)");
    expect((await app.inject("/assets/late.js")).statusCode).toBe(200);
    expect((await app.inject("/assets/missing.js")).statusCode).toBe(404);
    const spa = await app.inject("/tavern");
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain("<title>kf</title>");
    await app.close();
    await close();
  });
});
