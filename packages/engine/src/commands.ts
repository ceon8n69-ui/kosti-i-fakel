import { clone } from "./clone.js";
import { balance } from "@kf/content";
import type { Face } from "@kf/schema";
import { aliveMonsters, effectiveFace, isDamageFace, legalTargets, meleeTargets, upHeroes } from "./faces.js";
import { hero as getHero, monster as getMonster, reduceInPlace } from "./reducer.js";
import type { Rng } from "./rng.js";
import type {
  Assignment,
  Attr,
  Command,
  CommandError,
  CommandResult,
  EventBody,
  GameEvent,
  Hero,
  Intent,
  Monster,
  SessionState,
} from "./types.js";

/** Число траекторий на клиенте для каждого типа кубика (ТЗ 9.3). */
export const TRAJECTORIES = 12;

class Ctx {
  events: GameEvent[] = [];
  constructor(
    public s: SessionState,
    public rng: Rng,
  ) {}

  emit(body: EventBody): GameEvent {
    const ev = { ...body, seq: this.s.seq + 1 } as GameEvent;
    const draws = this.rng.takeDraws();
    if (draws.length) ev.draws = draws;
    reduceInPlace(this.s, ev);
    this.events.push(ev);
    return ev;
  }

  get ended(): boolean {
    return this.s.phase === "ended";
  }
}

const fail = (code: string, message?: string): CommandError => ({ code, message });

/**
 * applyCommand(state, command, rng) → { state, events, errors }.
 * Исходное состояние не меняется. При ошибке событий нет и броски не тратятся.
 */
export function applyCommand(state: SessionState, cmd: Command, rng: Rng): CommandResult {
  if (rng.counter !== state.rngCounter) throw new Error("rng is not aligned with state.rngCounter");
  const err = validate(state, cmd);
  if (err) return { state, events: [], errors: [err] };
  const ctx = new Ctx(clone(state), rng);
  execute(ctx, cmd);
  return { state: ctx.s, events: ctx.events, errors: [] };
}

// ───────── Проверка ─────────

function validate(s: SessionState, cmd: Command): CommandError | null {
  if (s.phase === "ended") return fail("session_ended");
  if (cmd.expectedSeq !== s.seq) return fail("stale_seq", `expected ${s.seq}`);
  const h = s.heroes.find((x) => x.id === cmd.heroId);
  if (!h) return fail("no_hero");
  if (h.ownerId !== cmd.actorId) return fail("not_your_hero");
  if (h.status !== "up") return fail("hero_not_up");

  switch (cmd.type) {
    case "INTERACT": {
      if (s.phase !== "explore") return fail("wrong_phase");
      const o = s.objects.find((x) => x.id === cmd.objectId);
      if (!o || o.hidden) return fail("no_object");
      if (cmd.verb === "inspect" && o.kind !== "corridor") return fail("bad_verb");
      if (cmd.verb === "disarm" && !(o.kind === "trap" && o.state === "revealed")) return fail("bad_verb");
      return null;
    }
    case "MOVE": {
      if (s.phase !== "explore") return fail("wrong_phase");
      const o = s.objects.find((x) => x.id === cmd.objectId);
      if (!o || o.kind !== "door") return fail("no_object");
      return null;
    }
    case "CHANGE_ROW":
      if (s.phase !== "explore") return fail("wrong_phase");
      if (cmd.row !== "front" && cmd.row !== "back") return fail("bad_row");
      return null;
    case "ROLL_DICE":
      if (s.phase !== "combat") return fail("wrong_phase");
      if (h.roll.some((r) => r !== null)) return fail("already_rolled");
      return null;
    case "REROLL":
    case "USE_FATE_DEBT": {
      if (s.phase !== "combat") return fail("wrong_phase");
      if (h.roll.some((r) => r === null)) return fail("not_rolled");
      if (h.ready) return fail("already_ready");
      if (cmd.type === "REROLL" && h.freeRerolls < 1) return fail("no_free_rerolls");
      const ok =
        Array.isArray(cmd.dice) &&
        cmd.dice.length > 0 &&
        new Set(cmd.dice).size === cmd.dice.length &&
        cmd.dice.every((d) => Number.isInteger(d) && d >= 0 && d < h.dice.length);
      return ok ? null : fail("bad_dice");
    }
    case "ASSIGN_FACE": {
      if (s.phase !== "combat") return fail("wrong_phase");
      if (h.roll.some((r) => r === null)) return fail("not_rolled");
      if (h.ready) return fail("already_ready");
      if (!Number.isInteger(cmd.die) || cmd.die < 0 || cmd.die >= h.dice.length) return fail("bad_die");
      const rolled = h.dice[cmd.die]![h.roll[cmd.die]!]!;
      if (rolled.t === "STAR") {
        if (cmd.target === null && cmd.star == null) return null; // снять назначение
        if (cmd.star == null) return fail("star_needs_face");
      } else if (cmd.star != null) return fail("not_a_star");
      const face = effectiveFace(h, cmd);
      if (!face) return fail("bad_star");
      const legal = legalTargets(s, h, face);
      if (cmd.target === null && !legal.includes(null)) return null; // снять назначение
      if (!legal.includes(cmd.target)) return fail("bad_target");
      return null;
    }
    case "READY":
      if (s.phase !== "combat") return fail("wrong_phase");
      if (h.roll.some((r) => r === null)) return fail("not_rolled");
      return null;
  }
}

