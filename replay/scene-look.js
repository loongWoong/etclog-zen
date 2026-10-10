/**
 * 共享「场景观感」模块：天空、环境反射、阳光与阴影、影调映射、路面材质。
 *
 * 三个页面（index.html / lanes.html / vehicles.html）共用这一份观感设置，
 * 避免每个页面各写一套灯光，导致同一场景在不同页面里亮度和阴影不一致。
 *
 * 设计取舍：
 *   - 天空用等距柱状画布（渐变 + 日面 + 日晕 + 云带）生成，再交给 PMREM 做环境贴图，
 *     这样车漆、玻璃、金属就有真实的反光，而不是靠高光「假装」。
 *   - 阳光方向由「窗口时刻」的粗略太阳高度角决定（正午偏高，阴影短）。
 *   - 软件渲染（SwiftShader 等）自动关闭阴影贴图、压低像素比：阴影是每帧一次的
 *     额外渲染通道，在没有 GPU 的机器上会直接把 CPU 打满。
 *   - 所有设置都只动光照与材质，不动任何设备的位置/尺寸，
 *     因此 check_lane_layout.py 的一致性结论不受影响。
 */

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

/** 正午天空配色（线性空间外的 sRGB 十六进制，画到画布上时按 sRGB 理解）。 */
export const SKY_COLORS = {
  zenith: "#2a66bd",
  upper: "#5b96d8",
  mid: "#9cc3e8",
  horizon: "#dfe9f1",
  groundHaze: "#8d97a1",
  groundDark: "#3f4751",
  sun: "#fff8e4",
};

/** 白天场景的雾色与远近（雾用来把大地面淡入地平线，避免出现"世界边界"）。 */
export const FOG = { color: "#cfdde8", near: 140, far: 620 };

/**
 * 太阳视半径（弧度）：0.266°。影子边缘的"半影"宽度就是这个角度在地面上摊开的量
 * ——`penumbra ≈ 2 × 视半径 × (物高 / sin高度角)`，4m 高的车约 4cm，1.5m 的轿车约 1.6cm。
 */
export const SUN_ANGULAR_RADIUS = 0.00465;

