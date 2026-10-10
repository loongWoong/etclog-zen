/**
 * 浏览器外的天空冒烟台：核对云的**几何**是不是按真实天空来的，而不是"看着差不多"。
 *
 * 用法（在 replay/ 下）：
 *   python _smoketool.py _smoke/sky-check.mjs && node _smoke/sky-check.mjs
 *
 * 最要紧的一条：等距柱状画布上画的椭圆，**投回天球上必须是圆的**。
 * 原来直接在画布上画圆，等于天顶的云被压窄、地平线的云被拉宽 —— 一眼就假。
 * 这里用"角宽 = Δφ·sin高度角、角高 = Δθ"两条恒等式把它钉死。
 */
import {
  skyCloudLayout, skyCanvasPoint, skyEllipse, paintSkyClouds,
  sunDirection, SKY_COLORS,
} from "./scene-look.mjs";

const failures = [];
function check(ok, what, detail = "") {
  if (!ok) failures.push(`${what}${detail ? " -> " + detail : ""}`);
  console.log(`${ok ? "  ok " : "  !! "}${what}${detail ? "  " + detail : ""}`);
}
const deg = (r) => (r * 180) / Math.PI;
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const W = 2048;
const H = 1024;
const sunAz = 118;
const sunEl = 58;
const layout = skyCloudLayout({ seed: 20260701, sunAzimuth: sunAz, sunElevation: sunEl });

// ---- 1. 确定性：同一个种子必须逐字节一样（自检才能复算） ----
const again = skyCloudLayout({ seed: 20260701, sunAzimuth: sunAz, sunElevation: sunEl });
check(JSON.stringify(layout) === JSON.stringify(again), "同一个种子生成的云完全一致（可复算）",
  `${layout.clouds.length} 团积云 / ${layout.cirrus.length} 条丝缕`);

// ---- 2. 地平线以上，且高度分布面积均匀（dA ∝ d(sin高度角)） ----
const above = layout.clouds.every((c) => c.dir[1] > 0);
check(above, "所有积云都在地平线以上", above ? "" : (layout.clouds.find((c) => c.dir[1] <= 0) || {}).dir?.join(","));
const ys = layout.clouds.map((c) => c.dir[1]).sort((a, b) => a - b);
const meanY = ys.reduce((s, v) => s + v, 0) / ys.length;
const deciles = Array.from({ length: 10 }, (_, i) => ys.filter((v) => v >= i / 10 && v < (i + 1) / 10).length);
const emptyBands = deciles.filter((n) => n === 0).length;
check(near(meanY, 0.51, 0.06) && emptyBands === 0,
  "sin高度角在 [0,1] 上均匀（= 天球上面积均匀，云不会全挤在天顶）",
  `均值 ${meanY.toFixed(3)}，十段分布 ${deciles.join("/")}`);

// ---- 3. 视角半径 ∝ sin高度角（云在一个水平云层上，离地平线越远看着越小） ----
const bases = layout.clouds.map((c) => deg(c.radius) / Math.max(0.12, c.dir[1]));
const baseMin = Math.min(...bases);
const baseMax = Math.max(...bases);
check(baseMin >= 4.4 && baseMax <= 16.1 && (baseMax - baseMin) > 5,
  "云底视角半径 = 基准角 × sin高度角（基准角 4.5°~16° 随机，所以近地平线的云明显更小）",
  `基准角 ${baseMin.toFixed(1)}°~${baseMax.toFixed(1)}°`);
const low = layout.clouds.filter((c) => c.dir[1] < 0.25);
const high = layout.clouds.filter((c) => c.dir[1] > 0.75);
const mean = (list) => list.reduce((s, c) => s + deg(c.radius), 0) / Math.max(1, list.length);
check(low.length > 0 && high.length > 0 && mean(low) < mean(high) * 0.6,
  "贴地平线的云的平均视角半径明显小于天顶附近的",
  `低 ${low.length} 团均 ${mean(low).toFixed(1)}° vs 高 ${high.length} 团均 ${mean(high).toFixed(1)}°`);

// ---- 4. 等距柱状足印的恒等式：角宽 = 角高 = 视角半径 ----
const sunDir = sunDirection(sunAz, sunEl);
let worstAngular = 0;
let worstCloud = null;
for (const cloud of layout.clouds) {
  for (const puff of [...cloud.puffs, { dir: cloud.dir, radius: cloud.radius }]) {
    const p = skyCanvasPoint(puff.dir, W, H);
    if (p.horizontal <= 1e-3) continue;
    const e = skyEllipse(puff.radius, p.horizontal, W, H);
    const angularWidth = (e.au * 2 * Math.PI) / W * p.horizontal;   // Δφ·sin高度角
    const angularHeight = (e.av * Math.PI) / H;                     // Δθ
    const err = Math.max(Math.abs(angularWidth - puff.radius), Math.abs(angularHeight - puff.radius));
    if (err > worstAngular) { worstAngular = err; worstCloud = puff.radius; }
  }
}
check(worstAngular < 1e-9, "画布椭圆的角宽 = 角高 = 视角半径（投回天球是圆的，不是画布上的圆）",
  `最大偏差 ${worstAngular.toExponential(2)} rad（视角半径量级 ${worstCloud?.toFixed(3)}）`);

