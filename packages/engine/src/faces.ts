import type { Face } from "@kf/schema";
import type { Assignment, Hero, Monster, SessionState } from "./types.js";

/** Фактическая грань с учётом звезды. null — звезда без выбора. */
export function effectiveFace(h: Hero, a: Pick<Assignment, "die" | "star">): Face | null {
  const idx = h.roll[a.die];
  if (idx == null) return null;
  const face = h.dice[a.die]![idx]!;
  if (face.t !== "STAR") return face;
  if (a.star == null) return null;
  const chosen = h.dice[a.die]![a.star];
  if (!chosen || chosen.t === "STAR") return null;
  return chosen;
}

export const aliveMonsters = (s: SessionState): Monster[] => s.monsters.filter((m) => m.alive);
export const upHeroes = (s: SessionState): Hero[] => s.heroes.filter((h) => h.status === "up");

/** Ближняя атака бьёт только передний ряд; если он пуст — задний. */
export function meleeTargets(s: SessionState): Monster[] {
  const alive = aliveMonsters(s);
  const front = alive.filter((m) => m.row === "front");
  return front.length ? front : alive;
}

/** Допустимые цели грани. null в списке — грань назначается без цели. */
export function legalTargets(s: SessionState, h: Hero, face: Face): (string | null)[] {
  switch (face.t) {
    case "SKULL":
    case "STAR":
      return [];
    case "M":
      return meleeTargets(s).map((m) => m.id);
    case "L":
      return aliveMonsters(s).map((m) => m.id);
    case "I":
      return face.all ? [null] : aliveMonsters(s).map((m) => m.id);
    case "B":
      return upHeroes(s).map((x) => x.id);
    case "H":
      return s.heroes.filter((x) => x.status !== "dead").map((x) => x.id);
  }
}

export const isDamageFace = (f: Face): boolean => f.t === "M" || f.t === "L" || f.t === "I";
