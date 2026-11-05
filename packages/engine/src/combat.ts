import { balance } from "@kf/content";
import type { Face } from "@kf/schema";
import { changeLight, checkWipe, damageHero, TRAJECTORIES, lightState } from "./common.js";
import type { Ctx } from "./ctx.js";
import { aliveMonsters, effectiveFace, isDamageFace, meleeTargets, upHeroes } from "./faces.js";
import { hero as getHero, monster as getMonster } from "./reducer.js";
import { fireRules } from "./rules.js";
import { ELITE_AFFIXES, type Assignment, type EliteAffix, type Hero, type Intent, type Monster, type SessionState } from "./types.js";

export function createMonster(kind: string, id: string, partySize: number, hpOverride?: number, elite?: EliteAffix, hpPercent = 100): Monster {
  const def = balance.monsters.find((m) => m.id === kind);
  if (!def) throw new Error(`unknown monster ${kind}`);
  const key = String(Math.min(4, Math.max(1, partySize)));
  const scale = (def.boss ? balance.bossHpScale[key] : balance.partyHpScale[key]) ?? 1;
  const e = balance.expedition.elite;
  const hp = Math.max(1, Math.round(((hpOverride ?? def.hp) * scale * (elite ? e.hpPercent : 100) * hpPercent) / 10000));
  const armor = def.armor + (elite === "armored" ? e.armor : 0);
  return { id, kind, hp, maxHp: hp, armor, row: def.row, boss: def.boss, block: 0, poison: 0, alive: true, age: 0, intents: [], ...(elite ? { elite } : {}) };
}

export function spawn(ctx: Ctx, kind: string, reason: "encounter" | "split" | "summon", hpOverride?: number, variant?: "small", elite?: EliteAffix): void {
  const solo = ctx.s.def.generated && ctx.s.partySize === 1;
  const m = createMonster(kind, `m${ctx.s.nextId}`, ctx.s.partySize, hpOverride, elite, solo ? balance.expedition.soloHpPercent : 100);
  if (variant) m.variant = variant;
  ctx.emit({ type: "MONSTER_SPAWNED", monster: m, reason });
}

/** Начало боя: текст, монстры, первый раунд. */
export function startEncounter(ctx: Ctx, encounterId: string, kinds: string[], textId?: string, elite = false): void {
  ctx.emit({ type: "ENCOUNTER_STARTED", encounterId, kinds });
  if (textId) {
    const text = ctx.s.def.texts[textId];
    if (text) ctx.emit({ type: "TEXT_SHOWN", textId, text });
  }
  // Элитная стычка: самый дорогой монстр группы становится вожаком со случайным свойством.
  let leader = -1;
  let affix: EliteAffix | undefined;
  if (elite && kinds.length) {
    const costOf = (k: string) => balance.monsters.find((m) => m.id === k)?.cost ?? 0;
    leader = kinds.reduce((best, k, i) => (costOf(k) > costOf(kinds[best]!) ? i : best), 0);
    affix = ELITE_AFFIXES[ctx.rng.int(ELITE_AFFIXES.length)]!;
  }
  kinds.forEach((kind, i) => spawn(ctx, kind, "encounter", undefined, undefined, i === leader ? affix : undefined));
  startRound(ctx, 1);
}

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
      const pool = [...heroesInReach(s, !p.ranged)];
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
      if (m.age % (p.every ?? 2) === 0) out.push({ kind: "summon", targets: [], amount: 1, spawn: def.spawn ?? "rat_swarm" });
      break;
    case "pack": {
      // Стая: каждый живой сородич добавляет урона.
      const allies = aliveMonsters(s).filter((a) => a.id !== m.id && a.kind === m.kind).length;
      out.push(attack(true, (p.damage ?? 1) + allies * (p.perAlly ?? 1)));
      break;
    }
    case "poison_bite":
      out.push(attack(true, p.damage ?? 1, { poison: p.poison ?? 1 }));
      break;
    case "heal_ally": {
      const hurt = aliveMonsters(s)
        .filter((a) => a.id !== m.id && a.hp < a.maxHp)
        .sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp || a.id.localeCompare(b.id))[0];
      out.push(hurt ? { kind: "heal", targets: [hurt.id], amount: p.heal ?? 2 } : attack(false, p.damage ?? 1));
      break;
    }
    case "boss_drain_light":
      out.push(attack(false, p.damage ?? 1));
      out.push({ kind: "drain", targets: [], amount: p.light ?? 0 });
      break;
    default:
      throw new Error(`unknown behavior ${def.behavior}`);
  }
  const res = out.filter((x): x is Intent => x !== null);
  // Свойства элиты: ярость — больше урона, яд — каждая атака отравляет.
  if (m.elite === "furious" || m.elite === "venomous") {
    const e = balance.expedition.elite;
    for (const it of res) {
      if (it.kind !== "attack") continue;
      if (m.elite === "furious") it.amount += e.damage;
      else it.poison = (it.poison ?? 0) + e.poison;
    }
  }
  return res;
}

