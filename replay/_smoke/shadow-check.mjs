/**
 * 浏览器外的阴影几何冒烟台：直接跑 prop-shadows / contact-ao 的几何，抓"只有运行到才会炸"的错。
 *
 * 用法（在 replay/ 下）：
 *   python _smoketool.py _smoke/shadow-check.mjs && node _smoke/shadow-check.mjs
 *
 * 这里放断言而不是只打印：几何是解析算的，算错了不该等到开浏览器才发现。
 */
import * as THREE from "./vendor/three/build/three.module.mjs";
import { sunDirection, sunShadowFrame } from "./scene-look.mjs";
import { collectStanding, addContactAO } from "./contact-ao.mjs";
import { addPropShadows } from "./prop-shadows.mjs";

// 浏览器外的 canvas 替身：只为让接触暗部的贴图生成跑通（要测的是几何/矩阵那部分）
const fakeCanvas = { width: 0, height: 0, style: {}, getContext: () => fakeContext };
const fakeContext = new Proxy({}, {
  get: (target, key) => {
    if (key === "createRadialGradient" || key === "createLinearGradient") return () => ({ addColorStop() {} });
    if (key === "getImageData") return () => ({ data: new Uint8ClampedArray(4) });
    if (key === "canvas") return fakeCanvas;
    return () => undefined;
  },
});
globalThis.document = { createElement: () => fakeCanvas };

const failures = [];
function check(ok, what, detail = "") {
  if (!ok) failures.push(`${what}${detail ? " -> " + detail : ""}`);
  console.log(`${ok ? "  ok " : "  !! "}${what}${detail ? "  " + detail : ""}`);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const scene = new THREE.Scene();
const cabinet = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.2, 0.8), new THREE.MeshBasicMaterial());
cabinet.position.set(3, 1.1, -5);
cabinet.name = "cabinet";
scene.add(cabinet);
const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 9, 12), new THREE.MeshBasicMaterial());
pole.position.set(-4, 4.5, 6);
pole.name = "lampPost";
scene.add(pole);
const beam = new THREE.Mesh(new THREE.BoxGeometry(14, 0.5, 0.5), new THREE.MeshBasicMaterial());
beam.position.set(0, 6.2, 0);
beam.name = "gantryBeam";
scene.add(beam);
const trees = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(2.2, 1), new THREE.MeshBasicMaterial(), 2);
const m = new THREE.Matrix4();
[0, 12].forEach((z, i) => { m.makeTranslation(20, 3.1, z); trees.setMatrixAt(i, m); });
trees.instanceMatrix.needsUpdate = true;
trees.name = "trees";
scene.add(trees);
// 广场外的"行道树"：影子必须被裁掉（否则悬在雾里）
const outside = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 8, 10), new THREE.MeshBasicMaterial());
outside.position.set(40, 4, 0);
outside.name = "outsideTree";
scene.add(outside);
// 小灌木（冠幅还没半影宽）：不该被拆成簇 —— 叶缝在这个尺度上被半影糊掉了，真影子就是一整块
const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(0.2, 1), new THREE.MeshBasicMaterial());
bush.position.set(-14, 1.2, -20);
bush.name = "bushes";
scene.add(bush);
// 每帧在转的栏杆臂：应当被排除
const pivot = new THREE.Group();
pivot.name = "barrierPivot";
const arm = new THREE.Mesh(new THREE.BoxGeometry(4, 0.12, 0.12), new THREE.MeshBasicMaterial());
arm.position.set(2, 1.2, 0);
pivot.add(arm);
scene.add(pivot);

const direction = sunDirection(118, 58);
const frame = sunShadowFrame(direction);
console.log(`frame cot=${frame.cot.toFixed(4)} dir=(${frame.x.toFixed(3)}, ${frame.z.toFixed(3)})`);

const standing = collectStanding(scene, { minTop: 1.2, minSlenderness: 0, maxGroundClearance: 12 });
check(standing.candidates.length >= 6, "collectStanding 至少找到 6 个构件", `实际 ${standing.candidates.length}`);

const result = addPropShadows(scene, {
  direction,
  tint: new THREE.Color(0.168, 0.254, 0.382),
  ground: { minX: -32, maxX: 32, minZ: -48, maxZ: 48 },
});
const data = (result.mesh && result.mesh.userData) || {};
check(result.count > 0, "硬影层建出来了", `实例 ${result.count} / 候选 ${result.candidates}`);
check(!result.byName.barrierPivot, "转动的栏杆臂被排除", JSON.stringify(result.byName));
check(!result.byName.outsideTree, "铺装外的树影被裁掉", JSON.stringify(result.byName));

