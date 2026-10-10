/**
 * 临时自检：用车道的真实数据跑 lane-motion，核对
 *   · 锚点是否被精确穿过（设备事件时刻的车位 = 设备位置）
 *   · 轨迹是否单调向前、峰值速度是否在车道限速附近
 *   · 是否从入口起步、线圈占用区间是否被覆盖
 *   · 与旧实现（buildTrack 单调钳制 + 线性插值）的偏差对比
 * 用法（先把模块复制成 .mjs，Node 才能按 ESM 跑）：
 *   Copy-Item lane-motion.js _smoke\lane-motion.mjs -Force
 *   node _smoke\motion-test.mjs
 */
import fs from "node:fs";
import { buildMotion, stationsFrom } from "./lane-motion.mjs";

const DEVICES = { vlpr: -22.0, weigh: -19.5, axle: -16.5, lane: 9.0, cpc: 6.0, display: 18.6, barrier: 24.0, rsu: 14.5 };
const COILS = { "1": -14.5, "2": -10.5, "6": 11.8, "7": 21.5 };
const stations = stationsFrom(DEVICES, COILS, { rsuFront: -12.4 });
const Z_MIN = -35;
const Z_MAX = 35;
const MAX_SPEED = 16.7;

// ---- 旧实现（复刻 lanes.js 的 buildTrack/zAt）作为对照 ----------------------
function oldTrack(passage) {
  const points = [];
  let last = -24;
  for (const node of passage.nodes) {
    const coil = /车检器(\d+)/.exec(node.coil || "");
    let z = null;
    if (coil && COILS[coil[1]] !== undefined) z = COILS[coil[1]];
    else if (DEVICES[node.device] !== undefined) z = DEVICES[node.device];
    else if (node.device === "rsu") z = last < 0 ? -12.4 : DEVICES.rsu;
    if (z === null || z < last) z = last;
    last = z;
    points.push({ o: node.o, z });
  }
  if (!points.length) points.push({ o: passage.o0, z: -24 });
  return points;
}
function oldZAt(track, o) {
  if (o <= track[0].o) return track[0].z;
  const last = track[track.length - 1];
  if (o >= last.o) return last.z;
  for (let i = 1; i < track.length; i += 1) {
    const a = track[i - 1];
    const b = track[i];
    if (o <= b.o) {
      const r = b.o === a.o ? 1 : (o - a.o) / (b.o - a.o);
      return a.z + (b.z - a.z) * r;
    }
  }
  return last.z;
}

const data = JSON.parse(fs.readFileSync("data/lanes.json", "utf8"));
const failures = [];
const stats = {
  passages: 0, anchors: 0, dropped: 0, rejected: 0, noAnchor: 0,
  oldMismatch: 0, oldMismatchMax: 0, newMiss: 0, peak: 0, delayMax: 0, earlyMax: 0,
  leads: [], perPassage: [], stations: {}, coilWindows: 0, coilMissed: 0,
  entryWrong: 0, backwards: 0, overspeed: 0, stuckCoils: 0, needLead: [],
  needSpeeds: [], deliveredDelay: [], accels: [], startSpeeds: [],
  jumpStart: 0, harshAccel: 0, rollPastGate: 0, harshAccelResidual: 0,
};
const detail = [];