/** sRGB 编码值（0~1）→ 线性。天空画布是 sRGB 的，算光照量前必须转过来。 */
function srgbToLinear(value) {
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

/** 线性 → sRGB 编码值（0~1），画到画布上时用。 */
export function linearToSrgb(value) {
  const x = Math.max(0, Math.min(1, value));
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

/**
 * 天空画布的一格 → 世界方向（与 three 的 equirect 采样一致）。
 * 画布 j=0 在顶（天顶，flipY 后 v=1）、i 沿方位角展开。
 */
function skyCanvasDirection(i, j, width, height) {
  const phi = (((i + 0.5) / width) - 0.5) * Math.PI * 2;
  const theta = ((j + 0.5) / height) * Math.PI;
  const sinTheta = Math.sin(theta);
  return [Math.cos(phi) * sinTheta, Math.cos(theta), Math.sin(phi) * sinTheta];
}

/**
 * 天空的**余弦加权平均辐射亮度**（= 上半球的辐照度 / π）。
 *
 * 直接把天空画布缩到 32×16 再逐格加权：朝上的水平面只看得见上半球，
 * 权重取 cosθ·sinθ（等距柱状投影下每格的立体角正比于 sinθ）。
 * 地面那半天（画布下半）不参与——它照的是朝下的面，不是路面。
 *
 * `excludeAroundSun`：把日面与日晕那一块从"天光"里扣掉。那部分能量是**直射**被散射的，
 * 已经在直射项里算过一次；再算进环境漫射就是双份，影子会因此虚亮（实测能把影色抬高近一倍）。
 * 扣掉后 `skyAverageRadiance` 才真正是"影子里的地面还能看到的那片天"。
 */
export function skyAverageRadiance(skyTexture, { width = 32, height = 16, sunDirection = null, excludeDeg = 30 } = {}) {
  const sum = [0, 0, 0];
  const excludeCos = sunDirection ? Math.cos(THREE.MathUtils.degToRad(excludeDeg)) : -2;
  const sun = sunDirection || null;
  let excludedWeight = 0;
  const image = skyTexture && skyTexture.image;
  if (!image || !image.getContext) return new THREE.Color(0.25, 0.38, 0.62);   // 拿不到画布时的兜底
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  let weightSum = 0;
  for (let j = 0; j < height; j += 1) {
    const theta = ((j + 0.5) / height) * Math.PI;
    if (theta >= Math.PI / 2) break;                     // 只算上半球
    const w = Math.cos(theta) * Math.sin(theta);
    for (let i = 0; i < width; i += 1) {
      const k = (j * width + i) * 4;
      if (sun) {
        const dir = skyCanvasDirection(i, j, width, height);
        if (dir[0] * sun.x + dir[1] * sun.y + dir[2] * sun.z > excludeCos) {
          excludedWeight += w;
          continue;
        }
      }
      sum[0] += srgbToLinear(data[k] / 255) * w;
      sum[1] += srgbToLinear(data[k + 1] / 255) * w;
      sum[2] += srgbToLinear(data[k + 2] / 255) * w;
    }
    weightSum += w * width;
  }
  if (!sun) excludedWeight = 0;
  if (weightSum <= 0) return new THREE.Color(0.25, 0.38, 0.62);
  const color = new THREE.Color(sum[0] / weightSum, sum[1] / weightSum, sum[2] / weightSum);
  color.userData = { excludedShare: weightSum > 0 ? excludedWeight / (weightSum + excludedWeight) : 0 };
  return color;
}

/**
 * 影子里的地面还剩多少光：**天光 / (天光 + 直射太阳)**，逐通道。
 *
 * 这是阴影真正的物理含义——太阳被挡住之后，地面只剩天空（所以影子偏蓝），
 * 深度就是"直射占了多少"。三个通道各自算，影子的颜色因此是天空的颜色而不是拍出来的深灰。
 * 直射项按水平面的投影算（乘 sin高度角），环境项 = 半球光 + 环境贴图的间接漫反射
 * （three 的间接漫反射是 `π × PMREM`，而 `skyAverageRadiance` 已经是"辐照度/π"，所以乘回 π）。
 */
export function groundShadowRatio({ sun, hemi, skyAverage, envIntensity = 0.35, ambientScale = 1 } = {}) {
  const fallback = new THREE.Color(0.12, 0.17, 0.25);
  if (!sun || !hemi || !skyAverage) return fallback;
  const sinElev = Math.max(0.05, sun.position.clone().normalize().y);
  const direct = [sun.color.r * sun.intensity * sinElev,
                  sun.color.g * sun.intensity * sinElev,
                  sun.color.b * sun.intensity * sinElev];
  const sky = [hemi.color.r * hemi.intensity + Math.PI * skyAverage.r * envIntensity * ambientScale,
               hemi.color.g * hemi.intensity + Math.PI * skyAverage.g * envIntensity * ambientScale,
               hemi.color.b * hemi.intensity + Math.PI * skyAverage.b * envIntensity * ambientScale];
  return new THREE.Color(
    THREE.MathUtils.clamp(sky[0] / (sky[0] + direct[0]), 0.02, 0.98),
    THREE.MathUtils.clamp(sky[1] / (sky[1] + direct[1]), 0.02, 0.98),
    THREE.MathUtils.clamp(sky[2] / (sky[2] + direct[2]), 0.02, 0.98),
  );
}

// ---------------------------------------------------------------------------
// 天空贴图
// ---------------------------------------------------------------------------

/** 由方位角/高度角算太阳单位方向（azimuth 0° 指向 +Z，向东旋转到 +X）。 */
export function sunDirection(azimuthDeg = 118, elevationDeg = 58) {
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
}

/**
 * 太阳假影的统一取法。`direction` 是**指向太阳**的单位向量（`setupSky` 的返回值），
 * 返回地面上的三个量：
 *   x/z     影子方向（水平单位向量，**背离太阳**）
 *   cot     cot(高度角) = 影长 / 物高（正午 58° ≈ 0.625）
 *   azimuth 影子方向的方位角（0° 指向 +Z，与 `sunDirection` 同一套约定，自检用来对数）
 * 接地暗部（`contact-ao.js`）与车辆接地阴影（`vehicle-models.js`）都从这里取，
 * 免得一个场地里出现"两拨影子朝不同方向、长短系数也不一样"。
 */
export function sunShadowFrame(direction) {
  if (!direction || direction.lengthSq() === 0) return null;
  const horizontal = Math.hypot(direction.x, direction.z);
  if (horizontal < 1e-6) return null;                       // 太阳正顶：没有方向可言，按无影处理
  const x = -direction.x / horizontal;
  const z = -direction.z / horizontal;
  return {
    x,
    z,
    cot: horizontal / Math.max(1e-6, direction.y),
    azimuthDeg: THREE.MathUtils.radToDeg(Math.atan2(x, z)),
  };
}

function fillGradient(ctx, width, height, stops) {
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

function softBlob(ctx, x, y, radius, color, alpha) {
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, `rgba(${color},${alpha})`);
  gradient.addColorStop(0.55, `rgba(${color},${alpha * 0.35})`);
  gradient.addColorStop(1, `rgba(${color},0)`);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

/** 椭圆版的 softBlob：径向渐变画不出椭圆，用 x 方向缩放把圆压成椭圆（渐变跟着一起压）。 */
function softEllipse(ctx, x, y, rx, ry, color, alpha) {
  if (!(rx > 0.3) || !(ry > 0.3)) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(Math.max(0.02, rx / ry), 1);
  softBlob(ctx, 0, 0, ry, color, alpha);
  ctx.restore();
}

/** 确定性伪随机（LCG）：同一个种子每次加载完全一样，Node 端自检可以逐条复算。 */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

/** 单位方向 → 等距柱状画布坐标（与 `equirectSphereGeometry` / 日面位置同一套约定）。 */
export function skyCanvasPoint(dir, width, height) {
  const horizontal = Math.hypot(dir[0], dir[2]);
  return {
    u: (Math.atan2(dir[2], dir[0]) / (Math.PI * 2) + 0.5) * width,
    v: (Math.acos(Math.max(-1, Math.min(1, dir[1]))) / Math.PI) * height,
    horizontal,
  };
}

/**
 * 云的等距柱状足印：一个**视角半径**为 ρ 的圆，投影到画布上是椭圆 ——
 *   竖直方向：Δv = ρ/π·H（θ 在画布行上本来就是线性的）
 *   水平方向：Δu = (ρ / sin高度角)/(2π)·W（同样大的角距离，越靠天顶占越多经度）
 * 不按这个画的云（直接画圆）会"天顶的云被压窄、地平线的云被拉宽"，一眼假。
 */
export function skyEllipse(radius, horizontal, width, height) {
  return {
    au: (radius / Math.max(1e-3, horizontal)) / (Math.PI * 2) * width,
    av: radius / Math.PI * height,
  };
}

/**
 * 云的布局：在**天球**上撒点，不是在画布上撒点。
 *
 * 三条都是从真实天空里抄的：
 *   1. **面积均匀**：y 分量 = sin 高度角，在 [0,1] 上均匀撒点就是天球上均匀（dA ∝ d(cosθ)），
 *      否则云会全挤在天顶。
 *   2. **越靠地平线的云看着越小**：云在一个水平云层上，仰角越低距离越远（r = H/sin高度角），
 *      同样一块云的视角半径正比于 sin 高度角 —— 这一条最出"有透视的云层"的观感。
 *   3. **向阳面亮、背阳面灰**：云是白的靠太阳照亮，背光那侧是灰蓝的，天顶整片纯白的云反而假。
 *
 * 返回纯数据（不碰 canvas），所以 Node 端能直接逐条核对；`skyCanvasTexture` 只负责画。
 */
export function skyCloudLayout({
  seed = 20260701,
  sunAzimuth = 118,
  sunElevation = 58,
  cumulus = 62,
  cirrus = 9,
} = {}) {
  const rnd = seededRandom(seed);
  const sun = sunDirection(sunAzimuth, sunElevation);
  const sunArr = [sun.x, sun.y, sun.z];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const unit = (phi, y) => {
    const h = Math.sqrt(Math.max(0, 1 - y * y));
    return [Math.cos(phi) * h, y, Math.sin(phi) * h];
  };
  const clamp01 = (value) => Math.max(0, Math.min(1, value));

  const clouds = [];
  const cirrusClouds = [];
  let covered = 0;
  let sunOpacity = 0;

  for (let i = 0; i < cumulus; i += 1) {
    const y = 0.06 + rnd() * 0.90;
    const phi = rnd() * Math.PI * 2;
    const dir = unit(phi, y);
    const radius = THREE.MathUtils.degToRad(4.5 + rnd() * 11.5) * Math.max(0.12, y);
    const toSun = dot(dir, sunArr);

    // 一团积云 = 几团挤在一起的"泡"，形状才不圆；外圈再加一层淡的当软边
    const puffs = [];
    const count = 3 + Math.floor(rnd() * 4);
    for (let k = 0; k < count; k += 1) {
      const angle = rnd() * Math.PI * 2;
      const spread = radius * (0.12 + rnd() * 0.5);
      const dy = Math.sin(angle) * spread;
      const dPhi = (Math.cos(angle) * spread) / Math.max(0.25, y);
      const pDir = unit(phi + dPhi, clamp01(y + dy) * 1);
      const lit = 0.58 + 0.42 * Math.max(0, dot(pDir, sunArr));      // 向阳面接近纯白
      puffs.push({
        dir: pDir,
        radius: radius * (0.34 + rnd() * 0.46),
        alpha: 0.26 + rnd() * 0.26,
        rgb: [Math.round(255 * lit),
          Math.round(255 * Math.min(1, lit + 0.015)),
          Math.round(255 * Math.min(1, lit + 0.055))],              // 背光那侧偏冷（灰蓝）
      });
    }
    // 云底/云缘的一层雾：让边缘不是硬切
    const veilLit = 0.52 + 0.34 * Math.max(0, toSun);
    clouds.push({
      dir,
      radius,
      toSun,
      solid: Math.PI * radius * radius,
      puffs,
      veil: {
        dir,
        alpha: 0.10 + rnd() * 0.07,
        radius: radius * (0.95 + rnd() * 0.4),
        rgb: [Math.round(255 * veilLit), Math.round(255 * Math.min(1, veilLit + 0.02)), Math.round(255 * Math.min(1, veilLit + 0.06))],
      },
    });
    covered += Math.PI * radius * radius;
    // 这团云挡在太阳前面多少（自检要拿它核对"太阳被云挡了"这件事）
    const angleToSun = Math.acos(clamp01(toSun * 0.5 + 0.5) * 2 - 1);
    if (angleToSun < radius * 1.4) {
      sunOpacity = Math.max(sunOpacity, 0.75 * (1 - angleToSun / (radius * 1.4)));
    }
  }

  for (let i = 0; i < cirrus; i += 1) {
    const y = 0.18 + rnd() * 0.72;
    const phi = rnd() * Math.PI * 2;
    cirrusClouds.push({
      dir: unit(phi, y),
      radius: THREE.MathUtils.degToRad(6 + rnd() * 14) * Math.max(0.25, y),
      stretch: 2.5 + rnd() * 3.5,           // 丝缕是拉长的
      tilt: (rnd() - 0.5) * 0.35,
      alpha: 0.05 + rnd() * 0.07,
    });
  }

  return { clouds, cirrus: cirrusClouds, coverage: covered / (2 * Math.PI), sunOpacity, seed };
}

/** 把 `skyCloudLayout` 的结果画到等距柱状画布上。只画地平线以上（v ≤ H/2）。 */
export function paintSkyClouds(ctx, layout, { width, height }) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height / 2);        // 地平线以下不能有云（原来那版会漏到地面雾里）
  ctx.clip();

  for (const band of layout.cirrus) {
    const p = skyCanvasPoint(band.dir, width, height);
    const e = skyEllipse(band.radius, p.horizontal, width, height);
    const radius = Math.max(e.au, e.av);
    ctx.save();
    ctx.translate(p.u, p.v);
    ctx.rotate(band.tilt);
    for (const shift of [0, -width, width]) {  // 方位角是环形的，跨 0 列的云要补画
      softEllipse(ctx, shift, 0, e.au * band.stretch, radius * 0.55, "238,244,252", band.alpha);
    }
    ctx.restore();
  }

  for (const cloud of layout.clouds) {
    const v = skyCanvasPoint(cloud.veil.dir, width, height);
    const ve = skyEllipse(cloud.veil.radius, v.horizontal, width, height);
    const colour = cloud.veil.rgb.join(",");
    for (const shift of [0, -width, width]) {
      softEllipse(ctx, v.u + shift, v.v, ve.au, ve.av, colour, cloud.veil.alpha);
    }
    for (const puff of cloud.puffs) {
      const p = skyCanvasPoint(puff.dir, width, height);
      const e = skyEllipse(puff.radius, p.horizontal, width, height);
      const puffColour = puff.rgb.join(",");
      for (const shift of [0, -width, width]) {
        softEllipse(ctx, p.u + shift, p.v, e.au, e.av, puffColour, puff.alpha);
      }
    }
  }
  ctx.restore();
}

/**
 * 画等距柱状天空：上蓝下灰、地平线亮雾，加日面与云带。
 * 画布 y=0 是天顶，y=height/2 是地平线，和 three 的等距柱状约定一致。
 */
export function skyCanvasTexture({ sunAzimuth = 118, sunElevation = 58, size = 2048, clouds = true } = {}) {
  const width = size;
  const height = Math.max(512, Math.round(size / 2));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  fillGradient(ctx, width, height, [
    [0, SKY_COLORS.zenith],
    [0.22, SKY_COLORS.upper],
    [0.4, SKY_COLORS.mid],
    [0.495, SKY_COLORS.horizon],
    [0.505, SKY_COLORS.groundHaze],
    [0.62, SKY_COLORS.groundDark],
    [1, "#2b3138"],
  ]);

  // 日晕 + 日面：**先画太阳，云再盖上去** —— 云挡在太阳前面时就该把日面盖掉。
  // 原来云画在太阳之前，云永远盖不住太阳（物理上错的，薄云过日也不会有遮挡感）。
  // 位置必须按**等距柱状投影**的约定算：这张图既当环境贴图（PMREM 按 equirect 采样：
  // u = atan2(z,x)/2π + 0.5），又当天空穹顶的贴图（穹顶 UV 已改成同一套）。
  // 之前直接用 `方位角/360` 当列号，与本工程的方位角约定（0° → +Z）差了一次镜面，
  // 太阳会画到离灯 90° 的地方去 —— 影子朝一边、天上的太阳在另一边。
  // 只有日面这一块用加法叠加（就是要它过曝成白点），半径同样按分辨率缩放。
  const unit = size / 2048;
  ctx.globalCompositeOperation = "lighter";
  const sunAzimuthRad = THREE.MathUtils.degToRad(sunAzimuth);
  const sunU = Math.atan2(Math.cos(sunAzimuthRad), Math.sin(sunAzimuthRad)) / (Math.PI * 2) + 0.5;
  const sunX = sunU * width;
  // 高度角这一项两套约定恰好一致：equirect 的 v = asin(y)/π + 0.5 → 行号 = (90°−高度角)/180°×高
  const sunY = ((90 - sunElevation) / 180) * height;
  softBlob(ctx, sunX, sunY, 400 * unit, "255,246,214", 0.2);   // 大范围晕
  softBlob(ctx, sunX, sunY, 140 * unit, "255,250,232", 0.4);
  softBlob(ctx, sunX, sunY, 44 * unit, "255,255,250", 0.85);   // 日面
  ctx.globalCompositeOperation = "source-over";

  // 云：在**天球**上撒点，再按等距柱状投影画（见 skyCloudLayout 的注释）。
  // 仍然必须用 source-over：加法叠加会把整片天推到纯白，天空成白幕，
  // "影子里剩多少天光"就算不出蓝来了。source-over 天然有界。
  // clouds:false 是给自检用的 —— 同一套生成器出一张无云天空，换上去前后差一帧，
  // 就是"云到底给画面加了多少"的直接量（不靠"亮且不偏色"这种代理指标）。
  const cloudLayout = clouds
    ? skyCloudLayout({ seed: 20260701, sunAzimuth, sunElevation })
    : { clouds: [], cirrus: [], coverage: 0, sunOpacity: 0, seed: 0 };
  paintSkyClouds(ctx, cloudLayout, { width, height });

  const texture = new THREE.CanvasTexture(canvas);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  // 云量/挡日程度随贴图一起带出去：自检要核对"太阳被云挡了多少"与画面里日面亮度是否对得上
  texture.userData.skyClouds = {
    coverage: cloudLayout.coverage,
    sunOpacity: cloudLayout.sunOpacity,
    clouds: cloudLayout.clouds.length,
    cirrus: cloudLayout.cirrus.length,
    seed: cloudLayout.seed,
  };
  return texture;
}

/**
 * 天空穹顶用的球：把 UV 改成**等距柱状投影**那一套（u = atan2(z,x)/2π + 0.5、v = asin(y)/π + 0.5）。
 *
 * 为什么不直接用 SphereGeometry 自带的 UV：那套 UV 的 u 与 equirect 差一次 z 的镜像
 * （球面 u=0 在 −X、u=0.25 在 +Z，equirect u=0.25 在 −Z），于是同一张天空贴图
 * 在"当环境贴图"和"当天穹贴图"时会把太阳放到天空的两个不同位置。
 * 照着 equirect 重写一遍，两边才指的是同一片天空。
 */
function equirectSphereGeometry(radius = 1, widthSegments = 48, heightSegments = 24) {
  const geometry = new THREE.SphereGeometry(radius, widthSegments, heightSegments);
  const position = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  const r = radius || 1;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    uv.setXY(i,
      Math.atan2(z, x) / (Math.PI * 2) + 0.5,
      Math.asin(THREE.MathUtils.clamp(y / r, -1, 1)) / Math.PI + 0.5);
  }
  uv.needsUpdate = true;
  return geometry;
}

