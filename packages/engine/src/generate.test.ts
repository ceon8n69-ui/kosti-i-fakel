import { balance, biomes, eventLibrary, itemById } from "@kf/content";
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
    // События ссылаются только на существующих монстров и предметы.
    for (const e of eventLibrary)
      for (const o of e.options)
        for (const out of [...o.success, ...o.fail]) {
          if (out.do === "spawn") for (const k of out.monsters) expect(known.has(k), `${e.id}: ${k}`).toBe(true);
          if (out.do === "item") expect(itemById(out.itemId), `${e.id}: ${out.itemId}`).toBeTruthy();
        }
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

  it("промежуточная глубина: развилка вместо сокровищницы, застава, три пути", () => {
    for (let i = 0; i < 30; i++) {
      const d = generateExpedition({ seedHex: seed(i), biome: "forest", tier: 1, stage: 1, stages: 3 });
      expect(d.objects.filter((o) => o.type === "treasury")).toHaveLength(0);
      const cross = d.events.find((e) => e.id === "crossroads")!;
      expect(cross.options.map((o) => o.id)).toEqual(["go", "danger", "leave"]);
      expect(d.encounters.some((e) => e.id === "gate")).toBe(true);
      const last = generateExpedition({ seedHex: seed(i), biome: "caves", tier: 1, stage: 3, stages: 3, danger: true });
      expect(last.objects.filter((o) => o.type === "treasury")).toHaveLength(1);
      expect(last.encounters.find((e) => e.id === "lair")!.elite).toBe(true);
    }
  });

  it("бот проходит экспедиции из трёх глубин: инварианты, журнал, исход", () => {
    const outcomes: Record<string, number> = {};
    const stages: Record<string, number> = {};
    for (let i = 0; i < 40; i++) {
      const biome = ["forest", "mountains", "swamp", "ruins", "caves"][i % 5]!;
      const party = [["guardian"], ["rogue", "healer"], ["sorcerer", "guardian", "healer"], ["guardian", "rogue", "sorcerer", "healer"]][i % 4]!;
      const def = generateExpedition({ seedHex: seed(100 + i), biome, tier: 1, partySize: party.length, stage: 1, stages: balance.expedition.stages });
      const t = new Table(seed(i), party.map((c, k) => ({ ownerId: `u${k}`, classId: c, name: `H${k}` })), def);
      const memo = { searches: new Set<string>(), danger: i % 3 === 0 };
      for (let g = 0; g < 12000 && t.state.phase !== "ended"; g++) {
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
      stages[`${party.length}:${t.state.stage}`] = (stages[`${party.length}:${t.state.stage}`] ?? 0) + 1;
      // Отряд из трёх-четырёх доходит до логова.
      if (party.length >= 3) expect(t.state.stage).toBe(balance.expedition.stages);
    }
    console.log("исходы экспедиций (размер партии:итог)", outcomes, "дошли до глубины", stages);
  });
});
