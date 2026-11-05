import { botStep, verifyJournal, type CommandBody } from "@kf/engine";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { signInitData } from "./auth/initData.js";
import { createDb, runMigrations } from "./db/client.js";
import { loadEnv } from "./env.js";

const url = process.env.TEST_DATABASE_URL;
const TOKEN = "123456:TEST-token-abcdefghijklmnopqrstuvwxyz";

describe.skipIf(!url)("партии: журнал, команды, синхронизация", () => {
  const env = loadEnv({ NODE_ENV: "test", DATABASE_URL: url!, BOT_TOKEN: TOKEN, BOT_USERNAME: "kf_test_bot", SESSION_SECRET: "t".repeat(40) });
  const { db, close } = createDb(url!);
  let app: Awaited<ReturnType<typeof buildApp>>;

  const login = async (tgId: number) => {
    const initData = signInitData(
      { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: tgId, first_name: `U${tgId}` }) },
      TOKEN,
    );
    const r = await app.inject({ method: "POST", url: "/auth/telegram", payload: { initData } });
    return r.json().token as string;
  };
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  async function newHero(token: string, classId = "guardian") {
    const r = await app.inject({ method: "POST", url: "/heroes", headers: auth(token), payload: { classId } });
    expect(r.statusCode).toBe(200);
    return r.json().id as string;
  }
  async function newSession(token: string, classId = "guardian", dungeonId = "tavern_cellar") {
    const heroId = await newHero(token, classId);
    const r = await app.inject({ method: "POST", url: "/sessions", headers: auth(token), payload: { heroId, dungeonId } });
    expect(r.statusCode).toBe(200);
    return r.json().sessionId as string;
  }
  async function getState(token: string, id: string, since = 0) {
    return app.inject({ method: "GET", url: `/sessions/${id}/state?sinceSeq=${since}`, headers: auth(token) });
  }
  async function send(token: string, id: string, body: CommandBody, expectedSeq: number, commandId = randomUUID()) {
    return app.inject({ method: "POST", url: `/sessions/${id}/commands`, headers: auth(token), payload: { ...body, commandId, expectedSeq } });
  }

  beforeAll(async () => {
    await runMigrations(url!);
    app = await buildApp({ env, db });
    await app.ready();
  });
  beforeEach(async () => {
    await db.execute(sql`truncate gold_ledger, heroes, session_commands, session_snapshots, session_events, sessions, analytics_events, users restart identity cascade`);
    app.game.dropCache();
  });
  afterAll(async () => {
    await app?.close();
    await close();
  });

  it("создание партии, проекция без скрытого, без зерна", async () => {
    const tok = await login(1);
    const id = await newSession(tok);
    const v = (await getState(tok, id)).json();
    expect(v.seq).toBeGreaterThan(1);
    expect(v.seed).toBeNull();
    expect(v.seedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(v.state.objects.map((o: { id: string }) => o.id)).not.toContain("trap_store");
    expect(v.state).not.toHaveProperty("def");
    expect(v.state.story[0]).toContain("Мирон");
    expect(v.state).not.toHaveProperty("rngCounter");
    expect((await app.inject({ method: "GET", url: "/sessions/active", headers: auth(tok) })).json().sessionId).toBe(id);
  });

  it("чужой игрок не видит партию и не может ходить", async () => {
    const a = await login(1);
    const b = await login(2);
    const id = await newSession(a);
    expect((await getState(b, id)).statusCode).toBe(404);
    expect((await send(b, id, { type: "MOVE", heroId: "h1", x: 3, y: 3 }, 1)).statusCode).toBe(403);
  });

  it("idempotency по commandId и проверка expectedSeq", async () => {
    const tok = await login(1);
    const id = await newSession(tok);
    const cid = randomUUID();
    const seq0 = (await getState(tok, id)).json().seq;
    const r1 = await send(tok, id, { type: "MOVE", heroId: "h1", x: 4, y: 3 }, seq0, cid);
    expect(r1.statusCode).toBe(200);
    const r2 = await send(tok, id, { type: "MOVE", heroId: "h1", x: 4, y: 3 }, seq0, cid);
    expect(r2.json().duplicate).toBe(true);
    expect(r2.json().events).toEqual(r1.json().events);
    const stale = await send(tok, id, { type: "SEARCH", heroId: "h1" }, seq0);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: "stale_seq", seq: r1.json().seq });
    const bad = await send(tok, id, { type: "MOVE", heroId: "h1", x: 12, y: 2 }, r1.json().seq);
    expect(bad.statusCode).toBe(422);
  });

  it("полный поход: снимки, награды, восстановление из журнала после рестарта, проверка зерна", async () => {
    const tok = await login(1);
    const id = await newSession(tok, "sorcerer");
    let seq = (await getState(tok, id)).json().seq as number;
    const latencies: number[] = [];
    const memo = { searches: new Set<string>() };
    for (let guard = 0; guard < 1500; guard++) {
      const full = await app.game.fullState(id);
      if (!full || full.phase === "ended") break;
      const c = botStep(full, "h1", memo);
      if (!c) break;
      const t0 = performance.now();
      const r = await send(tok, id, c, seq);
      latencies.push(performance.now() - t0);
      expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
      seq = r.json().seq;
    }
    const end = (await getState(tok, id)).json();
    expect(end.state.phase).toBe("ended");
    expect(end.seed).toMatch(/^[0-9a-f]{16}$/);
    expect(createHash("sha256").update(end.seed).digest("hex")).toBe(end.seedHash);

    // Награды: опыт герою, золото через журнал, герой свободен.
    const hs = (await app.inject({ method: "GET", url: "/heroes", headers: auth(tok) })).json();
    expect(hs.heroes[0].status).toBe("alive");
    if (end.state.ended.reason === "victory") {
      expect(hs.heroes[0].level * 1000 + hs.heroes[0].xp).toBeGreaterThan(1000);
      expect(hs.gold).toBeGreaterThan(0);
      const sum = await db.execute(sql`select coalesce(sum(delta),0)::int as n from gold_ledger`);
      expect(sum[0]!.n).toBe(0); // сумма по транзакциям сходится
      const cat = (await app.inject({ method: "GET", url: "/dungeons", headers: auth(tok) })).json().official;
      expect(cat[0]).toMatchObject({ cleared: true });
      expect(cat[1]).toMatchObject({ unlocked: true });
    }

    const snaps = await db.execute(sql`select count(*)::int as n from session_snapshots where session_id = ${id}`);
    expect(snaps[0]!.n).toBeGreaterThan(0);
    const before = await app.game.fullState(id);
    app.game.dropCache();
    expect(await app.game.rebuildFromJournal(id)).toEqual(before);
    expect((await getState(tok, id)).json().state).toEqual(end.state);
    const all = (await getState(tok, id, 0)).json();
    expect(verifyJournal(end.seed, all.events).ok).toBe(true);

    latencies.sort((a, b) => a - b);
    expect(latencies[Math.floor(latencies.length * 0.95)]!).toBeLessThan(150);
  });

  it("обучение открывается по порядку, герой не может быть в двух походах", async () => {
    const tok = await login(1);
    const heroId = await newHero(tok);
    const locked = await app.inject({ method: "POST", url: "/sessions", headers: auth(tok), payload: { heroId, dungeonId: "damp_well" } });
    expect(locked.statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/sessions", headers: auth(tok), payload: { heroId, dungeonId: "tavern_cellar" } })).statusCode).toBe(200);
    const busy = await app.inject({ method: "POST", url: "/sessions", headers: auth(tok), payload: { heroId, dungeonId: "tavern_cellar" } });
    expect(busy.json()).toMatchObject({ error: "hero_busy" });
  });

  it("не больше трёх героев", async () => {
    const tok = await login(1);
    for (let i = 0; i < 3; i++) await newHero(tok);
    expect((await app.inject({ method: "POST", url: "/heroes", headers: auth(tok), payload: { classId: "rogue" } })).statusCode).toBe(409);
  });

  it("переподключение: sinceSeq отдаёт только пропущенные события", async () => {
    const tok = await login(1);
    const id = await newSession(tok);
    const seq0 = (await getState(tok, id)).json().seq;
    const r = await send(tok, id, { type: "MOVE", heroId: "h1", x: 4, y: 3 }, seq0);
    const tail = (await getState(tok, id, seq0)).json();
    expect(tail.events[0].seq).toBe(seq0 + 1);
    expect(tail.events.at(-1).seq).toBe(r.json().seq);
    expect((await getState(tok, id, r.json().seq)).json().events).toEqual([]);
  });

  it("WebSocket: auth, sub, cmd, рассылка", async () => {
    const tok = await login(1);
    const id = await newSession(tok);
    const ws = await app.injectWS("/ws");
    const inbox: Record<string, unknown>[] = [];
    const waitFor = (t: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout ${t}`)), 3000);
        const check = () => {
          const i = inbox.findIndex((m) => m.t === t);
          if (i >= 0) {
            clearTimeout(timer);
            resolve(inbox.splice(i, 1)[0]!);
          } else setTimeout(check, 10);
        };
        check();
      });
    ws.on("message", (d: Buffer) => inbox.push(JSON.parse(d.toString())));
    ws.send(JSON.stringify({ t: "auth", token: tok }));
    await waitFor("authed");
    ws.send(JSON.stringify({ t: "sub", sessionId: id, sinceSeq: 0 }));
    const sync = await waitFor("sync");
    const seq0 = sync.seq as number;
    ws.send(JSON.stringify({ t: "cmd", sessionId: id, command: { type: "MOVE", heroId: "h1", x: 4, y: 3, commandId: randomUUID(), expectedSeq: seq0 } }));
    const ackMsg = await waitFor("ack");
    expect(ackMsg.ok).toBe(true);
    const pushed = await waitFor("events");
    expect((pushed.events as unknown[]).length).toBeGreaterThan(0);
    ws.terminate();
  });

  it("неавторизованный WebSocket закрывается", async () => {
    const ws = await app.injectWS("/ws");
    const closed = new Promise<number>((r) => ws.on("close", (code: number) => r(code)));
    ws.send(JSON.stringify({ t: "sub", sessionId: randomUUID() }));
    expect(await closed).toBe(4001);
  });
});
