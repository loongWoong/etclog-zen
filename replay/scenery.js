/**
 * 场景道具与地面细节：波形梁护栏、路灯、行道树、收费岛警示条纹、车道标线、轮胎磨损痕。
 *
 * 目的：让收费站不再"只有设备浮在一块板上"。所有道具都是程序化几何 + 共享材质，
 * 不依赖任何外部模型/贴图文件；同一份代码同时供 index.html（单车现场）与 lanes.html
 * （多车道过程视图）使用，两页面的场地观感保持一致。
 *
 * 约定：道具只加在广场外围与既有构件上，不移动任何设备/线圈位置，
 * 因此 check_lane_layout.py 的一致性结论不受影响。
 */

import * as THREE from "three";

const GEOMETRY_CACHE = new Map();
const MATERIAL_CACHE = new Map();
const TEXTURE_CACHE = new Map();

function hash(text) {
  let value = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return Math.abs(value);
}

/** 确定性随机（同一个种子每次刷新都一样，避免回放画面闪来闪去）。 */
function rng(seed) {
  let state = hash(String(seed)) || 1;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function geometry(key, factory) {
  if (!GEOMETRY_CACHE.has(key)) GEOMETRY_CACHE.set(key, factory());
  return GEOMETRY_CACHE.get(key);
}

function material(key, options) {
  if (!MATERIAL_CACHE.has(key)) MATERIAL_CACHE.set(key, new THREE.MeshStandardMaterial(options));
  return MATERIAL_CACHE.get(key);
}

// ---------------------------------------------------------------------------
// 收费岛警示条纹（黄黑斜纹）
// ---------------------------------------------------------------------------
export function hazardTexture({ size = 128, stripe = 26 } = {}) {
  const key = `hazard:${size}:${stripe}`;
  if (TEXTURE_CACHE.has(key)) return TEXTURE_CACHE.get(key);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#e8b21c";
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "#20242a";
  ctx.lineWidth = stripe;
  ctx.beginPath();
  for (let offset = -size; offset < size * 2; offset += stripe * 2) {
    ctx.moveTo(offset, -4);
    ctx.lineTo(offset + size, size + 4);
  }
  ctx.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  TEXTURE_CACHE.set(key, texture);
  return texture;
}

export function hazardMaterial({ repeat = [1, 1], name = "islandHazard" } = {}) {
  const map = hazardTexture().clone();
  map.needsUpdate = true;
  map.repeat.set(repeat[0], repeat[1]);
  const material = new THREE.MeshStandardMaterial({ map, roughness: 0.7, metalness: 0.05 });
  material.name = name;
  return material;
}

// ---------------------------------------------------------------------------
// 波形梁护栏（公路护栏）
// ---------------------------------------------------------------------------

/**
 * 一段护栏：立柱用 InstancedMesh（几十根柱子只一次绘制），横梁两根长条。
 * @param {{length:number, spacing?:number, height?:number, name?:string}} options
 */
export function buildGuardrail({ length = 60, spacing = 4, height = 0.78, name = "guardrail" } = {}) {
  const group = new THREE.Group();
  group.name = name;
  const postGeometry = geometry("post", () => new THREE.BoxGeometry(0.11, 1, 0.13));
  const postMaterial = material("postSteel", { color: 0x9aa3ad, roughness: 0.55, metalness: 0.65 });
  const count = Math.max(2, Math.round(length / spacing) + 1);
  const posts = new THREE.InstancedMesh(postGeometry, postMaterial, count);
  posts.name = `${name}Posts`;
  posts.castShadow = true;
  const matrix = new THREE.Matrix4();
  const scale = new THREE.Vector3(1, height + 0.1, 1);
  for (let i = 0; i < count; i += 1) {
    const z = -length / 2 + (i * length) / (count - 1);
    matrix.compose(new THREE.Vector3(0, (height + 0.1) / 2 - 0.05, z), new THREE.Quaternion(), scale);
    posts.setMatrixAt(i, matrix);
  }
  posts.instanceMatrix.needsUpdate = true;
  group.add(posts);

  const beamMaterial = material("guardBeam", { color: 0xc4ccd5, roughness: 0.42, metalness: 0.78 });
  for (const y of [height, height - 0.26]) {
    const beam = new THREE.Mesh(
      geometry(`beam:${length.toFixed(1)}`, () => new THREE.BoxGeometry(0.07, 0.17, length)),
      beamMaterial,
    );
    beam.position.set(0.06, y, 0);
    beam.castShadow = true;
    beam.receiveShadow = true;
    beam.name = `${name}Beam`;
    group.add(beam);
  }
  return group;
}

// ---------------------------------------------------------------------------
// 路灯
// ---------------------------------------------------------------------------
export function buildLampPost({ height = 9, armLength = 2.2, name = "lampPost" } = {}) {
  const group = new THREE.Group();
  group.name = name;
  const poleMaterial = material("pole", { color: 0x8892a0, roughness: 0.5, metalness: 0.7 });
  const pole = new THREE.Mesh(
    geometry(`pole:${height}`, () => new THREE.CylinderGeometry(0.09, 0.14, height, 10)),
    poleMaterial,
  );
  pole.position.y = height / 2;
  pole.castShadow = true;
  group.add(pole);

  const base = new THREE.Mesh(
    geometry("poleBase", () => new THREE.CylinderGeometry(0.3, 0.36, 0.34, 12)),
    material("poleBase", { color: 0x6d7681, roughness: 0.8, metalness: 0.2 }),
  );
  base.position.y = 0.17;
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);

  const arm = new THREE.Mesh(
    geometry(`arm:${armLength}`, () => new THREE.CylinderGeometry(0.06, 0.07, armLength, 8)),
    poleMaterial,
  );
  arm.rotation.z = Math.PI / 2;
  arm.position.set(armLength / 2, height - 0.1, 0);
  arm.castShadow = true;
  group.add(arm);

  const head = new THREE.Mesh(
    geometry("lampHead", () => new THREE.BoxGeometry(0.62, 0.13, 0.3)),
    material("lampHead", { color: 0x5d6672, roughness: 0.6, metalness: 0.5 }),
  );
  head.position.set(armLength, height - 0.2, 0);
  head.rotation.z = -0.12;
  head.castShadow = true;
  group.add(head);

  const lens = new THREE.Mesh(
    geometry("lampLens", () => new THREE.BoxGeometry(0.5, 0.04, 0.24)),
    material("lampLens", { color: 0xdfe6ee, emissive: 0x2a3140, emissiveIntensity: 0.35, roughness: 0.25 }),
  );
  lens.position.set(armLength, height - 0.28, 0);
  lens.rotation.z = -0.12;
  group.add(lens);
  return group;
}

