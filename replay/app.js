import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// ---------------------------------------------------------------------------
// 设备布局
//   通行设备（车道现场）沿车辆行驶方向（+Z）按理论顺序排布：
//     关道/摄像机 → 车牌识别 → 称重治超 → 车型识别 → 车检器1 → 前ETC天线
//     → 车检器2 → CPC读卡 → 车道控制器 → 车检器6 → 后ETC天线 → 费显 → 车检器7 → 栏杆
//   收费系统设备（交易/名单/计费/MQ/流水）不放在车道上，而是独立到右侧「虚拟机房」，
//   再由机房连到更远处的「虚拟省中心」。
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

// 收费系统：每台服务就是机房里的一台机柜
const ROOM_DEVICES = {
  service: { label: "交易服务", color: 0x75a7ff, rack: "标准机柜" },
  namelist: { label: "名单服务", color: 0x9b8cff, rack: "标准机柜" },
  fee: { label: "计费服务", color: 0x68d391, rack: "标准机柜" },
  mq: { label: "消息/MQ", color: 0xf687b3, rack: "标准机柜" },
  store: { label: "流水/Redis", color: 0x63b3ed, rack: "标准机柜" },
};

const deviceInfo = { ...LANE_DEVICES, ...ROOM_DEVICES };
const LANE_DEVICE_KEYS = Object.keys(LANE_DEVICES);
const ROOM_DEVICE_KEYS = Object.keys(ROOM_DEVICES);
// 需要和省中心交互的服务（流水/Redis 是本地落库，不上省中心）
const PROVINCE_LINKED_KEYS = new Set(["service", "namelist", "fee", "mq"]);

const ROOM = { x: 18, z: -2, halfW: 8, halfD: 6, height: 4.6 };
const PROVINCE = { x: 37.5, z: -2 };

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x151a20);

const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 400);
const PANORAMA = { position: [-33, 33, 49], target: [12, 1.5, 0] };
camera.position.set(...PANORAMA.position);
camera.lookAt(...PANORAMA.target);

const renderer = new THREE.WebGLRenderer({
  canvas: document.querySelector("#scene"),
  antialias: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(...PANORAMA.target);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 6;
controls.maxDistance = 190;
controls.maxPolarAngle = Math.PI * 0.48;
controls.update();

const VIEW_PRESETS = {
  panorama: { label: "全景", position: PANORAMA.position, target: PANORAMA.target },
  lane: { label: "车道现场", position: [-13, 8.5, -6], target: [0, 1.2, 2] },
  room: { label: "虚拟机房", position: [18, 7.5, 15], target: [18, 1.4, -1] },
  province: { label: "省中心", position: [30, 10, 21], target: [37.5, 4.5, -2] },
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
const links = [];
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

  buildMachineRoom();
  buildProvinceCenter();
  buildSiteLinks();
  renderViews();

  scene.add(makeVehicle());
  renderLegend();
}

function buildGround() {
  const ground = box(150, 0.08, 96, 0x191d23);
  ground.position.set(16, -0.1, 0);
  scene.add(ground);
  // 车道与机房之间的场坪
  const apron = box(26, 0.02, 30, 0x21262d);
  apron.position.set(15.5, -0.04, ROOM.z);
  scene.add(apron);
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

// ---------------------------------------------------------------------------
// 虚拟机房：收费系统服务各自一台机柜
// ---------------------------------------------------------------------------
function makeRackShell(color) {
  const shell = box(1.75, 2.4, 1.2, 0x252b33);
  shell.position.y = 1.5;
  const panel = box(1.5, 1.95, 0.08, color);
  panel.position.set(0, 1.55, 0.62);
  const slots = new THREE.Group();
  for (let index = 0; index < 5; index += 1) {
    const unit = box(1.34, 0.17, 0.06, 0x121820);
    unit.position.set(0, 0.8 + index * 0.37, 0.67);
    slots.add(unit);
  }
  const led = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 0.14, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x86efac, emissive: 0x1f7a4d, roughness: 0.4 })
  );
  led.position.set(0.62, 2.5, 0.63);
  return { shell, panel, slots, led };
}

