// 图 2 · 过车慢判定流（含口径分支 b1/b2 与三子模型根因）
// 判定流配方：菱形只放极短问句、只吃面中点；三路以上的分叉交给矩形（bottom 面摊 t）。
import { box, card, emit, sceneOf, wire, note } from './kit.ts';

const CX = 900;
const nodes = []; const edges = []; const texts = [];
const put = (b) => { nodes.push(b.node); return b.rect; };

// ① 入口
const passage = put(box('passage', '一次通行 Passage', { x: CX, y: 70 }, { sub: 'ETC 出口交易成功 · 车道 370164335B（91 车道）', tone: 'amber', variant: 'solid' }));
// ② 时间节点与口径
const times = put(card('times', [
  '**抽取六个时间节点**（口径先于规则）',
  'A1 压线圈 · B1 抓拍上报 · C1 首个 B2 帧',
  'T2 抬杆指令 · T3 到位（barStaus=01）· T4 通过线圈',
  'T1 = ETC 专用 min(B1,C1)；混合车道 A1 优先',
], { x: CX, y: 230 }, { tone: 'blue', variant: 'tint' }));
// ③ 口径分支
const dT3 = put(box('t3trust', 'T3 可信?', { x: CX, y: 420 }, { sub: 'T3 − T2 ≥ 20ms 且 C1 ≤ T2 ≤ T3', shape: 'diamond', tone: 'violet' }));
const b1 = put(box('b1', 'b1：T3 − T1 > 阈值', { x: CX - 480, y: 620 }, { sub: '方案 b1 · 冷启动客车/货车 2s', tone: 'emerald', variant: 'tint' }));
const b2 = put(box('b2', 'b2：T4 − T1 > 阈值', { x: CX + 480, y: 620 }, { sub: '方案 b2 · 冷启动客车 5s / 货车 15s', tone: 'amber', variant: 'tint' }));
// ④ 基线
const base = put(card('baseline', [
  '**动态基线 median + k×MAD**（k=7）',
  '分组 = (车道 × 车型)：7 条收费车道 × 客车/货车',
  '窗口 = 最近 7 个**有数据日**（07-03~12 等 16 天无数据）',
  '样本保护：组样本 <30 → 沿用上期 → 冷启动值',
], { x: CX, y: 790 }, { tone: 'violet' }));
// ⑤ 判定
const dSlow = put(box('slowq', '超阈值?', { x: CX, y: 950 }, { sub: '剔除：倒车 / 闯关 / 节点缺失 / >15s', shape: 'diamond', tone: 'violet' }));
const normal = put(box('normal', '正常通行', { x: CX - 620, y: 950 }, { sub: '入台账并作基线样本', tone: 'slate' }));
// ⑥ 三子模型
const root = put(box('root', '根因定位', { x: CX, y: 1090 }, { sub: '三子模型 · 依次判定', tone: 'blue', variant: 'tint' }));
const rc1 = put(card('rc1', ['**天线扫描慢**', 'ETC：C1 − B1 > c1', '混合：C1 − A1 > c1', '负数 → 不计样本'], { x: CX - 470, y: 1250 }, { tone: 'rose' }));
const rc2 = put(card('rc2', ['**栏杆抬杆慢**', 'T3 − T2 > a2（500ms）', '或 T4 − T2 > a3（1.5s）'], { x: CX, y: 1250 }, { tone: 'rose' }));
const rc3 = put(card('rc3', ['**交易慢**', 'C2 = 首个 B5 − 首个 B2', 'C2 > d1（冷启动 500ms）'], { x: CX + 470, y: 1250 }, { tone: 'rose' }));
// ⑦ 结论
const anomaly = put(card('anomaly', [
  '**Anomaly 异常实例**：过车慢',
  '实测值 + 阈值 + 来源（冷启动/动态）+ 根因',
  '证据指针（ES _id + 口径）· verdict：已证实 / 规则推断 / 待核实',
], { x: CX, y: 1420 }, { tone: 'amber', variant: 'solid' }));

edges.push(
  wire('passage', 'times', passage, times, { fromSide: 'bottom', toSide: 'top' }),
  wire('times', 't3trust', times, dT3, { fromSide: 'bottom', toSide: 'top', label: '先定口径' }),
  wire('t3trust', 'b1', dT3, b1, { fromSide: 'left', toSide: 'top', label: '是', tone: 'emerald' }),
  wire('t3trust', 'b2', dT3, b2, { fromSide: 'right', toSide: 'top', label: '否', tone: 'amber' }),
  wire('b1', 'baseline', b1, base, { fromSide: 'right', toSide: 'top', toT: 0.3 }),
  wire('b2', 'baseline', b2, base, { fromSide: 'left', toSide: 'top', toT: 0.7 }),
  wire('baseline', 'slowq', base, dSlow, { fromSide: 'bottom', toSide: 'top' }),
  wire('slowq', 'normal', dSlow, normal, { fromSide: 'left', toSide: 'right', label: '否' }),
  wire('slowq', 'root', dSlow, root, { fromSide: 'bottom', toSide: 'top', label: '是', tone: 'rose' }),
  wire('root', 'rc1', root, rc1, { fromSide: 'bottom', toSide: 'top', fromT: 0.2, stub: 26 }),
  wire('root', 'rc2', root, rc2, { fromSide: 'bottom', toSide: 'top', fromT: 0.5, stub: 26 }),
  wire('root', 'rc3', root, rc3, { fromSide: 'bottom', toSide: 'top', fromT: 0.8, stub: 26 }),
  wire('rc1', 'anomaly', rc1, anomaly, { fromSide: 'bottom', toSide: 'top', toT: 0.3, stub: 40 }),
  wire('rc2', 'anomaly', rc2, anomaly, { fromSide: 'bottom', toSide: 'top', toT: 0.5, stub: 40 }),
  wire('rc3', 'anomaly', rc3, anomaly, { fromSide: 'bottom', toSide: 'top', toT: 0.7, stub: 40 }),
);

texts.push(
  note('n-caliber', '口径回归用例 R1：同一趟（鲁UG6595）上报口径 538ms → 正常；改用报文内 picTime 则 2312ms → 过车慢 + 天线扫描慢。标 B1_LOW 才算说清。', { x: 150, y: 1560 }, { anchor: 'start', color: '#b42318' }),
  note('n-echo', '陷阱：设备信息|E4 的「电动栏杆机抬杆到位」时间与 T2 指令同毫秒，取它会把 T3−T2 变成 0ms → 误判 T3 不可信 → 整趟换口径。T3 只认 barStaus=01 帧。', { x: 150, y: 1590 }, { anchor: 'start', color: '#b42318' }),
);

emit(sceneOf({ nodes, edges, texts }), '02-过车慢判定流.svg', '过车慢判定流：口径分支 b1/b2 + 三子模型根因');