// ---------------------------------------------------------------------------
// 光照 / 天空 / 环境
// ---------------------------------------------------------------------------

/**
 * 一次性装好天空、环境反射、雾、太阳与阴影。
 * @returns {{ sun: THREE.DirectionalLight, env: THREE.Texture, sky: THREE.Texture, shadow: boolean }}
 */
export function setupSky(scene, renderer, {
  software = false,
  azimuth = 118,
  elevation = 58,
  sunIntensity = 3.2,
  skyIntensity = 1.0,
  shadowRadius = 62,
  shadowMapSize = 2048,
  fog = true,
  fogNear = FOG.near,
  fogFar = FOG.far,
  exposure = 1.0,
} = {}) {
  const sky = skyCanvasTexture({ sunAzimuth: azimuth, sunElevation: elevation, size: software ? 768 : 2048 });
  const direction = sunDirection(azimuth, elevation);

  let env = null;
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    env = pmrem.fromEquirectangular(sky).texture;
    pmrem.dispose();
  } catch (error) {
    env = null; // 环境贴图失败不影响主流程，退回纯光照
  }

  // 天空穹顶：用"挂在相机上的球壳"而不是 scene.background。
  // 原因：three 对 sRGB 背景贴图**不施加色调映射**（display-referred），而渲染到 render target
  // 的泛光管线里 OutputPass 会统一对整帧施加 ACES —— 两条路径会得到两个不同的天空。
  // 换成普通网格（toneMapped=true）后，直接渲染与泛光管线看到的是同一个天空。
  const skyDome = new THREE.Mesh(
    equirectSphereGeometry(1, 48, 24),
    new THREE.MeshBasicMaterial({ map: sky, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false }),
  );
  skyDome.name = "skyDome";
  skyDome.frustumCulled = false;
  skyDome.renderOrder = -1000;      // 最先画，后面所有东西都盖在它上面
  skyDome.userData.noShadow = true;
  scene.add(skyDome);
  scene.background = null;

  if (env) scene.environment = env;
  if (fog) scene.fog = new THREE.Fog(new THREE.Color(FOG.color), fogNear, fogFar);

  // 半球光：上方天空色、下方地面反弹色，比单一环境光更接近室外
  const hemi = new THREE.HemisphereLight(new THREE.Color(SKY_COLORS.mid), new THREE.Color(SKY_COLORS.groundDark), 0.78 * skyIntensity);
  scene.add(hemi);

  if (renderer) renderer.toneMappingExposure = exposure;

  const sun = new THREE.DirectionalLight(new THREE.Color(SKY_COLORS.sun), sunIntensity);
  sun.position.copy(direction).multiplyScalar(160);
  sun.target.position.set(0, 0, 0);
  scene.add(sun);
  scene.add(sun.target);

  // 阴影参数始终按「有 GPU」的规格配好，只把开关交给 GPU 检测结果：
  // 软件渲染关掉（每帧一次额外通道会打满 CPU），但无头验证里可以临时打开做因果检验。
  sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
  const camera = sun.shadow.camera;
  camera.left = -shadowRadius;
  camera.right = shadowRadius;
  camera.top = shadowRadius;
  camera.bottom = -shadowRadius;
  camera.near = 40;
  camera.far = 360;
  camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.035;
  sun.shadow.radius = 1.6;

  const useShadow = !software;
  sun.castShadow = useShadow;

  // 影子的颜色与深度按**这几盏灯自己**算：影子里的地面只剩天光（半球光 + 环境贴图），
  // 直射太阳被挡住了。地面材质的 envMapIntensity 默认是 0.35（asphaltMaterial），
  // 所以这里也按 0.35 估环境贴图那一份；数字全部回报出去，自检会独立复算一遍对数。
  const skyAverage = skyAverageRadiance(sky, { sunDirection: direction, excludeDeg: 30 });
  const shadowTint = groundShadowRatio({ sun, hemi, skyAverage, envIntensity: 0.35 });
  const shadowLight = {
    sunIntensity: sun.intensity,
    sunColor: [sun.color.r, sun.color.g, sun.color.b].map((v) => Math.round(v * 1000) / 1000),
    hemiIntensity: hemi.intensity,
    envIntensity: 0.35,
    skyAverage: [skyAverage.r, skyAverage.g, skyAverage.b].map((v) => Math.round(v * 1000) / 1000),
    sunHaloExcludeDeg: 30,
    sunHaloShare: Math.round((skyAverage.userData ? skyAverage.userData.excludedShare : 0) * 1000) / 1000,
    tint: [shadowTint.r, shadowTint.g, shadowTint.b].map((v) => Math.round(v * 1000) / 1000),
  };

  // 穹顶跟着相机走：半径取相机远平面的一半以内，既包住整个视锥又不会被远平面裁掉
  function followSky(camera) {
    if (!camera) return;
    const radius = Math.max(50, (camera.far || 400) * 0.45);
    skyDome.position.copy(camera.position);
    skyDome.scale.setScalar(radius);
  }

  return { sun, hemi, env, sky, skyDome, followSky, direction, shadow: useShadow, shadowTint, shadowLight, skyAverage };
}

