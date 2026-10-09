import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createRenderer, createRenderLoop, detectGpu, frameInterval, mountGpuBadge } from "./render-runtime.js";
import { BODY_COLOR_OPTIONS, buildVehicleModel } from "./vehicle-models.js";

// ---------------------------------------------------------------------------
// 设备布局
//   通行设备（车道现场）沿车辆行驶方向（+Z）按理论顺序排布：
//     关道/摄像机 → 车牌识别 → 称重治超 → 车型识别 → 车检器1 → 前ETC天线
//     → 车检器2 → CPC读卡 → 车道控制器 → 车检器6 → 后ETC天线 → 费显 → 车检器7 → 栏杆
//   收费系统设备（交易/名单/计费/MQ/流水）不做三维建模，只在右侧时间线里按日志出现。
// ---------------------------------------------------------------------------
const LANE_DEVICES = {
  vlpr: { label: "车牌识别", color: 0x5fb3ff, z: -22.0, x: -3.9 },
  weigh: { label: "称重/治超", color: 0xf2994a, z: -19.5, x: 0, deck: true },
  axle: { label: "车型识别", color: 0xf2c94c, z: -16.5, x: 0, gantry: true },
  lane: { label: "车道控制器", color: 0x8bd17c, z: 9.0, x: 3.35, island: true },
  cpc: { label: "CPC读卡", color: 0xbb6bd9, z: 6.0, x: 3.35, island: true },
  display: { label: "费显/LED", color: 0xf7d154, z: 18.6, x: 3.35, island: true },
  barrier: { label: "栏杆", color: 0xeb5757, z: 24.0, x: 2.9, island: true },
  rsu: { label: "RSU/ETC天线", color: 0x56ccf2, z: 14.5, x: 0 },
};

const deviceInfo = { ...LANE_DEVICES };
const LANE_DEVICE_KEYS = Object.keys(LANE_DEVICES);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x151a20);

const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 400);
const PANORAMA = { position: [-36, 34, 54], target: [0, 1.5, 0] };
camera.position.set(...PANORAMA.position);
camera.lookAt(...PANORAMA.target);

// GPU 优先：显式要求高性能显卡；如果浏览器落到软件渲染，自动关抗锯齿并压到像素比 1
const GPU = detectGpu();
// 渲染循环在文件末尾创建；这里先声明，避免 controls 的监听器在求值期触发时踩到暂时性死区
let LOOP = null;
const renderer = createRenderer(document.querySelector("#scene"), GPU);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(...PANORAMA.target);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 6;
controls.maxDistance = 190;
controls.maxPolarAngle = Math.PI * 0.48;
controls.addEventListener("change", () => LOOP?.hold(500));
controls.update();

const VIEW_PRESETS = {
  panorama: { label: "全景", position: PANORAMA.position, target: PANORAMA.target },
  lane: { label: "车道现场", position: [-13, 8.5, -6], target: [0, 1.2, 2] },
};
let cameraTween = null;


const ambient = new THREE.AmbientLight(0xffffff, 0.62);
scene.add(ambient);
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(8, 18, 8);
scene.add(sun);

const deviceMeshes = new Map();
const coilMeshes = new Map();
const profileObjects = [];
const antennaEndpoints = [];
const labels = [];
let replay = null;
let currentIndex = 0;
let playing = false;
let lastTick = performance.now();
let speed = 1;
let communicationBeam = null;
let coilStates = new Map();
let eventPositions = [];

const coilInfo = {
  "1": { label: "车检器1", profile: "etc", z: -14.5, x: 0, color: 0x6ee7b7 },
  "2": { label: "车检器2", profile: "etc", z: -10.5, x: 0, color: 0x34d399 },
  "6": { label: "存在线圈6", profile: "mtc", z: 11.8, x: 0, color: 0x8bd17c },
  "7": { label: "落杆线圈7", profile: "both", z: 21.5, x: 0, color: 0xa7f3d0 },
};

const deviceZAnchors = {
  vlpr: deviceInfo.vlpr.z,
  axle: deviceInfo.axle.z,
  weigh: deviceInfo.weigh.z,
  cpc: deviceInfo.cpc.z,
  display: deviceInfo.display.z,
  barrier: deviceInfo.barrier.z,
};

const els = {
  select: document.querySelector("#replaySelect"),
  legend: document.querySelector("#legend"),
  views: document.querySelector("#views"),
  play: document.querySelector("#playButton"),
  scrubber: document.querySelector("#scrubber"),
  speed: document.querySelector("#speedSelect"),
  vehicle: document.querySelector("#vehicleName"),
  clock: document.querySelector("#clock"),
  count: document.querySelector("#eventCount"),
  title: document.querySelector("#eventTitle"),
  timeline: document.querySelector("#timeline"),
  card: document.querySelector("#vehicleCard"),
  plate: document.querySelector("#vehiclePlate"),
  plateColor: document.querySelector("#vehiclePlateColor"),
  spec: document.querySelector("#vehicleSpec"),
  note: document.querySelector("#vehicleNote"),
  bodyColor: document.querySelector("#bodyColorSelect"),
};

