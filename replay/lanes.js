// 多车道过程视图：把 ES 里按 landId 汇总出来的「一条条过车过程」放到同一个收费站场景里，
// 用同一个时间游标驱动多条车道的过程回放。数据由 generate_lane_data.py 生成。
//
// 单条车道的现场布局（路面/收费岛/收费亭/线圈/龙门架/费显/栏杆/路侧立柱）与 index.html
// 里的车道现场完全一致，几何定义见 lane-kit.js；本文件负责：
//   1. 把每条车道的设备状态时间线（线圈压上/释放、栏杆抬/落…）挂到时间游标上；
//   2. 状态超时（线圈压着不放、栏杆抬着不落、过程跨度过大）时让设备红色闪烁；
//   3. 在泳道区画出每条车道的设备状态时间线条带。
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createRenderer, createRenderLoop, detectGpu, frameInterval, mountGpuBadge } from "./render-runtime.js";
import { COILS, DEVICES, GANTRIES, LAYOUT, buildArrowField, buildLaneSite } from "./lane-kit.js";
import { buildVehicleModel, createBrakeController, setShadowTint, setSunDirection, axleLayout, PLATE_STYLE } from "./vehicle-models.js";
import { addGroundHaze, applyRenderLook, applyShadowFlags, asphaltMaterial, createBloomPipeline, setupSky } from "./scene-look.js";
import { buildDistantHorizon, buildScenery } from "./scenery.js";
import { BARRIER, barrierAngleAt } from "./barrier-arm.js";
import { buildWeathering, groundRoughness } from "./weathering.js";
import { addContactAO } from "./contact-ao.js";
import { addPropShadows } from "./prop-shadows.js";

// 车道间距：车道现场本体横向占 -3.78(岛尾) ~ +2.65(右路肩)，相邻车道再留一条路肩间隙
const PITCH = 7.4;
const ROAD_HALF = LAYOUT.roadWidth / 2;
const Z_MIN = LAYOUT.zMin;
const Z_MAX = LAYOUT.zMax;
const FADE_MS = 20000;      // 过车结束后状态灯保持多久

const DEVICE_Z = Object.fromEntries(Object.entries(DEVICES).map(([key, info]) => [key, info.z]));
const COIL_Z = Object.fromEntries(Object.entries(COILS).map(([key, info]) => [key, info.z]));
const RSU_Z = GANTRIES.map((item) => item.z);
const DEVICE_COLOR = Object.fromEntries(Object.entries(DEVICES).map(([key, info]) => [key, info.color]));
const DEVICE_LABEL = Object.fromEntries(Object.entries(DEVICES).map(([key, info]) => [key, info.label]));

// 超时判定阈值：状态进来之后迟迟不翻转，就是"卡住"了
const TIMEOUT = {
  coilMs: 20000,     // 线圈压上超过 20s 没释放
  barrierMs: 30000,  // 抬杆后超过 30s 没落杆
  passageMs: 90000,  // 单趟过程跨度超过 90s
};

// 时间线区域（泳道）的最小高度，以及给它留出的最小三维视野高度
const SWIM_MIN = 84;
const STAGE_MIN = 250;
const SWIM_STORE_KEY = "lanes.swimHeight";

const COLORS = {
  run: 0x3777b8,
  pass: 0x159879,
  block: 0xd1483f,
  idle: 0x4a5563,
  mixed: 0xd88727,
  unknown: 0x6b7683,
  timeout: 0xff3b30,
};

const STATE = {
  data: null,
  lanes: [],
  models: new Map(),
  span: 1,
  t: 0,
  playing: false,
  speed: 4,
  selected: null,
  liveKeys: new Set(),
  barEls: new Map(),
  pillText: new Map(),
  nodeCursor: -1,
  lastClock: "",
  lastSlider: -1,
  timeouts: new Map(),
  flashCount: 0,
  swimHeight: 0,
  showStates: true,
  showDetails: true,
  flashEnabled: true,
  timeoutKey: "",
  // 交互：选中的车道（三维高亮跟着它走）、拦截/超时清单、单车道通行回放
  selectedLane: null,
  highlightAt: 0,
  incidents: [],
  filter: "all",        // all | block | timeout
  laneFilter: null,     // 只列这条车道的车；null = 全部车道
  focus: null,          // { laneId, passageI, from, to }：下钻到的单车道通行回放
  camTween: null,
  soloLogs: [],         // data/index.json：有单车日志时才能给"单车日志回放"深链
};

const dom = {};

// GPU 探测放在模块顶层：循环的帧率上限要按"是否软件渲染"来定
const GPU = detectGpu();

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
boot().catch((error) => {
  dom.hud.innerHTML = `<span class="pill">加载失败：${String(error.message || error)}</span>`;
  console.error(error);
});

async function boot() {
  dom.canvas = document.getElementById("scene");
  dom.hud = document.getElementById("hud");
  dom.clock = document.getElementById("clock");
  dom.summary = document.getElementById("summary");
  dom.laneList = document.getElementById("laneList");
  dom.detail = document.getElementById("detail");
  dom.swimRows = document.getElementById("swimRows");
  dom.swimScale = document.getElementById("swimScale");
  dom.swimCursor = document.getElementById("swimCursor");
  dom.swimResizer = document.getElementById("swimResizer");
  dom.main = document.querySelector("main");
  dom.controls = document.querySelector(".controls");
  dom.playBtn = document.getElementById("playBtn");
  dom.speedSel = document.getElementById("speedSel");
  dom.scrub = document.getElementById("scrub");
  dom.timeLabel = document.getElementById("timeLabel");
  dom.resetBtn = document.getElementById("resetBtn");
  dom.stationLine = document.getElementById("stationLine");
  dom.windowLine = document.getElementById("windowLine");
  dom.timeoutLine = document.getElementById("timeoutLine");
  dom.timeoutPill = document.getElementById("timeoutPill");
  dom.stateToggle = document.getElementById("stateToggle");
  dom.detailToggle = document.getElementById("detailToggle");
  dom.flashToggle = document.getElementById("flashToggle");
  dom.alertPanel = document.getElementById("alertPanel");
  dom.alertBody = document.getElementById("alertBody");
  dom.alertCount = document.getElementById("alertCount");
  dom.alertToggle = document.getElementById("alertToggle");
  // 单车道通行回放：聚焦条
  dom.focusBar = document.getElementById("focusBar");
  dom.focusLane = document.getElementById("focusLane");
  dom.focusRange = document.getElementById("focusRange");
  dom.focusResult = document.getElementById("focusResult");
  dom.focusReplay = document.getElementById("focusReplay");
  dom.focusBack = document.getElementById("focusBack");
  dom.focusDeepLink = document.getElementById("focusDeepLink");
  // 左侧悬浮：拦截 / 超时车辆清单
  dom.vehicleFloat = document.getElementById("vehicleFloat");
  dom.vehicleFloatBody = document.getElementById("vehicleFloatBody");
  dom.vehicleFloatCount = document.getElementById("vehicleFloatCount");
  dom.vehicleFloatScope = document.getElementById("vehicleFloatScope");
  dom.vehicleFloatHint = document.getElementById("vehicleFloatHint");
  dom.vehicleFloatToggle = document.getElementById("vehicleFloatToggle");
  dom.vfChips = [...document.querySelectorAll(".vf-chip")];

  const response = await fetch("./data/lanes.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`data/lanes.json ${response.status}（先跑 generate_lane_data.py）`);
  STATE.data = await response.json();

  const minutes = STATE.data.window.minutes || 1;
  STATE.span = minutes * 60000;
  STATE.lanes = STATE.data.lanes.filter((lane) => lane.passages.length > 0);
  for (const lane of STATE.lanes) {
    lane.rel = lane.passages.map((passage) => ({ passage, o0: passage.o0 - STATE.data.window.offsetMs, o1: passage.o1 - STATE.data.window.offsetMs }));
    lane.tracks = new Map();
    for (const entry of lane.rel) lane.tracks.set(entry.passage.i, buildTrack(entry.passage));
    prepareSignals(lane);
  }

  STATE.gpu = GPU;
  buildScene();
  buildHeader();
  buildSummary();
  buildLaneList();
  buildSwim();
  buildHud();
  bindControls();
  bindSwimResize();
  // 拦截/超时清单与单车道下钻：数据在 lanes.json 里就能算出来，不依赖单车日志
  buildIncidents();
  bindVehicleFloat();
  bindFocusBar();
  renderVehicleFloat();
  // 单车日志清单（index.json 里有什么就认什么）：取不到就当作没有对应日志，本页功能不受影响
  fetch("./data/index.json", { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : []))
    .then((list) => {
      STATE.soloLogs = Array.isArray(list) ? list : [];
      if (STATE.focus) renderFocusBar(STATE.focus);
    })
    .catch(() => {});
  STATE.badge = mountGpuBadge(document.querySelector(".side-head"), STATE.gpu, "inline");
  window.addEventListener("resize", resize);
  resize();

  LOOP.wake(80);
}

// ---------------------------------------------------------------------------
// 设备状态时间线
// ---------------------------------------------------------------------------
/**
 * 把生成器给的整窗口信号（线圈压上/释放、栏杆抬/落）整理成状态区间。
 * 每条轨道的结构：
 *   transitions: [{t, s, at, text}]   相对窗口起点的状态跳变
 *   intervals:   [{t0, t1, s, ms, timedOut}]  每一跳变持续到下一次跳变（最后一跳到窗口结束）
 *   timeouts:    intervals 里超时的那些
 */
function buildStateTrack(rawSeries, span, thresholdMs, activeWhen) {
  const transitions = [];
  let last = null;
  for (const item of rawSeries) {
    const t = Math.max(0, Math.min(span, item.o - STATE.data.window.offsetMs));
    // 线圈信号是布尔，栏杆信号是 "up"/"down" 字符串，统一成布尔
    const state = item.s === true || item.s === "up";
    if (last === state) continue;
    last = state;
    transitions.push({ t, s: state, at: item.t, text: item.x || "" });
  }
  const intervals = [];
  for (let index = 0; index < transitions.length; index += 1) {
    const from = transitions[index];
    const next = transitions[index + 1];
    const t1 = next ? next.t : span;
    const ms = Math.max(0, t1 - from.t);
    intervals.push({
      t0: from.t,
      t1,
      s: from.s,
      ms,
      at: from.at,
      text: from.text,
      timedOut: from.s === activeWhen && ms > thresholdMs,
    });
  }
  return {
    transitions,
    intervals,
    timeouts: intervals.filter((item) => item.timedOut),
    noData: transitions.length === 0,
    thresholdMs,
  };
}

function prepareSignals(lane) {
  const raw = lane.signals || { coils: {}, barrier: [] };
  const span = STATE.span;
  const coils = new Map();
  for (const coilId of Object.keys(COILS)) {
    const series = (raw.coils && raw.coils[coilId]) || [];
    coils.set(coilId, buildStateTrack(series, span, TIMEOUT.coilMs, true));
  }
  const barrier = buildStateTrack(raw.barrier || [], span, TIMEOUT.barrierMs, true);

  // 过程超时：整段跨度超过阈值
  const passageTimeouts = new Set();
  for (const passage of lane.passages) if (passage.durationMs > TIMEOUT.passageMs) passageTimeouts.add(passage.i);

  // 设备活动时间点（来自过程节点），用于 3D 里给设备打脉冲 + 画"设备事件"轨
  const ticks = [];
  for (const entry of lane.rel) {
    for (const node of entry.passage.nodes) {
      ticks.push({ t: Math.max(0, Math.min(span, node.o - STATE.data.window.offsetMs)), device: node.device, text: node.text, kind: node.kind, severity: node.severity });
    }
  }
  ticks.sort((a, b) => a.t - b.t);
  const deviceTimes = new Map();
  for (const tick of ticks) {
    if (!deviceTimes.has(tick.device)) deviceTimes.set(tick.device, []);
    deviceTimes.get(tick.device).push(tick.t);
  }

  lane.signals = { coils, barrier, ticks, deviceTimes, passageTimeouts };
}

/** 取某个时刻的状态（最后一次跳变），并判断当前所处区间是否已超时 */
function signalStateAt(track, t) {
  const transitions = track.transitions;
  let index = -1;
  for (let i = 0; i < transitions.length; i += 1) {
    if (transitions[i].t <= t) index = i;
    else break;
  }
  if (index < 0) return { state: null, timedOut: false, at: null, index: -1, interval: null };
  const interval = track.intervals[index] || null;
  return {
    state: transitions[index].s,
    at: transitions[index].at,
    timedOut: Boolean(interval && interval.timedOut),
    interval,
    index,
  };
}

function lastAtOrBefore(list, t) {
  if (!list || !list.length) return null;
  let low = 0;
  let high = list.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (list[mid] <= t) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found < 0 ? null : list[found];
}

// ---------------------------------------------------------------------------
// 三维场景
// ---------------------------------------------------------------------------
function buildScene() {
  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 700);
  camera.position.set(0, 58, 76);
  camera.lookAt(0, 0, 2);

  const renderer = createRenderer(dom.canvas, STATE.gpu);
  applyRenderLook(renderer, STATE.gpu);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 2);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 8;
  controls.maxDistance = 260;
  controls.addEventListener("change", () => LOOP.hold(500));

  // 天空 + 环境反射 + 太阳与阴影（正午太阳偏高；软件渲染自动关阴影）
  const look = setupSky(scene, renderer, { software: STATE.gpu.software });
  STATE.followSky = look.followSky;
  STATE.sunDirection = look.direction;      // 接地暗部的假影方向要跟着太阳走
  STATE.shadowTint = look.shadowTint;       // 硬影层要用同一个乘数（两层的影色必须一样）
  setSunDirection(look.direction);          // 车辆接地阴影同理（与接地暗部共用 scene-look 的取法）
  setShadowTint(look.shadowTint);           // 影色按场景灯光算：影子里只剩天光（乘数贴在贴图里）

  // 泛光 + 统一色调映射管线：太阳/警示灯/刹车灯/状态灯的光晕。
  // 软件渲染下不建泛光 pass（省一遍全屏模糊），但同样走 RT+OutputPass，画面与 GPU 一致。
  STATE.bloom = createBloomPipeline(renderer, scene, camera, { enabled: !STATE.gpu.software });
  STATE.followSky(camera);   // 天空穹顶挂在相机上，先摆好再画第一帧

  const width = STATE.lanes.length * PITCH + 30;
  const ground = new THREE.Mesh(
    new THREE.BoxGeometry(width + 60, 0.1, 170),
    asphaltMaterial({
      color: "#666d76",
      repeat: [Math.round((width + 60) / 2), 85],
      roughness: 0.95,
      roughnessMap: groundRoughness([Math.max(3, Math.round((width + 60) / 20)), 8]),
    }),
  );
  ground.position.y = -0.06;
  ground.receiveShadow = true;
  ground.name = "plazaGround";
  scene.add(ground);

  buildStationBuilding(scene, 0, Z_MIN - 9, width);

  const half = (STATE.lanes.length - 1) / 2;
  // 行车方向箭头：整片广场合成一个 InstancedMesh
  const arrowPositions = [];
  STATE.lanes.forEach((lane, index) => {
    const x = (index - half) * PITCH;
    for (let z = -24; z <= 26; z += 12) {
      for (const dx of [-1.35, 1.35]) arrowPositions.push({ x: x + dx, z });
    }
  });
  scene.add(buildArrowField(arrowPositions));

  STATE.lanes.forEach((lane, index) => {
    const model = createLaneModel(lane, (index - half) * PITCH);
    scene.add(model.group);
    STATE.models.set(lane.id, model);
  });

  STATE.scene = scene;
  STATE.camera = camera;
  STATE.renderer = renderer;
  STATE.controls = controls;

  // 场地外围道具：护栏、路灯、行道树（护栏摆在广场长边外，进出车道方向留空）
  scene.add(buildScenery({ halfWidth: (width + 60) / 2, zMin: -85, zMax: 85 }));

  // 几何全部建好后再统一分配阴影角色：大块地面只接收、设备与车辆投射+接收
  applyShadowFlags(scene);
  addGroundHaze(scene);

  // 地面风化与远景层次：放在 applyShadowFlags 之后，免得被当成场内物体乱给阴影角色
  const halfWidth = (width + 60) / 2;
  const islandXs = STATE.lanes.map((_, index) => (index - half) * PITCH + 3.25);
  scene.add(buildWeathering({
    halfWidth, zMin: -85, zMax: 85, islandXs, y: 0.006, patches: 10, cracks: 12, grates: 4, manholes: 3,
  }));
  scene.add(buildDistantHorizon({ z: -205, spread: 280 }));

  // 最后一步：给所有立在地上的构件补接地暗部与正午软影（软件渲染关阴影时全靠它"落地"）
  rebuildContactAO();
}

