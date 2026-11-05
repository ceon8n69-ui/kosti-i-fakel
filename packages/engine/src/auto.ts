import type { Face } from "@kf/schema";
import { effectiveFace, legalTargets } from "./faces.js";
import { unit } from "./reducer.js";
import type { CommandBody, Hero, SessionState } from "./types.js";

const value = (f: Face): number => (f.t === "STAR" || f.t === "SKULL" ? 0 : f.n + (f.all ? 1 : 0) + (f.poison ?? 0));

/**
 * Простой алгоритм хода (ТЗ 4.9): используется при пропуске хода и в симуляторе.
 * Без перебросов. Урон — по самому раненому, блок — себе, лечение — самому раненому союзнику.
 */
export function autoTurn(s: SessionState, heroId: string): CommandBody[] {
  const h = s.heroes.find((x) => x.id === heroId);
  if (!h || h.status !== "up" || s.phase !== "combat") return [];
  if (h.roll.some((r) => r === null)) return [{ type: "ROLL_DICE", heroId }];
  if (h.ready) return [];
  const out: CommandBody[] = [];
  h.roll.forEach((idx, die) => {
    if (idx == null) return;
    const rolled = h.dice[die]![idx]!;
    let star: number | undefined;
    if (rolled.t === "STAR") {
      const options = h.dice[die]!.map((f, i) => ({ f, i })).filter((x) => x.f.t !== "STAR" && x.f.t !== "SKULL");
      star = options.sort((a, b) => value(b.f) - value(a.f))[0]?.i;
      if (star === undefined) return;
    }
    const face = effectiveFace(h, { die, star });
    if (!face) return;
    const target = chooseTarget(s, h, face);
    if (target === undefined) return;
    out.push(star != null ? { type: "ASSIGN_FACE", heroId, die, target, star } : { type: "ASSIGN_FACE", heroId, die, target });
  });
  out.push({ type: "READY", heroId, ready: true });
  return out;
}

function chooseTarget(s: SessionState, h: Hero, face: Face): string | null | undefined {
  const legal = legalTargets(s, h, face);
  if (!legal.length) return undefined;
  if (legal.includes(null)) return null;
  const ids = legal as string[];
  if (face.t === "B") return ids.includes(h.id) ? h.id : ids[0];
  if (face.t === "H") {
    return [...ids].sort((a, b) => {
      const ua = unit(s, a);
      const ub = unit(s, b);
      return ua.hp - ua.maxHp - (ub.hp - ub.maxHp);
    })[0];
  }
  return [...ids].sort((a, b) => unit(s, a).hp - unit(s, b).hp || a.localeCompare(b))[0];
}