function mat(color, roughness = 0.7) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.08 });
}

function box(w, h, d, color) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
}

function cyl(radiusTop, radiusBottom, height, color, segments = 24) {
  return new THREE.Mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments), mat(color));
}

function makeLabel(text, color = "#eef2f7", scale = 3.4) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 96;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(12, 16, 22, 0.76)";
  roundRect(ctx, 10, 14, 492, 58, 12);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.font = "32px system-ui, sans-serif";
  let fontSize = 32;
  while (fontSize > 11 && ctx.measureText(text).width > 460) {
    fontSize -= 2;
    ctx.font = `${fontSize}px system-ui, sans-serif`;
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 256, 43);
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
  sprite.scale.set(scale, scale * 0.188, 1);
  labels.push(sprite);
  return sprite;
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
}

function buildScene() {
  buildGround();

  const road = box(5.2, 0.08, 70, 0x2a3038);
  road.position.set(0, -0.04, 0);
  scene.add(road);

  for (let z = -31; z <= 31; z += 6) {
    const mark = box(0.12, 0.03, 2.7, 0xe9eef5);
    mark.position.set(0, 0.02, z);
    scene.add(mark);
  }
  buildDirectionArrows();

  const shoulderL = box(0.08, 0.04, 70, 0xcfd8e3);
  shoulderL.position.set(-2.65, 0.04, 0);
  scene.add(shoulderL);
  const shoulderR = shoulderL.clone();
  shoulderR.position.x = 2.65;
  scene.add(shoulderR);

  const island = box(1.05, 0.22, 54, 0x4b5563);
  island.position.set(3.25, 0.08, 1.5);
  scene.add(island);
  const islandNose = cyl(0.52, 0.52, 0.2, 0x6b7280, 32);
  islandNose.rotation.x = Math.PI / 2;
  islandNose.position.set(3.25, 0.1, -25.5);
  scene.add(islandNose);
  const islandTail = islandNose.clone();
  islandTail.position.z = 28.5;
  scene.add(islandTail);

  const tollBooth = new THREE.Group();
  const boothBody = box(1.35, 1.7, 2.2, 0xd7dee8);
  boothBody.position.y = 0.95;
  const boothRoof = box(1.55, 0.18, 2.45, 0x7f8ea3);
  boothRoof.position.y = 1.88;
  const windowA = box(0.05, 0.62, 1.05, 0x7dc4e8);
  windowA.position.set(-0.7, 1.12, 0);
  tollBooth.add(boothBody, boothRoof, windowA);
  tollBooth.position.set(3.25, 0, 3.4);
  scene.add(tollBooth);
  profileObjects.push({ object: tollBooth, profiles: new Set(["mtc"]) });

  Object.entries(coilInfo).forEach(([id, info]) => {
    const group = new THREE.Group();
    const ring = box(1.35, 0.035, 0.9, info.color);
    ring.material.transparent = true;
    ring.material.opacity = 0.48;
    ring.userData.coilId = id;
    ring.position.y = 0.035;
    const center = box(0.9, 0.04, 0.5, 0x1f2933);
    center.position.y = 0.045;
    const label = makeLabel(info.label);
    label.position.set(0, 0.72, 0);
    group.add(ring, center, label);
    group.position.set(info.x, 0, info.z);
    scene.add(group);
    coilMeshes.set(id, { group, body: ring, baseColor: info.color, profile: info.profile, pulse: 0 });
  });

  // 车辆检测器立柱（与车检器1/2 同点位，路侧设备柜）
  const detector1 = makePostDevice("车辆检测器1", 0x8bd17c);
  detector1.position.set(-3.7, 0, coilInfo["1"].z);
  scene.add(detector1);
  profileObjects.push({ object: detector1, profiles: new Set(["etc"]) });

  const detector2 = makePostDevice("车辆检测器2", 0x8bd17c);
  detector2.position.set(-3.7, 0, coilInfo["2"].z);
  scene.add(detector2);
  profileObjects.push({ object: detector2, profiles: new Set(["etc"]) });

  // 入口区：关道设备、车道摄像机
  const closureDevice = makePostDevice("关道设备", 0x9ca3af);
  closureDevice.position.set(-3.7, 0, -29);
  scene.add(closureDevice);

  const cameraPost = makePostDevice("车道摄像机", 0x9fb4c8);
  cameraPost.position.set(-3.7, 0, -25.5);
  scene.add(cameraPost);

  // 前 ETC 天线（预交易）与后 ETC 天线（交易确认）
  const frontGantry = makeGantry(-12.4, "前ETC天线(预交易)", { role: "front", profile: "etc" });
  scene.add(frontGantry);
  profileObjects.push({ object: frontGantry, profiles: new Set(["etc"]) });

  const gantry = makeGantry(deviceInfo.rsu.z, "ETC天线(交易)", { deviceKey: "rsu", role: "rear", profile: "both" });
  scene.add(gantry);

  // 车道控制器机柜（岛上，事件设备 lane 的实体）
  const controllerCabinet = makePostDevice("一体化集成设备", 0x9ca3af);
  controllerCabinet.position.set(-3.7, 0, -4.5);
  scene.add(controllerCabinet);
  profileObjects.push({ object: controllerCabinet, profiles: new Set(["etc"]) });

  const onlineCoilLabel = makeLabel("存在线圈", "#dbeafe");
  onlineCoilLabel.position.set(2.2, 0.9, coilInfo["6"].z);
  scene.add(onlineCoilLabel);
  profileObjects.push({ object: onlineCoilLabel, profiles: new Set(["mtc"]) });

  communicationBeam = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 3.9, deviceInfo.rsu.z),
      new THREE.Vector3(0, 1.25, -20),
    ]),
    new THREE.LineBasicMaterial({
      color: 0x8ee7ff,
      transparent: true,
      opacity: 0,
      linewidth: 2,
    })
  );
  scene.add(communicationBeam);

  // 通行设备（车道现场），按理论顺序沿 +Z 排布
  LANE_DEVICE_KEYS.forEach((key) => {
    if (key === "rsu") return; // RSU 由龙门架承载
    const built = buildLaneDevice(key);
    if (!built) return;
    scene.add(built.group);
    if (key === "weigh" || key === "cpc") {
      profileObjects.push({ object: built.group, profiles: new Set(["mtc"]) });
    }
  });

  renderViews();

  scene.add(makeVehicle());
  renderLegend();
}

