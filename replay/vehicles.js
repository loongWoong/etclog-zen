// 车辆模型总览：把 11 个车型族按网格摆出来，用于人工核对造型与配色
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { buildVehicleModel, setShadowTint, setSunDirection } from "./vehicle-models.js";
import { addPropShadows } from "./prop-shadows.js";
import { createRenderLoop, createRenderer, detectGpu, frameInterval, mountGpuBadge } from "./render-runtime.js";
import { addGroundHaze, applyRenderLook, applyShadowFlags, asphaltMaterial, createBloomPipeline, setupSky } from "./scene-look.js";

/** 只用于展示的车型表：kind / 轴数 / 典型长宽高 / 号牌 / 车牌颜色 / 车身颜色 */
const FAMILIES = [
  { label: "客一 轿车", kind: "car", axles: 2, dims: [4.7, 1.85, 1.5], plate: "京A00001", plateColor: 0, color: "#eef1f4" },
  { label: "客二 中客", kind: "van", axles: 2, dims: [6.0, 2.0, 2.45], plate: "京A00002", plateColor: 0, color: "#2c6fb5" },
  { label: "客四 大客", kind: "coach", axles: 2, dims: [11.9, 2.55, 3.7], plate: "京A00003", plateColor: 1, color: "#eef1f4" },
  { label: "货一 轻卡", kind: "lightTruck", axles: 2, dims: [5.8, 2.1, 2.6], plate: "京A00004", plateColor: 0, color: "#eef1f4" },
  { label: "货二 2 轴", kind: "mediumTruck", axles: 2, dims: [9.6, 2.4, 3.0], plate: "京A00005", plateColor: 1, color: "#2f7d4f" },
  { label: "货三 3 轴", kind: "rigid3", axles: 3, dims: [11.0, 2.5, 3.6], plate: "京A00006", plateColor: 1, color: "#b9c0c8" },
  { label: "货四 4 轴", kind: "rigid4", axles: 4, dims: [12.0, 2.5, 3.8], plate: "京A00007", plateColor: 1, color: "#7d858e" },
  { label: "货五 半挂", kind: "semi5", axles: 5, dims: [16.5, 2.5, 4.0], plate: "京A00008", plateColor: 1, color: "#eef1f4" },
  { label: "货六 半挂", kind: "semi6", axles: 6, dims: [18.5, 2.5, 4.05], plate: "京A00009", plateColor: 1, color: "#2c6fb5" },
  { label: "危险品货车", kind: "mediumTruck", axles: 2, dims: [9.6, 2.4, 3.0], plate: "京A00010", plateColor: 1, color: "#e0a71a", dangerous: true },
  { label: "专项作业车", kind: "special", axles: 4, dims: [11.0, 2.5, 3.6], plate: "京A00011", plateColor: 1, color: "#a92330", special: true },
];

const COLUMNS = 4;
const SPACING_X = 15;
const SPACING_Z = 27;

const canvas = document.getElementById("scene");
// GPU 优先：和两个回放页面用同一套检测/降级逻辑（软件渲染时关阴影、压像素比）
const gpu = detectGpu();
const renderer = createRenderer(canvas, gpu);
applyRenderLook(renderer, gpu);

const scene = new THREE.Scene();
const LOOK = setupSky(scene, renderer, { software: gpu.software, shadowRadius: 78 });
setSunDirection(LOOK.direction);            // 展台车辆的地面阴影也按这颗太阳铺
setShadowTint(LOOK.shadowTint);             // 影色/深浅由场景灯光算出（影子里的地面只剩天光）

const camera = new THREE.PerspectiveCamera(42, 1, 0.5, 900);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI / 2 - 0.04;
controls.target.set(0, 2.2, 0);

// 泛光 + 统一色调映射管线：车漆高光、尾灯、金属边缘的光晕。
// 软件渲染下不建泛光 pass（省一遍全屏模糊），但同样走 RT+OutputPass，画面与 GPU 一致。
const BLOOM = createBloomPipeline(renderer, scene, camera, { enabled: !gpu.software });
LOOK.followSky(camera);   // 天空穹顶挂在相机上，先摆好再画第一帧

