// 图 6 · 数据可用性（索引 ump_37016433_2026.07 的 26 天）：柱高 = 当日文档量，格 = 当日是否有数据
import { emit, note, sceneOf } from './kit.ts';

const PITCH = 58; const X0 = 90; const BASE = 1290; const PER_M = 86; // 86px / 百万文档
const nodes = []; const texts = [];
const DAYS = [
  { d: 1, doc: 2.04, kind: 'full' }, { d: 2, doc: 2.56, kind: 'full' },
  { d: 3, doc: 0, kind: 'none' }, { d: 4, doc: 0, kind: 'none' }, { d: 5, doc: 0, kind: 'none' },
  { d: 6, doc: 0, kind: 'none' }, { d: 7, doc: 0, kind: 'none' }, { d: 8, doc: 0, kind: 'none' },
  { d: 9, doc: 0, kind: 'none' }, { d: 10, doc: 0, kind: 'none' }, { d: 11, doc: 0, kind: 'none' },
  { d: 12, doc: 0, kind: 'none' },
  { d: 13, doc: 2.09, kind: 'full' }, { d: 14, doc: 2.10, kind: 'full' }, { d: 15, doc: 0.55, kind: 'part' },
  { d: 16, doc: 0, kind: 'none' }, { d: 17, doc: 0, kind: 'none' }, { d: 18, doc: 0, kind: 'none' }, { d: 19, doc: 0, kind: 'none' },
  { d: 20, doc: 1.86, kind: 'full' }, { d: 21, doc: 2.49, kind: 'full' }, { d: 22, doc: 2.34, kind: 'full' },
  { d: 23, doc: 0.25, kind: 'part' }, { d: 24, doc: 0, kind: 'none' }, { d: 25, doc: 0, kind: 'none' },
  { d: 26, doc: 2.40, kind: 'full' },
];
const TONE = { full: 'emerald', part: 'amber', none: 'slate' };

DAYS.forEach((day, i) => {
  const cx = X0 + i * PITCH + 21;
  if (day.doc > 0) {
    const h = Math.round(day.doc * PER_M);
    nodes.push({ id: `bar-${day.d}`, rect: { x: cx - 18, y: BASE - h, w: 36, h }, tone: TONE[day.kind], variant: 'tint' });
    texts.push(note(`bar-lbl-${day.d}`, day.doc.toFixed(2), { x: cx, y: BASE - h - 16 }, { anchor: 'middle', fontSize: 10 }));
  }
  nodes.push({ id: `tile-${day.d}`, rect: { x: cx - 21, y: BASE + 20, w: 42, h: 34 }, label: day.kind === 'none' ? '无' : `${day.d}`, tone: TONE[day.kind], variant: day.kind === 'full' ? 'tint' : 'outline' });
  texts.push(note(`day-${day.d}`, day.kind === 'none' ? '—' : `07-${String(day.d).padStart(2, '0')}`, { x: cx, y: BASE + 82 }, { anchor: 'middle', fontSize: 10 }));
});

texts.push(
  note('n-head', '索引 ump_37016433_2026.07 · 26 天里的数据可用性（柱高 = 当日文档量 / 百万）', { x: X0, y: 1000 }, { anchor: 'start', fontSize: 16, weight: 600 }),
  note('n-title', '**图 6 · 数据可用性**：索引名带月份，但 26 天里只有 **10 天有数据**（8 个全天 + 2 个部分日），16 天为空。', { x: X0, y: 1405 }, { anchor: 'start', fontSize: 13 }),
  note('n-partial', '**部分日**：07-15 与 07-23 的 laneLog 只到凌晨（10.5 万 / 3.7 万条），但 data 服务日志是全天量 —— 这两天只能进服务侧统计，不能进耗时基线。', { x: X0, y: 1440 }, { anchor: 'start', fontSize: 12, color: '#b45309' }),
  note('n-window', '**MAD 基线的"最近 7 天"必须改口径**：按自然日取 07-20~07-26 只有 5 个有数据日（20/21/22/23/26）；要凑 7 天得跨到 07-13~15 或更早的 06-29/30（在 `2026.06` 索引里）→ 建议定义为"最近 7 个有数据日"，并把跨索引取数写进规格。', { x: X0, y: 1475 }, { anchor: 'start', fontSize: 12, color: '#b42318' }),
  note('n-ask', '**开放项**：这是采集/入库缺口，还是导出裁剪？它决定基线能否做趋势判断，也决定 07-03~12 等空白期是否还有别的索引副本。', { x: X0, y: 1510 }, { anchor: 'start', fontSize: 12 }),
);

// 图例
const legend = [['有数据（全天）', 'emerald', 'tint'], ['部分日（laneLog 缺）', 'amber', 'outline'], ['无数据（16 天）', 'slate', 'outline']];
legend.forEach(([label, tone, variant], i) => {
  nodes.push({ id: `lg-${i}`, rect: { x: X0 + i * 380, y: 1560, w: 28, h: 28 }, tone, variant });
  texts.push(note(`lg-l-${i}`, label, { x: X0 + i * 380 + 40, y: 1574 }, { anchor: 'start', fontSize: 12 }));
});

emit(sceneOf({ nodes, texts }), '06-数据可用性.svg', '数据可用性：索引 ump_37016433_2026.07 的 26 天里只有 10 天有数据');