function buildStationBuilding(scene, x, z, width) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(Math.min(width * 0.7, 46), 6.4, 7),
    new THREE.MeshStandardMaterial({ color: 0x2b333e, roughness: 0.85 })
  );
  body.position.set(x, 3.2, z);
  group.add(body);

  const canopy = new THREE.Mesh(
    new THREE.BoxGeometry(Math.min(width * 0.82, 54), 0.4, 9),
    new THREE.MeshStandardMaterial({ color: 0x3a4653, roughness: 0.8 })
  );
  canopy.position.set(x, 6.6, z);
  group.add(canopy);

  const label = makeLabel(STATE.data.station ? `${STATE.data.station} 收费站` : "收费站", "多车道过程", "#9fd0ff");
  label.position.set(x, 11, z);
  group.add(label);

  scene.add(group);
}

// ---------------------------------------------------------------------------
// 单条车道：布局直接复用 index.html 的现场构件
// ---------------------------------------------------------------------------
function createLaneModel(lane, x) {
  const first = lane.passages?.[0]?.vehicle || null;
  const site = buildLaneSite({ id: lane.id, sub: laneSub(lane), details: STATE.showDetails, vehicle: first });
  site.group.position.set(x, 0, 0);
  site.vehiclePassage = lane.passages?.[0]?.i ?? null;
  // 初始车也是真车：给它一套刹车灯控制器（否则「本趟过程一直是第 0 趟」的车道永远没有刹车灯）
  site.brakeController = createBrakeController();
  site.vehicleModel?.setBrake?.(0);
  site.highlight = buildLaneHighlight(site.group);
  return { ...site, lane, x, status: "idle", statusColor: COLORS.idle };
}

/**
 * 车道高亮层：给每条车道挂一层"点亮"用的自发光几何。
 *
 * 为什么不直接改车道模型自己的材质：`lane-kit.buildLaneSite` 里的静态构件走的是**跨车道共用的
 * 材质缓存**（`staticMat`），改一条车道的材质会连带改掉所有车道 —— 而高亮只该亮一条。
 * 所以这里独立建一层加色混合的自发光薄片：不吃灯光、不写深度、明确标 noShadow/noAO，
 * 免得被 `applyShadowFlags` 收进阴影贴图、被 `contact-ao` 当成"立在地上的构件"清点
 * （那两份计数是自检的基线，不能被这层装饰改动）。
 */