// ---- 5. 覆盖率在"少云到多云"之间，且等于 Σπ r²/2π ----
const recomputed = layout.clouds.reduce((s, c) => s + c.solid, 0) / (2 * Math.PI);
check(near(recomputed, layout.coverage, 1e-12), "覆盖率与逐团重算一致",
  `${(layout.coverage * 100).toFixed(1)}%`);
check(layout.coverage >= 0.10 && layout.coverage <= 0.50, "云量落在少云到多云之间（不是晴空也不是阴天）",
  `${(layout.coverage * 100).toFixed(1)}%`);

// ---- 6. 向阳面亮、背阳面灰：云的亮度跟"和太阳的夹角"走 ----
const dotSun = (dir) => dir[0] * sunDir.x + dir[1] * sunDir.y + dir[2] * sunDir.z;
let shadeOk = true;
let shadeDetail = "";
for (const cloud of layout.clouds) {
  for (const puff of cloud.puffs) {
    const lit = 0.58 + 0.42 * Math.max(0, dotSun(puff.dir));
    const want = Math.round(255 * lit);
    if (Math.abs(puff.rgb[0] - want) > 1) { shadeOk = false; shadeDetail = `${puff.rgb[0]} vs ${want}`; }
    if (puff.rgb[0] < 145 || puff.rgb[2] > 255 || puff.rgb[2] < puff.rgb[0] - 1) { shadeOk = false; shadeOk = false; }
  }
}
const facing = layout.clouds.reduce((best, c) => (dotSun(c.dir) > dotSun(best.dir) ? c : best), layout.clouds[0]);
const away = layout.clouds.reduce((worst, c) => (dotSun(c.dir) < dotSun(worst.dir) ? c : worst), layout.clouds[0]);
check(shadeOk, "每团泡的亮度都按 cos(与太阳夹角) 算，且不会黑到脏（≥145/255）", shadeDetail);
check(facing.puffs[0].rgb[0] > away.puffs[0].rgb[0] + 20,
  "向阳那几团明显比背阳的亮（云的白是太阳打的，不是自发光）",
  `向阳 ${facing.puffs[0].rgb[0]} vs 背阳 ${away.puffs[0].rgb[0]}`);

// ---- 7. 挡日程度：有云压住太阳方向时 sunOpacity > 0，否则为 0 ----
check(layout.sunOpacity >= 0 && layout.sunOpacity <= 1, "挡日系数在 [0,1]",
  `sunOpacity=${layout.sunOpacity.toFixed(2)}`);
const blocked = layout.clouds.filter((c) => {
  const angle = Math.acos(Math.max(-1, Math.min(1, dotSun(c.dir))));
  return angle < c.radius * 1.4;
}).length;
check((blocked > 0) === (layout.sunOpacity > 0), "挡日系数与哪些云压住了太阳方向一致",
  `压住太阳的云 ${blocked} 团`);

// ---- 8. 画的时候不许出现 NaN/负数半径，且先裁到地平线以上 ----
const calls = [];
let stroke = { rect: 0, clipBeforeArc: false };
const stub = {
  save() {}, restore() {}, beginPath() {}, fill() {},
  translate(x, y) { if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("translate NaN"); },
  scale(x, y) { if (!Number.isFinite(x) || !Number.isFinite(y) || x === 0) throw new Error("scale bad"); calls.push(["scale", x]); },
  rotate(a) { if (!Number.isFinite(a)) throw new Error("rotate NaN"); },
  rect(x, y, w, h) { stroke.rect += 1; calls.push(["rect", x, y, w, h]); },
  clip() { calls.push(["clip"]); },
  arc(x, y, r) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(r > 0)) throw new Error(`arc bad ${x},${y},${r}`);
    if (stroke.rect > 0 && !calls.some((c) => c[0] === "clip")) stroke.clipBeforeArc = true;
    calls.push(["arc", x, y, r]);
  },
  createRadialGradient(x0, y0, r0, x1, y1, r1) {
    if (![x0, y0, r0, x1, y1, r1].every(Number.isFinite) || !(r1 > 0)) throw new Error("gradient bad");
    return { addColorStop() {} };
  },
  createLinearGradient() { return { addColorStop() {} }; },
  fillRect() {},
  set fillStyle(v) { if (typeof v === "string" && v.includes("NaN")) throw new Error(`fillStyle NaN: ${v}`); },
};
let painted = true;
let paintError = "";
try {
  paintSkyClouds(stub, layout, { width: W, height: H });
} catch (error) {
  painted = false;
  paintError = error.message;
}
check(painted, "paintSkyClouds 全程只产生有限数值（NaN 会被 canvas 静默丢掉，所以这里主动拦）", paintError);
check(stroke.rect === 1 && stroke.clipBeforeArc === false && calls.some((c) => c[0] === "clip"),
  "先裁到地平线以上再画云（云不能漏到地面的雾里）",
  `rect=${stroke.rect}, 画云时已有 clip=${calls.some((c) => c[0] === "clip")}`);
const arcCount = calls.filter((c) => c[0] === "arc").length;
check(arcCount > layout.clouds.length * 3, "每团云真的画了好几笔（不是只有一团一圆）", `弧 ${arcCount} 笔`);

// ---- 9. 天空配色表还在（别的模块/文档引用它） ----
check(typeof SKY_COLORS.zenith === "string" && typeof SKY_COLORS.horizon === "string", "SKY_COLORS 完整");

console.log(failures.length ? `\n没通过 ${failures.length} 项：\n- ${failures.join("\n- ")}` : "\n全部通过");
process.exit(failures.length ? 1 : 0);
