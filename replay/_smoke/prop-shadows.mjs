/**
 * 静态构件的**硬影**层：路灯、机柜、岗亭、门架、树干与树冠按太阳投在地上的那一条影子。
 *
 * 为什么单独一层：`contact-ao.js` 是**接触暗部**（软的、贴根的、故意把拉长上限压在 3.2 倍的），
 * 它自己的注释就写着"真正的树影是硬阴影那一层的事"。没有这一层时：
 *   · 9m 高的路灯脚下只有 1.7m 一团暗，真实影子该有 5.6m 长；
 *   · 树冠挂在高处，AO 只能给它底下一点暗，而真实影子是**树冠自己**投出来的椭圆；
 *   · 门架横梁整个吊在 6m 高，AO 直接丢掉，实际它会在路面上横一道影子。
 * 车辆已经有 `vehicle-models.js` 的扫掠贴图，这一层把同一套物理补到场内其它构件上。
 *
 * 投影是**解析**算的，不是"往那边拉一拉"——太阳是平行光，投影就是线性映射
 * `(x, y, z) → (x + dirX·cot·y, z + dirZ·cot·y)`：
 *
 *   · 方盒：占地矩形 与 它沿影子方向平移 `cot × 自身高度` 的那一份，取凸包。
 *     平移量用**自身高度**（top − base），离地高度只贡献整体偏移 `cot × base`；
 *     所以吊在 6m 的横梁投出来的是"随它自身厚度扫出来的窄带"，不是一条 4m 宽的带子。
 *   · 圆柱/圆锥（灯杆、树干）：圆盘扫 `cot × 自身高度` → 两端各一个半圆的跑道形。
 *   · 球/多面球（树冠）：球对地面的平行投影是**椭圆**，沿影子方向半轴 `r × √(1+cot²)`、
 *     垂直方向还是 `r`（58° 时拉长 1.18 倍），中心落在球心的投影点上。
 *
 * 两个容易翻车的地方，都按物理掐掉了：
 *   1. **按实际铺装范围裁剪**。index 的路灯/行道树站在 64×96 广场**之外**（广场 x∈[−32,32]，
 *      树在 x≈±40），不裁的话影子会悬在雾里当空飘着——一条 5.6m 长的黑影比没有影子更假。
 *   2. **动的东西不烤**。栏杆臂每帧在转，烤一条死影子必然对不上（按名字跳过 barrierArm）。
 *
 * 画法：不用贴图，把轮廓直接做成世界 XZ 上的多边形，靠**顶点色**从影核乘数渐变到白
 * （乘法混合里白=完全不变）。轮廓本来就在世界坐标里，省掉"贴图轴向/局部坐标"这一层最容易搞反的东西，
 * 全部构件也就能合并成**一个** mesh（+1 个 draw call）。
 * `toneMapped:false` + `fog:false`：乘数必须是物理比值本身，不能再过一遍 ACES / 空气透视。
 */

import * as THREE from "./vendor/three/build/three.module.mjs";
import { sunShadowFrame, SUN_ANGULAR_RADIUS } from "./scene-look.mjs";
import { collectStanding, dedupeByCell } from "./contact-ao.mjs";

const MATERIAL_CACHE = new Map();

const round2 = (value) => Math.round(value * 100) / 100;

/** 凸包（单调链）：输入 [[x,z],...]，返回逆时针轮廓。 */
function convexHull(points) {
  if (points.length < 3) return points.slice();
  const sorted = points.slice().sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-9) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-9) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

export function polygonArea(outline) {
  let sum = 0;
  for (let i = 0; i < outline.length; i += 1) {
    const [x1, z1] = outline[i];
    const [x2, z2] = outline[(i + 1) % outline.length];
    sum += x1 * z2 - x2 * z1;
  }
  return Math.abs(sum) / 2;
}