function buildLaneHighlight(group) {
  const holder = new THREE.Group();
  holder.name = "laneHighlight";
  holder.userData.noShadow = true;
  holder.userData.noAO = true;
  holder.visible = false;

  // 地面光带：逐像素算 alpha 做四边衰减，避免"一个方块压在路上"
  const glowMaterial = new THREE.MeshBasicMaterial({
    map: laneGlowTexture(),
    color: 0x74c4ff,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(LAYOUT.roadWidth + 2.6, LAYOUT.roadLength), glowMaterial);
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.07;   // 压过车位标线(0.035)与路肩(0.06)，又低于收费岛
  holder.add(glow);

  // 左右边界光带：把这条车道的边界勾出来
  const edgeMaterial = new THREE.MeshBasicMaterial({
    color: 0x9bd8ff,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const edgeGeometry = new THREE.BoxGeometry(0.16, 0.07, LAYOUT.roadLength);
  const brackets = [];
  for (const side of [-1, 1]) {
    const edge = new THREE.Mesh(edgeGeometry, edgeMaterial);
    edge.position.set(side * (LAYOUT.roadWidth / 2 + 0.42), 0.09, 0);
    holder.add(edge);
  }

  // 四个角标（靶框）：车道两端各一对，一眼看出锁的是哪一段
  const bracketMaterial = new THREE.MeshBasicMaterial({
    color: 0xbfe9ff,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const bracketGeometry = new THREE.BoxGeometry(0.32, 0.09, 2.6);
  for (const zSide of [-1, 1]) {
    for (const xSide of [-1, 1]) {
      const bracket = new THREE.Mesh(bracketGeometry, bracketMaterial);
      bracket.position.set(xSide * (LAYOUT.roadWidth / 2 + 0.42), 0.1, zSide * (LAYOUT.roadLength / 2 - 1.6));
      holder.add(bracket);
      brackets.push(bracket);
    }
  }

  holder.traverse((child) => {
    if (!child.isMesh) return;
    child.userData.noShadow = true;
    child.userData.noAO = true;
    child.renderOrder = 3;
  });
  group.add(holder);
  return { group: holder, glow, brackets, materials: [glowMaterial, edgeMaterial, bracketMaterial] };
}

/** 光带贴图：横向（车宽方向）与纵向（车长方向）各衰减一次，再相乘。 */
function laneGlowTexture() {
  if (laneGlowTexture.texture) return laneGlowTexture.texture;
  const width = 64;
  const height = 256;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(width, height);
  const fade = (value) => Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, value))), 1.7);
  for (let y = 0; y < height; y += 1) {
    const fy = fade((y + 0.5) / height);
    for (let x = 0; x < width; x += 1) {
      const alpha = Math.round(255 * fade((x + 0.5) / width) * fy);
      const index = (y * width + x) * 4;
      image.data[index] = 255;
      image.data[index + 1] = 255;
      image.data[index + 2] = 255;
      image.data[index + 3] = alpha;
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  laneGlowTexture.texture = texture;
  return texture;
}

/**
 * 每帧刷新高亮强度。选中瞬间给一次衰减脉冲（看得出"刚才点了它"），播放中持续呼吸，
 * 静止时停在固定亮度 —— 静止不打 keepAlive，不为了这一层装饰让页面一直出帧。
 */
function applyLaneHighlight(now, playing) {
  const since = (now - STATE.highlightAt) / 1000;
  const pop = since < 0.9 ? 1 - since / 0.9 : 0;
  const pulse = playing ? 0.5 + 0.5 * Math.sin(now / 320) : 0;
  const level = Math.max(pop, pulse * 0.7);
  STATE.highlightLevel = level;
  const focusId = STATE.focus ? STATE.focus.laneId : null;
  STATE.models.forEach((model, laneId) => {
    const highlight = model.highlight;
    if (!highlight) return;
    const on = laneId === STATE.selectedLane;
    highlight.group.visible = on && model.group.visible !== false;
    if (!on) return;
    const focused = laneId === focusId;
    const base = focused ? 0.34 : 0.22;
    const amp = focused ? 0.32 : 0.24;
    highlight.materials[0].opacity = base + amp * level;
    highlight.materials[1].opacity = base * 1.9 + amp * 1.5 * level;
    highlight.materials[2].opacity = base * 1.6 + amp * 1.2 * level;
  });
}

function laneSub(lane) {
  const m = lane.metrics;
  return `过程 ${m.passages} · 放行 ${m.released} · 拦截 ${m.blocked}`;
}

/**
 * 重建接地暗部（`contact-ao.js`）与硬影层（`prop-shadows.js`）。为什么要能重建：岗亭与收费设备是挂在
 * 「细节」组里的，关掉细节它们会一起消失，而这两层都是按加载时的场景快照铺的 —— 不重建就会留下一地
 * 幽灵暗斑/幽灵影子。几何/材质在模块里缓存，重建只新建一个缓冲。
 */
function rebuildContactAO() {
  // 必须走 STATE.scene：页面里有 <canvas id="scene">，浏览器会把 id 暴露成全局变量，
  // 在模块作用域里写裸 `scene` 会拿到那个 canvas 元素（不是 THREE.Scene），报的却是
  // "getObjectByName is not a function" 这种看不出根因的错。
  const target = STATE.scene;
  for (const layer of ["contactAO", "propShadows"]) {
    const previous = target.getObjectByName(layer);
    if (previous) {
      previous.traverse((child) => {
        if (child.geometry && child.geometry.userData.propShadow) child.geometry.dispose();
        if (child.isInstancedMesh) child.dispose();
      });
      target.remove(previous);
    }
  }
  const ao = addContactAO(target, { direction: STATE.sunDirection });
  STATE.contactAO = { count: ao.count, candidates: ao.candidates };
  const props = addPropShadows(target, {
    direction: STATE.sunDirection,
    tint: STATE.shadowTint,
    ground: { minX: -74.6, maxX: 74.6, minZ: -85, maxZ: 85 },
  });
  STATE.propShadows = { count: props.count, candidates: props.candidates };
  return STATE.contactAO.count;
}

/** 「细节」开关的唯一入口：模型与暗部一起切，避免两边状态不一致。 */
function applyDetails() {
  STATE.models.forEach((model) => {
    model.fine.visible = STATE.showDetails;
  });
  rebuildContactAO();
  LOOP.hold(400);
}

// ---------------------------------------------------------------------------
// 车辆轨迹：按过程节点里的设备位置推算 z，并保证单向推进
// ---------------------------------------------------------------------------
function buildTrack(passage) {
  const points = [];
  let last = -24;
  for (const node of passage.nodes) {
    let z = null;
    const coilMatch = node.coil ? node.coil.match(/车检器(\d+)/) : null;
    if (coilMatch && COIL_Z[coilMatch[1]] !== undefined) z = COIL_Z[coilMatch[1]];
    else if (DEVICE_Z[node.device] !== undefined) z = DEVICE_Z[node.device];
    else if (node.device === "rsu") z = last < 0 ? RSU_Z[0] : RSU_Z[1];
    if (z === null || z < last) z = last;
    last = z;
    points.push({ o: node.o, z });
  }
  if (!points.length) points.push({ o: passage.o0, z: -24 });
  return points;
}

function zAt(track, offsetInDay) {
  if (offsetInDay <= track[0].o) return track[0].z;
  const last = track[track.length - 1];
  if (offsetInDay >= last.o) return last.z;
  for (let index = 1; index < track.length; index += 1) {
    const a = track[index - 1];
    const b = track[index];
    if (offsetInDay <= b.o) {
      const ratio = b.o === a.o ? 1 : (offsetInDay - a.o) / (b.o - a.o);
      return a.z + (b.z - a.z) * ratio;
    }
  }
  return last.z;
}

function resultColor(result) {
  if (result === "放行") return COLORS.pass;
  if (result === "拦截") return COLORS.block;
  if (result === "混合") return COLORS.mixed;
  return COLORS.unknown;
}

/** 按本趟过程的车辆属性重建车辆模型（车型/轴数/真实长宽高/车牌颜色都来自日志）。 */
function setLaneVehicle(model, passage) {
  const spec = passage.vehicle || null;
  model.vehicle.clear();
  // 换车时释放上一辆车自己的材质（尾灯/刹车灯光晕/结果标记）
  model.vehicleModel?.dispose?.();
  const built = buildVehicleModel(
    spec || { kind: "car", axles: 2, dims: { length: 4.7, width: 1.85, height: 1.5 }, plate: "", plateColorCode: null },
    { detail: true },
  );
  built.group.name = "vehicle";
  model.vehicle.add(built.group);
  applyShadowFlags(built.group);
  model.vehicleModel = built;
  model.vehicleMarker = built.marker;
  model.vehicleBody = built.body;
  model.vehicleSpec = spec;
  model.vehiclePassage = passage.i;
  model.vehicle.userData.lastZ = null;
  model.brakeController = createBrakeController();
  built.setBrake(0);
  return built;
}

// ---------------------------------------------------------------------------
// 时间状态
// ---------------------------------------------------------------------------
function laneStateAt(lane, t) {
  let active = null;
  let recent = null;
  for (const entry of lane.rel) {
    if (t >= entry.o0 && t <= entry.o1) {
      active = entry;
      break;
    }
  }
  if (!active) {
    for (let index = lane.rel.length - 1; index >= 0; index -= 1) {
      const entry = lane.rel[index];
      if (entry.o1 <= t && t - entry.o1 <= FADE_MS) {
        recent = entry;
        break;
      }
    }
  }
  return { active, recent };
}

function statusOf(entry, isActive) {
  if (!entry) return "idle";
  if (entry.passage.result === "拦截") return "block";
  if (entry.passage.result === "放行") return isActive ? "run" : "pass";
  return isActive ? "run" : "unknown";
}

// ---------------------------------------------------------------------------
// 按需渲染循环：只有播放中 / 相机交互 / 状态变化 / 超时闪烁时才出帧，空闲时完全停掉 RAF
// ---------------------------------------------------------------------------
const LOOP = createRenderLoop({
  onFrame,
  keepAlive: () => STATE.playing || STATE.flashCount > 0 || Boolean(STATE.camTween),
  minInterval: frameInterval(GPU.software),
});

function onFrame(dt, now) {
  if (STATE.playing && STATE.span > 0) {
    STATE.t += dt * 1000 * STATE.speed;
    if (STATE.focus) {
      // 单车道通行回放：走到本趟结束就停住，不要绕回窗口开头（下钻看的是一趟过程）
      if (STATE.t >= STATE.focus.to) {
        STATE.t = STATE.focus.to;
        STATE.playing = false;
        dom.playBtn.textContent = "播放";
      }
    } else if (STATE.t >= STATE.span) {
      STATE.t = 0;
    }
  }

  updateCamTween(dt);
  updateScene(dt, now);
  applyLaneHighlight(now, STATE.playing);
  updateLiveBars();
  highlightNode();
  syncTimeUi();

  STATE.controls.update();
  STATE.followSky?.(STATE.camera);
  STATE.bloom.render();
  if (STATE.badge) STATE.badge.update(LOOP.fps);
}

function updateScene(dt, now) {
  const t = STATE.t;
  const offset = STATE.data.window.offsetMs;
  // 2Hz 闪烁相位：3D 里的超时设备用它在红/暗之间切换
  const flashOn = STATE.flashEnabled && Math.sin(now / 260) > 0;
  let flashCount = 0;
  const clock = new Map();
  STATE.timeouts = new Map();
  STATE.laneStates = new Map();
  const barrierPoses = new Map();
  STATE.barrierPoses = barrierPoses;

  for (const lane of STATE.lanes) {
    const model = STATE.models.get(lane.id);
    const state = laneStateAt(lane, t);
    STATE.laneStates.set(lane.id, state);
    if (!model || model.group.visible === false) continue;

    const timeouts = [];

    // ---- 线圈：压上/释放 + 超时红闪 ----
    for (const [coilId, coil] of model.coils) {
      const track = lane.signals.coils.get(coilId);
      const signal = track ? signalStateAt(track, t) : { state: null, timedOut: false };
      const active = signal.state === true;
      coil.pulse = Math.max(0, coil.pulse - dt * 1.8);
      const material = coil.body.material;
      if (signal.timedOut) {
        flashCount += 1;
        material.emissive.setHex(COLORS.timeout).multiplyScalar(flashOn ? 1.15 : 0.18);
        material.opacity = flashOn ? 0.95 : 0.42;
        coil.group.scale.setScalar(flashOn ? 1.32 : 1.02);
        timeouts.push({
          kind: "线圈",
          name: `线圈${coilId} 压上`,
          target: `线圈${coilId}`,
          label: COILS[coilId].label,
          signal,
          track,
          interval: signal.interval,
          thresholdMs: TIMEOUT.coilMs,
          active: true,
          evidence: (signal.interval && signal.interval.text) || "",
          jumps: track ? track.transitions.length : 0,
        });
      } else {
        material.emissive.setHex(coil.baseColor).multiplyScalar(coil.pulse * 1.2);
        material.opacity = active ? 0.78 : 0.38;
        coil.group.scale.setScalar(1 + coil.pulse * 0.18);
      }
    }

    // ---- 栏杆：抬/落 + 超时红闪（没有栏杆信号时退回按过程结果推断） ----
    const barrierSignal = signalStateAt(lane.signals.barrier, t);
    const armDevice = model.devices.get("barrier");
    let barrierOpen = barrierSignal.state === true;
    if (barrierSignal.state === null) {
      const entry = state.active || state.recent;
      if (entry) {
        const passage = entry.passage;
        const node = passage.nodes.find((item) => item.barrier === "抬杆" || item.device === "barrier");
        if (passage.result === "拦截") barrierOpen = false;
        else if (node) barrierOpen = t + offset >= node.o;
        else barrierOpen = !state.active;
      }
    }
    if (model.barrier) {
      // 角度 = 跳变序列 + 当前时刻的纯函数（见 barrier-arm.js）：拖时间轴不会看出两种姿态。
      // 有栏杆信号时用行程曲线；没有信号时只能用过程结果推断，此时按"已到位"处理，不编造行程时刻。
      const pose = barrierSignal.state === null
        ? { angle: THREE.MathUtils.degToRad(barrierOpen ? BARRIER.openDeg : 0), traveling: false }
        : barrierAngleAt(lane.signals.barrier.transitions, t, { timeScale: 0.001 });   // 本页时间轴单位是毫秒
      model.barrier.rotation.z = pose.angle;
      // 运行中杆座黄闪（确定性相位：同一时刻拖回来闪到哪一帧都一样）
      if (model.barrierLamp) {
        const seconds = t / 1000;
        const blinkOn = Math.floor(seconds * BARRIER.lampHz * 2) % 2 === 0;
        model.barrierLamp(pose.traveling && blinkOn ? 1 : 0);
      }
      barrierPoses.set(lane.id, {
        angleDeg: THREE.MathUtils.radToDeg(pose.angle),
        open: pose.open,
        traveling: pose.traveling,
      });
    }
    if (barrierSignal.timedOut) {
      flashCount += 1;
      timeouts.push({
        kind: "栏杆",
        name: "栏杆 抬杆",
        target: "栏杆",
        label: "栏杆",
        signal: barrierSignal,
        track: lane.signals.barrier,
        interval: barrierSignal.interval,
        thresholdMs: TIMEOUT.barrierMs,
        active: true,
        evidence: (barrierSignal.interval && barrierSignal.interval.text) || "",
        jumps: lane.signals.barrier.transitions.length,
      });
      if (armDevice) {
        armDevice.pulse = 0;
        armDevice.body.material.emissive.setHex(COLORS.timeout).multiplyScalar(flashOn ? 1.0 : 0.15);
      }
    }

    // ---- 其他设备：命中过程节点就打一次脉冲 ----
    for (const [key, device] of model.devices) {
      if (key === "barrier" && barrierSignal.timedOut) continue;
      device.pulse = Math.max(0, device.pulse - dt * 1.6);
      const times = lane.signals.deviceTimes.get(key);
      const hit = times ? lastAtOrBefore(times, t) : null;
      if (hit !== null && t - hit >= 0 && t - hit < 900) device.pulse = 1;
      device.body.material.emissive.setHex(device.baseColor).multiplyScalar(device.pulse * 0.95);
      if (!device.isAntenna) device.body.scale.setScalar(1 + device.pulse * 0.1);
    }

    // ---- 过程超时 ----
    const entry = state.active || state.recent;
    if (entry && lane.signals.passageTimeouts.has(entry.passage.i)) {
      flashCount += 1;
      timeouts.push({
        kind: "过程",
        name: "过程跨度",
        target: `${entry.passage.start} → ${entry.passage.end}`,
        label: `过程跨度 ${Math.round(entry.passage.durationMs / 1000)}s`,
        signal: { at: entry.passage.end },
        track: null,
        interval: {
          t0: entry.o0,
          t1: entry.o1,
          ms: entry.passage.durationMs,
          at: entry.passage.start,
          text: `${entry.passage.eventCount} 条日志 · ${entry.passage.basis} 分段 · ${entry.passage.devices.join(" → ")}`,
        },
        thresholdMs: TIMEOUT.passageMs,
        active: false,
        evidence: `${entry.passage.eventCount} 条日志 · ${entry.passage.basis} 分段 · 强度 ${entry.passage.confidence}`,
        jumps: entry.passage.nodes.length,
      });
    }

    STATE.timeouts.set(lane.id, timeouts);
    clock.set(lane.id, timeouts.length);

    // ---- 车道状态灯 / 头光带：有超时就红闪，否则按过程结果 ----
    const status = statusOf(entry, Boolean(state.active));
    model.status = status;
    const color = timeouts.length ? (flashOn ? COLORS.timeout : 0x5a1f1c) : COLORS[status] || COLORS.idle;
    model.statusColor = color;
    model.statusLight.material.color.setHex(color);
    model.headStrip.material.color.setHex(color);

    // ---- 车辆：按本趟车的车型/轴数/真实尺寸重建，结果用悬浮标记表达 ----
    if (state.active) {
      const passage = state.active.passage;
      const track = lane.tracks.get(passage.i);
      if (model.vehiclePassage !== passage.i) {
        setLaneVehicle(model, passage);
      }
      model.vehicle.visible = true;
      const vehicleZ = zAt(track, t + offset);
      const previousZ = model.vehicle.userData.lastZ;
      model.vehicle.position.set(0, 0, vehicleZ);
      model.vehicle.userData.lastZ = vehicleZ;
      if (typeof previousZ === "number") {
        const delta = vehicleZ - previousZ;
        if (Math.abs(delta) > 1e-4) model.vehicleModel?.spin?.(delta);
        // 刹车灯：同一趟过程内按实际位移算速度/减速度；跳变（拖拽时间游标）直接重置，避免整段闪亮
        if (Math.abs(delta) > 2.5) model.brakeController?.reset();
        else model.brakeController?.update(dt, delta);
        model.vehicleModel?.setBrake?.(model.brakeController ? model.brakeController.level : 0);
      }
      model.vehicleMarker?.material.color.setHex(resultColor(passage.result));
    } else {
      model.vehicle.visible = false;
    }
  }

  STATE.flashCount = flashCount;
  updateHudPills(clock);
  updateTimeoutPill();
  updateAlert();
}

function updateHudPills(clock) {
  for (const lane of STATE.lanes) {
    const pill = STATE.hudPills ? STATE.hudPills.get(lane.id) : null;
    if (!pill) continue;
    const { active, recent } = STATE.laneStates.get(lane.id);
    const entry = active || recent;
    const count = clock.get(lane.id) || 0;
    const label = `${entry ? `${entry.passage.result}${active ? " · 通行中" : " · 刚结束"}` : "空闲"}${count ? ` ⚠ 超时 ${count}` : ""}`;
    if (STATE.pillText.get(lane.id) !== label) {
      STATE.pillText.set(lane.id, label);
      pill.textContent = label;
      pill.parentElement.classList.toggle("warn", count > 0);
    }
  }
}

function updateTimeoutPill() {
  const active = [];
  STATE.timeouts.forEach((list, laneId) => {
    for (const item of list) active.push(`${laneId} ${item.kind}${item.target === item.kind ? "" : ` ${item.target}`}`);
  });
  const key = active.join("|");
  if (key === STATE.timeoutKey) return;
  STATE.timeoutKey = key;
  if (dom.timeoutPill) {
    dom.timeoutPill.textContent = active.length ? `超时设备 ${active.length}：${active.slice(0, 4).join("，")}${active.length > 4 ? " …" : ""}` : "当前游标处无超时设备";
    dom.timeoutPill.classList.toggle("warn", active.length > 0);
  }
}

// ---------------------------------------------------------------------------
// 右侧悬浮告警面板：只在当前游标处存在超时时出现，显示车辆 / 车道 / 问题设备
// ---------------------------------------------------------------------------
const VEHICLE_ROWS = [
  { label: "车牌识别", devices: ["vlpr"] },
  { label: "车型/轴型", devices: ["车型识别", "axle"] },
  { label: "称重", devices: ["weigh"] },
  { label: "OBU/ETC", devices: ["rsu"] },
  { label: "CPC", devices: ["cpc"] },
  { label: "名单", devices: ["namelist"] },
  { label: "交易", devices: ["fee", "display"] },
  { label: "车道服务", devices: ["lane", "service"] },
];

const ALERT = { signature: "", count: -1 };

function truncate(text, max = 96) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** 聚焦车道：优先选中的车道（若它当前有超时），否则取超时持续最久的 */
function focusTimeoutLane() {
  const selected = STATE.selected ? STATE.selected.lane.id : null;
  let focus = null;
  let best = -Infinity;
  STATE.timeouts.forEach((list, laneId) => {
    if (!list.length) return;
    const interval = list[0].interval;
    const score = (interval ? STATE.t - interval.t0 : 0) + (laneId === selected ? 1e9 : 0);
    if (score > best) {
      best = score;
      focus = laneId;
    }
  });
  return focus;
}

/** 游标之前该过程里最后一次出现的某类设备日志 */
function lastPassageNode(passage, devices, beforeOffset) {
  let found = null;
  for (const node of passage.nodes) {
    if (node.o > beforeOffset) break;
    if (devices.includes(node.device)) found = node;
  }
  return found;
}

/** 游标之前该过程的最后一个节点（用来表示车辆"走到哪了"） */
function lastNodeBefore(passage, beforeOffset) {
  let found = null;
  for (const node of passage.nodes) {
    if (node.o > beforeOffset) break;
    found = node;
  }
  return found;
}

function alertVehicleHtml(passage) {
  const rows = [];
  if (!passage) {
    return `<dl class="alert-rows"><dt>车辆</dt><dd class="dim">该时刻没有正在通行 / 刚结束的过程，无法关联车辆信息（这条超时可能发生在过程之外）</dd></dl>`;
  }
  const before = STATE.t + STATE.data.window.offsetMs;
  rows.push(
    `<dt>车牌</dt><dd class="${passage.plates.length ? "" : "dim"}">${passage.plates.length ? escapeHtml(passage.plates.join(" / ")) : "未识别（该过程没有车牌日志）"}</dd>`
  );
  rows.push(
    `<dt>通行号</dt><dd class="${passage.passIds.length ? "" : "dim"}">${passage.passIds.length ? escapeHtml(passage.passIds.slice(0, 2).join(" / ")) : "未上报"}</dd>`
  );
  const spec = passage.vehicle;
  if (spec) {
    const dims = spec.dims || {};
    const colorText = spec.bodyColorLabel
      ? `${spec.bodyColorLabel}（牌识码 ${spec.bodyColorCode}，厂商码表未验证）`
      : "按车型常见配色示意（日志未上报车身颜色）";
    rows.push(`<dt>车型</dt><dd class="${spec.declaredClass || spec.identifiedClass ? "" : "dim"}">${escapeHtml(spec.classLabel || "未知")}${spec.classCode ? `（部车型码 ${spec.classCode}）` : ""} · ${escapeHtml(spec.classBasis || "")}</dd>`);
    rows.push(`<dt>轴数</dt><dd>${spec.axles || "-"} 轴${spec.axleSource ? `（${escapeHtml(spec.axleSource)}）` : ""}</dd>`);
    rows.push(`<dt>车牌颜色</dt><dd class="${spec.plateColorLabel ? "" : "dim"}">${escapeHtml(spec.plateColorLabel || "未上报")}</dd>`);
    rows.push(`<dt>车身颜色</dt><dd class="src">${escapeHtml(colorText)}</dd>`);
    if (dims.length) {
      rows.push(`<dt>尺寸</dt><dd>${dims.length.toFixed(2)} × ${dims.width.toFixed(2)} × ${dims.height.toFixed(2)} m${spec.realDims ? "（车型识别实测）" : "（车型典型值）"}</dd>`);
    }
    if (spec.classMismatch || spec.axleMismatch) {
      rows.push(`<dt>⚠ 不一致</dt><dd>${spec.classMismatch ? `车型识别判定 ${spec.identifiedClass}，申报 ${spec.declaredClass}` : `轴数与车型码 ${spec.classCode} 不符`}</dd>`);
    }
  }
  for (const spec of VEHICLE_ROWS) {
    const node = lastPassageNode(passage, spec.devices, before);
    if (!node) continue;
    rows.push(`<dt>${spec.label}</dt><dd class="src" title="${escapeHtml(node.text)}">${escapeHtml(truncate(node.text))}</dd>`);
  }
  const last = lastNodeBefore(passage, before);
  if (last) rows.push(`<dt>当前位置</dt><dd>${DEVICE_LABEL[last.device] || last.device} · ${last.t}</dd>`);
  rows.push(`<dt>过程</dt><dd>${passage.start} → ${passage.end}（${Math.round(passage.durationMs / 1000)}s）· ${passage.result}</dd>`);
  rows.push(`<dt>证据</dt><dd>${passage.basis} 分段 · 强度 ${passage.confidence}${passage.coilConfirmed ? " · 线圈闭环" : " · 无线圈闭环"}</dd>`);
  if (passage.basis !== "线圈" || passage.confidence === "低") {
    rows.push(`<dt></dt><dd class="dim">注：该过程为${passage.basis}分段且强度${passage.confidence}${passage.basis !== "线圈" ? "，可能包含不止一辆车" : ""}，车辆字段仅供对照。</dd>`);
  }
  return `<dl class="alert-rows">${rows.join("")}</dl>`;
}

function alertLaneHtml(lane, state) {
  const metrics = lane.metrics;
  const coilTimeout = [...lane.signals.coils.values()].reduce((total, track) => total + track.timeouts.length, 0);
  const barrierTimeout = lane.signals.barrier.timeouts.length;
  const passageTimeout = lane.signals.passageTimeouts.size;
  const statusText = state.active
    ? `通行中（${state.active.passage.result}）`
    : state.recent
      ? `刚结束（${state.recent.passage.result}）`
      : "空闲";
  return `<dl class="alert-rows">
    <dt>车道号</dt><dd>${lane.id}</dd>
    <dt>类型/方向</dt><dd>${lane.types.join("/") || "未上报"} · ${lane.directions && lane.directions.length ? lane.directions.join("/") : "方向未上报"}</dd>
    <dt>当前状态</dt><dd class="warn">${statusText}</dd>
    <dt>本窗统计</dt><dd>过程 ${metrics.passages} · 放行 ${metrics.released} · 拦截 ${metrics.blocked} · 日志 ${lane.docCount}</dd>
    <dt>分段依据</dt><dd>${lane.basis || "-"}${lane.basis !== "线圈" && lane.gapSeconds ? `（间隔 ${lane.gapSeconds}s）` : ""}</dd>
    <dt>窗口超时</dt><dd class="warn">线圈 ${coilTimeout} · 栏杆 ${barrierTimeout} · 过程 ${passageTimeout}</dd>
  </dl>`;
}

function alertTimeoutHtml(items) {
  return items
    .map(({ laneId, item }) => {
      const interval = item.interval || null;
      const total = interval ? interval.ms : 0;
      const elapsed = interval ? Math.max(0, Math.min(total, STATE.t - interval.t0)) : 0;
      const atWindowEnd = interval ? interval.t1 >= STATE.span - 1 : false;
      const rows = [];
      rows.push(`<dt>问题</dt><dd class="warn">${item.name || item.target}${item.active ? "后长时间未翻转" : "超限"}</dd>`);
      rows.push(`<dt>持续</dt><dd class="warn">${Math.round(total / 1000)}s（阈值 ${Math.round(item.thresholdMs / 1000)}s）</dd>`);
      rows.push(`<dt>游标</dt><dd>已进入 ${Math.round(elapsed / 1000)}s / ${Math.round(total / 1000)}s</dd>`);
      if (interval) {
        rows.push(`<dt>起点</dt><dd>${interval.at || "-"}</dd>`);
        rows.push(
          `<dt>终点</dt><dd class="${atWindowEnd ? "warn" : ""}">${atWindowEnd ? "窗口末尾仍未恢复（也可能日志缺失）" : formatClock(interval.t1)}</dd>`
        );
      }
      if (item.evidence) {
        rows.push(`<dt>依据日志</dt><dd class="src" title="${escapeHtml(item.evidence)}">${escapeHtml(truncate(item.evidence, 120))}</dd>`);
      }
      if (item.jumps) rows.push(`<dt>跳变次数</dt><dd>${item.jumps}</dd>`);
      return `<div class="alert-item">
        <div class="alert-item-head"><b>${laneId}</b> · ${item.target}</div>
        <dl class="alert-rows">${rows.join("")}</dl>
      </div>`;
    })
    .join("");
}

/** 同一车道窗口内的其他超时点，便于顺着条带跳过去 */
function alertNoteHtml(laneId) {
  const lane = STATE.lanes.find((item) => item.id === laneId);
  if (!lane) return "";
  const others = [];
  lane.signals.coils.forEach((track, coilId) => {
    for (const interval of track.timeouts) others.push(`线圈${coilId} ${interval.at}`);
  });
  for (const interval of lane.signals.barrier.timeouts) others.push(`栏杆 ${interval.at}`);
  for (const passage of lane.passages) if (lane.signals.passageTimeouts.has(passage.i)) others.push(`过程 ${passage.start}`);
  if (others.length <= 1) return "";
  return `<div class="alert-note">该车道窗口内共 ${others.length} 处超时：${others.slice(0, 6).join("、")}${others.length > 6 ? " …" : ""}（泳道区的红色闪烁块可点击跳转）</div>`;
}

function updateAlert() {
  if (!dom.alertPanel) return;
  const items = [];
  STATE.timeouts.forEach((list, laneId) => {
    for (const item of list) items.push({ laneId, item });
  });
  const focusLaneId = items.length ? focusTimeoutLane() : null;
  if (!items.length || !focusLaneId) {
    if (!dom.alertPanel.hidden) {
      dom.alertPanel.hidden = true;
      ALERT.signature = "";
      ALERT.count = -1;
    }
    return;
  }
  if (dom.alertPanel.hidden) {
    dom.alertPanel.hidden = false;
    ALERT.signature = "";
  }
  if (ALERT.count !== items.length) {
    ALERT.count = items.length;
    dom.alertCount.textContent = `${items.length} 处`;
  }
  // 每半秒（游标时间）重绘一次，只有超时期间才会走到这里
  const signature = [
    focusLaneId,
    Math.floor(STATE.t / 500),
    items.map(({ laneId, item }) => `${laneId}:${item.kind}:${item.target}:${item.interval ? item.interval.t0 : -1}`).join(","),
  ].join("|");
  if (signature === ALERT.signature) return;
  ALERT.signature = signature;

  const lane = STATE.lanes.find((item) => item.id === focusLaneId);
  const laneState = STATE.laneStates.get(focusLaneId) || {};
  const entry = laneState.active || laneState.recent;
  dom.alertBody.innerHTML =
    `<div class="alert-sec"><h4>车辆基本信息</h4>${alertVehicleHtml(entry ? entry.passage : null)}</div>` +
    `<div class="alert-sec"><h4>车道信息</h4>${alertLaneHtml(lane, laneState)}</div>` +
    `<div class="alert-sec"><h4>问题设备 / 超时详情</h4>${alertTimeoutHtml(items)}${alertNoteHtml(focusLaneId)}</div>`;
}

function buildHud() {
  dom.hud.innerHTML = STATE.lanes
    .map((lane) => `<span class="pill" data-hud="${lane.id}">${lane.id} <b>空闲</b></span>`)
    .join("");
  STATE.hudPills = new Map(
    [...dom.hud.querySelectorAll(".pill")].map((el) => [el.dataset.hud, el.querySelector("b")])
  );
}

function updateLiveBars() {
  const live = new Set();
  STATE.laneStates.forEach((state, laneId) => {
    if (state.active) live.add(`${laneId}#${state.active.passage.i}`);
  });
  for (const key of live) {
    if (!STATE.liveKeys.has(key)) STATE.barEls.get(key)?.classList.add("live");
  }
  for (const key of STATE.liveKeys) {
    if (!live.has(key)) STATE.barEls.get(key)?.classList.remove("live");
  }
  STATE.liveKeys = live;
}

function syncTimeUi() {
  const clock = formatClock(STATE.t);
  let suffix = "";
  if (STATE.focus) {
    const width = Math.max(1, STATE.focus.to - STATE.focus.from);
    const percent = Math.round(Math.min(1, Math.max(0, (STATE.t - STATE.focus.from) / width)) * 100);
    suffix = ` 本趟 ${percent}%`;
  }
  const text = `${clock}${suffix}`;
  if (text !== STATE.lastClock) {
    STATE.lastClock = text;
    dom.clock.textContent = clock;
    dom.timeLabel.textContent = text;
  }
  const slider = timeToSlider(STATE.t);
  if (slider !== STATE.lastSlider) {
    STATE.lastSlider = slider;
    dom.scrub.value = String(slider);
  }
  const geometry = STATE.swimGeom || swimGeometry();
  if (geometry) {
    const left = geometry.left + (STATE.t / STATE.span) * geometry.width;
    dom.swimCursor.style.transform = `translateX(${left}px)`;
  }
}

function swimGeometry() {
  const track = dom.swimRows.querySelector(".swim-track");
  if (!track) return null;
  const rect = track.getBoundingClientRect();
  const parent = dom.swimRows.parentElement.getBoundingClientRect();
  return { left: rect.left - parent.left, width: rect.width };
}

function formatClock(t) {
  const base = STATE.data?.window?.from || "00:00:00";
  const parts = base.split(" ")[1]?.split(":") || ["0", "0", "0"];
  const startMs = ((Number(parts[0]) * 60 + Number(parts[1])) * 60 + Number(parts[2])) * 1000;
  const total = Math.max(0, Math.round(startMs + t));
  const hours = Math.floor(total / 3600000) % 24;
  const minutes = Math.floor(total / 60000) % 60;
  const seconds = Math.floor(total / 1000) % 60;
  const millis = total % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// 面板
// ---------------------------------------------------------------------------
function buildHeader() {
  const data = STATE.data;
  dom.stationLine.textContent = `站号 ${data.station || "-"} · ${data.index}`;
  dom.windowLine.textContent = `${data.window.from} ~ ${data.window.to}（${data.window.minutes} 分钟，${data.window.tz}）`;
  const coilTimeouts = STATE.lanes.reduce(
    (total, lane) => total + [...lane.signals.coils.values()].reduce((n, track) => n + track.timeouts.length, 0),
    0
  );
  const barrierTimeouts = STATE.lanes.reduce((total, lane) => total + lane.signals.barrier.timeouts.length, 0);
  const passageTimeouts = STATE.lanes.reduce((total, lane) => total + lane.signals.passageTimeouts.size, 0);
  if (dom.timeoutLine) {
    dom.timeoutLine.textContent = `窗口内超时：线圈 ${coilTimeouts} · 栏杆 ${barrierTimeouts} · 过程 ${passageTimeouts}（阈值 ${TIMEOUT.coilMs / 1000}s / ${TIMEOUT.barrierMs / 1000}s / ${TIMEOUT.passageMs / 1000}s）`;
    dom.timeoutLine.classList.toggle("warn", coilTimeouts + barrierTimeouts + passageTimeouts > 0);
  }
}

function buildSummary() {
  const s = STATE.data.summary;
  const conf = STATE.lanes.reduce(
    (acc, lane) => {
      acc.high += lane.metrics.confidence["高"] || 0;
      acc.mid += lane.metrics.confidence["中"] || 0;
      acc.low += lane.metrics.confidence["低"] || 0;
      return acc;
    },
    { high: 0, mid: 0, low: 0 }
  );
  const timeouts = STATE.lanes.reduce(
    (acc, lane) => {
      acc.coil += lane.signals.coils.size ? [...lane.signals.coils.values()].reduce((n, track) => n + track.timeouts.length, 0) : 0;
      acc.barrier += lane.signals.barrier.timeouts.length;
      acc.passage += lane.signals.passageTimeouts.size;
      return acc;
    },
    { coil: 0, barrier: 0, passage: 0 }
  );
  const cells = [
    ["车道", s.lanes],
    ["过程片段", s.passages],
    ["放行 / 拦截", `${s.released} / ${s.blocked}`],
    ["日志条数", s.docs],
    ["过程节点", s.nodes],
    ["证据强度 强/中/弱", `${conf.high}/${conf.mid}/${conf.low}`],
    ["线圈超时", timeouts.coil],
    ["栏杆超时", timeouts.barrier],
    ["过程超时", timeouts.passage],
    ["状态跳变 (线圈/栏杆)", `${s.signals ? s.signals.coils : 0} / ${s.signals ? s.signals.barrier : 0}`],
  ];
  dom.summary.innerHTML = cells
    .map(([key, value]) => `<div class="cell"><div class="k">${key}</div><div class="v">${value}</div></div>`)
    .join("");
}

function buildLaneList() {
  dom.laneList.innerHTML = STATE.lanes
    .map((lane) => {
      const m = lane.metrics;
      const basis = lane.basis ? `<span class="tag base">${lane.basis}分段</span>` : "";
      const basisNote = lane.basis !== "线圈" ? `<span class="tag base">间隔 ${lane.gapSeconds}s</span>` : "";
      const coilTimeout = [...lane.signals.coils.values()].reduce((n, track) => n + track.timeouts.length, 0) + lane.signals.barrier.timeouts.length;
      return `<div class="lane-item" data-lane="${lane.id}">
        <input type="checkbox" checked data-visible="${lane.id}">
        <div>
          <div class="lane-id">${lane.id}</div>
          <div class="lane-meta">类型 ${lane.types.join("/") || "-"} · 日志 ${lane.docCount} · 背景 ${m.background}</div>
          <div class="lane-tags">
            ${basis}${basisNote}
            <span class="tag ok">放行 ${m.released}</span>
            <span class="tag bad">拦截 ${m.blocked}</span>
            <span class="tag">强 ${m.confidence["高"]}</span>
            <span class="tag">中 ${m.confidence["中"]}</span>
            <span class="tag">弱 ${m.confidence["低"]}</span>
            ${coilTimeout ? `<span class="tag bad">超时 ${coilTimeout}</span>` : ""}
          </div>
        </div>
        <div class="lane-runs">${m.passages}</div>
      </div>`;
    })
    .join("");

  dom.laneList.querySelectorAll(".lane-item").forEach((item) => {
    item.addEventListener("click", (event) => {
      if (event.target.tagName === "INPUT") return;
      const laneId = item.dataset.lane;
      if (STATE.focus) {
        // 已经在下钻：点别的车道 = 换到那条车道的通行回放（那条车道有拦截/超时就落到那一趟）
        const incident = STATE.incidents.find((entry) => entry.lane.id === laneId);
        enterFocus(laneId, incident ? incident.passage.i : null);
        return;
      }
      selectLane(laneId);
    });
  });
  dom.laneList.querySelectorAll("input[data-visible]").forEach((input) => {
    input.addEventListener("change", () => {
      const model = STATE.models.get(input.dataset.visible);
      // 下钻时只留聚焦那条车道：勾选框照样记录用户意愿，但别的车道继续隐藏
      if (model) model.group.visible = STATE.focus ? input.dataset.visible === STATE.focus.laneId : input.checked;
      dom.laneList.querySelector(`.lane-item[data-lane="${input.dataset.visible}"]`)?.classList.toggle("off", !input.checked);
      document.querySelector(`.swim-row[data-lane="${input.dataset.visible}"]`)?.classList.toggle("off", !input.checked);
      if (!input.checked) model.vehicle.visible = false;
      LOOP.hold(400);
    });
  });
}

/**
 * 选中一条车道：左侧列表 + 泳道行 + 三维高亮 + 悬浮车辆清单的过滤范围都跟着走。
 * @param {string} laneId
 * @param {{follow?:boolean}} [options] follow=false 时不动相机（下钻自己会摆机位）
 */
function selectLane(laneId, { follow = true } = {}) {
  const lane = STATE.lanes.find((item) => item.id === laneId);
  if (!lane) return;
  STATE.selectedLane = laneId;
  STATE.highlightAt = performance.now();
  dom.laneList.querySelectorAll(".lane-item").forEach((item) => item.classList.toggle("sel", item.dataset.lane === laneId));
  dom.swimRows.querySelectorAll(".swim-row").forEach((row) => row.classList.toggle("sel", row.dataset.lane === laneId));
  const model = STATE.models.get(laneId);
  if (model && follow) camTweenTo(new THREE.Vector3(model.x, 0, 2));
  // 点车道 = 把悬浮清单收到这条车道上（再点一次"全部车道"就放回全局）
  if (!STATE.focus) setLaneFilter(laneId, { render: false });
  renderVehicleFloat();
  LOOP.hold(700);
}

// ---------------------------------------------------------------------------
// 拦截 / 超时车辆清单（左侧浮层）与单车道通行回放（下钻）
// ---------------------------------------------------------------------------
/**
 * 清点窗口内的"问题车"：过程判定拦截的，以及过程本身 / 线圈 / 栏杆超时且与本趟时间重叠的。
 * 全部来自 lanes.json 已有的事实，不新增任何判定阈值。
 */
function buildIncidents() {
  const offset = STATE.data.window.offsetMs;
  const incidents = [];
  for (const lane of STATE.lanes) {
    const coilTracks = [...lane.signals.coils.entries()];
    for (const passage of lane.passages) {
      const kinds = new Set();
      const reasons = [];
      const from = passage.o0 - offset;
      const to = passage.o1 - offset;
      if (passage.result === "拦截") {
        kinds.add("block");
        reasons.push(`过程判定拦截（依据 ${passage.basis} · 强度 ${passage.confidence} · ${passage.eventCount} 条日志）`);
      }
      if (lane.signals.passageTimeouts.has(passage.i)) {
        kinds.add("timeout");
        reasons.push(`过程跨度 ${(passage.durationMs / 1000).toFixed(1)}s 超过阈值 ${TIMEOUT.passageMs / 1000}s`);
      }
      for (const [coilId, track] of coilTracks) {
        // 同一条线圈只报最早那次重叠，免得一辆车刷出七八行
        const hit = track.timeouts.find((interval) => interval.t1 >= from && interval.t0 <= to);
        if (hit) {
          kinds.add("timeout");
          reasons.push(`线圈${coilId} 压上后 ${(hit.ms / 1000).toFixed(1)}s 未释放（@ ${hit.at}，阈值 ${TIMEOUT.coilMs / 1000}s）`);
        }
      }
      const barrierHit = lane.signals.barrier.timeouts.find((interval) => interval.t1 >= from && interval.t0 <= to);
      if (barrierHit) {
        kinds.add("timeout");
        reasons.push(`栏杆抬杆后 ${(barrierHit.ms / 1000).toFixed(1)}s 未落杆（@ ${barrierHit.at}，阈值 ${TIMEOUT.barrierMs / 1000}s）`);
      }
      if (!kinds.size) continue;
      incidents.push({ key: `${lane.id}#${passage.i}`, lane, passage, t0: from, kinds: [...kinds], reasons });
    }
  }
  incidents.sort((a, b) => a.t0 - b.t0);
  STATE.incidents = incidents;
  return incidents;
}

function visibleIncidents() {
  return STATE.incidents.filter((incident) => {
    if (STATE.filter === "block" && !incident.kinds.includes("block")) return false;
    if (STATE.filter === "timeout" && !incident.kinds.includes("timeout")) return false;
    if (STATE.laneFilter && incident.lane.id !== STATE.laneFilter) return false;
    return true;
  });
}

function setLaneFilter(laneId, { render = true } = {}) {
  STATE.laneFilter = laneId || null;
  if (render) renderVehicleFloat();
}

/** 车型族：只影响车型图的画法，判定用的 kind 仍然原样保留。 */
function vehicleFamily(kind) {
  if (kind === "car") return "car";
  if (kind === "van") return "van";
  if (kind === "bus" || kind === "coach") return "coach";
  if (kind === "lightTruck") return "lightTruck";
  if (kind === "mediumTruck" || (typeof kind === "string" && kind.startsWith("rigid"))) return "mediumTruck";
  if (typeof kind === "string" && kind.startsWith("semi")) return "semi";
  return "other";
}

/**
 * 车型图：画侧视轮廓（车头朝右），轴位直接调 `axleLayout` —— 图里几个轮子、排在哪儿，
 * 必须和三维场景里那辆车完全一致。车身只用示意灰蓝，不冒充真实车身颜色（日志里没有可靠的车身色）。
 */
function vehicleIconSvg(spec, label = "") {
  const width = 78;
  const height = 34;
  const ground = 28.5;
  const kind = (spec && spec.kind) || "car";
  const dims = (spec && spec.dims) || {};
  const axles = (spec && spec.axles) || 2;
  const length = Math.max(3.4, Math.min(Number(dims.length) || 4.7, 20));
  const tall = Math.max(1.2, Math.min(Number(dims.height) || 1.5, 4.4));
  const span = 62;   // 车长统一占 62px：图内不按真实长度缩放，长短靠轮廓与轴数区分
  const scale = span / length;
  const x0 = (width - span) / 2;
  const bodyHeight = Math.max(6.5, Math.min(19, tall * scale));
  const roof = ground - bodyHeight;
  const wheelR = Math.max(2.1, Math.min(4.4, (kind === "car" ? Math.min(0.34, tall * 0.22) : 0.42) * scale));
  const r = (value) => Math.round(value * 10) / 10;
  const px = (u) => x0 + u * span;
  const py = (v) => ground - v * bodyHeight;
  const boxU = (u0, u1, v0, v1, fill, radius = 1.2) => {
    const x = px(u0);
    const y = py(v1);
    return `<rect x="${r(x)}" y="${r(y)}" width="${r(px(u1) - x)}" height="${r(py(v0) - y)}" rx="${radius}" fill="${fill}"/>`;
  };
  const BODY = "#33414f";
  const BODY2 = "#3f4f5e";
  const CAB = "#465866";
  const GLASS = "#7fb6dd";
  const WHEEL = "#0f141a";
  const RIM = "#6b7b8d";
  const parts = [];
  const family = vehicleFamily(kind);
  if (family === "car") {
    parts.push(boxU(0, 1, 0.06, 0.52, BODY, 2.4));
    parts.push(`<path d="M${r(px(0.24))} ${r(py(0.52))} L${r(px(0.34))} ${r(py(0.88))} L${r(px(0.68))} ${r(py(0.88))} L${r(px(0.78))} ${r(py(0.52))} Z" fill="${BODY2}"/>`);
    parts.push(boxU(0.35, 0.45, 0.56, 0.82, GLASS, 0.8));
    parts.push(boxU(0.49, 0.66, 0.56, 0.82, GLASS, 0.8));
  } else if (family === "van") {
    parts.push(boxU(0, 1, 0.06, 0.54, BODY, 2));
    parts.push(`<path d="M${r(px(0.08))} ${r(py(0.54))} L${r(px(0.1))} ${r(py(0.94))} L${r(px(0.84))} ${r(py(0.94))} L${r(px(0.92))} ${r(py(0.62))} L${r(px(0.92))} ${r(py(0.54))} Z" fill="${BODY2}"/>`);
    parts.push(boxU(0.68, 0.88, 0.62, 0.88, GLASS, 0.8));
  } else if (family === "coach") {
    parts.push(boxU(0, 1, 0.06, 0.95, BODY, 2.2));
    parts.push(boxU(0.06, 0.94, 0.58, 0.84, GLASS, 0.8));
  } else if (family === "lightTruck") {
    parts.push(boxU(0.6, 1, 0.06, 0.84, CAB, 1.6));
    parts.push(boxU(0.63, 0.9, 0.56, 0.76, GLASS, 0.8));
    parts.push(boxU(0, 0.56, 0.06, 0.68, BODY2, 1.2));
  } else if (family === "mediumTruck") {
    parts.push(boxU(0.64, 1, 0.06, 0.88, CAB, 1.6));
    parts.push(boxU(0.67, 0.92, 0.58, 0.8, GLASS, 0.8));
    parts.push(boxU(0, 0.6, 0.06, 0.76, BODY2, 1.2));
  } else if (family === "semi") {
    parts.push(boxU(0.72, 1, 0.06, 0.92, CAB, 1.6));
    parts.push(boxU(0.75, 0.94, 0.6, 0.84, GLASS, 0.8));
    parts.push(boxU(0, 0.6, 0.16, 0.92, BODY2, 1.2));
  } else {
    parts.push(boxU(0, 1, 0.06, 0.72, BODY2, 1.2));
  }
  const axleZ = axleLayout(kind, { length, width: Number(dims.width) || 1.85, height: tall }, axles, dims.wheelbase);
  for (const z of axleZ) {
    const x = px(0.5 + z / length);
    parts.push(`<circle cx="${r(x)}" cy="${r(ground - wheelR)}" r="${r(wheelR)}" fill="${WHEEL}"/>`);
    parts.push(`<circle cx="${r(x)}" cy="${r(ground - wheelR)}" r="${r(wheelR * 0.36)}" fill="${RIM}"/>`);
  }
  // 车牌颜色角标（在图形左上角，不压在车上）：日志给了牌色就照牌色，没给就灰底
  const style = spec ? PLATE_STYLE[spec.plateColorCode] : null;
  parts.push(
    `<rect x="1" y="1" width="9.5" height="4.8" rx="1" fill="${style ? style.bg : "#2b3138"}" stroke="#0e1116" stroke-width="0.5"/>`,
    `<line x1="1" y1="29.6" x2="77" y2="29.6" stroke="#25303b" stroke-width="1"/>`,
  );
  return `<svg class="vf-icon" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(label)}">
    <title>${escapeHtml(label)}</title>${parts.join("")}</svg>`;
}

function incidentRowHtml(incident) {
  const { lane, passage } = incident;
  const spec = passage.vehicle || null;
  const plate = passage.plates.length ? passage.plates[0] : "";
  const focused = STATE.focus && STATE.focus.laneId === lane.id && STATE.focus.passageI === passage.i;
  const selected = STATE.selected && STATE.selected.lane.id === lane.id && STATE.selected.passage.i === passage.i;
  const label = `${plate || "无车牌"} · ${spec ? spec.classLabel || "未知车型" : "车型未上报"} · ${spec ? spec.axles || "?" : "?"} 轴 · ${lane.id} · ${passage.start}`;
  const plateLabel = spec && spec.plateColorLabel ? `车牌颜色 ${spec.plateColorLabel}` : "车牌颜色未上报";
  const dims = spec && spec.dims && Number(spec.dims.length)
    ? ` · ${Number(spec.dims.length).toFixed(2)}×${Number(spec.dims.width).toFixed(2)}×${Number(spec.dims.height).toFixed(2)}m`
    : "";
  const badges = [
    incident.kinds.includes("block") ? `<span class="vf-badge block">拦截</span>` : "",
    incident.kinds.includes("timeout") ? `<span class="vf-badge timeout">超时</span>` : "",
  ].join("");
  return `<div class="vf-item${focused ? " focused" : ""}${selected ? " sel" : ""}" data-lane="${lane.id}" data-i="${passage.i}"
    role="button" tabindex="0"
    title="${escapeHtml(`${label} · ${plateLabel}${dims} —— 点一下下钻到该车道的通行回放`)}">
    ${vehicleIconSvg(spec, `${spec ? spec.classLabel || "未知车型" : "车型未上报"}（${spec ? spec.axles || "?" : "?"} 轴）示意轮廓，不代表真实车身颜色`)}
    <div class="vf-main">
      <div class="vf-line1">
        <span class="vf-plate${plate ? "" : " dim"}">${escapeHtml(plate || "无车牌")}</span>${badges}
      </div>
      <div class="vf-meta">${lane.id} · ${passage.start} · ${escapeHtml(spec ? spec.classLabel || "未知车型" : "车型未上报")} · ${spec ? spec.axles || "?" : "?"} 轴 · ${Math.round(passage.durationMs)} ms</div>
      <div class="vf-why">${escapeHtml(incident.reasons[0] || "")}</div>
    </div>
  </div>`;
}

function renderVehicleFloat() {
  if (!dom.vehicleFloatBody) return;
  const items = visibleIncidents();
  const total = STATE.incidents.length;
  const blocked = STATE.incidents.filter((item) => item.kinds.includes("block")).length;
  const timed = STATE.incidents.filter((item) => item.kinds.includes("timeout")).length;
  dom.vehicleFloatCount.textContent = total ? `拦截 ${blocked} · 超时 ${timed}` : "0 辆";
  dom.vehicleFloatScope.textContent = STATE.laneFilter ? `仅 ${STATE.laneFilter}` : "全部车道";
  dom.vehicleFloatScope.title = STATE.laneFilter ? "点一下看全部车道" : "当前列出全部车道";
  dom.vehicleFloatHint.textContent = STATE.focus ? "正在回放本趟 · 点其它车辆可切到那趟" : "点一条车辆 → 下钻到该车道的通行回放";
  if (!items.length) {
    dom.vehicleFloatBody.innerHTML = `<div class="vf-empty">${
      total ? `当前筛选下没有车辆（窗口内共 ${total} 辆）` : "窗口内没有拦截 / 超时车辆"
    }</div>`;
    return;
  }
  dom.vehicleFloatBody.innerHTML = items.map(incidentRowHtml).join("");
  dom.vehicleFloatBody.querySelectorAll(".vf-item").forEach((row) => {
    const focus = () => enterFocus(row.dataset.lane, Number(row.dataset.i));
    row.addEventListener("click", focus);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        focus();
      }
    });
  });
  const focusedRow = dom.vehicleFloatBody.querySelector(".vf-item.focused");
  if (focusedRow) focusedRow.setAttribute("aria-current", "true");
}

function bindVehicleFloat() {
  if (dom.vehicleFloatToggle) {
    dom.vehicleFloatToggle.addEventListener("click", () => {
      const collapsed = dom.vehicleFloat.classList.toggle("collapsed");
      dom.vehicleFloatToggle.textContent = collapsed ? "展开" : "收起";
      LOOP.hold(200);
    });
  }
  if (dom.vehicleFloatScope) {
    dom.vehicleFloatScope.addEventListener("click", () => {
      setLaneFilter(null);
      LOOP.hold(200);
    });
  }
  dom.vfChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      STATE.filter = chip.dataset.filter || "all";
      dom.vfChips.forEach((item) => item.classList.toggle("on", item === chip));
      renderVehicleFloat();
      LOOP.hold(200);
    });
  });
}

