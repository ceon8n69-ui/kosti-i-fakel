import { balance } from "@kf/content";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { heroes, tableMembers, tables, users } from "../db/schema.js";
import { EXPEDITION_BIOMES } from "./progress.js";
import type { GameService } from "./service.js";

export type TableError = "no_table" | "full" | "started" | "no_hero" | "hero_busy" | "not_member" | "not_host" | "not_ready" | "bad_target" | "in_other_table";

const MAX_PARTY = 4;

export async function createTable(db: Db, userId: string, opts: { biome: string; mode: "live" | "async"; heroId?: string; chatId?: bigint }) {
  if (!EXPEDITION_BIOMES.includes(opts.biome as never)) return "bad_target" as const;
  const timer = opts.mode === "live" ? balance.timers.liveTurnSec : balance.timers.asyncTurnHoursDefault * 3600;
  return db.transaction(async (tx) => {
    const [t] = await tx
      .insert(tables)
      .values({ createdBy: userId, target: opts.biome, mode: opts.mode, turnTimer: timer, chatId: opts.chatId ?? null })
      .returning();
    await tx.insert(tableMembers).values({ tableId: t!.id, userId, heroId: opts.heroId ?? null });
    return t!;
  });
}

export async function tableView(db: Db, tableId: string, viewerId: string) {
  const [t] = await db.select().from(tables).where(eq(tables.id, tableId));
  if (!t) return null;
  const members = await db
    .select({ m: tableMembers, u: users, h: heroes })
    .from(tableMembers)
    .innerJoin(users, eq(users.id, tableMembers.userId))
    .leftJoin(heroes, eq(heroes.id, tableMembers.heroId))
    .where(eq(tableMembers.tableId, tableId))
    .orderBy(tableMembers.joinedAt);
  return {
    id: t.id,
    host: t.createdBy,
    isHost: t.createdBy === viewerId,
    biome: t.target,
    mode: t.mode,
    status: t.status,
    sessionId: t.sessionId,
    joined: members.some((x) => x.m.userId === viewerId),
    members: members.map(({ m, u, h }) => ({
      userId: m.userId,
      name: u.firstName,
      ready: !!m.ready,
      hero: h ? { id: h.id, name: h.name, classId: h.classId, level: h.level } : null,
    })),
  };
}

/** Войти за стол или сменить героя. Один игрок — один герой, до 4 игроков. */
export async function joinTable(db: Db, userId: string, tableId: string, heroId: string): Promise<TableError | null> {
  return db.transaction(async (tx) => {
    const locked = await tx.execute(sql`select * from tables where id = ${tableId} for update`);
    const t = locked[0] as { status: string } | undefined;
    if (!t) return "no_table";
    if (t.status !== "lobby") return "started";
    const [h] = await tx.select().from(heroes).where(and(eq(heroes.id, heroId), eq(heroes.userId, userId)));
    if (!h) return "no_hero";
    if (h.status !== "alive") return "hero_busy";
    const other = await tx
      .select({ id: tables.id })
      .from(tableMembers)
      .innerJoin(tables, eq(tables.id, tableMembers.tableId))
      .where(and(eq(tableMembers.userId, userId), eq(tables.status, "lobby"), sql`${tables.id} <> ${tableId}`));
    if (other.length) return "in_other_table";
    const members = await tx.select().from(tableMembers).where(eq(tableMembers.tableId, tableId));
    const me = members.find((m) => m.userId === userId);
    if (!me && members.length >= MAX_PARTY) return "full";
    if (me) await tx.update(tableMembers).set({ heroId, ready: 0 }).where(and(eq(tableMembers.tableId, tableId), eq(tableMembers.userId, userId)));
    else await tx.insert(tableMembers).values({ tableId, userId, heroId });
    return null;
  });
}

export async function leaveTable(db: Db, userId: string, tableId: string): Promise<TableError | null> {
  const [t] = await db.select().from(tables).where(eq(tables.id, tableId));
  if (!t) return "no_table";
  if (t.status !== "lobby") return "started";
  await db.delete(tableMembers).where(and(eq(tableMembers.tableId, tableId), eq(tableMembers.userId, userId)));
  // Хозяин ушёл — стол закрывается.
  if (t.createdBy === userId) await db.update(tables).set({ status: "closed" }).where(eq(tables.id, tableId));
  return null;
}

export async function setReady(db: Db, userId: string, tableId: string, ready: boolean): Promise<TableError | null> {
  const r = await db
    .update(tableMembers)
    .set({ ready: ready ? 1 : 0 })
    .where(and(eq(tableMembers.tableId, tableId), eq(tableMembers.userId, userId), sql`${tableMembers.heroId} is not null`))
    .returning();
  return r.length ? null : "not_member";
}

/** Старт: хозяин запускает, когда все с героями и готовы. */
export async function startTable(db: Db, game: GameService, userId: string, tableId: string): Promise<{ sessionId: string } | TableError | { error: string }> {
  const [t] = await db.select().from(tables).where(eq(tables.id, tableId));
  if (!t) return "no_table";
  if (t.createdBy !== userId) return "not_host";
  if (t.status !== "lobby") return "started";
  const members = await db.select().from(tableMembers).where(eq(tableMembers.tableId, tableId)).orderBy(tableMembers.joinedAt);
  const withHero = members.filter((m) => m.heroId);
  if (!withHero.length || withHero.some((m) => !m.ready && m.userId !== userId)) return "not_ready";
  const r = await game.create(
    withHero.map((m) => ({ userId: m.userId, heroId: m.heroId! })),
    { kind: "expedition", biome: t.target },
    tableId,
    withHero.length > 1 ? t.turnTimer : undefined,
  );
  if ("error" in r) return r;
  await db.update(tables).set({ status: "started", sessionId: r.id }).where(eq(tables.id, tableId));
  return { sessionId: r.id };
}

export const tableIdsForUsers = (db: Db, userIds: string[]) =>
  db.select({ tableId: tableMembers.tableId, userId: tableMembers.userId }).from(tableMembers).where(inArray(tableMembers.userId, userIds));
