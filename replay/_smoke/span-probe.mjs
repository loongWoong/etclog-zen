/**
 * 自检：多车道页"每趟车的可见区间"（buildSpans 的车辆部分）——
 * 复刻 lanes.js 的算法，逐趟核对：
 *   · 车一定从入口起步（起点 z ≈ 入口），不会"凭空出现在线圈6/闸机上"
 *   · 可见区间够长（不是闪一帧就没了）、也不会与前一趟重叠（前车没走就在入口等）
 *   · 车在自己的区间里把这一趟走完并驶离（终点 = 出口，且在可行驶区里）
 * 用法：python _smoketool.py _smoke/span-probe.mjs && node _smoke/span-probe.mjs
 */
import fs from "node:fs";
import { buildMotion, stationsFrom } from "./lane-motion.mjs";

const DEVICES = { vlpr: -22.0, weigh: -19.5, axle: -16.5, lane: 9.0, cpc: 6.0, display: 18.6, barrier: 24.0, rsu: 14.5 };
const COILS = { "1": -14.5, "2": -10.5, "6": 11.8, "7": 21.5 };
const stations = stationsFrom(DEVICES, COILS, { rsuFront: -12.4 });
const Z_MIN = -35;
const Z_MAX = 35;
const ENTRY_Z = Z_MIN + 3;
const ENTRY_TOL = 0.5;

const data = JSON.parse(fs.readFileSync("data/lanes.json", "utf8"));
const offset = data.window.offsetMs;

const rows = [];
const overlaps = [];
for (const lane of data.lanes) {
  const rel = lane.passages.map((passage) => ({ passage, o0: passage.o0 - offset, o1: passage.o1 - offset }));
  const motions = new Map();
  for (const entry of rel) {
    motions.set(entry.passage.i, buildMotion({
      events: entry.passage.nodes, stations, windowFrom: entry.passage.o0, windowTo: entry.passage.o1,
      zMin: Z_MIN, zMax: Z_MAX,
    }));
  }
  let previousCarTo = 0;
  let previousMotion = null;
  let previousNaturalTo = 0;
  let previousNaturalFrom = 0;
  let previousPassage = null;
  for (const entry of rel) {
    const motion = motions.get(entry.passage.i);
    const driveable = Boolean(motion && motion.hasEvidence);
    if (!driveable) continue;
    const naturalFrom = Math.max(0, entry.o0 - motion.leadMs);
    const naturalTo = motion.exit.o - offset;
    if (previousMotion) {
      overlaps.push({
        lane: lane.id, passage: entry.passage.i, prevPassage: previousPassage,
        overlapMs: Math.round(previousNaturalTo - naturalFrom),
        prevZ: Math.round(previousMotion.zAt(naturalFrom + offset) * 1000) / 1000,
        prevSpanMs: Math.round(previousNaturalTo - previousNaturalFrom),
      });
    }
    const carFrom = Math.max(previousCarTo, naturalFrom);
    const queueMs = Math.max(0, carFrom - naturalFrom);
    const carTo = Math.max(carFrom + 1, naturalTo + queueMs);
    previousCarTo = carTo;
    previousMotion = motion;
    previousNaturalTo = naturalTo;
    previousNaturalFrom = naturalFrom;
    previousPassage = entry.passage.i;
    const evalAt = (t) => motion.zAt(t + offset - queueMs);
    const last = motion.anchors[motion.anchors.length - 1] ?? null;
    // 逐 25ms 采样这一段，核对单调前进
    let previousZ = evalAt(carFrom);
    let backs = 0;
    for (let t = carFrom + 25; t <= carTo; t += 25) {
      const z = evalAt(t);
      if (z < previousZ - 1e-6) backs += 1;
      previousZ = z;
    }
    rows.push({
      lane: lane.id, passage: entry.passage.i,
      carFrom: Math.round(carFrom), carTo: Math.round(carTo),
      queueMs: Math.round(queueMs), spanMs: Math.round(carTo - carFrom),
      startZ: evalAt(carFrom), endZ: evalAt(carTo), lastAnchorZ: last ? last.z : null,
      backs, anchorCount: motion.diagnostics.anchorCount,
      exitAt: Math.round(motion.exit.o - offset),
    });
  }
}

