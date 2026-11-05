import { balance, itemById } from "@kf/content";
import { bestHero, changeLight, check, checkWipe, damageHero, finish, lightState } from "./common.js";
import type { Ctx } from "./ctx.js";
import { upHeroes } from "./faces.js";
import { cheb, findPath, isSeen, key, objectsAt, roomOf, visibleFrom, visibleObject, visibleTile, type Cell } from "./grid.js";
import { hero as getHero } from "./reducer.js";
import { startEncounter } from "./combat.js";
import { fireRules } from "./rules.js";
import type { Outcome } from "@kf/schema";
import type { RObject, SessionState } from "./types.js";

const inZone = (z: { x: number; y: number; w: number; h: number }, x: number, y: number) => x >= z.x && y >= z.y && x < z.x + z.w && y < z.y + z.h;

/** Клетки, которые станут видны с точки; источники света подсвечивают свои окрестности. */
function newlyVisible(s: SessionState, x: number, y: number, extraSeen: Set<string>): Cell[] {
  const radius = lightState(s.light).vision;
  const cells = visibleFrom(s, x, y, radius);
  for (const o of s.objects)
    if (o.type === "light" && !o.hidden && cells.some(([cx, cy]) => cx === o.x && cy === o.y)) cells.push(...visibleFrom(s, o.x, o.y, o.radius ?? 2));
  const out: Cell[] = [];
  const dedup = new Set<string>();
  for (const [cx, cy] of cells) {
    const k = key(cx, cy);
    if (dedup.has(k) || isSeen(s, cx, cy) || extraSeen.has(k)) continue;
    dedup.add(k);
    out.push([cx, cy]);
  }
  return out;
}

function emitReveal(ctx: Ctx, cells: Cell[]): void {
  if (!cells.length) return;
  const s = ctx.s;
  const set = new Set(cells.map(([x, y]) => key(x, y)));
  const objects = s.objects.filter((o) => !o.hidden && set.has(key(o.x, o.y)) && !(o.type === "key" && o.used)).map(visibleObject);
  ctx.emit({ type: "TILE_REVEALED", cells: cells.map(([x, y]) => [x, y, visibleTile(s, x, y)]), objects });
  spotEncounters(ctx);
}

/** Монстры видны, как только открыта хоть одна клетка их зоны. Возвращает true, если заметили новых. */
function spotEncounters(ctx: Ctx): boolean {
  let any = false;
  for (const e of ctx.s.def.encounters) {
    const st = ctx.s.encounters.find((x) => x.id === e.id)!;
    if (st.done || st.spotted) continue;
    const z = e.zone;
    let seen = false;
    for (let y = z.y; y < z.y + z.h && !seen; y++) for (let x = z.x; x < z.x + z.w && !seen; x++) seen = isSeen(ctx.s, x, y);
    if (!seen) continue;
    ctx.emit({ type: "ENCOUNTER_SPOTTED", encounterId: e.id, kinds: e.monsters, x: Math.floor(z.x + z.w / 2), y: Math.floor(z.y + z.h / 2) });
    any = true;
  }
  return any;
}

export function revealAround(ctx: Ctx): void {
  emitReveal(ctx, newlyVisible(ctx.s, ctx.s.pos.x, ctx.s.pos.y, new Set()));
}

/** Стартовый обзор при входе. */
export function enterDungeon(ctx: Ctx): void {
  const intro = ctx.s.def.texts.intro;
  if (intro) ctx.emit({ type: "TEXT_SHOWN", textId: "intro", text: intro });
  revealAround(ctx);
}

const armedTrapAt = (s: SessionState, x: number, y: number) =>
  objectsAt(s, x, y).find((o) => o.type === "trap" && (o.state === "armed" || o.state === "revealed"));

export function canPath(s: SessionState, x: number, y: number): Cell[] | null {
  return findPath(s, [s.pos.x, s.pos.y], [x, y], (cx, cy) => !!objectsAt(s, cx, cy).find((o) => o.type === "trap" && o.state === "revealed"), balance.explore.maxPathCells);
}