// ---------------------------------------------------------------------------
// 行道树（树干 + 树冠各一个 InstancedMesh）
// ---------------------------------------------------------------------------
export function buildTreeRow({ positions, seed = 11, name = "trees" } = {}) {
  const group = new THREE.Group();
  group.name = name;
  if (!positions.length) return group;
  const random = rng(seed);

  const trunkGeometry = geometry("trunk", () => new THREE.CylinderGeometry(0.16, 0.26, 1, 7));
  const trunkMaterial = material("trunk", { color: 0x51402f, roughness: 0.92, metalness: 0 });
  const trunks = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, positions.length);
  trunks.castShadow = true;

  const canopyGeometry = geometry("canopy", () => new THREE.IcosahedronGeometry(1, 1));
  const canopyMaterial = material("canopy", { color: 0xffffff, roughness: 0.88, metalness: 0, flatShading: true });
  const canopies = new THREE.InstancedMesh(canopyGeometry, canopyMaterial, positions.length * 3);
  canopies.castShadow = true;

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const color = new THREE.Color();
  const greens = [0x37622c, 0x41702f, 0x2f5726, 0x4a7a36];

  positions.forEach((position, index) => {
    const trunkHeight = 2.4 + random() * 1.6;
    const trunkScale = 0.8 + random() * 0.5;
    matrix.compose(
      new THREE.Vector3(position.x, (trunkHeight * trunkScale) / 2, position.z),
      quaternion.identity(),
      scale.set(trunkScale, trunkHeight * trunkScale, trunkScale),
    );
    trunks.setMatrixAt(index, matrix);

    // 每棵树三个球叠成树冠（低多边形，靠 flatShading 出体积感）
    const crownRadius = 1.7 + random() * 1.1;
    const crownY = trunkHeight * trunkScale + crownRadius * 0.55;
    for (let blob = 0; blob < 3; blob += 1) {
      const offset = blob === 0 ? [0, 0.25, 0] : [(random() - 0.5) * crownRadius * 1.1, (random() - 0.3) * crownRadius * 0.5, (random() - 0.5) * crownRadius * 1.1];
      const radius = crownRadius * (blob === 0 ? 1 : 0.72 + random() * 0.25);
      const yScale = radius * (0.82 + random() * 0.28);
      // 树冠别沉到地面以下：球被随机倾斜后包围盒会变高，留 1.3 倍余量
      const halfY = Math.max(radius, yScale) * 1.3;
      const centerY = Math.max(crownY + offset[1], halfY + 0.25);
      matrix.compose(
        new THREE.Vector3(position.x + offset[0], centerY, position.z + offset[2]),
        quaternion.setFromEuler(new THREE.Euler((random() - 0.5) * 0.7, random() * Math.PI, (random() - 0.5) * 0.7)),
        scale.set(radius, yScale, radius),
      );
      canopies.setMatrixAt(index * 3 + blob, matrix);
      canopies.setColorAt(index * 3 + blob, color.setHex(greens[Math.floor(random() * greens.length)]));
    }
  });
  trunks.instanceMatrix.needsUpdate = true;
  canopies.instanceMatrix.needsUpdate = true;
  if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;
  group.add(trunks, canopies);
  return group;
}

