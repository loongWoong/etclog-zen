// =====================================================================
// templates/lifecycle · 状态机 / **阶段带图**的起手骨架
//
//   ┌ 这一层是什么(与同目录 README 的宪章同一条) ──────────────────────┐
//   │ 模板, 不是内核。封装只有**骨架**: 共享列空间的列距 / 段带跨度 /     │
//   │ 行 y / 段带分隔线与标签落位 / 端口与走廊 / 画布反推 / audit 出口。   │
//   │ **决策**一个不碰: 几条段带 / 段序(数组序) / 谁在第几列第几行 /      │
//   │ 迁移的数组序 / 语义槽 / 图例 —— 全由调用方给全。                   │
//   └──────────────────────────────────────────────────────────────┘
//
// 判据(六条, 就是本模板存在的理由; 测试逐条对得上):
//   ① demo 用与手排示例 `examples/gallery/lifecycle-agent-run.ts` 同一拓扑
//      ⇒ showcase 档 **0 error**; 警示只剩段带分隔线那 2 条 `long_edge`(可读性档 —— 同图的
//      手排示例也有 4 条同类, 并在它文件头逐条声明"有意")。白名单**写死进测试**: 多出任何
//      一条新警示即红。**不**把分隔线切成 N 段去迁就门禁(那是拿拓扑变换换绿灯)
//   ② 那三条**门禁审不到的版式判据**语义不变(见 `test/lifecycle-agent-run.test.ts`):
//      同列下落边是直线 / 那条走廊上没有第三个盒子 / 两个状态同排相邻
//   ③ **跨列段带声明** ⇒ 列距按累积最小值顶开, 且 `plan.needs[].by` 读得出是谁顶开的
//   ④ 改一个决策(换段序 / 挪一列) ⇒ 产物**变**; 同 spec 跑两遍 ⇒ 逐字节相同
//   ⑤ 畸形入参当场抛(`ShapeInputError`, 点名字段 + 已知的带 / 状态 id), 不给半成品 scene
//   ⑥ 决策行数 ≪ 手排量(手排参照 339 行; 本模板 demo 的 spec **33 行 / 23 条决策 ≈ 1/10**, 见文件尾)
//
// ── 从决策到产物: 一条单向流水线 ─────────────────────────────────────
//
//   输入  bands(数组序 = 自上而下的行序, `from`/`to` = 跨列声明)
//         states(band + col + row) · transitions(数组序 = 谁先谁后)
//     ↓
//   ① 守卫   段带 / 状态 / 迁移合法性 + 格子唯一 + 跨列声明装得下成员 → 当场抛
//   ② 尺寸   盒高 = max(nodeFit(...).h); 逐列盒宽 = 该列成员的 max(fit.w)
//   ③ 落位需求  逐条迁移先定量两份: 标签遮罩片尺寸 与 "它吃哪一格列距"
//   ④ 列距    逐格 + **跨列** 需求各喂一条 `AxisConstraint` → `solveAxis` 解共享列空间
//   ⑤ 列心    首列锚在 margin + 段带标签槽 + 半个盒宽, 其后纯累加
//   ⑥ 行 y    各带内容顶喂一维账本 → `solveAxis`(带内子行 + 带间走廊; 走廊高度 = 旋钮与
//             "通道 + 标签 + 分隔线"需求各喂一条, 谁大谁赢)
//   ⑦ 装配    状态盒 / 迁移边(折点由拓扑定) / 段带分隔线 + 标签 / 边标签
//   ⑧ 画布    内容包围盒 + margin; `fit: true` 下只是兜底与 `plan` 可读
//     ↓
//   输出  { scene, opts, plan } —— 每一步的推导都原样进 `plan`, 推导可对账
//
// ── 四条贯穿始终的取舍 ──────────────────────────────────────────────
//
//   · **一组列心跨全图共用**(不是每带各解一次): 跨带对齐 = 同列号 = 同列心,
//     event / terminal 声明的列 N 就是 main 的列 N —— 对齐由**声明**保证, 不靠模板猜。
//   · **轴上的间距只喂账本, 不自己写 max 累加**: 逐格需求好写, 一旦出现跨格要求(一段段带横跨
//     3 列), "原地取 max" 就不再成立 —— 要求沿链累积, 且必须说得出是谁顶开的, 那正是 `solveAxis`
//     的活(纵轴同政策: 走廊上并列着"旋钮下限"与"标签 + 通道"两样需求, 同理各喂一条)。
//   · **同列 ⇒ 直线**: 同列的两个盒端口同 x, 二者之间**不许插折点**(判据 ②)。
//     跨带下行 / 回流的折点走**段带分隔线上方的走廊**, 那是唯一一条不压盒子的横向通道。
//   · **`via` 永远赢**: spec 显式给折点时按声明原样走, 不静默改写; `plan` 里标 `declarative: true`。
//
// 用法一(库):
//   import { buildLifecycle, emitLifecycle } from '@watert/svg-infovis/templates/lifecycle.ts';
//   const { scene, opts, plan } = buildLifecycle(spec);  // 想接着改停在这
//   emitLifecycle({ ...spec, out: '/tmp/life.svg' });    // 一步到产物
//
// 用法二(内置示例直跑):
//   bun run templates/lifecycle.ts --out=/tmp/life.svg [--dark]
//
// ⚠ 两条实测出来的坑(改这个文件前先读):
//   ① **段带标签必须待在左侧槽里, 不能落进列区**。跨带下行边要从"段带分隔线上方的走廊"
//      一路竖着扎到目标盒的顶面, 那条竖线会穿过分隔线与标签之间的整段高度 —— 标签若压在
//      任一列心上, `text_clearance` 当场报错(手排示例为同一件事把节点整体从 X0 = 64 起排)。
//      本模板把标签右对齐到"段带左缘 − bandLabelGap", 于是列区里永远没有文字。
//   ② **横向走廊与分隔线之间要留够净空**(`corridorClear`) —— 二者平行且 x 区间重叠,
//      贴太近会踩 `edge_overlap` 的近共线档(手排示例那条 `FAIL_LANE` 注释记的是同一件事:
//      中点 108 压到分隔线 120, 差 12px 就报)。
// =====================================================================

import { writeFileSync } from 'node:fs';
import {
  ShapeInputError,
  THEMES,
  bounds,
  edgeLabel,
  labelBoxSize,
  mid,
  nodeFit,
  rectFace,
  resolveKnobs,
  rightOf,
  solveAxis,
  textNote,
  tryExport,
  type AuditLevel,
  type AxisConstraint,
  type EdgeProps,
  type ExportOptions,
  type ExportResult,
  type Rect,
  type Scene,
  type SceneEdge,
  type SceneLabel,
  type SceneNode,
  type Theme,
  type Tone,
  type Variant,
} from '@watert/svg-infovis';
import { isMainModule } from '@watert/svg-infovis/runtime';

// --- 契约 --------------------------------------------------------------

export type Side = 'top' | 'right' | 'bottom' | 'left';