function buildGround() {
  const ground = box(64, 0.08, 96, 0x191d23);
  ground.position.set(0, -0.1, 0);
  scene.add(ground);
}

function buildDirectionArrows() {
  for (let z = -24; z <= 26; z += 12) {
    [-1.35, 1.35].forEach((x) => {
      const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.34, 1.0, 3), mat(0x46525f));
      arrow.rotation.x = Math.PI / 2; // 指向车辆行驶方向 +Z
      arrow.position.set(x, 0.07, z);
      scene.add(arrow);
    });
  }
}

// ---------------------------------------------------------------------------
// 车道现场设备实体
// ---------------------------------------------------------------------------
function registerDevice(key, group, body) {
  deviceMeshes.set(key, { group, body, baseColor: deviceInfo[key].color, pulse: 0 });
  return group;
}

function makeIslandCabinet(labelText, color, height = 1.45) {
  const group = new THREE.Group();
  const shell = box(0.95, height, 1.3, 0x39424f);
  shell.position.y = height / 2 + 0.22;
  const panel = box(0.12, height * 0.62, 1.0, color);
  panel.position.set(-0.5, height * 0.52 + 0.22, 0);
  const label = makeLabel(labelText);
  label.position.set(0, height + 0.9, 0);
  group.add(shell, panel, label);
  return { group, body: panel };
}

function makeBoomDevice(labelText, color, { armLength = 5.2, height = 4.3 } = {}) {
  const group = new THREE.Group();
  const post = box(0.2, height, 0.2, 0x7a8796);
  post.position.y = height / 2;
  const arm = box(armLength, 0.18, 0.18, 0x7a8796);
  arm.position.set(armLength / 2 - 0.1, height - 0.15, 0);
  const head = box(0.5, 0.42, 0.72, color);
  head.position.set(armLength - 0.7, height - 0.55, 0);
  const label = makeLabel(labelText);
  label.position.set(0, height + 0.75, 0);
  group.add(post, arm, head, label);
  return { group, body: head };
}