/** Sutherland–Hodgman：把凸多边形裁到轴对齐矩形内（矩形外的影子没有地面可落）。 */
export function clipToRect(outline, rect) {
  if (!rect) return outline;
  const edges = [
    { inside: (p) => p[0] >= rect.minX, intersect: (a, b) => [rect.minX, a[1] + ((b[1] - a[1]) * (rect.minX - a[0])) / (b[0] - a[0])] },
    { inside: (p) => p[0] <= rect.maxX, intersect: (a, b) => [rect.maxX, a[1] + ((b[1] - a[1]) * (rect.maxX - a[0])) / (b[0] - a[0])] },
    { inside: (p) => p[1] >= rect.minZ, intersect: (a, b) => [a[0] + ((b[0] - a[0]) * (rect.minZ - a[1])) / (b[1] - a[1]), rect.minZ] },
    { inside: (p) => p[1] <= rect.maxZ, intersect: (a, b) => [a[0] + ((b[0] - a[0]) * (rect.maxZ - a[1])) / (b[1] - a[1]), rect.maxZ] },
  ];
  let output = outline;
  for (const edge of edges) {
    const input = output;
    output = [];
    for (let i = 0; i < input.length; i += 1) {
      const current = input[i];
      const previous = input[(i + input.length - 1) % input.length];
      const currentInside = edge.inside(current);
      const previousInside = edge.inside(previous);
      if (currentInside) {
        if (!previousInside) output.push(edge.intersect(previous, current));
        output.push(current);
      } else if (previousInside) {
        output.push(edge.intersect(previous, current));
      }
    }
    if (!output.length) return [];
  }
  return output;
}

/**
 * 解析投影：给一个构件，算出它在地上的轮廓（世界 XZ）。
 *
 * 返回的是**一组环**而不是一个轮廓：树冠不是一个实心圆盘，是一团一团的枝叶。实心椭圆投在地上
 * 就是一块黑斑，真实树影是**带光斑的**（叶隙漏光）。所以球按"簇"来投：每簇是一个小球，平行投影成
 * 一个小椭圆，簇与簇之间留缝 → 地上就是树影该有的斑驳样子。方盒/圆柱还是单个环（雨棚本来就该整片）。
 */
export function projectRings(item, frame, sinElev) {
  const dirX = frame.x;
  const dirZ = frame.z;
  const cot = frame.cot;
  const perpX = -dirZ;
  const perpZ = dirX;
  const sweep = cot * (item.top - item.base);
  const lift = cot * item.base;
  const at = (along, across) => [
    item.x + dirX * (along + lift) + perpX * across,
    item.z + dirZ * (along + lift) + perpZ * across,
  ];

  if (item.kind === "sphere") {
    // 球（树冠）= 一簇簇叶子，每簇投影成一个小椭圆；沿影子方向 r/sin(高度角)、垂直方向 r
    const radius = item.radius;
    const centreHeight = (item.base + item.top) / 2;
    const rings = [];
    let coverage = 0;
    // 判"要不要斑驳"用的半影必须和报出去的每簇半影同源：都是**簇心高度**（叶子长在冠中心那一层），
    // 用树冠顶算会偏大，导致自检按报出来的数复算时对不上。
    const canopyPenumbra = penumbraFor(centreHeight, sinElev);
    canopyClumps(radius, sinElev, centreHeight, canopyPenumbra).forEach((circle) => {
      // 这一簇的影子中心：球心在 (along, across, y)，投影后沿影子方向多走 cot×y
      const along = circle.along + cot * circle.y;
      const across = circle.across;
      const a = circle.r / sinElev;
      const points = [];
      for (let i = 0; i < 12; i += 1) {
        const angle = (i / 12) * Math.PI * 2;
        // at() 内部会再加 lift，这里减掉，避免整片多飘 cot×base 出去
        points.push(at(along - lift + Math.cos(angle) * a, across + Math.sin(angle) * circle.r));
      }
      rings.push({ points, penumbra: penumbraFor(circle.y, sinElev), clump: circle });
      coverage += a * circle.r;
    });
    const span = radius * CANOPY_SPAN;
    const canopyArea = (span / sinElev) * span;
    // projected：**整块**投影面积（斑驳前、未裁剪）。判"这个构件的影子够不够大"要用它，
    // 不能用斑驳后剩下的面积 —— 否则一棵大树的影子会被当成小灌木丢掉。
    // ringsTotal：斑驳后的簇数（裁剪前）。裁剪只会让落在铺装外的簇消失，簇数本身是几何事实。
    return {
      rings,
      sweep,
      lift,
      projected: Math.PI * canopyArea,
      ringsTotal: rings.length,
      coverage: canopyArea > 0 ? coverage / canopyArea : 0,
    };
  }

  const points = [];
  if (item.kind === "cylinder") {
    const r = item.radius;
    for (let i = 0; i < 14; i += 1) {
      const angle = (i / 14) * Math.PI * 2;
      points.push(at(Math.cos(angle) * r, Math.sin(angle) * r));
      points.push(at(Math.cos(angle) * r + sweep, Math.sin(angle) * r));
    }
  } else {
    const halfX = item.footprint[0] / 2;
    const halfZ = item.footprint[1] / 2;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const lx = sx * halfX;
        const lz = sz * halfZ;
        // 占地矩形按世界轴摆（近景构件基本都是轴对齐的），转到影子坐标系后再平移 sweep
        const along = lx * dirX + lz * dirZ;
        const across = lx * perpX + lz * perpZ;
        points.push(at(along, across));
        points.push(at(along + sweep, across));
      }
    }
  }
  const hull = convexHull(points);
  return {
    rings: [{ points: hull, penumbra: penumbraFor(item.top, sinElev), clump: null }],
    sweep,
    lift,
    projected: polygonArea(hull),
    ringsTotal: 1,
    coverage: 1,
  };
}

