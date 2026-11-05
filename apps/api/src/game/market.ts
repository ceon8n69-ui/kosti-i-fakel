import { randomUUID } from "node:crypto";
import { balance, itemById } from "@kf/content";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { goldLedger, items, marketListings } from "../db/schema.js";
import { itemView } from "./inventory.js";
import { clearedDungeons, goldBalance } from "./progress.js";
import { officialDungeons } from "@kf/content";

/**
 * Рынок снаряжения за заработанное золото (решение заказчика: Stars в торговле не участвуют).
 * Все деньги — через gold_ledger: покупатель −цена, продавец +цена−комиссия, система +комиссия (сумма 0).
 * Защита от перекачки золота между своими аккаунтами: продавать можно после обучения,
 * цена ограничена по редкости, между одной парой — не больше 3 сделок в неделю.
 */
const PRICE_CAP: Record<string, number> = { common: 300, rare: 1200, epic: 5000 };
const PAIR_LIMIT_PER_WEEK = 3;

export type MarketError =
  | "no_item"
  | "equipped"
  | "listed"
  | "bad_price"
  | "too_many_listings"
  | "tutorial_required"
  | "no_listing"
  | "own_listing"
  | "not_enough_gold"
  | "pair_limit";

export async function listMarket(db: Db, opts: { slot?: string; rarity?: string; limit?: number }) {
  const rows = await db
    .select({ l: marketListings, i: items })
    .from(marketListings)
    .innerJoin(items, eq(items.id, marketListings.itemId))
    .where(eq(marketListings.status, "active"))
    .orderBy(desc(marketListings.createdAt))
    .limit(Math.min(100, opts.limit ?? 50));
  return rows
    .map(({ l, i }) => ({ listingId: l.id, price: l.price, sellerId: l.sellerId, createdAt: l.createdAt.toISOString(), item: itemView(i) }))
    .filter((x) => (!opts.slot || x.item.slot === opts.slot) && (!opts.rarity || x.item.rarity === opts.rarity));
}

export async function createListing(db: Db, userId: string, itemId: string, price: number): Promise<{ id: string } | MarketError> {
  if (!Number.isInteger(price) || price < balance.loot.marketMinPrice || price > balance.loot.marketMaxPrice) return "bad_price";
  if (!(await clearedDungeons(db, userId)).has(officialDungeons[0]!.id)) return "tutorial_required";
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}))`);
    const [it] = await tx.select().from(items).where(and(eq(items.id, itemId), eq(items.ownerId, userId))).for("update");
    if (!it) return "no_item" as const;
    if (it.equippedHeroId) return "equipped" as const;
    if (it.status !== "owned") return "listed" as const;
    if (price > (PRICE_CAP[it.rarity] ?? 300)) return "bad_price" as const;
    const [cnt] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(marketListings)
      .where(and(eq(marketListings.sellerId, userId), eq(marketListings.status, "active")));
    if ((cnt?.n ?? 0) >= balance.loot.marketMaxListings) return "too_many_listings" as const;
    await tx.update(items).set({ status: "listed" }).where(eq(items.id, itemId));
    const [l] = await tx.insert(marketListings).values({ itemId, sellerId: userId, price }).returning({ id: marketListings.id });
    return { id: l!.id };
  });
}

export async function cancelListing(db: Db, userId: string, listingId: string): Promise<MarketError | null> {
  return db.transaction(async (tx) => {
    const [l] = await tx.select().from(marketListings).where(eq(marketListings.id, listingId)).for("update");
    if (!l || l.sellerId !== userId || l.status !== "active") return "no_listing";
    await tx.update(marketListings).set({ status: "cancelled", closedAt: new Date() }).where(eq(marketListings.id, listingId));
    await tx.update(items).set({ status: "owned" }).where(eq(items.id, l.itemId));
    return null;
  });
}

export async function buyListing(db: Db, buyerId: string, listingId: string): Promise<{ itemId: string } | MarketError> {
  return db.transaction(async (tx) => {
    // Сначала покупатель (его баланс), потом лот — один порядок блокировок, без взаимоблокировок.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${buyerId}))`);
    const [l] = await tx.select().from(marketListings).where(eq(marketListings.id, listingId)).for("update");
    if (!l || l.status !== "active") return "no_listing" as const;
    if (l.sellerId === buyerId) return "own_listing" as const;
    const weekAgo = new Date(Date.now() - 7 * 86400_000);
    const [pair] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(marketListings)
      .where(
        and(
          eq(marketListings.status, "sold"),
          gte(marketListings.closedAt, weekAgo),
          sql`((${marketListings.sellerId} = ${l.sellerId} and ${marketListings.buyerId} = ${buyerId}) or (${marketListings.sellerId} = ${buyerId} and ${marketListings.buyerId} = ${l.sellerId}))`,
        ),
      );
    if ((pair?.n ?? 0) >= PAIR_LIMIT_PER_WEEK) return "pair_limit" as const;
    if ((await goldBalance(tx, buyerId)) < l.price) return "not_enough_gold" as const;
    const fee = Math.ceil((l.price * balance.loot.marketCommissionPercent) / 100);
    const transactionId = randomUUID();
    await tx.insert(goldLedger).values([
      { transactionId, accountType: "user", accountId: buyerId, delta: -l.price, reason: "market_buy" },
      { transactionId, accountType: "user", accountId: l.sellerId, delta: l.price - fee, reason: "market_sell" },
      { transactionId, accountType: "system", accountId: "market", delta: fee, reason: "market_fee" },
    ]);
    await tx.update(marketListings).set({ status: "sold", buyerId, closedAt: new Date() }).where(eq(marketListings.id, listingId));
    await tx.update(items).set({ ownerId: buyerId, status: "owned", equippedHeroId: null, slot: null, source: `market:${listingId}` }).where(eq(items.id, l.itemId));
    return { itemId: l.itemId };
  });
}

export const itemName = (key: string) => itemById(key)?.name ?? key;