function buildLaneDevice(key) {
  const info = LANE_DEVICES[key];

  if (key === "vlpr") {
    const built = makeBoomDevice(info.label, info.color, { armLength: 5.6, height: 4.5 });
    built.group.position.set(info.x, 0, info.z);
    return { group: registerDevice(key, built.group, built.body), body: built.body };
  }

  if (key === "axle") {
    const built = makeBoomDevice(info.label, info.color, { armLength: 6.0, height: 4.1 });
    built.group.position.set(-3.2, 0, info.z);
    return { group: registerDevice(key, built.group, built.body), body: built.body };
  }

  if (key === "weigh") {
    const group = new THREE.Group();
    const frame = box(5.8, 0.04, 4.8, 0x3f4854);
    frame.position.set(0, 0.02, 0);
    const deck = box(5.2, 0.06, 4.2, 0x59636f);
    deck.position.set(0, 0.07, 0);
    const cabinet = box(0.9, 1.35, 1.1, 0x39424f);
    cabinet.position.set(-3.5, 0.9, 1.0);
    const panel = box(0.12, 0.8, 0.85, info.color);
    panel.position.set(-4.0, 0.9, 1.0);
    const label = makeLabel(info.label);
    label.position.set(0, 1.35, 0);
    group.add(frame, deck, cabinet, panel, label);
    group.position.set(info.x, 0, info.z);
    return { group: registerDevice(key, group, panel), body: panel };
  }

  if (key === "lane" || key === "cpc") {
    const built = makeIslandCabinet(info.label, info.color, key === "lane" ? 1.65 : 1.2);
    built.group.position.set(info.x, 0, info.z);
    return { group: registerDevice(key, built.group, built.body), body: built.body };
  }

  if (key === "display") {
    const group = new THREE.Group();
    const post = cyl(0.12, 0.12, 3.2, 0x7a8796, 14);
    post.position.y = 1.6;
    const screen = box(1.9, 1.15, 0.16, info.color);
    screen.position.set(-0.4, 3.4, 0);
    const hood = box(2.05, 0.12, 0.42, 0x4b5563);
    hood.position.set(-0.4, 4.05, 0.1);
    const label = makeLabel(info.label);
    label.position.set(0, 4.6, 0);
    group.add(post, screen, hood, label);
    group.position.set(info.x, 0, info.z);
    return { group: registerDevice(key, group, screen), body: screen };
  }

  if (key === "barrier") {
    const group = new THREE.Group();
    const base = box(0.55, 0.9, 0.55, 0x313946);
    base.position.set(0, 0.67, 0);
    const pivot = new THREE.Group();
    pivot.position.set(0, 1.12, 0);
    pivot.name = "barrierArm";
    const arm = box(6.2, 0.12, 0.12, 0xeb5757);
    arm.position.set(-3.1, 0, 0);
    const tip = box(0.12, 0.36, 0.36, 0xf4f6f8);
    tip.position.set(-6.05, 0, 0);
    pivot.add(arm, tip);
    group.add(base, pivot);
    const label = makeLabel(info.label);
    label.position.set(0.2, 1.95, 0);
    group.add(label);
    group.position.set(info.x, 0, info.z);
    return { group: registerDevice(key, group, arm), body: arm };
  }

  return null;
}

function renderViews() {
  if (!els.views) return;
  els.views.replaceChildren(
    ...Object.entries(VIEW_PRESETS).map(([key, preset]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = preset.label;
      button.addEventListener("click", () => focusView(key));
      return button;
    })
  );
}

function focusView(key) {
  const preset = VIEW_PRESETS[key];
  if (!preset) return;
  cameraTween = {
    from: camera.position.clone(),
    to: new THREE.Vector3(...preset.position),
    fromTarget: controls.target.clone(),
    toTarget: new THREE.Vector3(...preset.target),
    t: 0,
  };
  LOOP?.hold(2200);
}

function makeGantry(z, labelText, options = {}) {
  const { deviceKey = null, role = "rear", profile = "both" } = options;
  const gantry = new THREE.Group();
  const postA = box(0.18, 4.2, 0.18, 0x7a8796);
  postA.position.set(-3, 2.1, z);
  const postB = postA.clone();
  postB.position.x = 3;
  const beam = box(6.4, 0.18, 0.18, 0x7a8796);
  beam.position.set(0, 4.1, z);
  const antenna = box(0.9, 0.12, 0.5, 0x56ccf2);
  antenna.position.set(0, 3.75, z);
  const label = makeLabel(labelText, "#d8f7ff");
  label.position.set(0, 4.8, z);
  gantry.add(postA, postB, beam, antenna, label);
  antennaEndpoints.push({ role, profile, mesh: antenna, z });
  if (deviceKey) {
    const info = deviceInfo[deviceKey];
    deviceMeshes.set(deviceKey, { group: antenna, body: antenna, baseColor: info.color, pulse: 0 });
  }
  return gantry;
}

function makePostDevice(labelText, color) {
  const group = new THREE.Group();
  const pole = box(0.14, 1.9, 0.14, 0x7a8796);
  pole.position.y = 0.95;
  const head = box(0.55, 0.45, 0.38, color);
  head.position.y = 1.95;
  const label = makeLabel(labelText);
  label.position.set(0, 2.55, 0);
  group.add(pole, head, label);
  return group;
}