// 树冠用外接球的 74% 当"有叶子的那部分"；再往外是稀疏枝条，本来就漏光。
const CANOPY_SPAN = 0.74;
// 叶缝要宽过 3 倍半影才看得见（半影 6~14cm）：达不到这个尺度就别硬拆，整块才是真实的样子。
const CANOPY_DAPPLE_MIN = 3;
// 簇-簇格距 = 这个系数 × 簇半径。下限 2.0（否则相邻两簇的椭圆会相交、乘法压两次）；
// 取 2.12：叶缝 ≈ 12% 簇径（6~13cm，正好和半影同量级 —— 细碎的软光斑），
// 覆盖率 ≈ π/2.12² ≈ 0.70，接近盛夏密树冠该有的样子。取 2.5 时覆盖率掉到 0.50，
// 树影会明显比真实偏淡（实测会导致"硬影变化落在下半部"这条核对不过）。
const CANOPY_CLUMP_STEP = 2.12;
// 上限按格距反推：2.12 格距下最大树冠约 11~12 簇，留到 18 是为了**永远不截断外圈** ——
// 截断是按离冠心远近排的，一截就先丢最外圈，恰好又回到"树冠边缘没影子"那个坑。
const CANOPY_CLUMP_MAX = 18;
// 簇心铺到"叶子范围"边界为止（不外扩也不内缩），簇团半径自然会让外圈探出去半个簇 —— 这是有意的：
// CANOPY_SPAN=0.74 本来就把球缩了一圈（外圈枝叶稀），簇团再探出去正好补回到树冠真正的轮廓。
// 之前要求"整簇装在冠内"，结果是树冠边缘一圈完全没有簇：一棵站在铺装边上的树（lanes 上 297 棵里
// 289 棵）重叠那一侧一个簇都没有，整片树影凭空消失。
const CANOPY_CLUMP_INSET = 0;

/**
 * 把树冠切成互相**不相交**的一簇簇叶子（六角格，铺在影子坐标系里）。
 *
 * 为什么铺在影子坐标系、而且不用随机抖动：椭圆是各向异性的——沿影子方向被拉长 1/sin(高度角)≈1.18 倍，
 * 所以"沿影子方向"的格距必须按 1/sin(高度角) 放大，否则相邻两簇的椭圆会在长轴方向上叠起来。
 * 两条影子一旦叠加，乘法混合就会把那块压两次（tint² ≈ 0.03，一块死黑），所以宁可留缝：
 * 缝隙就是漏下来的光斑，树影才像树影。格子是确定的（没有随机数），每次加载完全一样。
 *
 * 例外：叶缝得宽过半影才看得见。小灌木的"树冠"还没半影宽，真实影子本来就糊成一整块 ——
 * 这种就返回**一簇**（一簇半径 = 整个冠幅，铺出来就是那颗实心椭圆），不是所有树都硬拆。
 */