/**
 * Перемещение отряда. Идём по шагам: замеченная ловушка останавливает, незамеченная срабатывает,
 * вход в зону столкновения начинает бой, новые замеченные враги останавливают отряд.
 */
export function move(ctx: Ctx, path: Cell[]): void {
  const s = ctx.s;
  const walked: Cell[] = [];
  let cost = 0;
  const pendingSeen = new Set<string>();
  const reveal: Cell[] = [];
  let stop: null | { kind: "trap_spotted" | "trap" | "encounter" | "spotted" | "plate"; objectId?: string; encounterId?: string } = null;
  const room0 = roomOf(s, s.pos.x, s.pos.y);

  for (const [x, y] of path) {
    const trap = armedTrapAt(s, x, y);
    if (trap && trap.hidden) {
      // Пассивная проверка: самый внимательный герой может заметить ловушку перед шагом.
      flush();
      const def = balance.traps.find((t) => t.id === trap.trapId)!;
      const who = bestHero(ctx, def.spot);
      if (who && check(ctx, who, def.spot, def.dc, "spot")) {
        ctx.emit({ type: "TRAP_REVEALED", objectId: trap.id, trapId: def.id, x, y });
        stop = { kind: "trap_spotted" };
        break;
      }
      walked.push([x, y]);
      cost += s.tiles[y]![x] === "~" ? 2 : 1;
      flush();
      triggerTrap(ctx, trap.id);
      stop = { kind: "trap" };
      break;
    }
    walked.push([x, y]);
    cost += s.tiles[y]![x] === "~" ? 2 : 1;
    const seenNow = newlyVisible(s, x, y, pendingSeen);
    for (const c of seenNow) {
      pendingSeen.add(key(...c));
      reveal.push(c);
    }
    const enc = s.def.encounters.find((e) => inZone(e.zone, x, y) && !s.encounters.find((st) => st.id === e.id)!.done);
    if (enc) {
      stop = { kind: "encounter", encounterId: enc.id };
      break;
    }
    if (objectsAt(s, x, y).some((o) => o.type === "plate" && !o.used)) {
      stop = { kind: "plate", objectId: objectsAt(s, x, y).find((o) => o.type === "plate")!.id };
      break;
    }
    // Новые враги в поле зрения — остановиться.
    const wouldSpot = s.def.encounters.some((e) => {
      const st = s.encounters.find((q) => q.id === e.id)!;
      if (st.done || st.spotted) return false;
      for (const k of pendingSeen) {
        const [cx, cy] = k.split(",").map(Number) as Cell;
        if (inZone(e.zone, cx, cy)) return true;
      }
      return false;
    });
    if (wouldSpot) {
      stop = { kind: "spotted" };
      break;
    }
  }
  flush();
  if (cost) changeLight(ctx, -Math.ceil(cost / balance.light.cost.moveCellsPerUnit), "move");
  if (ctx.ended || checkWipe(ctx)) return;

  // Новая комната — Ведущим становится следующий игрок.
  const room1 = roomOf(s, s.pos.x, s.pos.y);
  if (room1 !== room0 && room1 >= 0) passLeader(ctx);

  for (const [x, y] of walked) fireRules(ctx, { on: "enter_zone", x, y });
  if (ctx.ended || s.phase !== "explore") return;

  if (stop?.kind === "plate" && stop.objectId) useObject(ctx, s.leaderId, s.objects.find((o) => o.id === stop!.objectId)!);
  if (stop?.kind === "encounter" && stop.encounterId) {
    const e = s.def.encounters.find((x) => x.id === stop!.encounterId)!;
    startEncounter(ctx, e.id, e.monsters, e.textId);
  }

  function flush() {
    if (walked.length) {
      const already = ctx.events.filter((e) => e.type === "PARTY_MOVED").reduce((n, e) => n + (e.type === "PARTY_MOVED" ? e.path.length : 0), 0);
      const fresh = walked.slice(already);
      if (fresh.length) ctx.emit({ type: "PARTY_MOVED", path: fresh, cost });
    }
    if (reveal.length) {
      emitReveal(ctx, reveal.filter(([x, y]) => !isSeen(s, x, y)));
      reveal.length = 0;
    }
  }
}

