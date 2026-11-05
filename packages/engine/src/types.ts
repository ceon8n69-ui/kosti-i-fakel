import type { Face } from "@kf/schema";
import type { Draw } from "./rng.js";

export type Attr = "STR" | "DEX" | "INT" | "SPI";
export type Row = "front" | "back";

export interface Assignment {
  die: number;
  /** id героя или монстра; null — грань без цели (череп, «по всем»). */
  target: string | null;
  /** Для звезды: индекс грани этого же кубика, которой она становится. */
  star?: number;
}

export interface Hero {
  id: string;
  ownerId: string;
  classId: string;
  name: string;
  level: number;
  hp: number;
  maxHp: number;
  block: number;
  poison: number;
  row: Row;
  status: "up" | "downed" | "dead";
  saves: { ok: number; fail: number };
  stats: Record<Attr, number>;
  dice: Face[][];
  /** Индекс выпавшей грани по каждому кубику; null — ещё не брошен. */
  roll: (number | null)[];
  freeRerolls: number;
  plan: Assignment[];
  ready: boolean;
  taunt: boolean;
}

export type IntentKind = "attack" | "block" | "doom" | "charge" | "summon" | "drain";

export interface Intent {
  kind: IntentKind;
  /** Цели атаки (герои) или союзник для блока. */
  targets: string[];
  amount: number;
  pierce?: boolean;
  /** summon: какой монстр появится. */
  spawn?: string;
}

export interface Monster {
  id: string;
  kind: string;
  hp: number;
  maxHp: number;
  armor: number;
  row: Row;
  boss: boolean;
  /** small — осколок слизня: не делится повторно. */
  variant?: "small";
  block: number;
  poison: number;
  alive: boolean;
  /** Сколько раундов монстр уже провёл в бою (для «раз в 2 раунда»). */
  age: number;
  intents: Intent[];
}

export type ObjectState = "armed" | "revealed" | "disarmed" | "triggered";

export interface RoomObject {
  id: string;
  kind: "corridor" | "trap" | "door";
  /** Скрытый объект не попадает в проекцию для игроков. */
  hidden: boolean;
  trapId?: string;
  state?: ObjectState;
  cells?: number;
}

export interface SessionState {
  v: 1;
  seq: number;
  rngCounter: number;
  scenarioId: string;
  tutorial: boolean;
  phase: "explore" | "combat" | "ended";
  partySize: number;
  light: number;
  torches: number;
  doom: number;
  heroes: Hero[];
  monsters: Monster[];
  round: number;
  step: "roll" | "plan" | null;
  objects: RoomObject[];
  encounter: string[];
  nextId: number;
  ended: null | { reason: "victory" | "defeat" | "retreat" };
}

// ───────── Команды ─────────

interface Base {
  commandId: string;
  expectedSeq: number;
  actorId: string;
}

export type Command =
  | (Base & { type: "INTERACT"; heroId: string; objectId: string; verb: "inspect" | "disarm" })
  | (Base & { type: "MOVE"; heroId: string; objectId: string })
  | (Base & { type: "CHANGE_ROW"; heroId: string; row: Row })
  | (Base & { type: "ROLL_DICE"; heroId: string })
  | (Base & { type: "REROLL"; heroId: string; dice: number[] })
  | (Base & { type: "USE_FATE_DEBT"; heroId: string; dice: number[] })
  | (Base & { type: "ASSIGN_FACE"; heroId: string; die: number; target: string | null; star?: number })
  | (Base & { type: "READY"; heroId: string; ready: boolean });

export type CommandType = Command["type"];

/** Команда без служебных полей — так её формирует клиент и тесты. */
export type CommandBody = Command extends infer C ? (C extends Command ? Omit<C, keyof Base> : never) : never;

// ───────── События ─────────

export type DamageKind = "melee" | "ranged" | "magic" | "poison" | "trap" | "skulls" | "monster";

type E<T extends string, P = object> = { seq: number; type: T; draws?: Draw[] } & P;

export type GameEvent =
  | E<"SESSION_STARTED", { initial: SessionState; seedHash: string }>
  | E<"CHECK_ROLLED", { heroId: string; attr: Attr; dc: number; natural: number; mod: number; total: number; success: boolean; traj: number; purpose: string }>
  | E<"TRAP_REVEALED", { objectId: string; trapId: string }>
  | E<"TRAP_DISARMED", { objectId: string }>
  | E<"TRAP_TRIGGERED", { objectId: string; trapId: string }>
  | E<"ROW_CHANGED", { heroId: string; row: Row }>
  | E<"PARTY_MOVED", { objectId: string; cells: number }>
  | E<"ENCOUNTER_STARTED", { kinds: string[] }>
  | E<"MONSTER_SPAWNED", { monster: Monster; reason: "encounter" | "split" | "summon" }>
  | E<"ROUND_STARTED", { round: number }>
  | E<"INTENTS_SHOWN", { intents: Record<string, Intent[]> }>
  | E<"HERO_DICE_ROLLED", { heroId: string; dice: number[]; faces: number[]; traj: number; kind: "roll" | "reroll" | "fate" }>
  | E<"FACE_ASSIGNED", { heroId: string; actorId: string; plan: Assignment[] }>
  | E<"HERO_READY", { heroId: string; ready: boolean }>
  | E<"ASSIGNMENTS_REVEALED", { heroId: string; plan: Assignment[] }>
  | E<"BLOCK_GAINED", { targetId: string; amount: number; sourceId: string }>
  | E<"TAUNT_SET", { heroId: string }>
  | E<"HEALED", { targetId: string; amount: number; sourceId: string }>
  | E<"DAMAGE_DEALT", { sourceId: string; targetId: string; amount: number; blocked: number; armor: number; kind: DamageKind }>
  | E<"POISON_CHANGED", { targetId: string; poison: number }>
  | E<"MONSTER_DIED", { monsterId: string }>
  | E<"ENEMY_TURN_STARTED">
  | E<"HERO_DOWNED", { heroId: string }>
  | E<"HERO_RAISED", { heroId: string; hp: number }>
  | E<"DEATH_SAVE_ROLLED", { heroId: string; natural: number; ok: number; fail: number; traj: number }>
  | E<"HERO_DIED", { heroId: string }>
  | E<"LIGHT_CHANGED", { delta: number; light: number; reason: string }>
  | E<"DOOM_CHANGED", { delta: number; doom: number; reason: string }>
  | E<"SESSION_ENDED", { reason: "victory" | "defeat" | "retreat" }>;

export type EventType = GameEvent["type"];
export type EventBody = GameEvent extends infer T ? (T extends GameEvent ? Omit<T, "seq"> : never) : never;

export interface CommandError {
  code: string;
  message?: string;
}

export interface CommandResult {
  state: SessionState;
  events: GameEvent[];
  errors: CommandError[];
}