// ───────── Исполнение ─────────

function execute(ctx: Ctx, cmd: Command): void {
  const s = ctx.s;
  switch (cmd.type) {
    case "INTERACT": {
      const trap = s.objects.find((o) => o.kind === "trap");
      const def = trap ? balance.traps.find((t) => t.id === trap.trapId)! : undefined;
      if (cmd.verb === "inspect") {
        const dc = def?.dc ?? balance.checks.dc.normal;
        const ok = check(ctx, cmd.heroId, def?.spot ?? "INT", dc, "inspect");
        spendLight(ctx, balance.light.cost.check, "check");
        if (ok && trap && trap.state === "armed" && trap.hidden)
          ctx.emit({ type: "TRAP_REVEALED", objectId: trap.id, trapId: trap.trapId! });
      } else {
        const ok = check(ctx, cmd.heroId, def!.disarm, def!.dc, "disarm");
        spendLight(ctx, balance.light.cost.check, "check");
        if (ok) ctx.emit({ type: "TRAP_DISARMED", objectId: trap!.id });
        else triggerTrap(ctx, trap!.id);
      }
      checkWipe(ctx);
      return;
    }
    case "MOVE": {
      const corridor = s.objects.find((o) => o.kind === "corridor");
      const cells = (corridor?.cells ?? 0) + (s.objects.find((o) => o.id === cmd.objectId)?.cells ?? 0);
      const trap = s.objects.find((o) => o.kind === "trap");
      ctx.emit({ type: "PARTY_MOVED", objectId: cmd.objectId, cells });
      spendLight(ctx, Math.ceil(cells / balance.light.cost.moveCellsPerUnit), "move");
      if (trap && (trap.state === "armed" || trap.state === "revealed")) triggerTrap(ctx, trap.id);
      if (checkWipe(ctx)) return;
      startEncounter(ctx);
      return;
    }
    case "CHANGE_ROW":
      ctx.emit({ type: "ROW_CHANGED", heroId: cmd.heroId, row: cmd.row });
      return;
    case "ROLL_DICE":
      rollHeroDice(ctx, cmd.heroId, [0, 1, 2], "roll");
      return;
    case "REROLL":
      rollHeroDice(ctx, cmd.heroId, [...cmd.dice].sort(), "reroll");
      return;
    case "USE_FATE_DEBT":
      rollHeroDice(ctx, cmd.heroId, [...cmd.dice].sort(), "fate");
      ctx.emit({ type: "DOOM_CHANGED", delta: 1, doom: s.doom + 1, reason: "fate_debt" });
      return;
    case "ASSIGN_FACE": {
      const h = getHero(s, cmd.heroId);
      const plan = h.plan.filter((a) => a.die !== cmd.die);
      const isUnassign =
        cmd.target === null &&
        (() => {
          const f = effectiveFace(h, cmd);
          return !f || !legalTargets(s, h, f).includes(null);
        })();
      if (!isUnassign) plan.push(cmd.star != null ? { die: cmd.die, target: cmd.target, star: cmd.star } : { die: cmd.die, target: cmd.target });
      plan.sort((a, b) => a.die - b.die);
      ctx.emit({ type: "FACE_ASSIGNED", heroId: h.id, actorId: cmd.actorId, plan });
      return;
    }
    case "READY":
      ctx.emit({ type: "HERO_READY", heroId: cmd.heroId, ready: cmd.ready });
      if (cmd.ready && upHeroes(s).every((h) => h.ready)) resolveRound(ctx);
      return;
  }
}

