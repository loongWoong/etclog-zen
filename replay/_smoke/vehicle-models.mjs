/**
 * 车辆三维模型库：按日志里的车型码、真实轴数与长宽高参数化生成拟真车辆。
 *
 * 约定：
 *   +Z 为行驶方向（车头朝 +Z），+X 为车辆右侧，Y 向上，车轮落在 y=0。
 *   模型以自身中心为原点（与 app.js 里 vehicle().position.z 的用法一致）。
 *
 * 输入是 vehicle_info.py 抽出来的 spec：
 *   { kind, classLabel, axles, dims:{length,width,height,wheelbase}, plate,
 *     plateColorCode, plateColorLabel, bodyColorCode, bodyColorLabel, dangerous, special, ... }
 * 车身颜色：日志里没有可信的车身颜色（牌识厂商码 81% 未上报、无码表），
 * 因此 code 非 0 时按未验证码表着色并在界面上标注；否则按车型常见配色示意。
 */

import * as THREE from "./vendor/three/build/three.module.mjs";
import { linearToSrgb, sunDirection, sunShadowFrame, SUN_ANGULAR_RADIUS } from "./scene-look.mjs";

// ---------------------------------------------------------------------------
// 太阳方向（页面 setupSky 之后由 setSunDirection 写进来）
// ---------------------------------------------------------------------------

/**
 * 车辆接地阴影要跟太阳一致：影子朝背离太阳的一侧、影长 = cot(高度角) × 车高。
 * 页面在 `setupSky` 之后调用它；不调用时会退回默认太阳（`sunDirection()`），
 * 保证任何一页都不会出现"两拨影子方向不同"。
 */
let SUN_DIRECTION = null;
export function setSunDirection(direction) {
  SUN_DIRECTION = direction && direction.lengthSq() > 0 ? direction.clone().normalize() : null;
}

/**
 * 影子里的地面还剩多少光（线性乘数，逐通道）：由 `setupSky` 按场景自己的灯算出来。
 * 页面在 `setSunDirection` 之后紧接着调用它（必须在建车之前）。
 */
let SHADOW_TINT = new THREE.Color(0.12, 0.17, 0.25);      // 没有页面输入时的清空天空估算
export function setShadowTint(color) {
  if (!color) return;
  SHADOW_TINT = new THREE.Color(color.r, color.g, color.b);   // 已经是线性值
}


// ---------------------------------------------------------------------------
// 车牌颜色：部颁编码，已用本窗口 257 辆车交叉验证（货一蓝牌、货二/三黄牌、客一蓝/绿牌、大客黄牌）
// ---------------------------------------------------------------------------
export const PLATE_STYLE = {
  0: { label: "蓝色", bg: "#1f4fa8", fg: "#eef3ff" },
  1: { label: "黄色", bg: "#d8a318", fg: "#231a04" },
  2: { label: "黑色", bg: "#15171b", fg: "#f2f6fa" },
  3: { label: "白色", bg: "#e9eef4", fg: "#1b2026" },
  4: { label: "绿色", bg: "#2f9e5f", fg: "#f0fff6" },
  5: { label: "黄绿双拼", bg: "#c3cf45", fg: "#20242a" },
};
const PLATE_FALLBACK = { label: "未上报", bg: "#2b3138", fg: "#93a1b1" };

/** 牌识厂商车身色码 -> 颜色（未验证，仅用于把日志里的码值画出来）。 */
const BODY_HEX = {
  白色: "#eef1f4", 黑色: "#1a1d22", 红色: "#a92330", 银色: "#b9c0c8", 灰色: "#7d858e",
  蓝色: "#2c6fb5", 绿色: "#2f7d4f", 黄色: "#e0a71a", 棕色: "#6b4a33", 银灰: "#a7aeb6",
};

// 车型族 -> 常见车身配色（日志未给出车身颜色时使用，按车牌稳定选取）
const PALETTES = {
  car: ["#e8edf3", "#1a1d22", "#b9c0c8", "#2c3238", "#8d949c", "#1f4fa8", "#9c1f27", "#f2f4f7"],
  van: ["#e9edf2", "#2f3a46", "#c9ced6", "#1f4fa8", "#7b848d"],
  bus: ["#2f7d4f", "#e9edf2", "#d8a318", "#1f4fa8", "#b9422f"],
  coach: ["#e9edf2", "#1f4fa8", "#b9422f", "#2f7d4f", "#33383f"],
  truckCab: ["#e9edf2", "#1f4fa8", "#9c1f27", "#2c6fb5", "#c9ced6", "#3c4650"],
  cargoBox: ["#eef1f4", "#dfe4ea", "#cfd6dd", "#2f6f9e", "#c0562f"],
  trailer: ["#e6eaee", "#cdd4db", "#2f6f9e", "#9aa4ad"],
  special: ["#e0a71a", "#e8edf2", "#2f3a46", "#b9422f"],
};

const MATERIAL_CACHE = new Map();
const GEOMETRY_CACHE = new Map();
const TEXTURE_CACHE = new Map();

function paint(color) {
  const key = `paint:${color}`;
  if (!MATERIAL_CACHE.has(key)) {
    // 车漆：金属漆 + 清漆层（clearcoat），配合 scene-look 的环境贴图才有真车反光
    const material = new THREE.MeshPhysicalMaterial({
      color,
      roughness: 0.3,
      metalness: 0.35,
      clearcoat: 0.85,
      clearcoatRoughness: 0.12,
      envMapIntensity: 1.05,
    });
    material.userData.paint = true;
    MATERIAL_CACHE.set(key, material);
  }
  return MATERIAL_CACHE.get(key);
}

function material(key, options) {
  if (!MATERIAL_CACHE.has(key)) MATERIAL_CACHE.set(key, new THREE.MeshStandardMaterial(options));
  return MATERIAL_CACHE.get(key);
}

const GLASS = () => material("glass", {
  color: 0x0d1b26, roughness: 0.06, metalness: 0.42, transparent: true, opacity: 0.7, envMapIntensity: 1.8,
});
const CHROME = () => material("chrome", { color: 0xbcc6cf, roughness: 0.22, metalness: 0.92, envMapIntensity: 1.6 });
const DARK = () => material("dark", { color: 0x1b1f24, roughness: 0.68, metalness: 0.32 });
const TIRE = () => material("tire", { color: 0x121417, roughness: 0.95, metalness: 0.0 });
const RIM = () => material("rim", { color: 0xaeb7c1, roughness: 0.3, metalness: 0.85, envMapIntensity: 1.3 });
const HEADLIGHT = () => material("headlight", { color: 0xfff6dc, emissive: 0xffe9a8, emissiveIntensity: 0.85, roughness: 0.2 });
const TAILLIGHT = () => material("taillight", { color: 0x8c1b1b, emissive: 0xd8362c, emissiveIntensity: 0.75, roughness: 0.35 });
const REFLECT_RED = () => material("reflectRed", { color: 0xb3241f, emissive: 0x521010, emissiveIntensity: 0.25, roughness: 0.4 });
const REFLECT_WHITE = () => material("reflectWhite", { color: 0xe8edf2, emissive: 0x39424c, emissiveIntensity: 0.2, roughness: 0.4 });
const AMBER = () => material("amber", { color: 0xffa41f, emissive: 0xff8c00, emissiveIntensity: 0.9, roughness: 0.4 });