function renderLegend() {
  const groups = [["通行设备 · 车道现场", LANE_DEVICE_KEYS]];
  const nodes = [];
  groups.forEach(([title, keys]) => {
    const heading = document.createElement("div");
    heading.className = "legend-title";
    heading.textContent = title;
    nodes.push(heading);
    keys.forEach((key) => {
      const info = deviceInfo[key];
      const item = document.createElement("div");
      item.className = "legend-item";
      item.dataset.device = key;
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = `#${info.color.toString(16).padStart(6, "0")}`;
      const label = document.createElement("span");
      label.textContent = info.label;
      item.append(swatch, label);
      nodes.push(item);
    });
  });
  els.legend.replaceChildren(...nodes);
}

function visibleCoilIds(profile) {
  if (profile === "etc") return new Set(["1", "2", "7"]);
  if (profile === "mtc") return new Set(["6", "7"]);
  return new Set(Object.keys(coilInfo));
}

function updateCoilVisibility(profile) {
  const visible = visibleCoilIds(profile);
  coilMeshes.forEach((item, id) => {
    item.group.visible = visible.has(id);
  });
}

function updateProfileVisibility(profile) {
  profileObjects.forEach(({ object, profiles }) => {
    const visible = profiles.has(profile) || profiles.has("both") || profile === "unknown";
    object.userData.profileVisible = visible;
    object.visible = visible;
  });
}

function makeVehicle(spec = null, options = {}) {
  const holder = new THREE.Group();
  holder.name = "vehicle";
  holder.position.set(0, 0, -28);

  const built = buildVehicleModel(
    spec || { kind: "car", axles: 2, dims: { length: 4.7, width: 1.85, height: 1.5 }, plate: "", plateColorCode: null },
    { detail: true, ...options },
  );
  holder.add(built.group);

  // OBU 标签指向模型里的 obuUnit，通信光束用它作为终点
  const obu = built.group.getObjectByName("obuUnit");
  if (obu) {
    const label = makeLabel("OBU车载单元", "#fff6cc");
    label.position.set(0, (built.spec.dims.height || 1.5) + 0.42, obu.position.z);
    holder.add(label);
  }
  holder.userData.model = built;
  return holder;
}

function vehicle() {
  return scene.getObjectByName("vehicle");
}

// ---------------------------------------------------------------------------
// 车辆信息卡：车型 / 轴数 / 尺寸 / 车牌颜色来自日志，车身颜色单独标注来源
// ---------------------------------------------------------------------------
const PLATE_CHIP_COLORS = {
  0: ["#1f4fa8", "#eef3ff"], 1: ["#d8a318", "#231a04"], 2: ["#15171b", "#f2f6fa"],
  3: ["#e9eef4", "#1b2026"], 4: ["#2f9e5f", "#f0fff6"], 5: ["#c3cf45", "#20242a"],
};

function fillVehicleCard(spec, colorSource) {
  if (!els.card) return;
  els.card.hidden = !spec;
  if (!spec) return;
  els.plate.textContent = spec.plate || "车牌未识别";
  const chip = PLATE_CHIP_COLORS[spec.plateColorCode] || ["#2b3138", "#93a1b1"];
  els.plateColor.textContent = spec.plateColorLabel ? `${spec.plateColorLabel}号牌` : "车牌颜色未上报";
  els.plateColor.style.background = chip[0];
  els.plateColor.style.color = chip[1];

  const dims = spec.dims || {};
  const sizeText = `${dims.length?.toFixed(2) ?? "-"} × ${dims.width?.toFixed(2) ?? "-"} × ${dims.height?.toFixed(2) ?? "-"} m`;
  const mass = spec.mass || {};
  const rows = [
    ["车型", `${spec.classLabel || "未知"}${spec.classCode ? `（部车型码 ${spec.classCode}）` : ""} · ${spec.classBasis || ""}`],
    ["轴数", `${spec.axles || "-"} 轴${spec.axleSource ? `（${spec.axleSource}）` : ""}${spec.axleMismatch ? " ⚠ 与车型不符" : ""}`],
    ["尺寸(长×宽×高)", `${sizeText}${spec.realDims ? " · 车型识别实测" : " · 车型典型值"}`],
  ];
  if (dims.wheelbase) rows.push(["轴距", `${dims.wheelbase.toFixed(2)} m`]);
  rows.push(["车身颜色", colorSource]);
  if (mass.load || mass.curb || mass.gvw || mass.actual) {
    rows.push(["质量", [
      mass.load ? `核载 ${mass.load}kg` : "", mass.curb ? `整备 ${mass.curb}kg` : "",
      mass.gvw ? `总质量 ${mass.gvw}kg` : "", mass.actual ? `入口称重 ${mass.actual}kg` : "",
    ].filter(Boolean).join(" · ")]);
  }
  if (spec.dangerous || spec.special) {
    rows.push(["标志", [spec.dangerous ? "危险品运输" : "", spec.special ? "专项作业车" : ""].filter(Boolean).join(" · ")]);
  }
  if (spec.classMismatch) {
    rows.push(["⚠ 车型不符", `车型识别判定 ${spec.identifiedClass}，申报 ${spec.declaredClass}`]);
  }
  els.spec.innerHTML = rows
    .map(([key, value]) => `<div class="vk">${key}</div><div class="vv">${value}</div>`)
    .join("");
  els.note.textContent = (spec.evidence || []).length
    ? `日志依据：${spec.evidence.join("；")}`
    : "日志中没有车型/颜色字段，按默认车型渲染";
}

