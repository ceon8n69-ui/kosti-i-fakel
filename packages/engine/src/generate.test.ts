import { balance, biomes } from "@kf/content";
import { describe, expect, it } from "vitest";
import { botStep } from "./bot.js";
import { generateExpedition } from "./generate.js";
import { replay } from "./reducer.js";
import { Table } from "./testkit.js";
import { verifyJournal } from "./verify.js";

const seed = (i: number) => ((i + 11) * 2654435761 >>> 0).toString(16).padStart(16, "0");

describe("генератор экспедиций", () => {
  it("детерминирован: одно зерно — одна карта", () => {
    expect(generateExpedition({ seedHex: seed(1), biome: "forest", tier: 1 })).toEqual(generateExpedition({ seedHex: seed(1), biome: "forest", tier: 1 }));
    expect(generateExpedition({ seedHex: seed(1), biome: "forest", tier: 1 }).tiles).not.toEqual(generateExpedition({ seedHex: seed(2), biome: "forest", tier: 1 }).tiles);
  });

  it("все монстры групп и боссов существуют", () => {
    const known = new Set(balance.monsters.map((m) => m.id));
    for (const b of biomes) for (const g of [...b.groups, ...b.bosses]) for (const k of g) expect(known.has(k), `${b.id}: ${k}`).toBe(true);
  });

  for (const biome of ["forest", "mountains", "swamp", "ruins", "caves"])
    for (const tier of [1, 2, 3] as const)
      it(`${biome} ${tier}: бюджет, лимиты, сокровищница`, () => {
        const t = balance.tiers.find((x) => x.tier === tier)!;
        for (let i = 0; i < 40; i++) {
          const d = generateExpedition({ seedHex: seed(i), biome, tier });
          const cost = (ks: string[]) => ks.reduce((n, k) => n + balance.monsters.find((m) => m.id === k)!.cost, 0);
          expect(d.encounters.reduce((n, e) => n + cost(e.monsters), 0)).toBeLessThanOrEqual(t.budget);
          for (const e of d.encounters.filter((x) => !x.boss)) expect(cost(e.monsters)).toBeLessThanOrEqual(t.maxPerRoom);
          expect(d.objects.filter((o) => o.type === "treasury")).toHaveLength(1);
          expect(d.events.length).toBeGreaterThan(0);
        }
      });

  it("бот проходит экспедиции: инварианты, журнал, исход", () => {
    const outcomes: Record<string, number> = {};
    for (let i = 0; i < 60; i++) {
      const biome = ["forest", "mountains", "swamp", "ruins", "caves"][i % 5]!;
      const def = generateExpedition({ seedHex: seed(100 + i), biome, tier: 1 });
      const party = [["guardian"], ["rogue", "healer"], ["sorcerer", "guardian", "healer"], ["guardian", "rogue", "sorcerer", "healer"]][i % 4]!;
      const t = new Table(seed(i), party.map((c, k) => ({ ownerId: `u${k}`, classId: c, name: `H${k}` })), def);
      const memo = { searches: new Set<string>() };
      for (let g = 0; g < 4000 && t.state.phase !== "ended"; g++) {
        let cmd = null;
        for (const h of t.state.heroes) if ((cmd = botStep(t.state, h.id, memo))) break;
        if (!cmd) break;
        const r = t.run(cmd);
        if (r.errors.length) throw new Error(`${biome} ${cmd.type} ${JSON.stringify(r.errors)}`);
      }
      expect(t.state.phase).toBe("ended");
      expect(replay(t.events)).toEqual(t.state);
      expect(verifyJournal(seed(i), t.events).ok).toBe(true);
      const k = `${party.length}:${t.state.ended!.reason}`;
      outcomes[k] = (outcomes[k] ?? 0) + 1;
    }
    console.log("исходы экспедиций (размер партии:итог)", outcomes);
  });
});