// ---------------------------------------------------------------------------
// 车道标线与轮胎磨损痕
// ---------------------------------------------------------------------------

/**
 * 车道面层细节：两侧白色边线、停止线、两条轮胎磨损痕。
 * 尺寸与既有"车位标线"同一套做法（薄长方体，避免 z-fighting）。
 */
export function buildLaneMarkings({ roadWidth = 5.2, roadLength = 70, wear = true, name = "laneMarkings" } = {}) {
  const group = new THREE.Group();
  group.name = name;
  const paint = geometry("markPaint", () => new THREE.BoxGeometry(1, 1, 1));
  const paintMaterial = material("lanePaint", { color: 0xe7ecf2, roughness: 0.72, metalness: 0.02 });

  const edge = (x) => {
    const mesh = new THREE.Mesh(paint, paintMaterial);
    mesh.scale.set(0.16, 0.02, roadLength);
    mesh.position.set(x, 0.012, 0);
    mesh.receiveShadow = true;
    return mesh;
  };
  const inset = roadWidth / 2 - 0.12;
  group.add(edge(-inset), edge(inset));

  // 停止线：栏杆前 3 米（栏杆 z=24，与 6 米一道的车位标线不重叠）
  const stopLine = new THREE.Mesh(paint, paintMaterial);
  stopLine.scale.set(roadWidth - 0.5, 0.02, 0.4);
  stopLine.position.set(0, 0.014, 21);
  stopLine.receiveShadow = true;
  stopLine.name = "stopLine";
  group.add(stopLine);

  if (wear) {
    const wearMaterial = material("tireWear", {
      color: 0x2a2f36, roughness: 1, metalness: 0, transparent: true, opacity: 0.42,
    });
    for (const x of [-0.62, 0.62]) {
      const track = new THREE.Mesh(
        geometry(`wear:${roadLength}`, () => new THREE.PlaneGeometry(0.42, roadLength)),
        wearMaterial,
      );
      track.rotation.x = -Math.PI / 2;
      track.position.set(x, 0.006, 0);
      track.name = "tireWear";
      group.add(track);
    }
  }
  return group;
}