function applyVehicle(spec, options = {}) {
  const previous = vehicle();
  if (previous) {
    scene.remove(previous);
    previous.traverse((child) => {
      if (!child.isSprite) return;
      const index = labels.indexOf(child);
      if (index >= 0) labels.splice(index, 1);
    });
  }
  const holder = makeVehicle(spec, options);
  scene.add(holder);
  const built = holder.userData.model;
  fillVehicleCard(spec, built ? built.bodyColorSource : "按车型常见配色示意");
  LOOP?.hold(700);
  return holder;
}

function initBodyColorSelect() {
  if (!els.bodyColor) return;
  els.bodyColor.innerHTML = BODY_COLOR_OPTIONS
    .map((item) => `<option value="${item.value}">${item.label}</option>`)
    .join("");
  els.bodyColor.addEventListener("change", () => {
    const value = els.bodyColor.value;
    applyVehicle(replay?.vehicleInfo || null, value ? { bodyColor: value, bodyColorSource: "手动指定" } : {});
  });
}

function barrierArm() {
  return scene.getObjectByName("barrierArm");
}

function obuUnit() {
  return scene.getObjectByName("obuUnit");
}

function visibleAntennaEndpoints() {
  if (replay?.laneProfile === "etc") {
    return antennaEndpoints.filter((item) => item.profile === "etc" || item.profile === "both");
  }
  return antennaEndpoints.filter((item) => item.role === "rear");
}

function communicationAntennaForVehicle() {
  const z = vehicle()?.position.z ?? 0;
  const endpoints = visibleAntennaEndpoints();
  return endpoints.reduce((best, item) => {
    if (!best) return item;
    return Math.abs(item.z - z) < Math.abs(best.z - z) ? item : best;
  }, null);
}

function eventZCandidate(event, currentZ) {
  if (event.coilId && coilInfo[event.coilId]) {
    return coilInfo[event.coilId].z;
  }
  if (event.device === "rsu") {
    return replay?.laneProfile === "etc" && currentZ < 0 ? -12.4 : deviceInfo.rsu.z;
  }
  if (Object.hasOwn(deviceZAnchors, event.device)) {
    return deviceZAnchors[event.device];
  }
  return null;
}

function buildEventPositions() {
  let currentZ = -27;
  eventPositions = replay.events.map((event) => {
    const candidate = eventZCandidate(event, currentZ);
    if (candidate !== null) {
      currentZ = Math.max(currentZ, candidate);
    }
    return currentZ;
  });
}

function setEvent(index) {
  if (!replay || !replay.events.length) return;
  currentIndex = Math.max(0, Math.min(index, replay.events.length - 1));
  const event = replay.events[currentIndex];
  const z = eventPositions[currentIndex] ?? -27;
  vehicle().position.z = THREE.MathUtils.lerp(vehicle().position.z, z, 0.55);

  deviceMeshes.forEach((item) => {
    item.pulse = 0;
    item.body.material.emissive.setHex(0x000000);
    item.body.scale.setScalar(1);
  });
  antennaEndpoints.forEach((item) => {
    item.mesh.material.emissive.setHex(0x000000);
    item.mesh.scale.setScalar(1);
  });
  coilMeshes.forEach((item) => {
    item.pulse = 0;
    item.body.material.emissive.setHex(0x000000);
    item.body.material.opacity = coilStates.get(item.body.userData.coilId) ? 0.78 : 0.38;
  });
  const active = deviceMeshes.get(event.device) || null;
  // 被车道类型过滤掉的设备（如 ETC 车道里的称重），在它自己的事件里临时显示
  profileObjects.forEach(({ object }) => {
    object.visible = object.userData.profileVisible !== false;
  });
  if (active?.group) active.group.visible = true;
  if (event.device === "rsu") {
    const endpoint = communicationAntennaForVehicle();
    if (endpoint) {
      endpoint.mesh.material.emissive.setHex(deviceInfo.rsu.color).multiplyScalar(1.1);
      endpoint.mesh.scale.setScalar(1.18);
    }
  } else if (active) {
    active.pulse = 1;
  }
  if (event.coilId && coilMeshes.has(event.coilId)) {
    const coil = coilMeshes.get(event.coilId);
    if (typeof event.coilState === "boolean") {
      coilStates.set(event.coilId, event.coilState);
    }
    coil.pulse = 1;
    coil.group.visible = true;
    coil.body.material.opacity = event.coilState === false ? 0.38 : 0.88;
  }
  communicationBeam.userData.active = event.device === "rsu";
  activeLegend(event.device);

  const arm = barrierArm();
  if (event.kind === "success") {
    arm.rotation.z = THREE.MathUtils.degToRad(-26); // 抬杆放行
  } else if (event.kind === "reject") {
    arm.rotation.z = 0; // 落杆
  }

  els.scrubber.value = currentIndex;
  els.clock.textContent = event.time.slice(11, 23);
  els.count.textContent = `${currentIndex + 1} / ${replay.events.length}`;
  updateTimelineActive();
  // 让这次的脉冲缓动跑完再停帧
  LOOP?.hold(700);
}

