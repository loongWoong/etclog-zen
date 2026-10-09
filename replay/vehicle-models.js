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

import * as THREE from "three";

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
    MATERIAL_CACHE.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.38, metalness: 0.22 }));
  }
  return MATERIAL_CACHE.get(key);
}

function material(key, options) {
  if (!MATERIAL_CACHE.has(key)) MATERIAL_CACHE.set(key, new THREE.MeshStandardMaterial(options));
  return MATERIAL_CACHE.get(key);
}

const GLASS = () => material("glass", {
  color: 0x0e1a24, roughness: 0.08, metalness: 0.45, transparent: true, opacity: 0.72, envMapIntensity: 1.2,
});
const CHROME = () => material("chrome", { color: 0xb9c2cb, roughness: 0.25, metalness: 0.85 });
const DARK = () => material("dark", { color: 0x1b1f24, roughness: 0.7, metalness: 0.3 });
const TIRE = () => material("tire", { color: 0x14171a, roughness: 0.9, metalness: 0.02 });
const RIM = () => material("rim", { color: 0xa7b0b9, roughness: 0.35, metalness: 0.75 });
const HEADLIGHT = () => material("headlight", { color: 0xfff6dc, emissive: 0xffe9a8, emissiveIntensity: 0.85, roughness: 0.2 });
const TAILLIGHT = () => material("taillight", { color: 0x8c1b1b, emissive: 0xd8362c, emissiveIntensity: 0.75, roughness: 0.35 });
const REFLECT_RED = () => material("reflectRed", { color: 0xb3241f, emissive: 0x521010, emissiveIntensity: 0.25, roughness: 0.4 });
const REFLECT_WHITE = () => material("reflectWhite", { color: 0xe8edf2, emissive: 0x39424c, emissiveIntensity: 0.2, roughness: 0.4 });
const AMBER = () => material("amber", { color: 0xffa41f, emissive: 0xff8c00, emissiveIntensity: 0.9, roughness: 0.4 });

function hash(text) {
  let value = 2166136261;
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

function axleLayout(kind, dims, axles, wheelbase) {
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

function addTailDetails(group, dims, rearZ, y = 0.85) {
  group.add(box(0.22, 0.16, 0.08, TAILLIGHT(), -dims.width / 2 + 0.22, y, rearZ));
  group.add(box(0.22, 0.16, 0.08, TAILLIGHT(), dims.width / 2 - 0.22, y, rearZ));
}

function addAxle(group, z, dims, radius, width, dual) {
  const wheelGroup = wheel(radius, width, { dual });
  wheelGroup.position.set(0, radius, z);
  const left = wheelGroup.clone();
  left.position.x = -dims.width / 2 + width * (dual ? 0.72 : 0.42);
  const right = wheelGroup.clone();
  right.position.x = dims.width / 2 - width * (dual ? 0.72 : 0.42);
  group.add(left, right);
  for (const side of [-1, 1]) {
    const flap = mudflap(width * (dual ? 1.7 : 1.1));
    flap.position.set(side * (dims.width / 2 - width * 0.5), 0.2, z - radius - 0.25);
    group.add(flap);
  }
  return wheelGroup;
}

function buildWheels(group, kind, dims, axles, wheelbase, radius, width) {
  const layout = axleLayout(kind, dims, axles, wheelbase);
  const heavy = kind.startsWith("semi") || kind === "rigid3" || kind === "rigid4" || kind === "mediumTruck";
  layout.forEach((z, index) => {
    addAxle(group, z, dims, radius, width, heavy ? index > 0 : false);
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

function buildPassenger(spec, colors, plateFront, plateRear) {
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
  addTailDetails(group, { width: W }, -L / 2 - 0.02);

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
  buildWheels(group, spec.kind, spec.dims, spec.axles, spec.dims.wheelbase, wheelRadius, 0.24);
  return group;
}

function buildTruck(spec, colors, plateFront, plateRear) {
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
    tractorAxles.forEach((z, index) => addAxle(group, z, spec.dims, wheelRadius, 0.3, index > 0));
    const trailerAxleCount = Math.max(1, spec.axles - tractorAxles.length);
    for (let index = 0; index < trailerAxleCount; index += 1) {
      addAxle(group, trailer.position.z - trailerLength / 2 + 0.95 + index * 1.35, spec.dims, wheelRadius, 0.3, true);
    }
    if (plateRear) {
      plateRear.position.set(0, 0.6, -L / 2 - 0.22);
      plateRear.rotation.y = Math.PI;
      group.add(plateRear);
    }
    addTailDetails(group, { width: W }, -L / 2 - 0.05, 0.95);
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
  buildTruckDetailLighting(group, { width: W }, -L / 2, 1.0);
  buildWheels(group, spec.kind, spec.dims, spec.axles, spec.dims.wheelbase, wheelRadius, 0.28);
  return group;
}

function buildTruckDetailLighting(group, dims, rearZ, y) {
  for (const side of [-1, 1]) {
    group.add(box(0.22, 0.5, 0.1, TAILLIGHT(), side * (dims.width / 2 - 0.24), y, rearZ - 0.12));
  }
}

function buildSpecial(spec, colors, plateFront, plateRear) {
  // 专项作业车按真实轴数选底盘：2 轴 → 单车底盘，5/6 轴 → 半挂底盘
  const baseKind = spec.axles <= 2 ? "mediumTruck" : spec.axles === 3 ? "rigid3" : spec.axles === 4 ? "rigid4" : "semi6";
  const group = buildTruck({ ...spec, kind: baseKind, payload: "box" }, colors, plateFront, plateRear);
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
 *            bodyColor: string, bodyColorSource: string}}
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

  const built = safe.kind === "special"
    ? buildSpecial(safe, colors, plateFront, plateRear)
    : isTruck
      ? buildTruck(safe, colors, plateFront, plateRear)
      : buildPassenger(safe, colors, plateFront, plateRear);
  group.add(built);

  // 结果标记：多车道页用它表达「放行/拦截/混合」，车身颜色保持真实配色
  const markerMaterial = new THREE.MeshBasicMaterial({ color: 0x49d17a, transparent: true, opacity: 0.92 });
  const marker = new THREE.Mesh(new THREE.OctahedronGeometry(0.28, 0), markerMaterial);
  marker.position.y = safe.dims.height + 0.75;
  marker.visible = detail;
  marker.name = "resultMarker";
  group.add(marker);

  let body = null;
  group.traverse((child) => {
    if (!body && child.isMesh && child.material && child.material.color && child.material.type === "MeshStandardMaterial"
      && child.material.roughness === 0.38) {
      body = child;
    }
  });

  return { group, body, marker, markerMaterial, spec: safe, bodyColor, bodyColorSource, colors };
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
