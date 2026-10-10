/**
 * 接地暗部（接触 AO + 正午软影）：让立在场地上的东西真正"踩在地上"。
 *
 * 为什么需要：没有 GPU 的机器上太阳阴影是整块关掉的（`render-runtime.js` 的降级策略：每帧一次
 * 阴影通道会把 CPU 打满），于是设备、路灯、树、护栏立柱、门架腿全都像"贴"在地面上。这一层给每个
 * 立在地上的构件铺一片贴地暗斑，并且不是随便一片圆：
 *
 *   · 大小按构件**底面尺寸**给（细杆就是小斑，机柜/房子就是大斑）；
 *   · 沿**太阳影子方向**轻微拉长并偏移 —— 正午高度角 58°，影长 ≈ 0.62 × 高度，
 *     所以矮东西几乎只有接触暗部、高东西会拖出一条软影（真的影子是硬的，这里是软的）；
 *   · 全部实例合成**一个 InstancedMesh**，只多 1 个 draw call；
 *   · 用**乘法**混合（白=不变、暗=压暗）：地面自己的颗粒与脏污能透过暗斑看见，
 *     而普通"半透明黑片"会把地面糊平。
 *
 * 有 GPU 时真实阴影本来就在，这一层只补"接触处应该更暗"的那一点，不冲突。
 *
 * 与 `scenery.js` / `weathering.js` 的分工：那两个是"往场上摆东西"，这一个只负责"让东西落地"。
 * 它不改任何几何、不移动任何构件位置，所以不影响 check_lane_layout.py 的一致性结论。
 */

import * as THREE from "three";
import { sunShadowFrame } from "./scene-look.js";

const TEXTURE_CACHE = new Map();
const MATERIAL_CACHE = new Map();
const GEOMETRY_CACHE = new Map();

const round2 = (value) => Math.round(value * 100) / 100;

/** 贴地单位方片：平铺在 XZ 面上，局部 X = 长轴、局部 Z = 短轴。几何全局一份（可重复用）。 */
function aoGeometry() {
  if (!GEOMETRY_CACHE.has("plane")) {
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    GEOMETRY_CACHE.set("plane", geometry);
  }
  return GEOMETRY_CACHE.get("plane");
}

/** 接地暗部材质：乘法混合，全局一份（重建时不能每次新建，否则会漏资源）。 */
function aoMaterial() {
  if (!MATERIAL_CACHE.has("ao")) {
    MATERIAL_CACHE.set("ao", new THREE.MeshBasicMaterial({
      map: aoTexture(),
      blending: THREE.MultiplyBlending,
      depthWrite: false,                          // 贴地覆盖层，不写深度
      polygonOffset: true,                        // 与地面共面，靠偏移避免远处打闪
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
      // 乘法混合**不能开雾**：雾是把片元颜色往雾色混（≈0.83），开了等于把整片暗斑变成"乘 0.83"，
      // 远处会变成一层无差别压暗。空气透视该冲淡的是对比，不是整块地面。
      fog: false,
    }));
  }
  return MATERIAL_CACHE.get("ao");
}

/**
 * 接地暗部贴图：乘法用，所以**底色必须是白**（白=完全不变），中心才压暗。
 * 中心 0.42 的不透明度 → 落到地面是"乘 0.58"，是接触阴影该有的量级；
 * 边缘干净地回到 1.0，不然会在大斑外围拉出一圈可见的方边。
 *
 * 颜色不是纯黑而是偏蓝的暗色：接触阴影挡住的主要是**天光**，剩下的直射太阳偏暖，
 * 所以被挡住的部分该往冷里走（与车辆接地阴影同一个道理）。这张图是数据贴图（NoColorSpace），
 * 所以这里的数字就是**线性乘数**，R 压得比 B 多。
 */
function aoTexture() {
  if (!TEXTURE_CACHE.has("ao")) {
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2 - 1);
    gradient.addColorStop(0, "rgba(18,26,40,0.42)");
    gradient.addColorStop(0.45, "rgba(14,20,34,0.26)");
    gradient.addColorStop(0.78, "rgba(8,12,22,0.08)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
    ctx.fill();
    const texture = new THREE.CanvasTexture(canvas);
    // 数据贴图（不是颜色）：乘法混合要的是"线性乘数"，标成 sRGB 会被解码成比 8bit 更暗的值
    texture.colorSpace = THREE.NoColorSpace;
    TEXTURE_CACHE.set("ao", texture);
  }
  return TEXTURE_CACHE.get("ao");
}