/**
 * 一段**阶段带**。**数组序 = 自上而下的行序** —— 谁在上是作者决策, 模板不排。
 *
 * `from` / `to` 是**跨列声明**(列号区间, 含两端): 段带的可见跨度 = 这段声明,
 * 它同时是喂给列距账本的**一条跨格约束**的来源(见 `spanMin` 与 ④ 段)。
 */
export type LifecycleBand = {
  id: string;
  label: string;
  /** 可见跨度的左端列号(含); 缺省 = 该带成员的最小列号 */
  from?: number;
  /** 可见跨度的右端列号(含); 缺省 = 该带成员的最大列号 */
  to?: number;
  /**
   * 段带可见跨度的**下限**(px)。声明了就变成一条 `from → to` 的跨格约束:
   * "这段声明要 N 像素宽" ⇒ 沿途每一格列距按累积被顶开, `plan.needs[].by` 记 `band:<id>`。
   * 不给 = 不额外提要求(只受逐格盒宽与 `colGapMin` 约束)。
   */
  spanMin?: number;
  /** 段带色泽(分隔线取它的边色) */
  tone?: Tone;
};

/** 一个状态盒。`band` 定段带, `col` 是**共享列空间**的列号, `row` 是带内第几行(缺省 0) */
export type LifecycleState = {
  id: string;
  label: string;
  /** 次标签(盒第二行, 同 `nodeFit` 口径) */
  sub?: string;
  /** 属哪一段带(必须是已知 id) */
  band: string;
  /** 列号 —— **全图共用一个列空间**: 不同带写同一个列号就是同一列心 */
  col: number;
  /** 带内第几行(缺省 0); 同一 (band, col, row) 只能有一个状态 */
  row?: number;
  tone?: Tone;
  variant?: Variant;
  radius?: number;
  /** 视觉主角: 缺省色块给 `tint`, 只有它给 `solid`(满图实色等于没有重点) */
  focus?: boolean;
};

/** 一条迁移。折点由拓扑决定; 显式 `via` 时**永远赢** */
export type LifecycleTransition = {
  id?: string;
  from: string;
  to: string;
  label?: string;
  /** 语义槽: 这条迁移属于哪一族(主路径刻意不点色, 走主题中性线色) */
  tone?: Tone;
  /**
   * **显式折点**(绝对坐标)。给了就按声明原样走, 模板不静默改写 ——
   * 缺省出入面为"左出 / 上入"(回流那一族的面), 要别人就写 `fromSide` / `toSide`。
   */
  via?: Array<{ x: number; y: number }>;
  fromSide?: Side;
  toSide?: Side;
};

export type LifecycleSpec = {
  bands: readonly LifecycleBand[];
  states: readonly LifecycleState[];
  transitions: readonly LifecycleTransition[];
  // --- 版式旋钮(缺省见 LIFECYCLE_DEFAULTS; 传了就是你说了算) ---
  /** 共享列空间的列距下限(px) */
  colGapMin?: number;
  /** 相邻列盒之间的最小净空(px) */
  boxGap?: number;
  /** 带内相邻子行之间盒与盒的净空(px) */
  rowGap?: number;
  /** 段带之间走廊的高度下限(px) —— 要容下"通道 + 标签 + 分隔线", 不够时按需顶开 */
  bandGap?: number;
  /** 段带可见跨度两端超出成员盒的余量(px) */
  bandPad?: number;
  /** 段带标签右缘 ↔ 段带左缘的净空(px) */
  bandLabelGap?: number;
  /** 分隔线在段带内容顶面之上的距离(px) */
  ruleRaise?: number;
  /** 段带标签盒心在分隔线之上的距离(px) */
  bandLabelRaise?: number;
  /** 边标签与线 / 盒的净空(px); 列距不足时会被它顶开 */
  labelGap?: number;
  /** 同一条走廊里多条横段的错开步长(px) */
  laneStep?: number;
  /** 回边竖走廊与两侧盒子的净空(px) */
  railClear?: number;
  /** 横向走廊与段带分隔线之间的净空(px) —— 见文件头坑②, 别调小 */
  corridorClear?: number;
  /** 图例锚点(段带底)到内容底的引导距离(px) —— 模板只给位, 不出图例节点 */
  legendLead?: number;
  /** 为调用方自绘图例预留的画布高度(px); 0 = 不留 */
  legendReserve?: number;
  /** 画布外侧留白(px) */
  margin?: number;
  // --- 出口 ---
  level?: AuditLevel;
  theme?: Theme;
  out?: string;
  title?: string;
  fontFamily?: string;
  /** 逐元素样式覆盖(最高优先级); 模板给的分隔线样式也在这张表里, 你的值覆盖它 */
  edgeStyles?: ExportOptions['edgeStyles'];
  nodeStyles?: ExportOptions['nodeStyles'];
};

/**
 * 版式缺省 —— **这张表同时就是旋钮的声明**(键集 = 可覆盖的旋钮名, 由 `resolveKnobs` 读取)。
 * 文档引用的就是这一份, 不许在别处再写一遍字面量。
 */
export const LIFECYCLE_DEFAULTS = {
  /** 列距下限。200 ≈ 手排示例的 GAP_X 48 + 盒宽(150): 也给回边竖走廊留出两侧净空 */
  colGapMin: 200,
  /** 相邻列盒最小净空(与门禁 `node_gap` 的 showcase 档 12 同一量级再宽一点) */
  boxGap: 24,
  /** 带内子行净空。同一段带里上下两排状态之间的呼吸位 */
  rowGap: 28,
  /** 段带走廊高度下限。104 = 分隔线 40 + 通道 40 + 标签半高, 手排示例用的同一个量级 */
  bandGap: 104,
  /** 段带跨度两端余量。16 = 分隔线比成员盒两头各探出一截, 读得出"这一段" */
  bandPad: 16,
  /** 段带标签右缘 ↔ 段带左缘 */
  bandLabelGap: 12,
  /** 分隔线在段带内容顶面之上 */
  ruleRaise: 40,
  /** 段带标签盒心在分隔线之上 */
  bandLabelRaise: 22,
  /** 边标签净空(showcase 的 `label_clearance` 要 4, 这里给 12 的观感余量) */
  labelGap: 12,
  /** 走廊里相邻两条横段的错开 */
  laneStep: 14,
  /** 回边竖走廊与两侧盒子的净空(px) —— 与盒净空是两个要求, 各喂一条列距约束 */
  railClear: 16,
  /** 横向走廊 ↔ 分隔线净空(见文件头坑②) */
  corridorClear: 40,
  /** 图例锚点在内容底之下多远(只是给位, 不画) */
  legendLead: 48,
  /** 预留的画布高度; 产物里图例是调用方的事 */
  legendReserve: 0,
  /** 画布外侧留白 */
  margin: 40,
} as const;

/** 迁移走的走廊族 —— `plan` 里读得出这一条是"直线 / 前行 / 下行 / 回流 / 声明折点" */
export type RouteFamily = 'same-col' | 'chain' | 'down' | 'back' | 'via';