function passLeader(ctx: Ctx): void {
  const up = upHeroes(ctx.s);
  if (up.length < 2) return;
  const i = up.findIndex((h) => h.id === ctx.s.leaderId);
  ctx.emit({ type: "LEADER_CHANGED", heroId: up[(i + 1) % up.length]!.id });
}

export function triggerTrap(ctx: Ctx, objectId: string): void {
  const s = ctx.s;
  const o = s.objects.find((x) => x.id === objectId)!;
  const def = balance.traps.find((t) => t.id === o.trapId)!;
  ctx.emit({ type: "TRAP_TRIGGERED", objectId, trapId: def.id, x: o.x, y: o.y });
  const up = upHeroes(s);
  if (!up.length) return;
  const p = def.params;
  const leader = up.find((h) => h.id === s.leaderId) ?? up[0]!;
  switch (def.effect) {
    case "damage_random":
      damageHero(ctx, up.length === 1 ? up[0]!.id : up[ctx.rng.int(up.length)]!.id, p.damage ?? 0, def.id, "trap", true);
      break;
    case "damage_leader":
      damageHero(ctx, leader.id, p.damage ?? 0, def.id, "trap", true);
      break;
    case "poison_all_light":
      for (const h of up) ctx.emit({ type: "POISON_CHANGED", targetId: h.id, poison: h.poison + (p.poison ?? 0) });
      changeLight(ctx, -(p.light ?? 0), "trap");
      break;
    default:
      break;
  }
}

const adjacent = (s: SessionState, o: RObject) => cheb(s.pos.x, s.pos.y, o.x, o.y) <= balance.explore.adjacent;

/** Что произойдёт при «использовать» — проверяется до броска. */
export function useError(s: SessionState, o: RObject): string | null {
  if (o.hidden || !isSeen(s, o.x, o.y)) return "no_object";
  if (!adjacent(s, o)) return "too_far";
  switch (o.type) {
    case "door":
      if (o.open) return "already_open";
      if (o.locked && !(o.keyId && s.bag.keys.includes(o.keyId))) return "locked";
      return null;
    case "chest":
      if (o.used) return "empty";
      if (o.locked && !(o.keyId && s.bag.keys.includes(o.keyId))) return "locked";
      return null;
    case "key":
    case "altar":
    case "npc":
    case "lever":
      return o.used ? "used" : null;
    case "note":
    case "treasury":
    case "entrance":
      return null;
    case "campfire":
      return o.used ? "used" : null;
    case "trap":
      return "use_disarm";
    case "plate":
    case "light":
      return "nothing";
    case "event":
      return o.used ? "used" : "use_choose";
  }
}