/** 相机补间：只改位置/目标点，交给 OrbitControls 自己去收敛（阻尼照旧）。 */
function camTweenTo(target, position = null) {
  STATE.camTween = { target: target.clone(), position: position ? position.clone() : STATE.camera.position.clone() };
  LOOP.hold(500);
}

function updateCamTween(dt) {
  const tween = STATE.camTween;
  if (!tween) return;
  const k = Math.min(1, 1 - Math.exp(-dt * 7));
  STATE.camera.position.lerp(tween.position, k);
  STATE.controls.target.lerp(tween.target, k);
  if (STATE.camera.position.distanceTo(tween.position) < 0.06 && STATE.controls.target.distanceTo(tween.target) < 0.06) {
    STATE.camera.position.copy(tween.position);
    STATE.controls.target.copy(tween.target);
    STATE.camTween = null;
  }
}

/** 本页时间轴与聚焦区间之间的换算：聚焦时进度条只覆盖本趟过程。 */
function timeToSlider(t) {
  const focus = STATE.focus;
  if (!focus) return Math.round((t / STATE.span) * 1000);
  const width = Math.max(1, focus.to - focus.from);
  return Math.round(Math.min(1, Math.max(0, (t - focus.from) / width)) * 1000);
}

function sliderToTime(value) {
  const focus = STATE.focus;
  if (!focus) return (value / 1000) * STATE.span;
  return focus.from + (value / 1000) * Math.max(1, focus.to - focus.from);
}