/** 起手骨架推出来的几何账 —— **可观测**, 别让推导量藏在函数里 */
export type LifecyclePlan = {
  /** 共享列空间的列心 x(下标 = 列号) */
  columns: number[];
  /** 相邻列中距(长度 = nCols - 1) */
  gaps: number[];
  /** 逐格列距的账: `box` = 盒宽需求, `used` = 账本的解, `by` = 谁顶住了这一格(账本原样) */
  needs: Array<{ index: number; box: number; used: number; by: string[] }>;
  /** 逐段走廊的账(与 `needs` 同构): `content` = 带 k 的内容高, `used` = 段距的解, `by` = 谁顶住的 */
  yNeeds: Array<{ index: number; content: number; used: number; by: string[] }>;
  /** 状态盒(与 `states` 同 id) */
  boxes: Record<string, Rect>;
  /** 段带: 声明区间 ↔ 实际跨度(可见跨度 = 列心距 + 两端半宽) 与分隔线区间 */
  bands: Array<{
    id: string; from: number; to: number;
    /** 声明的跨度下限(没声明 = 0) */
    declared: number;
    /** 实际可见跨度 = columns[to] − columns[from] + 两端半宽 */
    span: number;
    rule: { x: number; y: number; w: number };
    label: Rect;
  }>;
  /** 每条迁移走的是哪条走廊 —— 回边读得出它绕的是哪一段带的上方 */
  routes: Array<{
    id: string; from: string; to: string; family: RouteFamily;
    corridor: string; points: Array<{ x: number; y: number }>;
    /** true = spec 显式给了 `via`, 折点按声明走 */
    declarative: boolean;
  }>;
  /** 图例位(调用方自绘图例的起点) —— 模板只给位, 不出图例节点 */
  legendAnchor: { x: number; y: number };
  width: number;
  height: number;
};

// --- 起手骨架 ----------------------------------------------------------

/** 分隔线缺省样式: 细虚线、无端点 —— **样式类参数**, 走覆盖表(调用方的 edgeStyles 覆盖它) */
export const bandRuleStyle = (theme: Theme): Omit<EdgeProps, 'points'> =>
  ({ dash: '2 6', width: 1, color: theme.groupStroke, start: 'none', end: 'none' });

/** 段带标签字号 —— 量尺寸与上屏共用这一个数(度量与产物不许两个口径) */
const BAND_LABEL_SIZE = 11;

/**
 * 起手骨架: 决策进, 几何出。
 *
 * 它**只算不猜**: 带序 = `bands` 序, 列序 = `col`, 行序 = `row`, 迁移序 = 数组序, 色 = `tone`。
 * 会算的全是"内容驱动的下限"(盒宽走 `nodeFit`, 列距走账本, 跨度走声明), 不给"该给多少" ——
 * 想更松就传旋钮。
 */
