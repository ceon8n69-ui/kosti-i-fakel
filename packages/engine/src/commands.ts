import { balance, itemById } from "@kf/content";
import { clone } from "./clone.js";
import { resolveRound, rollHeroDice } from "./combat.js";
import { Ctx, fail } from "./ctx.js";
import { canPath, disarm, enterDungeon, force, move, rest, search, useError, useItem, useObject } from "./explore.js";
import { effectiveFace, legalTargets, upHeroes } from "./faces.js";
import { cheb } from "./grid.js";
import { hero as getHero, reduceInPlace } from "./reducer.js";
import type { Rng } from "./rng.js";
import "./rules.js";
import type { Command, CommandError, CommandResult, GameEvent, SessionState } from "./types.js";

export { TRAJECTORIES, lightState } from "./common.js";
export { createMonster } from "./combat.js";

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

/** Журнал новой партии: SESSION_STARTED + вступление и первый обзор. */
export function openSession(first: GameEvent, rng: Rng): GameEvent[] {
  if (first.type !== "SESSION_STARTED") throw new Error("expected SESSION_STARTED");
  const s = reduceInPlace(undefined as unknown as SessionState, first);
  const ctx = new Ctx(s, rng);
  enterDungeon(ctx);
  return [first, ...ctx.events];
}

function validate(s: SessionState, cmd: Command): CommandError | null {
  if (s.phase === "ended") return fail("session_ended");
  if (cmd.expectedSeq !== s.seq) return fail("stale_seq", `expected ${s.seq}`);
  const h = s.heroes.find((x) => x.id === cmd.heroId);
  if (!h) return fail("no_hero");
  if (h.ownerId !== cmd.actorId) return fail("not_your_hero");
  if (h.status !== "up") return fail("hero_not_up");
  const explore = s.phase === "explore";

  switch (cmd.type) {
    case "MOVE": {
      if (!explore) return fail("wrong_phase");
      if (cmd.heroId !== s.leaderId) return fail("not_leader");
      if (!Number.isInteger(cmd.x) || !Number.isInteger(cmd.y)) return fail("bad_cell");
      if (cmd.x === s.pos.x && cmd.y === s.pos.y) return fail("same_cell");
      return canPath(s, cmd.x, cmd.y) ? null : fail("no_path");
    }
    case "INTERACT": {
      if (!explore) return fail("wrong_phase");
      const o = s.objects.find((x) => x.id === cmd.objectId);
      if (!o) return fail("no_object");
      if (cmd.verb === "use") {
        const e = useError(s, o);
        return e ? fail(e) : null;
      }
      if (o.hidden || cheb(s.pos.x, s.pos.y, o.x, o.y) > balance.explore.adjacent) return fail("too_far");
      if (cmd.verb === "force") return (o.type === "door" || o.type === "chest") && o.locked && !o.open && !o.used ? null : fail("not_locked");
      if (cmd.verb === "disarm") return o.type === "trap" && o.state === "revealed" ? null : fail("bad_verb");
      return fail("bad_verb");
    }
    case "SEARCH":
      return explore ? null : fail("wrong_phase");
    case "REST": {
      if (!explore) return fail("wrong_phase");
      const o = s.objects.find((x) => x.id === cmd.objectId);
      if (!o || o.type !== "campfire") return fail("no_campfire");
      return useError(s, o) ? fail(useError(s, o)!) : null;
    }
    case "RETREAT": {
      if (!explore) return fail("wrong_phase");
      const ent = s.objects.find((o) => o.type === "entrance")!;
      return cheb(s.pos.x, s.pos.y, ent.x, ent.y) <= balance.explore.adjacent ? null : fail("not_at_entrance");
    }
    case "USE_ITEM": {
      const it = itemById(cmd.itemId);
      if (!it || !s.bag.items.includes(cmd.itemId)) return fail("no_item");
      if (s.phase === "combat" && !it.combat) return fail("not_in_combat");
      if (s.phase === "combat" && h.ready) return fail("already_ready");
      if (it.effect === "heal") {
        const t = s.heroes.find((x) => x.id === (cmd.targetId ?? h.id));
        if (!t || t.status === "dead") return fail("bad_target");
        if (t.status === "up" && t.hp >= t.maxHp) return fail("full_hp");
      }
      return null;
    }
    case "CHANGE_ROW":
      if (!explore) return fail("wrong_phase");
      return cmd.row === "front" || cmd.row === "back" ? null : fail("bad_row");
    case "ROLL_DICE":
      if (s.phase !== "combat") return fail("wrong_phase");
      return h.roll.some((r) => r !== null) ? fail("already_rolled") : null;
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
        if (cmd.target === null && cmd.star == null) return null;
        if (cmd.star == null) return fail("star_needs_face");
      } else if (cmd.star != null) return fail("not_a_star");
      const face = effectiveFace(h, cmd);
      if (!face) return fail("bad_star");
      const legal = legalTargets(s, h, face);
      if (cmd.target === null && !legal.includes(null)) return null;
      return legal.includes(cmd.target) ? null : fail("bad_target");
    }
    case "READY":
      if (s.phase !== "combat") return fail("wrong_phase");
      return h.roll.some((r) => r === null) ? fail("not_rolled") : null;
  }
}

function execute(ctx: Ctx, cmd: Command): void {
  const s = ctx.s;
  switch (cmd.type) {
    case "MOVE":
      move(ctx, canPath(s, cmd.x, cmd.y)!);
      return;
    case "INTERACT": {
      const o = s.objects.find((x) => x.id === cmd.objectId)!;
      if (cmd.verb === "use") useObject(ctx, cmd.heroId, o);
      else if (cmd.verb === "force") force(ctx, cmd.heroId, o);
      else disarm(ctx, cmd.heroId, o);
      return;
    }
    case "SEARCH":
      search(ctx, cmd.heroId);
      return;
    case "REST":
      rest(ctx, s.objects.find((o) => o.id === cmd.objectId)!);
      return;
    case "RETREAT":
      useObject(ctx, cmd.heroId, s.objects.find((o) => o.type === "entrance")!);
      return;
    case "USE_ITEM":
      useItem(ctx, cmd.heroId, cmd.itemId, cmd.targetId);
      return;
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
      const f = effectiveFace(h, cmd);
      const unassign = cmd.target === null && (!f || !legalTargets(s, h, f).includes(null));
      if (!unassign) plan.push(cmd.star != null ? { die: cmd.die, target: cmd.target, star: cmd.star } : { die: cmd.die, target: cmd.target });
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
