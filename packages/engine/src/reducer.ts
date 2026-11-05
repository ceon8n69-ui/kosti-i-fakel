import { runtimeObjects } from "./session.js";
import { balance } from "@kf/content";
import { clone } from "./clone.js";
import type { GameEvent, Hero, Monster, SessionState } from "./types.js";

/**
 * Единственное место, где меняется состояние. Всё, что делает движок, — это события,
 * поэтому состояние партии всегда пересчитывается из журнала.
 */
export function reduceInPlace(s: SessionState, ev: GameEvent): SessionState {
  if (ev.type === "SESSION_STARTED") {
    const fresh = upgradeState(clone(ev.initial));
    fresh.seq = ev.seq;
    return fresh;
  }
  s.seq = ev.seq;
  if (ev.draws?.length) s.rngCounter = Math.max(s.rngCounter, ev.draws[ev.draws.length - 1]![0] + 1);

  switch (ev.type) {
    case "CHECK_ROLLED":
      break;
    case "STAGE_ENTERED": {
      // У клиента описания нет — новую карту он получит вместе с состоянием в конце пачки.
      if (!ev.def) break;
      const def = clone(ev.def);
      const entrance = def.objects.find((o) => o.type === "entrance")!;
      s.def = def;
      s.dungeonId = def.id;
      s.title = def.title;
      s.biome = def.biome;
      s.stage = ev.stage;
      s.tiles = [...def.tiles];
      s.seen = def.tiles.map((r) => "0".repeat(r.length));
      s.pos = { x: entrance.x, y: entrance.y };
      s.objects = runtimeObjects(def);
      s.encounters = def.encounters.map((e) => ({ id: e.id, done: false, spotted: false }));
      s.encounterId = null;
      s.vars = Object.fromEntries(def.variables.map((v) => [v.id, v.initial]));
      s.ruleFired = {};
      s.monsters = [];
      break;
    }
    case "TRAP_REVEALED": {
      const o = obj(s, ev.objectId);
      o.hidden = false;
      o.state = "revealed";
      break;
    }
    case "TILE_REVEALED":
      for (const [x, y] of ev.cells) {
        const row = s.seen[y]!;
        s.seen[y] = row.slice(0, x) + "1" + row.slice(x + 1);
      }
      break;
    case "TILE_CHANGED":
      for (const [x, y, ch] of ev.cells) {
        const row = s.tiles[y]!;
        s.tiles[y] = row.slice(0, x) + ch + row.slice(x + 1);
      }
      break;
    case "OBJECT_CHANGED":
      Object.assign(obj(s, ev.objectId), ev.patch);
      break;
    case "SECRET_FOUND":
      obj(s, ev.object.id).hidden = false;
      break;
    case "TEXT_SHOWN":
      s.story = [...s.story, ev.text].slice(-20);
      break;
    case "ITEM_FOUND":
      s.bag.gold += ev.gold;
      s.bag.items.push(...ev.items);
      s.bag.keys.push(...ev.keys);
      break;
    case "ITEM_USED": {
      const i = s.bag.items.indexOf(ev.itemId);
      if (i >= 0) s.bag.items.splice(i, 1);
      break;
    }
    case "VARIABLE_SET":
      s.vars[ev.variable] = ev.value;
      break;
    case "RULE_FIRED":
      s.ruleFired[ev.ruleId] = (s.ruleFired[ev.ruleId] ?? 0) + 1;
      break;
    case "LEADER_CHANGED":
      s.leaderId = ev.heroId;
      break;
    case "PARTY_RESTED":
      obj(s, ev.objectId).used = true;
      break;
    case "ENCOUNTER_SPOTTED":
      enc(s, ev.encounterId).spotted = true;
      break;
    case "ENCOUNTER_ENDED": {
      const e = s.encounters.find((x) => x.id === ev.encounterId);
      if (e) e.done = true;
      s.phase = "explore";
      s.step = null;
      s.round = 0;
      s.encounterId = null;
      s.monsters = [];
      // Союзник уходит после стычки, в которой помог.
      s.allies = [];
      for (const h of s.heroes) {
        h.block = 0;
        h.roll = h.dice.map(() => null);
        h.plan = [];
        h.ready = false;
        h.taunt = false;
      }
      break;
    }
    case "REWARDS":
    case "SESSION_ENTERED":
      break;
    case "TURN_TIMED_OUT":
      break;
    case "OPTION_CHOSEN":
      obj(s, ev.objectId).used = true;
      break;
    case "GOLD_CHANGED":
      s.bag.gold = ev.gold;
      break;
    case "ALLY_JOINED":
      s.allies.push({ name: ev.name, damage: ev.damage });
      break;
    case "XP_BONUS":
      s.bonusXp += ev.amount;
      break;
    case "TRAP_DISARMED":
      obj(s, ev.objectId).state = "disarmed";
      break;
    case "TRAP_TRIGGERED": {
      const o = obj(s, ev.objectId);
      o.hidden = false;
      o.state = "triggered";
      break;
    }
    case "ROW_CHANGED":
      hero(s, ev.heroId).row = ev.row;
      break;
    case "PARTY_MOVED": {
      const last = ev.path[ev.path.length - 1];
      if (last) s.pos = { x: last[0], y: last[1] };
      break;
    }
    case "ENCOUNTER_STARTED": {
      s.phase = "combat";
      s.round = 0;
      s.encounterId = ev.encounterId;
      const e = s.encounters.find((x) => x.id === ev.encounterId);
      if (e) e.spotted = true;
      break;
    }
    case "MONSTER_SPAWNED":
      s.monsters.push(clone(ev.monster));
      s.nextId = Math.max(s.nextId, Number(ev.monster.id.slice(1)) + 1);
      break;
    case "ROUND_STARTED":
      s.round = ev.round;
      s.step = "roll";
      for (const h of s.heroes) {
        // Снаряжение с блоком даёт его в начале каждого раунда.
        h.block = h.status === "up" ? h.mods.block : 0;
        h.roll = h.dice.map(() => null);
        h.plan = [];
        h.ready = false;
        h.taunt = false;
        h.freeRerolls = balance.combat.freeRerolls + h.mods.rerolls;
      }
      for (const m of s.monsters) if (m.alive) m.age++;
      break;
    case "INTENTS_SHOWN":
      for (const m of s.monsters) m.intents = ev.intents[m.id] ?? [];
      break;
    case "HERO_DICE_ROLLED": {
      const h = hero(s, ev.heroId);
      ev.dice.forEach((d, i) => (h.roll[d] = ev.faces[i]!));
      if (ev.kind === "reroll") h.freeRerolls--;
      // Перебросанный кубик теряет назначение.
      h.plan = h.plan.filter((a) => !ev.dice.includes(a.die));
      h.ready = false;
      if (s.heroes.filter((x) => x.status === "up").every((x) => x.roll.every((r) => r !== null))) s.step = "plan";
      break;
    }
    case "FACE_ASSIGNED":
    case "ASSIGNMENTS_REVEALED":
      hero(s, ev.heroId).plan = clone(ev.plan);
      break;
    case "HERO_READY":
      hero(s, ev.heroId).ready = ev.ready;
      break;
    case "BLOCK_GAINED": {
      const t = unit(s, ev.targetId);
      t.block += ev.amount;
      break;
    }
    case "TAUNT_SET":
      hero(s, ev.heroId).taunt = true;
      break;
    case "HEALED": {
      const u = unit(s, ev.targetId);
      u.hp = Math.min(u.maxHp, u.hp + ev.amount);
      break;
    }
    case "DAMAGE_DEALT": {
      const t = unit(s, ev.targetId);
      t.block = Math.max(0, t.block - ev.blocked);
      t.hp = Math.max(0, t.hp - ev.amount);
      break;
    }
    case "POISON_CHANGED": {
      const t = unit(s, ev.targetId);
      t.poison = ev.poison;
      break;
    }
    case "MONSTER_DIED": {
      const m = monster(s, ev.monsterId);
      m.alive = false;
      m.hp = 0;
      m.intents = [];
      s.killed += m.variant ? 1 : (balance.monsters.find((d) => d.id === m.kind)?.cost ?? 0);
      break;
    }
    case "ENEMY_TURN_STARTED":
      for (const m of s.monsters) m.block = 0;
      break;
    case "HERO_DOWNED": {
      const h = hero(s, ev.heroId);
      h.status = "downed";
      h.hp = 0;
      h.saves = { ok: 0, fail: 0 };
      break;
    }
    case "HERO_RAISED": {
      const h = hero(s, ev.heroId);
      h.status = "up";
      h.hp = ev.hp;
      h.saves = { ok: 0, fail: 0 };
      break;
    }
    case "DEATH_SAVE_ROLLED":
      hero(s, ev.heroId).saves = { ok: ev.ok, fail: ev.fail };
      break;
    case "HERO_DIED":
      hero(s, ev.heroId).status = "dead";
      break;
    case "LIGHT_CHANGED":
      s.light = ev.light;
      break;
    case "DOOM_CHANGED":
      s.doom = ev.doom;
      break;
    case "SESSION_ENDED":
      s.phase = "ended";
      s.step = null;
      s.ended = { reason: ev.reason };
      break;
    default: {
      const never: never = ev;
      throw new Error(`unknown event ${(never as GameEvent).type}`);
    }
  }
  return s;
}