/** 取某条车道的某一趟过程；passageI 给不出（null/找不到）时退回该车道第一趟。 */
function focusPassage(laneId, passageI) {
  const lane = STATE.lanes.find((item) => item.id === laneId);
  if (!lane || !lane.passages.length) return null;
  return lane.passages.find((item) => item.i === passageI) || lane.passages[0];
}

/** 这趟车的车牌在 index.json 里有单车日志、且时刻落在该日志窗口内吗（否则跳过去什么也看不到）。 */
function soloLogFor(passage) {
  if (!passage.plates.length || !STATE.soloLogs.length) return null;
  const plate = passage.plates[0];
  for (const log of STATE.soloLogs) {
    if (!log || log.vehicle !== plate) continue;
    const from = String(log.start || "").slice(11, 23);
    const to = String(log.end || "").slice(11, 23);
    if (from && to && (passage.start < from || passage.start > to)) continue;
    return log;
  }
  return null;
}

function focusCameraPosition(x) {
  return new THREE.Vector3(x + 12.5, 7.6, 21);
}

function renderFocusBar(focus) {
  if (!dom.focusBar) return;
  const lane = focus ? STATE.lanes.find((item) => item.id === focus.laneId) : null;
  const passage = lane ? lane.passages.find((item) => item.i === focus.passageI) : null;
  if (!lane || !passage) {
    dom.focusBar.hidden = true;
    return;
  }
  dom.focusBar.hidden = false;
  dom.focusLane.textContent = lane.id;
  dom.focusRange.textContent = `${passage.start} → ${passage.end} · ${(passage.durationMs / 1000).toFixed(1)}s · ${passage.eventCount} 条日志`;
  const incident = STATE.incidents.find((item) => item.lane.id === lane.id && item.passage.i === passage.i);
  const tone = incident
    ? (incident.kinds.includes("timeout") ? "timeout" : "block")
    : (passage.result === "拦截" ? "block" : passage.result === "放行" ? "pass" : passage.result === "混合" ? "mixed" : "");
  const label = incident ? (incident.kinds.includes("timeout") ? "超时" : "拦截") : passage.result;
  dom.focusResult.className = `focus-result ${tone}`;
  dom.focusResult.textContent = `${label} · ${passage.plates.length ? passage.plates[0] : "无车牌"}`;
  const solo = soloLogFor(passage);
  if (solo) {
    dom.focusDeepLink.hidden = false;
    dom.focusDeepLink.href = `./index.html?file=${encodeURIComponent(solo.file)}&at=${encodeURIComponent(passage.start)}`;
    dom.focusDeepLink.title = `${solo.vehicle} 的单车日志（${solo.eventCount} 条）里跳到这时刻`;
  } else {
    dom.focusDeepLink.hidden = true;
    dom.focusDeepLink.removeAttribute("href");
    // 提示也别写死车牌：这份名单是从 data/index.json 读出来的
    const names = [...new Set(STATE.soloLogs.map((log) => log && log.vehicle).filter(Boolean))];
    dom.focusDeepLink.title = names.length
      ? `窗口内的单车日志只有 ${names.join(" / ")}，本趟不在其中（时刻对不上）`
      : "窗口内没有单车日志（data/index.json 为空）";
  }
}