// 展台地面：沥青广场 + 网格参考线（网格只作参照，尽量压暗）
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(600, 600),
  asphaltMaterial({ color: "#666d76", repeat: [150, 150], roughness: 0.95 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const grid = new THREE.GridHelper(300, 60, 0x59677a, 0x3b4655);
grid.position.y = 0.012;
grid.material.transparent = true;
grid.material.opacity = 0.34;
scene.add(grid);
addGroundHaze(scene, { y: -0.12, color: "#8d97a1" });

/** 展台：所有车辆挂在同一组里，用时间驱动整组旋转（与帧率无关） */
const turntable = new THREE.Group();
scene.add(turntable);

function makeLabel(text) {
  const scale = 4;
  const pad = 24;
  const canvasLabel = document.createElement("canvas");
  const ctx = canvasLabel.getContext("2d");
  ctx.font = `600 ${44}px "Microsoft YaHei", sans-serif`;
  const width = Math.ceil(ctx.measureText(text).width) + pad * 2;
  canvasLabel.width = width;
  canvasLabel.height = 88;
  const ctx2 = canvasLabel.getContext("2d");
  ctx2.fillStyle = "rgba(12, 18, 24, 0.78)";
  ctx2.fillRect(0, 0, canvasLabel.width, canvasLabel.height);
  ctx2.font = `600 44px "Microsoft YaHei", sans-serif`;
  ctx2.fillStyle = "#cfe3f5";
  ctx2.textBaseline = "middle";
  ctx2.fillText(text, pad, canvasLabel.height / 2);
  const texture = new THREE.CanvasTexture(canvasLabel);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  sprite.scale.set(canvasLabel.width / canvasLabel.height * 1.5 * scale * 0.3, 1.5 * scale * 0.3, 1);
  return sprite;
}

const holders = [];
FAMILIES.forEach((family, index) => {
  const column = index % COLUMNS;
  const row = Math.floor(index / COLUMNS);
  const x = (column - (COLUMNS - 1) / 2) * SPACING_X;
  const z = (row - Math.floor((FAMILIES.length - 1) / COLUMNS) / 2) * SPACING_Z;
  const built = buildVehicleModel(
    {
      kind: family.kind,
      axles: family.axles,
      dims: { length: family.dims[0], width: family.dims[1], height: family.dims[2] },
      plate: family.plate,
      plateColorCode: family.plateColor,
      dangerous: Boolean(family.dangerous),
      special: Boolean(family.special),
    },
    { detail: true, bodyColor: family.color, bodyColorSource: "示意配色" },
  );
  built.group.position.set(x, 0, z);
  turntable.add(built.group);

  const label = makeLabel(family.label);
  label.position.set(x, family.dims[2] + 2.6, z);
  turntable.add(label);
  holders.push({ family, built, x, z });
});

// 展台里所有车辆都投射/接收阴影（转台旋转时影子跟着扫，真实感主要来自这里）
applyShadowFlags(turntable);
// 硬影层：展台上没有灯杆/机柜/树，这里建出来是**空的**——留着是为了让"这一页没有静态构件"
// 在自检里显式成立（而不是探针拿不到数据、看起来像坏了）。
addPropShadows(scene, {
  direction: LOOK.direction,
  tint: LOOK.shadowTint,
  ground: { minX: -300, maxX: 300, minZ: -300, maxZ: 300 },
});

// 视角自动适配：转台绕 Y 轴过原点旋转，用「包含所有模型的水平半径 + 中心高度」取景，
// 这样任何旋转角度下都在画面里。
const bounds = new THREE.Box3();
holders.forEach(({ built }) => bounds.expandByObject(built.group));
const maxAbsX = Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x));
const maxAbsZ = Math.max(Math.abs(bounds.min.z), Math.abs(bounds.max.z));
const radius = Math.hypot(maxAbsX, maxAbsZ) * 1.02;
const focus = new THREE.Vector3(0, (bounds.min.y + bounds.max.y) / 2, 0);
const direction = new THREE.Vector3(0.92, 0.62, 1).normalize();
const distance = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 0.86;
const home = focus.clone().add(direction.multiplyScalar(distance));
controls.target.copy(focus);

function resetView() {
  camera.position.copy(home);
  controls.target.copy(focus);
  controls.update();
}
resetView();

let spinning = true;
let spinStart = performance.now();
let spinAngle = 0;
function applySpin(now) {
  if (!spinning) return;
  spinAngle = ((now - spinStart) / 1000) * 0.14;
  turntable.rotation.y = spinAngle;
}
applySpin(performance.now());

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / Math.max(1, height);
  camera.updateProjectionMatrix();
  BLOOM.setSize(width, height);
}
window.addEventListener("resize", resize);
resize();

mountGpuBadge(document.getElementById("gpuBadge"), gpu, "inline");
const spinButton = document.getElementById("spinToggle");
spinButton.textContent = "停止旋转";

const LOOP = createRenderLoop({
  onFrame: () => {
    applySpin(performance.now());
    LOOK.followSky(camera);
    controls.update();
    BLOOM.render();
    if (spinning) LOOP.hold(150);   // 旋转时持续出帧，停转后自动回到空闲
  },
  keepAlive: false,
  minInterval: frameInterval(gpu.software),
});
controls.addEventListener("change", () => LOOP.hold(220));
LOOP.hold(600);

document.getElementById("resetView").addEventListener("click", () => {
  spinning = false;
  spinButton.textContent = "自动旋转";
  resetView();
  LOOP.hold(600);
});
spinButton.addEventListener("click", () => {
  spinning = !spinning;
  spinButton.textContent = spinning ? "停止旋转" : "自动旋转";
  if (spinning) {
    spinStart = performance.now() - (spinAngle / 0.14) * 1000;   // 从当前角度继续转
  }
  LOOP.hold(600);
});

window.__GALLERY__ = { scene, holders, camera, controls, turntable, renderer, resetView, LOOP, gpu, bloom: BLOOM };
