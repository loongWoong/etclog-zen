// =====================================================================
// templates/layered · 分层架构(带框图)的**起手骨架**
//
//   ┌ 这一层是什么 ────────────────────────────────────────────────┐
//   │ 模板, 不是内核。封装的只有**起手骨架**(盒宽 / 行位 / 层距 /     │
//   │ 层框 / 走廊腰线 / 画布边界 / audit 调用), **决策**一个不碰:    │
//   │ 有几层 / 层序 / 层标签 / 层色调 / 每层几行 / 谁在哪一行哪一格 / │
//   │ 谁连谁 / 端口面 / 语义槽 —— 全由调用方给全。                   │
//   └─────────────────────────────────────────────────────────────┘
//
// ── 整体思路: 从决策到产物, 一条八步的单向流水线 ─────────────────────
//
//   输入  layers(层序 = 数组序; 层内行序 = rows 数组序; 行内次序 = 数组序) · edges(数组序)
//     ↓
//   ① 守卫   决策表合法性(含"哪条边必须显式给端口面")→ 当场抛, 不出半成品
//   ② 盒尺寸 逐节点 nodeFit(内容 + 该档呼吸位) → 盒宽按内容反算; 盒高全图统一(顶排才齐)
//   ③ 横轴   行内 packRow 铺开 → 每行的自然宽; 最宽那行定全图内容宽, **所有行骑同一条中轴**
//   ④ 层距   每层需求(内容高 / 走廊要几条腰线)翻成 AxisConstraint 喂 solveAxis ← ★ 本模板核心推导
//   ⑤ 行位   行 y = 层内容顶 + r·(盒高 + 行距); 网格是等距的, 只有层的**起点**由账本定
//   ⑥ 层框   成员派生(fitGroupFrames) 或 显式铺满全宽(frame: 'declared'), 由调用方选
//   ⑦ 端口   相邻层的竖直边自动选 facing side; 其余一律要调用方显式给(见「端口选面三护栏」)
//   ⑧ 装配   node / group / edge / label 四张表 + assignLanes 摊开走廊腰线 + 画布 fitScene
//     ↓
//   输出  { scene, opts, plan } —— plan 把 ③④⑤⑦⑧ 算过的每个数原样吐出来, 推导可对账
//
// 每一步的推导都写在它自己的段落注释里(公式 + 为什么是这一条), 上面只是骨架地图。
//
// 三条贯穿始终的取舍(读代码前先认下, 否则会觉得"这里为什么要绕"):
//   · **箱体公差与像素政策分家** —— `nodeFit` 给的是"装得下"的内容下限, 盒高取全图 max 是
//     **版式的节奏**(顶排对齐), 不是几何必需; 想更松传 `nodeH`。
//   · **一切最小值都留账** —— `plan.gaps` 记每段层距的四份账(内容 / 走廊腰线 / 实得 / 谁顶住的),
//     最后那份就是 `solveAxis.attribution` 原样带出来的。同一个数只有一处权威: 账本的解就是解。
//   · **模板不猜端口** —— 显式永远赢; 猜不出来(同层边 / 跨层跳边 / 自环 / 非竖直通道)当场抛,
//     逼作者写 `fromSide` / `toSide` 不丢人 —— 门禁看不出来的"引擎悄悄对齐"才是真事故。
//
// ── 端口选面三护栏(收窄版, 缺一不可) ─────────────────────────────────
//   ① 只对**相邻层之间的竖直边**自动选 facing side。这里"竖直边"是**几何判据**而非拓扑愿望:
//      源在本层**末行** ∧ 目标在下层**首行**(或目标是层框) —— 只有这种边, 源盒下方与本层框线
//      之间没有别的东西, 一条竖直/带一段腰线的折线必然落在通道里。源在中间行时"竖直"是假的:
//      它得穿过本层下面那几行节点(`edge_node_clearance` 会当场报穿盒), 那一步是**绕行决策**,
//      必须由作者给面。
//   ② 同层边 / 自环 / 跨层跳边(隔着 ≥2 层)/ 非竖直通道 —— **强制显式给 side**(没给就抛),
//      抛的时候点名边与两个端点 id。判据: 做不到就宁可不做。`alignFacingPorts` 那类
//      "引擎悄悄对齐"的反面教材, 门禁看不出来, 作者也说不清。
//   ③ 调用方显式给了 side **永远赢**(逐端独立: 给了一端, 另一端仍可自动)。
//   `plan.edges[].fromBasis / toBasis` 把"这条边选了哪面、依据是什么"写出来(`explicit` /
//   `auto:adjacent-layer`), 推导可对账。
//
// ── 明确不做 ──────────────────────────────────────────────────────────
//   · **不许猜层序** —— "这个节点该在哪层"一旦由模板推断, 就变成 `layout.suggest` 后门
//     (撞 templates/README 的三条立项判据第 1 条)。层序 = layers 数组序, 层内次序 = 数组序。
//   · **不出图例节点** —— 图例是调用方义务(core 的 legend 缺口记在 README, 模板不另造一份)。
//   · **不做避障 / 不自动挪标签** —— 折线与标签的落位是推导, 绕行是作者权威(那是 `via` 的活)。
//   · **不做换行** —— `\\n` 是作者写下的换行(与 `nodeFit` 同源); 文案是人的决定, 几何不算命。
//
// 用法(库): 模板**不在包的 `exports` 白名单里** —— `import '@watert/svg-infovis/templates/layered.ts'` 解析不到
// (模板源码随包发布, 但没进白名单)。拷本文件到你项目里再 import 本地那份(import 换成包名: 内核对
// `svg-infovis`, 出口对 `svg-infovis/runtime`)—— `svginfo new` 只带 sequence 那份脚手架, 这份手动拷:
//   import { buildLayered, emitLayered } from './my-arch.ts';
//   const { scene, opts, plan } = buildLayered({ layers, edges });   // 想接着改停在这
//   const r = emitLayered({ layers, edges, out: '/tmp/arch.svg' });   // 一步到产物
//   if (!r.report.pass) process.exitCode = 1;
//
// 用法二(内置示例直跑):
//   bun run templates/layered.ts --out=/tmp/arch.svg [--dark]
//
// ⚠ 实测出来的坑(都写进代码了, 改动前先读):
//   ① **层框标题是文本块, 也要参与净空** —— 框内左上角那块标题(`labelPlacement: 'inner'`)
//      进 `textBlocks`, 于是它既是 `text_overlap` 的对家(压节点就报), 又是 `text_clearance`
//      的对家(**任何**一条线靠它 4px 内就报)。所以层框上边距不是"留白口味": 它必须装得下
//      标题盒 —— 这正 `layerPad` 的守卫下限 `padFloor` 的来处(从 core 的 groupLabelRect 现算,
//      不抄一个 33 进来)。
//   ② **层框之间的走廊就是腰线唯一的落位** —— 跨层边两条 stub 都在竖直方向时, `assignLanes`
//      的理想位恰好是"两 stub 中点", 而框线对称时它就是走廊中点, 离两条框线各 `corridor/2`。
//      所以 `layerGap` 旋钮同时决定三件事: 走廊好不好看 / 腰线离框线够不够远(`cluster_border_
//      clearance` 的 `edge_runs_along_border` 阈值 6px) / 一个走廊能摊开几条腰线。
//   ③ **层框形态是作者决策, 不是推导结果** —— `derived`(成员并集 + pad, 框贴着内容)与
//      `band`(显式铺满全宽, 泳道感)是两种表达。`band` 必须显式给 rect 并标 `frame: 'declared'`:
//      派生会把作者给的框覆盖掉(那是 deriveGroupRect 的口径, 别绕过它自己拼框)。
// =====================================================================