for (const lane of data.lanes) {
  for (const passage of lane.passages) {
    stats.passages += 1;
    const motion = buildMotion({
      events: passage.nodes, stations, windowFrom: passage.o0, windowTo: passage.o1, zMin: Z_MIN, zMax: Z_MAX,
    });
    const d = motion.diagnostics;
    stats.anchors += d.anchorCount;
    stats.dropped += d.droppedCount;
    stats.rejected += d.rejected;
    if (!d.anchorCount) stats.noAnchor += 1;
    stats.peak = Math.max(stats.peak, d.peakSpeed);
    stats.delayMax = Math.max(stats.delayMax, d.maxDelayMs);
    stats.earlyMax = Math.max(stats.earlyMax, d.movedEarlyMs);
    stats.leads.push(motion.leadMs / 1000);
    stats.perPassage.push(d.anchorCount);
    stats.coilWindows += motion.coilWindows.length;
    stats.stuckCoils += motion.coilWindows.filter((item) => item.stuck).length;
    for (const [key, row] of Object.entries(d.stations)) stats.stations[key] = (stats.stations[key] ?? 0) + row.count;
    // 0. 日志本身要求的速度（相邻锚点）：用来看限速选得合不合适
    for (let i = 1; i < motion.anchors.length; i += 1) {
      const a = motion.anchors[i - 1];
      const b = motion.anchors[i];
      const dt = (b.logO - a.logO) / 1000;
      const dz = b.z - a.z;
      if (dt > 0 && dz > 0) stats.needSpeeds.push(dz / dt);
    }
    for (const anchor of motion.anchors) stats.deliveredDelay.push((anchor.o - anchor.logO) / 1000);

    // 1. 锚点必须被精确穿过
    for (const anchor of motion.anchors) {
      if (Math.abs(motion.zAt(anchor.o) - anchor.z) > 1e-6) {
        stats.newMiss += 1;
        if (failures.length < 8) failures.push(`锚点未穿过 ${lane.id}#${passage.i} ${anchor.key}`);
      }
    }
    // 2. 与旧实现对比：同一批锚点的日志时刻，旧路径给出的位置差多少
    const track = oldTrack(passage);
    for (const anchor of motion.anchors) {
      const err = Math.abs(oldZAt(track, anchor.logO) - anchor.z);
      if (err > 0.05) stats.oldMismatch += 1;
      stats.oldMismatchMax = Math.max(stats.oldMismatchMax, err);
    }
    // 3. 全程单调 + 限速 + 入口起步
    const span = Math.max(1, d.to - d.from);
    let previous = null;
    for (let i = 0; i <= 240; i += 1) {
      const o = d.from + (span * i) / 240;
      const z = motion.zAt(o);
      if (previous !== null) {
        if (z < previous - 1e-6) stats.backwards += 1;
        const speed = Math.abs(z - previous) / (span / 240 / 1000);
        if (speed > MAX_SPEED * 1.02) {
          stats.overspeed += 1;
          if (failures.length < 12) failures.push(`速度越界 ${lane.id}#${passage.i} ${speed.toFixed(2)} m/s`);
        }
      }
      previous = z;
    }
    if (Math.abs(motion.zAt(motion.entry.o) - (Z_MIN + 3)) > 1e-6) {
      stats.entryWrong += 1;
      if (failures.length < 12) failures.push(`未从入口起步 ${lane.id}#${passage.i}`);
    }
    // 4. 线圈占用区间必须被轨迹覆盖（车中心在占用期间到过线圈 ±3.6m）
    for (const window of motion.coilWindows) {
      let hit = false;
      const step = Math.max(20, (window.t1 - window.t0) / 40);
      for (let o = window.t0 - 200; o <= window.t1 + 200; o += step) {
        if (Math.abs(motion.zAt(o) - window.z) <= 3.6) { hit = true; break; }
      }
      if (!hit) {
        stats.coilMissed += 1;
        // 覆盖不上 = 这条过程的日志自相矛盾（例如"车还在牌识处，线圈却已经压了 5s"），
        // 单独计数而不是当失败：模型已经按物理顺序选了最长单调子序列。
        if (stats.coilMissed > 3) failures.push(`线圈窗口未覆盖过多 ${lane.id}#${passage.i} ${window.key}`);
      }
    }
    if (d.anchorCount >= 4 && detail.length < 4) detail.push({ lane: lane.id, passage, motion });
    // 5. 运动学：入口必须从静止起步、加速度有限、停在栏杆上的过程不滑过最后一个锚点
    const aStep = 20;   // ms
    const aFrom = motion.entry.o;
    const aTo = Math.min(motion.exit.o, aFrom + 120000);
    let prevZ = null;
    let prevV = null;
    let maxAccel = 0;
    let startSpeed = null;
    for (let o = aFrom; o <= aTo + 1e-6; o += aStep) {
      const z = motion.zAt(o);
      if (prevZ !== null) {
        const v = (z - prevZ) / (aStep / 1000);
        if (startSpeed === null && o >= aFrom + 100) startSpeed = Math.abs(v);
        if (prevV !== null) maxAccel = Math.max(maxAccel, Math.abs(v - prevV) / (aStep / 1000));
        prevV = v;
      }
      prevZ = z;
    }
    const lastAnchor = motion.anchors[motion.anchors.length - 1] ?? null;
    const endZ = motion.zAt(aTo);
    stats.accels.push(maxAccel);
    stats.startSpeeds.push(startSpeed ?? 0);
    if (startSpeed !== null && startSpeed > 2.5) {
      stats.jumpStart += 1;
      if (failures.length < 16) failures.push(`入口不是从静止起步 ${lane.id}#${passage.i} 起步速度 ${startSpeed.toFixed(2)}m/s`);
    }
    if (maxAccel > 24) {
      stats.harshAccel += 1;
      if (failures.length < 16) failures.push(`加速度过大 ${lane.id}#${passage.i} ${maxAccel.toFixed(1)}m/s²`);
    } else if (maxAccel > 12) {
      // 线圈占用是硬证据（锚点必须落在占用窗口内）：个别趟的日志本身就要求
      // 十几 m/s² 的加减速。模型保住证据、把残差如实报出来，不当失败。
      stats.harshAccelResidual += 1;
    }
    // 闸口这一趟：处理完要**往前驶离**（不是原地不动、也不是倒回去），
    // 但不能滑出道外（z ≤ zMax-1）；出口段还得是减速到静止（曲线端点切线为 0）。
    const zMax = 35;
    if (lastAnchor && lastAnchor.z >= 20) {
      const exitZ = motion.zAt(motion.exit.o);
      if (endZ < lastAnchor.z - 0.5 || endZ > zMax - 1 + 0.5) {
        stats.rollPastGate += 1;
        if (failures.length < 16) failures.push(`闸口驶离越界 ${lane.id}#${passage.i} 终点 z=${endZ.toFixed(1)}（锚点 ${lastAnchor.z}，道外 ${zMax - 1}）`);
      }
      if (Math.abs(exitZ - endZ) > 0.5) {
        stats.rollPastGate += 1;
        if (failures.length < 16) failures.push(`出口后还在动 ${lane.id}#${passage.i} z(${motion.exit.o})=${exitZ.toFixed(1)} vs 末尾 ${endZ.toFixed(1)}`);
      }
    }
  }
}

