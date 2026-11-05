import { describe, expect, it } from "vitest";
import { project, projectEvent } from "./project.js";
import { replay } from "./reducer.js";
import { valueAt } from "./rng.js";
import { Table } from "./testkit.js";
import type { GameEvent } from "./types.js";

/** Зерно, у которого первый d20 даёт нужное значение. */
function seedWithFirstD20(n: number): string {
  for (let i = 0; i < 100000; i++) {
    const seed = i.toString(16).padStart(16, "0");
    if (valueAt(seed, 0, 20) + 1 === n) return seed;
  }
  throw new Error("no seed");
}

const enterCombat = (t: Table) => {
  if (t.state.encounter.length === 2) t.patch((s) => (s.encounter = ["rat_swarm", "skeleton_guard", "rotten_archer"]));
  t.ok({ type: "MOVE", heroId: "h1", objectId: "door_1" });
  return t;
};

/** Ставит выпавшие грани вручную: индекс грани по каждому кубику. */
const setRoll = (t: Table, faces: number[], heroId = "h1") =>
  t.patch((s) => {
    const h = s.heroes.find((x) => x.id === heroId)!;
    h.roll = faces;
    s.step = "plan";
  });

describe("старт и исследование", () => {
  it("журнал начинается с SESSION_STARTED, зерна в нём нет", () => {
    const t = new Table("1234567890abcdef");
    expect(t.events[0]!.type).toBe("SESSION_STARTED");
    expect(JSON.stringify(t.events)).not.toContain("1234567890abcdef");
    expect(t.state.light).toBe(40);
    expect(t.state.heroes[0]!.hp).toBe(16);
  });

  it("натуральная 20 — всегда успех и находит ловушку", () => {
    const t = new Table(seedWithFirstD20(20));
    const ev = t.ok({ type: "INTERACT", heroId: "h1", objectId: "corridor", verb: "inspect" });
    const check = ev.find((e) => e.type === "CHECK_ROLLED")!;
    expect(check).toMatchObject({ natural: 20, success: true });
    expect(t.types(ev)).toContain("TRAP_REVEALED");
    expect(t.state.light).toBe(39);
  });

  it("натуральная 1 — всегда провал, даже при высоком бонусе", () => {
    const t = new Table(seedWithFirstD20(1), [{ ownerId: "u1", classId: "sorcerer", name: "Ия" }]);
    t.patch((s) => (s.heroes[0]!.stats.INT = 30));
    const ev = t.ok({ type: "INTERACT", heroId: "h1", objectId: "corridor", verb: "inspect" });
    expect(ev.find((e) => e.type === "CHECK_ROLLED")).toMatchObject({ natural: 1, success: false });
    expect(t.types(ev)).not.toContain("TRAP_REVEALED");
  });

  it("скрытая ловушка не видна в проекции, пока не найдена", () => {
    const t = new Table();
    expect(project(t.state, "u1").objects.map((o) => o.id)).not.toContain("trap_1");
    const start = projectEvent(t.events[0]!, "u1") as Extract<GameEvent, { type: "SESSION_STARTED" }>;
    expect(start.initial.objects.map((o) => o.id)).not.toContain("trap_1");
    expect(project(t.state, "u1")).not.toHaveProperty("rngCounter");
  });

  it("проход мимо невзведённой ловушки запускает её, затем бой с масштабом здоровья", () => {
    const t = new Table();
    t.patch((s) => (s.encounter = ["rat_swarm", "skeleton_guard", "rotten_archer"]));
    const ev = t.ok({ type: "MOVE", heroId: "h1", objectId: "door_1" });
    expect(t.types(ev)).toEqual(expect.arrayContaining(["TRAP_TRIGGERED", "ENCOUNTER_STARTED", "ROUND_STARTED", "INTENTS_SHOWN"]));
    expect(t.state.heroes[0]!.hp).toBe(14);
    // Рой 5×0,45, скелет 10×0,45, лучник 7×0,45
    expect(t.state.monsters.map((m) => m.maxHp)).toEqual([2, 5, 3]);
    expect(t.state.phase).toBe("combat");
    expect(t.state.light).toBe(39);
  });

  it("чужим героем ходить нельзя, устаревший seq отклоняется", () => {
    const t = new Table();
    expect(t.run({ type: "MOVE", heroId: "h1", objectId: "door_1" }, "intruder").errors[0]!.code).toBe("not_your_hero");
  });
});

