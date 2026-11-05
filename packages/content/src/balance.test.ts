import { describe, expect, it } from "vitest";
import { balance } from "./index.js";

describe("balance.json", () => {
  it("содержит 4 класса, 9 монстров, 5 ловушек", () => {
    expect(balance.classes).toHaveLength(4);
    expect(balance.monsters).toHaveLength(9);
    expect(balance.traps).toHaveLength(5);
  });
  it("у каждого класса по 3 кубика из 6 граней", () => {
    for (const c of balance.classes) {
      expect(c.dice).toHaveLength(3);
      for (const die of c.dice) expect(die).toHaveLength(6);
    }
  });
  it("характеристики классов в диапазоне", () => {
    for (const c of balance.classes)
      for (const v of Object.values(c.stats)) {
        expect(v).toBeGreaterThanOrEqual(balance.stats.min);
        expect(v).toBeLessThanOrEqual(balance.stats.max);
      }
  });
  it("за Stars не продаётся золото", () => {
    expect(Object.keys(balance.shopStars).some((k) => k.includes("gold"))).toBe(false);
  });
});