import { writeFileSync } from 'node:fs';
import {
  LANE_STEP_MIN,
  ShapeInputError,
  THEMES,
  assertFiniteNumber,
  assertOneOf,
  assignLanes,
  contentBounds,
  edgeLabel,
  expandRect,
  fitGroupFrames,
  groupLabelRect,
  laneSlot,
  nodeFit,
  packRow,
  rectBottom,
  resolveKnobs,
  routeOrthogonal,
  round1,
  solveAxis,
  tryExport,
  type AuditLevel,
  type AxisConstraint,
  type ExportOptions,
  type ExportResult,
  type LanePlan,
  type NodeFitResult,
  type NodeShapeKind,
  type Pt,
  type Rect,
  type RouteRequest,
  type Scene,
  type SceneEdge,
  type SceneGroup,
  type SceneLabel,
  type SceneNode,
  type Side,
  type Theme,
  type Tone,
  type Variant,
} from '@watert/svg-infovis';
import { isMainModule } from '@watert/svg-infovis/runtime';

// --- 契约 --------------------------------------------------------------

/** 端口面词表(与 core 的 `Side` 同一个词表; 运行时用它守 `assertOneOf`) */
const SIDES: readonly Side[] = ['top', 'right', 'bottom', 'left'];

/** 层框形态: `derived` = 成员并集 + pad(框贴内容) / `band` = 显式铺满全宽(泳道感) */
export type LayeredFrameMode = 'derived' | 'band';

/** 选面的依据 —— 写进 `plan`, 让"这条边选了哪面、凭什么"可对账 */
export type SideBasis = 'explicit' | 'auto:adjacent-layer';

/** 一个节点。**盒宽盒高由模板反算**, 这里只有内容与语义槽 */
export type LayeredNode = {
  id: string;
  label: string;
  /** 次标签(小两号, 与 `nodeFit` / `nodeShape` 同一口径) */
  sub?: string;
  /** 语义槽: 这一格在图上是什么角色(入口 / 能力面 / 存储…) */
  tone?: Tone;
  variant?: Variant;
  /** 语义槽: 形状(rect / diamond / cylinder) —— 盒按形状换算, 见 nodeFit */
  shape?: NodeShapeKind;
};

/**
 * 一层(带)。**层序 = 数组序**, **层内行序 = `rows` 数组序**, **行内次序 = 数组序**。
 * 三个"序"全是作者决策, 模板一个都不排 —— 换一组 rows, 图讲的必须是另一件事。
 */
export type LayeredLayer = {
  id: string;
  /** 层框标题(必给: 层框没有标题就只是一块区域, 读不出它是什么层) */
  label: string;
  /** 层框色调(语义槽, 与 `SceneGroup.tone` 同族) */
  tone?: Tone;
  /** 层的各行 —— 数组序即行序(上→下), 行内数组序即列序(左→右) */
  rows: readonly (readonly LayeredNode[])[];
};

/**
 * 一条边。`from` / `to` 是**节点 id 或层 id** —— 指向层 = archify 的 `FLAG --> ctx`
 * (跨层边指向整带), 这时端口落在**层框**上, 且 `cluster_border_clearance` 的
 * "边横穿框"那一条对它天然豁免(边本来就以这个框为端点)。
 */
export type LayeredEdge = {
  /** 边 id(缺省 `e0` / `e1` … 按数组序) */
  id?: string;
  from: string;
  to: string;
  label?: string;
  /** 语义槽: 这条边属于哪一族(主干 / 可选步骤 / 异常回流) */
  tone?: Tone;
  /** 源端端口面; **不给 = 尝试自动选**(仅相邻层的竖直边, 见文件头三护栏) */
  fromSide?: Side;
  /** 目标端端口面; 不给 = 尝试自动选 */
  toSide?: Side;
  /** 源端在面上的位置(0~1 比例, 缺省面中点) —— 端口位置是作者的一个参数, 不是布局算法的运气 */
  fromT?: number;
  /** 目标端在面上的位置(0~1 比例, 缺省面中点) */
  toT?: number;
  /** 边标签沿法线的偏移(缺省 0 = 骑在线上; 遮罩片会切断线, 所以骑线是合法观感) */
  labelDy?: number;
};