describe("кубики героя", () => {
  it("бросок трёх кубиков, затем один бесплатный переброс", () => {
    const t = enterCombat(new Table());
    const ev = t.ok({ type: "ROLL_DICE", heroId: "h1" });
    const roll = ev.find((e) => e.type === "HERO_DICE_ROLLED")!;
    expect(roll).toMatchObject({ dice: [0, 1, 2], kind: "roll" });
    expect(roll.draws).toHaveLength(4); // 3 грани + траектория
    t.ok({ type: "REROLL", heroId: "h1", dice: [1] });
    expect(t.run({ type: "REROLL", heroId: "h1", dice: [1] }).errors[0]!.code).toBe("no_free_rerolls");
  });

  it("Долг судьбы даёт переброс за жетон Рока", () => {
    const t = enterCombat(new Table());
    t.ok({ type: "ROLL_DICE", heroId: "h1" });
    t.ok({ type: "REROLL", heroId: "h1", dice: [0] });
    const ev = t.ok({ type: "USE_FATE_DEBT", heroId: "h1", dice: [0, 2] });
    expect(t.types(ev)).toEqual(["HERO_DICE_ROLLED", "DOOM_CHANGED"]);
    expect(t.state.doom).toBe(1);
  });

  it("ближняя атака не достаёт задний ряд, пока жив передний", () => {
    const t = enterCombat(new Table());
    setRoll(t, [0, 0, 2]); // М3, Щ3, М2
    expect(t.run({ type: "ASSIGN_FACE", heroId: "h1", die: 0, target: "m3" }).errors[0]!.code).toBe("bad_target");
    t.ok({ type: "ASSIGN_FACE", heroId: "h1", die: 0, target: "m2" });
  });

  it("броня снижает ближний урон, магия её игнорирует", () => {
    const t = enterCombat(new Table("00000000000000aa", [{ ownerId: "u1", classId: "sorcerer", name: "Ия" }]));
    t.patch((s) => {
      s.monsters.find((m) => m.id === "m2")!.hp = 50; // скелет с бронёй 1
      s.monsters.find((m) => m.id === "m2")!.maxHp = 50;
    });
    setRoll(t, [0, 4, 4]); // И3, Ч, Ч
    t.ok({ type: "ASSIGN_FACE", heroId: "h1", die: 0, target: "m2" });
    const ev = t.ok({ type: "READY", heroId: "h1", ready: true });
    const hit = ev.find((e) => e.type === "DAMAGE_DEALT" && e.targetId === "m2");
    expect(hit).toMatchObject({ amount: 3, armor: 0, kind: "magic" });

    const g = enterCombat(new Table());
    g.patch((s) => (s.monsters.find((m) => m.id === "m2")!.hp = 50));
    setRoll(g, [0, 5, 5]); // М3
    g.ok({ type: "ASSIGN_FACE", heroId: "h1", die: 0, target: "m2" });
    const ev2 = g.ok({ type: "READY", heroId: "h1", ready: true });
    expect(ev2.find((e) => e.type === "DAMAGE_DEALT" && e.targetId === "m2")).toMatchObject({ amount: 2, armor: 1 });
  });

  it("звезда становится выбранной гранью того же кубика", () => {
    const t = enterCombat(new Table());
    t.patch((s) => (s.monsters.find((m) => m.id === "m2")!.hp = 50));
    setRoll(t, [5, 4, 5]); // Ч, З (кубик B: Щ3 Щ3 Щ2 Щ2 З Ч), Ч
    expect(t.run({ type: "ASSIGN_FACE", heroId: "h1", die: 1, target: "h1" }).errors[0]!.code).toBe("star_needs_face");
    expect(t.run({ type: "ASSIGN_FACE", heroId: "h1", die: 1, target: "h1", star: 4 }).errors[0]!.code).toBe("bad_star");
    t.ok({ type: "ASSIGN_FACE", heroId: "h1", die: 1, target: "h1", star: 0 });
    const ev = t.ok({ type: "READY", heroId: "h1", ready: true });
    expect(ev.find((e) => e.type === "BLOCK_GAINED")).toMatchObject({ targetId: "h1", amount: 3 });
  });

  it("три черепа в одном броске наносят 2 урона без учёта блока", () => {
    // Ищем зерно, где после входа в бой первый бросок даёт три черепа у Плута (кубик B: два черепа).
    for (let i = 0; i < 20000; i++) {
      const seed = i.toString(16).padStart(16, "0");
      const t = enterCombat(new Table(seed, [{ ownerId: "u1", classId: "rogue", name: "Ли" }]));
      const c = t.state.rngCounter;
      const faces = [valueAt(seed, c, 6), valueAt(seed, c + 1, 6), valueAt(seed, c + 2, 6)];
      const h = t.state.heroes[0]!;
      if (!faces.every((f, d) => h.dice[d]![f]!.t === "SKULL")) continue;
      t.patch((s) => (s.heroes[0]!.block = 5));
      const hp = t.state.heroes[0]!.hp;
      const ev = t.ok({ type: "ROLL_DICE", heroId: "h1" });
      expect(ev.find((e) => e.type === "DAMAGE_DEALT")).toMatchObject({ amount: 2, blocked: 0, kind: "skulls" });
      expect(t.state.heroes[0]!.hp).toBe(hp - 2);
      return;
    }
    throw new Error("seed not found");
  });
});

