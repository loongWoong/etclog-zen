import fs from "node:fs";
import { buildMotion, stationsFrom, pchipSlopes } from "./lane-motion.mjs";

const DEVICES = { vlpr: -22.0, weigh: -19.5, axle: -16.5, lane: 9.0, cpc: 6.0, display: 18.6, barrier: 24.0, rsu: 14.5 };
const COILS = { "1": -14.5, "2": -10.5, "6": 11.8, "7": 21.5 };
const stations = stationsFrom(DEVICES, COILS, { rsuFront: -12.4 });
const data = JSON.parse(fs.readFileSync("data/lanes.json", "utf8"));
const lane = data.lanes.find((item) => item.id === process.argv[2] || "3701643300");
for (const passage of lane.passages) {
  if (String(passage.i) !== (process.argv[3] || "21")) continue;
  const motion = buildMotion({ events: passage.nodes, stations, windowFrom: passage.o0, windowTo: passage.o1, zMin: -35, zMax: 35 });
  console.log(`过程 #${passage.i} [${passage.start} → ${passage.end}] 节点 ${passage.nodes.length}`);
  console.log("-- 全部锚点 --");
  for (const anchor of motion.anchors) console.log(`   ${anchor.key.padEnd(9)} z=${String(anchor.z).padStart(6)} 日志 ${anchor.logO} → ${anchor.o} (${anchor.o - anchor.logO}ms) ${anchor.why}`);
  console.log("-- 剔除 --");
  for (const item of motion.dropped) console.log(`   ${item.key.padEnd(9)} z=${String(item.z).padStart(6)} ${item.o} ${item.why}`);
  console.log("-- 路径点 --");
  const xs = motion.points.map((p) => p.o);
  const zs = motion.points.map((p) => p.z);
  const slopes = pchipSlopes(xs, zs);
  motion.points.forEach((p, i) => {
    const prev = i ? `Δt=${p.o - xs[i - 1]}ms Δz=${(p.z - zs[i - 1]).toFixed(1)}m 段速=${(Math.abs(p.z - zs[i - 1]) / ((p.o - xs[i - 1]) / 1000)).toFixed(2)}` : "";
    console.log(`   ${String(p.key).padEnd(9)} o=${p.o} z=${p.z.toFixed(2)} 斜率=${(slopes[i] * 1000).toFixed(2)}m/s ${prev}`);
  });
  console.log(`峰值 ${motion.diagnostics.peakSpeed} m/s 后退 ${motion.diagnostics.backwards}`);
  // 找峰值所在时刻
  const from = motion.diagnostics.from;
  const to = motion.diagnostics.to;
  const step = (to - from) / 2000;
  let best = { v: 0 };
  let prev = null;
  for (let o = from; o <= to; o += step) {
    const z = motion.zAt(o);
    if (prev !== null) {
      const v = Math.abs(z - prev.z) / (step / 1000);
      if (v > best.v) best = { v, o, z, prev: prev.z };
    }
    prev = { z };
  }
  console.log(`峰值定位 ${best.v.toFixed(2)} m/s @ ${best.o} (${best.prev.toFixed(2)} → ${best.z.toFixed(2)})`);
}