function buildMachineRoom() {
  const slab = box(ROOM.halfW * 2 + 2.4, 0.3, ROOM.halfD * 2 + 2.4, 0x39414a);
  slab.position.set(ROOM.x, 0.15, ROOM.z);
  scene.add(slab);

  const wallMaterial = new THREE.MeshStandardMaterial({
    color: 0x8fb4d8,
    transparent: true,
    opacity: 0.13,
    roughness: 0.35,
    metalness: 0.1,
    side: THREE.DoubleSide,
  });
  [
    [ROOM.halfW * 2, ROOM.height, 0.1, ROOM.x, ROOM.z - ROOM.halfD],
    [ROOM.halfW * 2, ROOM.height, 0.1, ROOM.x, ROOM.z + ROOM.halfD],
    [0.1, ROOM.height, ROOM.halfD * 2, ROOM.x - ROOM.halfW, ROOM.z],
    [0.1, ROOM.height, ROOM.halfD * 2, ROOM.x + ROOM.halfW, ROOM.z],
  ].forEach(([width, height, depth, x, z]) => {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), wallMaterial);
    wall.position.set(x, ROOM.height / 2 + 0.3, z);
    scene.add(wall);
  });

  const roof = box(ROOM.halfW * 2 + 0.5, 0.16, ROOM.halfD * 2 + 0.5, 0x2f3640);
  roof.position.set(ROOM.x, ROOM.height + 0.3, ROOM.z);
  scene.add(roof);

  const banner = makeLabel("虚拟机房 · 收费系统", "#cfe6ff", 9);
  banner.position.set(ROOM.x, ROOM.height + 2.4, ROOM.z);
  scene.add(banner);

  ROOM_DEVICE_KEYS.forEach((key, index) => {
    const info = ROOM_DEVICES[key];
    const { shell, panel, slots, led } = makeRackShell(info.color);
    const group = new THREE.Group();
    const label = makeLabel(info.label, "#e6f0ff", 2.8);
    label.position.set(0, 3.1, 0);
    group.add(shell, panel, slots, led, label);
    const spacing = 3.1;
    group.position.set(ROOM.x + (index - (ROOM_DEVICE_KEYS.length - 1) / 2) * spacing, 0.3, ROOM.z + 2.4);
    scene.add(group);
    deviceMeshes.set(key, { group, body: panel, baseColor: info.color, pulse: 0 });
  });

  [["精密空调", 0x9fb4c8], ["配电柜", 0x9ca3af], ["核心交换/ODF", 0x8ab4f8]].forEach(([text, color], index) => {
    const group = new THREE.Group();
    const shell = box(1.5, 2.1, 1.1, 0x232931);
    shell.position.y = 1.35;
    const panel = box(1.28, 1.0, 0.07, color);
    panel.position.set(0, 1.6, 0.58);
    const label = makeLabel(text, "#c9d6e4", 2.6);
    label.position.set(0, 2.75, 0);
    group.add(shell, panel, label);
    group.position.set(ROOM.x + (index - 1) * 3.4, 0.3, ROOM.z - 3.2);
    scene.add(group);
  });
}