/** 刹车灯光晕贴图（加法混合 Sprite 用），全局一张。 */
function glowTexture() {
  if (!TEXTURE_CACHE.has("brakeGlow")) {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, "rgba(255,126,96,0.95)");
    gradient.addColorStop(0.35, "rgba(255,64,40,0.42)");
    gradient.addColorStop(1, "rgba(255,40,20,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    TEXTURE_CACHE.set("brakeGlow", texture);
  }
  return TEXTURE_CACHE.get("brakeGlow");
}

/**
 * 一辆车自己的一套刹车灯：尾灯材质 + 尾部两个光晕 Sprite。
 * 每辆车独立，所以踩下刹车时只有这一辆亮（尾灯材质不再全局共享）。
 */
function createBrakeLights() {
  const tail = new THREE.MeshStandardMaterial({
    color: 0x8c1b1b, emissive: 0xd8362c, emissiveIntensity: 0.32, roughness: 0.35,
  });
  tail.name = "brakeLight";
  const glows = [];
  const texture = glowTexture();
  return {
    tail,
    glows,
    add(group, x, y, z, width = 0.22, height = 0.16) {
      group.add(box(width, height, 0.08, tail, x, y, z));
      const material = new THREE.SpriteMaterial({
        map: texture, color: 0xff3a24, transparent: true, opacity: 0.08,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.position.set(x, y, z - 0.07);
      sprite.scale.setScalar(0.72);
      sprite.name = "brakeGlow";
      group.add(sprite);
      glows.push(sprite);
    },
    /** level: 0 = 只亮尾灯，1 = 刹车灯全亮（含光晕） */
    setLevel(level) {
      const amount = Math.max(0, Math.min(1, level));
      tail.emissiveIntensity = 0.32 + 1.75 * amount;
      tail.color.setHex(amount > 0.5 ? 0xbb2a20 : 0x8c1b1b);
      for (const sprite of glows) {
        sprite.material.opacity = 0.06 + 0.68 * amount;
        sprite.scale.setScalar(0.72 + 0.62 * amount);
      }
    },
    dispose() {
      tail.dispose();
      for (const sprite of glows) sprite.material.dispose();
    },
  };
}

/**
 * 刹车灯控制器：按「实际位移 / 时间」算速度与加速度。
 * 减速超过阈值时点亮；停住（等栏杆）后继续亮 stopHold 秒再熄灭（相当于松开刹车），
 * 快速点亮、缓慢熄灭，避免闪烁。
 */
export function createBrakeController({ threshold = 0.45, stopSpeed = 0.2, stopHold = 2.5 } = {}) {
  let speed = 0;
  let level = 0;
  let stillFor = 0;
  return {
    update(dt, distanceDelta) {
      const step = Math.max(dt, 1e-3);
      const next = distanceDelta / step;
      const accel = (next - speed) / step;
      speed = next;
      if (Math.abs(next) < stopSpeed) stillFor += step;
      else stillFor = 0;
      const wants = accel < -threshold || (stillFor > 0 && stillFor < stopHold);
      const target = wants ? 1 : 0;
      const rate = wants ? 14 : 3.4;
      const diff = target - level;
      level += Math.sign(diff) * Math.min(Math.abs(diff), rate * step);
      return level;
    },
    reset() {
      speed = 0;
      level = 0;
      stillFor = 0;
    },
    get level() {
      return level;
    },
  };
}

/**
 * 悬挂俯仰控制器：按「实际位移 / 时间」算速度与纵向加速度，驱动车头下沉（刹车）/抬起（加速）。
 * 真实乘用车 0.5g 制动大约俯仰 1.5~2.5°，这里 4 m/s² 满偏、上限 maxPitchDeg，快进慢出不留抖动。
 * 与刹车灯控制器用同一份位移输入（回放里就是每帧 z 位移），拖拽时间轴造成的突跳由调用方 reset。
 */
export function createSuspensionController({ maxPitchDeg = 2.2, fullAccel = 4.0, response = 5 } = {}) {
  const full = (maxPitchDeg * Math.PI) / 180;
  let speed = 0;
  let accel = 0;
  let pitch = 0;
  return {
    update(dt, distanceDelta) {
      const step = Math.max(dt, 1e-3);
      const next = distanceDelta / step;
      const raw = (next - speed) / step;
      speed = next;
      accel += (raw - accel) * Math.min(1, step * response);
      const want = Math.max(-1, Math.min(1, -accel / fullAccel)) * full;
      pitch += (want - pitch) * Math.min(1, step * 9);
      return pitch;
    },
    reset() {
      speed = 0;
      accel = 0;
      pitch = 0;
    },
    get pitch() {
      return pitch;
    },
    get accel() {
      return accel;
    },
    get speed() {
      return speed;
    },
  };
}

function hash(text) {  let value = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return Math.abs(value);
}

function pick(list, seed) {
  return list[seed % list.length];
}

function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const key = `box:${w.toFixed(3)}:${h.toFixed(3)}:${d.toFixed(3)}`;
  if (!GEOMETRY_CACHE.has(key)) GEOMETRY_CACHE.set(key, new THREE.BoxGeometry(w, h, d));
  const mesh = new THREE.Mesh(GEOMETRY_CACHE.get(key), mat);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  return mesh;
}

/** 由侧视轮廓挤出车身：profile 为 [z, y] 数组（z 正方向为车头），沿宽度方向挤出并倒角。 */
function extruded(profile, width, bevel = 0.05) {
  const shape = new THREE.Shape();
  shape.moveTo(profile[0][0], profile[0][1]);
  for (let i = 1; i < profile.length; i += 1) shape.lineTo(profile[i][0], profile[i][1]);
  shape.closePath();
  const key = `profile:${JSON.stringify(profile)}:${width}:${bevel}`;
  if (!GEOMETRY_CACHE.has(key)) {
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: width - bevel * 2,
      bevelEnabled: true,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: 2,
      curveSegments: 2,
      steps: 1,
    });
    geometry.rotateY(-Math.PI / 2);
    geometry.translate(width / 2, 0, 0);
    geometry.computeVertexNormals();
    GEOMETRY_CACHE.set(key, geometry);
  }
  return new THREE.Mesh(GEOMETRY_CACHE.get(key), paint("#ffffff"));
}

function wheel(radius, width, { dual = false } = {}) {
  const group = new THREE.Group();
  const offsets = dual ? [-width * 0.62, width * 0.62] : [0];
  for (const offset of offsets) {
    const tireKey = `wheel:${radius}:${width}`;
    if (!GEOMETRY_CACHE.has(tireKey)) {
      const geometry = new THREE.CylinderGeometry(radius, radius, width * 0.92, 18, 1);
      geometry.rotateZ(Math.PI / 2);
      GEOMETRY_CACHE.set(tireKey, geometry);
    }
    const tire = new THREE.Mesh(GEOMETRY_CACHE.get(tireKey), TIRE());
    tire.position.x = offset;
    tire.castShadow = true;
    group.add(tire);

    const rimKey = `rim:${radius}:${width}`;
    if (!GEOMETRY_CACHE.has(rimKey)) {
      const geometry = new THREE.CylinderGeometry(radius * 0.62, radius * 0.62, width * 0.95, 14, 1);
      geometry.rotateZ(Math.PI / 2);
      GEOMETRY_CACHE.set(rimKey, geometry);
    }
    const rim = new THREE.Mesh(GEOMETRY_CACHE.get(rimKey), RIM());
    rim.position.x = offset;
    group.add(rim);
  }
  return group;
}