export type LayeredSpec = {
  layers: readonly LayeredLayer[];
  edges?: readonly LayeredEdge[];
  /** 层框形态(决策), 缺省 `derived` */
  frame?: LayeredFrameMode;
  // --- 版式旋钮(缺省见 LAYERED_DEFAULTS; 传了就是你说了算) ---
  /** 层内相邻盒的水平净空(px) */
  nodeGapX?: number;
  /** 盒高下限(px); 0 = 只吃 `nodeFit` 的内容下限(版式节奏想给 54 这类值就传) */
  nodeH?: number;
  /** 层内相邻行的垂直净空(px) */
  rowGap?: number;
  /** 层框内边距(px, 四边均匀) —— 必须装得下框内标题盒(守卫会拦) */
  layerPad?: number;
  /** 层框线之间的**走廊**净空(px) —— 跨层腰线跑在这一段里 */
  layerGap?: number;
  /** 腰线离框线的最小留白(px) —— 走廊要摊开 N 条腰线时的下限之一起点 */
  laneGutter?: number;
  /** 出/入盒的直段长度(px) —— 交给 route 的 stub */
  edgeStub?: number;
  /** 画布外侧留白(px); `fit: true` 会据此重定画布, 这里只决定原始坐标系 */
  margin?: number;
  // --- 出口 ---
  level?: AuditLevel;
  theme?: Theme;
  /** 输出路径 —— 给了就由脚本自己落盘(产物不经 shell 重定向) */
  out?: string;
  /** 图表标题(进 `aria-label`) */
  title?: string;
  fontFamily?: string;
  /** 逐元素样式覆盖(最高优先级); 模板不给层框 / 节点 / 边任何缺省样式, 全在 scene 的语义槽里 */
  edgeStyles?: ExportOptions['edgeStyles'];
  nodeStyles?: ExportOptions['nodeStyles'];
  groupStyles?: ExportOptions['groupStyles'];
};

/**
 * 版式缺省 —— **这张表同时就是旋钮的声明**(键集 = 可覆盖的旋钮名, 由 `resolveKnobs` 读取)。
 * 文档引用的就是这一份, 不许在别处再写一遍字面量。注意 **`nodeH: 0`**: 盒高不注入"看起来
 * 应该有多高"的口味, 只吃 `nodeFit` 的内容下限 —— 版式节奏是作者说了算的旋钮, 不是缺省。
 */
export const LAYERED_DEFAULTS = {
  /** 行内盒净空。56 = showcase 档 `node_gap`(12) 的 4 倍出头, 相邻盒之间读得出"两个东西" */
  nodeGapX: 56,
  /** 盒高下限。0 = 只吃内容下限(nodeFit); 作者的版式节奏另给(内置示例给 54) */
  nodeH: 0,
  /** 层内行净空。56 ≈ 一个盒距, 行走廊里还能放下一条腰线(跨行边的 Z 腰线) */
  rowGap: 56,
  /** 层框内边距。40 = 框内标题盒底边(≈27.6) + showcase 档节点净空(12) + 一丝余量, 推导见 padFloor */
  layerPad: 40,
  /** 层框之间的走廊。96 = 一条腰线两侧各 48 的余量, 够摊到 5-6 条腰线才需要动它 */
  layerGap: 96,
  /** 腰线离框线的最小留白(与 `cluster_border_clearance` 的 `edge_runs_along_border`(6px)同向且更松) */
  laneGutter: 16,
  /** 出/入盒直段(route 的 stub) */
  edgeStub: 18,
  /** 画布外侧留白 */
  margin: 40,
} as const;

/** 起手骨架推出来的几何账 —— **可观测**, 别让推导量藏在函数里 */
export type LayeredPlan = {
  /** 逐层: 内容顶 / 层框 / 各行 y / 层内节点 id(与 `rows` 同序拍平) */
  layers: Array<{ id: string; label: string; top: number; frame: Rect; rows: number[]; members: string[] }>;
  /**
   * 逐段层距的账(与 `layers` 同序, 长度 = 层数 - 1)。四份数都在:
   * `content` = 该层内容高 + 双侧 pad + `layerGap`; `lanes` = 同一串但走廊要摊开 N 条腰线;
   * `used` = 账本的解(≥ 两者); `by` = **顶住这一格的 contributor**(`solveAxis.attribution` 原样
   * 带出来, 如 `content:boot` / `lanes:ctx→run`)。差集 + `by` 一起读, 就是"是哪一件把这段顶开的"。
   * `by` 为空 = 没有任何一条约束**紧住**这一段(解被上游链条推出来的), 不是错误。
   */
  gaps: Array<{ from: string; to: string; content: number; lanes: number; used: number; by: string[] }>;
  /** 框线到框线的净空(长度 = 层数 - 1) —— 腰线跑在这一段里 */
  corridors: number[];
  /** 每个节点的盒(`nodeFit` 反算 + 版式行高), 键 = 节点 id */
  boxes: Record<string, Rect>;
  /** 逐边: 两端各选了哪面 + 依据(可对账) + 折点 + 分到的腰线 + route 的可行性标志 */
  edges: Array<{
    id: string;
    from: string;
    to: string;
    fromSide: Side;
    toSide: Side;
    fromBasis: SideBasis;
    toBasis: SideBasis;
    lane: number | null;
    points: Pt[];
    flags: string[];
  }>;
  /** `assignLanes` 的账(带 + 逐边腰线 + 铺不开时的 warning) —— 作者查"为什么这条边没分到 lane"的入口 */
  lanes: LanePlan;
  width: number;
  height: number;
};

// --- 起手骨架 ----------------------------------------------------------

/** 边 id 缺省形态(数组序) —— 与 `sequence` 的 `m0` / `bar:...` 同一手法: id 是机器可读的次序 */
const edgeId = (i: number): string => `e${i}`;

/** 端点解析: 节点盒 或 层框 —— 两条路都在这一个函数里, 端口几何才不会分叉 */
function rectOf(id: string, boxes: Map<string, Rect>, frames: Map<string, Rect>): Rect {
  const r = boxes.get(id) ?? frames.get(id);
  // 走到这里说明守卫漏了 —— 内部不一致用裸 Error(它不是"调用方的畸形入参", 别冒充 ShapeInputError)
  if (!r) throw new Error(`layered 内部不一致: 端点 ${id} 既没有节点盒也没有层框`);
  return r;
}

/**
 * 起手骨架: 决策进, 几何出。
 *
 * 它**只算不猜**: 层序 = `layers` 序, 行序 = `rows` 序, 列序 = 数组序, 色 = `tone`,
 * 端口面 = 作者给的(或相邻层竖直边上唯一确定的那一对)。会算的全是"内容驱动的下限":
 * 盒宽走 `nodeFit`、层距走一维账本(内容高 + 走廊需求)、层框走成员并集 + pad、
 * 腰线走 `assignLanes`、画布走 `fitScene`。
 */
