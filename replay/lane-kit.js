// 单车道现场构件：尺寸、相对位置、设备几何全部对齐 index.html（单车通行回放）里的车道现场，
// 供多车道过程视图复用。几何与静态材质按尺寸/颜色缓存，8 条车道同屏时不会重复申请显存。
import * as THREE from "three";
import { buildVehicleModel } from "./vehicle-models.js";

// ---------------------------------------------------------------------------
// 尺寸表：与 app.js 的 LANE_DEVICES / coilInfo 一一对应（z 以车道中心为原点）
// ---------------------------------------------------------------------------
export const DEVICES = {
  vlpr: { label: "车牌识别", color: 0x5fb3ff, z: -22.0, x: -3.9, kind: "boom", armLength: 5.6, height: 4.5 },
  weigh: { label: "称重/治超", color: 0xf2994a, z: -19.5, x: 0, kind: "weigh" },
  axle: { label: "车型识别", color: 0xf2c94c, z: -16.5, x: -3.2, kind: "boom", armLength: 6.0, height: 4.1 },
  lane: { label: "车道控制器", color: 0x8bd17c, z: 9.0, x: 3.35, kind: "cabinet", height: 1.65 },
  cpc: { label: "CPC读卡", color: 0xbb6bd9, z: 6.0, x: 3.35, kind: "cabinet", height: 1.2 },
  display: { label: "费显/LED", color: 0xf7d154, z: 18.6, x: 3.35, kind: "display" },
  barrier: { label: "栏杆", color: 0xeb5757, z: 24.0, x: 2.9, kind: "barrier" },
  rsu: { label: "RSU/ETC天线", color: 0x56ccf2, z: 14.5, x: 0, kind: "gantry" },
};

export const COILS = {
  "1": { label: "车检器1", profile: "etc", z: -14.5, x: 0, color: 0x6ee7b7 },
  "2": { label: "车检器2", profile: "etc", z: -10.5, x: 0, color: 0x34d399 },
  "6": { label: "存在线圈6", profile: "mtc", z: 11.8, x: 0, color: 0x8bd17c },
  "7": { label: "落杆线圈7", profile: "both", z: 21.5, x: 0, color: 0xa7f3d0 },
};

export const LAYOUT = {
  roadWidth: 5.2,
  roadLength: 70,
  island: { x: 3.25, width: 1.05, height: 0.22, length: 54, z: 1.5, capZ: [-25.5, 28.5] },
  booth: { x: 3.25, z: 3.4 },
  shoulderX: 2.65,
  postX: -3.7,
  zMin: -35,
  zMax: 35,
};

// 车道现场的路侧立柱设备（与 app.js buildScene 一致）
export const POSTS = [
  { key: "detector1", label: "车辆检测器1", color: 0x8bd17c, z: COILS["1"].z },
  { key: "detector2", label: "车辆检测器2", color: 0x8bd17c, z: COILS["2"].z },
  { key: "closure", label: "关道设备", color: 0x9ca3af, z: -29 },
  { key: "camera", label: "车道摄像机", color: 0x9fb4c8, z: -25.5 },
  { key: "cabinet", label: "一体化集成设备", color: 0x9ca3af, z: -4.5 },
];

export const GANTRIES = [
  { z: -12.4, label: "前ETC天线(预交易)", role: "front", deviceKey: null },
  { z: DEVICES.rsu.z, label: "ETC天线(交易)", role: "rear", deviceKey: "rsu" },
];

// 需要在两页之间保持一致的配色
export const COLORS = {
  road: 0x2a3038,
  laneMark: 0xe9eef5,
  shoulder: 0xcfd8e3,
  island: 0x4b5563,
  islandCap: 0x6b7280,
  boothBody: 0xd7dee8,
  boothRoof: 0x7f8ea3,
  boothWindow: 0x7dc4e8,
  post: 0x7a8796,
  cabinetShell: 0x39424f,
  weighFrame: 0x3f4854,
  weighDeck: 0x59636f,
  weighCabinet: 0x39424f,
};

// ---------------------------------------------------------------------------
// 几何 / 材质缓存
// ---------------------------------------------------------------------------
const boxCache = new Map();
const cylCache = new Map();
const matCache = new Map();