/** 这个子树要不要跳过（车有自己的接地阴影、贴片/天空/远景层不该再压暗）。 */
function shouldSkip(object) {
  for (let node = object; node; node = node.parent) {
    const data = node.userData || {};
    if (data.noAO || data.noShadow) return true;
    // 被隐藏的组（比如多车道页关掉「细节」后的岗亭/设备）不算场内构件：
    // three 的 traverse 会照常走进隐藏组的子节点，只有这里能拦住。
    if (node !== object && node.visible === false) return true;
    const name = node.name || "";
    if (name === "vehicle" || name === "contactShadow" || name === "contactAO") return true;
    if (node.isScene) break;
  }
  return false;
}

/**
 * 给自检用的来源标签：构件自己的名字，没有就用几何类型，再借用最近一层有名字的父组。
 * 场景里绝大多数网格是匿名的（树干/树冠是两个 InstancedMesh，都没有名字），
 * 只用 object.name 会得到一串 "Mesh"，"暗部落到哪儿了"就无从核对。
 */
function labelOf(object) {
  const own = object.name || (object.geometry ? object.geometry.type : "") || object.type;
  let parent = object.parent;
  while (parent && !parent.name && parent.parent && !parent.isScene) parent = parent.parent;
  const base = parent && parent.name ? parent.name : "";
  if (own && base && own !== base) return `${base}/${own}`;
  return own || base || object.type;
}

/**
 * 把场景里"立着的构件"清点一遍（不含车、各贴地层、远景层）。
 *
 * 与 `addContactAO` 分开是有原因的：接触暗部和**硬影**是两层（AO 是软的、贴根的；硬影是
 * 按太阳投出来的、可以拖很长的），但"场上有哪些东西立在哪儿"必须是**同一份清单**，
 * 否则两层会对同一棵树给出两个不同的位置。所以清点在这里、怎么用各自决定。
 *
 * 只报事实（位置、底面/顶面高度、占地、几何类型），不做任何"影子该多大"的判断。
 *
 * @param {THREE.Scene} scene
 * @param {{minHeight?:number, minTop?:number, minFootprint?:number,
 *          maxGroundClearance?:number, minSlenderness?:number, maxTop?:number, y?:number}} options
 *   `maxGroundClearance`：底面高过它就算"吊在空中"（AO 默认 0.6 就丢掉门架横梁；硬影要它们）。
 *   `minSlenderness`：高 ≥ 它 × 占地长边，用来丢掉"又长又矮"的东西（护栏横梁、路缘、地面标线）。0 = 不要求。
 * @returns {{candidates:Array<object>}}
 */
