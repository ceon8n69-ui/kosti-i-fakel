import { createHash, randomBytes } from "node:crypto";
import {
  applyCommand,
  openSession,
  project,
  projectEvent,
  replay,
  Rng,
  startSession,
  type Command,
  type GameEvent,
  type SessionState,
  type VisibleState,
} from "@kf/engine";
import { and, asc, desc, eq, gt, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { heroes, sessionCommands, sessionEvents, sessions, sessionSnapshots } from "../db/schema.js";
import { applyResults, type Reward } from "./progress.js";
import { balance, dungeonById } from "@kf/content";
import type { ClientCommand } from "./commandSchema.js";

export const SNAPSHOT_EVERY = 20;

export interface SessionView {
  sessionId: string;
  seq: number;
  state: VisibleState;
  events: GameEvent[];
  seedHash: string;
  /** Зерно — только после окончания похода. */
  seed: string | null;
}

export type SubmitResult =
  | { ok: true; duplicate: boolean; seq: number; events: GameEvent[]; state: SessionState; participants: string[] }
  | { ok: false; status: number; code: string; message?: string; seq?: number };

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Exec = Db | Tx;

const toEvent = (row: { seq: number; type: string; payload: Record<string, unknown> }): GameEvent =>
  ({ ...row.payload, seq: row.seq, type: row.type }) as GameEvent;

const toPayload = (ev: GameEvent): Record<string, unknown> => {
  const { seq: _s, type: _t, ...rest } = ev;
  return rest;
};

export const participantsOf = (s: SessionState): string[] => [...new Set(s.heroes.map((h) => h.ownerId))];

/**
 * Партии и журнал событий. Состояние в памяти — только кэш: источник правды — session_events.
 * Один экземпляр API; блокировка строки sessions сериализует команды одной партии.
 */
export class GameService {
  private cache = new Map<string, SessionState>();

  constructor(private db: Db) {}

  /** Новый поход: герой переходит в статус in_session, журнал открывается вступлением. */
  async create(ownerId: string, heroId: string, dungeonId: string): Promise<{ id: string } | { error: string }> {
    const seed = randomBytes(8).toString("hex");
    const seedHash = createHash("sha256").update(seed).digest("hex");
    return this.db.transaction(async (tx) => {
      const locked = await tx.execute(sql`select * from heroes where id = ${heroId} and user_id = ${ownerId} for update`);
      const h = locked[0] as { id: string; class: string; name: string; level: number; max_hp: number; status: string; consumables_json: string[] } | undefined;
      if (!h) return { error: "no_hero" };
      if (h.status !== "alive") return { error: h.status === "in_session" ? "hero_busy" : "hero_dead" };
      // Герой не может войти в подземелье уровнем ниже своего (ТЗ 5.5).
      const def = dungeonById(dungeonId);
      const tier = balance.tiers.find((t) => t.tier === def?.tier);
      if (!def || !tier) return { error: "no_dungeon" };
      if (h.level > tier.heroLevels[1]) return { error: "tier_too_low" };
      const first = startSession({
        dungeonId,
        seedHash,
        heroes: [{ ownerId, classId: h.class, name: h.name, dbId: h.id, level: h.level, maxHp: h.max_hp, consumables: h.consumables_json }],
      });
      const events = openSession(first, new Rng(seed, 0));
      const last = events[events.length - 1]!;
      const [row] = await tx
        .insert(sessions)
        .values({ ownerId, scenarioId: dungeonId, seed, seedHash, seq: last.seq, heroIds: [h.id] })
        .returning({ id: sessions.id });
      await tx.insert(sessionEvents).values(events.map((e) => ({ sessionId: row!.id, seq: e.seq, type: e.type, payload: toPayload(e), actorId: ownerId })));
      await tx.update(heroes).set({ status: "in_session" }).where(eq(heroes.id, h.id));
      return { id: row!.id };
    });
  }

  /** Полное состояние (с описанием подземелья) — только для тестов и симуляции на сервере. */
  async fullState(sessionId: string): Promise<SessionState | null> {
    const [s] = await this.db.select().from(sessions).where(eq(sessions.id, sessionId));
    return s ? this.load(this.db, sessionId, s.seq) : null;
  }

  async latestActive(ownerId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.ownerId, ownerId), eq(sessions.state, "active")))
      .orderBy(desc(sessions.startedAt))
      .limit(1);
    return row?.id ?? null;
  }

  /** Состояние на текущий seq: кэш, иначе последний снимок + хвост журнала. */
  private async load(ex: Exec, sessionId: string, seq: number): Promise<SessionState> {
    const cached = this.cache.get(sessionId);
    if (cached && cached.seq === seq) return cached;
    const [snap] = await ex
      .select()
      .from(sessionSnapshots)
      .where(and(eq(sessionSnapshots.sessionId, sessionId), lte(sessionSnapshots.seq, seq)))
      .orderBy(desc(sessionSnapshots.seq))
      .limit(1);
    const from = snap ? (snap.state as unknown as SessionState) : undefined;
    const rows = await ex
      .select()
      .from(sessionEvents)
      .where(and(eq(sessionEvents.sessionId, sessionId), gt(sessionEvents.seq, snap?.seq ?? 0), lte(sessionEvents.seq, seq)))
      .orderBy(asc(sessionEvents.seq));
    const state = replay(rows.map(toEvent), from);
    this.cache.set(sessionId, state);
    return state;
  }

  /** Полный пересчёт из журнала без кэша и снимков — для проверки. */
  async rebuildFromJournal(sessionId: string): Promise<SessionState> {
    const rows = await this.db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, sessionId)).orderBy(asc(sessionEvents.seq));
    return replay(rows.map(toEvent));
  }

  dropCache(sessionId?: string): void {
    if (sessionId) this.cache.delete(sessionId);
    else this.cache.clear();
  }

  async view(sessionId: string, viewerId: string, sinceSeq: number): Promise<SessionView | null> {
    const [s] = await this.db.select().from(sessions).where(eq(sessions.id, sessionId));
    if (!s) return null;
    const state = await this.load(this.db, sessionId, s.seq);
    if (!participantsOf(state).includes(viewerId)) return null;
    const rows = await this.db
      .select()
      .from(sessionEvents)
      .where(and(eq(sessionEvents.sessionId, sessionId), gt(sessionEvents.seq, Math.max(0, sinceSeq))))
      .orderBy(asc(sessionEvents.seq))
      .limit(500);
    const events = rows.map(toEvent).map((e) => projectEvent(e, viewerId)).filter((e): e is GameEvent => e !== null);
    return {
      sessionId,
      seq: s.seq,
      state: project(state, viewerId),
      events,
      seedHash: s.seedHash,
      seed: s.state === "ended" ? s.seed : null,
    };
  }

  async submit(sessionId: string, actorId: string, cmd: ClientCommand): Promise<SubmitResult> {
    const result = await this.db
      .transaction(async (tx): Promise<SubmitResult> => {
      const locked = await tx.execute(sql`select seq, seed, state from sessions where id = ${sessionId} for update`);
      const row = locked[0] as { seq: number; seed: string; state: string } | undefined;
      if (!row) return { ok: false, status: 404, code: "not_found" };

      const [dup] = await tx
        .select()
        .from(sessionCommands)
        .where(and(eq(sessionCommands.sessionId, sessionId), eq(sessionCommands.commandId, cmd.commandId)));
      if (dup) {
        if (dup.actorId !== actorId) return { ok: false, status: 409, code: "command_id_taken" };
        const rows = await tx
          .select()
          .from(sessionEvents)
          .where(and(eq(sessionEvents.sessionId, sessionId), gt(sessionEvents.seq, dup.firstSeq - 1), lte(sessionEvents.seq, dup.lastSeq)))
          .orderBy(asc(sessionEvents.seq));
        const state = await this.load(tx, sessionId, row.seq);
        return { ok: true, duplicate: true, seq: row.seq, events: rows.map(toEvent), state, participants: participantsOf(state) };
      }

      const state = await this.load(tx, sessionId, row.seq);
      if (!participantsOf(state).includes(actorId)) return { ok: false, status: 403, code: "not_a_member" };
      if (cmd.expectedSeq !== row.seq) return { ok: false, status: 409, code: "stale_seq", seq: row.seq };

      const command = { ...cmd, actorId } as Command;
      const r = applyCommand(state, command, new Rng(row.seed, state.rngCounter));
      if (r.errors.length) return { ok: false, status: 422, code: r.errors[0]!.code, message: r.errors[0]!.message, seq: row.seq };

      const newSeq = r.state.seq;
      await tx.insert(sessionEvents).values(
        r.events.map((e) => ({ sessionId, seq: e.seq, type: e.type, payload: toPayload(e), actorId })),
      );
      await tx.insert(sessionCommands).values({
        sessionId,
        commandId: cmd.commandId,
        actorId,
        type: cmd.type,
        firstSeq: r.events[0]!.seq,
        lastSeq: newSeq,
      });
      const ended = r.state.phase === "ended";
      await tx
        .update(sessions)
        .set({
          seq: newSeq,
          ...(ended ? { state: "ended", endedReason: r.state.ended?.reason ?? null, endedAt: new Date() } : {}),
        })
        .where(eq(sessions.id, sessionId));
      if (ended) {
        const rw = r.events.find((e) => e.type === "REWARDS") as (Reward & { type: string }) | undefined;
        await applyResults(tx, sessionId, r.state, rw ?? { xp: 0, gold: 0, items: [], reason: r.state.ended?.reason ?? "defeat" });
      }
      if (Math.floor(row.seq / SNAPSHOT_EVERY) !== Math.floor(newSeq / SNAPSHOT_EVERY) || ended)
        await tx.insert(sessionSnapshots).values({ sessionId, seq: newSeq, state: r.state as unknown as Record<string, unknown> });

      return { ok: true, duplicate: false, seq: newSeq, events: r.events, state: r.state, participants: participantsOf(r.state) };
    })
      .catch((e: unknown) => {
        // Транзакция откатилась — кэш мог опередить БД.
        this.cache.delete(sessionId);
        throw e;
      });
    if (result.ok) this.cache.set(sessionId, result.state);
    return result;
  }
}