export function startRound(ctx: Ctx, round: number): void {
  ctx.emit({ type: "ROUND_STARTED", round });
  // Регенерация элиты — в начале каждого раунда, кроме первого.
  if (round > 1)
    for (const m of aliveMonsters(ctx.s))
      if (m.elite === "regen" && m.hp < m.maxHp)
        ctx.emit({ type: "HEALED", targetId: m.id, amount: Math.min(balance.expedition.elite.regen, m.maxHp - m.hp), sourceId: m.id });
  const intents: Record<string, Intent[]> = {};
  for (const m of aliveMonsters(ctx.s)) intents[m.id] = intentsFor(ctx, m);
  ctx.emit({ type: "INTENTS_SHOWN", intents });
  fireRules(ctx, { on: "round_start", round });
}

export function rollHeroDice(ctx: Ctx, heroId: string, dice: number[], kind: "roll" | "reroll" | "fate"): void {
  const h = getHero(ctx.s, heroId);
  const faces = dice.map((d) => ctx.rng.int(h.dice[d]!.length));
  const traj = ctx.rng.int(TRAJECTORIES);
  ctx.emit({ type: "HERO_DICE_ROLLED", heroId, dice, faces, traj, kind });
  const skulls = dice.filter((d, i) => h.dice[d]![faces[i]!]!.t === "SKULL").length;
  if (dice.length === 3 && skulls === 3) {
    damageHero(ctx, heroId, balance.combat.tripleSkullDamage, heroId, "skulls", true);
    checkWipe(ctx);
  }
}

function damageMonster(ctx: Ctx, m: Monster, face: Face, sourceId: string): void {
  if (!m.alive || face.t === "STAR" || face.t === "SKULL") return;
  const src = ctx.s.heroes.find((h) => h.id === sourceId);
  const bonus = src && (face.t === "M" || face.t === "L" || face.t === "I") ? src.mods.dmg[face.t] : 0;
  const raw = face.n + bonus;
  // Броня гасит урон, но не весь: каждый удар оставляет хотя бы 1 (иначе одиночка против каменной твари — тупик).
  const armor = face.t === "I" ? 0 : Math.max(0, Math.min(m.armor, raw - 1));
  const afterArmor = raw - armor;
  const blocked = Math.min(m.block, afterArmor);
  const amount = Math.min(m.hp, afterArmor - blocked);
  const kind = face.t === "M" ? "melee" : face.t === "L" ? "ranged" : "magic";
  ctx.emit({ type: "DAMAGE_DEALT", sourceId, targetId: m.id, amount, blocked, armor, kind });
  if (face.poison && getMonster(ctx.s, m.id).alive && getMonster(ctx.s, m.id).hp > 0)
    ctx.emit({ type: "POISON_CHANGED", targetId: m.id, poison: getMonster(ctx.s, m.id).poison + face.poison + (src?.mods.poison ?? 0) });
  if (getMonster(ctx.s, m.id).hp === 0) killMonster(ctx, m.id);
}

function killMonster(ctx: Ctx, id: string): void {
  const m = getMonster(ctx.s, id);
  if (!m.alive) return;
  ctx.emit({ type: "MONSTER_DIED", monsterId: id });
  const def = balance.monsters.find((d) => d.id === m.kind)!;
  if (def.behavior === "melee_split" && !m.variant) {
    for (let i = 0; i < (def.params.splitInto ?? 2); i++) spawn(ctx, m.kind, "split", def.params.splitHp ?? 3, "small");
  }
}