// ───────── Проверки d20 ─────────

export function lightState(light: number) {
  const states = [...balance.light.states].sort((a, b) => b.min - a.min);
  return states.find((st) => light >= st.min) ?? states[states.length - 1]!;
}

function check(ctx: Ctx, heroId: string, attr: Attr, dc: number, purpose: string): boolean {
  const h = getHero(ctx.s, heroId);
  const natural = ctx.rng.int(20) + 1;
  const traj = ctx.rng.int(TRAJECTORIES);
  const mod = h.stats[attr] + lightState(ctx.s.light).checkMod;
  const total = natural + mod;
  const success = natural === 20 ? true : natural === 1 ? false : total >= dc;
  ctx.emit({ type: "CHECK_ROLLED", heroId, attr, dc, natural, mod, total, success, traj, purpose });
  return success;
}

function spendLight(ctx: Ctx, amount: number, reason: string): void {
  if (amount <= 0) return;
  const light = Math.max(0, ctx.s.light - amount);
  if (light !== ctx.s.light) ctx.emit({ type: "LIGHT_CHANGED", delta: light - ctx.s.light, light, reason });
}

function triggerTrap(ctx: Ctx, objectId: string): void {
  const o = ctx.s.objects.find((x) => x.id === objectId)!;
  const def = balance.traps.find((t) => t.id === o.trapId)!;
  ctx.emit({ type: "TRAP_TRIGGERED", objectId, trapId: def.id });
  const up = upHeroes(ctx.s);
  if (!up.length) return;
  const p = def.params;
  switch (def.effect) {
    case "damage_random":
      damageHero(ctx, up[ctx.rng.int(up.length)]!.id, p.damage ?? 0, def.id, "trap", true);
      break;
    case "damage_leader":
      damageHero(ctx, up[0]!.id, p.damage ?? 0, def.id, "trap", true);
      break;
    case "poison_all_light":
      for (const h of up) ctx.emit({ type: "POISON_CHANGED", targetId: h.id, poison: h.poison + (p.poison ?? 0) });
      spendLight(ctx, p.light ?? 0, "trap");
      break;
    default:
      break; // block_path — этап 2 (карта)
  }
}

// ───────── Бой ─────────

export function createMonster(kind: string, id: string, partySize: number, hpOverride?: number): Monster {
  const def = balance.monsters.find((m) => m.id === kind);
  if (!def) throw new Error(`unknown monster ${kind}`);
  const scale = balance.partyHpScale[String(Math.min(4, Math.max(1, partySize)))] ?? 1;
  const hp = Math.max(1, Math.round((hpOverride ?? def.hp) * scale));
  return {
    id,
    kind,
    hp,
    maxHp: hp,
    armor: def.armor,
    row: def.row,
    boss: def.boss,
    block: 0,
    poison: 0,
    alive: true,
    age: 0,
    intents: [],
  };
}

function spawn(ctx: Ctx, kind: string, reason: "encounter" | "split" | "summon", hpOverride?: number): void {
  const m = createMonster(kind, `m${ctx.s.nextId}`, ctx.s.partySize, hpOverride);
  ctx.emit({ type: "MONSTER_SPAWNED", monster: m, reason });
}

function startEncounter(ctx: Ctx): void {
  ctx.emit({ type: "ENCOUNTER_STARTED", kinds: ctx.s.encounter });
  for (const kind of ctx.s.encounter) spawn(ctx, kind, "encounter");
  startRound(ctx, 1);
}

/** Герои в досягаемости монстра: ближний бой — передний ряд, если там кто-то стоит. */
function heroesInReach(s: SessionState, melee: boolean): Hero[] {
  const up = upHeroes(s);
  if (!melee) return up;
  const front = up.filter((h) => h.row === "front");
  return front.length ? front : up;
}

function pick<T>(ctx: Ctx, list: T[]): T | undefined {
  if (!list.length) return undefined;
  return list.length === 1 ? list[0] : list[ctx.rng.int(list.length)];
}

