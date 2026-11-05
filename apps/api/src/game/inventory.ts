import { balance, itemById } from "@kf/content";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { heroes, items } from "../db/schema.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Exec = Db | Tx;
export type ItemRow = typeof items.$inferSelect;

export function itemView(r: ItemRow) {
  const def = itemById(r.itemKey);
  return {
    id: r.id,
    key: r.itemKey,
    rarity: r.rarity,
    slot: def?.kind === "equipment" ? def.slot : null,
    name: def?.name ?? r.itemKey,
    desc: def?.desc ?? "",
    equippedHeroId: r.equippedHeroId,
    status: r.status,
  };
}

export const listInventory = (db: Exec, userId: string) => db.select().from(items).where(eq(items.ownerId, userId)).orderBy(items.createdAt);

/** Ключи надетого снаряжения героев — для старта похода. */
export async function equippedKeys(db: Exec, heroIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(heroIds.map((h) => [h, []]));
  if (!heroIds.length) return out;
  const rows = await db.select().from(items).where(inArray(items.equippedHeroId, heroIds));
  for (const r of rows) out.get(r.equippedHeroId!)?.push(r.itemKey);
  return out;
}

/** Выдать найденное снаряжение владельцу. */
export async function grantItems(tx: Tx, ownerId: string, keys: string[], source: string): Promise<void> {
  const rows = keys
    .map((k) => itemById(k))
    .filter((d) => d?.kind === "equipment")
    .map((d) => ({ ownerId, itemKey: d!.id, rarity: d!.kind === "equipment" ? d!.rarity : "common", source }));
  if (rows.length) await tx.insert(items).values(rows);
}

export type EquipError = "no_item" | "no_hero" | "hero_busy" | "not_equipment" | "listed";

/** Надеть: предмет занимает слот; если слот полон — самый старый предмет в нём снимается. */
export async function equip(db: Db, userId: string, heroId: string, itemId: string): Promise<EquipError | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}))`);
    const [h] = await tx.select().from(heroes).where(and(eq(heroes.id, heroId), eq(heroes.userId, userId)));
    if (!h) return "no_hero";
    if (h.status !== "alive") return "hero_busy";
    const [it] = await tx.select().from(items).where(and(eq(items.id, itemId), eq(items.ownerId, userId)));
    if (!it) return "no_item";
    if (it.status !== "owned") return "listed";
    const def = itemById(it.itemKey);
    if (def?.kind !== "equipment") return "not_equipment";
    if (it.equippedHeroId) {
      const [other] = await tx.select().from(heroes).where(eq(heroes.id, it.equippedHeroId));
      if (other && other.status !== "alive") return "hero_busy";
    }
    const inSlot = await tx
      .select()
      .from(items)
      .where(and(eq(items.equippedHeroId, heroId), eq(items.slot, def.slot)))
      .orderBy(items.createdAt);
    const cap = balance.loot.slots[def.slot];
    for (const old of inSlot.slice(0, Math.max(0, inSlot.length - cap + 1)))
      await tx.update(items).set({ equippedHeroId: null, slot: null }).where(eq(items.id, old.id));
    await tx.update(items).set({ equippedHeroId: heroId, slot: def.slot }).where(eq(items.id, itemId));
    return null;
  });
}

export async function unequip(db: Db, userId: string, itemId: string): Promise<EquipError | null> {
  const [it] = await db.select().from(items).where(and(eq(items.id, itemId), eq(items.ownerId, userId)));
  if (!it) return "no_item";
  if (it.equippedHeroId) {
    const [h] = await db.select().from(heroes).where(eq(heroes.id, it.equippedHeroId));
    if (h && h.status !== "alive") return "hero_busy";
  }
  await db.update(items).set({ equippedHeroId: null, slot: null }).where(eq(items.id, itemId));
  return null;
}