function renderTimeline() {
  els.timeline.replaceChildren(
    ...replay.events.map((event, index) => {
      const li = document.createElement("li");
      li.dataset.index = index;
      const time = document.createElement("div");
      time.className = "time";
      time.textContent = event.time.slice(11, 23);
      const summary = document.createElement("div");
      summary.className = "summary";
      summary.textContent = event.raw;
      li.append(time, summary);
      li.addEventListener("click", () => {
        playing = false;
        els.play.textContent = "播放";
        setEvent(index);
      });
      return li;
    })
  );
}

function updateTimelineActive() {
  if (timelineItems.length !== els.timeline.children.length) {
    timelineItems = [...els.timeline.children];
    timelineActiveEl = null;
  }
  const next = timelineItems[currentIndex];
  if (timelineActiveEl === next) return;
  timelineActiveEl?.classList.remove("active");
  next?.classList.add("active");
  timelineActiveEl = next;
  // 滚动跟随限频：播放时每帧 scrollIntoView 会强制同步布局
  const now = performance.now();
  if (next && now - lastTimelineScroll > 250) {
    lastTimelineScroll = now;
    next.scrollIntoView({ block: "nearest" });
  }
}

let timelineItems = [];
let timelineActiveEl = null;
let lastTimelineScroll = 0;

let legendItems = [];

function activeLegend(deviceKey) {
  if (legendItems.length !== els.legend.children.length) legendItems = [...els.legend.children];
  for (const item of legendItems) item.classList.toggle("active", item.dataset.device === deviceKey);
}

async function loadIndex() {
  const response = await fetch("./data/index.json");
  const index = await response.json();
  els.select.replaceChildren(
    ...index.map((item) => {
      const option = document.createElement("option");
      option.value = item.file;
      option.textContent = `${item.vehicle}  ${item.start.slice(11, 19)}  ${item.eventCount}条`;
      return option;
    })
  );
  const requestedFile = new URLSearchParams(window.location.search).get("file");
  const initialFile = index.some((item) => item.file === requestedFile)
    ? requestedFile
    : index[0]?.file;
  if (initialFile) {
    els.select.value = initialFile;
    await loadReplay(initialFile);
  }
}

async function loadReplay(file) {
  const response = await fetch(`./data/${file}`);
  replay = await response.json();
  currentIndex = 0;
  coilStates = new Map();
  els.vehicle.textContent = replay.vehicle;
  els.title.textContent = replay.passageTitle || `${replay.vehicle} ${replay.events[0]?.time?.slice(0, 19) || ""}`;
  els.scrubber.max = String(Math.max(replay.events.length - 1, 0));
  applyVehicle(replay.vehicleInfo || null);
  updateProfileVisibility(replay.laneProfile);
  updateCoilVisibility(replay.laneProfile);
  buildEventPositions();
  renderTimeline();
  setEvent(0);
}

function resize() {
  const rect = renderer.domElement.parentElement.getBoundingClientRect();
  renderer.setSize(rect.width, rect.height, false);
  camera.aspect = rect.width / Math.max(rect.height, 1);
  camera.updateProjectionMatrix();
  LOOP?.hold(300);
}

// ---------------------------------------------------------------------------
// 按需渲染：只有播放中 / 相机交互 / 缓动与脉冲收尾时才出帧，空闲时停掉 RAF
// ---------------------------------------------------------------------------
const ANIM_SCRATCH_VECTOR = new THREE.Vector3();
const ANIM_SCRATCH_VECTOR_B = new THREE.Vector3();

function stillAnimating() {
  if (playing || cameraTween) return true;
  for (const item of deviceMeshes) if (item.pulse > 0) return true;
  for (const item of coilMeshes) if (item.pulse > 0) return true;
  // 脉冲衰减完、相机缓动结束后就是静态画面，不需要继续出帧
  return false;
}