function intentsFor(ctx: Ctx, m: Monster): Intent[] {
  const def = balance.monsters.find((d) => d.id === m.kind)!;
  const p = def.params;
  const s = ctx.s;
  const attack = (melee: boolean, amount: number, extra: Partial<Intent> = {}): Intent | null => {
    const t = pick(ctx, heroesInReach(s, melee));
    return t ? { kind: "attack", targets: [t.id], amount, ...extra } : null;
  };
  const out: (Intent | null)[] = [];
  switch (def.behavior) {
    case "multi_hit": {
      const pool = [...heroesInReach(s, true)];
      const targets: string[] = [];
      for (let i = 0; i < (p.targets ?? 1) && pool.length; i++) {
        const idx = pool.length === 1 ? 0 : ctx.rng.int(pool.length);
        targets.push(pool.splice(idx, 1)[0]!.id);
      }
      if (targets.length) out.push({ kind: "attack", targets, amount: p.damage ?? 1 });
      break;
    }
    case "melee":
    case "melee_split":
      out.push(attack(true, p.damage ?? 1));
      break;
    case "melee_pierce":
      out.push(attack(true, p.damage ?? 1, { pierce: true }));
      break;
    case "ranged":
      out.push(attack(false, p.damage ?? 1));
      break;
    case "support": {
      const allies = aliveMonsters(s).filter((a) => a.id !== m.id);
      if (allies.length) {
        const weakest = [...allies].sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp || a.id.localeCompare(b.id))[0]!;
        out.push({ kind: "block", targets: [weakest.id], amount: p.block ?? 0 });
      } else out.push({ kind: "doom", targets: [], amount: p.doom ?? 1 });
      break;
    }
    case "charge":
      out.push(m.age % (p.every ?? 2) === 0 ? attack(true, p.damage ?? 1) : { kind: "charge", targets: [], amount: p.damage ?? 0 });
      break;
    case "boss_summon":
      out.push(attack(true, p.damage ?? 1));
      if (m.age % (p.every ?? 2) === 0) out.push({ kind: "summon", targets: [], amount: 1, spawn: "rat_swarm" });
      break;
    case "boss_drain_light":
      out.push(attack(false, p.damage ?? 1));
      out.push({ kind: "drain", targets: [], amount: p.light ?? 0 });
      break;
    default:
      throw new Error(`unknown behavior ${def.behavior}`);
  }
  return out.filter((x): x is Intent => x !== null);
}

function startRound(ctx: Ctx, round: number): void {
  ctx.emit({ type: "ROUND_STARTED", round });
  const intents: Record<string, Intent[]> = {};
  for (const m of aliveMonsters(ctx.s)) intents[m.id] = intentsFor(ctx, m);
  ctx.emit({ type: "INTENTS_SHOWN", intents });
}

function rollHeroDice(ctx: Ctx, heroId: string, dice: number[], kind: "roll" | "reroll" | "fate"): void {
  const h = getHero(ctx.s, heroId);
  const faces = dice.map((d) => ctx.rng.int(h.dice[d]!.length));
  const traj = ctx.rng.int(TRAJECTORIES);
  ctx.emit({ type: "HERO_DICE_ROLLED", heroId, dice, faces, traj, kind });
  const skulls = dice.filter((d, i) => h.dice[d]![faces[i]!]!.t === "SKULL").length;
  if (dice.length === 3 && skulls === 3) {
    damageHero(ctx, heroId, balance.combat.tripleSkullDamage, heroId, "skulls", true);
    if (checkWipe(ctx)) return;
  }
}

/** Урон герою. Возвращает true, если герой упал. */
function damageHero(ctx: Ctx, heroId: string, raw: number, sourceId: string, kind: "monster" | "trap" | "skulls" | "poison", pierce: boolean): boolean {
  const h = getHero(ctx.s, heroId);
  if (h.status !== "up") return false;
  const blocked = pierce ? 0 : Math.min(h.block, raw);
  const amount = Math.min(h.hp, raw - blocked);
  ctx.emit({ type: "DAMAGE_DEALT", sourceId, targetId: heroId, amount, blocked, armor: 0, kind });
  if (getHero(ctx.s, heroId).hp === 0) {
    ctx.emit({ type: "HERO_DOWNED", heroId });
    return true;
  }
  return false;
}