/** 下钻：只留这一条车道、相机取到该车道、时间游标停在本趟起点。 */
function enterFocus(laneId, passageI) {
  const lane = STATE.lanes.find((item) => item.id === laneId);
  const passage = focusPassage(laneId, passageI);
  if (!lane || !passage) return;
  const offset = STATE.data.window.offsetMs;
  STATE.focus = {
    laneId,
    passageI: passage.i,
    from: Math.max(0, passage.o0 - offset),
    to: Math.min(STATE.span, passage.o1 - offset),
  };
  document.body.classList.add("single-lane");
  STATE.lanes.forEach((item) => {
    const model = STATE.models.get(item.id);
    if (model) model.group.visible = item.id === laneId;
  });
  dom.swimRows.querySelectorAll(".swim-row").forEach((row) => row.classList.toggle("focus", row.dataset.lane === laneId));
  document.querySelectorAll(".hud .pill").forEach((pill) => pill.classList.toggle("focus", pill.dataset.hud === laneId));
  setLaneFilter(laneId, { render: false });
  selectPassage(lane, passage);                       // 选中条带 + 游标跳到本趟起点 + 过程详情
  const model = STATE.models.get(laneId);
  camTweenTo(new THREE.Vector3(model.x, 1.2, -0.8), focusCameraPosition(model.x));
  renderFocusBar(STATE.focus);
  renderDetail();
  renderVehicleFloat();
  LOOP.hold(900);
}

/** 退出下钻：恢复所有车道（按用户自己的显隐复选框）与全局时间轴。 */
function exitFocus() {
  if (!STATE.focus) return;
  STATE.focus = null;
  document.body.classList.remove("single-lane");
  STATE.lanes.forEach((item) => {
    const model = STATE.models.get(item.id);
    if (model) model.group.visible = true;
  });
  dom.laneList.querySelectorAll("input[data-visible]").forEach((input) => {
    const model = STATE.models.get(input.dataset.visible);
    if (model) model.group.visible = input.checked;
    if (model && !input.checked) model.vehicle.visible = false;
  });
  dom.swimRows.querySelectorAll(".swim-row").forEach((row) => row.classList.remove("focus"));
  document.querySelectorAll(".hud .pill").forEach((pill) => pill.classList.remove("focus"));
  if (dom.focusBar) dom.focusBar.hidden = true;
  setLaneFilter(STATE.selectedLane, { render: false });
  renderVehicleFloat();
  renderDetail();
  const model = STATE.selectedLane ? STATE.models.get(STATE.selectedLane) : null;
  camTweenTo(new THREE.Vector3(0, 0, 2), new THREE.Vector3(model ? model.x * 0.5 : 0, 58, 76));
  LOOP.hold(700);
}

function replayFocus() {
  if (!STATE.focus) return;
  STATE.t = STATE.focus.from;
  STATE.playing = true;
  dom.playBtn.textContent = "暂停";
  STATE.lastSlider = -1;
  LOOP.hold(4000);
}

function bindFocusBar() {
  if (dom.focusBack) dom.focusBack.addEventListener("click", () => exitFocus());
  if (dom.focusReplay) dom.focusReplay.addEventListener("click", () => replayFocus());
}

// ---------------------------------------------------------------------------
// 泳道区：过程条带 + 设备状态时间线条带
// ---------------------------------------------------------------------------
function hexColor(value) {
  return `#${(value >>> 0).toString(16).padStart(6, "0")}`;
}

/** 把状态区间压成一条 CSS 渐变（硬断点），避免为每个区间建 DOM */
function trackGradient(track, color, span) {
  if (!track || !track.transitions.length) return "";
  const stops = [];
  for (const interval of track.intervals) {
    if (!interval.s) continue;
    const a = (interval.t0 / span) * 100;
    const b = (interval.t1 / span) * 100;
    stops.push(`transparent ${a.toFixed(3)}%`, `${color} ${a.toFixed(3)}%`, `${color} ${b.toFixed(3)}%`, `transparent ${b.toFixed(3)}%`);
  }
  if (!stops.length) return "";
  return `linear-gradient(90deg, ${stops.join(",")})`;
}

