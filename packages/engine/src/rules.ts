import { balance } from "@kf/content";
import type { DungeonRule } from "@kf/schema";
import { changeLight, setLightRules } from "./common.js";
import type { Ctx } from "./ctx.js";
import { revealAround } from "./explore.js";
import { spawn, startEncounter } from "./combat.js";

export type RuleTrigger =
  | { on: "enter_zone"; x: number; y: number }
  | { on: "use_object"; objectId: string }
  | { on: "monster_died"; encounterId: string }
  | { on: "item_taken"; objectId: string }
  | { on: "light_below"; before: number; after: number }
  | { on: "round_start"; round: number };

const inZone = (z: { x: number; y: number; w: number; h: number }, x: number, y: number) => x >= z.x && y >= z.y && x < z.x + z.w && y < z.y + z.h;

function matches(r: DungeonRule, t: RuleTrigger): boolean {
  const e = r.event;
  switch (e.on) {
    case "enter_zone":
      return t.on === "enter_zone" && inZone(e.zone, t.x, t.y);
    case "use_object":
      return t.on === "use_object" && t.objectId === e.objectId;
    case "monster_died":
      return t.on === "monster_died" && t.encounterId === e.encounterId;
    case "item_taken":
      return t.on === "item_taken" && t.objectId === e.objectId;
    case "light_below":
      return t.on === "light_below" && t.before >= e.value && t.after < e.value;
    case "round_start":
      return t.on === "round_start" && t.round === e.round;
  }
}

function conditionsHold(ctx: Ctx, r: DungeonRule): boolean {
  const s = ctx.s;
  const cmp = (op: "eq" | "gte" | "lte", a: number, b: number) => (op === "eq" ? a === b : op === "gte" ? a >= b : a <= b);
  return r.conditions.every((c) => {
    switch (c.if) {
      case "has_item":
        return s.bag.keys.includes(c.keyId);
      case "variable":
        return cmp(c.op, s.vars[c.variable] ?? 0, c.value);
      case "class_in_party":
        return s.heroes.some((h) => h.classId === c.classId);
      case "party_size":
        return cmp(c.op, s.partySize, c.value);
      case "light":
        return cmp(c.op, s.light, c.value);
    }
  });
}

/** Правила «событие → условие → действие» (ТЗ 6.3). Цепочка ограничена по глубине. */
export function fireRules(ctx: Ctx, t: RuleTrigger): void {
  if (ctx.ended || ctx.ruleDepth >= balance.builder.maxChainDepth) return;
  ctx.ruleDepth++;
  try {
    for (const r of ctx.s.def.rules) {
      if (ctx.ended) return;
      const limit = r.limit ?? balance.builder.defaultRuleFireLimit;
      if ((ctx.s.ruleFired[r.id] ?? 0) >= limit) continue;
      if (!matches(r, t) || !conditionsHold(ctx, r)) continue;
      ctx.emit({ type: "RULE_FIRED", ruleId: r.id });
      for (const a of r.actions) {
        if (ctx.ended) return;
        runAction(ctx, r.id, a);
      }
    }
  } finally {
    ctx.ruleDepth--;
  }
}

function runAction(ctx: Ctx, ruleId: string, a: DungeonRule["actions"][number]): void {
  const s = ctx.s;
  switch (a.do) {
    case "open_door":
    case "close_door": {
      const d = s.objects.find((o) => o.id === a.doorId && o.type === "door");
      if (!d) return;
      const open = a.do === "open_door";
      ctx.emit({ type: "OBJECT_CHANGED", objectId: d.id, patch: open ? { open: true, locked: false, hidden: false } : { open: false } });
      if (open) revealAround(ctx);
      return;
    }
    case "arm_trap": {
      const tr = s.objects.find((o) => o.id === a.trapId && o.type === "trap");
      if (tr) ctx.emit({ type: "OBJECT_CHANGED", objectId: tr.id, patch: { state: tr.hidden ? "armed" : "revealed" } });
      return;
    }
    case "spawn":
      if (s.phase === "combat") for (const k of a.monsters) spawn(ctx, k, "summon");
      else startEncounter(ctx, `rule_${ruleId}`, a.monsters);
      return;
    case "show_text": {
      const text = s.def.texts[a.textId];
      if (text) ctx.emit({ type: "TEXT_SHOWN", textId: a.textId, text });
      return;
    }
    case "change_light":
      changeLight(ctx, a.delta, `rule:${ruleId}`);
      return;
    case "set_variable":
      ctx.emit({ type: "VARIABLE_SET", variable: a.variable, value: a.value });
      return;
    case "flood_zone": {
      const cells: [number, number, string][] = [];
      for (let y = a.zone.y; y < a.zone.y + a.zone.h; y++)
        for (let x = a.zone.x; x < a.zone.x + a.zone.w; x++) if (s.tiles[y]?.[x] === ".") cells.push([x, y, "~"]);
      if (cells.length) ctx.emit({ type: "TILE_CHANGED", cells });
      return;
    }
    case "set_tile":
      ctx.emit({ type: "TILE_CHANGED", cells: [[a.x, a.y, a.tile]] });
      revealAround(ctx);
      return;
  }
}

setLightRules((ctx, before, after) => fireRules(ctx, { on: "light_below", before, after }));