/** Чистая версия: исходное состояние не меняется. */
export function applyEvent(s: SessionState, ev: GameEvent): SessionState {
  return reduceInPlace(clone(s), ev);
}

/** Восстановление из журнала (опционально — от снимка). */
export function replay(events: GameEvent[], from?: SessionState): SessionState {
  let s = from ? upgradeState(clone(from)) : (undefined as unknown as SessionState);
  for (const ev of events) {
    if (!s && ev.type !== "SESSION_STARTED") throw new Error("journal must start with SESSION_STARTED");
    s = reduceInPlace(s, ev);
  }
  if (!s) throw new Error("empty journal");
  return s;
}

function enc(s: SessionState, id: string) {
  const e = s.encounters.find((x) => x.id === id);
  if (!e) throw new Error(`no encounter ${id}`);
  return e;
}

function obj(s: SessionState, id: string) {
  const o = s.objects.find((x) => x.id === id);
  if (!o) throw new Error(`no object ${id}`);
  return o;
}
export function hero(s: SessionState, id: string): Hero {
  const h = s.heroes.find((x) => x.id === id);
  if (!h) throw new Error(`no hero ${id}`);
  return h;
}
export function monster(s: SessionState, id: string): Monster {
  const m = s.monsters.find((x) => x.id === id);
  if (!m) throw new Error(`no monster ${id}`);
  return m;
}
export function unit(s: SessionState, id: string): Hero | Monster {
  return s.heroes.find((x) => x.id === id) ?? monster(s, id);
}

/**
 * Партии, начатые до появления снаряжения, союзников и биомов: их журнал и снимки
 * не содержат новых полей. Дополняем значениями «как будто ничего нет» — поведение старых партий не меняется.
 */
export function upgradeState(s: SessionState): SessionState {
  s.bonusXp ??= 0;
  s.allies ??= [];
  s.biome ??= "dungeon";
  s.stage ??= 1;
  s.stages ??= 1;
  for (const h of s.heroes) {
    h.equipment ??= [];
    h.mods ??= { dmg: { M: 0, L: 0, I: 0 }, block: 0, healAfter: 0, rerolls: 0, poison: 0, light: 0 } as SessionState["heroes"][number]["mods"];
  }
  return s;
}