function plateTexture(text, style) {
  const key = `plate:${text}:${style.bg}`;
  if (TEXTURE_CACHE.has(key)) return TEXTURE_CACHE.get(key);
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 160;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = style.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = 6;
  ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
  ctx.fillStyle = style.fg;
  ctx.font = "bold 92px 'Microsoft YaHei','PingFang SC',sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text || "未识别", canvas.width / 2, canvas.height / 2 + 4);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  TEXTURE_CACHE.set(key, texture);
  return texture;
}

/** 接地阴影（AO）贴图：径向衰减的暗斑，全局一张，用车身尺寸拉伸。 */
function contactTexture() {
  if (!TEXTURE_CACHE.has("contact")) {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext("2d");
    const gradient = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
    gradient.addColorStop(0, "rgba(8,10,14,0.78)");
    gradient.addColorStop(0.55, "rgba(8,10,14,0.42)");
    gradient.addColorStop(0.85, "rgba(8,10,14,0.12)");
    gradient.addColorStop(1, "rgba(8,10,14,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 128, 128);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    TEXTURE_CACHE.set("contact", texture);
  }
  return TEXTURE_CACHE.get("contact");
}

/**
 * 车辆接地阴影贴图（有太阳方向时用）：把**真实影子的形状**画进贴图，并且画的是
 * "影子里的地面还剩多少光"，而不是一块拍出来的深灰。
 *
 * 乘法混合：白 = 完全不变，色调 = 天光/(天光+直射太阳)（`setShadowTint` 由 `setupSky` 算好）。
 * 于是影子的**颜色**是天空的颜色（偏蓝），**深浅**是直射被挡掉多少 —— 和接地暗部同一套混合。
 *
 * 真影子 = 车身矩形沿影子方向平移 `sweep` 之后的扫掠（Minkowski 和）。太阳有视半径，
 * 所以整片是**均匀的影核**（地面在影子里看不见整个日面），只在边界外侧有一圈半影：
 * 宽度 `penumbra ≈ 2 × 太阳视半径 × 车高/sin高度角`（4m 高的车约 8cm）。
 * 没有画"从车底往影尖越来越淡"的渐变：那是美术处理，不是投影。
 *
 * 画布纵向 = 影子方向（v=0 在画布底边：贴图 flipY 之后 UV 的 v=0 对应画布底行），
 * 横向 = 垂直影子方向。所有几何先在**米**里算完，最后一步才换算到画布像素，
 * 这样"半影加宽"才是各向同性的（画布会被平面按不同比例拉伸）。
 */
function sweptShadowTexture(key, shape) {
  if (TEXTURE_CACHE.has(key)) return TEXTURE_CACHE.get(key);
  const { width, length, sweep, sinRel, cosRel, crossPlane, alongPlane, penumbra, tint } = shape;

  // 车身矩形在"影子方向 c / 垂直方向 p"里的四个角：c 从车身占地中心量起
  const corners = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = (sx * width) / 2;
      const z = (sz * length) / 2;
      corners.push([x * sinRel + z * cosRel, x * cosRel - z * sinRel]);
    }
  }
  // 扫掠 = 矩形 + 它沿 c 平移 sweep 的那一份，取 8 个点的凸包
  const points = corners.concat(corners.map(([c, p]) => [c + sweep, p]));
  const hull = convexHull(points);
  const cMin = Math.min(...hull.map(([c]) => c));
  const cMax = Math.max(...hull.map(([c]) => c));
  const pMin = Math.min(...hull.map(([, p]) => p));
  const pMax = Math.max(...hull.map(([, p]) => p));
  const centre = [(cMin + cMax) / 2, (pMin + pMax) / 2];
  const spanC = Math.max(0.2, cMax - cMin);
  const spanP = Math.max(0.2, pMax - pMin);

  const canvas = document.createElement("canvas");
  canvas.width = 256;
  // 画布比例跟着平面走，texel 密度才一致（半挂那片有 16m 长）
  canvas.height = Math.max(96, Math.min(512, Math.round((256 * alongPlane) / Math.max(1, crossPlane))));
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  const toPx = (c, p) => [((p + crossPlane / 2) / crossPlane) * W,
                          (1 - (c - sweep / 2 + alongPlane / 2) / alongPlane) * H];

  // 白底：乘法混合下"完全不变"。形状之外只可能是白，别的地方不压暗。
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  // 覆盖度 → 画布颜色：物理上是**线性**混合 `(1-k)·天光 + k·全影`，
  // 画布是 sRGB 的，所以按 sRGB 编码写进去（否则半影带会比物理值暗一截）。
  const coverageColor = (k) => {
    const parts = [tint.r, tint.g, tint.b].map((t) => t * k + (1 - k));
    return `rgb(${parts.map((v) => Math.round(linearToSrgb(v) * 255)).join(",")})`;
  };

  // 半影：在**米**里把多边形往外推几圈，一圈比一圈实（太阳视半径摊开的量）。
  // 两轴各自按"离中心的距离 + grow"换算缩放，这样长轴也是实打实外推 grow 米——
  // 用一个统一比例的话，18m 长的车长轴会一下撑出两米多的虚边（横向还很窄）。
  const draw = (grow, coverage) => {
    const sc = 1 + (grow * 2) / spanC;
    const sp = 1 + (grow * 2) / spanP;
    ctx.beginPath();
    hull.forEach(([c, p], i) => {
      const cc = centre[0] + (c - centre[0]) * sc;
      const pp = centre[1] + (p - centre[1]) * sp;
      const [x, y] = toPx(cc, pp);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = coverageColor(coverage);
    ctx.fill();
  };
  draw(penumbra, 0.25);
  draw(penumbra * 0.66, 0.5);
  draw(penumbra * 0.33, 0.75);
  draw(0, 1);

  const texture = new THREE.CanvasTexture(canvas);
  // 乘法贴图要的是"线性乘数"，画布按 sRGB 编的，所以标 sRGB 让 three 解回来（解出来正好是物理乘数）
  texture.colorSpace = THREE.SRGBColorSpace;
  // 这张图是**按哪一套几何**画出来的，一并记下：贴图按整数度缓存，转台一直在转，
  // 所以"当前这一帧的方案"与"图里那一版形状"可以差半度。自检要拿图自己的形状去对，
  // 不能拿当前帧的方案去对一个早先画好的图（那不是贴图错，是刻舟求剑）。
  texture.userData = {
    shape: {
      width, length, sweep, sinRel, cosRel, crossPlane, alongPlane, penumbra,
      tint: [tint.r, tint.g, tint.b],
    },
  };
  TEXTURE_CACHE.set(key, texture);
  return texture;
}

/** 单调链凸包：扫掠形状的点只有 8 个，够用且没有依赖。 */
function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = (list) => {
    const out = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    return out;
  };
  const lower = build(pts);
  const upper = build(pts.slice().reverse());
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/**
 * 按当前太阳与车体实际朝向摆好这片阴影。
 *
 * 为什么每帧都要重算：车头一旦转（展台转台一直在转、以后车道若要按方向掉头），
 * 挂在车体下的这片平面会跟着转，而**太阳不会跟着转**。所以要在局部坐标系里把转角反向补回来，
 * 保证影子的世界朝向始终是"背离太阳"。
 */
function orientShadow(mesh, dims, anchor) {
  const frame = sunShadowFrame(SUN_DIRECTION || sunDirection());
  if (!frame) return;
  const parent = mesh.parent;
  let yaw = 0;
  if (parent) {
    parent.updateWorldMatrix(true, false);
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(parent.getWorldQuaternion(new THREE.Quaternion()));
    yaw = Math.atan2(forward.x, forward.z);          // 车头在世界里的方位角
  }
  const rel = Math.atan2(frame.x, frame.z) - yaw;
  const dirX = Math.sin(rel);                      // 注意：这是**车体局部**坐标系里的影子方向
  const dirZ = Math.cos(rel);
  const height = Math.max(0.4, dims.height);
  const sweep = frame.cot * height;                                   // 车顶在地面上的位移
  const proj = Math.abs(dims.width * dirX) + Math.abs(dims.length * dirZ);   // 车身在影子方向上的跨度
  const cross = Math.abs(dims.width * dirZ) + Math.abs(dims.length * dirX);  // 垂直方向的跨度
  const along = proj + sweep;
  // 太阳视半径摊到地面上的半影宽度：`2 × 视半径 × (车高 / sin高度角)`，再加上一点点
  // 车身圆角/贴图分辨率带来的软边（0.04m）。4.05m 的半挂 ≈ 8cm，1.5m 的轿车 ≈ 5.6cm。
  const sinElev = 1 / Math.sqrt(1 + frame.cot * frame.cot);
  const penumbra = THREE.MathUtils.clamp(0.04 + (2 * SUN_ANGULAR_RADIUS * height) / Math.max(0.2, sinElev), 0.05, 0.14);
  const crossPlane = cross + penumbra * 2;
  const alongPlane = along + penumbra * 2;
  // 平面局部 +Y 要指向影子方向：rotation.x=-90° 之后局部 +Y 落到 -Z，再转 z 角即可对齐
  mesh.rotation.set(-Math.PI / 2, 0, Math.atan2(-dirX, -dirZ));
  mesh.scale.set(crossPlane, alongPlane, 1);
  // 贴图按这辆车的真实扫掠形状生成（缓存键带上尺寸/相对角/影长/影色，同款车只画一次）
  const shape = {
    width: dims.width, length: dims.length, sweep, sinRel: Math.sin(rel), cosRel: Math.cos(rel),
    crossPlane, alongPlane, penumbra, tint: SHADOW_TINT,
  };
  const tintKey = `${SHADOW_TINT.r.toFixed(3)},${SHADOW_TINT.g.toFixed(3)},${SHADOW_TINT.b.toFixed(3)}`;
  const texKey = `swept:${dims.width.toFixed(2)}:${dims.length.toFixed(2)}:${Math.round(THREE.MathUtils.radToDeg(rel))}:${frame.cot.toFixed(3)}:${tintKey}`;
  if (mesh.userData.shadowTexKey !== texKey) {
    mesh.material.map = sweptShadowTexture(texKey, shape);
    mesh.material.needsUpdate = true;
    mesh.userData.shadowTexKey = texKey;
  }
  // 整片沿影子方向平移 sweep/2：近端贴着车身背光边，远端正好是车顶影子。
  // 平移量必须用**局部**方向：这片是车体的子节点，车头一转，世界方向就跟着转了。
  // anchor 是车身实际占地中心（挂在车体组原点上的东西，几何中心未必在那里：
  // 半挂的车体大多长在 +Z 一侧，直接用原点当基准，影子会整片挪到车厢外面去）。
  mesh.position.set((anchor ? anchor.x : 0) + (dirX * sweep) / 2, 0.011, (anchor ? anchor.z : 0) + (dirZ * sweep) / 2);
  // 自检要核对：影子朝哪、影长是不是 cot×车高
  mesh.userData.shadowPlan = {
    cot: Math.round(frame.cot * 1000) / 1000,
    height: Math.round(height * 100) / 100,
    sweep: Math.round(sweep * 100) / 100,
    proj: Math.round(proj * 100) / 100,
    cross: Math.round(cross * 100) / 100,
    along: Math.round(along * 100) / 100,
    crossPlane: Math.round(crossPlane * 100) / 100,
    alongPlane: Math.round(alongPlane * 100) / 100,
    penumbra: Math.round(penumbra * 1000) / 1000,
    tint: [Math.round(SHADOW_TINT.r * 1000) / 1000, Math.round(SHADOW_TINT.g * 1000) / 1000,
           Math.round(SHADOW_TINT.b * 1000) / 1000],
    width: Math.round(dims.width * 100) / 100,
    length: Math.round(dims.length * 100) / 100,
    // 真影子面积 = 车身矩形 + 沿影子方向扫出去的一条（宽度取垂直方向跨度）
    areaTrue: Math.round((dims.width * dims.length + sweep * cross) * 100) / 100,
    areaRect: Math.round(along * cross * 100) / 100,
    shadowDir: [Math.round(frame.x * 1000) / 1000, Math.round(frame.z * 1000) / 1000],
    // 平移量的世界方向（把局部平移按车头转角转回去）：应当与 shadowDir 同向
    offsetWorldDir: [Math.round(Math.sin(rel + yaw) * 1000) / 1000, Math.round(Math.cos(rel + yaw) * 1000) / 1000],
    anchor: [Math.round((anchor ? anchor.x : 0) * 100) / 100, Math.round((anchor ? anchor.z : 0) * 100) / 100],
    relDeg: Math.round(THREE.MathUtils.radToDeg(rel) * 10) / 10,
    yawDeg: Math.round(THREE.MathUtils.radToDeg(yaw) * 10) / 10,
  };
  return mesh.userData.shadowPlan;
}

/**
 * 接地阴影：贴地一片暗斑，保证车"踩在地上"而不是悬空（没有 GPU 的机器上太阳阴影是关掉的）。
 *
 * 有太阳方向时按真实投影铺开：真扫掠形状 + 由场景自己的灯算出来的天光/直射比例，
 * 用**乘法混合**盖在路面上（白=不变，影色=影子里剩下的天光）。于是影子的深浅与冷暖
 * 都来自这套光照，而不是手调一个深灰——半挂会拖出比轿车长得多的一条影子。
 */
function createContactShadow(dims, anchor) {
  const frame = sunShadowFrame(SUN_DIRECTION || sunDirection());
  if (!frame) {
    // 太阳正顶（没有水平分量）：退回一片对称暗斑，至少让车不悬空
    const material = new THREE.MeshBasicMaterial({
      map: contactTexture(), color: 0x14171c, transparent: true, opacity: 0.62, depthWrite: false,
    });
    const key = "contactPlane";
    if (!GEOMETRY_CACHE.has(key)) GEOMETRY_CACHE.set(key, new THREE.PlaneGeometry(1, 1));
    const mesh = new THREE.Mesh(GEOMETRY_CACHE.get(key), material);
    mesh.name = "contactShadow";
    mesh.rotation.x = -Math.PI / 2;
    mesh.scale.set(Math.max(1.3, dims.width * 1.5), Math.max(2, dims.length * 1.08), 1);
    mesh.position.set(anchor ? anchor.x : 0, 0.011, anchor ? anchor.z : 0);
    mesh.renderOrder = 1;
    mesh.userData.noShadow = true;
    return mesh;
  }

  // 乘法混合：片元颜色直接当"乘数"。所以
  //   · 底色必须是白（白=完全不变），形状与半影都画在贴图里；
  //   · toneMapped:false —— 否则 multiplier 自己先过一次 ACES，乘到地面上就不是物理比例了；
  //   · fog:false —— 雾会把片元往雾色混，乘法片一旦被雾改色就整片变成"无差别压暗"。
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    blending: THREE.MultiplyBlending,
    transparent: true,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  const key = "contactPlane";
  if (!GEOMETRY_CACHE.has(key)) GEOMETRY_CACHE.set(key, new THREE.PlaneGeometry(1, 1));
  const mesh = new THREE.Mesh(GEOMETRY_CACHE.get(key), material);
  mesh.name = "contactShadow";
  mesh.renderOrder = 1;
  mesh.userData.noShadow = true;
  orientShadow(mesh, dims, anchor);               // 建好就先摆一次（此时父级可能还没进场景，yaw 按 0 算）
  // 车头一转（展台转台一直在转）就跟着修正，不需要页面配合。
  // onBeforeRender 在 updateMatrixWorld 之后、上传 uniform 之前跑，所以这里顺手把矩阵也刷新掉，
  // 否则这一帧用的还是上一帧的朝向（转台上会看到影子比车身慢半拍）。
  mesh.onBeforeRender = () => {
    orientShadow(mesh, dims, anchor);
    mesh.updateMatrix();
    if (mesh.parent) mesh.matrixWorld.multiplyMatrices(mesh.parent.matrixWorld, mesh.matrix);
  };
  return mesh;
}

function plate(text, colorCode, width = 0.44, height = 0.15) {
  const style = PLATE_STYLE[colorCode] || PLATE_FALLBACK;
  const material = new THREE.MeshStandardMaterial({
    map: plateTexture(text, style), roughness: 0.55, metalness: 0.05, emissive: 0x0a0c10, emissiveIntensity: 0.35,
  });
  const key = `plate:${width}:${height}`;
  if (!GEOMETRY_CACHE.has(key)) GEOMETRY_CACHE.set(key, new THREE.PlaneGeometry(width, height));
  return new THREE.Mesh(GEOMETRY_CACHE.get(key), material);
}

function mirror(size = 1) {
  const group = new THREE.Group();
  group.add(box(0.06 * size, 0.34 * size, 0.18 * size, DARK(), 0, 0, 0));
  const arm = box(0.26 * size, 0.05 * size, 0.05 * size, DARK(), -0.16 * size, 0.06 * size, 0);
  group.add(arm);
  return group;
}

function mudflap(width) {
  return box(width, 0.34, 0.04, DARK(), 0, 0.17, 0);
}

/** 反光条：货车侧面必备的贴条，红白相间。 */
function reflectStrip(length, y, z, x, mat) {
  return box(0.03, 0.1, length, mat, x, y, z);
}

/**
 * 轴位排布：返回各轴在车辆坐标系里的 z（+z 为车头方向）。
 * 导出是为了让「拦截/超时车辆清单」里的车型图与三维模型用同一套轴位 —— 图上车轮几个、
 * 排在哪儿，必须和场景里那辆车完全一致，否则同一辆车在图里和图外对不上。
 */
export function axleLayout(kind, dims, axles, wheelbase) {
  const half = dims.length / 2;
  const usable = wheelbase && wheelbase > 2 ? wheelbase : dims.length * (kind.startsWith("semi") ? 0.62 : 0.58);
  const front = Math.min(half - 0.85, usable / 2);
  const rear = -front;
  const spread = (count, from, step) => Array.from({ length: count }, (_, i) => from - i * step);
  switch (kind) {
    case "car":
      return [front, rear];
    case "van":
    case "bus":
    case "coach":
      return [half - 1.1, rear];
    case "lightTruck":
    case "mediumTruck":
      return [half - 1.35, -half + 1.25];
    case "rigid3":
      return [half - 1.35, ...spread(2, -half + 2.2, 1.35)];
    case "rigid4":
      return [half - 1.15, half - 2.35, ...spread(2, -half + 2.2, 1.35)];
    case "semi5":
      return [half - 1.3, half - 3.0, ...spread(3, -half + 0.9, 1.35)];
    case "semi6":
      return [half - 1.25, half - 2.6, half - 3.9, ...spread(3, -half + 0.9, 1.35)];
    case "special":
      return axles >= 4
        ? [half - 1.2, half - 2.4, ...spread(axles - 2, -half + 2.0, 1.35)]
        : [half - 1.3, ...spread(axles - 1, -half + 1.6, 1.4)];
    default:
      return [front, rear];
  }
}

function addTailDetails(group, dims, rearZ, y = 0.85, lights = null) {
  for (const side of [-1, 1]) {
    const x = side * (dims.width / 2 - 0.22);
    if (lights) lights.add(group, x, y, rearZ);
    else group.add(box(0.22, 0.16, 0.08, TAILLIGHT(), x, y, rearZ));
  }
}

/**
 * 装一根轴：返回的 axle 组原点就在车轮中心线上，绕 X 旋转即为车轮滚动。
 * @param {THREE.Group} group 车辆组
 * @param {number} z 轴在车辆坐标系里的 z
 * @param {boolean} dual 后轴双胎
 * @param {THREE.Group[]=} collector 收集轴组，供播放时驱动转动
 */
function addAxle(group, z, dims, radius, width, dual, collector) {
  const axle = new THREE.Group();
  axle.name = `axle@${z.toFixed(2)}`;
  axle.position.set(0, radius, z);
  axle.userData.radius = radius;
  const wheelGroup = wheel(radius, width, { dual });
  const left = wheelGroup.clone();
  left.position.set(-dims.width / 2 + width * (dual ? 0.72 : 0.42), 0, 0);
  const right = wheelGroup.clone();
  right.position.set(dims.width / 2 - width * (dual ? 0.72 : 0.42), 0, 0);
  axle.add(left, right);
  group.add(axle);
  for (const side of [-1, 1]) {
    const flap = mudflap(width * (dual ? 1.7 : 1.1));
    flap.position.set(side * (dims.width / 2 - width * 0.5), 0.2, z - radius - 0.25);
    group.add(flap);
  }
  if (collector) collector.push(axle);
  return axle;
}

function buildWheels(group, kind, dims, axles, wheelbase, radius, width, collector) {
  const layout = axleLayout(kind, dims, axles, wheelbase);
  const heavy = kind.startsWith("semi") || kind === "rigid3" || kind === "rigid4" || kind === "mediumTruck";
  layout.forEach((z, index) => {
    addAxle(group, z, dims, radius, width, heavy ? index > 0 : false, collector);
  });
  return layout;
}

function addChassis(group, dims, kind) {
  const y = 0.62;
  for (const x of [-0.42, 0.42]) {
    group.add(box(0.14, 0.2, dims.length * 0.78, DARK(), x, y, 0));
  }
  if (kind.startsWith("semi") || kind.startsWith("rigid") || kind === "mediumTruck") {
    group.add(box(0.34, 0.34, 0.7, CHROME(), -0.5, 0.55, 0.4));   // 油箱
    group.add(box(0.28, 0.28, 0.6, CHROME(), 0.52, 0.58, -0.6));  // 储气筒
  }
}

/** 平头货车驾驶室（含前脸、风挡、后视镜、前照灯、车牌）。 */
function truckCab(width, height, length, color, plateMesh) {
  const cab = new THREE.Group();
  const profile = [
    [-length * 0.5, 0.55],
    [-length * 0.5, height - 0.15],
    [length * 0.22, height],
    [length * 0.5, height - 0.55],
    [length * 0.5, 0.5],
  ];
  const shell = extruded(profile, width, 0.05);
  shell.material = paint(color);
  cab.add(shell);
  const glass = box(width * 0.9, height * 0.42, 0.06, GLASS(), 0, height * 0.62, length * 0.3);
  glass.rotation.x = -0.34;
  cab.add(glass);
  for (const side of [-1, 1]) {
    const window = box(0.05, height * 0.34, length * 0.42, GLASS(), side * (width / 2 + 0.01), height * 0.66, -length * 0.05);
    cab.add(window);
    const arm = mirror(1.35);
    arm.position.set(side * (width / 2 + 0.24), height * 0.78, length * 0.34);
    if (side < 0) arm.scale.x = -1;
    cab.add(arm);
    cab.add(box(0.3, 0.12, 0.08, HEADLIGHT(), side * (width / 2 - 0.34), 0.82, length * 0.5));
  }
  cab.add(box(width * 0.72, 0.16, 0.1, DARK(), 0, 0.72, length * 0.5));  // 进气格栅
  cab.add(box(width * 0.92, 0.2, 0.12, DARK(), 0, 0.42, length * 0.5));  // 保险杠
  if (plateMesh) {
    plateMesh.position.set(0, 0.52, length * 0.56);
    plateMesh.rotation.y = 0;
    cab.add(plateMesh);
  }
  const obu = box(0.12, 0.06, 0.09, DARK(), 0, height * 0.72, length * 0.22);
  obu.name = "obuUnit";
  cab.add(obu);
  return cab;
}

function buildCargoBox(width, height, length, color, shiny = false) {
  const group = new THREE.Group();
  const shell = box(width, height, length, paint(color));
  shell.position.y = height / 2;
  group.add(shell);
  if (shiny) {
    for (let z = -length / 2 + 0.35; z < length / 2; z += 0.7) {
      group.add(box(width * 1.005, height * 0.92, 0.06, paint(color), 0, height / 2, z));
    }
  }
  return group;
}

function addReflectors(group, dims, y, length, z) {
  for (const side of [-1, 1]) {
    group.add(reflectStrip(length, y, z, side * (dims.width / 2 + 0.02), REFLECT_RED()));
    group.add(reflectStrip(length, y - 0.16, z, side * (dims.width / 2 + 0.02), REFLECT_WHITE()));
  }
}

function addBeacons(group, dims, y) {
  for (const x of [-dims.width * 0.3, dims.width * 0.3]) {
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), AMBER());
    beacon.position.set(x, y, dims.length * 0.3);
    group.add(beacon);
  }
}

