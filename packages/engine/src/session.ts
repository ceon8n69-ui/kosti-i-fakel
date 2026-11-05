import { balance, dungeonById } from "@kf/content";
import type { DungeonDefinition } from "@kf/schema";
import { clone } from "./clone.js";
import { modsOf } from "./loot.js";
import type { GameEvent, Hero, RObject, Row, SessionState } from "./types.js";

export interface HeroSeed {
  ownerId: string;
  classId: string;
  name: string;
  /** Постоянный герой из БД: уровень и опыт переносятся в поход. */
  dbId?: string;
  level?: number;
  maxHp?: number;
  consumables?: string[];
  /** Надетое снаряжение (ключи каталога). */
  equipment?: string[];
}

const DEFAULT_ROW: Record<string, Row> = { guardian: "front", rogue: "front", sorcerer: "back", healer: "back" };

export function createHero(id: string, seed: HeroSeed): Hero {
  const cls = balance.classes.find((c) => c.id === seed.classId);
  if (!cls) throw new Error(`unknown class ${seed.classId}`);
  const equipment = seed.equipment ?? [];
  const eq = modsOf(equipment);
  const maxHp = (seed.maxHp ?? cls.hp) + eq.hp;
  const stats = { ...cls.stats } as Hero["stats"];
  for (const [a, n] of Object.entries(eq.stats)) stats[a as keyof Hero["stats"]] = Math.min(balance.stats.max, stats[a as keyof Hero["stats"]] + n);
  return {
    id,
    ownerId: seed.ownerId,
    classId: cls.id,
    name: seed.name.slice(0, 32),
    level: seed.level ?? 1,
    hp: maxHp,
    maxHp,
    block: 0,
    poison: 0,
    row: DEFAULT_ROW[cls.id] ?? "front",
    status: "up",
    saves: { ok: 0, fail: 0 },
    stats,
    dice: clone(cls.dice),
    roll: cls.dice.map(() => null),
    freeRerolls: balance.combat.freeRerolls + eq.mods.rerolls,
    equipment,
    mods: eq.mods,
    plan: [],
    ready: false,
    taunt: false,
    ...(seed.dbId ? { dbId: seed.dbId } : {}),
  };
}

export function runtimeObjects(def: DungeonDefinition): RObject[] {
  return def.objects.map((o): RObject => {
    const r: RObject = { id: o.id, type: o.type, x: o.x, y: o.y, hidden: false };
    switch (o.type) {
      case "door":
        r.open = o.open;
        r.hidden = !!o.secretDc;
        if (o.secretDc) r.secretDc = o.secretDc;
        if (o.lock) {
          r.locked = true;
          if (o.lock.keyId) r.keyId = o.lock.keyId;
          if (o.lock.dc) r.lockDc = o.lock.dc;
        }
        break;
      case "chest":
        r.used = false;
        if (o.lock) {
          r.locked = true;
          if (o.lock.keyId) r.keyId = o.lock.keyId;
          if (o.lock.dc) r.lockDc = o.lock.dc;
        }
        break;
      case "trap":
        r.trapId = o.trapId;
        r.hidden = o.hidden;
        r.state = o.hidden ? "armed" : "revealed";
        break;
      case "key":
        r.keyId = o.keyId;
        if (o.textId) r.textId = o.textId;
        r.used = false;
        break;
      case "lever":
      case "plate":
        r.variable = o.variable;
        r.used = false;
        if (o.type === "lever" && o.textId) r.textId = o.textId;
        break;
      case "note":
      case "altar":
      case "treasury":
        if (o.textId) r.textId = o.textId;
        if (o.type === "altar") r.used = false;
        break;
      case "npc":
        r.npcId = o.npcId;
        r.used = false;
        break;
      case "light":
        r.radius = o.radius;
        break;
      case "campfire":
        r.used = false;
        break;
      case "event": {
        const ev = def.events.find((e) => e.id === o.eventId);
        r.used = false;
        r.eventId = o.eventId;
        if (ev)
          r.event = {
            text: ev.text,
            options: ev.options.map((op) => ({ id: op.id, label: op.label, ...(op.check ? { check: op.check } : {}), ...(op.cost ? { cost: op.cost } : {}) })),
          };
        break;
      }
      default:
        break;
    }
    return r;
  });
}

/** Первое событие журнала. Описание подземелья (версия) кладётся в журнал, зерно — нет. */
export function startSession(params: { dungeonId?: string; dungeon?: DungeonDefinition; seedHash: string; heroes: HeroSeed[] }): GameEvent {
  const def = params.dungeon ?? (params.dungeonId ? dungeonById(params.dungeonId) : undefined);
  if (!def) throw new Error(`unknown dungeon ${params.dungeonId}`);
  if (params.heroes.length < 1 || params.heroes.length > 4) throw new Error("party size 1..4");
  const entrance = def.objects.find((o) => o.type === "entrance")!;
  const heroes = params.heroes.map((h, i) => createHero(`h${i + 1}`, h));
  const startItems = [
    ...Array.from({ length: balance.light.torches }, () => "torch"),
    ...params.heroes.flatMap((h) => h.consumables ?? balance.explore.startConsumables),
  ];
  const initial: SessionState = {
    v: 2,
    seq: 0,
    rngCounter: 0,
    dungeonId: def.id,
    title: def.title,
    tier: def.tier,
    tutorial: def.tutorial,
    phase: "explore",
    partySize: heroes.length,
    light: balance.light.start + heroes.reduce((n, h) => n + h.mods.light, 0),
    doom: 0,
    heroes,
    monsters: [],
    round: 0,
    step: null,
    def: clone(def),
    tiles: [...def.tiles],
    seen: def.tiles.map((r) => "0".repeat(r.length)),
    pos: { x: entrance.x, y: entrance.y },
    leaderId: heroes[0]!.id,
    objects: runtimeObjects(def),
    encounters: def.encounters.map((e) => ({ id: e.id, done: false, spotted: false })),
    encounterId: null,
    vars: Object.fromEntries(def.variables.map((v) => [v.id, v.initial])),
    ruleFired: {},
    bag: { keys: [], items: startItems, gold: 0 },
    killed: 0,
    bonusXp: 0,
    allies: [],
    biome: def.biome,
    stage: def.stage ?? 1,
    stages: def.stages ?? 1,
    story: [],
    nextId: 1,
    ended: null,
  };
  return { seq: 1, type: "SESSION_STARTED", initial, seedHash: params.seedHash };
}
