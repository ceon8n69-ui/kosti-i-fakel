import { balance } from "@kf/content";
import { describe, expect, it } from "vitest";
import { createMonster } from "./combat.js";

describe("элитные враги", () => {
  it("вожак крепче обычного, броня добавляется свойством", () => {
    const base = createMonster("bandit_brute", "m1", 4);
    const armored = createMonster("bandit_brute", "m2", 4, undefined, "armored");
    expect(armored.maxHp).toBe(Math.round((base.maxHp * balance.expedition.elite.hpPercent) / 100));
    expect(armored.armor).toBe(base.armor + balance.expedition.elite.armor);
    expect(armored.elite).toBe("armored");
    expect(createMonster("bandit_brute", "m3", 4, undefined, "furious").armor).toBe(base.armor);
  });

  it("одиночке в экспедиции — враги слабее на заданный процент", () => {
    const full = createMonster("skeleton_guard", "m1", 1);
    const solo = createMonster("skeleton_guard", "m2", 1, undefined, undefined, balance.expedition.soloHpPercent);
    expect(solo.maxHp).toBeLessThan(full.maxHp);
  });
});