function addDangerPlacard(group, dims) {
  const placard = box(0.52, 0.42, 0.03, material("danger", {
    color: 0xff7a1a, emissive: 0x7a3300, emissiveIntensity: 0.5, roughness: 0.5,
  }), 0, 1.1, -dims.length / 2 - 0.03);
  group.add(placard);
}

// ---------------------------------------------------------------------------
// 各族车身
// ---------------------------------------------------------------------------

function buildPassenger(spec, colors, plateFront, plateRear, wheels = [], lights = null) {
  const { length: L, width: W, height: H } = spec.dims;
  const group = new THREE.Group();
  const seed = hash(spec.plate || spec.classLabel || "x");
  const wheelRadius = spec.kind === "car" ? Math.min(0.34, H * 0.22) : 0.42;

  if (spec.kind === "car") {
    const profile = [
      [-L / 2, 0.3], [-L / 2, 0.74], [-L * 0.34, H * 0.56], [-L * 0.2, H * 0.98],
      [L * 0.06, H], [L * 0.3, H * 0.92], [L * 0.38, H * 0.6], [L / 2 - 0.05, 0.72], [L / 2, 0.3],
    ];
    const body = extruded(profile, W, 0.07);
    body.material = paint(colors.body);
    group.add(body);
    const glassBand = box(W * 0.94, H * 0.34, L * 0.46, GLASS(), 0, H * 0.72, -L * 0.09);
    group.add(glassBand);
    group.add(box(W * 0.8, 0.08, L * 0.42, paint(colors.roofColor), 0, H + 0.02, -L * 0.06));
  } else if (spec.kind === "van") {
    const profile = [
      [-L / 2, 0.36], [-L / 2, H * 0.94], [L * 0.3, H], [L * 0.42, H * 0.72], [L / 2, H * 0.42], [L / 2, 0.36],
    ];
    const body = extruded(profile, W, 0.06);
    body.material = paint(colors.body);
    group.add(body);
    group.add(box(W * 0.96, H * 0.32, L * 0.62, GLASS(), 0, H * 0.72, -L * 0.12));
  } else {
    const coach = spec.kind === "coach";
    const profile = coach
      ? [[-L / 2, 0.42], [-L / 2, H * 0.96], [L * 0.36, H], [L / 2, H * 0.7], [L / 2, 0.42]]
      : [[-L / 2, 0.4], [-L / 2, H * 0.94], [L * 0.4, H], [L / 2, H * 0.6], [L / 2, 0.4]];
    const body = extruded(profile, W, 0.08);
    body.material = paint(colors.body);
    group.add(body);
    // 侧窗带 + 前风挡
    group.add(box(W * 1.005, H * 0.3, L * 0.72, GLASS(), 0, H * 0.72, -L * 0.06));
    const windshield = box(W * 0.92, H * 0.36, 0.08, GLASS(), 0, H * 0.7, L * 0.44);
    windshield.rotation.x = -0.16;
    group.add(windshield);
    group.add(box(W * 0.7, 0.34, L * 0.3, paint(colors.roofColor), 0, H + 0.14, 0));  // 顶置空调
    group.add(box(W * 0.86, 0.5, 0.08, paint("#0d1116"), 0, H * 0.56, L / 2 + 0.02));  // 路牌
  }

  for (const side of [-1, 1]) {
    group.add(box(0.06, 0.1, 0.3, HEADLIGHT(), side * (W / 2 - 0.28), H * 0.42, L / 2 - 0.02));
    const arm = mirror(spec.kind === "car" ? 0.85 : 1.3);
    arm.position.set(side * (W / 2 + (spec.kind === "car" ? 0.16 : 0.26)), H * 0.66, spec.kind === "car" ? L * 0.16 : L * 0.36);
    if (side < 0) arm.scale.x = -1;
    group.add(arm);
  }
  group.add(box(W * 0.9, 0.16, 0.12, DARK(), 0, 0.42, L / 2 - 0.04));
  addTailDetails(group, { width: W }, -L / 2 - 0.02, 0.85, lights);

  const obu = box(0.12, 0.06, 0.09, DARK(), 0, H * 0.86, L * 0.16);
  obu.name = "obuUnit";
  group.add(obu);

  if (plateRear) {
    plateRear.position.set(0, 0.5, -L / 2 - 0.05);
    plateRear.rotation.y = Math.PI;
    group.add(plateRear);
  }
  if (plateFront) {
    plateFront.position.set(0, 0.44, L / 2 + 0.03);
    group.add(plateFront);
  }
  buildWheels(group, spec.kind, spec.dims, spec.axles, spec.dims.wheelbase, wheelRadius, 0.24, wheels);
  return group;
}