/** 影调映射与色彩空间：统一走 ACES，避免高光一片死白。exposure 为 null 时只设映射不动曝光。 */
export function applyRenderLook(renderer, gpu = { software: false }, exposure = null) {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  if (exposure !== null) renderer.toneMappingExposure = exposure;
  renderer.shadowMap.enabled = !gpu.software;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  return renderer;
}

/**
 * 按包围盒自动分配阴影角色：大块地面接收阴影、中小体量的物体既投射也接收。
 * 这样不用逐个设备手写 castShadow/receiveShadow，也不会让巨大平面进阴影贴图。
 */
export function applyShadowFlags(root, { castMaxY = 15, maxCastFootprint = 900, groundMaxY = 0.3 } = {}) {
  const box = new THREE.Box3();
  const size = new THREE.Vector3();
  let casters = 0;
  let receivers = 0;
  root.traverse((object) => {
    if (!object.isMesh || object.userData.noShadow) return;
    box.setFromObject(object, true);
    if (box.isEmpty()) return;
    box.getSize(size);
    const footprint = size.x * size.z;
    const isGround = box.max.y <= groundMaxY && footprint > 40;
    if (isGround) {
      object.castShadow = false;
      object.receiveShadow = true;
      receivers += 1;
      return;
    }
    if (box.max.y <= castMaxY && footprint <= maxCastFootprint && size.y > 0.02) {
      object.castShadow = true;
      object.receiveShadow = true;
      casters += 1;
    }
  });
  return { casters, receivers };
}

