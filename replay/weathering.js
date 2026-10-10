/**
 * 地表风化与磨损：让收费广场不再是一块"刚铺好、擦得干干净净"的新沥青。
 *
 * 真实广场的地面有这些一眼能看出来的痕迹，这一层就是照它们做的：
 *   1. 大尺度脏污/积水/补丁色差 —— 一整片乘法叠加的贴片（白色=不变，越暗越脏），
 *      乘法叠加只压暗不平提亮，所以不会破坏已定好的明暗关系；
 *   2. 轮迹磨光与积水 —— 地面材质的**粗糙度图**（数据贴图，不是颜色），
 *      轮迹被磨亮、低洼处更光滑，环境反射因此有层次（只影响反射，不动漫反射）；
 *   3. 沥青补丁 —— 几块方正的深色修补面，边缘干脆；
 *   4. 裂缝 —— 几条细长的深色折线；
 *   5. 排水沟与篦子、井盖 —— 收费岛旁最典型的金属件。
 *
 * 与 scenery.js 的分工：scenery 负责"立在地上的道具"，这里负责"地面本身的痕迹"。
 * 全部程序化生成（画布贴图 + 盒子/圆柱），不依赖外部贴图文件；同一套种子保证每次刷新一致。
 * 只加地面贴片与地面小件，不移动任何设备/线圈位置，所以不影响 check_lane_layout.py 的结论。
 */

import * as THREE from "three";

const TEXTURE_CACHE = new Map();
const MATERIAL_CACHE = new Map();
const GEOMETRY_CACHE = new Map();

function hash(text) {
  let value = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return Math.abs(value);
}

