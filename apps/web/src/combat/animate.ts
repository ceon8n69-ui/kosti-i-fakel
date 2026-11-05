import { reduceInPlace, type GameEvent, type SessionState, type VisibleState } from "@kf/engine";
import { itemById } from "@kf/content";
import { play } from "../audio/sound";

export const itemName = (id: string) => itemById(id)?.name ?? id;
import { haptic, hapticImpact } from "../lib/telegram";
import type { Stage3D, UnitVis } from "../scene/stage3d";

export interface UiHooks {
  toast(text: string, tone?: "good" | "bad" | "gold"): void;
  floater(unitId: string, text: string, cls: string): void;
  /** Надпись над клеткой карты (найденное золото, предметы). */
  cellFloater(x: number, y: number, text: string, cls: string): void;
  story(text: string, speaker?: string): void;
  rewards(r: { xp: number; gold: number; items: string[]; reason: string }): void;
  render(): void;
  t(key: string): string;
}

/** Юниты для сцены из видимого состояния. */
/** Юниты поля боя. */
export function unitsOf(s: VisibleState): UnitVis[] {
  return [
    ...s.heroes.map((h): UnitVis => ({ id: h.id, kind: h.classId, side: "hero", row: h.row, status: h.status === "dead" ? "gone" : h.status })),
    ...s.monsters.map((m): UnitVis => ({ id: m.id, kind: m.kind, side: "monster", row: m.row, boss: m.boss, small: m.variant === "small", status: m.alive ? "up" : "gone" })),
  ];
}

/** Применить событие к отображаемому состоянию. Если событие касается скрытого — пропускаем, в конце пачки придёт истина. */
export function applyVisual(d: VisibleState, ev: GameEvent): void {
  try {
    reduceInPlace(d as unknown as SessionState, ev);
  } catch {
    /* скрытый объект или чужое решение — не страшно */
  }
}

const isHero = (d: VisibleState, id: string) => d.heroes.some((h) => h.id === id);

/**
 * Проиграть одно событие: анимация на сцене + изменение отображаемого состояния.
 * Результаты уже известны (их прислал сервер) — здесь только показ.
 */