function deviceTicksGradient(lane) {
  const ticks = lane.signals.ticks;
  if (!ticks.length) return "";
  const step = Math.max(1, Math.ceil(ticks.length / 240));
  const stops = [];
  for (let index = 0; index < ticks.length; index += step) {
    const tick = ticks[index];
    const center = (tick.t / STATE.span) * 100;
    const width = Math.max(0.18, 0.45);
    const color = hexColor(DEVICE_COLOR[tick.device] ?? 0x7f8ea3);
    const a = Math.max(0, center - width / 2);
    const b = Math.min(100, center + width / 2);
    stops.push(`transparent ${a.toFixed(3)}%`, `${color} ${a.toFixed(3)}%`, `${color} ${b.toFixed(3)}%`, `transparent ${b.toFixed(3)}%`);
  }
  return stops.length ? `linear-gradient(90deg, ${stops.join(",")})` : "";
}

function stateRowHtml(lane, track, color, extraClass = "") {
  const gradient = trackGradient(track, color, STATE.span);
  const overlays = track.timeouts
    .map((interval) => {
      const left = (interval.t0 / STATE.span) * 100;
      const width = Math.max(0.4, ((interval.t1 - interval.t0) / STATE.span) * 100);
      return `<i class="st-timeout" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%" title="超时 ${Math.round(interval.ms / 1000)}s @ ${interval.at}"></i>`;
    })
    .join("");
  const title = track.noData
    ? "该车道窗口内没有这类信号"
    : `${track.transitions.length} 次状态跳变${track.timeouts.length ? ` · 超时 ${track.timeouts.length} 次` : ""}`;
  return `<div class="st-row ${extraClass}${track.noData ? " no-data" : ""}" title="${title}">
    <div class="st-fill" style="${gradient ? `background-image:${gradient}` : ""}"></div>${overlays}
  </div>`;
}

function buildSwim() {
  const minutes = Math.round(STATE.data.window.minutes);
  let scale = "";
  for (let minute = 0; minute <= minutes; minute += 1) {
    scale += `<span style="left:${(minute / minutes) * 100}%">+${minute}min</span>`;
  }
  dom.swimScale.innerHTML = scale;

  dom.swimRows.innerHTML = STATE.lanes
    .map((lane) => {
      const density = lane.metrics.perMinute || [];
      const peak = Math.max(1, ...density);
      const densityHtml = density
        .map((count) => `<i style="height:${Math.round((count / peak) * 100)}%"></i>`)
        .join("");
      const bars = lane.rel
        .map((entry) => {
          const passage = entry.passage;
          const left = (entry.o0 / STATE.span) * 100;
          const width = Math.max(0.25, ((entry.o1 - entry.o0) / STATE.span) * 100);
          const resultClass =
            passage.result === "放行" ? "res-pass" : passage.result === "拦截" ? "res-block" : passage.result === "混合" ? "res-mixed" : "res-unknown";
          const timeoutClass = lane.signals.passageTimeouts.has(passage.i) ? " timeout" : "";
          return `<div class="bar ${resultClass}${timeoutClass} conf-${passage.confidence}" data-key="${lane.id}#${passage.i}"
            data-lane="${lane.id}" data-i="${passage.i}" style="left:${left}%;width:${width}%"
            title="${passage.start} → ${passage.end} · ${passage.result} · ${passage.basis} · 强度${passage.confidence} · ${passage.eventCount} 条日志"></div>`;
        })
        .join("");

      const coilIds = Object.keys(COILS);
      const coilRows = coilIds
        .map((coilId) => stateRowHtml(lane, lane.signals.coils.get(coilId), hexColor(COILS[coilId].color)))
        .join("");
      const barrierRow = stateRowHtml(lane, lane.signals.barrier, "#e0b155");
      const tickGradient = deviceTicksGradient(lane);
      const deviceRow = `<div class="st-row st-device" title="各设备过程节点（颜色对应设备）">
        <div class="st-fill" style="${tickGradient ? `background-image:${tickGradient}` : ""}"></div></div>`;

      return `<div class="swim-row" data-lane="${lane.id}">
        <div class="swim-label" data-lane="${lane.id}">${lane.id}<small>${lane.metrics.passages} 段</small></div>
        <div class="swim-body">
          <div class="swim-track" data-lane="${lane.id}">
            <div class="density">${densityHtml}</div>
            ${bars}
          </div>
          <div class="swim-states" data-lane="${lane.id}">
            ${coilRows}${barrierRow}${deviceRow}
          </div>
        </div>
      </div>`;
    })
    .join("");

  dom.swimRows.querySelectorAll(".swim-label").forEach((label) => {
    label.addEventListener("click", () => selectLane(label.dataset.lane));
  });
  // 条带元素建索引：每帧切换 live 标记时不再做属性选择器查询
  STATE.barEls = new Map();
  dom.swimRows.querySelectorAll(".bar").forEach((bar) => {
    STATE.barEls.set(bar.dataset.key, bar);
    bar.addEventListener("click", (event) => {
      event.stopPropagation();
      const lane = STATE.lanes.find((item) => item.id === bar.dataset.lane);
      const passage = lane.passages.find((item) => item.i === Number(bar.dataset.i));
      selectPassage(lane, passage);
    });
  });
  const scrubTo = (event) => {
    const rect = dom.swimRows.querySelector(".swim-track").getBoundingClientRect();
    STATE.t = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * STATE.span;
    LOOP.hold(400);
  };
  dom.swimRows.querySelectorAll(".swim-track, .swim-states").forEach((target) => {
    target.addEventListener("click", scrubTo);
  });
  syncStateVisibility();
}

function syncStateVisibility() {
  dom.swimRows.querySelectorAll(".swim-states").forEach((el) => {
    el.classList.toggle("hidden", !STATE.showStates);
  });
}

function selectPassage(lane, passage) {
  STATE.selected = { lane, passage };
  STATE.nodeCursor = -1;
  document.querySelectorAll(".swim-track .bar.sel").forEach((bar) => bar.classList.remove("sel"));
  document.querySelector(`.bar[data-key="${lane.id}#${passage.i}"]`)?.classList.add("sel");
  selectLane(lane.id);
  STATE.t = Math.max(0, passage.o0 - STATE.data.window.offsetMs);
  STATE.playing = false;
  dom.playBtn.textContent = "播放";
  renderDetail();
  LOOP.hold(600);
}

function renderDetail() {
  const selected = STATE.selected;
  if (!selected) return;
  const { lane, passage } = selected;
  const focused = Boolean(STATE.focus && STATE.focus.laneId === lane.id && STATE.focus.passageI === passage.i);
  const solo = soloLogFor(passage);
  const passageTimeout = lane.signals.passageTimeouts.has(passage.i);
  const chips = [
    `<span class="chip ${passage.result === "放行" ? "pass" : passage.result === "拦截" ? "block" : passage.result === "混合" ? "mixed" : ""}">${passage.result}</span>`,
    `<span class="chip">分段依据 ${passage.basis}</span>`,
    `<span class="chip">证据强度 ${passage.confidence}</span>`,
    `<span class="chip${passageTimeout ? " timeout" : ""}">${passage.durationMs} ms${passageTimeout ? " 超时" : ""}</span>`,
    `<span class="chip">${passage.eventCount} 条日志</span>`,
    passage.coilConfirmed ? `<span class="chip pass">线圈闭环</span>` : `<span class="chip">无线圈闭环</span>`,
    passage.coilIds.length ? `<span class="chip">线圈 ${passage.coilIds.join("/")}</span>` : "",
    passage.plates.length ? `<span class="chip">车牌 ${passage.plates.join(" ")}</span>` : `<span class="chip">无车牌</span>`,
    passage.anomalies.length ? `<span class="chip block">异常 ${passage.anomalies.join(" ")}</span>` : "",
  ].join("");

  const maxNodes = 60;
  const nodes = passage.nodes.slice(0, maxNodes);
  const list = nodes
    .map((node, index) => {
      const event = [node.coil, node.barrier].filter(Boolean).join(" ");
      return `<li data-node="${index}" data-o="${node.o}">
        <span class="t">${node.t}</span>
        <span class="dev">${node.device}${event ? ` · ${event}` : ""}</span>
        <span class="tx">${escapeHtml(node.text)}</span>
      </li>`;
    })
    .join("");

  // 这段过程前后的设备状态时间线（线圈 + 栏杆）
  const from = passage.o0 - STATE.data.window.offsetMs;
  const to = passage.o1 - STATE.data.window.offsetMs;
  const stateLines = [];
  lane.signals.coils.forEach((track, coilId) => {
    const signal = signalStateAt(track, to);
    if (signal.state === null) {
      stateLines.push(`<li><span class="dev">线圈${coilId}</span><span class="tx dim">窗口内无该线圈信号</span></li>`);
      return;
    }
    const inside = track.transitions.filter((item) => item.t >= from && item.t <= to);
    const tail = track.intervals[signal.index];
    const flag = signal.timedOut ? ` <b class="warn">超时 ${Math.round(tail.ms / 1000)}s</b>` : "";
    stateLines.push(
      `<li><span class="dev">线圈${coilId}</span><span class="tx">${signal.state ? "压上" : "释放"} @ ${signal.at}${flag} · 本段跳变 ${inside.length} 次${
        inside.length ? `（${inside.map((item) => `${item.at}${item.s ? "压上" : "释放"}`).join("，")}）` : ""
      }</span></li>`
    );
  });
  const barrierSignal = signalStateAt(lane.signals.barrier, to);
  const barrierText = barrierSignal.state === null
    ? "窗口内无栏杆状态信号"
    : `${barrierSignal.state ? "抬杆" : "落杆"} @ ${barrierSignal.at}${barrierSignal.timedOut ? ` <b class="warn">超时 ${Math.round(lane.signals.barrier.intervals[barrierSignal.index].ms / 1000)}s</b>` : ""}`;
  stateLines.push(`<li><span class="dev">栏杆</span><span class="tx">${barrierText}</span></li>`);

  const deviceTail = [...lane.signals.deviceTimes.entries()]
    .map(([device, times]) => {
      const last = times.filter((item) => item <= to).pop();
      return last === undefined ? null : `${DEVICE_LABEL[device] || device} ${formatClock(last).slice(0, 12)}`;
    })
    .filter(Boolean)
    .join(" · ");

  dom.detail.innerHTML = `
    <div class="detail-head">${lane.id} · ${passage.start} → ${passage.end}</div>
    <div class="detail-chips">${chips}</div>
    <div class="detail-actions">
      <button class="detail-btn" id="detailFocus" type="button">${focused ? "← 返回多车道" : "下钻到单车道通行回放"}</button>
      ${
        solo
          ? `<a class="detail-btn linkish" id="detailSolo" href="./index.html?file=${encodeURIComponent(solo.file)}&at=${encodeURIComponent(passage.start)}" title="${solo.vehicle} 的单车日志（${solo.eventCount} 条）里跳到这时刻">单车日志回放 →</a>`
          : ""
      }
    </div>
    <div class="steps">设备序列：${passage.devices.join(" → ") || "-"}${passage.nodes.length > maxNodes ? `（展示前 ${maxNodes} / ${passage.nodes.length} 个节点）` : ""}</div>
    <h3 class="mini">该时间点的设备状态</h3>
    <ul class="state-lines">${stateLines.join("")}</ul>
    <div class="steps dim">最后一次活动：${deviceTail || "-"}</div>
    <h3 class="mini">过程节点</h3>
    <ol class="nodes">${list}</ol>`;

  const focusButton = dom.detail.querySelector("#detailFocus");
  if (focusButton) {
    focusButton.addEventListener("click", () => {
      if (focused) exitFocus();
      else enterFocus(lane.id, passage.i);
    });
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}

function highlightNode() {
  if (!STATE.selected) return;
  const nodes = STATE.selected.passage.nodes;
  let index = -1;
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i].o <= STATE.t + STATE.data.window.offsetMs) index = i;
    else break;
  }
  if (index === STATE.nodeCursor) return;
  STATE.nodeCursor = index;
  dom.detail.querySelectorAll(".nodes li").forEach((item) => {
    item.classList.toggle("ev", Number(item.dataset.node) === index);
  });
}

// ---------------------------------------------------------------------------
// 控件
// ---------------------------------------------------------------------------
function bindControls() {
  dom.playBtn.addEventListener("click", () => {
    // 聚焦回放里播到头之后再按播放 = 从头重播本趟
    if (!STATE.playing && STATE.focus && STATE.t >= STATE.focus.to - 1) STATE.t = STATE.focus.from;
    STATE.playing = !STATE.playing;
    dom.playBtn.textContent = STATE.playing ? "暂停" : "播放";
    LOOP.hold(STATE.playing ? 4000 : 600);
  });
  dom.speedSel.addEventListener("change", () => {
    STATE.speed = Number(dom.speedSel.value) || 1;
    LOOP.hold(300);
  });
  dom.scrub.addEventListener("input", () => {
    STATE.t = sliderToTime(Number(dom.scrub.value));
    LOOP.hold(400);
  });
  dom.resetBtn.addEventListener("click", () => {
    exitFocus();
    STATE.t = 0;
    STATE.selected = null;
    STATE.selectedLane = null;
    STATE.playing = false;
    dom.playBtn.textContent = "播放";
    dom.laneList.querySelectorAll(".lane-item").forEach((item) => item.classList.remove("sel"));
    dom.swimRows.querySelectorAll(".swim-row").forEach((row) => row.classList.remove("sel"));
    setLaneFilter(null);
    camTweenTo(new THREE.Vector3(0, 0, 2), new THREE.Vector3(0, 58, 76));
    dom.detail.innerHTML = `<p class="dim">在下方泳道里点一条过程条带，或按播放让时间游标走过车道。</p>`;
    LOOP.hold(500);
  });
  if (dom.stateToggle) {
    dom.stateToggle.checked = STATE.showStates;
    dom.stateToggle.addEventListener("change", () => {
      STATE.showStates = dom.stateToggle.checked;
      syncStateVisibility();
      LOOP.hold(300);
    });
  }
  if (dom.detailToggle) {
    dom.detailToggle.checked = STATE.showDetails;
    dom.detailToggle.addEventListener("change", () => {
      STATE.showDetails = dom.detailToggle.checked;
      applyDetails();
    });
  }
  if (dom.flashToggle) {
    dom.flashToggle.checked = STATE.flashEnabled;
    dom.flashToggle.addEventListener("change", () => {
      STATE.flashEnabled = dom.flashToggle.checked;
      LOOP.hold(400);
    });
  }
  if (dom.alertToggle) {
    dom.alertToggle.addEventListener("click", () => {
      const collapsed = dom.alertPanel.classList.toggle("collapsed");
      dom.alertToggle.textContent = collapsed ? "展开" : "收起";
      ALERT.signature = "";
      LOOP.hold(200);
    });
  }
}