export function collectStanding(scene, {
  minHeight = 0.2,
  minTop = 0.5,
  minFootprint = 0.12,
  maxGroundClearance = 0.6,
  minSlenderness = 0.35,
  maxTop = 40,
  y = 0.007,
} = {}) {
  const box = new THREE.Box3();
  const instanceBox = new THREE.Box3();
  const matrix = new THREE.Matrix4();
  const candidates = [];

  const kindOf = (geometry) => {
    const type = geometry ? geometry.type : "";
    if (type === "CylinderGeometry" || type === "ConeGeometry") return "cylinder";
    if (type === "SphereGeometry" || type === "IcosahedronGeometry" || type === "DodecahedronGeometry") return "sphere";
    return "box";
  };

  const consider = (min, max, label, kind) => {
    const height = max.y - min.y;
    const footprintX = max.x - min.x;
    const footprintZ = max.z - min.z;
    if (height < minHeight) return;
    if (max.y < minTop) return;                    // 躺在地面上的东西（箭头、标线、线圈、岛头）
    if (max.y > maxTop) return;                    // 天空穹顶、远景层（另有 noShadow 标记，这里是双保险）
    if (Math.min(footprintX, footprintZ) < minFootprint) return;
    if (minSlenderness > 0 && height < minSlenderness * Math.max(footprintX, footprintZ)) return;
    if (min.y > maxGroundClearance) return;        // 完全悬空（门架横梁、设备悬臂、树冠）
    candidates.push({
      x: (min.x + max.x) / 2,
      z: (min.z + max.z) / 2,
      y: Math.max(y, min.y + 0.006),               // 底在哪儿就贴在哪儿（收费岛上的机柜贴岛面）
      base: round2(min.y),                         // 底面高度
      top: round2(max.y),                          // 顶面高度
      height: round2(height),                      // 构件自身高度（= top − base）
      footprint: [round2(footprintX), round2(footprintZ)],
      dims: [round2(footprintX), round2(height), round2(footprintZ)],
      grounded: min.y <= 0.25,
      kind,
      radius: round2(Math.max(footprintX, footprintZ) / 2),
      label,
    });
  };

  scene.traverse((object) => {
    if (!object.visible && object !== scene) return;
    if (shouldSkip(object)) return;
    if (object.isInstancedMesh) {
      // 树、护栏立柱、道钉这类是实例化的：要按**每个实例**的位置算，不能用一个整体包围盒
      if (!object.geometry) return;
      if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
      const local = object.geometry.boundingBox;
      object.updateWorldMatrix(true, false);
      for (let index = 0; index < object.count; index += 1) {
        object.getMatrixAt(index, matrix);
        instanceBox.copy(local).applyMatrix4(matrix).applyMatrix4(object.matrixWorld);
        consider(instanceBox.min, instanceBox.max, `${labelOf(object)}#${index}`, kindOf(object.geometry));
      }
      return;
    }
    if (!object.isMesh || !object.geometry) return;
    const list = Array.isArray(object.material) ? object.material : [object.material];
    if (list.some((material) => material && material.blending === THREE.MultiplyBlending)) return;
    if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
    object.updateWorldMatrix(true, false);
    box.copy(object.geometry.boundingBox).applyMatrix4(object.matrixWorld);
    consider(box.min, box.max, labelOf(object), kindOf(object.geometry));
  });

  return { candidates };
}

/** 去重：同一格子里只留最大的那片（机柜几十个零件、护栏立柱连着横梁，都会落到同一格）。 */
export function dedupeByCell(items, cell, maxInstances, areaOf) {
  const grid = new Map();
  items.forEach((item) => {
    const key = `${Math.round(item.x / cell)}:${Math.round(item.z / cell)}`;
    const current = grid.get(key);
    if (!current || areaOf(item) > areaOf(current)) grid.set(key, item);
  });
  let entries = Array.from(grid.values()).sort((a, b) => areaOf(b) - areaOf(a));
  if (entries.length > maxInstances) entries = entries.slice(0, maxInstances);
  return entries;
}

/**
 * 给场景里所有"立在地上的构件"加接地暗部。
 *
 * @param {THREE.Scene} scene
 * @param {{direction?:THREE.Vector3|null, y?:number, minHeight?:number, minTop?:number,
 *          minFootprint?:number, maxInstances?:number, cell?:number, maxStretch?:number,
 *          name?:string}} options
 *   `direction` 是**指向太阳**的单位向量（`setupSky` 的返回值）：假影按它的反方向拉长。
 * @returns {{group:THREE.Group, mesh:THREE.InstancedMesh|null, count:number, candidates:number}}
 */
