import websocket from "@fastify/websocket";
import { project, projectEvent, type GameEvent } from "@kf/engine";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { readSession } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { ClientCommandSchema, CreateHeroSchema, CreateSessionSchema } from "./commandSchema.js";
import { createHero, EXPEDITION_BIOMES, expeditionsUnlocked, goldBalance, heroView, listHeroes, officialCatalog } from "./progress.js";
import { equip, itemView, listInventory, unequip } from "./inventory.js";
import { buyListing, cancelListing, createListing, listMarket } from "./market.js";
import { Hub, type HubClient } from "./hub.js";
import type { GameService, SubmitResult } from "./service.js";
import { createTable, joinTable, leaveTable, setReady, startTable, tableView } from "./tables.js";

const uuid = z.string().uuid();

export interface Notifier {
  /** Напоминание о ходе (асинхронный стол): по одному на таймер. */
  turn(userIds: string[], sessionId: string, title: string): Promise<void>;
}

export interface GameRouteDeps {
  notifier?: Notifier;
  db: Db;
  game: GameService;
  hub: Hub;
  secret: string;
  botUsername?: string;
  nowSec: () => number;
  requireSession: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

function ack(r: SubmitResult, commandId: string, viewerId: string) {
  if (!r.ok) return { ok: false, commandId, error: r.code, message: r.message, seq: r.seq };
  return {
    ok: true,
    commandId,
    duplicate: r.duplicate,
    seq: r.seq,
    events: r.events.map((e) => projectEvent(e, viewerId)).filter((e): e is GameEvent => e !== null),
    state: project(r.state, viewerId),
  };
}

export async function gameRoutes(app: FastifyInstance, d: GameRouteDeps): Promise<void> {
  const { game, hub } = d;
  /** После хода: рассылка проекций и напоминания тем, чей ход (только асинхронные столы). */
  const after = (sessionId: string, r: SubmitResult, actorId: string) => {
    if (!r.ok || r.duplicate) return;
    hub.publish(sessionId, r.seq, r.events, r.state);
    if (r.turnStarted && r.turnStarted.timerSec >= 3600 && d.notifier) {
      const waiting = r.state.heroes.filter((h) => h.status === "up" && !h.ready && h.ownerId !== actorId).map((h) => h.ownerId);
      if (waiting.length) void d.notifier.turn([...new Set(waiting)], sessionId, r.state.title).catch(() => {});
    }
  };
  app.decorate("hub", hub);

  app.get("/heroes", { preHandler: d.requireSession }, async (req) => ({
    heroes: (await listHeroes(d.db, req.session!.uid)).map(heroView),
    gold: await goldBalance(d.db, req.session!.uid),
  }));

  app.post("/heroes", { preHandler: d.requireSession, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = CreateHeroSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const [u] = await d.db.select({ firstName: users.firstName }).from(users).where(eq(users.id, req.session!.uid));
    const r = await createHero(d.db, req.session!.uid, body.data.classId, body.data.name ?? u?.firstName ?? "Герой");
    if (r === "slots_full") return reply.code(409).send({ error: "slots_full" });
    return heroView(r);
  });

  app.get("/dungeons", { preHandler: d.requireSession }, async (req) => ({
    official: await officialCatalog(d.db, req.session!.uid),
    expeditions: { unlocked: await expeditionsUnlocked(d.db, req.session!.uid), biomes: EXPEDITION_BIOMES },
  }));

  app.get("/inventory", { preHandler: d.requireSession }, async (req) => ({
    items: (await listInventory(d.db, req.session!.uid)).map(itemView),
    gold: await goldBalance(d.db, req.session!.uid),
  }));

  app.post<{ Params: { id: string } }>("/heroes/:id/equip", { preHandler: d.requireSession }, async (req, reply) => {
    const body = z.object({ itemId: z.string().uuid() }).safeParse(req.body);
    if (!body.success || !uuid.safeParse(req.params.id).success) return reply.code(400).send({ error: "bad_request" });
    const err = await equip(d.db, req.session!.uid, req.params.id, body.data.itemId);
    return err ? reply.code(409).send({ error: err }) : { ok: true };
  });

  app.post("/items/unequip", { preHandler: d.requireSession }, async (req, reply) => {
    const body = z.object({ itemId: z.string().uuid() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const err = await unequip(d.db, req.session!.uid, body.data.itemId);
    return err ? reply.code(409).send({ error: err }) : { ok: true };
  });

  app.get<{ Querystring: { slot?: string; rarity?: string } }>("/market", { preHandler: d.requireSession }, async (req) => ({
    listings: await listMarket(d.db, { slot: req.query.slot, rarity: req.query.rarity }),
  }));

  app.post("/market", { preHandler: d.requireSession, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = z.object({ itemId: z.string().uuid(), price: z.number().int() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const r = await createListing(d.db, req.session!.uid, body.data.itemId, body.data.price);
    return typeof r === "string" ? reply.code(409).send({ error: r }) : r;
  });

  app.post<{ Params: { id: string } }>("/market/:id/buy", { preHandler: d.requireSession, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success) return reply.code(404).send({ error: "no_listing" });
    const r = await buyListing(d.db, req.session!.uid, req.params.id);
    return typeof r === "string" ? reply.code(409).send({ error: r }) : r;
  });

  app.post<{ Params: { id: string } }>("/market/:id/cancel", { preHandler: d.requireSession }, async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success) return reply.code(404).send({ error: "no_listing" });
    const r = await cancelListing(d.db, req.session!.uid, req.params.id);
    return r ? reply.code(409).send({ error: r }) : { ok: true };
  });

  app.post("/sessions", { preHandler: d.requireSession, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = CreateSessionSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const uid = req.session!.uid;
    let target: { kind: "official"; dungeonId: string } | { kind: "expedition"; biome: string };
    if (body.data.biome) {
      if (!(await expeditionsUnlocked(d.db, uid))) return reply.code(403).send({ error: "locked" });
      target = { kind: "expedition", biome: body.data.biome };
    } else {
      const dungeon = (await officialCatalog(d.db, uid)).find((x) => x.id === body.data.dungeonId);
      if (!dungeon) return reply.code(404).send({ error: "no_dungeon" });
      if (!dungeon.unlocked) return reply.code(403).send({ error: "locked" });
      target = { kind: "official", dungeonId: dungeon.id };
    }
    const r = await game.create([{ userId: uid, heroId: body.data.heroId }], target);
    if ("error" in r) return reply.code(409).send({ error: r.error });
    return { sessionId: r.id };
  });

  // ───────── Столы (партии) ─────────
  app.post("/tables", { preHandler: d.requireSession, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = z.object({ biome: z.string(), mode: z.enum(["live", "async"]).default("live"), heroId: z.string().uuid().optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const t = await createTable(d.db, req.session!.uid, body.data);
    if (typeof t === "string") return reply.code(409).send({ error: t });
    return { tableId: t.id };
  });
  app.get<{ Params: { id: string } }>("/tables/:id", { preHandler: d.requireSession }, async (req, reply) => {
    if (!uuid.safeParse(req.params.id).success) return reply.code(404).send({ error: "no_table" });
    const v = await tableView(d.db, req.params.id, req.session!.uid);
    if (!v) return reply.code(404).send({ error: "no_table" });
    return { ...v, inviteUrl: d.botUsername ? `https://t.me/${d.botUsername}?startapp=t_${v.id}` : null };
  });
  const tableAction = (fn: (uid: string, id: string, body: Record<string, unknown>) => Promise<unknown>) =>
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!uuid.safeParse(req.params.id).success) return reply.code(404).send({ error: "no_table" });
      const r = await fn(req.session!.uid, req.params.id, (req.body ?? {}) as Record<string, unknown>);
      if (typeof r === "string") return reply.code(409).send({ error: r });
      if (r && typeof r === "object" && "error" in r) return reply.code(409).send(r);
      return r ?? { ok: true };
    };
  app.post<{ Params: { id: string } }>("/tables/:id/join", { preHandler: d.requireSession }, tableAction(async (uid, id, b) => (uuid.safeParse(b.heroId).success ? joinTable(d.db, uid, id, String(b.heroId)) : "no_hero")));
  app.post<{ Params: { id: string } }>("/tables/:id/leave", { preHandler: d.requireSession }, tableAction((uid, id) => leaveTable(d.db, uid, id)));
  app.post<{ Params: { id: string } }>("/tables/:id/ready", { preHandler: d.requireSession }, tableAction((uid, id, b) => setReady(d.db, uid, id, !!b.ready)));
  app.post<{ Params: { id: string } }>("/tables/:id/start", { preHandler: d.requireSession }, tableAction((uid, id) => startTable(d.db, game, uid, id)));

  app.get("/sessions/active", { preHandler: d.requireSession }, async (req) => ({
    sessionId: await game.latestActive(req.session!.uid),
  }));

  app.get<{ Params: { id: string }; Querystring: { sinceSeq?: string } }>(
    "/sessions/:id/state",
    { preHandler: d.requireSession },
    async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success) return reply.code(404).send({ error: "not_found" });
      const since = Number(req.query.sinceSeq ?? 0) || 0;
      const v = await game.view(req.params.id, req.session!.uid, since);
      if (!v) return reply.code(404).send({ error: "not_found" });
      return v;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/sessions/:id/commands",
    { preHandler: d.requireSession, config: { rateLimit: { max: 60, timeWindow: "10 seconds" } } },
    async (req, reply) => {
      if (!uuid.safeParse(req.params.id).success) return reply.code(404).send({ error: "not_found" });
      const cmd = ClientCommandSchema.safeParse(req.body);
      if (!cmd.success) return reply.code(400).send({ error: "bad_command" });
      const uid = req.session!.uid;
      const r = await game.submit(req.params.id, uid, cmd.data);
      after(req.params.id, r, uid);
      return reply.code(r.ok ? 200 : r.status).send(ack(r, cmd.data.commandId, uid));
    },
  );

  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });

  /**
   * Протокол WebSocket:
   *  → {t:"auth", token}            ← {t:"authed"}
   *  → {t:"sub", sessionId, sinceSeq} ← {t:"sync", ...SessionView}
   *  → {t:"cmd", sessionId, command}  ← {t:"ack", ...}; всем участникам ← {t:"events", ...}
   *  → {t:"ping"}                   ← {t:"pong"}
   */
  app.get("/ws", { websocket: true }, (socket, req) => {
    let userId: string | null = null;
    const client: HubClient = {
      get userId() {
        return userId ?? "";
      },
      send: (msg) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      },
    };
    let budget = 30;
    const refill = setInterval(() => (budget = Math.min(30, budget + 10)), 5000);
    const authTimer = setTimeout(() => !userId && socket.close(4001, "auth timeout"), 10000);

    socket.on("message", async (raw: Buffer) => {
      if (--budget < 0) return client.send({ t: "error", error: "rate_limited" });
      let msg: { t?: string; token?: string; sessionId?: string; sinceSeq?: number; command?: unknown };
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return client.send({ t: "error", error: "bad_json" });
      }
      try {
        if (msg.t === "ping") return client.send({ t: "pong" });
        if (msg.t === "auth") {
          const s = typeof msg.token === "string" ? readSession(msg.token, d.secret, d.nowSec()) : null;
          if (!s) return socket.close(4001, "unauthorized");
          userId = s.uid;
          clearTimeout(authTimer);
          return client.send({ t: "authed" });
        }
        if (!userId) return socket.close(4001, "unauthorized");
        if (!msg.sessionId || !uuid.safeParse(msg.sessionId).success) return client.send({ t: "error", error: "bad_session" });

        if (msg.t === "sub") {
          const v = await game.view(msg.sessionId, userId, Number(msg.sinceSeq ?? 0) || 0);
          if (!v) return client.send({ t: "error", error: "not_found", sessionId: msg.sessionId });
          hub.subscribe(msg.sessionId, client);
          return client.send({ t: "sync", ...v });
        }
        if (msg.t === "cmd") {
          const cmd = ClientCommandSchema.safeParse(msg.command);
          if (!cmd.success) return client.send({ t: "ack", ok: false, error: "bad_command" });
          const r = await game.submit(msg.sessionId, userId, cmd.data);
          client.send({ t: "ack", ...ack(r, cmd.data.commandId, userId) });
          after(msg.sessionId, r, userId);
          return;
        }
        client.send({ t: "error", error: "unknown_message" });
      } catch (e) {
        req.log.error(e, "ws message failed");
        client.send({ t: "error", error: "internal" });
      }
    });

    socket.on("close", () => {
      clearInterval(refill);
      clearTimeout(authTimer);
      hub.dropClient(client);
    });
  });
}