function canopyClumps(radius, sinElev, centreHeight, penumbra) {
  const R = radius * CANOPY_SPAN;                 // 叶子部分的外接半径
  if (R < CANOPY_DAPPLE_MIN * penumbra) {
    return [{ along: 0, across: 0, y: centreHeight, r: R, mode: "solid" }];
  }
  // 簇半径按冠幅等比给（不能给小树冠一个固定的下限：那样小树冠只剩一两簇，影子又变回一块实心斑），
  // 只留一个很小的绝对下限防数值退化。覆盖率与簇半径**无关**（≈ π/格距系数²）：簇大簇少、簇小簇多。
  const clumpRadius = Math.min(0.55, Math.max(0.04, R * 0.26));
  const stepAlong = (CANOPY_CLUMP_STEP * clumpRadius) / sinElev; // 长轴格距 > 2×长半轴 → 椭圆不相交
  const stepAcross = CANOPY_CLUMP_STEP * clumpRadius;            // 短轴格距 > 2×短半轴
  const alongLimit = R / sinElev;
  const acrossLimit = R;
  const circles = [];
  const rows = Math.ceil(acrossLimit / stepAcross) + 1;
  const cols = Math.ceil(alongLimit / stepAlong) + 1;
  for (let i = -rows; i <= rows; i += 1) {
    for (let j = -cols; j <= cols; j += 1) {
      // 六角错列：隔一行错半格，同样多的缝下少放几簇
      const across = i * stepAcross;
      const along = j * stepAlong + (Math.abs(i) % 2 ? stepAlong / 2 : 0);
      if (Math.hypot(along / alongLimit, across / acrossLimit)
        > 1 - CANOPY_CLUMP_INSET * (clumpRadius / R)) continue;
      circles.push({ along, across, y: centreHeight, r: clumpRadius, mode: "clustered" });
    }
  }
  // 只在这时候才该按"从里往外"截断（数量远超上限的极端参数才会走到），一般树冠都取不满
  circles.sort((a, b) => Math.hypot(a.along / alongLimit, a.across / acrossLimit)
    - Math.hypot(b.along / alongLimit, b.across / acrossLimit));
  return circles.slice(0, CANOPY_CLUMP_MAX);
}

/** 物理半影：太阳不是点光源，障碍越高、半影越宽。 */
function penumbraFor(heightAboveGround, sinElev) {
  return Math.min(0.14, Math.max(0.05, 0.04 + (2 * SUN_ANGULAR_RADIUS * heightAboveGround) / sinElev));
}

/**
 * 给场景里立着的构件烤一层硬影。
 *
 * @param {THREE.Scene} scene
 * @param {{direction?:THREE.Vector3|null, tint?:THREE.Color|null, y?:number,
 *          ground?:{minX:number,maxX:number,minZ:number,maxZ:number}|null, minTop?:number,
 *          minPlanArea?:number, minShadowArea?:number, minDrawnArea?:number,
 *          cell?:number, maxInstances?:number, name?:string}} options
 *   `direction` 指向太阳、`tint` 是线性乘数（都来自 `setupSky`）；`ground` 是实际铺装范围。
 * @returns {{group:THREE.Group, mesh:THREE.Mesh|null, count:number, candidates:number, kinds:object}}
 */