function onFrame(dt) {
  if (playing && replay?.events.length) {
    const next = currentIndex + Math.max(1, Math.floor(speed * dt * 2));
    if (next >= replay.events.length) {
      playing = false;
      els.play.textContent = "播放";
      setEvent(replay.events.length - 1);
    } else {
      setEvent(next);
    }
  }

  deviceMeshes.forEach((item) => {
    item.pulse = Math.max(0, item.pulse - dt * 1.6);
    // setHex 复用同一个 Color 对象，不再每帧 new THREE.Color()
    item.body.material.emissive.setHex(item.baseColor).multiplyScalar(item.pulse * 0.95);
    item.body.scale.setScalar(1 + item.pulse * 0.1);
  });

  coilMeshes.forEach((item) => {
    item.pulse = Math.max(0, item.pulse - dt * 1.8);
    item.body.material.emissive.setHex(item.baseColor).multiplyScalar(item.pulse * 1.2);
    item.group.scale.setScalar(1 + item.pulse * 0.18);
  });

  if (communicationBeam) {
    const active = communicationBeam.userData.active;
    const targetOpacity = active ? 0.88 : 0;
    communicationBeam.material.opacity = THREE.MathUtils.lerp(
      communicationBeam.material.opacity,
      targetOpacity,
      0.16
    );
    communicationBeam.visible = communicationBeam.material.opacity > 0.02;
    if (communicationBeam.visible) {
      // 原位更新两个端点，避免每帧 setFromPoints 重建 BufferAttribute
      const obuPosition = ANIM_SCRATCH_VECTOR;
      obuUnit()?.getWorldPosition(obuPosition);
      const endpoint = communicationAntennaForVehicle();
      const antennaPosition = ANIM_SCRATCH_VECTOR_B.set(0, 3.9, deviceInfo.rsu.z);
      if (endpoint) {
        endpoint.mesh.getWorldPosition(antennaPosition);
        endpoint.mesh.material.emissive.setHex(deviceInfo.rsu.color).multiplyScalar(0.95);
        endpoint.mesh.scale.setScalar(1.14);
      }
      const position = communicationBeam.geometry.getAttribute("position");
      if (position && position.count >= 2) {
        position.setXYZ(0, antennaPosition.x, antennaPosition.y, antennaPosition.z);
        position.setXYZ(1, obuPosition.x, obuPosition.y, obuPosition.z);
        position.needsUpdate = true;
        communicationBeam.geometry.computeBoundingSphere();
      }
    }
  }

  if (cameraTween) {
    cameraTween.t = Math.min(1, cameraTween.t + dt * 1.6);
    const eased =
      cameraTween.t < 0.5
        ? 2 * cameraTween.t * cameraTween.t
        : 1 - (-2 * cameraTween.t + 2) ** 2 / 2;
    camera.position.lerpVectors(cameraTween.from, cameraTween.to, eased);
    controls.target.lerpVectors(cameraTween.fromTarget, cameraTween.toTarget, eased);
    if (cameraTween.t >= 1) cameraTween = null;
  }

  labels.forEach((label) => label.lookAt(camera.position));
  controls.update();
  renderer.render(scene, camera);
  if (badge) badge.update(LOOP ? LOOP.fps : 0);
}

let badge = null;

els.play.addEventListener("click", () => {
  playing = !playing;
  els.play.textContent = playing ? "暂停" : "播放";
  LOOP?.hold(playing ? 4000 : 600);
});

els.scrubber.addEventListener("input", () => {
  playing = false;
  els.play.textContent = "播放";
  setEvent(Number(els.scrubber.value));
  LOOP?.hold(700);
});

els.speed.addEventListener("change", () => {
  speed = Number(els.speed.value);
});

els.select.addEventListener("change", () => {
  playing = false;
  els.play.textContent = "播放";
  loadReplay(els.select.value);
});

window.addEventListener("resize", resize);
buildScene();
initBodyColorSelect();
resize();

// 无头验证 / 控制台调试接口（与 lanes.js 的 window.__LANES__ 对应）
window.__REPLAY__ = {
  get scene() { return scene; },
  get replay() { return replay; },
  get index() { return currentIndex; },
  setEvent,
  applyVehicle,
  get stats() {
    return LOOP ? { fps: LOOP.fps, spinning: LOOP.spinning, errors: LOOP.errorCount } : null;
  },
};
LOOP = createRenderLoop({
  onFrame,
  keepAlive: stillAnimating,
  minInterval: frameInterval(GPU.software),
});
badge = mountGpuBadge(document.querySelector(".event-head") || renderer.domElement.parentElement, GPU, "inline");
loadIndex().catch((error) => {
  els.title.textContent = "数据加载失败";
  els.timeline.replaceChildren();
  const item = document.createElement("li");
  const time = document.createElement("div");
  time.className = "time";
  time.textContent = "error";
  const summary = document.createElement("div");
  summary.className = "summary";
  summary.textContent = String(error);
  item.append(time, summary);
  els.timeline.append(item);
});
LOOP.wake(80);
