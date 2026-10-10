// 图 4 · 口径对照时序（鲁UG6595 真实数据）：同一趟、两个口径、相反结论
// 时间轴按真实毫秒线性映射：12:07:15.000 → x=180，每秒 144px。
import { emit, note, sceneOf, wire } from './kit.ts';

const X0 = 180; const PPS = 144; const Y_AXIS = 469;
const x = (sec) => Math.round(X0 + sec * PPS);           // sec = 相对 12:07:15.000 的秒
const nodes = []; const edges = []; const texts = [];
const put = (id, rect, o = {}) => { nodes.push({ id, rect, ...o }); return rect; };
const rect = (x0, y0, w, h) => ({ x: x0, y: Math.round(y0 - h / 2), w, h });

// 时间轴
put('axis', rect(X0, Y_AXIS, x(9) - X0, 2), { tone: 'slate' });
for (let s = 0; s <= 9; s += 1) {
  const t = 15 + s;
  put(`tick-${t}`, rect(x(s) - 1, Y_AXIS - 20, 2, 4), { tone: 'slate' });
  texts.push(note(`lbl-${t}`, `12:07:${String(t).padStart(2, '0')}`, { x: x(s), y: 505 }, { anchor: 'middle', fontSize: 11 }));
}
// 轴上方：口径相关的 4 个时刻（T2/T3 只差 46ms ≈ 7px，合并成一根刻度，避免假精度）
for (const [id, sec] of [['ev-pic', 0], ['ev-c1', 1.774]]) {
  put(id, rect(x(sec) - 1, Y_AXIS - 109, 2, 60), { tone: 'violet' });
}
put('ev-t23', rect(x(2.312) - 1, Y_AXIS - 109, 2, 60), { tone: 'violet' });
texts.push(
  note('ev-pic-l', 'picTime 15.000（报文内拍摄时间）', { x: x(0), y: 280 }, { anchor: 'middle', fontSize: 12, color: '#b42318' }),
  note('ev-c1-l', 'C1 首个 B2 帧 16.774', { x: x(1.774), y: 280 }, { anchor: 'middle', fontSize: 12 }),
  note('ev-t23-l', '**T2 抬杆指令 17.266 / T3 真实到位 17.312**（barStaus=01，间隔 46ms ≥ a1 20ms → T3 可信）', { x: x(2.312) + 8, y: 325 }, { anchor: 'start', fontSize: 12 }),
);
// 轴下方：其余 4 个时刻
for (const [id, sec, tone] of [['ev-b1', 2.86, 'amber'], ['ev-a1', 3.679, 'emerald'], ['ev-t4', 6.82, 'emerald'], ['ev-down', 8.6, 'slate']]) {
  put(id, rect(x(sec) - 1, Y_AXIS + 84, 2, 50), { tone });
}
texts.push(
  note('ev-b1-l', 'B1 抓拍上报 17.860（与 picTime 差 2860ms → 标 B1_LOW）', { x: x(2.86), y: 610 }, { anchor: 'middle', fontSize: 12, color: '#b42318' }),
  note('ev-a1-l', 'A1 车检器 1/2 有信号 18.679', { x: x(3.679), y: 650 }, { anchor: 'middle', fontSize: 12 }),
  note('ev-t4-l', 'T4 车检器 7 有信号 21.820', { x: x(6.82), y: 610 }, { anchor: 'middle', fontSize: 12 }),
  note('ev-down-l', '落杆到位 23.600', { x: x(8.6), y: 650 }, { anchor: 'middle', fontSize: 12 }),
);
// 三条耗时条
const barA = put('bar-a', rect(x(1.774), 700, x(2.312) - x(1.774), 26), { tone: 'emerald', variant: 'tint' });
const barB = put('bar-b', rect(x(0), 760, x(2.312) - x(0), 26), { tone: 'rose', variant: 'tint' });
const barC = put('bar-c', rect(x(1.774), 820, x(6.82) - x(1.774), 26), { tone: 'slate', variant: 'tint' });
texts.push(
  note('bar-a-l', '口径 A（本轮：B1 = 抓拍上报行时间）elapsedBarrier = T3 − T1 = **538ms** → 正常（冷启动 b1 货车 2s）', { x: x(2.312) + 20, y: 700 }, { anchor: 'start', fontSize: 12, color: '#067647' }),
  note('bar-b-l', '口径 B（若 B1 = 报文内 picTime）elapsedBarrier = **2312ms** > 2000ms → **过车慢**，根因 **天线扫描慢**（C1 − B1 = 1774ms > c1 1s）', { x: x(2.312) + 20, y: 760 }, { anchor: 'start', fontSize: 12, color: '#b42318' }),
  note('bar-c-l', 'elapsedPass = T4 − T1 = **5046ms**（< b2 货车 15s）→ 物理通过不判慢', { x: x(6.82) + 20, y: 820 }, { anchor: 'start', fontSize: 12 }),
  note('bar-a-r', '口径 A', { x: x(1.774) - 14, y: 700 }, { anchor: 'end', fontSize: 12, weight: 600 }),
  note('bar-b-r', '口径 B', { x: x(0) - 14, y: 760 }, { anchor: 'end', fontSize: 12, weight: 600 }),
  note('bar-c-r', '物理通过', { x: x(1.774) - 14, y: 820 }, { anchor: 'end', fontSize: 12, weight: 600 }),
  note('n1', '**为什么差 1774ms**：B1（抓拍上报行 17.860）比 C1（首个 B2 帧 16.774）晚 1086ms —— 上报延迟落在 B1 上；改回 picTime 后 T1 提前到 15.000，这段延迟就变成「检测 → 抬杆」的等待，于是同一趟从「正常」翻成「过车慢 + 天线扫描慢」。', { x: X0, y: 900 }, { anchor: 'start', fontSize: 12 }),
  note('n2', '**T3 只认设备上报帧**：`设备信息|E4` 的「电动栏杆机抬杆到位」与 T2 指令同毫秒（17.266），取它会使 T3 − T2 = 0ms < a1 → 误判 T3 不可信 → 整趟改用 b2 分支。', { x: X0, y: 940 }, { anchor: 'start', fontSize: 12, color: '#b42318' }),
  note('n3', '结论：同一份日志、同一趟车，两个口径给出相反结论。口径必须进字段、进清单、进每个结论的 evidence.caliber。', { x: X0, y: 980 }, { anchor: 'start', fontSize: 12, weight: 600 }),
);

emit(sceneOf({ nodes, edges, texts }), '04-口径对照时序.svg', '口径对照时序：同一趟通行在两个 B1 口径下的相反结论（鲁UG6595 / 91 车道）');