export function useObject(ctx: Ctx, heroId: string, o: RObject): void {
  const s = ctx.s;
  const text = (id?: string, speaker?: string) => {
    const t = id ? s.def.texts[id] : undefined;
    if (id && t) ctx.emit({ type: "TEXT_SHOWN", textId: id, text: t, ...(speaker ? { speaker } : {}) });
  };
  switch (o.type) {
    case "door":
      ctx.emit({ type: "OBJECT_CHANGED", objectId: o.id, patch: { open: true, locked: false } });
      revealAround(ctx);
      fireRules(ctx, { on: "use_object", objectId: o.id });
      return;
    case "chest": {
      const def = s.def.objects.find((d) => d.id === o.id);
      const loot = def && def.type === "chest" ? def.loot : { gold: 0, items: [] };
      ctx.emit({ type: "OBJECT_CHANGED", objectId: o.id, patch: { used: true, open: true, locked: false } });
      ctx.emit({ type: "ITEM_FOUND", objectId: o.id, gold: loot.gold, items: loot.items, keys: [] });
      fireRules(ctx, { on: "item_taken", objectId: o.id });
      return;
    }
    case "key":
      text(o.textId);
      ctx.emit({ type: "OBJECT_CHANGED", objectId: o.id, patch: { used: true } });
      ctx.emit({ type: "ITEM_FOUND", objectId: o.id, gold: 0, items: [], keys: [o.keyId!] });
      fireRules(ctx, { on: "item_taken", objectId: o.id });
      return;
    case "note":
      text(o.textId);
      return;
    case "lever":
    case "plate":
      ctx.emit({ type: "OBJECT_CHANGED", objectId: o.id, patch: { used: true } });
      if (o.variable) ctx.emit({ type: "VARIABLE_SET", variable: o.variable, value: 1 });
      text(o.textId);
      fireRules(ctx, { on: "use_object", objectId: o.id });
      return;
    case "altar": {
      const def = s.def.objects.find((d) => d.id === o.id);
      text(o.textId);
      ctx.emit({ type: "OBJECT_CHANGED", objectId: o.id, patch: { used: true } });
      if (def?.type === "altar" && def.check) {
        const ok = check(ctx, heroId, def.check.attr, def.check.dc, "altar");
        changeLight(ctx, -balance.light.cost.check, "check");
        text(ok ? def.check.successTextId : def.check.failTextId);
        if (ok && def.check.loot) ctx.emit({ type: "ITEM_FOUND", objectId: o.id, gold: def.check.loot.gold, items: def.check.loot.items, keys: [] });
        if (ok && def.check.variable) ctx.emit({ type: "VARIABLE_SET", variable: def.check.variable, value: 1 });
      }
      fireRules(ctx, { on: "use_object", objectId: o.id });
      return;
    }
    case "npc": {
      const npc = s.def.npcs.find((n) => n.id === o.npcId);
      ctx.emit({ type: "OBJECT_CHANGED", objectId: o.id, patch: { used: true } });
      if (!npc) return;
      for (const l of npc.lines) text(l, npc.name);
      for (const out of npc.outcomes) {
        if (out === "give_item" && npc.itemId) ctx.emit({ type: "ITEM_FOUND", objectId: o.id, gold: 0, items: [npc.itemId], keys: [] });
        if (out === "open_door" && npc.doorId) {
          ctx.emit({ type: "OBJECT_CHANGED", objectId: npc.doorId, patch: { open: true, locked: false, hidden: false } });
          revealAround(ctx);
        }
      }
      fireRules(ctx, { on: "use_object", objectId: o.id });
      return;
    }
    case "campfire":
      rest(ctx, o);
      return;
    case "treasury": {
      text(o.textId);
      // Доля сокровищницы: для официальных подземелий её выдаёт система (ТЗ 10.2).
      const tier = balance.tiers.find((t) => t.tier === s.tier);
      const gold = tier ? Math.floor((tier.minHoard * balance.economy.victoryHoardPercent) / 100) : 0;
      if (gold) ctx.emit({ type: "ITEM_FOUND", objectId: o.id, gold, items: [], keys: [] });
      finish(ctx, "victory");
      return;
    }
    case "entrance":
      finish(ctx, "retreat");
      return;
    default:
      return;
  }
}

/** Привал у костра: +50% здоровья, −5 Факела, один раз на костёр. */
export function rest(ctx: Ctx, o: RObject): void {
  ctx.emit({ type: "PARTY_RESTED", objectId: o.id });
  changeLight(ctx, -balance.light.cost.rest, "rest");
  for (const h of ctx.s.heroes) {
    if (h.status === "dead") continue;
    const amount = Math.ceil((h.maxHp * balance.rest.healPercent) / 100);
    if (h.status === "downed") ctx.emit({ type: "HERO_RAISED", heroId: h.id, hp: Math.min(h.maxHp, amount) });
    else ctx.emit({ type: "HEALED", targetId: h.id, amount: Math.min(amount, h.maxHp - h.hp), sourceId: o.id });
  }
}