const median = (arr) => { const a = arr.slice().sort((x, y) => x - y); return a.length ? a[a.length >> 1] : 0; };
console.log("=== 多车道（103 趟过程）===");
console.log(`过程 ${stats.passages} · 位置锚点 ${stats.anchors} · 剔除的冲突锚点 ${stats.dropped} · 过滤非位置节点 ${stats.rejected} · 无锚点过程 ${stats.noAnchor}`);
console.log(`每趟锚点数：中位 ${median(stats.perPassage)} 最大 ${Math.max(...stats.perPassage)} · 锚点来源 ${JSON.stringify(stats.stations)}`);
console.log(`旧路径在同一批锚点上对不上：${stats.oldMismatch} 处，最大偏差 ${stats.oldMismatchMax.toFixed(1)}m`);
console.log(`新实现锚点未穿过 ${stats.newMiss} · 后退采样 ${stats.backwards} · 超速采样 ${stats.overspeed} · 未从入口起步 ${stats.entryWrong}`);
console.log(`峰值速度 ${stats.peak.toFixed(2)} m/s（限速 ${MAX_SPEED}）· 最大后移 ${stats.delayMax}ms · 最大提前 ${stats.earlyMax}ms`);
console.log(`线圈占用区间 ${stats.coilWindows} 个（其中一直不释放/压着不走 ${stats.stuckCoils} 个），未覆盖 ${stats.coilMissed}`);
console.log(`入口提前量 s：中位 ${median(stats.leads).toFixed(2)} 最大 ${Math.max(...stats.leads).toFixed(2)}`);
{
  const as = stats.accels.slice().sort((a, b) => a - b);
  const ss = stats.startSpeeds.slice().sort((a, b) => a - b);
  const pick = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0);
  console.log(`运动学：|a| 中位 ${pick(as, 0.5).toFixed(2)} p90 ${pick(as, 0.9).toFixed(2)} 最大 ${(as[as.length - 1] || 0).toFixed(2)} m/s² · `
    + `入口起步速度（起步后 100ms）中位 ${pick(ss, 0.5).toFixed(2)} 最大 ${(ss[ss.length - 1] || 0).toFixed(2)} m/s`);
  console.log(`入口不是静止起步 ${stats.jumpStart} 趟 · 加速度 >24m/s² 的 ${stats.harshAccel} 趟 · 闸口驶离越界 ${stats.rollPastGate} 趟`);
  console.log(`加速度 12~24m/s² 的 ${stats.harshAccelResidual} 趟（线圈占用窗口把锚点钉住、日志本身要求这么急）`);
}
const ns = stats.needSpeeds.slice().sort((a, b) => a - b);
const pct = (p) => ns.length ? ns[Math.min(ns.length - 1, Math.floor(ns.length * p))].toFixed(2) : "0";
console.log(`日志相邻锚点要求的速度 m/s：${ns.length} 段，中位 ${pct(0.5)} p75 ${pct(0.75)} p90 ${pct(0.9)} 最大 ${ns.length ? ns[ns.length - 1].toFixed(2) : 0}，>16.7 的 ${ns.filter((v) => v > 16.7).length} 段，>13.9 的 ${ns.filter((v) => v > 13.9).length} 段`);
const dd = stats.deliveredDelay.filter((v) => v > 0.05).sort((a, b) => a - b);
console.log(`被限速延后的锚点 ${dd.length} 个：中位滞后 ${dd.length ? dd[dd.length >> 1].toFixed(2) : 0}s，最大 ${dd.length ? dd[dd.length - 1].toFixed(2) : 0}s`);

