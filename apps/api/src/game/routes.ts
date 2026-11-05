import websocket from "@fastify/websocket";
import { project, projectEvent, type GameEvent } from "@kf/engine";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { readSession } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { ClientCommandSchema, CreateSessionSchema } from "./commandSchema.js";
import { Hub, type HubClient } from "./hub.js";
import type { GameService, SubmitResult } from "./service.js";

const uuid = z.string().uuid();

export interface GameRouteDeps {
  db: Db;
  game: GameService;
  hub: Hub;
  secret: string;
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

  app.post("/sessions", { preHandler: d.requireSession, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = CreateSessionSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const [u] = await d.db.select({ firstName: users.firstName }).from(users).where(eq(users.id, req.session!.uid));
    const id = await game.create(req.session!.uid, { classId: body.data.classId, name: body.data.name ?? u?.firstName ?? "Герой" });
    return { sessionId: id };
  });

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
      if (r.ok && !r.duplicate) hub.publish(req.params.id, r.seq, r.events, r.state);
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
          if (r.ok && !r.duplicate) hub.publish(msg.sessionId, r.seq, r.events, r.state);
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