export function addPropShadows(scene, {
  direction = null,
  tint = null,
  y = 0.008,
  ground = null,
  minTop = 1.2,            // 顶面高过 1.2m 的东西才值得一条看得见的硬影
  minPlanArea = 0.02,      // 占地太小（电缆、道钉）不铺；注意灯杆只有 0.06m²，但影子有 1.3m² —— 拉长的是影子，不是占地
  minShadowArea = 0.05,    // **整块**投影面积小于它就不铺（斑驳前、未裁剪）
  minDrawnArea = 0.02,     // 真正落在铺装上的面积小于它就不铺（影子几乎全在铺装外）
  cell = 1.2,              // 去重网格：同一棵树/同一个机柜的几十个零件只留最大的一片
  maxInstances = 420,
  name = "propShadows",
} = {}) {
  const group = new THREE.Group();
  group.name = name;
  group.userData.noShadow = true;         // 自己不该再被当成"投影片"清点进来

  const frame = direction ? sunShadowFrame(direction) : null;
  if (!frame || !tint) {
    scene.add(group);
    return { group, mesh: null, count: 0, candidates: 0, kinds: {} };
  }
  const sinElev = Math.max(0.05, direction.clone().normalize().y);
  const tintLinear = [tint.r, tint.g, tint.b];

  const { candidates } = collectStanding(scene, {
    minHeight: 0.15,
    minTop,
    minFootprint: 0.08,
    maxGroundClearance: 12,     // 吊在空中的（门架横梁、设备悬臂）也要——它们的影子落在地上
    minSlenderness: 0,          // 又长又矮的也要（横梁、防撞墙）
    maxTop: 20,
    y,
  });

  const prepared = [];
  // 在每个门上分开记账（还要按几何类型分）：数目对不上时必须能直接看出是哪一门、哪一类掉的
  const dropped = { blocked: 0, plan: 0, tiny: 0, clip: 0, dedupe: 0 };
  const byKind = {};
  const note = (gate, kind) => {
    dropped[gate] += 1;
    byKind[kind] = byKind[kind] || { blocked: 0, plan: 0, tiny: 0, clip: 0, dedupe: 0 };
    byKind[kind][gate] += 1;
  };
  candidates.forEach((item) => {
    // 动的东西不烤：栏杆臂（index 叫 barrierArm、lanes 叫 barrierPivot）每帧在转，
    // 烤一条死影子必然对不上，比没有影子更假。
    if (/barrierArm|barrierPivot/i.test(String(item.label || ""))) {
      note("blocked", item.kind);
      return;
    }
    if (item.footprint[0] * item.footprint[1] < minPlanArea) {
      note("plan", item.kind);
      return;
    }
    const projected = projectRings(item, frame, sinElev);
    // 每个环单独裁：树冠是一簇簇，越界的只是外圈那几簇
    const rings = [];
    let drawn = 0;
    projected.rings.forEach((ring) => {
      const clipped = clipToRect(ring.points, ground);
      if (clipped.length < 3) return;
      const ringArea = polygonArea(clipped);
      if (ringArea < 1e-4) return;          // 只丢数值退化的碎片（1cm²），不丢"小但真在铺装上的"影子
      drawn += ringArea;
      rings.push({ points: clipped, penumbra: ring.penumbra, clump: ring.clump });
    });
    // 两道门分开量：**整块投影**（斑驳前、未裁剪）说明"这个构件的影子本身够不够大"，
    // **画出来的面积**说明"到底有多少真的落在铺装上"。树冠斑驳后只剩一半面积，
    // 用画出来的面积当第一道门会把大树的影子当成小灌木丢掉。
    if (projected.projected < minShadowArea) {
      note("tiny", item.kind);
      return;
    }
    if (drawn < minDrawnArea) {
      note("clip", item.kind);              // 影子几乎全在铺装外
      return;
    }
    prepared.push({
      ...item,
      rings,
      clipped: drawn < projected.projected - 1e-6,
      area: drawn,
      projected: projected.projected,
      ringsTotal: projected.ringsTotal,
      sweep: projected.sweep,
      lift: projected.lift,
      coverage: projected.coverage,
    });
  });

  const deduped = dedupeByCell(prepared, cell, maxInstances, (item) => item.area);
  // 去重也会刷掉东西（同一格只留最大的一片、超过上限截断）：这部分同样要记账，否则数目对不上时查不到
  const kept = new Set(deduped);
  prepared.forEach((item) => { if (!kept.has(item)) note("dedupe", item.kind); });
  if (!deduped.length) {
    scene.add(group);
    return { group, mesh: null, count: 0, candidates: candidates.length, kinds: {} };
  }

  // 树冠（斑驳）与实心构件分成两个 mesh：画法一样，但分开之后自检能把树影单独藏起来量
  const solid = deduped.filter((item) => item.kind !== "sphere");
  const canopy = deduped.filter((item) => item.kind === "sphere");
  const solidMesh = buildMesh(solid, "propShadowMesh", tintLinear, y);
  const canopyMesh = buildMesh(canopy, "propShadowCanopyMesh", tintLinear, y);
  [solidMesh, canopyMesh].forEach((mesh) => { if (mesh) group.add(mesh); });
  if (solidMesh) solidMesh.userData.noShadow = true;
  if (canopyMesh) canopyMesh.userData.noShadow = true;
  const mesh = solidMesh || canopyMesh;

  const kinds = {};
  const byName = {};
  deduped.forEach((item) => {
    kinds[item.kind] = (kinds[item.kind] || 0) + 1;
    const label = String(item.label || "?").replace(/#\d+$/, "");
    byName[label] = (byName[label] || 0) + 1;
  });
  const round3 = (value) => Math.round(value * 1000) / 1000;
  const stats = {
    count: deduped.length,
    candidates: candidates.length,
    kinds,
    byName,
    vertices: (solidMesh ? solidMesh.userData.vertices : 0) + (canopyMesh ? canopyMesh.userData.vertices : 0),
    area: round2(deduped.reduce((sum, item) => sum + item.area, 0)),
    // 树冠斑驳度：Σ(每簇影子面积) ÷ 整块椭圆面积。1 = 实心黑斑，越小事光斑越多。
    // 只统计**真的拆成簇**的树冠：小灌木按半影尺度本来就是一整块（不是没做斑驳，是做了会假）。
    dapple: {
      canopyItems: canopy.length,
      clumps: canopy.reduce((sum, item) => sum + item.ringsTotal, 0),
      clumpsDrawn: canopy.reduce((sum, item) => sum + item.rings.length, 0),
      clusteredCanopies: canopy.filter((item) => item.coverage < 0.999).length,
      solidCanopies: canopy.filter((item) => item.coverage >= 0.999).length,
      coverage: canopy.some((item) => item.coverage < 0.999)
        ? Math.round((canopy.filter((item) => item.coverage < 0.999)
          .reduce((sum, item) => sum + item.coverage, 0)
          / canopy.filter((item) => item.coverage < 0.999).length) * 1000) / 1000
        : 0,
      area: round2(canopy.reduce((sum, item) => sum + item.area, 0)),
    },
    // 每棵树的斑驳决策（供自检独立复算：冠幅 < 3×半影 的就该是整块）
    canopyModes: canopy.map((item) => ({
      label: item.label,
      radius: round2(item.radius),
      // 判据本身的两个输入也报出去（同一份取整值），自检用它们复算，避免各算各的、边界上对不齐
      canopyR: round3(item.radius * CANOPY_SPAN),
      penumbra: round3(penumbraFor((item.base + item.top) / 2, sinElev)),
      dappleMin: CANOPY_DAPPLE_MIN,
      top: round2(item.top),
      mode: item.coverage >= 0.999 ? "solid" : "clustered",
      rings: item.ringsTotal,          // 斑驳后的簇数（裁剪前，几何事实）
      ringsDrawn: item.rings.length,   // 其中真的落在铺装上的簇数
      coverage: round3(item.coverage),
      area: round2(item.area),
    })),
    solidCount: solid.length,
    canopyCount: canopy.length,
    // 被刷掉的候选都记一笔（按门、按几何类型）：数目对不上时要能看出是在哪一道门上掉的
    dropped: Object.assign({}, dropped, { byKind }),
    // 自检用：影长/偏移/半影是不是按太阳高度角与构件高度算的（含"吊在空中"的横梁）
    samples: deduped
    .slice()
    .sort((a, b) => b.area - a.area)
    .slice(0, 12)
    .map((item) => ({
      x: round2(item.x),
      z: round2(item.z),
      label: item.label,
      kind: item.kind,
      height: round2(item.top - item.base),
      base: round2(item.base),
      top: round2(item.top),
      grounded: item.grounded,
      sweep: round2(item.sweep),
      expectedSweep: round3(frame.cot * (item.top - item.base)),
      lift: round2(item.lift),
      expectedLift: round3(frame.cot * item.base),
      penumbra: round2(Math.max(...item.rings.map((ring) => ring.penumbra))),
      area: round2(item.area),
      rings: item.rings.length,
      coverage: item.kind === "sphere" ? round3(item.coverage) : 1,
      footprint: item.footprint,
      // 影子中心 = 构件位置沿影子方向偏移 cot × 重心高度。用**解析值**算，不用轮廓重心：
      // 裁到铺装范围内会把轮廓重心带偏，那是裁剪的副作用，不是投影算错。
      centre: [
        round2(item.x + frame.x * frame.cot * ((item.base + item.top) / 2)),
        round2(item.z + frame.z * frame.cot * ((item.base + item.top) / 2)),
      ],
      clipped: item.clipped,
      shadowDir: [round3(frame.x), round3(frame.z)],
    })),
    // 树冠簇样本：每簇影子中心要落在"簇心 + 影长方向 × cot×簇高"，且两两不相交（叠加会压两次）
    clumpExamples: canopy
      .filter((item) => item.coverage < 0.999)
      .sort((a, b) => b.area - a.area)
      .slice(0, 4)
      .map((item) => ({
        label: item.label,
        mode: "clustered",
        x: round2(item.x),
        z: round2(item.z),
        radius: round2(item.radius),
        canopyBase: round2(item.base),
        canopyTop: round2(item.top),
        cot: round3(frame.cot),
        sinElev: round3(sinElev),
        coverage: round3(item.coverage),
        clumps: item.rings
          .map((ring) => ring.clump)
          .filter(Boolean)
          .map((clump) => ({
            along: round3(clump.along),
            across: round3(clump.across),
            y: round3(clump.y),
            r: round3(clump.r),
            centre: [
              round2(item.x + frame.x * (clump.along + frame.cot * clump.y)),
              round2(item.z + frame.z * (clump.along + frame.cot * clump.y)),
            ],
          })),
      })),
    shadow: {
      direction: [direction.x, direction.y, direction.z].map(round3),
      shadowDir: [round3(frame.x), round3(frame.z)],
      cotElevation: round3(frame.cot),
      azimuthDeg: frame.azimuthDeg,
      tint: tintLinear.map(round3),
      ground: ground ? [ground.minX, ground.maxX, ground.minZ, ground.maxZ] : null,
    },
  };
  [solidMesh, canopyMesh].forEach((target) => {
    if (target) Object.assign(target.userData, stats);
  });
  if (solidMesh) solidMesh.userData.part = "solid";
  if (canopyMesh) canopyMesh.userData.part = "canopy";

  group.add(mesh);
  scene.add(group);
  return { group, mesh, solidMesh, canopyMesh, count: deduped.length, candidates: candidates.length, kinds, byName };
}

/** 把一批构件的贴地多边形合并成一个 mesh（同一份材质，只多 1 个 draw call）。 */
function buildMesh(items, name, tint, y) {
  if (!items.length) return null;
  const positions = [];
  const colours = [];
  const indices = [];
  items.forEach((item) => {
    item.rings.forEach((ring) => pushRing(ring.points, ring.penumbra, tint, y, positions, colours, indices));
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colours, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  geometry.userData.propShadow = true;   // 重建时要能认出这是自建几何、该 dispose

  const mesh = new THREE.Mesh(geometry, decalMaterial());
  mesh.name = name;
  mesh.renderOrder = 2;                   // 地面之后（与接地暗部同为乘法混合，先后不影响结果）
  mesh.userData.vertices = positions.length / 3;
  // 分开记一份：userData.vertices 之后会被总统计覆盖，半边的顶点数要单独留着（自检用）
  mesh.userData.partVertices = positions.length / 3;
  mesh.userData.noShadow = true;
  return mesh;
}

/**
 * 一个环的贴地多边形：影核轮廓 + 两圈向外扩张的半影环，顶点色从乘数渐变到白。
 * 真实半影只有 6~9cm，两圈足够；乘法混合下"白"就是完全不变，所以边界能干净收回。
 */
function outlineCentre(outline) {
  let cx = 0;
  let cz = 0;
  outline.forEach(([x, z]) => { cx += x; cz += z; });
  return [cx / outline.length, cz / outline.length];
}

function pushRing(outline, penumbra, tint, y, positions, colours, indices) {
  const n = outline.length;
  if (n < 3) return;
  const [cx, cz] = outlineCentre(outline);
  const steps = 2;
  const base = positions.length / 3;
  for (let s = 0; s <= steps; s += 1) {
    const t = s / steps;
    const colour = [
      tint[0] + (1 - tint[0]) * t,
      tint[1] + (1 - tint[1]) * t,
      tint[2] + (1 - tint[2]) * t,
    ];
    outline.forEach(([x, z]) => {
      const dx = x - cx;
      const dz = z - cz;
      const len = Math.hypot(dx, dz) || 1;
      positions.push(x + (dx / len) * penumbra * t, y, z + (dz / len) * penumbra * t);
      colours.push(colour[0], colour[1], colour[2]);
    });
  }
  for (let s = 0; s < steps; s += 1) {
    for (let i = 0; i < n; i += 1) {
      const a = base + s * n + i;
      const b = base + s * n + ((i + 1) % n);
      const c = base + (s + 1) * n + ((i + 1) % n);
      const d = base + (s + 1) * n + i;
      indices.push(a, b, c, a, c, d);
    }
  }
}

/** 硬影材质：乘法混合、不写深度、不吃雾不吃色调映射。全局一份。 */
function decalMaterial() {
  if (!MATERIAL_CACHE.has("propShadow")) {
    MATERIAL_CACHE.set("propShadow", new THREE.MeshBasicMaterial({
      vertexColors: true,
      blending: THREE.MultiplyBlending,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
      fog: false,
      toneMapped: false,
    }));
  }
  return MATERIAL_CACHE.get("propShadow");
}