function damageMonster(ctx: Ctx, m: Monster, face: Face, sourceId: string): void {
  if (!m.alive || face.t === "STAR" || face.t === "SKULL") return;
  const raw = face.n;
  const armor = face.t === "I" ? 0 : Math.min(m.armor, raw);
  const afterArmor = raw - armor;
  const blocked = Math.min(m.block, afterArmor);
  const amount = Math.min(m.hp, afterArmor - blocked);
  const kind = face.t === "M" ? "melee" : face.t === "L" ? "ranged" : "magic";
  ctx.emit({ type: "DAMAGE_DEALT", sourceId, targetId: m.id, amount, blocked, armor, kind });
  if (face.poison && getMonster(ctx.s, m.id).alive && getMonster(ctx.s, m.id).hp > 0)
    ctx.emit({ type: "POISON_CHANGED", targetId: m.id, poison: getMonster(ctx.s, m.id).poison + face.poison });
  if (getMonster(ctx.s, m.id).hp === 0) killMonster(ctx, m.id);
}

function killMonster(ctx: Ctx, id: string): void {
  const m = getMonster(ctx.s, id);
  if (!m.alive) return;
  ctx.emit({ type: "MONSTER_DIED", monsterId: id });
  const def = balance.monsters.find((d) => d.id === m.kind)!;
  if (def.behavior === "melee_split" && !m.variant) {
    const n = def.params.splitInto ?? 2;
    for (let i = 0; i < n; i++) spawnSmallSlime(ctx, m.kind, def.params.splitHp ?? 3);
  }
}

/** Осколки слизня: те же характеристики, меньшее здоровье и без повторного деления. */
function spawnSmallSlime(ctx: Ctx, kind: string, hp: number): void {
  const mon = createMonster(kind, `m${ctx.s.nextId}`, ctx.s.partySize, hp);
  mon.variant = "small";
  ctx.emit({ type: "MONSTER_SPAWNED", monster: mon, reason: "split" });
}

/** Если в строю не осталось героев — поход окончен. */
function checkWipe(ctx: Ctx): boolean {
  if (ctx.ended) return true;
  if (upHeroes(ctx.s).length > 0) return false;
  if (!ctx.s.tutorial)
    for (const h of ctx.s.heroes) if (h.status === "downed") ctx.emit({ type: "HERO_DIED", heroId: h.id });
  ctx.emit({ type: "SESSION_ENDED", reason: "defeat" });
  return true;
}