export function buildLayered(spec: LayeredSpec): { scene: Scene; opts: ExportOptions; plan: LayeredPlan } {
  const D = LAYERED_DEFAULTS;
  const level: AuditLevel = spec.level ?? 'showcase';
  const theme = spec.theme ?? THEMES.light;
  // 八个版式旋钮一次收齐(缺省回落 + 越界当场抛全在 `resolveKnobs` 里), 键集 = LAYERED_DEFAULTS 的键
  const { nodeGapX, nodeH, rowGap, layerPad, layerGap, laneGutter, edgeStub, margin } =
    resolveKnobs('layered', D, spec);

  // --- ① 入参守卫(畸形是编程错误, 当场抛 —— 与 core 的 guard.ts 同一口径) ---

  const layers = spec.layers;
  if (!layers?.length) {
    throw new ShapeInputError('layered', 'layers', '是空数组', '至少一层; 层序是作者决策, 模板不替你定');
  }
  const frameMode: LayeredFrameMode = spec.frame ?? 'derived';
  if (frameMode !== 'derived' && frameMode !== 'band') {
    throw new ShapeInputError('layered', 'frame', `不在词表里(拿到 ${JSON.stringify(spec.frame)})`, '只认 derived(成员派生) / band(显式铺满全宽)', '词表参数');
  }

  const layerAt = new Map<string, number>();
  const nodeAt = new Map<string, { layer: number; row: number }>();
  layers.forEach((l, i) => {
    if (!l?.id) throw new ShapeInputError('layered', `layers[${i}].id`, '缺失', 'id 是边引用这一层的唯一键');
    if (layerAt.has(l.id) || nodeAt.has(l.id)) {
      throw new ShapeInputError('layered', `layers[${i}].id`, `与前面的层 / 节点重名(${l.id})`, '层 id 与节点 id 共用一套命名空间(边两端都可能指它们), 必须唯一');
    }
    if (!l.label) throw new ShapeInputError('layered', `layers[${i}].label`, '缺失', '层框要有可读的标题; 没有它这一带读不出是什么层');
    if (!l.rows?.length) {
      throw new ShapeInputError('layered', `layers[${i}].rows`, '一行都没有', '层里至少要有节点: 空的层框只剩一块区域与一个标题, 那不是这一层的内容');
    }
    layerAt.set(l.id, i);
    l.rows.forEach((row, r) => {
      if (!row?.length) {
        throw new ShapeInputError('layered', `layers[${i}].rows[${r}]`, '这一行没有节点', '空行会让这一层的行序与 y 对不上; 不想要这一行就删掉它');
      }
      row.forEach((n, c) => {
        if (!n?.id) throw new ShapeInputError('layered', `layers[${i}].rows[${r}][${c}].id`, '缺失', 'id 是边引用节点的唯一键');
        if (layerAt.has(n.id) || nodeAt.has(n.id)) {
          throw new ShapeInputError('layered', `layers[${i}].rows[${r}][${c}].id`, `与前面的节点 / 层重名(${n.id})`, '节点 id 必须唯一(且不与层 id 撞名)');
        }
        if (!n.label) throw new ShapeInputError('layered', `layers[${i}].rows[${r}][${c}].label`, '缺失', '盒里要有可读的标签; 空标签会上屏一块空白');
        nodeAt.set(n.id, { layer: i, row: r });
      });
    });
  });

  /** 端点 → 层序(节点 id 与层 id 共用一套命名空间) */
  const layerOf = (id: string): number | undefined => layerAt.get(id) ?? nodeAt.get(id)?.layer;
  const isLayerId = (id: string): boolean => layerAt.has(id);

  const edgesIn = spec.edges ?? [];
  edgesIn.forEach((e, i) => {
    for (const k of ['from', 'to'] as const) {
      const id = e?.[k];
      if (typeof id !== 'string' || layerOf(id) === undefined) {
        throw new ShapeInputError(
          'layered', `edges[${i}].${k}`, `不是任何节点 / 层的 id(${String(id)})`,
          `已知层: ${layers.map((l) => l.id).join(' / ')}; 已知节点: ${[...nodeAt.keys()].join(' / ')}`,
        );
      }
    }
    for (const k of ['fromSide', 'toSide'] as const) assertOneOf('layered', `edges[${i}].${k}`, e[k], SIDES, '端口面');
    for (const k of ['fromT', 'toT'] as const) {
      const v = e[k];
      if (v === undefined) continue;
      assertFiniteNumber('layered', `edges[${i}].${k}`, v);
      if (v < 0 || v > 1) {
        throw new ShapeInputError('layered', `edges[${i}].${k}`, `不在 [0, 1] 里(${v})`, '面上的位置是 0~1 的比例(0 = 面的起点侧, 1 = 终点侧); 给绝对像素用 route 的 at, 模板只收比例');
      }
    }
  });

  // --- 端口选面(三护栏, 见文件头) -------------------------------------
  //
  // "竖直边"的判据落在**几何**上: 源在末行 ⇒ 源盒下方到本层框线之间没有别的节点; 目标在首行
  // (或目标是层框)⇒ 目标盒上方到框线之间没有别的节点。两条都成立时, 一条 facing-side 的折线
  // 必然只走"通道"(盒 → 本层 pad → 走廊 → 下层 pad → 盒), 这是**唯一**能自动选面的情形。
  // 其余情形(同层边 / 自环 / 跳层 / 上端不在上层末行 / 下端不在下层首行)的绕行路线是决策, 逼作者给面。
  //
  // ⚠ 判据必须按**上/下**而不是 from/to: 边的方向(dir)是作者写的, 而"竖直通道"这件事只跟
  //   两端各在哪一层的哪一行有关 —— 拿 from 当"上端"会把向上的边整批判错(实测踩过)。
  const whyCannotAuto = (e: LayeredEdge): string => {
    const li = layerOf(e.from) as number;
    const lj = layerOf(e.to) as number;
    if (li === lj) return e.from === e.to ? '是自环(两端同一个节点): 环的走法完全由你定' : '两端在同一层: 同层边的路线是决策';
    if (Math.abs(li - lj) > 1) return `隔着 ${Math.abs(li - lj) - 1} 层(不是相邻层): 绕开中间那层的走法是决策`;
    const upper = Math.min(li, lj);
    const upId = li < lj ? e.from : e.to;
    const downId = li < lj ? e.to : e.from;
    if (!isLayerId(upId) && nodeAt.get(upId)?.row !== layers[upper].rows.length - 1) {
      return `的上端 ${upId} 不在上层末行(它下面还有别的行, 竖直下去会穿过它们)`;
    }
    if (!isLayerId(downId) && nodeAt.get(downId)?.row !== 0) {
      return `的下端 ${downId} 不在下层首行(竖直下来会先穿过它上面那几行)`;
    }
    return ''; // 相邻层之间的一条竖直通道 —— 唯一能自动选面的情形
  };
  const basisOf = (e: LayeredEdge, i: number, end: 'from' | 'to'): { side: Side; basis: SideBasis } => {
    const explicit = end === 'from' ? e.fromSide : e.toSide;
    if (explicit) return { side: explicit, basis: 'explicit' }; // ③ 显式永远赢
    const why = whyCannotAuto(e);
    if (why) {
      throw new ShapeInputError(
        'layered', `edges[${i}].${end}Side`, `没给, 而这条边(${e.from} → ${e.to})${why}`,
        '自动选面只对**相邻层之间的竖直边**成立(上端在上层末行 ∧ 下端在下层首行 / 或那一端就是层框): '
        + '只有这种边走的是"盒 → pad → 走廊 → pad → 盒"的通道。其余情形的绕行路线是**决策**, 模板不猜 —— '
        + `请显式写 ${end}Side(${SIDES.join(' / ')}), 需要时连同 ${end}T 一起给`,
      );
    }
    // 相邻层竖直边: 朝下的那一端出底面, 朝上的那一端进顶面
    const fromUpper = (layerOf(e.from) as number) < (layerOf(e.to) as number);
    return { side: end === 'from' ? (fromUpper ? 'bottom' : 'top') : (fromUpper ? 'top' : 'bottom'), basis: 'auto:adjacent-layer' };
  };

  // --- ② 盒尺寸(盒宽走 nodeFit 反算; 盒高全图统一 —— 顶排才是齐的) ---

  const fitOf = new Map<string, NodeFitResult>();
  for (const l of layers) for (const row of l.rows) for (const n of row) fitOf.set(n.id, nodeFit({ label: n.label, sub: n.sub, level, shape: n.shape }));
  const boxOf = (id: string): NodeFitResult => fitOf.get(id) as NodeFitResult;
  // 盒高: `nodeFit` 给的是内容下限(行数说了算), `nodeH` 是作者加的版式下限 —— 取 max 是为了**对齐**:
  // 各行自扫门前雪会让同一行的盒高低不一, 顶排看着就散了。
  const boxH = Math.max(nodeH, ...[...fitOf.values()].map((f) => f.h));

  // --- ③ 横轴: 行内铺开, 所有行骑同一条中轴 -----------------------------
  //
  // 行的"自然宽"= 盒宽和 + 净空; 全图内容宽 = 最宽的那一行。行的落位是**居中**(骑中轴)
  // —— 这条政策只有一条理由: 层与层之间没有共同的左缘, 居中是唯一与"层序"无关的对称解,
  // 且窄行的两侧留白相等(框不会一边空一边挤)。想左右对齐请改行内成员次序, 别改这里。
  // 行宽 = **那一行铺出来的长度**: 问 `packRow` 要, 不手抄一遍"Σ盒宽 + 净空"(同一句话写两遍必漂)
  const rowWidth = (row: readonly LayeredNode[]): number =>
    (packRow({ items: row.map((n) => ({ w: boxOf(n.id).w, h: boxH })), gap: nodeGapX, x0: 0, y: 0 })
      .bounds as Rect).w;
  const layerRowW = layers.map((l) => l.rows.map(rowWidth));
  const contentW = Math.max(...layerRowW.flat());
  const centerX = margin + contentW / 2;

  // --- ④ 层距: 每层的需求 → 一维约束账本, 交给 `solveAxis` 解 -------------
  //
  // 账本的变量 = **各层内容块的顶边 y**(层框顶 = 内容顶 − layerPad)。相邻两层的约束说的是同一句话:
  //
  //   这段距离 ≥ 该层内容高 + 双侧 pad + 走廊需求
  //
  // 而"走廊需求"有两种来源, **各喂一条约束**(同一个 (i, i+1) 上的多条约束 = 多源竞争, 最长路
  // 取最大的那条, `AxisPlan.attribution` 里读得出是哪一条顶开的):
  //   · 版式下限 + 内容:  `layerGap` —— 走廊本来就该留够(观感下限), 撞上高内容层时被内容顶开
  //   · 走廊腰线条数:    `(k−1)·LANE_STEP_MIN + 2·laneGutter` —— 上下层之间有 k 条边要穿过走廊时,
  //                      腰线要按 15px 起步摊开(与 `assignLanes` 同一把尺子), 走廊不够就只能靠
  //                      投影挤在一起(`lane_band_overflow` 会喊, 但那时已经晚了: 版式该改的是距离)
  //
  // 为什么值得上账本而不是自己写 max: ① 与 `sequence` 的列距同一套推导(两条需求竞争, 谁顶开的
  // 读得出来) ② 一旦出现**跨层**要求(一段距离要给隔层的两件东西让位), 逐段 max 就不再成立
  // —— 要求是沿链累积的, 那正是账本存在的理由。今天本模板还没有跨层需求, 但账目口径先立住。
  //
  // 解出来的是**绝对坐标**(origin = margin + layerPad = 第一层内容顶), 不是增量 —— 内核的
  // 0.1 量化只往上抬, 而这里 origin 与全部 minimum 都是整数(模板政策: 像素不要小数尾巴)。
  const contentH = layers.map((l) => l.rows.length * boxH + (l.rows.length - 1) * rowGap);
  const crossings = layers.map(() => 0);
  for (const e of edgesIn) {
    const li = layerOf(e.from) as number;
    const lj = layerOf(e.to) as number;
    if (Math.abs(li - lj) === 1) crossings[Math.min(li, lj)] += 1;
  }
  const constraints: AxisConstraint[] = [];
  const gaps: LayeredPlan['gaps'] = [];
  for (let i = 0; i < layers.length - 1; i++) {
    const base = contentH[i] + 2 * layerPad; // 该层带高(含 pad), 下一层至少要在它下面
    const k = crossings[i];
    const content = Math.ceil(base + layerGap);
    const lanes = Math.ceil(base + (k === 0 ? 0 : (k - 1) * LANE_STEP_MIN + 2 * laneGutter));
    constraints.push({ from: i, to: i + 1, minimum: content, contributor: `content:${layers[i].id}` });
    if (lanes > content) constraints.push({ from: i, to: i + 1, minimum: lanes, contributor: `lanes:${layers[i].id}→${layers[i + 1].id}` });
    gaps.push({ from: layers[i].id, to: layers[i + 1].id, content, lanes, used: 0, by: [] });
  }
  const axis = solveAxis({ count: layers.length, origin: margin + layerPad, constraints });
  const tops = axis.positions;
  // 每段的实得层距取账本的解, 不再另算一份 max —— 同一个数只许一个来源; `by` 也原样带出来
  gaps.forEach((g, i) => { g.used = axis.gaps[i]; g.by = axis.attribution[i]?.by ?? []; });

  // --- ⑤ 行位 + 节点盒 ------------------------------------------------

  const nodes: SceneNode[] = [];
  const rowYs: number[][] = [];
  const boxes = new Map<string, Rect>();
  layers.forEach((l, i) => {
    const ys = l.rows.map((_, r) => round1(tops[i] + r * (boxH + rowGap)));
    rowYs.push(ys);
    l.rows.forEach((row, r) => {
      const packed = packRow({
        items: row.map((n) => ({ w: boxOf(n.id).w, h: boxH })),
        gap: nodeGapX,
        x0: round1(centerX - layerRowW[i][r] / 2),
        y: ys[r],
        align: 'start',
      });
      row.forEach((n, c) => {
        const rect = packed.rects[c];
        boxes.set(n.id, rect);
        nodes.push({ id: n.id, rect, label: n.label, sub: n.sub, tone: n.tone, variant: n.variant, shape: n.shape });
      });
    });
  });

  // --- ⑥ 层框: 成员派生 or 显式铺满 ------------------------------------
  //
  // 派生框只声明**成员**(`contains`)与标题归属位(`labelPlacement`), `rect` 是占位 —— 框的形状
  // 由 `fitGroupFrames` 按成员并集 + pad 现算。这样的框**结构上不可能**出现"成员跑出框外", 而
  // 标题的矩形由同一个 `labelAnchor` 派生(渲染面与审计面读同一份, 双源老病根除)。
  // `band` 相反: 框是作者给的(全宽横带), 必须显式声明 `frame: 'declared'`, 派生一律跳过。
  const groups: SceneGroup[] = layers.map((l, i) => ({
    id: l.id,
    label: l.label,
    tone: l.tone,
    contains: [...l.rows.flatMap((row) => row.map((n) => n.id))],
    labelPlacement: 'inner',
    rect: frameMode === 'derived'
      ? { x: 0, y: 0, w: 0, h: 0 } // 占位: 一律被 fitGroupFrames 覆盖(取不到会当场抛, 见下)
      // 显式铺满: 内容盒四边各让出 `layerPad` —— 外扩走 `expandRect`(别手抄一遍"四元各减/加一次")
      : expandRect({ x: centerX - contentW / 2, y: tops[i], w: contentW, h: contentH[i] }, layerPad),
    ...(frameMode === 'band' ? { frame: 'declared' as const } : {}),
  }));
  const scaffold: Scene = { width: 0, height: 0, nodes, edges: [], groups };
  const framed = frameMode === 'derived' ? fitGroupFrames(scaffold, { pad: layerPad }).scene : scaffold;
  const frames = new Map<string, Rect>();
  for (const g of framed.groups ?? []) {
    if (g.rect.w <= 0 || g.rect.h <= 0) {
      throw new ShapeInputError('layered', `layers[${g.id}]`, '派生不出层框(宽或高为 0)', '成员都取不到盒时会这样; 那是内部不一致, 不该发生');
    }
    frames.set(g.id, g.rect);
  }
  // 层框标题的**两个守卫下限**(都要 core 的现算值, 不是抄来的常量):
  //   · 上边距: 标题盒(inner 归属位)的底边 —— pad 比它还小 ⇒ 标题压在首行节点上(text_overlap)
  //   · 框宽:   标题盒的右端 —— 框比标题还窄 ⇒ 标题戳出框线(视觉上这带读不出标题)
  layers.forEach((l) => {
    const rect = frames.get(l.id) as Rect;
    const box = groupLabelRect({ ...rect, label: l.label, labelPlacement: 'inner' });
    if (!box) return;
    if (layerPad < Math.ceil(box.y + box.h) - rect.y) {
      throw new ShapeInputError(
        'layered', 'layerPad', `${layerPad} 装不下框内标题(${l.id} 的标题盒底边在框顶 + ${Math.ceil(box.y + box.h) - rect.y}px)`,
        `把 layerPad 调到 ≥ ${Math.ceil(box.y + box.h) - rect.y}px(缺省 ${D.layerPad} 另留了节点净空); 或把层框标题改短 —— 标题压到首行节点上就是 text_overlap`,
      );
    }
    if (box.x + box.w > rect.x + rect.w) {
      throw new ShapeInputError(
        'layered', `layers[${layers.findIndex((x) => x.id === l.id)}].label`, `比这一层的框还宽(${round1(box.x + box.w - rect.x - rect.w)}px 溢出)`,
        '层框宽度由成员盒反算 —— 标题比内容还长就装不下: 把标题改短, 或给这一层更多 / 更宽的成员',
      );
    }
  });

  // --- ⑦ 边: 端口 → route → 走廊腰线 -----------------------------------

  const requests: RouteRequest[] = [];
  const chosen = edgesIn.map((e, i) => {
    const from = basisOf(e, i, 'from');
    const to = basisOf(e, i, 'to');
    return { id: e.id ?? edgeId(i), fromSide: from.side, toSide: to.side, fromBasis: from.basis, toBasis: to.basis, edge: e };
  });
  chosen.forEach((c) => {
    requests.push({
      from: rectOf(c.edge.from, boxes, frames), fromPort: { side: c.fromSide, t: c.edge.fromT },
      to: rectOf(c.edge.to, boxes, frames), toPort: { side: c.toSide, t: c.edge.toT },
      stub: edgeStub,
    });
  });
  // 走廊腰线: 只把**吃得了腰线**的边交给 `assignLanes`。判据走 core 的 `laneSlot`(与 route 同一
  // 份可行域口径, 不许在这里另写一套), 再加两条"这条边真有腰线可挪"的否决:
  //   · `span` 退化(两端 stub 在带轴上同一点)—— 它本来就是一条**直线**, 腰线值动它也不动;
  //     不否决的话逐行的直连边会因为"span 投影重叠"被聚成一个假"带", 白占一次分配(实测踩过)。
  //   · 可行域比 `LANE_STEP_MIN` 还窄 —— 挪得出 15px 才叫错开, 更窄的挪动是自欺。
  // 没分到的边保持 route 的自动位 —— "不干涉"是 `null` 的语义。
  const laneReady = requests.map((r) => {
    const s = laneSlot(r);
    return s !== null && s.span[0] !== s.span[1] && Number.isFinite(s.hi - s.lo) && s.hi - s.lo >= LANE_STEP_MIN;
  });
  const laneTargets = laneReady.map((ok, i) => (ok ? i : -1)).filter((i) => i >= 0);
  const assigned = assignLanes(laneTargets.map((i) => requests[i]));
  /** 边序 → 它在 `assignLanes` 输入里的下标(回填要按位置对, 不能靠 indexOf 猜) */
  const laneAt = new Map<number, number>();
  laneTargets.forEach((gi, k) => {
    laneAt.set(gi, k);
    const v = assigned.plan.lanes[k];
    if (v !== null) requests[gi] = { ...requests[gi], lane: v };
  });

  const sceneEdges: SceneEdge[] = [];
  const sceneLabels: SceneLabel[] = [];
  const edgePlan: LayeredPlan['edges'] = chosen.map((c, i) => {
    const r = routeOrthogonal(requests[i]);
    // `from`/`to` **写**上(节点 id 或层 id): 端口归属与"这条边以该层框为端点"的豁免都靠它
    // 判 —— 与 sequence 的消息边相反(那边端点天生在盒外, 写了会被误判), 这里的端点在盒面上。
    sceneEdges.push({ id: c.id, from: c.edge.from, to: c.edge.to, points: r.points, label: c.edge.label, tone: c.edge.tone });
    // tone 与上面那条边同源(260925): 边有肤色, 标签的字色跟着它走 —— 标签这侧不许另给一个色
    if (c.edge.label) sceneLabels.push(edgeLabel({ id: c.id, points: r.points, tone: c.edge.tone }, c.edge.label, { dy: c.edge.labelDy ?? 0 }));
    const flags: string[] = [];
    if (r.laneProjected) flags.push('laneProjected');
    if (r.laneInfeasible) flags.push('laneInfeasible');
    if (r.laneIgnored) flags.push('laneIgnored');
    if (r.viaInfeasible) flags.push('viaInfeasible');
    return {
      id: c.id, from: c.edge.from, to: c.edge.to,
      fromSide: c.fromSide, toSide: c.toSide, fromBasis: c.fromBasis, toBasis: c.toBasis,
      lane: laneAt.has(i) ? assigned.plan.lanes[laneAt.get(i) as number] : null,
      points: r.points, flags,
    };
  });

  // --- ⑧ 画布 ----------------------------------------------------------
  //
  // 右/下缘取 `contentBounds`(节点 / 层框 / 标题 / 标签 / 折点全在它里面 —— 与 `fitScene`
  // 同一份公式): 与 sequence 的 ⑨ 段同一个处境, `opts.fit: true` 下这两个声明的数不上屏
  // (fitScene 会按内容重定画布), 所以它们的价值只剩"给不 fit 的调用方一个兜底 + plan 可读"。
  const scene: Scene = { width: 0, height: 0, nodes, edges: sceneEdges, labels: sceneLabels, groups: framed.groups };
  const cb = contentBounds(scene);
  const width = cb ? Math.round(cb.x + cb.w + margin) : Math.round(margin * 2);
  const height = cb ? Math.round(cb.y + cb.h + margin) : Math.round(margin * 2);

  const plan: LayeredPlan = {
    layers: layers.map((l, i) => ({
      id: l.id, label: l.label, top: tops[i], frame: frames.get(l.id) as Rect,
      rows: rowYs[i], members: l.rows.flatMap((row) => row.map((n) => n.id)),
    })),
    gaps,
    // 走廊高 = 下一层框顶 − 这一层框底(`rectBottom` 就是"底边"的唯一口径, 别手抄 `y + h`)
    corridors: layers.slice(0, -1).map((l, i) =>
      round1((frames.get(layers[i + 1].id) as Rect).y - rectBottom(frames.get(l.id) as Rect))),
    boxes: Object.fromEntries(boxes),
    edges: edgePlan,
    lanes: assigned.plan,
    width,
    height,
  };
  const opts: ExportOptions = {
    level,
    theme,
    fit: true,
    title: spec.title,
    fontFamily: spec.fontFamily,
    nodeStyles: spec.nodeStyles,
    groupStyles: spec.groupStyles,
    edgeStyles: spec.edgeStyles,
  };
  return { scene: { ...scene, width, height }, opts, plan };
}