function buildTruck(spec, colors, plateFront, plateRear, wheels = [], lights = null) {
  const { length: L, width: W, height: H } = spec.dims;
  const group = new THREE.Group();
  const cabLength = Math.min(2.3, Math.max(1.6, L * 0.2));
  const cabHeight = Math.min(H * 0.94, spec.kind.startsWith("semi") ? 3.0 : 2.75);
  const wheelRadius = Math.min(0.56, Math.max(0.42, H * 0.2));
  const cargoColor = colors.cargo;
  if (!spec.payload) {
    spec.payload = spec.kind.startsWith("semi")
      ? pick(["container", "box"], hash(spec.plate || "semi"))
      : spec.kind === "lightTruck" || spec.kind === "mediumTruck"
        ? pick(["box", "stake"], hash(spec.plate || "truck"))
        : pick(["box", "stake", "container"], hash(spec.plate || "truck"));
  }
  const cargoKind = spec.payload;

  if (spec.kind.startsWith("semi")) {
    const tractorLength = Math.min(6.6, L * 0.36);
    const tractor = new THREE.Group();
    const cab = truckCab(W, cabHeight, cabLength, colors.body, plateFront);
    cab.position.set(0, 0, tractorLength / 2 - cabLength / 2);
    tractor.add(cab);
    tractor.add(box(W * 0.9, 0.5, 0.7, DARK(), 0, 0.95, -tractorLength / 2 + cabLength * 0.9));
    addChassis(tractor, { length: tractorLength, width: W }, "mediumTruck");
    tractor.add(box(W * 0.55, 0.16, 0.5, CHROME(), 0, 1.28, tractorLength / 2 - cabLength - 0.9));  // 鞍座
    group.add(tractor);

    const trailerLength = L - tractorLength - 0.5;
    const trailer = new THREE.Group();
    trailer.position.z = -tractorLength / 2 - 0.25 - trailerLength / 2;
    const boxHeight = Math.max(2.4, H - 1.05);
    const container = buildCargoBox(W, boxHeight, trailerLength, cargoColor, cargoKind === "container");
    container.position.y = 1.05;
    trailer.add(container);
    trailer.add(box(W * 0.96, 0.16, 0.12, REFLECT_WHITE(), 0, 0.75, trailerLength / 2 + 0.02));
    addReflectors(trailer, { width: W }, 1.35, trailerLength * 0.9, 0);
    trailer.add(box(W, 0.12, 0.4, DARK(), 0, 0.45, -trailerLength / 2 - 0.2));  // 后防撞
    group.add(trailer);

    // 轴位必须按牵引车 / 挂车各自的长度算，用整车长度算会把转向轴甩到车头之外
    const tractorAxles = spec.kind === "semi6"
      ? [tractorLength / 2 - 1.25, -tractorLength / 2 + 0.85, -tractorLength / 2 + 2.2]
      : [tractorLength / 2 - 1.3, -tractorLength / 2 + 1.05];
    tractorAxles.forEach((z, index) => addAxle(group, z, spec.dims, wheelRadius, 0.3, index > 0, wheels));
    const trailerAxleCount = Math.max(1, spec.axles - tractorAxles.length);
    for (let index = 0; index < trailerAxleCount; index += 1) {
      addAxle(group, trailer.position.z - trailerLength / 2 + 0.95 + index * 1.35, spec.dims, wheelRadius, 0.3, true, wheels);
    }
    if (plateRear) {
      plateRear.position.set(0, 0.6, -L / 2 - 0.22);
      plateRear.rotation.y = Math.PI;
      group.add(plateRear);
    }
    addTailDetails(group, { width: W }, -L / 2 - 0.05, 0.95, lights);
    if (spec.dangerous) addDangerPlacard(group, spec.dims);
    return group;
  }

  // 单车（货一 ~ 货四）
  const cab = truckCab(W, cabHeight, cabLength, colors.body, plateFront);
  cab.position.set(0, 0, L / 2 - cabLength / 2);
  group.add(cab);
  addChassis(group, { length: L, width: W }, spec.kind);

  const cargoLength = L - cabLength - 0.55;
  const cargoHeight = Math.max(1.5, H - 1.0);
  const cargo = new THREE.Group();
  cargo.position.set(0, 1.0, -L / 2 + cargoLength / 2);
  if (cargoKind === "box" || cargoKind === "container") {
    const shell = buildCargoBox(W, cargoHeight, cargoLength, cargoColor, cargoKind === "container");
    cargo.add(shell);
  } else {
    // 栏板车：底板 + 三面低栏板
    cargo.add(box(W, 0.12, cargoLength, paint(cargoColor), 0, 0.06, 0));
    for (const side of [-1, 1]) cargo.add(box(0.08, 0.62, cargoLength, paint(cargoColor), side * (W / 2 - 0.04), 0.4, 0));
    cargo.add(box(W, 0.62, 0.08, paint(cargoColor), 0, 0.4, -cargoLength / 2 + 0.04));
  }
  group.add(cargo);
  addReflectors(group, { width: W }, 1.3, cargoLength * 0.9, -L / 2 + cargoLength / 2);
  if (plateRear) {
    plateRear.position.set(0, 0.72, -L / 2 - 0.16);
    plateRear.rotation.y = Math.PI;
    group.add(plateRear);
  }
  if (spec.dangerous) addDangerPlacard(group, { length: L, width: W });
  buildTruckDetailLighting(group, { width: W }, -L / 2, 1.0, lights);
  buildWheels(group, spec.kind, spec.dims, spec.axles, spec.dims.wheelbase, wheelRadius, 0.28, wheels);
  return group;
}