export function addContactAO(scene, {
  direction = null,
  y = 0.007,
  minHeight = 0.2,        // 构件自身高度：地面标线/线圈/箭头都在这之下
  minTop = 0.5,           // 顶面要高过地面，否则是"画在地上的东西"而不是"立着的东西"
  minFootprint = 0.12,    // 底面最短边：再细就不值一片暗斑了
  maxInstances = 600,     // 去重后的上限（只影响画质细节，不影响正确性）
  cell = 1.4,             // 去重网格：同一个机柜上几十个零件只留最大的一片
  maxStretch = 3.2,       // 拉长上限，免得高杆拖出一条夸张的长条
  name = "contactAO",
} = {}) {
  const group = new THREE.Group();
  group.name = name;

  // 假影方向：影子落在太阳的反方向（只取水平分量）——与车辆接地阴影共用同一套取法（scene-look.js）
  const frame = sunShadowFrame(direction);
  const shadowX = frame ? frame.x : 0;
  const shadowZ = frame ? frame.z : 0;
  const cotElevation = frame ? frame.cot : 0;

  // 清点交给 collectStanding（与硬影层共用同一份清单），这里只管"暗斑该多大"
  const { candidates } = collectStanding(scene, {
    minHeight, minTop, minFootprint, y,
    maxGroundClearance: 0.6,        // 完全悬空（门架横梁、设备悬臂、树冠）由硬影层去管
    minSlenderness: 0.35,           // 又长又矮：护栏横梁、路缘
  });

  const entries = candidates.map((item) => {
    const [footprintX, , footprintZ] = item.dims;
    // 分两档：真落地的按**底面**给（机柜、立柱、房子：暗部半径≈半个占地跨度，正好盖住构件自己）；
    // 被支撑在空中的（树冠这类低垂的球体）只当"它底下该有一点暗"来处理，尺寸封顶，
    // 否则一排树会连成一条 9m 宽的暗沟——真正的树影是硬阴影那一层的事（`prop-shadows.js`）。
    const rawSize = item.grounded
      ? Math.max(footprintX, footprintZ) * 0.5 + 0.42
      : Math.max(footprintX, footprintZ) * 0.42 + 0.3;
    const size = Math.min(rawSize, item.grounded ? 12 : 2.2);
    const shadowLength = cotElevation * item.height;
    const along = Math.min(size + shadowLength * 0.45, size * maxStretch);
    return {
      x: item.x,
      z: item.z,
      y: item.y,
      cross: size,
      along,
      grounded: item.grounded,
      offset: shadowLength * 0.28,
      height: item.height,
      dims: item.dims,
      label: item.label,
    };
  });

  // 去重：同一格子里只留最大的那片（机柜几十个零件、护栏立柱连着横梁，都会落到同一格）
  const deduped = dedupeByCell(entries, cell, maxInstances, (item) => item.along * item.cross);

  if (!deduped.length) {
    return { group, mesh: null, count: 0, candidates: candidates.length };
  }

  const geometry = aoGeometry();
  const material = aoMaterial();

  const mesh = new THREE.InstancedMesh(geometry, material, deduped.length);
  mesh.name = "contactAOMesh";
  mesh.renderOrder = 1;                           // 画在地面之后
  const quaternion = new THREE.Quaternion();
  const axis = new THREE.Vector3(0, 1, 0);
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  const angle = Math.atan2(-shadowZ, shadowX);    // 把局部 +X 转到影子方向
  deduped.forEach((item, index) => {
    quaternion.setFromAxisAngle(axis, angle);
    position.set(item.x + shadowX * item.offset, item.y, item.z + shadowZ * item.offset);
    scale.set(item.along * 2, 1, item.cross * 2);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(index, matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  const radians = Math.round((angle * 180) / Math.PI * 10) / 10;
  mesh.userData.count = deduped.length;
  mesh.userData.candidates = candidates.length;
  mesh.userData.grounded = deduped.filter((item) => item.grounded).length;
  const round1 = (value) => Math.round(value * 10) / 10;
  mesh.userData.xRange = [round1(Math.min(...deduped.map((item) => item.x))), round1(Math.max(...deduped.map((item) => item.x)))];
  mesh.userData.zRange = [round1(Math.min(...deduped.map((item) => item.z))), round1(Math.max(...deduped.map((item) => item.z)))];
  // 自检用：暗部到底落到哪些东西上了（去重后）
  const byName = {};
  deduped.forEach((item) => {
    const label = String(item.label || "?").replace(/#\d+$/, "");
    byName[label] = (byName[label] || 0) + 1;
  });
  mesh.userData.byName = byName;
  // 自检用：方向和拉长是不是真的按太阳高度角算的
  mesh.userData.samples = deduped.slice(0, 8).map((item) => ({
    x: Math.round(item.x * 100) / 100,
    z: Math.round(item.z * 100) / 100,
    label: item.label,
    height: item.height,
    dims: item.dims,
    grounded: item.grounded,
    along: Math.round(item.along * 100) / 100,
    cross: Math.round(item.cross * 100) / 100,
    offset: Math.round(item.offset * 100) / 100,
    angleDeg: radians,
  }));
  mesh.userData.shadow = {
    direction: direction ? [direction.x, direction.y, direction.z].map((v) => Math.round(v * 1000) / 1000) : null,
    shadowDir: [Math.round(shadowX * 1000) / 1000, Math.round(shadowZ * 1000) / 1000],
    cotElevation: Math.round(cotElevation * 1000) / 1000,
    expectedAngleDeg: radians,
  };
  group.add(mesh);
  scene.add(group);
  return { group, mesh, count: deduped.length, candidates: candidates.length };
}
