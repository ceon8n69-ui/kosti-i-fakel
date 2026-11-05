import { describe, expect, it } from "vitest";
import { Table } from "./testkit.js";
import { rollEquipment } from "./loot.js";

describe("снаряжение", () => {
  it("здоровье, характеристики и свет на старте", () => {
    const t = new Table("00000000000000aa", [{ ownerId: "u1", classId: "guardian", name: "Брам", equipment: ["warden_plate", "wolf_fang", "brass_lantern"] }]);
    const h = t.state.heroes[0]!;
    expect(h.maxHp).toBe(16 + 5);
    expect(h.stats.STR).toBe(4); // +3 класса, +1 клык (максимум 4)
    expect(t.state.light).toBe(40 + 6);
  });

  it("блок каждый раунд и бонус урона по типу грани", () => {
    const t = new Table("00000000000000aa", [{ ownerId: "u1", classId: "guardian", name: "Брам", equipment: ["chain_shirt", "rusty_sword"] }]);
    t.ok({ type: "MOVE", heroId: "h1", x: 3, y: 2 });
    expect(t.state.heroes[0]!.block).toBe(1);
    t.patch((s) => {
      s.heroes[0]!.roll = [0, 5, 5]; // М3
      s.step = "plan";
      s.monsters.find((m) => m.id === "m2")!.hp = 50;
    });
    t.ok({ type: "ASSIGN_FACE", heroId: "h1", die: 0, target: "m1" });
    const ev = t.ok({ type: "READY", heroId: "h1", ready: true });
    // М3 +1 меча против роя без брони
    expect(ev.find((e) => e.type === "DAMAGE_DEALT" && e.targetId === "m1")).toMatchObject({ amount: 2 }); // у роя 2 здоровья
  });

  it("лишний переброс", () => {
    const t = new Table("00000000000000aa", [{ ownerId: "u1", classId: "rogue", name: "Ли", equipment: ["lucky_die"] }]);
    t.ok({ type: "MOVE", heroId: "h1", x: 3, y: 2 });
    t.ok({ type: "ROLL_DICE", heroId: "h1" });
    t.ok({ type: "REROLL", heroId: "h1", dice: [0] });
    t.ok({ type: "REROLL", heroId: "h1", dice: [1] });
    expect(t.run({ type: "REROLL", heroId: "h1", dice: [2] }).errors[0]!.code).toBe("no_free_rerolls");
  });

  it("редкость растёт с уровнем подземелья", () => {
    let i = 0;
    const int = (n: number) => (i = (i * 1103515245 + 12345) >>> 0) % n;
    const epic = (tier: number) => Array.from({ length: 2000 }, () => rollEquipment(int, tier, false)).filter((k) => ["lamplighter_hook", "warden_plate", "abyss_shard", "fate_coin"].includes(k)).length;
    expect(epic(1)).toBe(0); // эпики первого уровня отсутствуют в каталоге
    expect(epic(3)).toBeGreaterThan(epic(2));
  });
});