function staticMat(color, options = {}) {
  const key = `${color}|${options.roughness ?? 0.7}|${options.metalness ?? 0.08}|${options.transparent ? 1 : 0}|${options.opacity ?? 1}`;
  let material = matCache.get(key);
  if (!material) {
    material = new THREE.MeshStandardMaterial({
      color,
      roughness: options.roughness ?? 0.7,
      metalness: options.metalness ?? 0.08,
      transparent: Boolean(options.transparent),
      opacity: options.opacity ?? 1,
    });
    matCache.set(key, material);
  }
  return material;
}

// 需要单独做脉冲/发光动画的部件必须独占材质，不能共用
export function ownMat(color, options = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: options.roughness ?? 0.7,
    metalness: options.metalness ?? 0.08,
    transparent: Boolean(options.transparent),
    opacity: options.opacity ?? 1,
  });
}

function boxGeometry(w, h, d) {
  const key = `${w}|${h}|${d}`;
  let geometry = boxCache.get(key);
  if (!geometry) {
    geometry = new THREE.BoxGeometry(w, h, d);
    boxCache.set(key, geometry);
  }
  return geometry;
}

function cylGeometry(rt, rb, h, segments) {
  const key = `${rt}|${rb}|${h}|${segments}`;
  let geometry = cylCache.get(key);
  if (!geometry) {
    geometry = new THREE.CylinderGeometry(rt, rb, h, segments);
    cylCache.set(key, geometry);
  }
  return geometry;
}

/** 静态构件：共用几何与材质，适合路面/立柱/龙门架等不变色的部件 */
export function box(w, h, d, color, options) {
  return new THREE.Mesh(boxGeometry(w, h, d), staticMat(color, options));
}

/** 动画构件：独占材质，可安全地逐帧改 emissive / opacity */
export function liveBox(w, h, d, color, options) {
  return new THREE.Mesh(boxGeometry(w, h, d), ownMat(color, options));
}

export function cyl(rt, rb, h, color, segments = 24) {
  return new THREE.Mesh(cylGeometry(rt, rb, h, segments), staticMat(color));
}

// ---------------------------------------------------------------------------
// 文字标签（贴图缓存 + 复制精灵）
// ---------------------------------------------------------------------------
const labelCache = new Map();