function buildTruckDetailLighting(group, dims, rearZ, y, lights = null) {
  for (const side of [-1, 1]) {
    const x = side * (dims.width / 2 - 0.24);
    if (lights) lights.add(group, x, y, rearZ - 0.12, 0.6, 0.5);
    else group.add(box(0.22, 0.5, 0.1, TAILLIGHT(), x, y, rearZ - 0.12));
  }
}

function buildSpecial(spec, colors, plateFront, plateRear, wheels = [], lights = null) {
  // 专项作业车按真实轴数选底盘：2 轴 → 单车底盘，5/6 轴 → 半挂底盘
  const baseKind = spec.axles <= 2 ? "mediumTruck" : spec.axles === 3 ? "rigid3" : spec.axles === 4 ? "rigid4" : "semi6";
  const group = buildTruck({ ...spec, kind: baseKind, payload: "box" }, colors, plateFront, plateRear, wheels, lights);
  addBeacons(group, spec.dims, Math.max(1.6, spec.dims.height * 0.96));
  for (const z of [-spec.dims.length * 0.2, spec.dims.length * 0.25]) {
    group.add(box(0.16, 0.5, 0.16, DARK(), -spec.dims.width / 2 - 0.1, 0.35, z));
    group.add(box(0.16, 0.5, 0.16, DARK(), spec.dims.width / 2 + 0.1, 0.35, z));
  }
  return group;
}

