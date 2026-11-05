import { clone } from "./clone.js";
import type { GameEvent, Hero, Monster, SessionState } from "./types.js";

/**
 * Единственное место, где меняется состояние. Всё, что делает движок, — это события,
 * поэтому состояние партии всегда пересчитывается из журнала.
 */
export function reduceInPlace(s: SessionState, ev: GameEvent): SessionState {
  if (ev.type === "SESSION_STARTED") {
    const fresh = clone(ev.initial);
    fresh.seq = ev.seq;
    return fresh;
  }
  s.seq = ev.seq;
  if (ev.draws?.length) s.rngCounter = Math.max(s.rngCounter, ev.draws[ev.draws.length - 1]![0] + 1);

  switch (ev.type) {
    case "CHECK_ROLLED":
      break;
    case "TRAP_REVEALED": {
      const o = obj(s, ev.objectId);
      o.hidden = false;
      o.state = "revealed";
      break;
    }
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
    case "PARTY_MOVED":
      break;
    case "ENCOUNTER_STARTED":
      s.phase = "combat";
      s.round = 0;
      break;
    case "MONSTER_SPAWNED":
      s.monsters.push(clone(ev.monster));
      s.nextId = Math.max(s.nextId, Number(ev.monster.id.slice(1)) + 1);
      break;
    case "ROUND_STARTED":
      s.round = ev.round;
      s.step = "roll";
      for (const h of s.heroes) {
        h.block = 0;
        h.roll = h.dice.map(() => null);
        h.plan = [];
        h.ready = false;
        h.taunt = false;
        h.freeRerolls = 1;
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
      const h = hero(s, ev.targetId);
      h.hp = Math.min(h.maxHp, h.hp + ev.amount);
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
  let s = from ? clone(from) : (undefined as unknown as SessionState);
  for (const ev of events) {
    if (!s && ev.type !== "SESSION_STARTED") throw new Error("journal must start with SESSION_STARTED");
    s = reduceInPlace(s, ev);
  }
  if (!s) throw new Error("empty journal");
  return s;
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
