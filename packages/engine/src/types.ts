import type { DungeonDefinition, DungeonObjectType, Face } from "@kf/schema";
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
  /** id постоянного героя в БД. */
  dbId?: string;
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

/** Объект подземелья во время похода. Скрытые поля (dc, тайники) не уходят клиенту. */
export interface RObject {
  id: string;
  type: DungeonObjectType;
  x: number;
  y: number;
  hidden: boolean;
  /** Двери. */
  open?: boolean;
  locked?: boolean;
  keyId?: string;
  lockDc?: number;
  secretDc?: number;
  /** Ловушки. */
  trapId?: string;
  state?: ObjectState;
  /** Сундук открыт, рычаг потянут, ключ взят, NPC выслушан, костёр использован. */
  used?: boolean;
  textId?: string;
  npcId?: string;
  radius?: number;
  variable?: string;
}

export interface EncounterState {
  id: string;
  done: boolean;
  spotted: boolean;
}

export interface Bag {
  keys: string[];
  items: string[];
  gold: number;
}

export interface SessionState {
  v: 2;
  seq: number;
  rngCounter: number;
  dungeonId: string;
  title: string;
  tier: number;
  tutorial: boolean;
  phase: "explore" | "combat" | "ended";
  partySize: number;
  light: number;
  doom: number;
  heroes: Hero[];
  monsters: Monster[];
  round: number;
  step: "roll" | "plan" | null;
  /** Полное описание подземелья — только на сервере. */
  def: DungeonDefinition;
  tiles: string[];
  /** Открытые клетки: '1' — видели. */
  seen: string[];
  pos: { x: number; y: number };
  leaderId: string;
  objects: RObject[];
  encounters: EncounterState[];
  encounterId: string | null;
  vars: Record<string, number>;
  ruleFired: Record<string, number>;
  bag: Bag;
  /** Сумма стоимости побеждённых монстров — для опыта. */
  killed: number;
  /** Последние тексты истории (видны всем). */
  story: string[];
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
  | (Base & { type: "MOVE"; heroId: string; x: number; y: number })
  | (Base & { type: "INTERACT"; heroId: string; objectId: string; verb: "use" | "force" | "disarm" })
  | (Base & { type: "SEARCH"; heroId: string })
  | (Base & { type: "REST"; heroId: string; objectId: string })
  | (Base & { type: "RETREAT"; heroId: string })
  | (Base & { type: "USE_ITEM"; heroId: string; itemId: string; targetId?: string })
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
  | E<"SESSION_ENTERED">
  | E<"CHECK_ROLLED", { heroId: string; attr: Attr; dc: number; natural: number; mod: number; total: number; success: boolean; traj: number; purpose: string }>
  | E<"TRAP_REVEALED", { objectId: string; trapId: string; x: number; y: number }>
  | E<"TRAP_DISARMED", { objectId: string }>
  | E<"TRAP_TRIGGERED", { objectId: string; trapId: string; x: number; y: number }>
  | E<"ROW_CHANGED", { heroId: string; row: Row }>
  | E<"PARTY_MOVED", { path: [number, number][]; cost: number }>
  | E<"TILE_REVEALED", { cells: [number, number, string][]; objects: VisibleObject[] }>
  | E<"TILE_CHANGED", { cells: [number, number, string][] }>
  | E<"OBJECT_CHANGED", { objectId: string; patch: Partial<RObject> }>
  | E<"SECRET_FOUND", { object: VisibleObject }>
  | E<"TEXT_SHOWN", { textId: string; text: string; speaker?: string }>
  | E<"ITEM_FOUND", { objectId: string; gold: number; items: string[]; keys: string[] }>
  | E<"ITEM_USED", { heroId: string; itemId: string; targetId?: string }>
  | E<"VARIABLE_SET", { variable: string; value: number }>
  | E<"RULE_FIRED", { ruleId: string }>
  | E<"LEADER_CHANGED", { heroId: string }>
  | E<"PARTY_RESTED", { objectId: string }>
  | E<"ENCOUNTER_SPOTTED", { encounterId: string; kinds: string[]; x: number; y: number }>
  | E<"ENCOUNTER_STARTED", { encounterId: string; kinds: string[] }>
  | E<"ENCOUNTER_ENDED", { encounterId: string }>
  | E<"REWARDS", { xp: number; gold: number; items: string[]; reason: "victory" | "defeat" | "retreat" }>
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

/** Объект в том виде, в каком его видит игрок: без dc и секретов. */
export interface VisibleObject {
  id: string;
  type: DungeonObjectType;
  x: number;
  y: number;
  open?: boolean;
  locked?: boolean;
  state?: ObjectState;
  trapId?: string;
  used?: boolean;
  npcId?: string;
  radius?: number;
}
