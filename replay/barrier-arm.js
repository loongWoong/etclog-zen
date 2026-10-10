// ---------------------------------------------------------------------------
// 道闸（电动栏杆机）的真实动作与外观
//
// 之前两页的栏杆臂都只抬到 -26°（几乎是水平挑一下），而且角度是"每帧朝目标缓动"攒出来的：
// 拖时间轴跳着看时，画面上的角度取决于你从哪儿拖过来，同一个时刻能看出两个不同的姿态。
//
// 这个模块把三件事定死：
//   1. 抬杆到位 = 臂接近竖直（真实直臂道闸抬到 80~90°，不是 26°）；
//   2. 行程有时长（抬 0.9s / 落 1.1s，落杆略慢），中间用缓入缓出，能看出机械加速与到位前的减速；
//   3. 角度是**跳变序列 + 当前时刻**的纯函数 —— 拖到哪一秒都是同一个角度，中途反转也能接得上。
//
// 涂装按中国收费站直臂道闸的常见样式：红白相间 + 白端头 + 杆座黄闪警示灯。
// ---------------------------------------------------------------------------
import * as THREE from "three";

export const BARRIER = {
  openDeg: -86,      // 抬杆到位：臂接近竖直（水平 = 0°）
  upSeconds: 0.9,    // 抬杆行程（6m 直臂的常见规格约 1s）
  downSeconds: 1.1,  // 落杆行程略慢一点（真实设备也是这么做安全）
  lampHz: 2.0,       // 运行中的黄闪频率（≈2 次/秒）
};

const GEO_CACHE = new Map();
const TEX_CACHE = new Map();

function boxGeometry(w, h, d) {
  const key = `${w}|${h}|${d}`;
  let geometry = GEO_CACHE.get(key);
  if (!geometry) {
    geometry = new THREE.BoxGeometry(w, h, d);
    GEO_CACHE.set(key, geometry);
  }
  return geometry;
}

/** 红白相间涂装：12 段，正好是 6.2m 臂上 0.52m 一段（真实反光带就是这个量级） */
export function barrierStripeTexture() {
  if (TEX_CACHE.has("stripe")) return TEX_CACHE.get("stripe");
  const canvas = document.createElement("canvas");
  canvas.width = 768;
  canvas.height = 48;
  const ctx = canvas.getContext("2d");
  const blocks = 12;
  const step = canvas.width / blocks;
  for (let index = 0; index < blocks; index += 1) {
    ctx.fillStyle = index % 2 === 0 ? "#d8382f" : "#eef2f7";
    ctx.fillRect(Math.round(index * step), 0, Math.ceil(step) + 1, canvas.height);
  }
  // 段与段之间的细黑缝 + 上下边缘的暗线：远看才有"一根杆"的轮廓，不然像一条平色带
  ctx.fillStyle = "rgba(20,24,30,0.55)";
  for (let index = 1; index < blocks; index += 1) {
    ctx.fillRect(Math.round(index * step), 0, 2, canvas.height);
  }
  ctx.fillStyle = "rgba(12,16,22,0.5)";
  ctx.fillRect(0, 0, canvas.width, 3);
  ctx.fillRect(0, canvas.height - 3, canvas.width, 3);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  TEX_CACHE.set("stripe", texture);
  return texture;
}

/** 缓入缓出：起步与到位前都慢，中间快（正弦式的机械感） */
export function easeInOut(progress) {
  const p = Math.min(1, Math.max(0, progress));
  return p < 0.5 ? 2 * p * p : 1 - 2 * (1 - p) * (1 - p);
}

/** 单段行程：从 from 到 to 走了 elapsed 秒、总时长 seconds */
export function travelAngle(from, to, elapsed, seconds) {
  return from + (to - from) * easeInOut(seconds > 0 ? elapsed / seconds : 1);
}

/**
 * 栏杆角度（弧度）——跳变序列 + 当前时刻的纯函数。
 * transitions: [{ t, s（true=抬杆） }]，按时间升序。
 * `timeScale`：时间轴单位换算成秒的系数（多车道页的时间轴单位是毫秒，传 0.001）。
 * `from` 是"第一次跳变之前臂在哪儿"：默认取第一次跳变的反面（日志第一次记抬杆，
 * 那之前必然是落着的）—— 这是个显式假设，写在返回值里以便自检核对。
 */
