import { officialDungeons } from "@kf/content";
import { describe, expect, it } from "vitest";
import { botStep } from "./bot.js";
import { project, projectEvent } from "./project.js";
import { replay } from "./reducer.js";
import { Table } from "./testkit.js";
import { verifyJournal } from "./verify.js";

const solo = (classId: string) => [{ ownerId: "u1", classId, name: "Герой" }];

/** Прогон ботом до конца похода. */
function playthrough(seed: string, dungeonId: string, party: { ownerId: string; classId: string; name: string }[]) {
  const t = new Table(seed, party, dungeonId);
  const memo = { searches: new Set<string>() };
  for (let guard = 0; guard < 1500 && t.state.phase !== "ended"; guard++) {
    let acted = false;
    for (const h of t.state.heroes) {
      const c = botStep(t.state, h.id, memo);
      if (!c) continue;
      const r = t.run(c);
      if (r.errors.length) throw new Error(`${dungeonId} ${c.type}: ${JSON.stringify(r.errors)} at ${JSON.stringify(t.state.pos)}`);
      acted = true;
      break;
    }
    if (!acted) break;
  }
  return t;
}

describe("исследование подземелья", () => {
  it("вход: вступление, обзор вокруг, скрытого не видно", () => {
    const t = new Table("00000000000000aa", solo("guardian"), "tavern_cellar");
    expect(t.types(t.events)).toEqual(expect.arrayContaining(["SESSION_STARTED", "TEXT_SHOWN", "TILE_REVEALED"]));
    const v = project(t.state, "u1");
    expect(v.story[0]).toContain("Мирон");
    expect(v.objects.map((o) => o.id)).toContain("note_miron");
    expect(v.objects.map((o) => o.id)).not.toContain("trap_store");
    expect(v.map.tiles.join("").includes(" ")).toBe(true); // туман войны
    expect(v).not.toHaveProperty("def");
    expect(projectEvent(t.events[0]!, "u1")).toEqual({ seq: 1, type: "SESSION_ENTERED" });
  });

  it("закрытая дверь не пропускает, открытая открывает обзор", () => {
    const t = new Table("00000000000000aa", solo("guardian"), "tavern_cellar");
    expect(t.run({ type: "MOVE", heroId: "h1", x: 8, y: 2 }).errors[0]!.code).toBe("no_path");
    t.ok({ type: "MOVE", heroId: "h1", x: 4, y: 3 });
    const ev = t.ok({ type: "INTERACT", heroId: "h1", objectId: "door_store", verb: "use" });
    expect(t.types(ev)).toEqual(["OBJECT_CHANGED", "TILE_REVEALED"]);
    expect(t.state.seen[2]![8]).toBe("1"); // за дверью открылась кладовая
  });

  it("запертая дверь требует ключ или силу; ключ открывает", () => {
    const t = new Table("00000000000000aa", solo("guardian"), "tavern_cellar");
    t.patch((s) => {
      s.pos = { x: 6, y: 8 };
      s.seen = s.seen.map((r) => "1".repeat(r.length));
      s.encounters.forEach((e) => (e.done = true));
    });
    expect(t.run({ type: "INTERACT", heroId: "h1", objectId: "door_crypt", verb: "use" }).errors[0]!.code).toBe("locked");
    t.patch((s) => s.bag.keys.push("crypt_key"));
    t.ok({ type: "INTERACT", heroId: "h1", objectId: "door_crypt", verb: "use" });
    expect(t.state.objects.find((o) => o.id === "door_crypt")!.open).toBe(true);
  });

  it("сундук даёт золото и предметы один раз", () => {
    const t = new Table("00000000000000aa", solo("rogue"), "tavern_cellar");
    t.patch((s) => {
      s.pos = { x: 12, y: 1 };
      s.seen = s.seen.map((r) => "1".repeat(r.length));
    });
    const ev = t.ok({ type: "INTERACT", heroId: "h1", objectId: "chest_store", verb: "use" });
    expect(ev.find((e) => e.type === "ITEM_FOUND")).toMatchObject({ gold: 15, items: ["potion"] });
    expect(t.state.bag.gold).toBe(15);
    expect(t.run({ type: "INTERACT", heroId: "h1", objectId: "chest_store", verb: "use" }).errors[0]!.code).toBe("empty");
  });

  it("рычаг по правилу поднимает решётку", () => {
    const t = new Table("00000000000000aa", solo("guardian"), "damp_well");
    t.patch((s) => {
      s.pos = { x: 1, y: 11 };
      s.seen = s.seen.map((r) => "1".repeat(r.length));
      s.encounters.forEach((e) => (e.done = true));
    });
    const ev = t.ok({ type: "INTERACT", heroId: "h1", objectId: "lever_grate", verb: "use" });
    expect(t.types(ev)).toEqual(expect.arrayContaining(["RULE_FIRED", "OBJECT_CHANGED", "TEXT_SHOWN"]));
    expect(t.state.objects.find((o) => o.id === "grate")!.open).toBe(true);
  });

  it("NPC рассказывает свои реплики", () => {
    const t = new Table("00000000000000aa", solo("healer"), "damp_well");
    t.patch((s) => {
      s.pos = { x: 6, y: 4 };
      s.seen = s.seen.map((r) => "1".repeat(r.length));
      s.objects.find((o) => o.id === "door_well")!.open = true;
    });
    const ev = t.ok({ type: "INTERACT", heroId: "h1", objectId: "ghost_sava", verb: "use" });
    const texts = ev.filter((e) => e.type === "TEXT_SHOWN");
    expect(texts).toHaveLength(2);
    expect(texts[0]).toMatchObject({ speaker: "Утопленник Сава" });
  });

  it("отступление у входа завершает поход и сохраняет найденное", () => {
    const t = new Table("00000000000000aa", solo("guardian"), "tavern_cellar");
    t.patch((s) => (s.bag.gold = 7));
    const ev = t.ok({ type: "RETREAT", heroId: "h1" });
    expect(ev.find((e) => e.type === "REWARDS")).toMatchObject({ reason: "retreat", gold: 7 });
    expect(t.state.ended).toEqual({ reason: "retreat" });
  });

  it("факел из сумки добавляет 8 света", () => {
    const t = new Table("00000000000000aa", solo("guardian"), "smokehouse");
    t.ok({ type: "USE_ITEM", heroId: "h1", itemId: "torch" });
    expect(t.state.light).toBe(48);
    expect(t.state.bag.items.filter((i) => i === "torch")).toHaveLength(1);
  });

  it("правило «Факел ниже» срабатывает при пересечении порога", () => {
    const t = new Table("00000000000000aa", solo("guardian"), "smokehouse");
    t.patch((s) => (s.light = 26));
    const ev = t.ok({ type: "MOVE", heroId: "h1", x: 3, y: 1 });
    expect(ev.find((e) => e.type === "TEXT_SHOWN" && e.textId === "smoke")).toBeTruthy();
  });

  it("обыск находит секретную дверь", () => {
    for (let i = 0; i < 200; i++) {
      const seed = (i + 1).toString(16).padStart(16, "0");
      const t = new Table(seed, solo("sorcerer"), "damp_well");
      t.patch((s) => {
        s.pos = { x: 9, y: 9 };
        s.seen = s.seen.map((r) => "1".repeat(r.length));
        s.encounters.forEach((e) => (e.done = true));
      });
      expect(project(t.state, "u1").map.tiles[9]![10]).toBe("#");
      const ev = t.ok({ type: "SEARCH", heroId: "h1" });
      if (!ev.some((e) => e.type === "SECRET_FOUND")) continue;
      expect(project(t.state, "u1").objects.map((o) => o.id)).toContain("secret_wall");
      return;
    }
    throw new Error("secret never found");
  });
});

describe("проходимость обучающих подземелий", () => {
  for (const d of officialDungeons) {
    for (const cls of ["guardian", "rogue", "sorcerer", "healer"]) {
      it(`${d.id}: ${cls} проходит, журнал проверяется`, () => {
        let wins = 0;
        for (let i = 0; i < 12; i++) {
          const seed = ((i + 7) * 2654435761 >>> 0).toString(16).padStart(16, "0");
          const t = playthrough(seed, d.id, solo(cls));
          expect(t.state.phase).toBe("ended");
          if (t.state.ended?.reason === "victory") wins++;
          expect(replay(t.events)).toEqual(t.state);
          expect(verifyJournal(seed, t.events).ok).toBe(true);
        }
        expect(wins).toBeGreaterThanOrEqual(8);
      });
    }
  }
});