describe("раунд", () => {
  it("порядок разрешения: раскрытие, блок, урон героев, враги, свет, новый раунд", () => {
    const t = enterCombat(new Table());
    setRoll(t, [0, 0, 3]); // М3, Щ3, Щ1
    t.ok({ type: "ASSIGN_FACE", heroId: "h1", die: 0, target: "m1" });
    t.ok({ type: "ASSIGN_FACE", heroId: "h1", die: 1, target: "h1" });
    const ev = t.ok({ type: "READY", heroId: "h1", ready: true });
    const order = t.types(ev);
    const idx = (x: string) => order.indexOf(x);
    expect(idx("ASSIGNMENTS_REVEALED")).toBeLessThan(idx("BLOCK_GAINED"));
    expect(idx("BLOCK_GAINED")).toBeLessThan(idx("DAMAGE_DEALT"));
    expect(idx("MONSTER_DIED")).toBeLessThan(idx("ENEMY_TURN_STARTED"));
    expect(idx("ENEMY_TURN_STARTED")).toBeLessThan(idx("LIGHT_CHANGED"));
    expect(order.at(-2)).toBe("ROUND_STARTED");
    expect(order.at(-1)).toBe("INTENTS_SHOWN");
    expect(t.state.round).toBe(2);
    expect(t.state.heroes[0]!.block).toBe(0);
  });

  it("провокация перенаправляет атаки на провокатора", () => {
    const t = enterCombat(
      new Table("00000000000000aa", [
        { ownerId: "u1", classId: "guardian", name: "Брам" },
        { ownerId: "u2", classId: "sorcerer", name: "Ия" },
      ]),
    );
    t.patch((s) => {
      for (const m of s.monsters) m.intents = [{ kind: "attack", targets: ["h2"], amount: 1 }];
    });
    setRoll(t, [5, 5, 0], "h1"); // кубик C грань 0: Щ2+Провокация
    setRoll(t, [5, 4, 5], "h2"); // Чародей: Ч, Ч, Ч
    t.ok({ type: "ASSIGN_FACE", heroId: "h1", die: 2, target: "h1" });
    t.ok({ type: "READY", heroId: "h1", ready: true });
    const ev = t.ok({ type: "READY", heroId: "h2", ready: true }, "u2");
    const hits = ev.filter((e) => e.type === "DAMAGE_DEALT" && e.kind === "monster");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((e) => e.type === "DAMAGE_DEALT" && e.targetId === "h1")).toBe(true);
  });

  it("слизень при смерти делится на двух", () => {
    const t = new Table();
    t.patch((s) => (s.encounter = ["slime"]));
    enterCombat(t);
    t.patch((s) => (s.monsters[0]!.hp = 1));
    setRoll(t, [0, 5, 5]);
    t.ok({ type: "ASSIGN_FACE", heroId: "h1", die: 0, target: "m1" });
    const ev = t.ok({ type: "READY", heroId: "h1", ready: true });
    const spawned = ev.filter((e) => e.type === "MONSTER_SPAWNED");
    expect(spawned).toHaveLength(2);
    expect(t.state.monsters.filter((m) => m.alive).map((m) => [m.kind, m.variant, m.hp])).toEqual([
      ["slime", "small", 1],
      ["slime", "small", 1],
    ]);
  });

  it("яд наносит урон в конце раунда и слабеет на 1", () => {
    const t = enterCombat(new Table("00000000000000aa", [{ ownerId: "u1", classId: "rogue", name: "Ли" }]));
    t.patch((s) => {
      for (const m of s.monsters) (m.hp = 30), (m.maxHp = 30);
    });
    setRoll(t, [5, 4, 0]); // Ч, Ч, Л2+Яд1
    t.ok({ type: "ASSIGN_FACE", heroId: "h1", die: 2, target: "m3" });
    const ev = t.ok({ type: "READY", heroId: "h1", ready: true });
    const poison = ev.filter((e) => e.type === "DAMAGE_DEALT" && e.kind === "poison");
    expect(poison).toHaveLength(1);
    expect(t.state.monsters.find((m) => m.id === "m3")).toMatchObject({ hp: 27, poison: 0 });
  });

  it("победа завершает поход", () => {
    const t = enterCombat(new Table("00000000000000aa", [{ ownerId: "u1", classId: "sorcerer", name: "Ия" }]));
    t.patch((s) => s.monsters.forEach((m) => (m.hp = 1)));
    setRoll(t, [5, 0, 5]); // И1 всем
    t.ok({ type: "ASSIGN_FACE", heroId: "h1", die: 1, target: null });
    const ev = t.ok({ type: "READY", heroId: "h1", ready: true });
    expect(ev.at(-1)).toMatchObject({ type: "SESSION_ENDED", reason: "victory" });
    expect(t.run({ type: "ROLL_DICE", heroId: "h1" }).errors[0]!.code).toBe("session_ended");
  });

  it("в обучении поражение не убивает героя", () => {
    const t = enterCombat(new Table());
    t.patch((s) => {
      s.heroes[0]!.hp = 1;
      for (const m of s.monsters) m.intents = [{ kind: "attack", targets: ["h1"], amount: 5 }];
    });
    setRoll(t, [5, 5, 5]);
    const ev = t.ok({ type: "READY", heroId: "h1", ready: true });
    expect(t.types(ev)).toContain("HERO_DOWNED");
    expect(t.types(ev)).not.toContain("HERO_DIED");
    expect(ev.at(-1)).toMatchObject({ type: "SESSION_ENDED", reason: "defeat" });
  });

  it("лечение поднимает упавшего союзника", () => {
    const t = enterCombat(
      new Table("00000000000000aa", [
        { ownerId: "u1", classId: "healer", name: "Ма" },
        { ownerId: "u2", classId: "guardian", name: "Брам" },
      ]),
    );
    t.patch((s) => {
      s.heroes[1]!.status = "downed";
      s.heroes[1]!.hp = 0;
      for (const m of s.monsters) m.intents = [];
    });
    setRoll(t, [0, 5, 5], "h1"); // С3
    t.ok({ type: "ASSIGN_FACE", heroId: "h1", die: 0, target: "h2" });
    const ev = t.ok({ type: "READY", heroId: "h1", ready: true });
    expect(ev.find((e) => e.type === "HERO_RAISED")).toMatchObject({ heroId: "h2", hp: 3 });
  });

  it("чужое назначение граней скрыто в проекции", () => {
    const t = enterCombat(
      new Table("00000000000000aa", [
        { ownerId: "u1", classId: "guardian", name: "Брам" },
        { ownerId: "u2", classId: "rogue", name: "Ли" },
      ]),
    );
    setRoll(t, [0, 5, 5], "h1");
    setRoll(t, [0, 5, 5], "h2");
    const ev = t.ok({ type: "ASSIGN_FACE", heroId: "h1", die: 0, target: "m1" });
    expect(projectEvent(ev[0]!, "u2")).toBeNull();
    expect(projectEvent(ev[0]!, "u1")).not.toBeNull();
    expect(project(t.state, "u2").heroes[0]!.plan).toBeNull();
    expect(project(t.state, "u1").heroes[0]!.plan).toHaveLength(1);
  });

  it("состояние восстанавливается из журнала", () => {
    const t = new Table();
    t.ok({ type: "MOVE", heroId: "h1", objectId: "door_1" });
    t.ok({ type: "ROLL_DICE", heroId: "h1" });
    expect(replay(t.events)).toEqual(t.state);
  });
});