export function barrierAngleAt(transitions, t, options = {}) {
  const openDeg = options.openDeg ?? BARRIER.openDeg;
  const upSeconds = options.upSeconds ?? BARRIER.upSeconds;
  const downSeconds = options.downSeconds ?? BARRIER.downSeconds;
  const timeScale = options.timeScale ?? 1;
  const openRad = THREE.MathUtils.degToRad(openDeg);
  const closedRad = 0;
  const list = transitions || [];
  const preOpen = list.length ? !list[0].s : false;
  let angle = preOpen ? openRad : closedRad;
  let segmentStart = 0;
  let segmentFrom = angle;
  let segmentTo = angle;
  let segmentTravel = 1;
  let known = false;
  for (const item of list) {
    if (item.t * timeScale > t * timeScale) break;
    if (known) angle = travelAngle(segmentFrom, segmentTo, (item.t - segmentStart) * timeScale, segmentTravel);
    segmentFrom = angle;
    segmentTo = item.s ? openRad : closedRad;
    segmentTravel = item.s ? upSeconds : downSeconds;
    segmentStart = item.t;
    known = true;
  }
  const elapsed = known ? (t - segmentStart) * timeScale : Infinity;
  if (known) angle = travelAngle(segmentFrom, segmentTo, elapsed, segmentTravel);
  return {
    angle,
    open: known ? segmentTo === openRad : preOpen,
    traveling: known && elapsed < segmentTravel,
    progress: known ? Math.min(1, Math.max(0, elapsed / segmentTravel)) : 1,
    assumedBeforeFirst: preOpen,
  };
}

/**
 * 建一台栏杆机：杆座 + 转轴 + 红白相间直臂 + 白端头 + 配重 + 黄闪警示灯。
 * 尺寸与原来的内联实现逐项一致（杆座 0.55×0.9×0.55、轴高 1.12、臂 6.2×0.12×0.12、端头 x=-6.05），
 * 只是多了涂装、配重与警示灯。转轴沿用原来的名字（index 用 barrierArm、多车道用 barrierPivot）。
 */
export function createBarrierArm({
  length = 6.2,
  pivotY = 1.12,
  armColor = 0xeb5757,
  tipColor = 0xf4f6f8,
  lampColor = 0xf2c94c,
  pivotName = "barrierPivot",
} = {}) {
  const group = new THREE.Group();

  const baseMat = new THREE.MeshStandardMaterial({ color: 0x313946, roughness: 0.7, metalness: 0.12 });
  const base = new THREE.Mesh(boxGeometry(0.55, 0.9, 0.55), baseMat);
  base.position.set(0, 0.67, 0);
  group.add(base);

  const pivot = new THREE.Group();
  pivot.position.set(0, pivotY, 0);
  pivot.name = pivotName;
  group.add(pivot);

  // 臂：红白相间（白 = 反光带），端头白色，都是从真实道闸上抄的比例
  const armMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: barrierStripeTexture(),
    roughness: 0.45,
    metalness: 0.1,
  });
  const arm = new THREE.Mesh(boxGeometry(length, 0.12, 0.12), armMaterial);
  arm.position.set(-length / 2 + 0.1, 0, 0);
  const tip = new THREE.Mesh(
    boxGeometry(0.12, 0.36, 0.36),
    new THREE.MeshStandardMaterial({ color: tipColor, roughness: 0.5, metalness: 0.05 }),
  );
  tip.position.set(-(length - 0.15), 0, 0);
  pivot.add(arm, tip);

  // 配重（真实道闸转轴另一侧的平衡块）+ 黄闪警示灯（运行中闪烁）
  const counterweight = new THREE.Mesh(
    boxGeometry(0.5, 0.28, 0.26),
    new THREE.MeshStandardMaterial({ color: 0x2b323d, roughness: 0.75, metalness: 0.2 }),
  );
  counterweight.position.set(0.42, 0.02, 0);
  pivot.add(counterweight);

  const lampMaterial = new THREE.MeshStandardMaterial({
    color: lampColor,
    emissive: new THREE.Color(lampColor),
    emissiveIntensity: 0,
    roughness: 0.4,
  });
  const lamp = new THREE.Mesh(boxGeometry(0.16, 0.16, 0.16), lampMaterial);
  lamp.position.set(0.34, 1.18, 0);
  lamp.name = "barrierLamp";
  group.add(lamp);

  const setAngle = (radians) => { pivot.rotation.z = radians; };
  /** 警示灯亮度：0 = 灭；运行中按 lampHz 闪烁（调色板上的黄闪） */
  const setLamp = (level) => {
    lampMaterial.emissiveIntensity = Math.max(0, level) * 1.6;
    lampMaterial.emissive.setHex(level > 0.01 ? lampColor : 0x3a3222);
  };
  setLamp(0);

  return { group, pivot, arm, tip, lamp, counterweight, setAngle, setLamp, armMaterial, lampMaterial };
}