export async function animateEvent(ev: GameEvent, d: VisibleState, stage: Stage3D | null, ui: UiHooks): Promise<void> {
  const apply = () => {
    applyVisual(d, ev);
    ui.render();
  };
  const wait = (ms: number) => (stage ? stage.tw.wait(ms) : new Promise<void>((r) => setTimeout(r, ms / 3)));

  switch (ev.type) {
    case "CHECK_ROLLED": {
      if (stage) await stage.rollD20(ev.traj, ev.natural);
      else await wait(400);
      apply();
      const nat = ev.natural === 20 ? ` · ${ui.t("toast.nat20")}` : ev.natural === 1 ? ` · ${ui.t("toast.nat1")}` : "";
      const sign = ev.mod >= 0 ? `+${ev.mod}` : `${ev.mod}`;
      ui.toast(`${ui.t(`attr.${ev.attr}`)}: ${ev.natural} ${sign} = ${ev.total} / ${ev.dc} · ${ui.t(ev.success ? "toast.success" : "toast.fail")}${nat}`, ev.natural === 20 ? "gold" : ev.success ? "good" : "bad");
      if (ev.natural === 20) {
        play("crit");
        haptic("success");
      } else if (ev.natural === 1) {
        play("fumble");
        haptic("error");
      }
      await wait(500);
      return;
    }
    case "DEATH_SAVE_ROLLED":
      if (ev.natural > 0 && stage) await stage.rollD20(ev.traj, ev.natural);
      apply();
      return;
    case "HERO_DICE_ROLLED": {
      const h = d.heroes.find((x) => x.id === ev.heroId);
      if (stage && h) {
        await stage.rollD6(
          ev.traj,
          ev.dice.map((die, i) => ({ die, faces: h.dice[die]!, result: ev.faces[i]! })),
        );
      } else await wait(400);
      apply();
      return;
    }
    case "TRAP_REVEALED":
      ui.toast(ui.t("toast.trapFound"), "good");
      if (stage) {
        stage.map.setObject({ id: ev.objectId, type: "trap", x: ev.x, y: ev.y, state: "revealed", trapId: ev.trapId }, true);
        await stage.map.flashCell(ev.x, ev.y, "#f0a040");
      }
      apply();
      return;
    case "TRAP_DISARMED": {
      apply();
      ui.toast(ui.t("toast.trapDisarmed"), "good");
      const o = d.objects.find((x) => x.id === ev.objectId);
      if (stage && o) stage.map.setObject({ ...o, state: "disarmed" }, true);
      return;
    }
    case "TRAP_TRIGGERED":
      ui.toast(ui.t("toast.trapTriggered"), "bad");
      play("hit");
      hapticImpact("heavy");
      if (stage) {
        stage.map.setObject({ id: ev.objectId, type: "trap", x: ev.x, y: ev.y, state: "triggered", trapId: ev.trapId }, false);
        await stage.map.flashCell(ev.x, ev.y, "#c0392b");
      }
      apply();
      return;
    case "PARTY_MOVED":
      if (stage) await stage.map.walk(ev.path, () => play("dice", 0.15));
      apply();
      return;
    case "TILE_REVEALED":
      if (stage) {
        for (const [x, y, ch] of ev.cells) stage.map.setTile(x, y, ch, true);
        for (const o of ev.objects) stage.map.setObject(o, true);
      }
      apply();
      return;
    case "TILE_CHANGED":
      if (stage) for (const [x, y, ch] of ev.cells) stage.map.setTile(x, y, ch, true);
      apply();
      return;
    case "SECRET_FOUND":
      ui.toast(ui.t("toast.secret"), "gold");
      play("crit");
      if (stage) {
        stage.map.setTile(ev.object.x, ev.object.y, ".", true);
        stage.map.setObject(ev.object, true);
      }
      apply();
      return;
    case "OBJECT_CHANGED": {
      const o = d.objects.find((x) => x.id === ev.objectId);
      apply();
      if (stage && o) {
        if (ev.patch.used && o.type === "key") stage.map.removeObject(o.id);
        else stage.map.setObject({ ...o, ...(ev.patch as object) }, true);
      }
      if (o?.type === "door" && ev.patch.open) play("block");
      await wait(200);
      return;
    }
    case "TEXT_SHOWN":
      apply();
      ui.story(ev.text, ev.speaker);
      await wait(250);
      return;
    case "ITEM_FOUND": {
      apply();
      const o = d.objects.find((x) => x.id === ev.objectId);
      const parts = [ev.gold ? `+${ev.gold} ${ui.t("bag.gold")}` : "", ...ev.items.map((i) => `+${itemName(i)}`), ...ev.keys.map(() => `+${ui.t("bag.key")}`)].filter(Boolean);
      const at = o ?? { x: d.pos.x, y: d.pos.y };
      parts.forEach((p, i) => setTimeout(() => ui.cellFloater(at.x, at.y, p, "fl-loot"), i * 250));
      if (ev.items.some((i) => itemById(i)?.kind === "equipment")) ui.toast(`${ui.t("toast.equipFound")}: ${ev.items.filter((i) => itemById(i)?.kind === "equipment").map(itemName).join(", ")}`, "gold");
      play("heal");
      haptic("success");
      await wait(300);
      return;
    }
    case "OPTION_CHOSEN":
      apply();
      return;
    case "GOLD_CHANGED":
      apply();
      ui.floater(d.leaderId, `${ev.delta > 0 ? "+" : ""}${ev.delta} ${ui.t("bag.gold")}`, "fl-loot");
      return;
    case "ALLY_JOINED":
      apply();
      ui.toast(`${ev.name} ${ui.t("toast.ally")}`, "gold");
      return;
    case "XP_BONUS":
      apply();
      ui.toast(`+${ev.amount} ${ui.t("end.xp")}`, "good");
      return;
    case "ITEM_USED":
      apply();
      ui.toast(itemName(ev.itemId), "good");
      return;
    case "PARTY_RESTED":
      apply();
      ui.toast(ui.t("toast.rest"), "good");
      play("torch");
      await wait(300);
      return;
    case "LEADER_CHANGED":
      apply();
      return;
    case "ENCOUNTER_SPOTTED":
      apply();
      if (stage) stage.map.addFoes(ev.encounterId, ev.kinds, ev.x, ev.y, true);
      ui.toast(ui.t("toast.spotted"), "bad");
      await wait(350);
      return;
    case "ENCOUNTER_STARTED":
      apply();
      if (stage) {
        stage.map.removeFoes(ev.encounterId);
        stage.setUnits(unitsOf(d));
        await stage.transition("battle");
      }
      play("hit");
      haptic("error");
      return;
    case "ENCOUNTER_ENDED":
      ui.toast(ui.t("toast.encounterWon"), "gold");
      play("victory");
      await wait(500);
      apply();
      if (stage) {
        stage.clearDice();
        await stage.transition("map");
      }
      return;
    case "REWARDS":
      apply();
      ui.rewards(ev);
      return;
    case "SESSION_ENTERED":
      return;
    case "MONSTER_SPAWNED":
      apply();
      if (stage) await stage.spawn(unitsOf(d), ev.monster.id);
      return;
    case "ROUND_STARTED":
      apply();
      stage?.clearDice();
      return;
    case "ROW_CHANGED":
      apply();
      if (stage) await stage.regroup(unitsOf(d));
      return;
    case "DAMAGE_DEALT": {
      const toHero = isHero(d, ev.targetId);
      if (stage && ev.kind !== "poison" && ev.kind !== "skulls" && ev.kind !== "trap") {
        const ranged = ev.kind === "ranged" || ev.kind === "magic";
        const src = d.monsters.find((m) => m.id === ev.sourceId);
        const monsterRanged = src && (src.row === "back" || src.kind === "lamplighter");
        if (ranged || monsterRanged) await stage.shoot(ev.sourceId, ev.targetId, ev.kind === "magic" ? "#b79bff" : "#e8d9a8");
        else await stage.lunge(ev.sourceId, ev.targetId);
      }
      apply();
      if (ev.blocked > 0) ui.floater(ev.targetId, `🛡${ev.blocked}`, "fl-block");
      if (ev.amount > 0 || ev.blocked === 0) ui.floater(ev.targetId, `-${ev.amount}`, ev.kind === "poison" ? "fl-poison" : "fl-dmg");
      if (ev.amount > 0) {
        play("hit");
        hapticImpact(toHero ? "heavy" : "medium");
        if (stage) await stage.hurt(ev.targetId);
      } else {
        play("block");
        if (stage) await stage.flash(ev.targetId, "#7fb2ff");
      }
      if (ev.kind === "skulls") ui.toast(ui.t("toast.skulls"), "bad");
      return;
    }
    case "BLOCK_GAINED":
      apply();
      ui.floater(ev.targetId, `+🛡${ev.amount}`, "fl-block");
      play("block");
      if (stage) await stage.flash(ev.targetId, "#7fb2ff");
      return;
    case "HEALED":
      apply();
      ui.floater(ev.targetId, `+${ev.amount}`, "fl-heal");
      play("heal");
      if (stage) await stage.flash(ev.targetId, "#7fe0a0");
      return;
    case "HERO_RAISED":
      apply();
      ui.floater(ev.heroId, `+${ev.hp}`, "fl-heal");
      play("heal");
      if (stage) await stage.down(ev.heroId, false);
      return;
    case "HERO_DOWNED":
      apply();
      play("death");
      haptic("error");
      if (stage) await stage.down(ev.heroId, true);
      return;
    case "MONSTER_DIED":
      apply();
      play("death");
      if (stage) await stage.kill(ev.monsterId);
      return;
    case "LIGHT_CHANGED":
      apply();
      stage?.setLight(d.light);
      if (ev.reason !== "round") play("torch");
      return;
    case "SESSION_ENDED":
      apply();
      play(ev.reason === "victory" ? "victory" : "defeat");
      haptic(ev.reason === "victory" ? "success" : "error");
      await wait(300);
      return;
    case "ASSIGNMENTS_REVEALED":
    case "ENEMY_TURN_STARTED":
      apply();
      await wait(120);
      return;
    default:
      apply();
  }
}
