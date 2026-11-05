import { balance, items } from "@kf/content";
import type { EquipmentItem, Item } from "@kf/schema";
import type { Attr, HeroMods } from "./types.js";

export const equipmentItems = (): EquipmentItem[] => items.filter((i): i is EquipmentItem => i.kind === "equipment");

/** Случайное снаряжение по весам редкости уровня. rich — сундук логова: редкость на ступень выше с шансом. */
export function rollEquipment(int: (n: number) => number, tier: number, rich: boolean): string {
  const w = balance.loot.rarityWeights[String(tier)] ?? balance.loot.rarityWeights["1"]!;
  const total = w.common + w.rare + w.epic;
  let roll = int(total);
  let rarity: EquipmentItem["rarity"] = roll < w.common ? "common" : roll < w.common + w.rare ? "rare" : "epic";
  if (rich && rarity === "common" && int(2) === 0) rarity = "rare";
  let pool = equipmentItems().filter((i) => i.rarity === rarity && i.tier <= tier);
  if (!pool.length) pool = equipmentItems().filter((i) => i.tier <= tier);
  roll = int(pool.length);
  return pool[roll]!.id;
}

export const emptyMods = (): HeroMods => ({ dmg: { M: 0, L: 0, I: 0 }, block: 0, healAfter: 0, rerolls: 0, poison: 0, light: 0 });

/** Суммарные эффекты надетого снаряжения. */
export function modsOf(keys: string[]): { mods: HeroMods; hp: number; stats: Partial<Record<Attr, number>> } {
  const mods = emptyMods();
  let hp = 0;
  const stats: Partial<Record<Attr, number>> = {};
  for (const k of keys) {
    const it = items.find((i) => i.id === k);
    if (!it || it.kind !== "equipment") continue;
    for (const e of it.effects) {
      switch (e.t) {
        case "hp":
          hp += e.n;
          break;
        case "stat":
          stats[e.attr] = (stats[e.attr] ?? 0) + e.n;
          break;
        case "dmg":
          mods.dmg[e.face] += e.n;
          break;
        case "block":
          mods.block += e.n;
          break;
        case "heal_after":
          mods.healAfter += e.n;
          break;
        case "light":
          mods.light += e.n;
          break;
        case "reroll":
          mods.rerolls += e.n;
          break;
        case "poison":
          mods.poison += e.n;
          break;
      }
    }
  }
  return { mods, hp, stats };
}

export const isEquipment = (id: string): boolean => items.some((i: Item) => i.id === id && i.kind === "equipment");
