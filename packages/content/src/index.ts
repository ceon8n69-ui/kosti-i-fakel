import { BalanceSchema, ScenarioSchema, type Balance, type Scenario } from "@kf/schema";
import balanceRaw from "../balance.json" with { type: "json" };
import sliceRaw from "../scenarios/slice.json" with { type: "json" };

/** Баланс проверяется схемой при загрузке: битый JSON роняет старт, а не партию. */
export const balance: Balance = BalanceSchema.parse(balanceRaw);

export const scenarios: Record<string, Scenario> = {
  slice_cellar: ScenarioSchema.parse(sliceRaw),
};
