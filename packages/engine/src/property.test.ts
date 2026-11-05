import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { autoTurn } from "./auto.js";
import { effectiveFace, legalTargets } from "./faces.js";
import { project } from "./project.js";
import { replay } from "./reducer.js";
import { Table } from "./testkit.js";
import type { CommandBody, SessionState } from "./types.js";
import { verifyJournal } from "./verify.js";

const CLASSES = ["guardian", "rogue", "sorcerer", "healer"];

/** Набор осмысленных команд для героя в текущем состоянии (включая заведомо неверные). */
function options(s: SessionState, heroId: string): CommandBody[] {
  const h = s.heroes.find((x) => x.id === heroId)!;
  const out: CommandBody[] = [];
  if (s.phase === "explore") {
    out.push({ type: "INTERACT", heroId, objectId: "corridor", verb: "inspect" });
    out.push({ type: "INTERACT", heroId, objectId: "trap_1", verb: "disarm" });
    out.push({ type: "CHANGE_ROW", heroId, row: h.row === "front" ? "back" : "front" });
    out.push({ type: "MOVE", heroId, objectId: "door_1" });
  } else if (s.phase === "combat") {
    out.push({ type: "ROLL_DICE", heroId });
    out.push({ type: "REROLL", heroId, dice: [0, 2] });
    out.push({ type: "USE_FATE_DEBT", heroId, dice: [1] });
    h.roll.forEach((idx, die) => {
      if (idx == null) return;
      const star = h.dice[die]![idx]!.t === "STAR" ? 0 : undefined;
      const f = effectiveFace(h, { die, star });
      const targets = f ? legalTargets(s, h, f) : [];
      for (const target of [...targets, "m99"]) out.push({ type: "ASSIGN_FACE", heroId, die, target, star } as CommandBody);
    });
    out.push({ type: "READY", heroId, ready: true }, { type: "READY", heroId, ready: false });
    out.push(...autoTurn(s, heroId));
  }
  return out;
}

function checkInvariants(t: Table): void {
  const s = t.state;
  expect(s.light).toBeGreaterThanOrEqual(0);
  expect(s.doom).toBeGreaterThanOrEqual(0);
  for (const h of s.heroes) {
    expect(h.hp).toBeGreaterThanOrEqual(0);
    expect(h.hp).toBeLessThanOrEqual(h.maxHp);
    expect(h.block).toBeGreaterThanOrEqual(0);
    if (h.status !== "up") expect(h.hp).toBe(0);
    if (h.status === "up") expect(h.hp).toBeGreaterThan(0);
  }
  for (const m of s.monsters) {
    expect(m.hp).toBeGreaterThanOrEqual(0);
    expect(m.hp).toBeLessThanOrEqual(m.maxHp);
    expect(m.alive).toBe(m.hp > 0);
  }
  t.events.forEach((e, i) => expect(e.seq).toBe(i + 1));
}

const scenario = fc.record({
  seed: fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }).map((b) => b.toString(16).padStart(16, "0")),
  party: fc.array(fc.constantFrom(...CLASSES), { minLength: 1, maxLength: 4 }),
  picks: fc.array(fc.nat(), { minLength: 20, maxLength: 250 }),
});

function play(seed: string, party: string[], picks: number[]): Table {
  const t = new Table(
    seed,
    party.map((c, i) => ({ ownerId: `u${i + 1}`, classId: c, name: `H${i}` })),
  );
  for (const p of picks) {
    if (t.state.phase === "ended") break;
    const hero = t.state.heroes[p % t.state.heroes.length]!;
    const opts = options(t.state, hero.id);
    if (!opts.length) continue;
    t.run(opts[Math.floor(p / 7) % opts.length]!);
  }
  return t;
}

describe("свойства движка", () => {
  it("инварианты, воспроизводимость, восстановление из журнала, проверка бросков", () => {
    fc.assert(
      fc.property(scenario, ({ seed, party, picks }) => {
        const a = play(seed, party, picks);
        checkInvariants(a);
        // Одно зерно и одни команды дают один результат.
        const b = play(seed, party, picks);
        expect(b.events).toEqual(a.events);
        // Состояние полностью восстанавливается из журнала.
        expect(replay(a.events)).toEqual(a.state);
        // Снимок + хвост журнала = то же состояние.
        const cut = Math.floor(a.events.length / 2) || 1;
        expect(replay(a.events.slice(cut), replay(a.events.slice(0, cut)))).toEqual(a.state);
        // Каждый бросок проверяется по зерну.
        const report = verifyJournal(seed, a.events);
        expect(report.ok).toBe(true);
        expect(report.checked).toBe(a.state.rngCounter);
        // Проекция не раскрывает скрытое.
        const v = project(a.state, "u1");
        expect(v).not.toHaveProperty("rngCounter");
        expect(v.objects.some((o) => o.hidden)).toBe(false);
        v.heroes.filter((h) => h.ownerId !== "u1").forEach((h) => expect(h.plan).toBeNull());
      }),
      { numRuns: 300 },
    );
  });

  it("автоматический ход всегда доводит бой до конца", () => {
    fc.assert(
      fc.property(scenario, ({ seed, party }) => {
        const t = new Table(seed, party.map((c, i) => ({ ownerId: `u${i + 1}`, classId: c, name: `H${i}` })));
        t.ok({ type: "MOVE", heroId: "h1", objectId: "door_1" });
        for (let guard = 0; guard < 2000 && t.state.phase !== "ended"; guard++) {
          const h = t.state.heroes.find((x) => x.status === "up" && !x.ready)!;
          for (const c of autoTurn(t.state, h.id)) {
            if (t.state.phase === "ended") break;
            t.ok(c);
          }
        }
        expect(t.state.phase).toBe("ended");
        checkInvariants(t);
      }),
      { numRuns: 200 },
    );
  });

  it("подделанный бросок обнаруживается проверкой", () => {
    const t = play("00000000deadbeef", ["guardian"], Array.from({ length: 60 }, (_, i) => i * 13));
    const forged = structuredClone(t.events);
    const ev = forged.find((e) => e.draws?.length)!;
    ev.draws![0]![2] = (ev.draws![0]![2] + 1) % ev.draws![0]![1];
    expect(verifyJournal("00000000deadbeef", forged).ok).toBe(false);
  });
});
