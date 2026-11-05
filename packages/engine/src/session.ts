import { clone } from "./clone.js";
import { balance, scenarios } from "@kf/content";
import type { GameEvent, Hero, Row, SessionState } from "./types.js";

export interface HeroSeed {
  ownerId: string;
  classId: string;
  name: string;
}

const DEFAULT_ROW: Record<string, Row> = { guardian: "front", rogue: "front", sorcerer: "back", healer: "back" };

export function createHero(id: string, seed: HeroSeed): Hero {
  const cls = balance.classes.find((c) => c.id === seed.classId);
  if (!cls) throw new Error(`unknown class ${seed.classId}`);
  return {
    id,
    ownerId: seed.ownerId,
    classId: cls.id,
    name: seed.name.slice(0, 32),
    level: 1,
    hp: cls.hp,
    maxHp: cls.hp,
    block: 0,
    poison: 0,
    row: DEFAULT_ROW[cls.id] ?? "front",
    status: "up",
    saves: { ok: 0, fail: 0 },
    stats: { ...cls.stats } as Hero["stats"],
    dice: clone(cls.dice),
    roll: cls.dice.map(() => null),
    freeRerolls: balance.combat.freeRerolls,
    plan: [],
    ready: false,
    taunt: false,
  };
}

/** Первое событие журнала. Зерно в него не попадает — только хеш. */
export function startSession(params: { scenarioId: string; seedHash: string; heroes: HeroSeed[] }): GameEvent {
  const sc = scenarios[params.scenarioId];
  if (!sc) throw new Error(`unknown scenario ${params.scenarioId}`);
  if (params.heroes.length < 1 || params.heroes.length > 4) throw new Error("party size 1..4");
  const r = sc.room;
  const initial: SessionState = {
    v: 1,
    seq: 0,
    rngCounter: 0,
    scenarioId: sc.id,
    tutorial: sc.tutorial,
    phase: "explore",
    partySize: params.heroes.length,
    light: balance.light.start,
    torches: balance.light.torches,
    doom: 0,
    heroes: params.heroes.map((h, i) => createHero(`h${i + 1}`, h)),
    monsters: [],
    round: 0,
    step: null,
    objects: [
      { id: r.corridor.id, kind: "corridor", hidden: false, cells: r.corridor.cells },
      { id: r.trap.id, kind: "trap", hidden: true, trapId: r.trap.trapId, state: "armed" },
      { id: r.door.id, kind: "door", hidden: false, cells: r.door.cells },
    ],
    encounter: [...sc.encounter],
    nextId: 1,
    ended: null,
  };
  return { seq: 1, type: "SESSION_STARTED", initial, seedHash: params.seedHash };
}