/** Взлом двери или сундука силой. */
export function force(ctx: Ctx, heroId: string, o: RObject): void {
  const ok = check(ctx, heroId, "STR", o.lockDc ?? balance.checks.dc.hard, "force");
  changeLight(ctx, -balance.light.cost.check, "check");
  if (ok) {
    ctx.emit({ type: "OBJECT_CHANGED", objectId: o.id, patch: { locked: false } });
    useObject(ctx, heroId, { ...o, locked: false });
  }
}

export function disarm(ctx: Ctx, heroId: string, o: RObject): void {
  const def = balance.traps.find((t) => t.id === o.trapId)!;
  const ok = check(ctx, heroId, def.disarm, def.dc, "disarm");
  changeLight(ctx, -balance.light.cost.check, "check");
  if (ok) ctx.emit({ type: "TRAP_DISARMED", objectId: o.id });
  else triggerTrap(ctx, o.id);
  checkWipe(ctx);
}

/** Обыск вокруг: одна проверка Разума против каждой скрытой ловушки и секретной двери рядом. */
export function search(ctx: Ctx, heroId: string): void {
  const s = ctx.s;
  const h = getHero(s, heroId);
  const natural = ctx.rng.int(20) + 1;
  const traj = ctx.rng.int(12);
  const mod = h.stats.INT + lightState(s.light).checkMod;
  const total = natural + mod;
  const r = balance.explore.searchRadius;
  const hidden = s.objects.filter((o) => o.hidden && (o.type === "trap" || (o.type === "door" && o.secretDc)) && cheb(s.pos.x, s.pos.y, o.x, o.y) <= r);
  const dcOf = (o: RObject) => (o.type === "trap" ? balance.traps.find((t) => t.id === o.trapId)!.dc : o.secretDc!);
  const easiest = hidden.length ? Math.min(...hidden.map(dcOf)) : balance.checks.dc.normal;
  const success = natural === 20 ? true : natural === 1 ? false : total >= easiest;
  ctx.emit({ type: "CHECK_ROLLED", heroId, attr: "INT", dc: easiest, natural, mod, total, success, traj, purpose: "search" });
  changeLight(ctx, -balance.light.cost.check, "check");
  for (const o of hidden) {
    if (!(natural === 20 || (natural !== 1 && total >= dcOf(o)))) continue;
    if (o.type === "trap") ctx.emit({ type: "TRAP_REVEALED", objectId: o.id, trapId: o.trapId!, x: o.x, y: o.y });
    else {
      ctx.emit({ type: "SECRET_FOUND", object: visibleObject({ ...o, hidden: false }) });
      ctx.emit({ type: "TILE_REVEALED", cells: [[o.x, o.y, s.tiles[o.y]![o.x]!]], objects: [visibleObject(o)] });
    }
  }
}

export function useItem(ctx: Ctx, heroId: string, itemId: string, targetId?: string): void {
  const it = itemById(itemId)!;
  if (it.kind !== "consumable") return;
  ctx.emit({ type: "ITEM_USED", heroId, itemId, ...(targetId ? { targetId } : {}) });
  switch (it.effect) {
    case "heal": {
      const t = getHero(ctx.s, targetId ?? heroId);
      if (t.status === "downed") ctx.emit({ type: "HERO_RAISED", heroId: t.id, hp: Math.min(t.maxHp, it.amount) });
      else ctx.emit({ type: "HEALED", targetId: t.id, amount: Math.min(it.amount, t.maxHp - t.hp), sourceId: itemId });
      return;
    }
    case "light":
      changeLight(ctx, it.amount, "torch");
      return;
    case "retreat":
      finish(ctx, "retreat");
      return;
  }
}