// ---------------------------------------------------------------------------
// 虚拟省中心
// ---------------------------------------------------------------------------
function buildProvinceCenter() {
  const slab = box(13, 0.3, 13, 0x39414a);
  slab.position.set(PROVINCE.x, 0.15, PROVINCE.z);
  scene.add(slab);

  const group = new THREE.Group();
  const levels = [
    { width: 9.4, height: 3.4, color: 0x2b323c },
    { width: 7.4, height: 3.6, color: 0x323a46 },
    { width: 5.0, height: 3.2, color: 0x3a4451 },
  ];
  const stripMaterial = new THREE.MeshStandardMaterial({
    color: 0x9fd8ff,
    emissive: 0x2f6f9e,
    roughness: 0.35,
  });
  let bottom = 0;
  levels.forEach(({ width, height, color }) => {
    const block = box(width, height, width, color);
    block.position.y = bottom + height / 2;
    group.add(block);
    for (let row = 0; row < 2; row += 1) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(width * 0.84, 0.14, 0.1), stripMaterial);
      strip.position.set(0, bottom + 0.9 + row * 1.4, width / 2 + 0.06);
      group.add(strip);
    }
    bottom += height;
  });

  const mast = cyl(0.09, 0.14, 3.4, 0x9ca3af, 12);
  mast.position.y = bottom + 1.7;
  const dish = cyl(0.85, 0.85, 0.18, 0xcfd8e3, 22);
  dish.position.set(0.9, bottom + 3.0, 0);
  dish.rotation.set(Math.PI * 0.3, 0, Math.PI * 0.15);
  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.3, 14, 14),
    new THREE.MeshStandardMaterial({ color: 0xffd166, emissive: 0x8a6a12, roughness: 0.4 })
  );
  beacon.position.y = bottom + 3.5;
  group.add(mast, dish, beacon);
  group.position.set(PROVINCE.x, 0, PROVINCE.z);
  scene.add(group);

  const banner = makeLabel("虚拟省中心 · 联网收费中心", "#d8f7ff", 12);
  banner.position.set(PROVINCE.x, bottom + 5.4, PROVINCE.z);
  scene.add(banner);
}

// ---------------------------------------------------------------------------
// 车道 → 机房 → 省中心 的连接链路
// ---------------------------------------------------------------------------
function makeLink(name, points, color) {
  const vectors = points.map((point) => new THREE.Vector3(...point));
  const path = new THREE.CurvePath();
  for (let index = 0; index < vectors.length - 1; index += 1) {
    path.add(new THREE.LineCurve3(vectors[index], vectors[index + 1]));
  }
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(vectors),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.18 })
  );
  scene.add(line);
  const packets = [];
  for (let index = 0; index < 3; index += 1) {
    const packet = new THREE.Mesh(
      new THREE.SphereGeometry(0.17, 10, 10),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0 })
    );
    scene.add(packet);
    packets.push({ mesh: packet, offset: index / 3 });
  }
  const link = { name, path, line, packets, color, active: false, clock: 0, speed: 0.42 };
  links.push(link);
  return link;
}

let laneRoomLink = null;
let roomProvinceLink = null;

function buildSiteLinks() {
  laneRoomLink = makeLink(
    "lane-room",
    [
      [LANE_DEVICES.lane.x + 0.6, 1.4, LANE_DEVICES.lane.z],
      [9.0, 1.4, LANE_DEVICES.lane.z],
      [9.0, 0.5, ROOM.z],
      [ROOM.x - ROOM.halfW, 0.5, ROOM.z],
    ],
    0x6ee7ff
  );
  roomProvinceLink = makeLink(
    "room-province",
    [
      [ROOM.x + ROOM.halfW, ROOM.height - 0.6, ROOM.z],
      [(ROOM.x + PROVINCE.x) / 2, ROOM.height + 2.4, (ROOM.z + PROVINCE.z) / 2],
      [PROVINCE.x - 4.7, 4.2, PROVINCE.z],
    ],
    0xffd166
  );
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
  const groups = [
    ["通行设备 · 车道现场", LANE_DEVICE_KEYS],
    ["收费系统 · 虚拟机房", ROOM_DEVICE_KEYS],
  ];
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

function makeVehicle() {
  const car = new THREE.Group();
  const body = box(1.65, 0.65, 3.2, 0x2f80ed);
  body.position.y = 0.58;
  const cab = box(1.35, 0.56, 1.25, 0x56ccf2);
  cab.position.set(0, 1.08, -0.45);
  const obu = box(0.34, 0.12, 0.22, 0xffd166);
  obu.name = "obuUnit";
  obu.position.set(0, 1.42, -0.88);
  const obuLabel = makeLabel("OBU车载单元", "#fff6cc");
  obuLabel.position.set(0, 2.05, -0.9);
  const wheelMat = mat(0x0b0f14);
  [-0.78, 0.78].forEach((x) => {
    [-1.05, 1.05].forEach((z) => {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.18, 18), wheelMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x, 0.28, z);
      car.add(wheel);
    });
  });
  car.add(body, cab, obu, obuLabel);
  car.name = "vehicle";
  car.position.set(0, 0, -28);
  return car;
}