/** Конец столкновения: победа в стычке, отряд снова исследует. */
function endEncounter(ctx: Ctx): void {
  const id = ctx.s.encounterId ?? "encounter";
  // Упавшие после боя приходят в себя с 1 здоровьем.
  for (const h of ctx.s.heroes.filter((x) => x.status === "downed")) ctx.emit({ type: "HERO_RAISED", heroId: h.id, hp: 1 });
  // Снаряжение «лечение после стычки».
  for (const h of ctx.s.heroes.filter((x) => x.status === "up" && x.mods.healAfter > 0 && x.hp < x.maxHp))
    ctx.emit({ type: "HEALED", targetId: h.id, amount: Math.min(h.mods.healAfter, h.maxHp - h.hp), sourceId: "equipment" });
  ctx.emit({ type: "ENCOUNTER_ENDED", encounterId: id });
  fireRules(ctx, { on: "monster_died", encounterId: id });
}

export function resolveRound(ctx: Ctx): void {
  const s = ctx.s;
  const actors = upHeroes(s);
  for (const h of actors) ctx.emit({ type: "ASSIGNMENTS_REVEALED", heroId: h.id, plan: h.plan });

  const resolved = (h: Hero) =>
    h.plan.map((a) => ({ a, face: effectiveFace(h, a) })).filter((x): x is { a: Assignment; face: Face } => x.face !== null);

  // 1. Блок и лечение.
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
        else ctx.emit({ type: "HEALED", targetId: t.id, amount: Math.min(face.n, t.maxHp - t.hp), sourceId: h.id });
      }
    }
  }

  // 2. Урон героев.
  for (const h of actors) {
    for (const { a, face } of resolved(h)) {
      if (!isDamageFace(face)) continue;
      if (face.t === "I" && face.all) {
        for (const m of aliveMonsters(s)) damageMonster(ctx, m, face, h.id);
        continue;
      }
      let target = s.monsters.find((m) => m.id === a.target && m.alive);
      if (target && face.t === "M" && !meleeTargets(s).includes(target)) target = undefined;
      target ??= (face.t === "M" ? meleeTargets(s) : aliveMonsters(s))[0];
      if (target) damageMonster(ctx, target, face, h.id);
    }
  }

  // 2б. Союзники из событий бьют случайного врага.
  for (const ally of s.allies) {
    const alive = aliveMonsters(s);
    if (!alive.length) break;
    const t = alive.length === 1 ? alive[0]! : alive[ctx.rng.int(alive.length)]!;
    const amount = Math.min(t.hp, ally.damage);
    ctx.emit({ type: "DAMAGE_DEALT", sourceId: `ally:${ally.name}`, targetId: t.id, amount, blocked: 0, armor: 0, kind: "ally" });
    if (getMonster(s, t.id).hp === 0) killMonster(ctx, t.id);
  }

  // 3. Действия живых врагов.
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
            const fell = damageHero(ctx, target.id, it.amount + bonus, m.id, "monster", !!it.pierce);
            if (it.poison && !fell && getHero(s, target.id).status === "up")
              ctx.emit({ type: "POISON_CHANGED", targetId: target.id, poison: getHero(s, target.id).poison + it.poison });
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
          changeLight(ctx, -it.amount, m.kind);
          break;
        case "heal": {
          const ally = s.monsters.find((x) => x.id === it.targets[0] && x.alive);
          if (ally) ctx.emit({ type: "HEALED", targetId: ally.id, amount: Math.min(it.amount, ally.maxHp - ally.hp), sourceId: m.id });
          break;
        }
        case "charge":
          break;
      }
    }
  }

  // 4. Яд.
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

  // 5. Свет.
  changeLight(ctx, -balance.light.cost.combatRound, "round");
  if (ctx.ended) return;

  if (!aliveMonsters(s).length) {
    endEncounter(ctx);
    return;
  }
  if (checkWipe(ctx)) return;
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
    if (ctx.s.tutorial) ctx.emit({ type: "DEATH_SAVE_ROLLED", heroId, natural: 0, ok: 0, fail: 0, traj: 0 });
    else ctx.emit({ type: "HERO_DIED", heroId });
  }
}