/** 确定性随机：同一个种子每次刷新一样，回放画面不会闪。 */
function rng(seed) {
  let state = hash(String(seed)) || 1;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function cached(cache, key, factory) {
  if (!cache.has(key)) cache.set(key, factory());
  return cache.get(key);
}

/** 把画布包成纹理（默认按数据贴图处理：粗糙度/遮罩这类贴图绝不能标成 sRGB）。 */
function canvasTexture(canvas, { repeat = 1, srgb = false } = {}) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

// ---------------------------------------------------------------------------
// 贴图
// ---------------------------------------------------------------------------

/**
 * 大尺度脏污贴片（乘法叠加）：白底 = 完全不变；越暗越脏。
 * 内容是油渍场、积水斑、色差大补丁与几条裂缝，尺度都在几米到几十米，正好是不该重复的那一档。
 */
export function stainTexture({ size = 1024, seed = 7 } = {}) {
  return cached(TEXTURE_CACHE, `stain:${size}:${seed}`, () => {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);
    const random = rng(seed);
    const dark = (x, y, r, strength) => {
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
      gradient.addColorStop(0, `rgba(0,0,0,${strength})`);
      gradient.addColorStop(0.55, `rgba(0,0,0,${strength * 0.55})`);
      gradient.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    };
    // 大块色差（修补过的路面、压实度不同的区域）
    for (let i = 0; i < 14; i += 1) dark(random() * size, random() * size, size * (0.09 + random() * 0.16), 0.05 + random() * 0.07);
    // 油渍：小而浓
    for (let i = 0; i < 40; i += 1) dark(random() * size, random() * size, size * (0.012 + random() * 0.03), 0.16 + random() * 0.22);
    // 积水：中尺度、很淡，主要靠粗糙度图体现反光，这里只压一点点
    for (let i = 0; i < 22; i += 1) dark(random() * size, random() * size, size * (0.04 + random() * 0.07), 0.04 + random() * 0.05);
    // 裂缝：细折线
    ctx.lineCap = "round";
    for (let i = 0; i < 14; i += 1) {
      let x = random() * size;
      let y = random() * size;
      ctx.strokeStyle = `rgba(0,0,0,${0.28 + random() * 0.3})`;
      ctx.lineWidth = 1 + random() * 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      const segments = 3 + Math.floor(random() * 4);
      for (let s = 0; s < segments; s += 1) {
        x += (random() - 0.5) * size * 0.1;
        y += (random() - 0.5) * size * 0.1;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    return canvasTexture(canvas, { repeat: 1 });
  });
}

/**
 * 地面粗糙度图（数据贴图）：这是**乘法**贴图，白 = 完全不改材质本来的粗糙度。
 * 所以底色留白，只有轮迹磨光带（骨料被碾平 → 更光）与积水斑（更光）才压暗，
 * 干燥路面保持材质原值 —— 否则整片广场会一起变亮（实测过一次，中位亮度 0.40→0.48，就是这么来的）。
 */
export function groundRoughnessTexture({ size = 512, seed = 31 } = {}) {
  return cached(TEXTURE_CACHE, `rough:${size}:${seed}`, () => {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";             // 白 = 不改，干燥沥青保持材质原本的粗糙度
    ctx.fillRect(0, 0, size, size);
    const random = rng(seed);
    // 轮迹磨光带（车辆反复碾压把骨料磨平）：两条纵向宽带
    for (const cx of [size * 0.32, size * 0.68]) {
      const gradient = ctx.createLinearGradient(cx - size * 0.16, 0, cx + size * 0.16, 0);
      gradient.addColorStop(0, "rgba(196,196,196,0)");
      gradient.addColorStop(0.5, "rgba(196,196,196,0.85)");
      gradient.addColorStop(1, "rgba(196,196,196,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(cx - size * 0.16, 0, size * 0.32, size);
    }
    // 积水/低洼：更光滑（明显但不夸张，反射才看得见）
    for (let i = 0; i < 16; i += 1) {
      const x = random() * size;
      const y = random() * size;
      const r = size * (0.05 + random() * 0.1);
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
      gradient.addColorStop(0, `rgba(140,140,140,${0.45 + random() * 0.35})`);
      gradient.addColorStop(1, "rgba(140,140,140,0)");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // 细颗粒：粗糙度也不该是一块死板的值（只往"略光"的方向动，不抬高）
    for (let i = 0; i < size * size * 0.02; i += 1) {
      const tone = 205 + Math.floor(random() * 50);
      ctx.fillStyle = `rgba(${tone},${tone},${tone},0.2)`;
      ctx.fillRect(random() * size, random() * size, 1 + random() * 2, 1 + random() * 2);
    }
    return canvasTexture(canvas, { repeat: 1 });
  });
}

// ---------------------------------------------------------------------------
// 材质与几何
// ---------------------------------------------------------------------------

/** 乘法叠加的脏污材质：渲染在路面之后，白=不变、暗=压暗。 */
function stainMaterial() {
  return cached(MATERIAL_CACHE, "stainMaterial", () => {
    const texture = stainTexture();
    return new THREE.MeshBasicMaterial({
      map: texture,
      blending: THREE.MultiplyBlending,
      depthWrite: false,
      polygonOffset: true,       // 与路面共面，靠偏移而不是抬高，避免远处打闪
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      // 乘法叠加**不能开雾**：雾是把片元颜色往雾色（≈0.83）混，开了等于把整片脏污变成"乘 0.83"，
      // 远处会变成一层无差别压暗（空气透视该冲淡的是对比，不是整块地面）。见 contact-ao.js 同一处理。
      fog: false,
    });
  });
}

/** 沥青补丁：比原地更黑更粗糙一点，边缘干脆。 */
function patchMaterial() {
  return cached(MATERIAL_CACHE, "patchMaterial", () => new THREE.MeshStandardMaterial({
    color: 0x484f57,
    roughness: 0.99,
    metalness: 0.02,
    envMapIntensity: 0.3,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  }));
}

/** 裂缝：乘法叠加的半透明细线，不反光。 */
function crackMaterial() {
  return cached(MATERIAL_CACHE, "crackMaterial", () => new THREE.MeshBasicMaterial({
    color: 0x5a5a5a,
    blending: THREE.MultiplyBlending,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  }));
}

/** 铸铁件（排水篦子、井盖）：略反光的深灰金属。 */
function castIronMaterial() {
  return cached(MATERIAL_CACHE, "castIron", () => new THREE.MeshStandardMaterial({
    color: 0x3b4046,
    roughness: 0.55,
    metalness: 0.55,
    envMapIntensity: 0.6,
  }));
}

function planeGeometry(key, width, height) {
  return cached(GEOMETRY_CACHE, `plane:${key}:${width}x${height}`, () => new THREE.PlaneGeometry(width, height));
}

function boxGeometry(key, w, h, d) {
  return cached(GEOMETRY_CACHE, `box:${key}:${w}x${h}x${d}`, () => new THREE.BoxGeometry(w, h, d));
}

function groundQuad(geometry, material, x, z, y, rotY = 0) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.rotation.z = rotY;
  mesh.position.set(x, y, z);
  mesh.userData.noShadow = true;
  return mesh;
}

// ---------------------------------------------------------------------------
// 一整片场地风化
// ---------------------------------------------------------------------------

/**
 * @param {{halfWidth:number, zMin:number, zMax:number, roadWidth?:number, islandXs?:number[],
 *          islandLength?:number, islandZ?:number, seed?:number, y?:number, patches?:number, cracks?:number,
 *          grates?:number, manholes?:number, name?:string}} options
 *   `islandXs` 是各条收费岛中心的 x（每条给一条排水沟）；留空就按单车道在路侧摆一条。
 * @returns {THREE.Group} group.name = name，子件都带 name 方便自检统计
 */
export function buildWeathering({
  halfWidth = 32,
  zMin = -48,
  zMax = 48,
  roadWidth = 5.2,
  islandXs = [],
  islandLength = 54,
  islandZ = 1.5,
  seed = 20260701,
  y = 0.004,
  patches = 6,
  cracks = 8,
  grates = 4,
  manholes = 2,
  name = "weathering",
} = {}) {
  const group = new THREE.Group();
  group.name = name;
  const random = rng(seed);
  const length = zMax - zMin;
  const middleZ = (zMin + zMax) / 2;

  // 1) 整片场地的脏污/积水/色差贴片
  const stain = groundQuad(
    planeGeometry("stain", halfWidth * 2, length),
    stainMaterial(),
    0, middleZ, y,
  );
  stain.name = "stainDecal";
  stain.renderOrder = 1;
  group.add(stain);

  // 2) 沥青补丁：方正的深色修补面
  const patchMat = patchMaterial();
  for (let i = 0; i < patches; i += 1) {
    const w = 2.4 + random() * 4.2;
    const d = 1.8 + random() * 3.4;
    const x = (random() - 0.5) * halfWidth * 1.5;
    const z = zMin + 4 + random() * (length - 8);
    const patch = groundQuad(planeGeometry(`patch${i}`, w, d), patchMat, x, z, y + 0.0015, random() * Math.PI);
    patch.name = "patchRepair";
    patch.renderOrder = 2;
    group.add(patch);
  }

  // 3) 裂缝：细长折线，每条几段
  const crackMat = crackMaterial();
  for (let i = 0; i < cracks; i += 1) {
    let x = (random() - 0.5) * halfWidth * 1.6;
    let z = zMin + 3 + random() * (length - 6);
    let angle = random() * Math.PI;
    const segments = 2 + Math.floor(random() * 3);
    for (let s = 0; s < segments; s += 1) {
      const len = 0.8 + random() * 2.2;
      const width = 0.04 + random() * 0.05;
      const segment = groundQuad(
        // 几何按尺寸缓存，所以 key 里必须带上实际尺寸，否则会复用别的裂缝的长宽
        planeGeometry(`crack:${width.toFixed(3)}x${len.toFixed(3)}`, width, len),
        crackMat,
        x, z, y + 0.001,
        angle,
      );
      segment.name = "crack";
      segment.renderOrder = 3;
      group.add(segment);
      // 下一段接着往前走（沿自身方向或折一下）
      const dir = angle + (random() - 0.5) * 0.9;
      x += Math.sin(dir) * len;
      z += Math.cos(dir) * len;
      angle = dir;
    }
  }

  // 4) 排水沟：贴着收费岛底的一条长沟 + 周期性篦子（多车道页每条车道一条）
  const channelMaterial = cached(MATERIAL_CACHE, "drainChannel", () => new THREE.MeshStandardMaterial({
    color: 0x2f343a, roughness: 0.85, metalness: 0.25,
  }));
  const drainXs = islandXs.length ? islandXs.map((x) => x - 0.62) : [roadWidth / 2 + 0.35];
  const grateGeo = boxGeometry("grate", 0.5, 0.012, 0.36);
  const grateMat = castIronMaterial();
  drainXs.forEach((drainX, laneIndex) => {
    // 沟跟着收费岛走：长度与中心都对齐岛体（岛 54m、中心 z=1.5），不要伸到岛两头外面的空场地上
    const channel = new THREE.Mesh(planeGeometry(`channel${laneIndex}`, 0.34, islandLength), channelMaterial);
    channel.rotation.x = -Math.PI / 2;
    channel.position.set(drainX, y + 0.002, islandZ);
    channel.name = "drainChannel";
    channel.userData.noShadow = true;
    group.add(channel);

    for (let i = 0; i < grates; i += 1) {
      const grate = new THREE.Mesh(grateGeo, grateMat);
      const z = islandZ - islandLength / 2 + islandLength * ((i + 0.5) / grates) + (random() - 0.5) * 1.2;
      grate.position.set(drainX, y + 0.008, z);
      grate.name = "drainGrate";
      grate.userData.noShadow = true;
      group.add(grate);
    }
  });

  // 5) 井盖：圆形铸铁盖 + 一圈略大的座
  const coverGeo = cached(GEOMETRY_CACHE, "manholeCover", () => new THREE.CylinderGeometry(0.33, 0.33, 0.02, 24));
  const seatGeo = cached(GEOMETRY_CACHE, "manholeSeat", () => new THREE.CylinderGeometry(0.42, 0.42, 0.014, 24));
  const seatMat = cached(MATERIAL_CACHE, "manholeSeat", () => new THREE.MeshStandardMaterial({
    color: 0x565c63, roughness: 0.8, metalness: 0.2,
  }));
  for (let i = 0; i < manholes; i += 1) {
    const x = (random() - 0.5) * halfWidth * 1.4;
    const z = zMin + 6 + random() * (length - 12);
    const seat = new THREE.Mesh(seatGeo, seatMat);
    seat.position.set(x, y + 0.006, z);
    seat.name = "manholeSeat";
    seat.userData.noShadow = true;
    const cover = new THREE.Mesh(coverGeo, castIronMaterial());
    cover.position.set(x, y + 0.014, z);
    cover.name = "manholeCover";
    cover.userData.noShadow = true;
    group.add(seat, cover);
  }

  group.userData.counts = {
    stainDecal: 1,
    patchRepair: patches,
    crack: group.children.filter((child) => child.name === "crack").length,
    drainChannel: drainXs.length,
    drainGrate: drainXs.length * grates,
    manhole: manholes * 2,
  };
  return group;
}

/** 方便页面与自检共用：地面材质的粗糙度图（repeat 按"几十米一张"给）。 */
export function groundRoughness(repeat = [3, 4]) {
  const texture = groundRoughnessTexture();
  const instance = texture.clone();
  instance.needsUpdate = true;
  instance.wrapS = THREE.RepeatWrapping;
  instance.wrapT = THREE.RepeatWrapping;
  instance.repeat.set(repeat[0], repeat[1]);
  instance.colorSpace = THREE.NoColorSpace;
  return instance;
}