/** 雾与地面远景的贴地大平面：让地平线不是"世界边缘"，颜色接上雾色。 */
export function addGroundHaze(scene, { y = -0.09, size = 2400, color = FOG.color } = {}) {
  const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.82), roughness: 1, metalness: 0 });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y;
  mesh.receiveShadow = false;
  mesh.userData.noShadow = true;
  mesh.name = "groundHaze";
  scene.add(mesh);
  return mesh;
}

// ---------------------------------------------------------------------------
// 路面材质（程序化沥青，不依赖外部贴图文件）
// ---------------------------------------------------------------------------

const ASPHALT_CACHE = new Map();

/** 程序化沥青/混凝土贴图：底色 + 颗粒噪点 + 浅色骨料。整体偏亮，作为「细节图」由 color 决定明暗。 */
export function asphaltTexture({ base = "#969ba1", speckle = 1, size = 512, seed = 7 } = {}) {
  const key = `${base}:${speckle}:${size}:${seed}`;
  if (ASPHALT_CACHE.has(key)) return ASPHALT_CACHE.get(key);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  let state = seed * 2654435761;
  const random = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  // 大块深浅斑（补丁/油渍）
  for (let i = 0; i < 26; i += 1) {
    const x = random() * size;
    const y = random() * size;
    const r = 20 + random() * 90;
    const tone = random() > 0.5 ? 255 : 0;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
    gradient.addColorStop(0, `rgba(${tone},${tone},${tone},${0.03 + random() * 0.04})`);
    gradient.addColorStop(1, `rgba(${tone},${tone},${tone},0)`);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // 骨料颗粒
  const grains = Math.round(size * size * 0.05 * speckle);
  for (let i = 0; i < grains; i += 1) {
    const x = random() * size;
    const y = random() * size;
    const bright = random();
    const tone = bright > 0.82 ? 236 : bright > 0.4 ? 148 : 84;
    ctx.fillStyle = `rgba(${tone},${tone},${tone + 6},${0.18 + random() * 0.4})`;
    ctx.fillRect(x, y, 1 + random() * 1.6, 1 + random() * 1.6);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  ASPHALT_CACHE.set(key, texture);
  return texture;
}

/** 沥青/混凝土标准材质（带颗粒贴图与轻微粗糙度变化）。
 *  `roughnessMap` 用来做**大尺度**的干湿/磨光变化（轮迹磨亮、积水更光），它只影响反射与高光，
 *  不动漫反射底色，所以不会改变已定好的明暗关系。 */
export function asphaltMaterial({
  color = "#6b727a", repeat = [12, 12], roughness = 0.92, metalness = 0.02, bump = 0.35, roughnessMap = null,
} = {}) {
  const map = asphaltTexture();
  const instance = map.clone();
  instance.needsUpdate = true;
  instance.repeat.set(repeat[0], repeat[1]);
  instance.wrapS = THREE.RepeatWrapping;
  instance.wrapT = THREE.RepeatWrapping;
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    map: instance,
    bumpMap: instance,
    bumpScale: bump,
    roughness,
    roughnessMap,
    metalness,
    envMapIntensity: 0.35,
  });
}