const offEntry = rows.filter((row) => Math.abs(row.startZ - ENTRY_Z) > ENTRY_TOL);
const shortSpan = rows.filter((row) => row.spanMs < 300);
const incomplete = rows.filter((row) => row.lastAnchorZ !== null && row.endZ < row.lastAnchorZ - 0.5);
const outside = rows.filter((row) => row.endZ > Z_MAX - 1 + 0.5);
const backwards = rows.filter((row) => row.backs > 0);
const queued = rows.filter((row) => row.queueMs > 50);
const spans = rows.map((row) => row.spanMs).sort((a, b) => a - b);
const pastEnd = rows.filter((row) => row.carTo > 300000);
console.log(`车辆区间越过窗口末(300000ms)的 ${pastEnd.length} 趟 · 最晚 carTo=${Math.max.apply(null, rows.map((r) => r.carTo))}ms`);

console.log(`有位置证据的趟次 ${rows.length} 趟（车会画出来）`);
console.log(`起点不在入口(>${ENTRY_TOL}m) ${offEntry.length} 趟 · 可见区间 <300ms ${shortSpan.length} 趟 · 没走完(终点 < 最后锚点) ${incomplete.length} 趟 · 冲出道外 ${outside.length} 趟 · 区间内有倒车 ${backwards.length} 趟`);
console.log(`可见区间中位 ${spans[spans.length >> 1]}ms · 最短 ${spans[0]}ms · 最长 ${spans[spans.length - 1]}ms · 需要在入口等前车的 ${queued.length} 趟`);
const waits = rows.map((row) => row.queueMs).sort((a, b) => a - b);
console.log(`入口等待（前车还在道内）中位 ${waits[waits.length >> 1]}ms · 最长 ${waits[waits.length - 1]}ms`);
const lap = overlaps.filter((row) => row.overlapMs > 0);
const lapDeep = lap.filter((row) => row.prevZ < 15);
console.log(`\n相邻两趟在时间上重叠的 ${lap.length} 组（前一趟还没走完、下一趟的日志已经开始）：`);
console.log(`  其中前车还停在道中间（z<15，不是闸口/驶离段）的 ${lapDeep.length} 组`
  + `（模型一条车道只画一辆车，这些组只能"收掉前车"或"让后车在入口等"）`);
for (const row of lap.sort((a, b) => b.overlapMs - a.overlapMs).slice(0, 8)) {
  console.log(`  ${row.lane} #${row.prevPassage}→#${row.passage} 重叠 ${row.overlapMs}ms · 前车此刻 z=${row.prevZ}（前车全程 ${row.prevSpanMs}ms）`);
}
console.log("\n等得最久的 6 趟（核对是不是前一趟压着不走/线圈一直不释放）：");
for (const row of rows.slice().sort((a, b) => b.queueMs - a.queueMs).slice(0, 6)) {
  console.log(`  ${row.lane} #${String(row.passage).padStart(3)} 等 ${String(row.queueMs).padStart(6)}ms · 本趟区间 ${row.spanMs}ms · 起点 z=${row.startZ.toFixed(1)} → 终点 z=${row.endZ.toFixed(1)}（最后锚点 ${row.lastAnchorZ}）`);
}
if (offEntry.length) {
  console.log("\n起点不在入口的趟次（这正是「凭空出现在线圈6/闸机」的来源）：");
  for (const row of offEntry.slice(0, 12)) {
    console.log(`  ${row.lane} #${String(row.passage).padStart(3)} 起点 z=${row.startZ.toFixed(1)} · 等前车 ${row.queueMs}ms · 锚点 ${row.anchorCount}`);
  }
}
const failures = offEntry.length + shortSpan.length + incomplete.length + outside.length + backwards.length;
console.log(failures ? `\n失败：${failures} 项` : "\n全部通过");
process.exit(failures ? 1 : 0);