function vehicle() {
  return scene.getObjectByName("vehicle");
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
    item.body.material.emissive = new THREE.Color(0x000000);
    item.body.scale.setScalar(1);
  });
  antennaEndpoints.forEach((item) => {
    item.mesh.material.emissive = new THREE.Color(0x000000);
    item.mesh.scale.setScalar(1);
  });
  coilMeshes.forEach((item) => {
    item.pulse = 0;
    item.body.material.emissive = new THREE.Color(0x000000);
    item.body.material.opacity = coilStates.get(item.body.userData.coilId) ? 0.78 : 0.38;
  });
  const active = deviceMeshes.get(event.device) || deviceMeshes.get("service");
  // 被车道类型过滤掉的设备（如 ETC 车道里的称重），在它自己的事件里临时显示
  profileObjects.forEach(({ object }) => {
    object.visible = object.userData.profileVisible !== false;
  });
  if (active?.group) active.group.visible = true;
  if (event.device === "rsu") {
    const endpoint = communicationAntennaForVehicle();
    if (endpoint) {
      endpoint.mesh.material.emissive = new THREE.Color(deviceInfo.rsu.color).multiplyScalar(1.1);
      endpoint.mesh.scale.setScalar(1.18);
    }
  } else {
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
  // 链路动画：机房服务事件点亮「车道→机房」，与省中心交互的服务点亮「机房→省中心」
  if (laneRoomLink) laneRoomLink.active = ROOM_DEVICE_KEYS.includes(event.device);
  if (roomProvinceLink) roomProvinceLink.active = PROVINCE_LINKED_KEYS.has(event.device);
  [...els.legend.children].forEach((item) => {
    item.classList.toggle("active", item.dataset.device === event.device);
  });

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
  [...els.timeline.children].forEach((li, index) => {
    li.classList.toggle("active", index === currentIndex);
    if (index === currentIndex) li.scrollIntoView({ block: "nearest" });
  });
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
}

function animate(now) {
  requestAnimationFrame(animate);
  const dt = (now - lastTick) / 1000;
  lastTick = now;

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
    const intensity = item.pulse * 0.95;
    item.body.material.emissive = new THREE.Color(item.baseColor).multiplyScalar(intensity);
    item.body.scale.setScalar(1 + item.pulse * 0.1);
  });

  coilMeshes.forEach((item) => {
    item.pulse = Math.max(0, item.pulse - dt * 1.8);
    const intensity = item.pulse * 1.2;
    item.body.material.emissive = new THREE.Color(item.baseColor).multiplyScalar(intensity);
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
      const obuPosition = new THREE.Vector3();
      obuUnit()?.getWorldPosition(obuPosition);
      const endpoint = communicationAntennaForVehicle();
      const antennaPosition = new THREE.Vector3(0, 3.9, deviceInfo.rsu.z);
      if (endpoint) {
        endpoint.mesh.getWorldPosition(antennaPosition);
        endpoint.mesh.material.emissive = new THREE.Color(deviceInfo.rsu.color).multiplyScalar(0.95);
        endpoint.mesh.scale.setScalar(1.14);
      }
      const points = [
        antennaPosition,
        obuPosition,
      ];
      communicationBeam.geometry.setFromPoints(points);
    }
  }

  links.forEach((link) => {
    if (link.active) link.clock += dt * link.speed;
    link.line.material.opacity = THREE.MathUtils.lerp(
      link.line.material.opacity,
      link.active ? 0.85 : 0.18,
      0.12
    );
    const target = link.active ? 0.95 : 0;
    link.packets.forEach((packet) => {
      packet.mesh.position.copy(link.path.getPoint((link.clock + packet.offset) % 1));
      packet.mesh.material.opacity = THREE.MathUtils.lerp(packet.mesh.material.opacity, target, 0.12);
    });
  });

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
}

els.play.addEventListener("click", () => {
  playing = !playing;
  els.play.textContent = playing ? "暂停" : "播放";
});

els.scrubber.addEventListener("input", () => {
  playing = false;
  els.play.textContent = "播放";
  setEvent(Number(els.scrubber.value));
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
resize();
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
requestAnimationFrame(animate);