// ---------------------------------------------------------------------------
// 泛光（太阳、警示灯、刹车灯、设备状态灯）
// ---------------------------------------------------------------------------

/**
 * 后处理管线：渲染 →（可选）泛光 → 统一色调映射与 sRGB 编码。
 *
 * 两条路径都走这条管线，只有泛光与 MSAA 有区别：
 *   - 有 GPU：RT 带 4x MSAA、挂 UnrealBloomPass（太阳/警示灯/刹车灯在远景也发光）；
 *   - 软件渲染：RT 不带 MSAA、不建泛光 pass（多一遍全屏模糊会把 CPU 打满）。
 * 不再回退到裸 `renderer.render()`：three 在没有 render target 时按 `outputColorSpace` 处理
 * "不受光 uniform"（雾色、背景），渲染到 RT 时按线性工作空间处理（见 `getUnlitUniformColorSpace`），
 * 两条路径会得到不同的雾与天空 —— 同一页面在 GPU 和软件渲染下不是一个样子。
 * 统一走 RT + OutputPass 后两条路径逐像素一致，而且整帧统一施加 ACES，
 * 天空/雾的过曝被压住（实测高光裁切像素 2.96% → 0.02%）。
 *
 * 只有当前环境建不出管线时（WebGL1 或构造抛错）才退回裸 `renderer.render()`。
 *
 * @param {{enabled?: boolean, strength?: number, radius?: number, threshold?: number, samples?: number}} options
 */