/** Выбор варианта в событии: проверка (если есть) и исходы. */
export function chooseOption(ctx: Ctx, heroId: string, o: RObject, optionId: string): void {
  const s = ctx.s;
  const ev = s.def.events.find((e) => e.id === o.eventId);
  const opt = ev?.options.find((x) => x.id === optionId);
  if (!opt) return;
  ctx.emit({ type: "OPTION_CHOSEN", objectId: o.id, optionId, heroId });
  let ok = true;
  if (opt.check) {
    ok = check(ctx, heroId, opt.check.attr, opt.check.dc, "event");
    changeLight(ctx, -balance.light.cost.check, "check");
  }
  applyOutcomes(ctx, heroId, ok ? opt.success : opt.fail, `event_${o.id}`);
}

export function applyOutcomes(ctx: Ctx, heroId: string, outcomes: Outcome[], encounterId: string): void {
  const s = ctx.s;
  const targets = (t: "leader" | "all" | "random") => {
    const up = upHeroes(s);
    if (!up.length) return [];
    if (t === "all") return up;
    if (t === "leader") return [up.find((h) => h.id === s.leaderId) ?? up[0]!];
    return [up.length === 1 ? up[0]! : up[ctx.rng.int(up.length)]!];
  };
  for (const out of outcomes) {
    if (ctx.ended || s.phase !== "explore") return;
    switch (out.do) {
      case "gold": {
        const gold = Math.max(0, s.bag.gold + out.amount);
        if (gold !== s.bag.gold) ctx.emit({ type: "GOLD_CHANGED", delta: gold - s.bag.gold, gold });
        break;
      }
      case "item":
        if (itemById(out.itemId)) ctx.emit({ type: "ITEM_FOUND", objectId: "event", gold: 0, items: [out.itemId], keys: [] });
        break;
      case "light":
        changeLight(ctx, out.delta, "event");
        break;
      case "damage":
        for (const h of targets(out.target)) damageHero(ctx, h.id, out.amount, "event", "trap", true);
        if (checkWipe(ctx)) return;
        break;
      case "heal":
        for (const h of s.heroes.filter((x) => x.status !== "dead" && (out.target === "all" || x.id === (targets(out.target)[0]?.id ?? heroId)))) {
          if (h.status === "downed") ctx.emit({ type: "HERO_RAISED", heroId: h.id, hp: Math.min(h.maxHp, out.amount) });
          else ctx.emit({ type: "HEALED", targetId: h.id, amount: Math.min(out.amount, h.maxHp - h.hp), sourceId: "event" });
        }
        break;
      case "poison":
        for (const h of targets(out.target)) ctx.emit({ type: "POISON_CHANGED", targetId: h.id, poison: getHero(s, h.id).poison + out.amount });
        break;
      case "doom": {
        const doom = Math.max(0, s.doom + out.delta);
        if (doom !== s.doom) ctx.emit({ type: "DOOM_CHANGED", delta: doom - s.doom, doom, reason: "event" });
        break;
      }
      case "spawn":
        startEncounter(ctx, encounterId, out.monsters);
        return;
      case "text":
        ctx.emit({ type: "TEXT_SHOWN", textId: "event", text: out.text });
        break;
      case "reveal": {
        // Подсказка проводника: открыть окрестности без учёта прямой видимости.
        const cells: Cell[] = [];
        for (let y = s.pos.y - out.radius; y <= s.pos.y + out.radius; y++)
          for (let x = s.pos.x - out.radius; x <= s.pos.x + out.radius; x++) {
            if (x < 0 || y < 0 || x >= s.def.size.w || y >= s.def.size.h || isSeen(s, x, y)) continue;
            if ((x - s.pos.x) ** 2 + (y - s.pos.y) ** 2 > out.radius ** 2) continue;
            cells.push([x, y]);
          }
        emitReveal(ctx, cells);
        break;
      }
      case "ally":
        ctx.emit({ type: "ALLY_JOINED", name: out.name, damage: out.damage });
        break;
      case "xp":
        ctx.emit({ type: "XP_BONUS", amount: out.amount });
        break;
    }
  }
}
