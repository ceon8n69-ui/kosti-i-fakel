import { reduceInPlace, type GameEvent, type SessionState, type VisibleState } from "@kf/engine";
import { play } from "../audio/sound";
import { haptic, hapticImpact } from "../lib/telegram";
import type { Stage3D, UnitVis } from "../scene/stage3d";

export interface UiHooks {
  toast(text: string, tone?: "good" | "bad" | "gold"): void;
  floater(unitId: string, text: string, cls: string): void;
  render(): void;
  t(key: string): string;
}

/** Юниты для сцены из видимого состояния. */
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
      apply();
      ui.toast(ui.t("toast.trapFound"), "good");
      await wait(300);
      return;
    case "TRAP_DISARMED":
      apply();
      ui.toast(ui.t("toast.trapDisarmed"), "good");
      return;
    case "TRAP_TRIGGERED":
      apply();
      ui.toast(ui.t("toast.trapTriggered"), "bad");
      play("hit");
      await wait(200);
      return;
    case "PARTY_MOVED":
      apply();
      if (stage) {
        stage.exploring = false;
        await stage.regroup(unitsOf(d), true);
      }
      return;
    case "ENCOUNTER_STARTED":
      apply();
      stage?.clearDice();
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