export function makeLabel(text, color = "#eef2f7", scale = 3.4) {
  const key = `${text}|${color}|${scale}`;
  let sprite = labelCache.get(key);
  if (!sprite) {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 96;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(12, 16, 22, 0.76)";
    roundRect(ctx, 10, 14, 492, 58, 12);
    ctx.fill();
    ctx.fillStyle = color;
    let fontSize = 32;
    ctx.font = `${fontSize}px system-ui, sans-serif`;
    while (fontSize > 11 && ctx.measureText(text).width > 460) {
      fontSize -= 2;
      ctx.font = `${fontSize}px system-ui, sans-serif`;
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 256, 43);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
    sprite.scale.set(scale, scale * 0.188, 1);
    labelCache.set(key, sprite);
  }
  const clone = sprite.clone();
  return clone;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// 设备几何（逐一对齐 app.js buildLaneDevice / makeIslandCabinet / makeBoomDevice）
// ---------------------------------------------------------------------------
function makeIslandCabinet(labelText, color, height) {
  const group = new THREE.Group();
  const shell = box(0.95, height, 1.3, COLORS.cabinetShell);
  shell.position.y = height / 2 + 0.22;
  const panel = liveBox(0.12, height * 0.62, 1.0, color);
  panel.position.set(-0.5, height * 0.52 + 0.22, 0);
  const label = makeLabel(labelText);
  label.position.set(0, height + 0.9, 0);
  group.add(shell, panel, label);
  return { group, body: panel };
}

function makeBoomDevice(labelText, color, { armLength, height }) {
  const group = new THREE.Group();
  const post = box(0.2, height, 0.2, COLORS.post);
  post.position.y = height / 2;
  const arm = box(armLength, 0.18, 0.18, COLORS.post);
  arm.position.set(armLength / 2 - 0.1, height - 0.15, 0);
  const head = liveBox(0.5, 0.42, 0.72, color);
  head.position.set(armLength - 0.7, height - 0.55, 0);
  const label = makeLabel(labelText);
  label.position.set(0, height + 0.75, 0);
  group.add(post, arm, head, label);
  return { group, body: head };
}

function makePostDevice(labelText, color) {
  const group = new THREE.Group();
  const pole = box(0.14, 1.9, 0.14, COLORS.post);
  pole.position.y = 0.95;
  const head = box(0.55, 0.45, 0.38, color);
  head.position.y = 1.95;
  const label = makeLabel(labelText);
  label.position.set(0, 2.55, 0);
  group.add(pole, head, label);
  return group;
}

export function buildDevice(key) {
  const info = DEVICES[key];
  if (!info) return null;

  if (info.kind === "boom") {
    const built = makeBoomDevice(info.label, info.color, info);
    built.group.position.set(info.x, 0, info.z);
    return { group: built.group, body: built.body, baseColor: info.color };
  }

  if (info.kind === "weigh") {
    const group = new THREE.Group();
    const frame = box(5.8, 0.04, 4.8, COLORS.weighFrame);
    frame.position.set(0, 0.02, 0);
    const deck = box(5.2, 0.06, 4.2, COLORS.weighDeck);
    deck.position.set(0, 0.07, 0);
    const cabinet = box(0.9, 1.35, 1.1, COLORS.weighCabinet);
    cabinet.position.set(-3.5, 0.9, 1.0);
    const panel = liveBox(0.12, 0.8, 0.85, info.color);
    panel.position.set(-4.0, 0.9, 1.0);
    const label = makeLabel(info.label);
    label.position.set(0, 1.35, 0);
    group.add(frame, deck, cabinet, panel, label);
    group.position.set(info.x, 0, info.z);
    return { group, body: panel, baseColor: info.color };
  }

  if (info.kind === "cabinet") {
    const built = makeIslandCabinet(info.label, info.color, info.height);
    built.group.position.set(info.x, 0, info.z);
    return { group: built.group, body: built.body, baseColor: info.color };
  }

  if (info.kind === "display") {
    const group = new THREE.Group();
    const post = cyl(0.12, 0.12, 3.2, 0x7a8796, 14);
    post.position.y = 1.6;
    const screen = liveBox(1.9, 1.15, 0.16, info.color);
    screen.position.set(-0.4, 3.4, 0);
    const hood = box(2.05, 0.12, 0.42, 0x4b5563);
    hood.position.set(-0.4, 4.05, 0.1);
    const label = makeLabel(info.label);
    label.position.set(0, 4.6, 0);
    group.add(post, screen, hood, label);
    group.position.set(info.x, 0, info.z);
    return { group, body: screen, baseColor: info.color };
  }

  if (info.kind === "barrier") {
    const group = new THREE.Group();
    const base = box(0.55, 0.9, 0.55, 0x313946);
    base.position.set(0, 0.67, 0);
    const pivot = new THREE.Group();
    pivot.position.set(0, 1.12, 0);
    pivot.name = "barrierPivot";
    const arm = liveBox(6.2, 0.12, 0.12, 0xeb5757);
    arm.position.set(-3.1, 0, 0);
    const tip = box(0.12, 0.36, 0.36, 0xf4f6f8);
    tip.position.set(-6.05, 0, 0);
    pivot.add(arm, tip);
    group.add(base, pivot);
    const label = makeLabel(info.label);
    label.position.set(0.2, 1.95, 0);
    group.add(label);
    group.position.set(info.x, 0, info.z);
    return { group, body: arm, pivot, baseColor: info.color };
  }

  return null;
}

export function buildGantry(spec) {
  const group = new THREE.Group();
  const postA = box(0.18, 4.2, 0.18, COLORS.post);
  postA.position.set(-3, 2.1, spec.z);
  const postB = postA.clone();
  postB.position.x = 3;
  const beam = box(6.4, 0.18, 0.18, COLORS.post);
  beam.position.set(0, 4.1, spec.z);
  const antenna = liveBox(0.9, 0.12, 0.5, DEVICES.rsu.color);
  antenna.position.set(0, 3.75, spec.z);
  const label = makeLabel(spec.label, "#d8f7ff");
  label.position.set(0, 4.8, spec.z);
  group.add(postA, postB, beam, antenna, label);
  return { group, antenna };
}

export function buildCoil(id) {
  const info = COILS[id];
  const group = new THREE.Group();
  const ring = new THREE.Mesh(
    boxGeometry(1.35, 0.035, 0.9),
    ownMat(info.color, { transparent: true, opacity: 0.38, roughness: 0.55 })
  );
  ring.position.y = 0.035;
  const center = box(0.9, 0.04, 0.5, 0x1f2933);
  center.position.y = 0.045;
  const label = makeLabel(info.label);
  label.position.set(0, 0.72, 0);
  group.add(ring, center, label);
  group.position.set(info.x, 0, info.z);
  return { group, body: ring, baseColor: info.color, profile: info.profile };
}

// ---------------------------------------------------------------------------
// 整车：与 app.js 共用 vehicle-models.js，按日志车型/轴数/真实尺寸渲染
// ---------------------------------------------------------------------------
export function buildVehicle(spec = null) {
  const built = buildVehicleModel(
    spec || { kind: "car", axles: 2, dims: { length: 4.7, width: 1.85, height: 1.5 }, plate: "", plateColorCode: null },
    { detail: true },
  );
  built.group.name = "vehicle";
  return { vehicle: built.group, body: built.body, marker: built.marker, model: built, spec };
}

/** 车道方向箭头（+Z 为行车方向）：整片广场合成一个 InstancedMesh，只占 1 个 draw call */
export function buildArrowField(positions) {
  const geometry = new THREE.ConeGeometry(0.34, 1.0, 3);
  const material = staticMat(0x46525f);
  const field = new THREE.InstancedMesh(geometry, material, positions.length);
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
  const scale = new THREE.Vector3(1, 1, 1);
  positions.forEach((point, index) => {
    matrix.compose(new THREE.Vector3(point.x, 0.07, point.z), quaternion, scale);
    field.setMatrixAt(index, matrix);
  });
  field.instanceMatrix.needsUpdate = true;
  return field;
}

// ---------------------------------------------------------------------------
// 一条车道的完整现场
// ---------------------------------------------------------------------------
/**
 * @param {object} options
 * @param {string} options.id      车道号
 * @param {string} options.sub     副标题（过程/放行/拦截）
 * @param {boolean} options.details 是否建细部（车位标线/箭头/收费亭/立柱）
 */
export function buildLaneSite({ id, sub, details = true, vehicle = null }) {
  const group = new THREE.Group();

  // 路面
  const road = box(LAYOUT.roadWidth, 0.08, LAYOUT.roadLength, COLORS.road, { roughness: 1 });
  road.position.set(0, -0.04, 0);
  group.add(road);

  const fine = new THREE.Group();
  fine.name = "laneDetails";
  fine.visible = Boolean(details);
  group.add(fine);

  // 车位标线
  for (let z = -31; z <= 31; z += 6) {
    const mark = box(0.12, 0.03, 2.7, COLORS.laneMark);
    mark.position.set(0, 0.02, z);
    fine.add(mark);
  }
  // 路肩
  const shoulderL = box(0.08, 0.04, LAYOUT.roadLength, COLORS.shoulder);
  shoulderL.position.set(-LAYOUT.shoulderX, 0.04, 0);
  const shoulderR = shoulderL.clone();
  shoulderR.position.x = LAYOUT.shoulderX;
  fine.add(shoulderL, shoulderR);

  // 收费岛
  const island = box(LAYOUT.island.width, LAYOUT.island.height, LAYOUT.island.length, COLORS.island, { roughness: 0.9 });
  island.position.set(LAYOUT.island.x, 0.08, LAYOUT.island.z);
  group.add(island);
  const capGeometry = cylGeometry(0.52, 0.52, 0.2, 32);
  const capMaterial = staticMat(COLORS.islandCap);
  for (const z of LAYOUT.island.capZ) {
    const cap = new THREE.Mesh(capGeometry, capMaterial);
    cap.rotation.x = Math.PI / 2;
    cap.position.set(LAYOUT.island.x, 0.1, z);
    group.add(cap);
  }

  // 收费亭
  const booth = new THREE.Group();
  const boothBody = box(1.35, 1.7, 2.2, COLORS.boothBody);
  boothBody.position.y = 0.95;
  const boothRoof = box(1.55, 0.18, 2.45, COLORS.boothRoof);
  boothRoof.position.y = 1.88;
  const boothWindow = box(0.05, 0.62, 1.05, COLORS.boothWindow);
  boothWindow.position.set(-0.7, 1.12, 0);
  booth.add(boothBody, boothRoof, boothWindow);
  booth.position.set(LAYOUT.booth.x, 0, LAYOUT.booth.z);
  fine.add(booth);

  // 路侧立柱设备
  for (const post of POSTS) {
    const built = makePostDevice(post.label, post.color);
    built.position.set(LAYOUT.postX, 0, post.z);
    fine.add(built);
  }

  // 存在线圈标牌（与 app.js 一致，摆在线圈 6 旁边）
  const onlineCoilLabel = makeLabel("存在线圈", "#dbeafe");
  onlineCoilLabel.position.set(2.2, 0.9, COILS["6"].z);
  fine.add(onlineCoilLabel);

  // 线圈
  const coils = new Map();
  for (const coilId of Object.keys(COILS)) {
    const built = buildCoil(coilId);
    group.add(built.group);
    coils.set(coilId, { ...built, state: null, pulse: 0, everSeen: false });
  }

  // 龙门架（前 ETC 天线 / 交易天线）
  const antBases = [];
  for (const spec of GANTRIES) {
    const built = buildGantry(spec);
    group.add(built.group);
    antBases.push({ z: spec.z, role: spec.role, mesh: built.antenna });
  }

  // 通行设备
  const devices = new Map();
  for (const key of Object.keys(DEVICES)) {
    if (key === "rsu") continue;
    const built = buildDevice(key);
    if (!built) continue;
    group.add(built.group);
    devices.set(key, { group: built.group, body: built.body, pivot: built.pivot || null, baseColor: built.baseColor, pulse: 0 });
  }
  // RSU 由交易龙门架承载，状态作用在天线上
  const rearAntenna = antBases.find((item) => item.role === "rear");
  if (rearAntenna) {
    devices.set("rsu", {
      group: rearAntenna.mesh,
      body: rearAntenna.mesh,
      pivot: null,
      baseColor: DEVICES.rsu.color,
      pulse: 0,
      isAntenna: true,
    });
  }

  // 车辆（先按首趟车型建，播放时按每趟车重建）
  const builtVehicle = buildVehicle(vehicle);
  builtVehicle.vehicle.visible = false;
  group.add(builtVehicle.vehicle);

  // 入口区状态灯与光带（本页自有的车道状态指示）
  const lampPost = box(0.2, 3.2, 0.2, 0x424c59);
  lampPost.position.set(-(LAYOUT.roadWidth / 2 + 0.7), 1.6, LAYOUT.zMin + 5);
  group.add(lampPost);
  const statusLight = new THREE.Mesh(
    new THREE.SphereGeometry(0.34, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0x4a5563 })
  );
  statusLight.position.set(-(LAYOUT.roadWidth / 2 + 0.7), 3.3, LAYOUT.zMin + 5);
  group.add(statusLight);
  const headStrip = new THREE.Mesh(
    new THREE.BoxGeometry(LAYOUT.roadWidth, 0.05, 1.2),
    new THREE.MeshBasicMaterial({ color: 0x4a5563, transparent: true, opacity: 0.75 })
  );
  headStrip.position.set(0, 0.12, LAYOUT.zMin + 5);
  group.add(headStrip);

  // 车道号牌
  const label = makeLabel(id, "#cfe0f0", 6.4);
  label.position.set(0, 6.4, LAYOUT.zMin + 5);
  group.add(label);

  return {
    id,
    group,
    fine,
    details,
    devices,
    coils,
    antBases,
    vehicle: builtVehicle.vehicle,
    vehicleBody: builtVehicle.body,
    vehicleMarker: builtVehicle.marker,
    vehicleModel: builtVehicle.model,
    vehicleSpec: builtVehicle.spec,
    statusLight,
    headStrip,
    label,
    barrier: devices.get("barrier")?.pivot || null,
  };
}

/** 车道现场在 z 轴上的取值范围，供相机取景 */
export const SITE_Z = { min: -35, max: 35 };