/**
 * **模板的出口**: 骨架 → 门禁 → 产物。
 *
 * 与内核出口的分工一字不差(见 SKILL.md「出口」): 用的是 `tryExport`(**永不抛**),
 * 门禁没过也给草稿图 + `report.pass === false`; 诊断一律走 stderr、图走 `spec.out`
 * **由脚本自己写**(不经 shell 重定向)。判决由调用方落到 exit code —— 库不擅自 `process.exitCode`。
 */
export function emitLayered(spec: LayeredSpec): ExportResult {
  const { scene, opts, plan } = buildLayered(spec);
  const result = tryExport(scene, opts);
  if (spec.out) writeFileSync(spec.out, result.svg);
  console.error(
    `layered: pass=${result.report.pass} draft=${result.draft} `
    + `层=${plan.layers.length} 节点=${scene.nodes.length} 边=${scene.edges.length} `
    + `画布=${plan.width}x${plan.height} 层距=[${plan.gaps.map((g) => g.used).join(', ')}] `
    + `走廊=[${plan.corridors.join(', ')}] bytes=${new TextEncoder().encode(result.svg).length}`,
  );
  // 走廊铺不开是**版式面**的事故(与门禁无关), 但它必须被看见 —— 否则作者以为已经错开了
  for (const d of plan.lanes.diagnostics) console.error(`  [${d.severity}] ${d.code} @ ${d.subject.kind}:${d.subject.id} — ${d.message}`);
  for (const d of result.report.diagnostics) {
    console.error(`  [${d.severity}] ${d.code} @ ${d.subject.kind}:${d.subject.id} — ${d.message}`, d.evidence);
  }
  return result;
}

