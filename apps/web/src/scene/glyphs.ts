import type { Face } from "@kf/schema";

/** Цвета граней: одна гамма для 3D-кубиков и для фишек в интерфейсе. */
export const FACE_COLOR: Record<string, string> = {
  M: "#d9d2c3",
  L: "#b9d27a",
  I: "#b79bff",
  B: "#7fb2ff",
  H: "#7fe0a0",
  STAR: "#ffd45c",
  SKULL: "#8a7f74",
};

/** Рисует значок грани в квадрате size×size с отступом. ink — цвет линий. */
export function drawFace(ctx: CanvasRenderingContext2D, face: Face, size: number, ink: string): void {
  const s = size;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  const lw = s * 0.07;
  ctx.lineWidth = lw;
  const cx = s * 0.42;
  const cy = s * 0.42;
  const r = s * 0.26;
  switch (face.t) {
    case "M": // меч
      ctx.beginPath();
      ctx.moveTo(cx - r, cy + r);
      ctx.lineTo(cx + r, cy - r);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.75, cy + r * 0.15);
      ctx.lineTo(cx - r * 0.15, cy + r * 0.75);
      ctx.stroke();
      break;
    case "L": // лук и стрела
      ctx.beginPath();
      ctx.arc(cx - r * 0.3, cy, r, -Math.PI / 2.4, Math.PI / 2.4);
      ctx.stroke();
      ctx.lineWidth = lw * 0.6;
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.9, cy);
      ctx.lineTo(cx + r * 0.9, cy);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + r * 0.9, cy);
      ctx.lineTo(cx + r * 0.55, cy - r * 0.3);
      ctx.moveTo(cx + r * 0.9, cy);
      ctx.lineTo(cx + r * 0.55, cy + r * 0.3);
      ctx.stroke();
      break;
    case "I": // вспышка
      star(ctx, cx, cy, 4, r, r * 0.3);
      ctx.fill();
      if (face.all) {
        star(ctx, cx + r * 0.95, cy - r * 0.85, 4, r * 0.38, r * 0.12);
        ctx.fill();
        star(ctx, cx - r * 0.95, cy - r * 0.85, 4, r * 0.38, r * 0.12);
        ctx.fill();
      }
      break;
    case "B": // щит
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.quadraticCurveTo(cx + r, cy - r, cx + r, cy - r * 0.6);
      ctx.quadraticCurveTo(cx + r, cy + r * 0.5, cx, cy + r * 1.1);
      ctx.quadraticCurveTo(cx - r, cy + r * 0.5, cx - r, cy - r * 0.6);
      ctx.quadraticCurveTo(cx - r, cy - r, cx, cy - r);
      ctx.stroke();
      if (face.taunt) {
        ctx.font = `bold ${s * 0.26}px Georgia, serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("!", cx, cy + r * 0.05);
      }
      break;
    case "H": // крест
      ctx.fillRect(cx - r * 0.28, cy - r, r * 0.56, r * 2);
      ctx.fillRect(cx - r, cy - r * 0.28, r * 2, r * 0.56);
      break;
    case "STAR":
      star(ctx, s / 2, s / 2, 5, s * 0.34, s * 0.15);
      ctx.fill();
      break;
    case "SKULL": {
      const x = s / 2;
      const y = s * 0.46;
      ctx.beginPath();
      ctx.arc(x, y, s * 0.24, Math.PI * 0.85, Math.PI * 2.15);
      ctx.lineTo(x + s * 0.13, y + s * 0.3);
      ctx.lineTo(x - s * 0.13, y + s * 0.3);
      ctx.closePath();
      ctx.fill();
      ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath();
      ctx.arc(x - s * 0.09, y + s * 0.02, s * 0.065, 0, Math.PI * 2);
      ctx.arc(x + s * 0.09, y + s * 0.02, s * 0.065, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
      break;
    }
  }
  if (face.t !== "STAR" && face.t !== "SKULL") {
    ctx.font = `bold ${s * 0.36}px Georgia, serif`;
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(String(face.n), s * 0.94, s * 0.94);
    if (face.poison) {
      // капля яда
      ctx.fillStyle = "#57d16b";
      ctx.beginPath();
      const px = s * 0.16;
      const py = s * 0.8;
      ctx.moveTo(px, py - s * 0.12);
      ctx.quadraticCurveTo(px + s * 0.09, py, px, py + s * 0.06);
      ctx.quadraticCurveTo(px - s * 0.09, py, px, py - s * 0.12);
      ctx.fill();
    }
  }
  ctx.restore();
}

function star(ctx: CanvasRenderingContext2D, cx: number, cy: number, n: number, ro: number, ri: number) {
  ctx.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const a = (Math.PI * i) / n - Math.PI / 2;
    const r = i % 2 ? ri : ro;
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  ctx.closePath();
}

const urlCache = new Map<string, string>();
/** Картинка грани для DOM (фишки кубиков). */
export function faceDataUrl(face: Face, size = 96): string {
  const key = JSON.stringify(face) + size;
  const hit = urlCache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  drawFace(ctx, face, size, FACE_COLOR[face.t]!);
  const url = c.toDataURL();
  urlCache.set(key, url);
  return url;
}