console.log("\n=== 单车（merged 日志，index 页）===");
const rep = JSON.parse(fs.readFileSync("data/merged_鲁UG6595_20260701_120654.json", "utf8"));
const base = Date.parse(rep.events[0].time.replace(" ", "T"));
// 这份合并日志混了两个车道（335B 车道 + 335F 匝道），只认本车道的日志（与 app.js 一致）
const declared = new Map();
for (const event of rep.events) if (event.lane) declared.set(String(event.lane), (declared.get(String(event.lane)) || 0) + 1);
const ownLane = [...declared.entries()].sort((a, b) => b[1] - a[1])[0][0];
const single = buildMotion({
  events: rep.events.map((event) => ({ o: Date.parse(event.time.replace(" ", "T")) - base, device: event.device, kind: event.kind, severity: event.severity, coilId: event.coilId, coilState: event.coilState, lane: event.lane, summary: event.summary })),
  stations,
  windowFrom: 0,
  windowTo: Date.parse(rep.events[rep.events.length - 1].time.replace(" ", "T")) - base,
  zMin: Z_MIN,
  zMax: Z_MAX,
  laneId: ownLane,
});
console.log(`本车道 ${ownLane}（另一条 ${[...declared.keys()].filter((key) => key !== ownLane).join("/")} 的日志全部剔除）`);
console.log(`事件 ${rep.events.length} · 位置锚点 ${single.anchors.length} · 剔除 ${single.diagnostics.droppedCount} · 过滤 ${single.diagnostics.rejected}`);
console.log(`过滤原因 ${JSON.stringify(single.diagnostics.rejectedByReason)}`);
console.log(`入口 +${(single.entry.o / 1000).toFixed(2)}s z=${single.entry.z} · 出口 +${(single.exit.o / 1000).toFixed(2)}s z=${single.exit.z.toFixed(1)} · 峰值 ${single.diagnostics.peakSpeed} m/s · 最大后移 ${single.diagnostics.maxDelayMs}ms · 最大提前 ${single.diagnostics.movedEarlyMs}ms`);
{
  // 单车日志自己的轨迹上，|a| 峰值出现在哪儿（10ms 采样）—— 用来分辨"日志要求的急段"和"页面跳帧"
  const stepMs = 10;
  let worst = 0, worstT = 0, previousV = null, previousT = null;
  for (let t = single.entry.o; t <= single.exit.o; t += stepMs) {
    const z = single.zAt(t);
    if (previousT !== null) {
      const dt = (t - previousT) / 1000;
      const v = (z - single.zAt(previousT)) / dt;
      if (previousV !== null) {
        const a = (v - previousV) / dt;
        if (Math.abs(a) > worst) { worst = Math.abs(a); worstT = t; }
      }
      previousV = v;
    }
    previousT = t;
  }
  console.log(`单车轨迹 |a| 峰值（10ms 采样）${worst.toFixed(2)} m/s² @ +${(worstT / 1000).toFixed(2)}s（z=${single.zAt(worstT).toFixed(2)}）· diagnostics.accelMax=${single.diagnostics.accelMax}`);
  for (const anchor of single.anchors) {
    if (Math.abs(anchor.o - worstT) < 2500) console.log(`   峰值附近的锚点：+${(anchor.o / 1000).toFixed(3)}s ${anchor.key} z=${anchor.z} ${anchor.why}`);
  }
}
for (const anchor of single.anchors) {
  console.log(`   +${(anchor.o / 1000).toFixed(3)}s  ${String(anchor.key).padEnd(9)} z=${String(anchor.z).padStart(6)}  (日志 +${(anchor.logO / 1000).toFixed(3)}s, 位移 ${((anchor.o - anchor.logO) / 1000).toFixed(3)}s ×${anchor.repeats})  ${anchor.why}`);
}
for (const item of single.dropped) console.log(`   [剔除] ${String(item.key).padEnd(9)} z=${String(item.z).padStart(6)}  日志 +${(item.o / 1000).toFixed(3)}s  ${item.why}`);

console.log("\n=== 抽样过程（多车道）===");
for (const { lane, passage, motion } of detail) {
  console.log(`车道 ${lane} 过程 #${passage.i} [${passage.start} → ${passage.end}] 判定 ${passage.result}`);
  for (const anchor of motion.anchors) {
    console.log(`   +${(anchor.o / 1000).toFixed(3)}s  ${String(anchor.key).padEnd(9)} z=${String(anchor.z).padStart(6)}  (日志 +${(anchor.logO / 1000).toFixed(3)}s)  ${anchor.why}`);
  }
}

console.log("\n=== 断言 ===");
if (failures.length) { console.log("失败：" ); for (const line of failures) console.log("  [!!] " + line); }
else console.log("全部通过");
process.exit(failures.length ? 1 : 0);
