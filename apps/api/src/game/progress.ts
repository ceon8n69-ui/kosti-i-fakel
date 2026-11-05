import { randomUUID } from "node:crypto";
import { balance, officialDungeons } from "@kf/content";
import type { SessionState } from "@kf/engine";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { goldLedger, heroes, items, sessions } from "../db/schema.js";
import { grantItems } from "./inventory.js";
import { isEquipment } from "@kf/engine";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Exec = Db | Tx;
export type HeroRow = typeof heroes.$inferSelect;

export const xpToNext = (level: number) => balance.progression.xpPerLevelFactor * level;

export function heroView(h: HeroRow) {
  return {
    id: h.id,
    classId: h.classId,
    name: h.name,
    level: h.level,
    xp: h.xp,
    xpToNext: xpToNext(h.level),
    maxHp: h.maxHp,
    stats: h.stats,
    dice: h.dice,
    scars: h.scars,
    relics: h.relics,
    consumables: h.consumables,
    status: h.status,
  };
}

export async function listHeroes(db: Exec, userId: string): Promise<HeroRow[]> {
  return db.select().from(heroes).where(and(eq(heroes.userId, userId), sql`${heroes.status} <> 'dead'`)).orderBy(heroes.createdAt);
}

export async function createHero(db: Db, userId: string, classId: string, name: string): Promise<HeroRow | "slots_full"> {
  const cls = balance.classes.find((c) => c.id === classId)!;
  return db.transaction(async (tx) => {
    // Блокировка по пользователю: два параллельных запроса не превысят лимит слотов.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}))`);
    const count = (await listHeroes(tx, userId)).length;
    if (count >= balance.progression.freeHeroSlots) return "slots_full" as const;
    const [row] = await tx
      .insert(heroes)
      .values({ userId, classId, name, maxHp: cls.hp, stats: cls.stats, dice: cls.dice, consumables: [...balance.explore.startConsumables] })
      .returning();
    return row!;
  });
}

/** Пройденные официальные подземелья пользователя. */
export async function clearedDungeons(db: Exec, userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: sessions.scenarioId })
    .from(sessions)
    .where(and(eq(sessions.ownerId, userId), eq(sessions.endedReason, "victory")));
  return new Set(rows.map((r) => r.id));
}

export const EXPEDITION_BIOMES = ["forest", "mountains", "swamp", "ruins", "caves"] as const;
export const tierForLevel = (level: number): 1 | 2 | 3 => (level <= 3 ? 1 : level <= 6 ? 2 : 3);

/** Экспедиции открываются после первого обучающего подземелья. */
export async function expeditionsUnlocked(db: Exec, userId: string): Promise<boolean> {
  return (await clearedDungeons(db, userId)).has(officialDungeons[0]!.id);
}

/** Каталог официальных подземелий: обучение выдаётся строго по порядку. */
export async function officialCatalog(db: Exec, userId: string) {
  const cleared = await clearedDungeons(db, userId);
  let prevCleared = true;
  return officialDungeons.map((d) => {
    const unlocked = !d.tutorial || prevCleared;
    if (d.tutorial) prevCleared = cleared.has(d.id);
    return { id: d.id, title: d.title, tier: d.tier, tutorial: d.tutorial, unlocked, cleared: cleared.has(d.id), intro: d.texts.intro ?? "" };
  });
}

export async function goldBalance(db: Exec, userId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`coalesce(sum(${goldLedger.delta}), 0)::int` })
    .from(goldLedger)
    .where(and(eq(goldLedger.accountType, "user"), eq(goldLedger.accountId, userId)));
  return r?.n ?? 0;
}

/**
 * Итоги похода в той же транзакции, что и последнее событие: опыт и уровни героям,
 * золото владельцам (через журнал), расходники в сумки, статусы героев.
 */
export interface Reward {
  xp: number;
  gold: number;
  items: string[];
  reason: "victory" | "defeat" | "retreat";
}

export async function applyResults(tx: Tx, sessionId: string, s: SessionState, reward: Reward): Promise<void> {
  const ids = s.heroes.map((h) => h.dbId).filter((x): x is string => !!x);
  if (!ids.length) return;
  const rows = await tx.select().from(heroes).where(inArray(heroes.id, ids));
  const owners = [...new Set(s.heroes.map((h) => h.ownerId))];
  const share = owners.length ? Math.floor(reward.gold / owners.length) : 0;
  if (share > 0) {
    const transactionId = randomUUID();
    // Обучение: награды выдаёт система (счёт system отрицательный — так сумма по транзакции = 0).
    await tx.insert(goldLedger).values([
      { transactionId, accountType: "system", accountId: "official", delta: -share * owners.length, reason: "session_reward", sessionId },
      ...owners.map((u) => ({ transactionId, accountType: "user", accountId: u, delta: share, reason: "session_reward", sessionId })),
    ]);
  }
  for (const sh of s.heroes) {
    const row = rows.find((r) => r.id === sh.dbId);
    if (!row) continue;
    let { level, xp, maxHp } = row;
    xp += reward.xp;
    while (level < balance.progression.maxLevel && xp >= xpToNext(level)) {
      xp -= xpToNext(level);
      level++;
      if (level % 2 === 0) maxHp += balance.progression.hpBonusEvenLevels;
    }
    const dead = sh.status === "dead";
    // Расходники героев ушли в общую сумку похода. Оставшиеся (кроме факелов) делятся по кругу, до 4 на героя.
    const pool = reward.reason === "defeat" ? [] : reward.items.filter((i) => i !== "torch" && !isEquipment(i));
    const idx = s.heroes.indexOf(sh);
    const mine = pool.filter((_, i) => i % s.heroes.length === idx).slice(0, balance.progression.consumableSlots);
    await tx
      .update(heroes)
      .set({ level, xp, maxHp, consumables: mine, status: dead ? "dead" : "alive" })
      .where(eq(heroes.id, row.id));
    // Погибший герой теряет надетое снаряжение (позже оно перейдёт к Павшему).
    if (dead) await tx.delete(items).where(eq(items.equippedHeroId, row.id));
  }
  // Найденное снаряжение — игрокам по кругу.
  if (reward.reason !== "defeat") {
    const found = reward.items.filter((i) => isEquipment(i));
    const owners2 = s.heroes.map((h) => h.ownerId);
    for (let i = 0; i < found.length; i++) await grantItems(tx, owners2[i % owners2.length]!, [found[i]!], `session:${sessionId}`);
  }
}

