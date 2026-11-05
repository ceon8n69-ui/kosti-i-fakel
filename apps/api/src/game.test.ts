import { autoTurn, verifyJournal, type CommandBody, type VisibleState } from "@kf/engine";
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

  async function newSession(token: string, classId = "guardian") {
    const r = await app.inject({ method: "POST", url: "/sessions", headers: auth(token), payload: { classId } });
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
    await db.execute(sql`truncate session_commands, session_snapshots, session_events, sessions, analytics_events, users restart identity cascade`);
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
    expect(v.seq).toBe(1);
    expect(v.seed).toBeNull();
    expect(v.seedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(v.state.objects.map((o: { id: string }) => o.id)).not.toContain("trap_1");
    expect(v.state).not.toHaveProperty("rngCounter");
    expect((await app.inject({ method: "GET", url: "/sessions/active", headers: auth(tok) })).json().sessionId).toBe(id);
  });

  it("чужой игрок не видит партию и не может ходить", async () => {
    const a = await login(1);
    const b = await login(2);
    const id = await newSession(a);
    expect((await getState(b, id)).statusCode).toBe(404);
    expect((await send(b, id, { type: "MOVE", heroId: "h1", objectId: "door_1" }, 1)).statusCode).toBe(403);
  });

  it("idempotency по commandId и проверка expectedSeq", async () => {
    const tok = await login(1);
    const id = await newSession(tok);
    const cid = randomUUID();
    const r1 = await send(tok, id, { type: "MOVE", heroId: "h1", objectId: "door_1" }, 1, cid);
    expect(r1.statusCode).toBe(200);
    const r2 = await send(tok, id, { type: "MOVE", heroId: "h1", objectId: "door_1" }, 1, cid);
    expect(r2.json().duplicate).toBe(true);
    expect(r2.json().events).toEqual(r1.json().events);
    const stale = await send(tok, id, { type: "ROLL_DICE", heroId: "h1" }, 1);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: "stale_seq", seq: r1.json().seq });
    const bad = await send(tok, id, { type: "MOVE", heroId: "h1", objectId: "door_1" }, r1.json().seq);
    expect(bad.statusCode).toBe(422);
  });

  it("полный бой: снимки, восстановление из журнала после рестарта, проверка зерна", async () => {
    const tok = await login(1);
    const id = await newSession(tok, "sorcerer");
    let v = (await getState(tok, id)).json() as { seq: number; state: VisibleState };
    let seq = (await send(tok, id, { type: "MOVE", heroId: "h1", objectId: "door_1" }, v.seq)).json().seq as number;
    const latencies: number[] = [];
    for (let guard = 0; guard < 300; guard++) {
      v = (await getState(tok, id)).json();
      if (v.state.phase === "ended") break;
      // autoTurn работает с полным состоянием; для своего героя проекция совпадает с ним.
      const cmds = autoTurn(v.state as never, "h1");
      for (const c of cmds) {
        const t0 = performance.now();
        const r = await send(tok, id, c, seq);
        latencies.push(performance.now() - t0);
        expect(r.statusCode).toBe(200);
        seq = r.json().seq;
        if (r.json().state.phase === "ended") break;
      }
    }
    const end = (await getState(tok, id)).json();
    expect(end.state.phase).toBe("ended");
    expect(end.seed).toMatch(/^[0-9a-f]{16}$/);
    expect(createHash("sha256").update(end.seed).digest("hex")).toBe(end.seedHash);

    const snaps = await db.execute(sql`select count(*)::int as n from session_snapshots where session_id = ${id}`);
    expect(snaps[0]!.n).toBeGreaterThan(0);

    // «Рестарт»: кэш сброшен, состояние собирается из снимка + хвоста и совпадает с чистым журналом.
    const before = app.game["cache"].get(id);
    app.game.dropCache();
    const fromJournal = await app.game.rebuildFromJournal(id);
    expect(fromJournal).toEqual(before);
    const again = (await getState(tok, id)).json();
    expect(again.state).toEqual(end.state);

    const all = (await getState(tok, id, 0)).json();
    expect(verifyJournal(end.seed, all.events).ok).toBe(true);

    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.floor(latencies.length * 0.95)]!;
    expect(p95).toBeLessThan(150);
  });

  it("переподключение: sinceSeq отдаёт только пропущенные события", async () => {
    const tok = await login(1);
    const id = await newSession(tok);
    const r = await send(tok, id, { type: "MOVE", heroId: "h1", objectId: "door_1" }, 1);
    const tail = (await getState(tok, id, 1)).json();
    expect(tail.events[0].seq).toBe(2);
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
    expect(sync.seq).toBe(1);
    ws.send(JSON.stringify({ t: "cmd", sessionId: id, command: { type: "MOVE", heroId: "h1", objectId: "door_1", commandId: randomUUID(), expectedSeq: 1 } }));
    const ackMsg = await waitFor("ack");
    expect(ackMsg.ok).toBe(true);
    const pushed = await waitFor("events");
    expect((pushed.events as unknown[]).length).toBeGreaterThan(3);
    ws.terminate();
  });

  it("неавторизованный WebSocket закрывается", async () => {
    const ws = await app.injectWS("/ws");
    const closed = new Promise<number>((r) => ws.on("close", (code: number) => r(code)));
    ws.send(JSON.stringify({ t: "sub", sessionId: randomUUID() }));
    expect(await closed).toBe(4001);
  });
});