export function buildLifecycle(spec: LifecycleSpec): { scene: Scene; opts: ExportOptions; plan: LifecyclePlan } {
  const D = LIFECYCLE_DEFAULTS;
  const level: AuditLevel = spec.level ?? 'showcase';
  const theme = spec.theme ?? THEMES.light;
  // 十五个版式旋钮一次收齐(缺省回落 + 越界当场抛全在 `resolveKnobs` 里), 键集 = LIFECYCLE_DEFAULTS 的键
  const {
    colGapMin, boxGap, rowGap, bandGap, bandPad, bandLabelGap, ruleRaise, bandLabelRaise,
    labelGap, laneStep, railClear, corridorClear, legendLead, legendReserve, margin,
  } = resolveKnobs('lifecycle', D, spec);

  // --- ① 入参守卫(畸形是编程错误, 当场抛 —— 与 core 的 guard.ts 同一口径) ---

  const bands = spec.bands;
  if (!bands.length) {
    throw new ShapeInputError('lifecycle', 'bands', '是空数组', '至少一段; 段序 = 数组序, 模板不替你排行');
  }
  const bandIdx = new Map<string, number>();
  bands.forEach((b, i) => {
    if (!b?.id) throw new ShapeInputError('lifecycle', `bands[${i}].id`, '缺失', 'id 是状态引用段带的唯一键');
    if (!b.label) throw new ShapeInputError('lifecycle', `bands[${i}].label`, '缺失', '段带要有一行可读的标签; 空标签会上屏一条无名分隔线');
    if (bandIdx.has(b.id)) throw new ShapeInputError('lifecycle', `bands[${i}].id`, `与前面的段带重名(${b.id})`, '段带 id 必须唯一');
    if (b.spanMin !== undefined && (!Number.isFinite(b.spanMin) || b.spanMin < 0)) {
      throw new ShapeInputError('lifecycle', `bands[${i}].spanMin`, `不是 ≥0 的有限数(${String(b.spanMin)})`, 'spanMin 是"这段声明至少多宽"(px); 不想要就整条别写');
    }
    bandIdx.set(b.id, i);
  });

  const states = spec.states;
  if (!states.length) {
    throw new ShapeInputError('lifecycle', 'states', '是空数组', '状态机总得有个状态; 成员是作者决策, 模板不替你定');
  }
  const stateById = new Map<string, LifecycleState>();
  states.forEach((s, i) => {
    if (!s?.id) throw new ShapeInputError('lifecycle', `states[${i}].id`, '缺失', 'id 是迁移引用状态的唯一键');
    if (!s.label) throw new ShapeInputError('lifecycle', `states[${i}].label`, '缺失', '状态盒要有可读的标签; 空标签会上屏一块空白');
    if (stateById.has(s.id)) throw new ShapeInputError('lifecycle', `states[${i}].id`, `与前面的状态重名(${s.id})`, '状态 id 必须唯一');
    if (!bandIdx.has(s.band)) {
      throw new ShapeInputError('lifecycle', `states[${i}].band`, `不是任何段带 id(${String(s.band)})`, `已知段带: ${bands.map((b) => b.id).join(' / ')}`);
    }
    if (!Number.isInteger(s.col) || s.col < 0) {
      throw new ShapeInputError('lifecycle', `states[${i}].col`, `不是 ≥0 的整数(${String(s.col)})`, '列号是**共享列空间**的下标: 跨带对齐靠它(同列号 ⇒ 同列心)');
    }
    if (s.row !== undefined && (!Number.isInteger(s.row) || s.row < 0)) {
      throw new ShapeInputError('lifecycle', `states[${i}].row`, `不是 ≥0 的整数(${String(s.row)})`, '带内第几行; 缺省 0');
    }
    stateById.set(s.id, s);
  });

  // 格子唯一: 一个 (带, 列, 行) 只放一个盒 —— 两个叠一起是硬撞, 门禁会红, 但那时已经出了一半图
  const cell = new Map<string, string>();
  states.forEach((s, i) => {
    const key = `${s.band}#${s.col}#${s.row ?? 0}`;
    const prev = cell.get(key);
    if (prev) {
      throw new ShapeInputError(
        'lifecycle', `states[${i}].id`, `${s.id} 与 ${prev} 挤在同一格(带 ${s.band} / 列 ${s.col} / 行 ${s.row ?? 0})`,
        '一格只放一个盒; 想并排就换列, 想上下就换行 —— 归属是作者决策, 模板不替你挪',
      );
    }
    cell.set(key, s.id);
  });

  const cols = states.map((s) => s.col);
  const nCols = Math.max(...cols) + 1;

  // 段带的可见跨度 = **跨列声明**(优先) 或 成员列区间; 声明必须装得下成员
  const bandSpan = bands.map((b, k) => {
    const members = states.filter((s) => s.band === b.id);
    if (!members.length && (b.from === undefined || b.to === undefined)) {
      throw new ShapeInputError(
        'lifecycle', `bands[${k}].from`, '本带没有任何成员, 又没声明跨列区间',
        `模板无从知道 ${b.id} 该跨哪几列; 要么放状态进来, 要么把 from/to 写全`,
      );
    }
    const lo = members.length ? Math.min(...members.map((s) => s.col)) : (b.from as number);
    const hi = members.length ? Math.max(...members.map((s) => s.col)) : (b.to as number);
    const from = b.from ?? lo;
    const to = b.to ?? hi;
    for (const [key, v] of [['from', from], ['to', to]] as const) {
      if (!Number.isInteger(v) || v < 0) {
        throw new ShapeInputError('lifecycle', `bands[${k}].${key}`, `不是 ≥0 的整数(${String(v)})`, '跨列声明是列号区间(含两端), 就是共享列空间的下标');
      }
    }
    if (to < from) {
      throw new ShapeInputError('lifecycle', `bands[${k}].to`, `小于 from(${from} > ${to})`, '区间按列号给(左小右大); 想跨哪几列就写清 from/to, 模板不替你交换');
    }
    const outside = members.filter((s) => s.col < from || s.col > to).map((s) => s.id);
    if (outside.length) {
      throw new ShapeInputError(
        'lifecycle', `bands[${k}].from`, `声明的跨度 [${from}, ${to}] 装不下成员 ${outside.join(' / ')}`,
        `${b.id} 的成员实际落在列 [${lo}, ${hi}]; 要么改声明, 要么把状态挪回带内`,
      );
    }
    return { id: b.id, from, to };
  });

  const transitions = spec.transitions;
  transitions.forEach((t, i) => {
    for (const k of ['from', 'to'] as const) {
      if (typeof t?.[k] !== 'string' || !stateById.has(t[k])) {
        throw new ShapeInputError(
          'lifecycle', `transitions[${i}].${k}`, `不是任何状态 id(${String(t?.[k])})`,
          `已知状态: ${states.map((s) => s.id).join(' / ')}`,
        );
      }
    }
    (t.via ?? []).forEach((p, j) => {
      if (!p || !Number.isFinite(p?.x) || !Number.isFinite(p?.y)) {
        throw new ShapeInputError(
          'lifecycle', `transitions[${i}].via[${j}]`, `不是有限坐标(${JSON.stringify(p)})`,
          'via 是**绝对坐标**折点; 给了就按声明原样走(永不静默改写), 所以要写完整',
        );
      }
    });
  });

  // --- ② 尺寸: 盒高全图一个(顶排才齐), 盒宽逐列取该列成员的 max ---

  const fitOf = new Map(states.map((s) => [s.id, nodeFit({ label: s.label, sub: s.sub, level })]));
  const boxH = Math.max(...states.map((s) => (fitOf.get(s.id) as { h: number }).h));
  const colW = Array.from({ length: nCols }, (_, i) => {
    const w = states.filter((s) => s.col === i).map((s) => (fitOf.get(s.id) as { w: number }).w);
    return w.length ? Math.max(...w) : 0;
  });

  // --- ③ 迁移的走廊族 / 通道序 / 标签尺寸, 全部先于几何算 ---
  //
  // 族由**拓扑**定(同列 / 同带前行 / 跨带下行 / 回流), 不由模板猜先后 —— 先后是数组序。
  // 通道序: 同一条走廊里谁贴内由**声明序**决定(先声明的贴内, 后声明的往外错开)。
  const famOf = (t: LifecycleTransition): RouteFamily => {
    if (t.via?.length) return 'via';
    const a = stateById.get(t.from) as LifecycleState;
    const b = stateById.get(t.to) as LifecycleState;
    if (a.col === b.col) return 'same-col';
    const ka = bandIdx.get(a.band) as number;
    const kb = bandIdx.get(b.band) as number;
    if (ka === kb) return b.col > a.col ? 'chain' : 'back';
    return kb > ka ? 'down' : 'back';
  };

  type Slot = {
    t: LifecycleTransition; i: number; id: string; family: RouteFamily;
    /** 折点要落在哪一段带的"分隔线上方走廊"里(下行 / 回流才有) */
    corridorBand: number; lane: number; corridor: string;
    /** 回边的**竖走廊**走哪一格列距(源与目标之间最近的那一格); 其余族 = -1 */
    gapIdx: number;
    /** 标签尺寸(与上屏那份同源) */
    size: { width: number; height: number } | null;
  };
  const laneCursor = new Map<number, number>();
  /** 每条段带上方的走廊要装几条横段 + 有没有标签 —— 行 y 的走廊高度按它算 */
  const laneCount = new Map<number, number>();
  const corridorLabel = new Map<number, number>();

  const slots: Slot[] = transitions.map((t, i) => {
    const family = famOf(t);
    const a = stateById.get(t.from) as LifecycleState;
    const b = stateById.get(t.to) as LifecycleState;
    const kb = bandIdx.get(b.band) as number;
    const needsLane = family === 'down' || family === 'back';
    const lane = needsLane ? laneCursor.get(kb) ?? 0 : -1;
    if (needsLane) laneCursor.set(kb, lane + 1);
    // 回边竖走廊: **源与目标之间最近的那一格** —— 它比"最左外通道"短得多(见 ⑦ 段的账)
    const gapIdx = family === 'back' ? Math.min(a.col, b.col) : -1;
    const size = t.label ? labelBoxSize(t.label) : null;
    if (needsLane && size) corridorLabel.set(kb, Math.max(corridorLabel.get(kb) ?? 0, size.height));
    return {
      t, i, id: t.id ?? `t${i}`, family,
      corridorBand: kb, lane, gapIdx,
      corridor: needsLane ? `above:${bands[kb].id}${gapIdx >= 0 ? `/gap:col${gapIdx}|col${gapIdx + 1}` : ''}` : family,
      size,
    };
  });
  laneCursor.forEach((n, k) => laneCount.set(k, n));

  // --- ④ 列距: 需求们 → 一维约束账本, 交给 `solveAxis` 解 ---
  //
  // 一格列距 = 相邻两列心的距离, 它要同时满足:
  //
  //   盒需   (colW_i + colW_{i+1}) / 2 + boxGap      ↑ 半宽之和 + 净空, 不是"两个盒宽"
  //   版式下限 colGapMin                              (内容都不长时的观感兜底)
  //   标签需 chain:   size.width + 2·labelGap         (贴在列距中点的线上方, 两侧各留净空)
  //         same-col: labelGap + size.width + 半宽_右  (竖线右侧的标签不许伸进右邻盒)
  //
  // **跨列**需求(这是账本存在的理由, 逐格取 max 已经不够):
  //   段带声明  positions[to] − positions[from] + 两端半宽 ≥ spanMin
  //             ⇒ 反解出列心距下界 = spanMin − (colW[from] + colW[to]) / 2
  //   要求沿链累积 —— 一条跨 3 格的声明会把三格一起顶开, `needs[].by` 逐格记 `band:<id>`。
  //   下界 ≤ 0 时不喂(光靠逐格盒宽就已经比 spanMin 宽了, 喂一条零距离的要求只是噪声)。
  //
  // 账本解出来的是**相对**列距(origin = 0), 绝对坐标留给 ⑤ 加锚点 —— 内核的 0.1 量化碰不到锚点。
  // 向上取整到整像素是**模板的政策**(像素不要小数尾巴), 内核只保证"≥ 需求"。
  const axisConstraints: AxisConstraint[] = [];
  const boxNeeds: number[] = [];
  for (let i = 0; i < nCols - 1; i++) {
    const box = Math.ceil((colW[i] + colW[i + 1]) / 2 + boxGap);
    boxNeeds.push(box);
    axisConstraints.push({ from: i, to: i + 1, minimum: colGapMin, contributor: 'colGapMin' });
    axisConstraints.push({ from: i, to: i + 1, minimum: box, contributor: `box:col${i}→col${i + 1}` });
  }
  /** 竖线右侧的标签伸到哪儿为止 —— 画布右缘要用(末列时列距装不下它) */
  let rightTail = 0;
  for (const s of slots) {
    if (!s.size) continue;
    const a = stateById.get(s.t.from) as LifecycleState;
    const b = stateById.get(s.t.to) as LifecycleState;
    if (s.family === 'chain' && b.col === a.col + 1) {
      axisConstraints.push({ from: a.col, to: b.col, minimum: Math.ceil(s.size.width + 2 * labelGap), contributor: `label:${s.id}` });
    } else if (s.family === 'same-col' && a.col + 1 < nCols) {
      axisConstraints.push({
        from: a.col, to: a.col + 1,
        minimum: Math.ceil(labelGap + s.size.width + colW[a.col + 1] / 2), contributor: `label:${s.id}`,
      });
    } else if (s.family === 'same-col') {
      // 末列的竖线标签伸到画布右边去了 —— 列距装不下, 由画布兜住
      rightTail = Math.max(rightTail, labelGap + s.size.width);
    }
  }
  for (const sp of bandSpan) {
    const b = bands[bandIdx.get(sp.id) as number];
    if (sp.to === sp.from) continue;
    const min = Math.ceil((b.spanMin ?? 0) - (colW[sp.from] + colW[sp.to]) / 2);
    if (min <= 0) continue;
    axisConstraints.push({ from: sp.from, to: sp.to, minimum: min, contributor: `band:${sp.id}` });
  }
  // 回边的竖走廊要能从相邻两列的盒之间**穿过去** —— 这是"走廊净空", 与上面 `box:` 那条
  // (盒与盒的净空)是**两个不同的要求**: 各喂一条, 谁大谁赢由账本决(不在这里写 max)。
  for (const s of slots) {
    if (s.family !== 'back') continue;
    axisConstraints.push({
      from: s.gapIdx, to: s.gapIdx + 1,
      minimum: Math.ceil((colW[s.gapIdx] + colW[s.gapIdx + 1]) / 2 + 2 * railClear),
      contributor: `rail:${s.id}`,
    });
  }
  const axis = solveAxis({ count: nCols, constraints: axisConstraints });
  const gaps = axis.gaps;

  // --- ⑤ 列心(累加) ---
  //
  // 首列锚点 = margin + 段带标签槽 + 半个盒宽 —— 左槽宽度由**内容反算**
  // (最宽的那条段带标签 + 净空 + 段带两端余量), 不是拍一个常量: 手排示例把它写成 X0 = 64,
  // 换一段更长的标签就得重排一次。
  // ⚠ 与 `templates/sequence.ts` ⑤ 同一条保命政策: 这里**故意**自家累加, 不走账本的 `positions`
  //   —— 带小数的 origin 逐位取和会带进 ulp 级差异, 而产物要求逐字节稳定。
  const labelSizes = new Map(bands.map((b) => [b.id, labelBoxSize(b.label, { fontSize: BAND_LABEL_SIZE })]));
  const labelSlotW = Math.max(...bands.map((b) => (labelSizes.get(b.id) as { width: number }).width));
  const x0 = margin + labelSlotW + bandLabelGap + bandPad;
  const columns: number[] = [x0 + colW[0] / 2];
  for (let i = 1; i < nCols; i++) columns.push(columns[i - 1] + gaps[i - 1]);

  // --- ⑥ 行 y 与段带 y: 与列距**同构**的一维账本(变量 = 各带内容顶) ---
  //
  // 约束 `k → k+1` 的下界 = 带 k 的内容高 + 那段走廊(要同时容下 ① 段带标签 ② 下行 / 回流的
  // 横向通道 ③ 分隔线本身): 旋钮(`bandGap`)与需求(`headroom`)各喂一条, 谁大谁赢由账本决
  // —— 与 ④ 段 `rail:` 同一条政策, 不在这里写 max, `plan.yNeeds[].by` 于是读得出是谁顶开的。
  const maxLabelH = Math.max(0, ...bands.map((b) => (labelSizes.get(b.id) as { height: number }).height));
  /** 某段带上方的需求高度(从它的内容顶面往上量) */
  const headroom = (k: number): number => {
    const n = laneCount.get(k) ?? 0;
    const laneZone = n ? corridorClear + (n - 1) * laneStep + (corridorLabel.get(k) ?? 0) + labelGap + laneStep : 0;
    return ruleRaise + Math.max(bandLabelRaise + maxLabelH / 2, laneZone);
  };
  const subRows = bands.map((b) => Math.max(1, ...states.filter((s) => s.band === b.id).map((s) => (s.row ?? 0) + 1)));
  const bandContentH = (k: number): number => subRows[k] * boxH + (subRows[k] - 1) * rowGap;
  const yConstraints: AxisConstraint[] = [];
  for (let k = 0; k + 1 < bands.length; k++) {
    const h = bandContentH(k);
    yConstraints.push({ from: k, to: k + 1, minimum: h + bandGap, contributor: 'bandGap' });
    yConstraints.push({ from: k, to: k + 1, minimum: h + headroom(k + 1) + laneStep, contributor: `corridor:${bands[k + 1].id}` });
  }
  const yAxis = solveAxis({ count: bands.length, constraints: yConstraints });
  // ⚠ 与 ⑤ 同一条保命政策: 账本解的是**相对**带顶(origin = 0), 绝对坐标在这里自家累加 —— 带小数
  //   的锚点逐位取和会带进 ulp 级差异, 而产物要求逐字节稳定(260925 实测: 九份 demo 变体逐字节同)。
  const bandTop: number[] = [margin + headroom(0)];
  for (let k = 1; k < bands.length; k++) bandTop.push(bandTop[k - 1] + yAxis.gaps[k - 1]);
  const bandBottom = (k: number): number => bandTop[k] + bandContentH(k);
  const ruleY = (k: number): number => bandTop[k] - ruleRaise;
  /** 第 k 段带上方的横向走廊里第 i 条的 y(从分隔线往上错开) */
  const laneY = (k: number, i: number): number => ruleY(k) - corridorClear - i * laneStep;

  const rowY = (s: LifecycleState): number => bandTop[bandIdx.get(s.band) as number] + (s.row ?? 0) * (boxH + rowGap);

  // --- ⑦ 装配: 盒 / 迁移边 / 段带分隔线与标签 / 边标签 ---

  const boxOf = (s: LifecycleState): Rect => ({
    x: Math.round(columns[s.col] - colW[s.col] / 2), y: rowY(s), w: colW[s.col], h: boxH,
  });
  const boxes: Record<string, Rect> = {};
  const nodes: SceneNode[] = states.map((s) => {
    const rect = boxOf(s);
    boxes[s.id] = rect;
    return {
      id: s.id, rect, label: s.label, sub: s.sub,
      tone: s.tone,
      // tint = 角色色; solid = 强调 —— 只给主角(focus), 满图实色等于没有重点
      variant: s.variant ?? (s.focus ? 'solid' : 'tint'),
      radius: s.radius ?? 8,
    };
  });

  const face = (r: Rect, side: Side): { x: number; y: number } => rectFace(r, side, { offset: 0 });
  /**
   * 列心 —— **几何唯一口径**: 竖线/横段的 x 一律从盒面反推, 不从 `columns` 直接取。
   * `columns` 是账本解出的**名义**列心(带 0.1 格尾巴), 而盒左缘是 `Math.round` 过的整像素
   * (模板政策); 两处各取各的会差出零点几像素 —— `orthogonal_edges` 会当场报"第 N 段不正交",
   * 而 `no_backtrack` 还会把那一丁点横漂读成"折回"(实测: 0.3px 就够报两条 error)。
   */
  const cxOf = (r: Rect): number => r.x + r.w / 2;
  /** 某列盒的左缘 / 某格列距的**正中间**(回边竖走廊的 x = 两侧盒面的中点, 到两盒等距) */
  const boxLeftOf = (col: number): number => Math.round(columns[col] - colW[col] / 2);
  // 中点走 `vec.mid`(同一句话别在两处各写一遍): 左邻盒右面 ↔ 右邻盒左面的中点
  const railXOf = (g: number): number => mid({ x: boxLeftOf(g) + colW[g], y: 0 }, { x: boxLeftOf(g + 1), y: 0 }).x;

  /** 去重 + 去共线: 同列下落必须塌成 **2 点直线**(判据 ②), 折点里的重合点也不许留 */
  const squash = (pts: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> => {
    const out: Array<{ x: number; y: number }> = [];
    for (const p of pts) {
      const last = out[out.length - 1];
      if (last && last.x === p.x && last.y === p.y) continue;
      out.push(p);
    }
    let changed = true;
    while (changed && out.length > 2) {
      changed = false;
      for (let i = 1; i < out.length - 1; i++) {
        const a = out[i - 1], b = out[i], c = out[i + 1];
        if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) {
          out.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
    return out;
  };

  const edges: SceneEdge[] = [];
  const labels: SceneLabel[] = [];
  const routes: LifecyclePlan['routes'] = [];
  let railSeq = 0;

  for (const s of slots) {
    const a = stateById.get(s.t.from) as LifecycleState;
    const b = stateById.get(s.t.to) as LifecycleState;
    const ra = boxes[a.id], rb = boxes[b.id];
    const ka = bandIdx.get(a.band) as number, kb = bandIdx.get(b.band) as number;
    const ca = cxOf(ra), cb = cxOf(rb);
    let pts: Array<{ x: number; y: number }>;
    if (s.family === 'via') {
      pts = [face(ra, s.t.fromSide ?? 'left'), ...(s.t.via as Array<{ x: number; y: number }>), face(rb, s.t.toSide ?? 'top')];
    } else if (s.family === 'same-col') {
      // 同列 ⇒ 端口同 x ⇒ 直线; 判据 ② 的第一条, 这里不许插折点
      pts = ka === kb
        ? (a.row ?? 0) < (b.row ?? 0) ? [face(ra, 'bottom'), face(rb, 'top')] : [face(ra, 'top'), face(rb, 'bottom')]
        : (ka < kb ? [face(ra, 'bottom'), face(rb, 'top')] : [face(ra, 'top'), face(rb, 'bottom')]);
    } else if (s.family === 'chain') {
      // 同带前行: 右出左入, 一条直线
      pts = [face(ra, 'right'), face(rb, 'left')];
    } else {
      const ly = laneY(kb, s.lane);
      if (s.family === 'down') {
        // 岔路下行: 出底 → 落到目标带上方的走廊 → 横到目标列 → 进顶
        pts = [face(ra, 'bottom'), { x: ca, y: ly }, { x: cb, y: ly }, face(rb, 'top')];
      } else if (ka === kb) {
        // 同带回流: 本带上方的走廊绕(出顶 → 横 → 进顶)
        pts = [face(ra, 'top'), { x: ca, y: ly }, { x: cb, y: ly }, face(rb, 'top')];
      } else {
        // 跨带回流: 从源盒**朝间隙的那一侧**出 → 沿"源与目标之间最近的列间隙"竖着升到目标带上方的
        // 走廊 → 横到目标列 → 进目标顶。
        // ⚠ 不走"最左的外通道": 那条路的横段要横扫全图, 同一条回边会胀到画布对角的 1.2 倍
        //   (`long_edge` 报"横扫全图"), 而列间隙走廊把它压到 ~30%。走廊的净空不是撞运气 ——
        //   ④ 喂了一条列距约束(`rail:<id>`), 账本保证两侧都让得开。
        const from = face(ra, a.col <= s.gapIdx ? 'right' : 'left');
        const railX = railXOf(s.gapIdx) - railSeq * laneStep;
        railSeq += 1;
        pts = [from, { x: railX, y: from.y }, { x: railX, y: ly }, { x: cb, y: ly }, face(rb, 'top')];
      }
    }
    const points = squash(pts);
    edges.push({ id: s.id, from: s.t.from, to: s.t.to, points, tone: s.t.tone });
    routes.push({
      id: s.id, from: s.t.from, to: s.t.to, family: s.family,
      corridor: s.family === 'via' ? 'declared' : s.corridor,
      points, declarative: s.family === 'via',
    });

    // 边标签: 落位由本模板推导, 显式交给 `edgeLabel`(`at` 一给, core 就不再算它自己那套落位)
    if (!s.size || !s.t.label) continue;
    const h = s.size.height / 2 + labelGap;
    let at: { x: number; y: number };
    if (s.family === 'chain') {
      // 前行边: 落在这一条横线的中点上方(自身半高 + labelGap)
      at = { x: (ca + cb) / 2, y: face(ra, 'right').y - h };
    } else if (s.family === 'same-col') {
      // 竖线右侧: x 贴线 + labelGap + 半宽; y 取两盒之间的竖直中点(上盒底 ↔ 下盒顶)
      at = { x: ca + labelGap + s.size.width / 2, y: mid({ x: 0, y: ra.y + ra.h }, { x: 0, y: rb.y }).y };
    } else if (s.family === 'via') {
      // **via 单独一支**: 折点是作者声明的绝对坐标, 与 `lane` / "目标带上方的走廊"毫无关系 ——
      // `via` 的 `s.lane` 恒为 -1(③ 只给 down / back 发通道), 走下面那条 `laneY(kb, -1)` 只会
      // 算出目标带分隔线上方的**凭空位置**。落位取声明折点串(`squash` 后)的**中段中点**, 再按
      // 与其余族**同一口径抬到线上方 h**(偶数段取靠后那一段, `points` 中点法自然如此)。
      // ⚠ 260925 前这里是"字面骑线": 遮罩片(与画布同色)会把那一段线切出一个洞, 观感与邻支不一。
      const k = Math.floor((points.length - 1) / 2);
      const on = mid(points[k], points[k + 1]);
      at = { x: on.x, y: on.y - h };
    } else {
      // 下行 / 回流: 落在各自那条横向走廊上(走廊 y 由 `laneY` 定, 见 ⑥)
      at = { x: (ca + cb) / 2, y: laneY(kb, s.lane) - h };
    }
    // tone 与上面那条边同源(260925): 迁移边有肤色(`s.t.tone`, 上面 `edges.push` 那个值), 标签字色跟着走
    labels.push(edgeLabel({ id: s.id, points, tone: s.t.tone }, s.t.label, { at }));
  }

  // 段带分隔线 + 标签: 分隔线是**版式基准线**, 走 `SceneEdge.noCheck`(与泳道线同族);
  // 它同时就是"这一段从哪到哪"的唯一权威 —— 跨度 = 声明的两端列 ± bandPad。
  const edgeStyles: ExportOptions['edgeStyles'] = {};
  const texts: NonNullable<Scene['texts']> = [];
  const bandPlans: LifecyclePlan['bands'] = [];
  bands.forEach((b, k) => {
    const sp = bandSpan[k];
    const left = Math.round(columns[sp.from] - colW[sp.from] / 2 - bandPad);
    const right = Math.round(columns[sp.to] + colW[sp.to] / 2 + bandPad);
    const y = ruleY(k);
    edges.push({ id: `band-${b.id}`, points: [{ x: left, y }, { x: right, y }], noCheck: true, tone: b.tone });
    edgeStyles[`band-${b.id}`] = bandRuleStyle(theme);
    // 段带标签: `at` 是 start 锚的**左中** —— 左缘贴"段带左缘 − 标签净空 − 标签槽宽",
    // 垂直给块心(槽量盒取整顶 + 半高); 盒尺寸由 textFit 反算
    const slot = labelSizes.get(b.id) as { width: number; height: number };
    const note = textNote({
      id: `band-label-${b.id}`,
      content: b.label,
      at: {
        x: Math.round(left - bandLabelGap - slot.width),
        y: Math.round(y - bandLabelRaise - slot.height / 2) + slot.height / 2,
      },
      fontSize: BAND_LABEL_SIZE,
      anchor: 'start',
      color: theme.groupText,
    });
    texts.push(note);
    bandPlans.push({
      id: b.id, from: sp.from, to: sp.to, declared: b.spanMin ?? 0,
      span: columns[sp.to] - columns[sp.from] + colW[sp.from] / 2 + colW[sp.to] / 2,
      rule: { x: left, y, w: right - left }, label: note.rect,
    });
  });

  const contentBottom = bandBottom(bands.length - 1);
  const legendAnchor = { x: x0, y: contentBottom + legendLead };

  // --- ⑧ 画布 ---
  //
  // 内容包围盒(盒 + 段带标签 + 折点)往外 margin —— `fit: true` 下这些声明数只是兜底与 `plan` 可读
  // (手排示例实测过同一件事: `fitScene` 走 `contentBounds`, 声明的宽高根本不进产物)。
  // ⚠ 边标签的矩形**不并进来**: `SceneLabel` 不上报 rect(遮罩片由 core 在出口算), 而末列竖线
  //   标签伸出去的那一截由 `rightTail` 兜 —— 两处都在算同一个直角边只会变成第二权威。
  const extent = bounds([
    ...Object.values(boxes),
    ...texts.map((t) => t.rect),
    ...edges.flatMap((e) => e.points.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 }))),
  ], { pad: margin }) as Rect;
  const width = Math.round(extent.w + rightTail);
  const height = Math.round(extent.h + legendReserve);

  const needs = axis.attribution.map((at, i) => ({ index: i, box: boxNeeds[i], used: gaps[i], by: at.by }));
  const yNeeds = yAxis.attribution.map((at, i) => ({ index: i, content: bandContentH(i), used: yAxis.gaps[i], by: at.by }));

  const scene: Scene = { width, height, nodes, edges, labels, texts };
  const opts: ExportOptions = {
    level, theme, fit: true,
    title: spec.title, fontFamily: spec.fontFamily,
    nodeStyles: spec.nodeStyles,
    edgeStyles: { ...edgeStyles, ...(spec.edgeStyles ?? {}) },
  };
  const plan: LifecyclePlan = {
    columns, gaps, needs, yNeeds, boxes, bands: bandPlans, routes, legendAnchor, width, height,
  };
  return { scene, opts, plan };
}

