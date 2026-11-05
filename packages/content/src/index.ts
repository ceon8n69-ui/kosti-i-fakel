import { readFileSync } from "node:fs";
import { BalanceSchema, type Balance } from "@kf/schema";

const raw: unknown = JSON.parse(
  readFileSync(new URL("../balance.json", import.meta.url), "utf8"),
);

/** Баланс проверяется схемой при загрузке: битый JSON роняет старт, а не партию. */
export const balance: Balance = BalanceSchema.parse(raw);
