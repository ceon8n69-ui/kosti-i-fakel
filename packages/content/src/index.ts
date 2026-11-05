import { BalanceSchema, DungeonDefinitionSchema, ItemSchema, type Balance, type DungeonDefinition, type Item } from "@kf/schema";
import balanceRaw from "../balance.json" with { type: "json" };
import d01 from "../dungeons/01_tavern_cellar.json" with { type: "json" };
import d02 from "../dungeons/02_damp_well.json" with { type: "json" };
import d03 from "../dungeons/03_smokehouse.json" with { type: "json" };
import itemsRaw from "../items.json" with { type: "json" };

/** Баланс проверяется схемой при загрузке: битый JSON роняет старт, а не партию. */
export const balance: Balance = BalanceSchema.parse(balanceRaw);

export const items: Item[] = ItemSchema.array().parse(itemsRaw);
export const itemById = (id: string): Item | undefined => items.find((i) => i.id === id);

/** Официальные подземелья в порядке прохождения. Первые три — обучение. */
export const officialDungeons: DungeonDefinition[] = [d01, d02, d03].map((d) => DungeonDefinitionSchema.parse(d));
export const dungeonById = (id: string): DungeonDefinition | undefined => officialDungeons.find((d) => d.id === id);
