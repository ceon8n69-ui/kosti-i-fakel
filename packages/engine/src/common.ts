import { balance } from "@kf/content";
import type { Ctx } from "./ctx.js";
import { upHeroes } from "./faces.js";
import { hero as getHero } from "./reducer.js";
import type { Attr } from "./types.js";

/** Число траекторий на клиенте для каждого типа кубика (ТЗ 9.3). */
export const TRAJECTORIES = 12;

export function lightState(light: number) {
  const states = [...balance.light.states].sort((a, b) => b.min - a.min);
  return states.find((st) => light >= st.min) ?? states[states.length - 1]!;
}

/** Проверка d20 + характеристика + свет. Натуральная 20 — всегда успех, 1 — всегда провал. */
export function check(ctx: Ctx, heroId: string, attr: Attr, dc: number, purpose: string): boolean {
  const h = getHero(ctx.s, heroId);
  const natural = ctx.rng.int(20) + 1;
  const traj = ctx.rng.int(TRAJECTORIES);
  const mod = h.stats[attr] + lightState(ctx.s.light).checkMod;
  const total = natural + mod;
  const success = natural === 20 ? true : natural === 1 ? false : total >= dc;
  ctx.emit({ type: "CHECK_ROLLED", heroId, attr, dc, natural, mod, total, success, traj, purpose });
  return success;
}

/** Лучший герой отряда по характеристике (для пассивных проверок). */
export function bestHero(ctx: Ctx, attr: Attr): string | null {
  const up = upHeroes(ctx.s);
  if (!up.length) return null;
  return [...up].sort((a, b) => b.stats[attr] - a.stats[attr] || a.id.localeCompare(b.id))[0]!.id;
}

export function changeLight(ctx: Ctx, delta: number, reason: string): void {
  if (!delta) return;
  const before = ctx.s.light;
  const light = Math.max(0, before + delta);
  if (light === before) return;
  ctx.emit({ type: "LIGHT_CHANGED", delta: light - before, light, reason });
  // Правила «Факел ниже значения» срабатывают при пересечении порога вниз.
  if (light < before) lightRules(ctx, before, light);
}

let lightRules: (ctx: Ctx, before: number, after: number) => void = () => {};
export const setLightRules = (fn: typeof lightRules) => {
  lightRules = fn;
};

/** Урон герою. Возвращает true, если герой упал. */
export function damageHero(ctx: Ctx, heroId: string, raw: number, sourceId: string, kind: "monster" | "trap" | "skulls" | "poison", pierce: boolean): boolean {
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

/** Если в строю не осталось героев — поход окончен. */
export function checkWipe(ctx: Ctx): boolean {
  if (ctx.ended) return true;
  const up = upHeroes(ctx.s);
  if (up.length > 0) {
    // Ведущий упал (ловушка, событие) — карту ведёт следующий в строю, иначе отряд застрянет.
    if (ctx.s.phase === "explore" && !up.some((h) => h.id === ctx.s.leaderId)) ctx.emit({ type: "LEADER_CHANGED", heroId: up[0]!.id });
    return false;
  }
  if (!ctx.s.tutorial) for (const h of ctx.s.heroes) if (h.status === "downed") ctx.emit({ type: "HERO_DIED", heroId: h.id });
  finish(ctx, "defeat");
  return true;
}

/** Итог похода: опыт и найденное. Золото и лут сохраняются при победе и отступлении. */
export function finish(ctx: Ctx, reason: "victory" | "defeat" | "retreat", opts: { fullXp?: boolean } = {}): void {
  const r = balance.rewards;
  const kills = ctx.s.killed * r.xpPerMonsterCost;
  const base = kills + ctx.s.bonusXp;
  const xp =
    reason === "victory" ? base + ctx.s.tier * r.xpVictoryPerTier : reason === "retreat" ? (opts.fullXp ? base : Math.floor((base * r.xpRetreatShare) / 100)) : 0;
  const keep = reason !== "defeat";
  ctx.emit({ type: "REWARDS", xp, gold: keep ? ctx.s.bag.gold : 0, items: keep ? [...ctx.s.bag.items] : [], reason });
  ctx.emit({ type: "SESSION_ENDED", reason });
}