// 逐样本核对解析投影公式（实心那一半：方盒/圆柱）
(result.solidMesh ? result.solidMesh.userData.samples : data.samples || []).forEach((s) => {
  check(near(s.sweep, s.expectedSweep, 0.02), `影长 = cot × 高度（${s.label}）`, `${s.sweep} vs ${s.expectedSweep}`);
  check(near(s.lift, s.expectedLift, 0.02), `偏移 = cot × 离地（${s.label}）`, `${s.lift} vs ${s.expectedLift}`);
  const wantX = s.x + frame.x * frame.cot * ((s.base + s.top) / 2);
  const wantZ = s.z + frame.z * frame.cot * ((s.base + s.top) / 2);
  check(near(s.centre[0], wantX, 0.02) && near(s.centre[1], wantZ, 0.02),
        `影子中心落在背光侧（${s.label}）`, `${s.centre} vs [${wantX.toFixed(2)}, ${wantZ.toFixed(2)}]`);
});

// 树冠：簇数、斑驳度、每簇中心、两两不相交
const canopyData = result.canopyMesh ? result.canopyMesh.userData : data;
console.log(`树冠：${canopyData.dapple.canopyItems} 棵 / ${canopyData.dapple.clumps} 簇 / 覆盖率 ${canopyData.dapple.coverage}`);
const modes = canopyData.canopyModes || [];
const bushMode = modes.find((item) => item.label === "bushes");
check(!!bushMode && bushMode.mode === "solid",
      "小灌木不拆簇（冠幅 < 3×半影，叶缝被半影糊掉，本来就该一整块）",
      bushMode ? `${bushMode.mode} / 冠幅 ${bushMode.radius} / 半影 ${bushMode.penumbra}` : "没找到 bushes");
modes.filter((item) => item.mode === "clustered").forEach((item) => {
  check(item.rings >= 3 && item.radius * 0.74 >= 3 * item.penumbra,
        `大树冠才拆簇，且至少 3 簇（${item.label}）`,
        `${item.rings} 簇 / 冠幅 ${item.radius} / 半影 ${item.penumbra}`);
});
check(canopyData.dapple.canopyItems >= 2, "树冠被识别为球（斑驳处理）", `${canopyData.dapple.canopyItems} 棵`);
check(canopyData.dapple.coverage > 0.3 && canopyData.dapple.coverage < 0.8,
      "斑驳度在「有光斑但不稀」的区间", `${canopyData.dapple.coverage}`);
(canopyData.clumpExamples || []).forEach((tree) => {
  check(tree.clumps.length >= 3, `每棵树的簇数足够（${tree.label}）`, `${tree.clumps.length} 簇`);
  let inside = true;
  tree.clumps.forEach((clump) => {
    const wantX = tree.x + frame.x * (clump.along + frame.cot * clump.y);
    const wantZ = tree.z + frame.z * (clump.along + frame.cot * clump.y);
    if (!(near(clump.centre[0], wantX, 0.02) && near(clump.centre[1], wantZ, 0.02))) {
      inside = false;
      check(false, `簇影中心 = 簇心投影（${tree.label}）`, `${clump.centre} vs [${wantX.toFixed(2)}, ${wantZ.toFixed(2)}]`);
    }
    const centre = Math.hypot(clump.along, clump.across);
    const outer = centre + clump.r;
    if (centre > tree.radius + 0.01 || outer > tree.radius * 1.2 + 0.01) {
      inside = false;
      check(false, `簇心在树冠球内、簇团最多探出 20%（${tree.label}）`,
            `簇心 ${centre.toFixed(2)} / 外缘 ${outer.toFixed(2)} vs 冠半径 ${tree.radius}`);
    }
  });
  if (inside) check(true, `每簇都落在树冠球内、且影子中心按公式（${tree.label}，${tree.clumps.length} 簇）`);
  let disjoint = true;
  for (let i = 0; i < tree.clumps.length && disjoint; i += 1) {
    for (let j = i + 1; j < tree.clumps.length; j += 1) {
      const a = tree.clumps[i];
      const b = tree.clumps[j];
      // 两个椭圆不相交的**充分**条件：按影子坐标轴分开
      const apart = Math.abs(a.along - b.along) >= (a.r + b.r) / tree.sinElev - 1e-6
        || Math.abs(a.across - b.across) >= a.r + b.r - 1e-6;
      if (!apart) {
        disjoint = false;
        check(false, `簇影两两不相交（${tree.label} #${i}/#${j}）`,
              `dAlong=${Math.abs(a.along - b.along).toFixed(2)} dAcross=${Math.abs(a.across - b.across).toFixed(2)} r=${a.r}`);
        break;
      }
    }
  }
  if (disjoint) check(true, `簇影两两不相交（${tree.label}，${tree.clumps.length} 簇）`);
});

// 接地暗部：这一步专门抓"删了局部变量、但后面还在用"这类运行到才炸的错
const ao = addContactAO(scene, { direction });
check(ao.count > 0, "接触暗部建出来了", `实例 ${ao.count} / 候选 ${ao.candidates}`);
check(ao.mesh && ao.mesh.instanceMatrix.array.length === ao.count * 16, "接触暗部实例矩阵可读",
      `${ao.mesh ? ao.mesh.instanceMatrix.array.length : 0}`);

console.log(failures.length ? `\n${failures.length} 项没过：\n- ` + failures.join("\n- ") : "\n全部通过");
process.exit(failures.length ? 1 : 0);