// ---------------------------------------------------------------------------
// 一整片场地道具
// ---------------------------------------------------------------------------

/**
 * 广场外围道具：两侧 + 远端护栏、路灯、两排行道树。
 * @param {{halfWidth:number, zMin:number, zMax:number, openEnd?:boolean, seed?:number}} options
 */
export function buildScenery({ halfWidth = 34, zMin = -48, zMax = 48, openEnd = true, seed = 20260701, name = "scenery" } = {}) {
  const group = new THREE.Group();
  group.name = name;

  const railLength = zMax - zMin + 8;
  const railZ = (zMin + zMax) / 2;
  for (const side of [-1, 1]) {
    const rail = buildGuardrail({ length: railLength, spacing: 4, name: `guardrail${side > 0 ? "R" : "L"}` });
    rail.position.set(side * (halfWidth + 0.6), 0, railZ);
    group.add(rail);
  }
  if (!openEnd) {
    const endRail = buildGuardrail({ length: halfWidth * 2 + 1.2, spacing: 4, name: "guardrailFar" });
    endRail.rotation.y = Math.PI / 2;
    endRail.position.set(0, 0, zMin - 4);
    group.add(endRail);
  }

  // 路灯：沿两侧护栏内侧，每 26 米一根，灯臂朝场地内
  const random = rng(seed);
  for (const side of [-1, 1]) {
    for (let z = zMin + 8; z <= zMax - 6; z += 26) {
      const lamp = buildLampPost({ height: 9 + random() * 0.6, armLength: 2.2 });
      lamp.position.set(side * (halfWidth - 0.9), 0, z);
      lamp.rotation.y = side > 0 ? Math.PI : 0;
      group.add(lamp);
    }
  }

  // 行道树：护栏外两排交错
  const positions = [];
  for (const side of [-1, 1]) {
    for (let row = 0; row < 2; row += 1) {
      const x = side * (halfWidth + 6 + row * 8 + (row ? 4 : 0));
      for (let z = zMin - 2 + row * 5; z <= zMax + 4; z += 9) {
        positions.push(new THREE.Vector3(x + (random() - 0.5) * 1.6, 0, z + (random() - 0.5) * 1.6));
      }
    }
  }
  // 远端再加一排，挡住地平线
  for (let x = -halfWidth; x <= halfWidth; x += 8) {
    positions.push(new THREE.Vector3(x + (random() - 0.5) * 2, 0, zMin - 14 - random() * 6));
  }
  group.add(buildTreeRow({ positions, seed }));
  return group;
}

// ---------------------------------------------------------------------------
// 远景层次（远山 / 厂房 / 远处树墙）
// ---------------------------------------------------------------------------

/**
 * 广场之外的远景：一排远山、几座厂房与两只筒仓、一条远处树墙。
 *
 * 目的是让地平线不再是"一条雾线"：真实收费站外面总有更远的建筑与地形，
 * 它们被雾一化就成了剪影，画面的纵深立刻就出来了。
 *
 * 两点约定：
 *  - 距离按各页相机远平面取：index 的相机 far=400 且最远能在 190m 处观察，
 *    所以整个远景层放在 z ≈ -140 ~ -260，任何机位都还在远平面内（否则会被裁掉）；
 *  - 远山用不受光的 `MeshBasicMaterial`（远景本来就该被空气透视压成剪影），
 *    厂房与树用正常受光材质，颜色随雾衰减。全部 `userData.noShadow = true`，
 *    并且要在 `applyShadowFlags()` **之后**加进场景，免得被当成场内物体。
 *
 * @param {{z?:number, spread?:number, hills?:number, buildings?:number, seed?:number, name?:string}} options
 */