/**
 * **模板的出口**: 骨架 → 门禁 → 产物。
 *
 * 用的是 `tryExport`(**永不抛**): 门禁没过也给草稿图 + `report.pass === false`;
 * 诊断一律走 stderr、图走 `spec.out` **由脚本自己写**(不经 shell 重定向)。
 * 判决由调用方落到 exit code —— 库不擅自 `process.exitCode`。
 */
export function emitLifecycle(
  spec: LifecycleSpec,
  /**
   * **义务件**的那一笔(图例 / 水印 / 角标): 模板一个图例节点都不出, 只给 `plan.legendAnchor` 的位;
   * 要画就挂在这条口子上 —— 它不改骨架的任何一步, 只是往装配好的 scene 上追加。
   */
  decorate?: (scene: Scene, plan: LifecyclePlan, theme: Theme) => Scene,
): ExportResult {
  const { scene, opts, plan } = buildLifecycle(spec);
  const result = tryExport(decorate ? decorate(scene, plan, opts.theme ?? THEMES.light) : scene, opts);
  if (spec.out) writeFileSync(spec.out, result.svg);
  console.error(
    `lifecycle: pass=${result.report.pass} draft=${result.draft} `
    + `段带=${spec.bands.length} 状态=${spec.states.length} 迁移=${spec.transitions.length} `
    + `画布=${plan.width}x${plan.height} 列距=[${plan.gaps.join(', ')}] `
    + `bytes=${new TextEncoder().encode(result.svg).length}`,
  );
  for (const d of result.report.diagnostics) {
    console.error(`  [${d.severity}] ${d.code} @ ${d.subject.kind}:${d.subject.id} — ${d.message}`, d.evidence);
  }
  return result;
}

