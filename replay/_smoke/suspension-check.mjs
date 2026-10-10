/**
 * 悬挂俯仰的离线几何/动力学自检：把 vehicle-models 的俯仰枢轴与控制器拿到浏览器外跑，
 * 直接量「车头是不是真的比车尾低」「车轮有没有浮起来/陷进地面」「接地阴影有没有跟着歪」。
 * 用法（在 replay/ 下）：
 *   python _smoketool.py _smoke/suspension-check.mjs && node _smoke/suspension-check.mjs
 */
import * as THREE from "./vendor/three/build/three.module.mjs";
import { buildVehicleModel, createSuspensionController } from "./vehicle-models.mjs";

// 浏览器外的 canvas 替身：这些几何/矩阵断言不关心贴图像素，但不能因为缺 canvas 就抛错
const fakeCanvas = { width: 0, height: 0, style: {}, getContext: () => fakeContext };
const fakeContext = new Proxy({}, {
  get: (target, key) => {
    if (key === "createRadialGradient" || key === "createLinearGradient") return () => ({ addColorStop() {} });
    if (key === "getImageData") return () => ({ data: new Uint8ClampedArray(4) });
    if (key === "measureText") return () => ({ width: 8 });
    if (key === "canvas") return fakeCanvas;
    return () => undefined;
  },
});
globalThis.document = { createElement: () => fakeCanvas };

const failures = [];
function check(ok, label, detail) {
  console.log(`  [${ok ? "OK" : "!!"}] ${label}${detail ? `　${detail}` : ""}`);
  if (!ok) failures.push(label);
}

const DEG = Math.PI / 180;
const SPECS = [
  { name: "轿车 4.7m", kind: "car", axles: 2, dims: { length: 4.7, width: 1.85, height: 1.5 } },
  { name: "客车 12m", kind: "bus", axles: 2, dims: { length: 12, width: 2.55, height: 3.6 } },
  { name: "半挂 16.5m", kind: "semi", axles: 6, dims: { length: 16.5, width: 2.55, height: 4.05 } },
];

console.log("=== 俯仰枢轴的几何 ===");
for (const spec of SPECS) {
  const model = buildVehicleModel(spec, { detail: true });
  const root = new THREE.Group();
  root.add(model.group);
  // 车身前后两端的探针（挂在俯仰枢轴上）：直接量刚性车身的倾角，而不是车轮
  const axleZs = model.wheels.map((axle) => axle.position.z);
  const halfSpread = axleZs.length ? Math.max(...axleZs.map(Math.abs)) : spec.dims.length / 2;
  const probeHeight = spec.dims.height / 2;
  const frontProbe = new THREE.Object3D();
  frontProbe.position.set(0, probeHeight, halfSpread);
  const rearProbe = new THREE.Object3D();
  rearProbe.position.set(0, probeHeight, -halfSpread);
  model.pitchPivot.add(frontProbe, rearProbe);
  const bodyTilt = () => {
    root.updateMatrixWorld(true);
    const front = frontProbe.getWorldPosition(new THREE.Vector3()).y;
    const rear = rearProbe.getWorldPosition(new THREE.Vector3()).y;
    return { front, rear, delta: front - rear };
  };
  const wheelDrop = () => {
    root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    for (const axle of model.wheels) box.expandByObject(axle);
    return box.min.y;
  };

  model.setPitch(0);
  const level = bodyTilt();
  const wheelLevel = wheelDrop();
  const maxPitch = model.maxPitchDeg * DEG;
  model.setPitch(maxPitch);
  const noseDown = bodyTilt();
  model.setPitch(-maxPitch);
  const noseUp = bodyTilt();

  check(Math.abs(level.delta) < 1e-6, `${spec.name}：零俯仰时车身水平`, `Δy=${level.delta.toFixed(6)}m`);
  check(noseDown.delta < level.delta - 0.02,
        `${spec.name}：正俯仰（刹车）时车头比车尾低`,
        `满偏 ${model.maxPitchDeg.toFixed(2)}°，前后探针相距 ${(halfSpread * 2).toFixed(2)}m，车头低 ${(Math.abs(noseDown.delta) * 1000).toFixed(0)}mm`);
  check(noseUp.delta > level.delta + 0.02,
        `${spec.name}：负俯仰（加速）时车头比车尾高`,
        `车头高 ${(noseUp.delta * 1000).toFixed(0)}mm`);
  const tiltAngle = (Math.atan2(Math.abs(noseDown.delta), halfSpread * 2) * 180) / Math.PI;
  check(Math.abs(tiltAngle - model.maxPitchDeg) < 0.05,
        `${spec.name}：车身倾角与设定值一致`, `实测 ${tiltAngle.toFixed(2)}° / 设定 ${model.maxPitchDeg.toFixed(2)}°`);

  // 车轮必须始终贴地（车轮不在枢轴里），车身最低点也不该扎进路面
  const ends = [maxPitch, -maxPitch].map((angle) => {
    model.setPitch(angle);
    return { body: (root.updateMatrixWorld(true), new THREE.Box3().setFromObject(model.group).min.y), wheel: wheelDrop() };
  });
  const tyreDrift = Math.max(...ends.map((item) => Math.abs(item.wheel - wheelLevel)));
  check(tyreDrift < 0.001, `${spec.name}：俯仰时轮胎接地点不动（车轮不在枢轴里）`, `相对水平漂移 ${(tyreDrift * 1000).toFixed(2)}mm`);
  const bodyDip = Math.min(...ends.map((item) => item.body));
  check(bodyDip > -0.09, `${spec.name}：满偏俯仰时车身最低点仍高于 −90mm（不扎进路面）`, `最低 ${(bodyDip * 1000).toFixed(0)}mm`);
  check(model.contactShadow.position.y < 0.02 && model.contactShadow.parent === model.group,
        `${spec.name}：接地阴影仍贴在枢轴之外的地面上`,
        `y=${model.contactShadow.position.y.toFixed(3)}m`);
  model.setPitch(maxPitch);
  root.updateMatrixWorld(true);
  const shadowBefore = model.contactShadow.getWorldPosition(new THREE.Vector3());
  const markerBefore = model.marker.getWorldPosition(new THREE.Vector3());
  model.setPitch(-maxPitch);
  root.updateMatrixWorld(true);
  const shadowAfter = model.contactShadow.getWorldPosition(new THREE.Vector3());
  const markerAfter = model.marker.getWorldPosition(new THREE.Vector3());
  check(shadowBefore.distanceTo(shadowAfter) < 1e-6, `${spec.name}：俯仰不带动接地阴影`, `位移 ${shadowBefore.distanceTo(shadowAfter).toExponential(1)}m`);
  check(Math.abs(markerBefore.y - markerAfter.y) < 1e-6, `${spec.name}：俯仰不带动结果标记`, `Δy=${Math.abs(markerBefore.y - markerAfter.y).toExponential(1)}m`);

  // 车轮滚动与俯仰互不干扰
  const axle = model.wheels[0];
  model.setPitch(model.maxPitchDeg * DEG);
  const spinBefore = axle.rotation.x;
  model.spin(2.5);
  check(Math.abs(axle.rotation.x - spinBefore) > 1 && Math.abs(model.pitchPivot.rotation.x - model.maxPitchDeg * DEG) < 1e-9,
        `${spec.name}：俯仰后车轮仍按行驶距离转动`, `转角 ${(axle.rotation.x - spinBefore).toFixed(3)}rad`);
  model.setPitch(0);
}

