// 图 5 · 邻道干扰判定流（主规则 + 辅助证据 + 必须排除的正常业务链）
import { box, card, emit, note, sceneOf, wire } from './kit.ts';

const nodes = []; const edges = []; const texts = [];
const put = (b) => { nodes.push(b.node); return b.rect; };
const CX = 880;

const entry = put(box('entry', '本车道 ETC 交易成功', { x: CX, y: 80 }, { sub: '完整 OBU + B4/0015 车牌 + 交易时间 T', tone: 'amber', variant: 'solid' }));
const idkey = put(card('idkey', [
  '**身份键：完整 8 位 OBU**（从 message 的 `B2帧原始数据` 解析）',
  'ES 字段 `ObuCode` 只有 1 字节 → 禁止作唯一键（实测一小时仅 26 个取值）',
], { x: CX, y: 250 }, { tone: 'blue', variant: 'tint' }));
const d1 = put(box('d1', '本车道有物理证据?', { x: CX, y: 470 }, { sub: '[T−30s, T+30s] 内同车牌抓拍 或 线圈压上', shape: 'diamond', tone: 'violet' }));
const ok = put(box('ok', '正常通行', { x: CX - 560, y: 470 }, { sub: '证据齐 → 不做干扰判定', tone: 'slate' }));
const d2 = put(box('d2', '他车道有同车牌抓拍?', { x: CX, y: 700 }, { sub: '[T−30s, T+30s] 窗口', shape: 'diamond', tone: 'violet' }));
const weak = put(box('weak', '证据不足 → 待核实', { x: CX - 560, y: 940 }, { sub: '不得直接下结论', tone: 'slate' }));
const hit = put(card('hit', [
  '**Anomaly 邻道干扰**',
  '干扰车道 = 本车道（无物理证据却有交易）',
  '正常车道 = 匹配到抓拍的车道',
  'verdict：规则推断（需人工复核）',
], { x: CX, y: 960 }, { tone: 'rose', variant: 'solid' }));

edges.push(
  wire('entry', 'idkey', entry, idkey, { fromSide: 'bottom', toSide: 'top' }),
  wire('idkey', 'd1', idkey, d1, { fromSide: 'bottom', toSide: 'top' }),
  wire('d1', 'ok', d1, ok, { fromSide: 'left', toSide: 'right', label: '是' }),
  wire('d1', 'd2', d1, d2, { fromSide: 'bottom', toSide: 'top', label: '否' }),
  wire('d2', 'weak', d2, weak, { fromSide: 'left', toSide: 'right', label: '否' }),
  wire('d2', 'hit', d2, hit, { fromSide: 'bottom', toSide: 'top', label: '是', tone: 'rose' }),
);

// 排除项：侧栏分组框（显式声明框，不派生）
const excl = {
  id: 'excl', rect: { x: 1500, y: 380, w: 720, h: 620 }, label: '必须排除的正常业务链', tone: 'amber' as const,
  frame: 'declared' as const, labelPlacement: 'outer' as const, contains: ['x-ramp', 'x-obu', 'x-aux'],
};
const xr = put(card('x-ramp', [
  '**匝道 ↔ 收费车道**',
  '95 车道（匝道）读到 OBU，15~35s 后在',
  '91/24/25 车道完成交易 → 一次通行的正常链',
], { x: 1860, y: 520 }, { tone: 'amber' }));
const xo = put(card('x-obu', [
  '**ObuCode 字段口径**',
  '一小时 31 对「跨车道」→ 全假阳性',
  '（字段只存首字节）',
], { x: 1860, y: 700 }, { tone: 'amber' }));
const xa = put(card('x-aux', [
  '**辅助证据（不作主判据）**',
  '同一完整 OBU 在 ±30s 内被 ≥2 条',
  '不同车道读到 —— 只升级关注度',
], { x: 1860, y: 880 }, { tone: 'amber' }));

texts.push(
  note('n-measured', '**实测（2026-07-01 12 时·单站）**：完整 OBU 127 个（78 个跨车道），**5 秒内跨车道 0 对** —— 方案原「场景一（5s 同 OBU）」在本站几乎不产出，主判据必须落在场景二。', { x: 200, y: 1150 }, { anchor: 'start', fontSize: 12, color: '#b42318' }),
  note('n-case', '**样例**：OBU 3DF35ED4 在 12:06:54.5 被 95 车道（匝道）读到、E1 因「货车不允通行」失败；12:07:16.8 在 91 车道重做并成功 —— 这是同一次通行，不是邻道干扰。', { x: 200, y: 1185 }, { anchor: 'start', fontSize: 12 }),
  note('n-src', '前置依赖：车道字典（role + adjacency）· 完整 OBU 解析 · 车道存在的物理证据（线圈/抓拍）。', { x: 200, y: 1220 }, { anchor: 'start', fontSize: 12 }),
);

emit(sceneOf({ nodes, edges, texts, groups: [excl] }), '05-邻道干扰判定流.svg', '邻道干扰判定流：主规则（场景二）+ 辅助证据 + 必须排除的匝道正常链');
