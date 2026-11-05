/**
 * Записывает 12 траекторий на каждый тип кубика (ТЗ 9.3). Физика считается один раз здесь,
 * клиент только проигрывает запись и подставляет нужную грань сверху.
 * Детерминированно: один и тот же файл при каждом запуске.
 *
 * Координаты лотка: x вправо, z к игроку, y вверх. Лоток 4.8 × 3.0.
 */
import { writeFileSync } from "node:fs";
import * as CANNON from "cannon-es";
import * as THREE from "three";

export const TRAY = { w: 4.8, d: 3.0 };
const D6_HALF = 0.28;
const D20_R = 0.4;
const STEP = 1 / 120;
const RECORD_EVERY = 4; // 30 кадров/с
const MAX_STEPS = 120 * 4;

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function d20Shape() {
  const g = new THREE.IcosahedronGeometry(D20_R, 0);
  const pos = g.getAttribute("position");
  const verts = [];
  const faces = [];
  const key = (v) => v.toArray().map((x) => x.toFixed(4)).join(",");
  const map = new Map();
  for (let i = 0; i < pos.count; i += 3) {
    const tri = [];
    for (let k = 0; k < 3; k++) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, i + k);
      const kk = key(v);
      if (!map.has(kk)) {
        map.set(kk, verts.length);
        verts.push(new CANNON.Vec3(v.x, v.y, v.z));
      }
      tri.push(map.get(kk));
    }
    faces.push(tri);
  }
  return new CANNON.ConvexPolyhedron({ vertices: verts, faces });
}

function world() {
  const w = new CANNON.World({ gravity: new CANNON.Vec3(0, -28, 0) });
  w.allowSleep = true;
  const floorMat = new CANNON.Material("floor");
  const diceMat = new CANNON.Material("dice");
  w.addContactMaterial(new CANNON.ContactMaterial(floorMat, diceMat, { friction: 0.25, restitution: 0.35 }));
  w.addContactMaterial(new CANNON.ContactMaterial(diceMat, diceMat, { friction: 0.2, restitution: 0.3 }));
  const plane = (pos, quat) => {
    const b = new CANNON.Body({ mass: 0, material: floorMat, shape: new CANNON.Plane() });
    b.position.set(...pos);
    b.quaternion.setFromEuler(...quat);
    w.addBody(b);
  };
  plane([0, 0, 0], [-Math.PI / 2, 0, 0]);
  plane([-TRAY.w / 2, 0, 0], [0, Math.PI / 2, 0]);
  plane([TRAY.w / 2, 0, 0], [0, -Math.PI / 2, 0]);
  plane([0, 0, -TRAY.d / 2], [0, 0, 0]);
  plane([0, 0, TRAY.d / 2], [0, Math.PI, 0]);
  return { w, diceMat };
}

const upNormalDot = (body, normals) => {
  const q = new THREE.Quaternion(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
  return Math.max(...normals.map((n) => n.clone().applyQuaternion(q).y));
};

const D6_NORMALS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map((a) => new THREE.Vector3(...a));
const D20_NORMALS = (() => {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const p = g.getAttribute("position");
  const out = [];
  for (let i = 0; i < p.count; i += 3) {
    const a = new THREE.Vector3().fromBufferAttribute(p, i);
    const b = new THREE.Vector3().fromBufferAttribute(p, i + 1);
    const c = new THREE.Vector3().fromBufferAttribute(p, i + 2);
    out.push(new THREE.Vector3().subVectors(c, b).cross(new THREE.Vector3().subVectors(a, b)).normalize());
  }
  return out;
})();

function simulate(kind, count, seed) {
  const rnd = mulberry32(seed);
  const r = (a, b) => a + (b - a) * rnd();
  const { w, diceMat } = world();
  const bodies = [];
  for (let i = 0; i < count; i++) {
    const shape = kind === "d6" ? new CANNON.Box(new CANNON.Vec3(D6_HALF, D6_HALF, D6_HALF)) : d20Shape();
    const b = new CANNON.Body({ mass: 1, material: diceMat, shape, sleepSpeedLimit: 0.08, sleepTimeLimit: 0.25 });
    // У d20 почти круглая форма — без сильного затухания он катится бесконечно.
    b.linearDamping = kind === "d6" ? 0.05 : 0.25;
    b.angularDamping = kind === "d6" ? 0.08 : 0.4;
    // Бросок справа налево, кубики летят веером.
    const lane = count === 1 ? 0 : (i - (count - 1) / 2) * 0.9;
    b.position.set(r(1.5, 1.9), r(1.2, 1.8), lane + r(-0.15, 0.15));
    b.velocity.set(r(-6.2, -4.2), r(-0.5, 2), r(-1, 1) - lane * 0.3);
    b.angularVelocity.set(r(-18, 18), r(-18, 18), r(-18, 18));
    b.quaternion.setFromEuler(r(0, 6.28), r(0, 6.28), r(0, 6.28));
    w.addBody(b);
    bodies.push(b);
  }
  const frames = [];
  for (let s = 0; s < MAX_STEPS; s++) {
    w.step(STEP);
    if (s % RECORD_EVERY === 0) {
      frames.push(
        bodies.flatMap((b) => [
          +b.position.x.toFixed(3), +b.position.y.toFixed(3), +b.position.z.toFixed(3),
          +b.quaternion.x.toFixed(4), +b.quaternion.y.toFixed(4), +b.quaternion.z.toFixed(4), +b.quaternion.w.toFixed(4),
        ]),
      );
    }
    if (s > 60 && bodies.every((b) => b.sleepState === CANNON.Body.SLEEPING)) break;
  }
  const normals = kind === "d6" ? D6_NORMALS : D20_NORMALS;
  const flat = bodies.every((b) => upNormalDot(b, normals) > (kind === "d6" ? 0.995 : 0.97));
  const settled = bodies.every((b) => b.sleepState === CANNON.Body.SLEEPING);
  // Кубик должен остановиться в середине лотка, а не у бортика.
  const inside = bodies.every((b) => Math.abs(b.position.x) < TRAY.w / 2 - 0.55 && Math.abs(b.position.z) < TRAY.d / 2 - 0.45);
  // Кубики не должны лечь вплотную: их грани должны быть видны.
  let apart = true;
  for (let i = 0; i < bodies.length; i++)
    for (let j = i + 1; j < bodies.length; j++) if (bodies[i].position.distanceTo(bodies[j].position) < 0.75) apart = false;
  return { ok: flat && settled && inside && apart, frames, why: { flat, settled, inside, apart } };
}

const out = { fps: 30, tray: TRAY, d6Half: D6_HALF, d20Radius: D20_R, d6: [], d20: [] };
for (const [kind, count] of [["d6", 3], ["d20", 1]]) {
  let seed = kind === "d6" ? 1000 : 5000;
  const fails = {};
  while (out[kind].length < 12) {
    if (seed % 500 === 0 && process.env.DEBUG) console.log(kind, seed, out[kind].length, JSON.stringify(fails));
    const { ok, frames, why } = simulate(kind, count, seed++);
    for (const [k, v] of Object.entries(why)) if (!v) fails[k] = (fails[k] ?? 0) + 1;
    if (ok && (frames.length < 30 || frames.length > 110)) fails.len = (fails.len ?? 0) + 1;
    if (ok && frames.length >= 30 && frames.length <= 110) out[kind].push(frames);
  }
}
const file = new URL("../src/dice/trajectories.json", import.meta.url);
writeFileSync(file, JSON.stringify(out));
console.log("d6 frames:", out.d6.map((f) => f.length).join(","), "d20 frames:", out.d20.map((f) => f.length).join(","));