/**
 * 构建一辆车。
 * @returns {{group: THREE.Group, body: THREE.Object3D|null, marker: THREE.Mesh, spec: object,
 *            bodyColor: string, bodyColorSource: string, wheels: THREE.Group[], wheelRadius: number,
 *            spin: (distance: number) => void, setBrake: (level: number) => void, dispose: () => void}}
 */
export function buildVehicleModel(spec, options = {}) {
  const detail = options.detail !== false;
  const safe = {
    kind: "car",
    axles: 2,
    plate: "",
    plateColorCode: null,
    dangerous: false,
    special: false,
    ...spec,
    dims: {
      length: 4.7, width: 1.85, height: 1.5, wheelbase: null,
      ...(spec && spec.dims ? spec.dims : {}),
    },
  };
  const seed = hash(safe.plate || `${safe.classLabel || ""}${safe.kind}${safe.axles}`);

  const isTruck = /Truck|rigid|semi|special/.test(safe.kind);
  const palette = PALETTES[safe.kind.startsWith("semi") ? "truckCab" : safe.kind] || PALETTES.car;
  let bodyColor = pick(palette, seed);
  let bodyColorSource = "按车型常见配色示意";
  if (safe.bodyColorLabel) {
    bodyColor = BODY_HEX[safe.bodyColorLabel] || bodyColor;
    bodyColorSource = `牌识车身色码 ${safe.bodyColorCode}（厂商码表未验证）`;
  }
  if (options.bodyColor) {
    bodyColor = options.bodyColor;
    bodyColorSource = options.bodyColorSource || "手动指定";
  }
  const colors = {
    body: bodyColor,
    cargo: pick(PALETTES[safe.kind.startsWith("semi") ? "trailer" : "cargoBox"], seed >> 3),
    roofColor: bodyColor,
  };

  const group = new THREE.Group();
  group.name = "vehicle";
  const plateStyle = safe.plateColorCode;
  const plateFront = detail ? plate(safe.plate, plateStyle) : null;
  const plateRear = detail ? plate(safe.plate, plateStyle) : null;

  const wheels = [];
  const lights = createBrakeLights();
  const built = safe.kind === "special"
    ? buildSpecial(safe, colors, plateFront, plateRear, wheels, lights)
    : isTruck
      ? buildTruck(safe, colors, plateFront, plateRear, wheels, lights)
      : buildPassenger(safe, colors, plateFront, plateRear, wheels, lights);
  group.add(built);

  // 接地阴影：太阳阴影被关掉（软件渲染）时也能看出车在地面上，且方向/长度跟着太阳走。
  // 基准用**车体实际占地中心**：车体组原点常在车头/挂车一端，半挂会因此把影子整片挪到车厢外。
  const bodyBox = new THREE.Box3().setFromObject(built);
  group.updateWorldMatrix(true, false);
  bodyBox.applyMatrix4(group.matrixWorld.clone().invert());       // 换算回车体局部的占地范围
  const anchor = { x: (bodyBox.min.x + bodyBox.max.x) / 2, z: (bodyBox.min.z + bodyBox.max.z) / 2 };
  if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.z)) { anchor.x = 0; anchor.z = 0; }   // 空车体：退回原点
  const contactShadow = createContactShadow(safe.dims, anchor);
  group.add(contactShadow);

  // 悬挂俯仰的支点：**轴距中心**那条贴地线 —— 真实车是车身绕车轮中心转，加/减速时车头下沉或抬起。
  // 车轮从枢轴里挪到 group 下（轴组局部坐标不用改：枢轴 +anchor、built 又 −anchor，正好抵消），
  // 所以轮胎接地点一点不差；接地阴影与结果标记本来就在枢轴外，同样不跟着歪。
  const axleZs = wheels.map((axle) => axle.position.z).filter((z) => Number.isFinite(z));
  const pivotZ = axleZs.length ? (Math.min(...axleZs) + Math.max(...axleZs)) / 2 : anchor.z;
  const halfSpread = axleZs.length
    ? Math.max(0.8, (Math.max(...axleZs) - Math.min(...axleZs)) / 2)
    : Math.max(0.8, safe.dims.length / 2);
  const pitchPivot = new THREE.Group();
  pitchPivot.name = "pitchPivot";
  pitchPivot.position.set(anchor.x, 0, pivotZ);
  group.remove(built);
  built.position.set(built.position.x - anchor.x, built.position.y, built.position.z - pivotZ);
  pitchPivot.add(built);
  group.add(pitchPivot);
  for (const axle of wheels) group.add(axle);

  // 俯仰幅度按真实悬挂行程限制：车轮处最多升降 5cm，轴距越长俯仰角越小
  // （轿车约 2.1°、12m 客车 0.7°、16.5m 半挂 0.4°），长车不会出现车头/挡泥板扎进路面。
  const travelLimitDeg = (Math.atan(0.05 / halfSpread) * 180) / Math.PI;
  const maxPitchDeg = Math.min(2.2, travelLimitDeg);

  // 结果标记：多车道页用它表达「放行/拦截/混合」，车身颜色保持真实配色
  const markerMaterial = new THREE.MeshBasicMaterial({ color: 0x49d17a, transparent: true, opacity: 0.92 });
  const marker = new THREE.Mesh(new THREE.OctahedronGeometry(0.28, 0), markerMaterial);
  marker.position.y = safe.dims.height + 0.75;
  marker.visible = detail;
  marker.name = "resultMarker";
  group.add(marker);

  let body = null;
  group.traverse((child) => {
    if (!body && child.isMesh && child.material && child.material.userData && child.material.userData.paint) {
      body = child;
    }
  });

  // 车轮滚动：按行驶距离换算转角，速度由调用方给（回放里就是每帧 z 位移）
  const wheelRadius = (wheels[0] && wheels[0].userData.radius) || 0.42;
  function spin(distance) {
    const delta = distance / wheelRadius;
    for (const axle of wheels) axle.rotation.x += delta;
  }

  // 刹车灯：level 0..1，由调用方按速度/减速度驱动（见 createBrakeController）
  function setBrake(level) {
    lights.setLevel(level);
  }

  // 悬挂俯仰：弧度，正值 = 车头下沉（刹车）；见 createSuspensionController
  function setPitch(radians) {
    pitchPivot.rotation.x = Number.isFinite(radians) ? radians : 0;
  }

  /** 换车/换页时释放这辆车自己的材质（几何与贴图是全局共享的，不在这里释放）。 */
  function dispose() {
    lights.dispose();
    markerMaterial.dispose();
    contactShadow.material.dispose();
  }

  return {
    group, body, pitchPivot, marker, markerMaterial, spec: safe, bodyColor, bodyColorSource, colors,
    wheels, wheelRadius, spin, brakeLights: lights, setBrake, setPitch, maxPitchDeg, contactShadow, dispose,
  };
}

/** 车身颜色候选（手动指定用）。 */
export const BODY_COLOR_OPTIONS = [
  { label: "跟随日志", value: "" },
  { label: "白色", value: "#eef1f4" },
  { label: "银色", value: "#b9c0c8" },
  { label: "灰色", value: "#7d858e" },
  { label: "黑色", value: "#1a1d22" },
  { label: "蓝色", value: "#2c6fb5" },
  { label: "红色", value: "#a92330" },
  { label: "黄色", value: "#e0a71a" },
  { label: "绿色", value: "#2f7d4f" },
];

/** 释放缓存（切换数据时用，避免材质/几何持续累积）。 */
export function disposeVehicleCache() {
  for (const item of GEOMETRY_CACHE.values()) item.dispose();
  for (const item of MATERIAL_CACHE.values()) item.dispose();
  for (const item of TEXTURE_CACHE.values()) item.dispose();
  GEOMETRY_CACHE.clear();
  MATERIAL_CACHE.clear();
  TEXTURE_CACHE.clear();
}