export function buildDistantHorizon({
  z = -205, spread = 280, hills = 5, buildings = 5, seed = 20260701, name = "distant",
} = {}) {
  const group = new THREE.Group();
  group.name = name;
  const random = rng(seed);

  // 远山：压扁的球体，纯剪影，颜色接近雾色（靠雾自然融进天空）
  const hillMaterial = new THREE.MeshBasicMaterial({ color: 0x6d7c72, fog: true });
  const hillGeometry = geometry("farHill", () => new THREE.SphereGeometry(1, 24, 12));
  for (let i = 0; i < hills; i += 1) {
    const hill = new THREE.Mesh(hillGeometry, hillMaterial.clone());
    const scale = 0.75 + random() * 0.55;
    hill.scale.set((90 + random() * 120) * scale, (16 + random() * 20) * scale, 60 + random() * 40);
    // 距离收在"广场中心 ±(190,265)"以内：index 的相机 far=400、最远机位 190m，
    // 再远就会被远平面整块裁掉（会看到硬边）
    hill.position.set((random() - 0.5) * spread * 1.3, (2 + random() * 4) * scale - 6, z - 20 - random() * 45);
    hill.name = "farHill";
    hill.userData.noShadow = true;
    // 每座山一点点色调差别，避免剪影一条线
    hill.material.color.setHSL(0.32 + random() * 0.06, 0.10 + random() * 0.06, 0.36 + random() * 0.06);
    group.add(hill);
  }

  // 厂房：方盒子 + 稍深的屋面，工业区最常见的体量；再来两只筒仓
  const wallMaterial = material("farWall", { color: 0xb9bec3, roughness: 0.86, metalness: 0.04 });
  const roofMaterial = material("farRoof", { color: 0x878d94, roughness: 0.72, metalness: 0.16 });
  const siloMaterial = material("farSilo", { color: 0xc7ccd1, roughness: 0.7, metalness: 0.12 });
  const bodyGeometry = geometry("farBuilding", () => new THREE.BoxGeometry(1, 1, 1));
  for (let i = 0; i < buildings; i += 1) {
    const width = 26 + random() * 40;
    const depth = 16 + random() * 20;
    const height = 8 + random() * 8;
    const x = (random() - 0.5) * spread * 1.7;
    const bz = z + 10 - random() * 70;
    const body = new THREE.Mesh(bodyGeometry, wallMaterial);
    body.scale.set(width, height, depth);
    body.position.set(x, height / 2, bz);
    body.name = "farBuilding";
    body.userData.noShadow = true;
    const roof = new THREE.Mesh(bodyGeometry, roofMaterial);
    roof.scale.set(width + 1.2, 0.7, depth + 1.2);
    roof.position.set(x, height + 0.2, bz);
    roof.name = "farRoof";
    roof.userData.noShadow = true;
    group.add(body, roof);
  }
  const siloGeometry = geometry("farSilo", () => new THREE.CylinderGeometry(1, 1, 1, 18));
  for (let i = 0; i < 2; i += 1) {
    const silo = new THREE.Mesh(siloGeometry, siloMaterial);
    silo.scale.set(3.2 + random(), 14 + random() * 6, 3.2 + random());
    silo.position.set(spread * (0.45 + random() * 0.3) * (i ? -1 : 1), silo.scale.y / 2, z - 10 - random() * 25);
    silo.name = "farSilo";
    silo.userData.noShadow = true;
    group.add(silo);
  }

  // 远处树墙：接在行道树之外再一排，把厂房与天空之间那条硬边打散
  const positions = [];
  for (let x = -spread * 1.1; x <= spread * 1.1; x += 9) {
    positions.push(new THREE.Vector3(x + (random() - 0.5) * 4, 0, z + 52 + (random() - 0.5) * 14));
  }
  const row = buildTreeRow({ positions, seed: seed + 7, name: "farTrees" });
  row.traverse((child) => { child.userData.noShadow = true; child.castShadow = false; child.receiveShadow = false; });
  row.userData.noShadow = true;
  group.add(row);

  group.userData.counts = {
    farHill: hills,
    farBuilding: buildings,
    farRoof: buildings,
    farSilo: 2,
    farTrees: positions.length,
  };
  return group;
}