// --- 内置示例(演示怎么喂 + 当冒烟用例) --------------------------------
//
// 决策全在这里: 三段带、十个状态、十条迁移、肤色分工 —— 模板一个都没替它定。
// 拓扑与手排示例 `examples/gallery/lifecycle-agent-run.ts` 逐格相同, 以便对照(判据 ① ②):
//   01 五个有序阶段(一行) · 02 暂停与可重试的失败(一行) · 03 两种没有回头路的结束(一行)
//   同列的三条直线: executing→approval→cancelled / reviewing→blocked→expired
//   一条回边: failed→executing 绕"01 段上方"回执行(Executing 的底面被同列的 Needs Approval 盖住)

export const DEMO_LIFECYCLE: LifecycleSpec = {
  title: 'Agent Run Lifecycle',
  bands: [
    { id: 'main', label: '01 / Lifecycle phases', from: 0, to: 4, tone: 'slate' },
    { id: 'wait', label: '02 / Interruptions + Recovery loop', from: 1, to: 3, tone: 'amber' },
    { id: 'term', label: '03 / Terminal exits', from: 2, to: 3, tone: 'rose' },
  ],
  states: [
    { id: 'queued', label: 'Queued', sub: 'request accepted', band: 'main', col: 0, tone: 'blue' },
    { id: 'planning', label: 'Planning', sub: 'build task graph', band: 'main', col: 1, tone: 'emerald' },
    { id: 'executing', label: 'Executing', sub: 'tool calls', band: 'main', col: 2, tone: 'emerald', focus: true },
    { id: 'reviewing', label: 'Reviewing', sub: 'quality gate', band: 'main', col: 3, tone: 'rose' },
    { id: 'completed', label: 'Completed', sub: 'final response', band: 'main', col: 4, tone: 'violet' },
    { id: 'failed', label: 'Failed', sub: 'recoverable error', band: 'wait', col: 1, tone: 'rose' },
    { id: 'approval', label: 'Needs Approval', sub: 'human gate', band: 'wait', col: 2, tone: 'amber' },
    { id: 'blocked', label: 'Blocked', sub: 'missing input', band: 'wait', col: 3, tone: 'amber' },
    { id: 'cancelled', label: 'Cancelled', sub: 'user stopped', band: 'term', col: 2, tone: 'rose' },
    { id: 'expired', label: 'Expired', sub: 'timeout', band: 'term', col: 3, tone: 'rose' },
  ],
  transitions: [
    { id: 'e-queued-planning', from: 'queued', to: 'planning' },
    { id: 'e-planning-executing', from: 'planning', to: 'executing' },
    { id: 'e-executing-reviewing', from: 'executing', to: 'reviewing' },
    { id: 'e-reviewing-completed', from: 'reviewing', to: 'completed' },
    { id: 'e-approval-needed', from: 'executing', to: 'approval', tone: 'amber' },
    { id: 'e-review-blocked', from: 'reviewing', to: 'blocked', tone: 'amber' },
    { id: 'e-approval-cancelled', from: 'approval', to: 'cancelled', tone: 'rose' },
    { id: 'e-block-expired', from: 'blocked', to: 'expired', tone: 'rose' },
    { id: 'e-execution-failed', from: 'executing', to: 'failed', tone: 'rose' },
    { id: 'e-failed-retry', from: 'failed', to: 'executing', tone: 'emerald' },
  ],
  // ⚠ 这 96 在 demo 上**不上屏**: `fit: true` ⇒ 出口 `fitScene` 按内容重定画布, 它只进 `plan.height`
  //   (给不 fit 的调用方一个兜底); 想让图下方真留出图例位, 得关掉 fit 或把图例画进 scene。
  legendReserve: 96,
};