function resolveRound(ctx: Ctx): void {
  const s = ctx.s;
  const actors = upHeroes(s);

  // 1. Скрытые решения раскрываются одновременно.
  for (const h of actors) ctx.emit({ type: "ASSIGNMENTS_REVEALED", heroId: h.id, plan: h.plan });

  const resolved = (h: Hero) =>
    h.plan
      .map((a) => ({ a, face: effectiveFace(h, a) }))
      .filter((x): x is { a: Assignment; face: Face } => x.face !== null);

  // 2. Блок и лечение.
  for (const h of actors) {
    for (const { a, face } of resolved(h)) {
      if (face.t === "B") {
        const t = s.heroes.find((x) => x.id === a.target && x.status === "up");
        if (t) ctx.emit({ type: "BLOCK_GAINED", targetId: t.id, amount: face.n, sourceId: h.id });
        if (face.taunt && !getHero(s, h.id).taunt) ctx.emit({ type: "TAUNT_SET", heroId: h.id });
      } else if (face.t === "H") {
        const t = s.heroes.find((x) => x.id === a.target && x.status !== "dead");
        if (!t) continue;
        if (t.status === "downed") ctx.emit({ type: "HERO_RAISED", heroId: t.id, hp: Math.min(t.maxHp, face.n) });
        else {
          const amount = Math.min(face.n, t.maxHp - t.hp);
          ctx.emit({ type: "HEALED", targetId: t.id, amount, sourceId: h.id });
        }
      }
    }
  }

  // 3. Урон героев.
  for (const h of actors) {
    for (const { a, face } of resolved(h)) {
      if (!isDamageFace(face)) continue;
      if (face.t === "I" && face.all) {
        for (const m of aliveMonsters(s)) damageMonster(ctx, m, face, h.id);
        continue;
      }
      let target = s.monsters.find((m) => m.id === a.target && m.alive);
      if (target && face.t === "M" && !meleeTargets(s).includes(target)) target = undefined;
      // Цель погибла раньше — удар уходит в первую допустимую.
      target ??= (face.t === "M" ? meleeTargets(s) : aliveMonsters(s))[0];
      if (target) damageMonster(ctx, target, face, h.id);
    }
  }

  // 4. Действия живых врагов.
  ctx.emit({ type: "ENEMY_TURN_STARTED" });
  const bonus = lightState(s.light).enemyDamageBonus;
  for (const m of [...s.monsters]) {
    if (!m.alive) continue;
    for (const it of m.intents) {
      if (ctx.ended) return;
      switch (it.kind) {
        case "attack":
          for (const tid of it.targets) {
            const taunter = upHeroes(s).find((h) => h.taunt);
            let target = taunter ?? s.heroes.find((h) => h.id === tid && h.status === "up");
            target ??= pick(ctx, upHeroes(s));
            if (!target) break;
            damageHero(ctx, target.id, it.amount + bonus, m.id, "monster", !!it.pierce);
            if (checkWipe(ctx)) return;
          }
          break;
        case "block": {
          const ally = s.monsters.find((x) => x.id === it.targets[0] && x.alive);
          if (ally) ctx.emit({ type: "BLOCK_GAINED", targetId: ally.id, amount: it.amount, sourceId: m.id });
          break;
        }
        case "doom":
          ctx.emit({ type: "DOOM_CHANGED", delta: it.amount, doom: s.doom + it.amount, reason: m.kind });
          break;
        case "summon":
          spawn(ctx, it.spawn ?? "rat_swarm", "summon");
          break;
        case "drain":
          spendLight(ctx, it.amount, m.kind);
          break;
        case "charge":
          break;
      }
    }
  }

  // 5. Яд: наносит урон и слабеет на 1.
  for (const m of [...s.monsters]) {
    if (!m.alive || m.poison <= 0) continue;
    const amount = Math.min(m.hp, m.poison);
    ctx.emit({ type: "DAMAGE_DEALT", sourceId: "poison", targetId: m.id, amount, blocked: 0, armor: 0, kind: "poison" });
    ctx.emit({ type: "POISON_CHANGED", targetId: m.id, poison: m.poison - 1 });
    if (getMonster(s, m.id).hp === 0) killMonster(ctx, m.id);
  }
  for (const h of upHeroes(s)) {
    if (h.poison <= 0) continue;
    damageHero(ctx, h.id, h.poison, "poison", "poison", true);
    ctx.emit({ type: "POISON_CHANGED", targetId: h.id, poison: getHero(s, h.id).poison - 1 });
  }

  // 6. Свет.
  spendLight(ctx, balance.light.cost.combatRound, "round");

  if (!aliveMonsters(s).length) {
    ctx.emit({ type: "SESSION_ENDED", reason: "victory" });
    return;
  }
  if (checkWipe(ctx)) return;

  // Спасброски упавших.
  for (const h of s.heroes.filter((x) => x.status === "downed")) deathSave(ctx, h.id);

  startRound(ctx, s.round + 1);
}

function deathSave(ctx: Ctx, heroId: string): void {
  const h = getHero(ctx.s, heroId);
  const natural = ctx.rng.int(20) + 1;
  const traj = ctx.rng.int(TRAJECTORIES);
  const ds = balance.deathSaves;
  let { ok, fail } = h.saves;
  if (natural === 20) ok = ds.successes;
  else if (natural === 1) fail += 2;
  else if (natural >= ds.dc) ok += 1;
  else fail += 1;
  ctx.emit({ type: "DEATH_SAVE_ROLLED", heroId, natural, ok: Math.min(ok, ds.successes), fail: Math.min(fail, ds.failures), traj });
  if (ok >= ds.successes) ctx.emit({ type: "HERO_RAISED", heroId, hp: 1 });
  else if (fail >= ds.failures) {
    // В обучающих подземельях герои не умирают: счётчик сбрасывается.
    if (ctx.s.tutorial) ctx.emit({ type: "DEATH_SAVE_ROLLED", heroId, natural: 0, ok: 0, fail: 0, traj: 0 });
    else ctx.emit({ type: "HERO_DIED", heroId });
  }
}