console.log("\n=== 悬挂控制器的动力学 ===");
const controller = createSuspensionController();
// 合成一段：0→16m/s 用 4s 加速，16m/s 匀速 3s，再 2.5s 刹停，然后停 3s
const dt = 1 / 34;
const frames = [];
let v = 0;
for (let t = 0; t < 12.5; t += dt) {
  let a = 0;
  if (t < 4) a = 4;
  else if (t < 7) a = 0;
  else if (t < 9.5) a = -6.4;
  v = Math.max(0, Math.min(16, v + a * dt));
  const distance = v * dt;
  const pitch = controller.update(dt, distance) / DEG;
  frames.push({ t, a, v, pitch });
}
const during = (from, to) => frames.filter((item) => item.t >= from && item.t < to);
const peak = (list) => list.reduce((best, item) => (Math.abs(item.pitch) > Math.abs(best.pitch) ? item : best), { pitch: 0 });
const accelPhase = during(0.5, 4);
const cruisePhase = during(5.5, 7);
const brakePhase = during(7.2, 9.5);
const restPhase = during(10.5, 12.4);
const brakePeak = peak(brakePhase);
const accelPeak = peak(accelPhase);
const cruisePeak = peak(cruisePhase);
const restPeak = peak(restPhase);

check(brakePeak.pitch > 0.5 && brakePeak.pitch < 2.6,
      "刹车时车头下沉，幅度落在真实轿车 0.5~2.5° 区间",
      `峰值 ${brakePeak.pitch.toFixed(2)}°（减速度约 ${Math.abs(brakePhase[brakePhase.length - 1].a).toFixed(1)}m/s²）`);
check(accelPeak.pitch < -0.5 && accelPeak.pitch > -2.6,
      "加速时车头抬起（与刹车反号）", `峰值 ${accelPeak.pitch.toFixed(2)}°`);
check(Math.abs(cruisePeak.pitch) < 0.15, "匀速巡航时车身回到水平", `残余 ${cruisePeak.pitch.toFixed(3)}°`);
check(Math.abs(restPeak.pitch) < 0.05, "停稳后车身完全回正（不会一直低头）", `残余 ${restPeak.pitch.toFixed(3)}°`);
// 悬挂不是开关：从刹车开始到达到 90% 峰值应花 0.15~0.6s（真实减振器就是这个量级）
const brakeOn = frames.filter((item) => item.a < 0)[0];
const rise = frames.filter((item) => item.t >= brakeOn.t && item.pitch >= brakePeak.pitch * 0.9)[0];
check(rise && rise.t - brakeOn.t > 0.15 && rise.t - brakeOn.t < 0.6,
      "俯仰是渐进建立的（0.15~0.6s 达到 90%），不是瞬间跳到位",
      rise ? `${(rise.t - brakeOn.t).toFixed(2)}s` : "未达到 90%");
check(frames.every((item) => Number.isFinite(item.pitch) && Math.abs(item.pitch) <= 2.2 + 1e-9),
      "俯仰角全程有限且不超过满偏 2.2°", `最大 ${Math.max(...frames.map((item) => Math.abs(item.pitch))).toFixed(3)}°`);
const maxStep = frames.reduce((best, item, index) => (index ? Math.max(best, Math.abs(item.pitch - frames[index - 1].pitch)) : best), 0);
check(maxStep < 0.6, "逐帧变化平滑（34fps 下不会一帧从 0 跳到满偏）", `单帧最大 ${maxStep.toFixed(3)}°`);
controller.reset();
check(controller.pitch === 0 && controller.accel === 0 && controller.speed === 0, "reset 后状态归零");

console.log("\n=== 断言 ===");
if (failures.length) {
  console.log(`失败 ${failures.length} 项：`);
  for (const line of failures) console.log(`  [!!] ${line}`);
  process.exit(1);
}
console.log("全部通过");