/**
 * **图例是调用方义务, 模板一个图例节点都不出** —— 这里给的是 demo 层那一笔:
 * 色块 + "色调 个数", 个数**从状态表派生**(改一个状态的 tone, 图例自己跟上, 不会与图走散),
 * 位置取 `plan.legendAnchor`(模板只给位)。
 * 它走 `emitLifecycle` 的 `decorate` 位进去 —— 那条口子就是为这类义务件留的, 不是给模板开后门。
 */
export const decorateDemoLegend = (scene: Scene, plan: LifecyclePlan, theme: Theme): Scene => {
  const SWATCH = 11;
  const counts = new Map<Tone, number>();
  for (const s of DEMO_LIFECYCLE.states) if (s.tone) counts.set(s.tone, (counts.get(s.tone) ?? 0) + 1);
  const { x: x0, y } = plan.legendAnchor;
  let x = x0;
  const nodes = [...scene.nodes];
  const texts = [...(scene.texts ?? [])];
  for (const [tone, n] of counts) {
    const content = `${tone} ${n}`;
    const size = labelBoxSize(content);
    // 落位交给 `rightOf`(图例步进宽 = 版式量, 累加**不换 packRow** —— 加法结合序有 ulp 风险):
    // "文字块在色块右边隔 8px"只该有一份口径; `align: 'start'` = 文字块**顶**贴色块顶, 而
    // `at.x` 是文字左缘(`anchor: 'start'`)、`at.y` 要的是**块心** —— 两者不是同一个锚点。
    const swatch: Rect = { x, y, w: SWATCH, h: SWATCH };
    const box = rightOf(swatch, { w: size.width, h: size.height }, 8, { align: 'start' });
    nodes.push({ id: `legend-${tone}`, rect: swatch, tone, variant: 'solid' });
    texts.push(textNote({
      id: `legend-text-${tone}`,
      content,
      at: { x: box.x, y: box.y + box.h / 2 },
      fontSize: BAND_LABEL_SIZE,
      anchor: 'start',
      color: theme.label,
    }));
    x += SWATCH + 8 + size.width + 30;
  }
  return { ...scene, nodes, texts };
};

if (isMainModule(import.meta.url)) {
  const outArg = process.argv.find((a) => a.startsWith('--out='));
  const out = outArg ? outArg.slice('--out='.length) : undefined;
  const dark = process.argv.includes('--dark'); // 笔记配图走 light, deck / 深色页走 dark
  const result = emitLifecycle(
    { ...DEMO_LIFECYCLE, out, theme: dark ? THEMES.dark : THEMES.light },
    decorateDemoLegend,
  );
  if (!out) process.stdout.write(result.svg);
  if (!result.report.pass) process.exitCode = 1;
}