// --- 内置示例(演示怎么喂 + 当冒烟用例) --------------------------------
//
// 决策全在这里: 三层 / 层内分几行 / 谁和谁竖直成对 / 每条边吃哪个面 / 色怎么分 —— 模板一个都没替它定。
// 拓扑与标签与 `examples/gallery/harness-arch.ts`(同图的**手排**对照组, 280 行)同源:
// 同一批层 / 成员 / 连边, 但**排布决策各给一份** —— 手排那份把注入对摆成水平、成对排放在末排
// (出口因此是一条竖直直线, 不必绕走廊), 本模板的选面三护栏只认邻层竖直通道, 于是收成
// "`SESS / LLM / SEAM` 在上、两对竖直成对在下"; 差值就是"起手骨架"值多少行、以及它收窄掉的那些摆法。
//
// 读法: 装配层是一条注入管线(行内次序 = 执行次序); 服务层里 `TOOLS→SP` 与 `LOOP→AG` 是**两对竖直
// 成对**的能力注入 —— 能力在下一排、消费方在上一排, 所以那两条边是直线而非折线; `SESS / LLM / SEAM`
// 是顶排的并列服务面; 运行层两个来源汇聚到 event log。**这就是"谁在哪一排"的全部理由** ——
// 模板不知道这些, 也猜不出: 换一组 rows, 图讲的必须是另一件事。

