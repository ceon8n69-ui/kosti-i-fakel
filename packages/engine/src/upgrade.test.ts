import { describe, expect, it } from "vitest";
import { project } from "./project.js";
import { replay } from "./reducer.js";
import { Table } from "./testkit.js";

const solo = (classId: string) => [{ ownerId: "u1", classId, name: "Герой" }];

describe("старые партии", () => {
  it("журнал и снимок без снаряжения, союзников и биома читаются и показываются", () => {
    const t = new Table("00000000000000ab", solo("guardian"), "tavern_cellar");
    const old = structuredClone(t.events);
    const init = (old[0] as { initial: Record<string, unknown> & { heroes: Record<string, unknown>[] } }).initial;
    delete init.allies;
    delete init.bonusXp;
    delete init.biome;
    for (const h of init.heroes) {
      delete h.equipment;
      delete h.mods;
    }
    const s = replay(old);
    expect(s.allies).toEqual([]);
    expect(s.heroes[0]!.mods.block).toBe(0);
    expect(() => project(s, s.heroes[0]!.ownerId)).not.toThrow();
    const snap = structuredClone(s) as unknown as Record<string, unknown>;
    delete snap.allies;
    expect(() => project(replay([], snap as never), s.heroes[0]!.ownerId)).not.toThrow();
  });
});