export function createBloomPipeline(renderer, scene, camera, {
  enabled = true, strength = 0.18, radius = 0.45, threshold = 1.4, samples = 4,
} = {}) {
  const size = new THREE.Vector2();
  renderer.getDrawingBufferSize(size);
  const width = Math.max(1, size.x);
  const height = Math.max(1, size.y);

  let composer = null;
  let renderTarget = null;
  let bloom = null;
  try {
    renderTarget = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      samples: enabled ? samples : 0,   // 软件渲染不再额外开 MSAA
      colorSpace: THREE.LinearSRGBColorSpace,
    });
    composer = new EffectComposer(renderer, renderTarget);
    composer.addPass(new RenderPass(scene, camera));
    if (enabled) {
      bloom = new UnrealBloomPass(new THREE.Vector2(width / 2, height / 2), strength, radius, threshold);
      composer.addPass(bloom);
    }
    composer.addPass(new OutputPass());
  } catch (error) {
    composer = null;
    if (renderTarget) renderTarget.dispose();
    renderTarget = null;
    bloom = null;
  }

  if (!composer) {
    return {
      enabled: false,
      postprocessed: false,
      bloom: null,
      setEnabled() {},
      setSize() {},
      render: () => renderer.render(scene, camera),
      dispose() {},
    };
  }

  return {
    enabled: Boolean(enabled),
    postprocessed: true,
    bloom,
    composer,
    setEnabled(value) {
      if (bloom) bloom.enabled = Boolean(value);
    },
    /** width/height 用 CSS 像素（EffectComposer 自己乘 pixelRatio）。 */
    setSize(width, height) {
      composer.setSize(Math.max(1, width), Math.max(1, height));
    },
    render() {
      composer.render();
    },
    dispose() {
      composer.dispose();
      renderTarget.dispose();
    },
  };
}