function resize() {
  if (STATE.swimHeight) {
    document.documentElement.style.setProperty("--swim-height", `${clampSwimHeight(STATE.swimHeight)}px`);
  }
  const stage = dom.canvas.parentElement;
  const width = stage.clientWidth || 800;
  const height = stage.clientHeight || 420;
  STATE.camera.aspect = width / height;
  STATE.camera.updateProjectionMatrix();
  STATE.renderer.setSize(width, height, false);
  STATE.bloom?.setSize(width, height);
  STATE.swimGeom = swimGeometry();
  placeVehicleFloat();
  LOOP.hold(300);
}

/**
 * 悬浮清单要挂在状态胶囊下面：窄窗口时胶囊会折成两行，写死 top 就会被压住。
 * 量的是胶囊的实际盒高（不猜行数），窗口一变就重排。
 */
function placeVehicleFloat() {
  if (!dom.vehicleFloat) return;
  const hud = document.querySelector(".hud");
  const stage = dom.canvas.parentElement;
  if (!hud || !stage) return;
  const stageTop = stage.getBoundingClientRect().top;
  const top = Math.max(52, hud.getBoundingClientRect().bottom - stageTop + 10);
  dom.vehicleFloat.style.top = `${Math.round(top)}px`;
  // 底下给「超时胶囊」（bottom 12px）留出位置，清单再长也不压它
  dom.vehicleFloat.style.maxHeight = `${Math.max(150, Math.round(stage.clientHeight - top - 46))}px`;
}

// ---------------------------------------------------------------------------
// 时间线区域高度：拖动分隔条调整（双击复位，聚焦后 ↑/↓ 微调），高度记在 localStorage
// ---------------------------------------------------------------------------
function clampSwimHeight(value) {
  const mainHeight = dom.main ? dom.main.clientHeight : window.innerHeight;
  const controlsHeight = dom.controls ? dom.controls.getBoundingClientRect().height : 60;
  const max = Math.max(SWIM_MIN, mainHeight - controlsHeight - STAGE_MIN);
  return Math.max(SWIM_MIN, Math.min(max, Math.round(Number(value) || 0) || SWIM_MIN));
}

function applySwimHeight(value, persist = false) {
  const height = clampSwimHeight(value);
  STATE.swimHeight = height;
  document.documentElement.style.setProperty("--swim-height", `${height}px`);
  if (dom.swimResizer) dom.swimResizer.dataset.size = `${height}px`;
  if (persist) {
    try {
      localStorage.setItem(SWIM_STORE_KEY, String(height));
    } catch (error) {
      /* 隐私模式/禁用存储时忽略 */
    }
  }
  resize(); // 画布必须跟着改尺寸，否则画面被拉伸
}

function bindSwimResize() {
  const handle = dom.swimResizer;
  if (!handle) return;

  let stored = 0;
  try {
    stored = Number(localStorage.getItem(SWIM_STORE_KEY)) || 0;
  } catch (error) {
    stored = 0;
  }
  applySwimHeight(stored || (dom.main ? dom.main.clientHeight : window.innerHeight) * 0.46, false);

  let dragging = false;
  const drag = (event) => {
    if (!dragging) return;
    // 分隔条跟随指针：区域高度 = 控制条顶边 - 指针 Y
    applySwimHeight(dom.controls.getBoundingClientRect().top - event.clientY, false);
    event.preventDefault();
  };
  const stop = (event) => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("resizing");
    if (event && event.pointerId !== undefined) {
      try {
        if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      } catch (error) {
        /* 指针已消失时忽略 */
      }
    }
    applySwimHeight(STATE.swimHeight, true);
  };

  handle.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    dragging = true;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch (error) {
      /* 合成事件/指针已释放时退回窗口级监听，仍然可以拖 */
    }
    document.body.classList.add("resizing");
    event.preventDefault();
  });
  // 监听挂在 window 上：指针移出手柄、甚至移出窗口也不会丢拖拽
  window.addEventListener("pointermove", drag);
  window.addEventListener("pointerup", stop);
  window.addEventListener("pointercancel", stop);
  handle.addEventListener("dblclick", () => {
    applySwimHeight((dom.main ? dom.main.clientHeight : window.innerHeight) * 0.46, true);
  });
  handle.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      applySwimHeight(STATE.swimHeight + (event.key === "ArrowUp" ? step : -step), true);
    } else if (event.key === "Home") {
      event.preventDefault();
      applySwimHeight(SWIM_MIN, true);
    } else if (event.key === "End") {
      event.preventDefault();
      applySwimHeight(dom.main ? dom.main.clientHeight : window.innerHeight, true);
    }
  });
}

// ---------------------------------------------------------------------------
// 文字标签（本页的站点标题牌，样式与车道设备标签不同）
// ---------------------------------------------------------------------------
const labelCache = new Map();

function makeLabel(text, sub, color) {
  const key = `${text}|${sub}|${color}`;
  if (labelCache.has(key)) return labelCache.get(key).clone();
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 160;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgba(14,17,22,0.82)";
  roundRect(ctx, 6, 6, 500, 148, 18);
  ctx.fill();
  ctx.strokeStyle = "rgba(120,160,200,0.5)";
  ctx.lineWidth = 3;
  roundRect(ctx, 6, 6, 500, 148, 18);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = "bold 62px Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 256, 58);
  if (sub) {
    ctx.font = "34px 'Microsoft YaHei', sans-serif";
    ctx.fillStyle = "#93a6ba";
    ctx.fillText(sub, 256, 116);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
  sprite.scale.set(9.6, 3, 1);
  labelCache.set(key, sprite);
  return sprite.clone();
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// 只读调试句柄：给无头验证/现场排查用，不参与任何渲染逻辑
// ---------------------------------------------------------------------------
window.__LANES__ = {
  STATE,
  LOOP,
  seek(t) {
    STATE.t = Math.max(0, Math.min(STATE.span, Number(t) || 0));
    LOOP.hold(400);
  },
  /** 自检用：「细节」开关与接地暗部是否同步（关掉细节后暗斑不该留在原地）。 */
  setDetails(value) {
    STATE.showDetails = Boolean(value);
    if (dom.detailToggle) dom.detailToggle.checked = STATE.showDetails;
    applyDetails();
    return STATE.contactAO ? STATE.contactAO.count : null;
  },
  /** 自检用：某条车道此刻的栏杆姿态 —— 直接用场景里的真实对象量（不重算一遍公式）。 */
  barrierPose(laneId) {
    const model = STATE.models.get(laneId);
    if (!model || !model.barrier) return null;
    const world = new THREE.Vector3();
    model.barrierTip?.getWorldPosition(world);
    const stored = STATE.barrierPoses ? STATE.barrierPoses.get(laneId) : null;
    const device = model.devices.get("barrier") || null;
    const lampMaterial = device ? (device.lampMaterial || (device.lamp && device.lamp.material) || null) : null;
    return {
      angleDeg: THREE.MathUtils.radToDeg(model.barrier.rotation.z),
      tipY: model.barrierTip ? world.y : null,
      open: stored ? stored.open : null,
      traveling: stored ? stored.traveling : null,
      lamp: lampMaterial ? lampMaterial.emissiveIntensity : null,
    };
  },
  /** 自检用：栏杆跳变时刻（窗口内秒）。 */
  barrierTransitions(laneId) {
    const lane = STATE.lanes.find((item) => item.id === laneId);
    if (!lane) return null;
    return lane.signals.barrier.transitions.map((item) => ({ t: item.t, s: item.s, at: item.at }));
  },
  /** 自检用：所有有栏杆信号的车道 id。 */
  barrierLaneIds() {
    return STATE.lanes.filter((lane) => lane.signals.barrier.transitions.length >= 2).map((lane) => lane.id);
  },
  setSwimHeight(px) {
    applySwimHeight(px, true);
    return STATE.swimHeight;
  },
  get swimHeight() {
    return STATE.swimHeight;
  },
  model(laneId) {
    return STATE.models.get(laneId) || null;
  },
  timeoutsAt(laneId) {
    return STATE.timeouts.get(laneId) || [];
  },
  signalAt(laneId, coilId, t) {
    const lane = STATE.lanes.find((item) => item.id === laneId);
    if (!lane) return null;
    const track = lane.signals.coils.get(coilId);
    return track ? signalStateAt(track, t) : null;
  },
  laneSignalSummary(laneId) {
    const lane = STATE.lanes.find((item) => item.id === laneId);
    if (!lane) return null;
    return {
      coils: [...lane.signals.coils.entries()].map(([id, track]) => ({
        id,
        jumps: track.transitions.length,
        timeouts: track.timeouts.length,
      })),
      barrier: { jumps: lane.signals.barrier.transitions.length, timeouts: lane.signals.barrier.timeouts.length },
      passageTimeouts: [...lane.signals.passageTimeouts],
      ticks: lane.signals.ticks.length,
    };
  },
  // ---- 交互：车道高亮 / 拦截超时清单 / 单车道下钻（自检用） ----
  selectLane(laneId) {
    selectLane(laneId);
    return STATE.selectedLane;
  },
  get selectedLane() {
    return STATE.selectedLane;
  },
  /** 三维高亮层：哪条亮着、亮度多少 —— 亮点在画布上，只能这样核对 */
  highlightState() {
    const lit = [];
    STATE.models.forEach((model, laneId) => {
      if (model.highlight && model.highlight.group.visible) {
        lit.push({ laneId, opacity: Math.round(model.highlight.materials[0].opacity * 1000) / 1000 });
      }
    });
    return { lit, level: Math.round((STATE.highlightLevel || 0) * 1000) / 1000 };
  },
  incidents() {
    return STATE.incidents.map((item) => ({
      laneId: item.lane.id,
      passage: item.passage.i,
      start: item.passage.start,
      plate: item.passage.plates[0] || null,
      kind: item.passage.vehicle ? item.passage.vehicle.kind : null,
      classLabel: item.passage.vehicle ? item.passage.vehicle.classLabel : null,
      axles: item.passage.vehicle ? item.passage.vehicle.axles : null,
      kinds: item.kinds,
      reason: item.reasons[0] || "",
    }));
  },
  vehicleFloatRows() {
    return [...document.querySelectorAll("#vehicleFloatBody .vf-item")].map((row) => ({
      laneId: row.dataset.lane,
      passage: Number(row.dataset.i),
      plate: (row.querySelector(".vf-plate") || {}).textContent || "",
      badges: [...row.querySelectorAll(".vf-badge")].map((badge) => badge.textContent),
      iconShapes: row.querySelectorAll("svg.vf-icon *").length,
      iconWheels: row.querySelectorAll("svg.vf-icon circle").length / 2,
      focused: row.classList.contains("focused"),
    }));
  },
  setFilter(filter) {
    STATE.filter = filter;
    dom.vfChips.forEach((chip) => chip.classList.toggle("on", chip.dataset.filter === filter));
    renderVehicleFloat();
    return visibleIncidents().length;
  },
  setFlash(on) {
    STATE.flashEnabled = Boolean(on);
    if (dom.flashToggle) dom.flashToggle.checked = STATE.flashEnabled;
    LOOP.hold(400);
    return STATE.flashEnabled;
  },
  clearLaneFilter() {
    setLaneFilter(null);
    return visibleIncidents().length;
  },
  enterFocus(laneId, passageI) {
    enterFocus(laneId, passageI);
    return this.focusState();
  },
  exitFocus() {
    exitFocus();
    return this.focusState();
  },
  focusState() {
    const focus = STATE.focus;
    const hidden = [];
    STATE.models.forEach((model, laneId) => {
      if (model.group.visible === false) hidden.push(laneId);
    });
    const solo = focus ? soloLogFor(focusPassage(focus.laneId, focus.passageI)) : null;
    return {
      active: Boolean(focus),
      laneId: focus ? focus.laneId : null,
      passage: focus ? focus.passageI : null,
      from: focus ? Math.round(focus.from) : null,
      to: focus ? Math.round(focus.to) : null,
      t: Math.round(STATE.t),
      hiddenLanes: hidden,
      visibleLanes: STATE.lanes.length - hidden.length,
      bodyClass: document.body.classList.contains("single-lane"),
      focusBarHidden: dom.focusBar ? dom.focusBar.hidden : null,
      focusRows: document.querySelectorAll(".swim-row.focus").length,
      hiddenRows: [...document.querySelectorAll(".swim-row")].filter((row) => row.offsetParent === null).length,
      playing: STATE.playing,
      slider: Number(dom.scrub.value),
      deepLink: dom.focusDeepLink && !dom.focusDeepLink.hidden ? dom.focusDeepLink.getAttribute("href") : null,
      soloPlate: solo ? solo.vehicle : null,
    };
  },
  /** 点击类交互也走同一套 handler：自检里 dispatch 真事件，而不是直接调内部函数 */
  click(selector) {
    const node = document.querySelector(selector);
    if (!node) return null;
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  },
  frame(ms = 260) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
};