export const DEMO_LAYERED: LayeredSpec = {
  title: 'DeepSeek-Harness 装配链 · 分层',
  nodeH: 54, // 版式节奏: `nodeFit` 的内容下限是 39, 54 是作者给的行高
  layers: [
    {
      id: 'boot',
      label: '装配层',
      tone: 'slate',
      rows: [[
        { id: 'EMPTY', label: '空 entry list' },
        { id: 'BASE', label: 'dsh-base patch' },
        { id: 'MODE', label: 'web / headless patch' },
        { id: 'USER', label: 'profile + home cordis.patch.yml' },
        { id: 'FLAG', label: '--patch', tone: 'amber', variant: 'tint' }, // 命令行开关: 整条管线的入口
      ]],
    },
    {
      id: 'ctx',
      label: '服务层',
      tone: 'blue',
      rows: [
        [
          { id: 'SESS', label: 'ctx.runs', sub: '追加写 event log' },
          { id: 'LLM', label: 'ctx.llm', sub: '注册 adapter' },
          { id: 'SEAM', label: 'ctx.shell / ctx.fs / ctx.subprocess …' },
        ],
        [
          { id: 'SP', label: 'ctx.systemPrompt', sub: '拼 prompt 段 + tool schema', tone: 'blue', variant: 'tint' },
          { id: 'AG', label: 'ctx.agents', sub: 'Agent 接口、注册表', tone: 'violet', variant: 'tint' },
        ],
        [
          { id: 'TOOLS', label: 'ctx.tools', sub: '工具注册 + 执行管道', tone: 'blue', variant: 'tint' },
          { id: 'LOOP', label: 'ctx.agentLoop', sub: '默认驱动, 可换', tone: 'violet', variant: 'tint' },
        ],
      ],
    },
    {
      id: 'run',
      label: '运行层',
      tone: 'emerald',
      rows: [
        [
          { id: 'INBOX', label: 'agent inbox', tone: 'emerald', variant: 'tint' },
          { id: 'WF', label: 'agent/* 与 tools/* 瀑布', tone: 'emerald', variant: 'tint' },
        ],
        [
          { id: 'LOG', label: 'event log', tone: 'amber', variant: 'tint' }],
      ],
    },
  ],
  edges: [
    // 装配层的注入管线: 层内直线, 两端都是显式面(同层边**必须**显式)
    { id: 'boot-1', from: 'EMPTY', to: 'BASE', fromSide: 'right', toSide: 'left', tone: 'slate' },
    { id: 'boot-2', from: 'BASE', to: 'MODE', fromSide: 'right', toSide: 'left', tone: 'slate' },
    { id: 'boot-3', from: 'MODE', to: 'USER', fromSide: 'right', toSide: 'left', tone: 'slate' },
    { id: 'boot-4', from: 'USER', to: 'FLAG', fromSide: 'right', toSide: 'left', tone: 'slate' },
    // 跨层: 指向**整层**(对应 mermaid 的 `FLAG -->|Loader + inject| ctx`), 端口落在层框顶边上。
    // 两端都在相邻层的竖直通道里 ⇒ 面可以自动选。`toT: 0.85` 是作者决策: 把注入点放到层框右侧,
    // 贴近来源的管线末端(缺省中点会让这条边横跨半个画布, 撞上 `long_edge` 的 40% 基线)。
    { id: 'inject', from: 'FLAG', to: 'ctx', label: 'Loader + inject', tone: 'amber', toT: 0.85 },
    // 服务层的两对竖直注入: 能力在下一排 ⇒ 出顶面进底面, 行内同列 ⇒ 直线(标签落在行的间隙里)
    { id: 'tools', from: 'TOOLS', to: 'SP', label: 'tools provider', tone: 'blue', fromSide: 'top', toSide: 'bottom' },
    { id: 'factory', from: 'LOOP', to: 'AG', label: 'setFactory', tone: 'violet', fromSide: 'top', toSide: 'bottom' },
    // 跨层: `LOOP` 在服务层**末行** ⇒ 面可自动选。`toT: 0.15` 同上, 是入口落点的作者决策
    { id: 'assemble', from: 'LOOP', to: 'run', label: 'assemble / stream / execute', tone: 'violet', toT: 0.15 },
    // 运行层的汇聚: L 形(一出底面、一进侧面) ⇒ `laneSlot` 天然无解, 模板不会白给它分腰线
    { id: 'sink-1', from: 'INBOX', to: 'LOG', fromSide: 'bottom', toSide: 'left', tone: 'emerald' },
    { id: 'sink-2', from: 'WF', to: 'LOG', fromSide: 'bottom', toSide: 'right', tone: 'emerald' },
  ],
};

if (isMainModule(import.meta.url)) {
  const outArg = process.argv.find((a) => a.startsWith('--out='));
  const out = outArg ? outArg.slice('--out='.length) : undefined;
  const dark = process.argv.includes('--dark'); // 笔记配图走 light, deck / 深色页走 dark
  const result = emitLayered({ ...DEMO_LAYERED, out, theme: dark ? THEMES.dark : THEMES.light });
  if (!out) process.stdout.write(result.svg);
  if (!result.report.pass) process.exitCode = 1;
}
