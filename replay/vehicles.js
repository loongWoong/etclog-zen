// 车辆模型总览：把 11 个车型族按网格摆出来，用于人工核对造型与配色
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { buildVehicleModel } from "./vehicle-models.js";
import { createRenderLoop, detectGpu, mountGpuBadge } from "./render-runtime.js";

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
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = false;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1219);
scene.fog = new THREE.Fog(0x0d1219, 90, 220);

const camera = new THREE.PerspectiveCamera(42, 1, 0.5, 600);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI / 2 - 0.04;
controls.target.set(0, 2.2, 0);

scene.add(new THREE.HemisphereLight(0xdfe9f5, 0x2a2f36, 1.05));
const sun = new THREE.DirectionalLight(0xfff2dd, 1.5);
sun.position.set(26, 42, 30);
scene.add(sun);
const fill = new THREE.DirectionalLight(0x9fc4ff, 0.45);
fill.position.set(-30, 20, -26);
scene.add(fill);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshStandardMaterial({ color: 0x1b2129, roughness: 0.95, metalness: 0.02 }),
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
const grid = new THREE.GridHelper(400, 40, 0x2e3a46, 0x232c35);
grid.position.y = 0.01;
scene.add(grid);

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
  scene.add(built.group);

  const label = makeLabel(family.label);
  label.position.set(x, family.dims[2] + 2.6, z);
  scene.add(label);
  holders.push({ family, built, x, z });
});

// 视角自动适配所有模型
const bounds = new THREE.Box3();
holders.forEach(({ built }) => bounds.expandByObject(built.group));
const center = bounds.getCenter(new THREE.Vector3());
const radius = bounds.getSize(new THREE.Vector3()).length() / 2;
const direction = new THREE.Vector3(0.92, 0.62, 1).normalize();
const distance = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 0.82;
const home = center.clone().add(direction.multiplyScalar(distance));
controls.target.copy(center);

function resetView() {
  camera.position.copy(home);
  controls.target.copy(center);
  controls.update();
}
resetView();

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / Math.max(1, height);
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

const gpu = detectGpu();
mountGpuBadge(document.getElementById("gpuBadge"), gpu, "inline");

let spinning = true;
const spinButton = document.getElementById("spinToggle");
spinButton.textContent = "停止旋转";

const LOOP = createRenderLoop({
  onFrame: () => {
    controls.update();
    renderer.render(scene, camera);
    if (spinning) LOOP.hold(150);   // 旋转时持续出帧，停转后自动回到空闲
  },
  keepAlive: false,
});
controls.autoRotate = true;
controls.autoRotateSpeed = 0.7;
controls.addEventListener("change", () => LOOP.hold(220));
LOOP.hold(600);

document.getElementById("resetView").addEventListener("click", () => {
  spinning = false;
  controls.autoRotate = false;
  spinButton.textContent = "自动旋转";
  resetView();
  LOOP.hold(600);
});
spinButton.addEventListener("click", () => {
  spinning = !spinning;
  controls.autoRotate = spinning;
  spinButton.textContent = spinning ? "停止旋转" : "自动旋转";
  LOOP.hold(600);
});

window.__GALLERY__ = { scene, holders, camera, controls, resetView, LOOP };
