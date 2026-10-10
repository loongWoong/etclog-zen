// =====================================================================
// templates/sequence · 序列图(泳道 × 有序消息)的**起手骨架**
//
//   ┌ 这一层是什么 ────────────────────────────────────────────────┐
//   │ 模板, 不是内核。封装的只有**起手骨架**(列距 / 行距 / 端口偏移 /  │
//   │ 标签落位 / 激活条 / 画布边界 / audit 调用), **决策**一个不碰:   │
//   │ 几条泳道 / 谁在左 / 消息先后 / 谁在哪段是活跃的 / 语义槽 ——      │
//   │ 全由调用方给全。几何判据一条没动 —— 260920 只为激活条多补了一个     │
//   │ 旋钮位(`SceneEdge.noCheck`, 见坑③), 边界见同目录 README 的「宪章」。│
//   └─────────────────────────────────────────────────────────────┘
//
// ── 整体思路: 从决策到产物, 一条九步的单向流水线 ─────────────────────
//
//   输入  actors(列序 = 数组序) · messages(行序 = 数组序) · activations(消息下标区间)
//     ↓
//   ① 守卫    决策表合法性 + 旋钮越界(含 barW 与 msgInset 的联立) → 当场抛
//   ② 盒尺寸  boxH = max(nodeFit(每列内容).h) —— 量的是文字不是拍脑袋; 取 max 是为了顶排齐
//   ③ 落位需求 逐条消息先量一次标签宽(喂 `edgeLabel` 一条单位线), 并定它吃哪一格列距
//   ④ 列距    逐格 gap_i = max(版式下限, 盒需, 标签需)   ← ★ 本模板最核心的一处推导
//   ⑤ 列心    cx_i = cx_{i-1} + gap_{i-1}(纯累加; 首列 = margin + 首个盒的半宽)
//   ⑥ 行 y    row_i = margin + boxH + headGap + i·rowGap(等差)
//   ⑦ 激活条  消息下标 [from..to] → 骑在泳道线中心的圆头竖条(半径 = 半宽)
//   ⑧ 装配    node / edge / label 三张表 —— 消息边不写 from/to, 泳道线写(判据见「三条坑」①)
//   ⑨ 画布    右缘 = max(末列盒右缘, 末列 + 末列自调用尾需); 高 = lifelineBottom + margin
//     ↓
//   输出  { scene, opts, plan } —— plan 把 ④⑤⑥⑦ 算过的每个数原样吐出来, 推导可对账
//
// 每一步的推导过程**都写在它自己的段落注释里**(公式 + 为什么是这一条), 上面只是骨架地图。
//
// 三条贯穿始终的取舍(读代码前先认下, 否则会觉得"这里为什么要绕"):
//   · **列距逐格算, 不取全图最大** —— 一格要宽是那一格自己的事(长标签 / 自调用环),
//     拿全图最大去铺所有格 = 白摊版式。这与 `nodeFit` 给"内容下限"而非"该给多少"同一条立场:
//     版式节奏归作者, 模板只保证"装得下"。
//   · **一切最小值都留账** —— `plan.needs` 记每格列距的三份需求(box / label / used),
//     差集可见: 是哪一件把这个列距顶开的。参照实现里那张 `contributors` 账本同一个设计。
//   · **样式永远走覆盖表** —— 模板给的 lifeline 缺省样式只是"没意见时的样子",
//     调用方的 `edgeStyles` / `nodeStyles` 一个字都优先于它(docs/internals/policies.md 纪律 10)。
//
// 用法(库): 模板**不在包的 `exports` 白名单里** —— `import '@watert/svg-infovis/templates/sequence.ts'` 解析不到
// (模板源码随包发布, 但没进白名单)。先把它拷成你自己项目里的一份, 再 import 本地那份; 要改就改本地:
//   svginfo new my-seq.ts          # 拷本文件到 ./my-seq.ts, 并把 import 换成包名 / `svg-infovis/runtime`
//   import { buildSequence, emitSequence } from './my-seq.ts';
//   const { scene, opts, plan } = buildSequence({ actors, messages, activations }); // 想接着改停在这
//   const r = emitSequence({ ..., out: '/tmp/seq.svg' });                          // 一步到产物
//   if (!r.report.pass) process.exitCode = 1;
//
// 用法二(内置示例直跑):
//   bun run templates/sequence.ts --out=/tmp/seq.svg [--dark]
//
// ⚠ 三条实测出来的坑(都写进代码了, 改动前先读):
//   ① **消息边的 `from`/`to` 一个都不写**。写了就会撞上 `port_crowding` 的第三档
//      (`shared_projected_port`): 那一档把"端点在盒外"读成手写错误 —— 它 clamp 回盒判重合,
//      而序列图的消息端点**天然全在盒外**(在泳道线上), 同一泳道的两条消息必然被 clamp 到同一点。
//      这是 core 对该拓扑的**误报**, 模板侧规避: 不声明 from/to(门禁于是走"就近吸附", 端点离盒
//      ≥14px 自然落空 → 不参与端口判定)。泳道线**可以**写 from/to —— 它端点在盒底边上, 是唯一
//      一端, 不会与谁配成对。
//   ② **消息标签一律抬到线上方**(`labelLift`), 且横向只允许落在**一个列距内**:
//      跨列消息(如 网关 → 数据库, 中间隔着缓存泳道)的标签若居中放, 必然被中间那条泳道线穿过
//      → `label_clearance` error。落法是"贴着源侧的第一个列距"。
//   ③ **激活条骑在泳道线上 ⇒ 该列 lifeline 标 `noCheck`**(260920 加 bar 时实测):
//      bar 骑在泳道线中心, 而 lifeline 是一条贯穿全高的竖线 —— 不处理的话 `edge_node_clearance`
//      会逐条报"lifeline 从 bar 身上穿过"(实测穿透 392 / 112 / 56px, 3 条 error, 全在 lifeline 上)。
//      两种修法实测都全绿, 本模板取后者, 理由写在这里免得后人再试一遍:
//        · 把 lifeline 按 bar 的 y 区间**切成互补的若干段** —— 线真的不画了, 代价是一条泳道线
//          在数据里碎成 N 条不相干的边(产物边数膨胀 / id 变 `life:gw#0` / density 的 `long_edge`
//          中位数基线被短段拉低而冒出一条本不该有的 warning)。**本质是拿拓扑变换迁就门禁**。
//        · 标 `SceneEdge.noCheck`(纯视觉基准线豁免, 与 `SceneGroup.noCheck` 同一套话语体系)——
//          lifeline 是背景基准线, 被自己的装饰骑住是常态, 那条判据对它不成立。数据里仍是完整一条。
//      ⚠ **豁免加在边(泳道线)上, 不加在装饰物(bar)上**, 这是刻意的: 给 bar 开豁免会连带放过
//        "跨列消息横穿中间泳道的 bar"—— 那才是真事故(线横在色条上)。实测: 同图把 bar 拉长到
//        跨列边必经之处, 照报不误(变体 E)。
//      ⚠ 层序是硬约束(core 固定**边画在节点之上**), 所以那截 lifeline 虚线会**看得见**地走在
//        色条中央。要彻底看不见只能分段 —— 实测 tint 底 + 1px 浅灰虚线的观感可接受, 而"泳道线
//        仍是一条连续线"在语义上是更好的信息(它没有断成几截)。
// =====================================================================

import { writeFileSync } from 'node:fs';
import {
  ShapeInputError,
  THEMES,
  edgeLabel,
  labelBoxSize,
  mid,
  nodeFit,
  resolveKnobs,
  solveAxis,
  tryExport,
  type AuditLevel,
  type AxisConstraint,
  type EdgeProps,
  type ExportOptions,
  type ExportResult,
  type LabelBoxSize,
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

/** 一条泳道(参与者)。**列序就是数组序** —— 谁在左是作者决策, 模板不排 */
export type SeqActor = {
  id: string;
  label: string;
  /** 次标签(泳道盒第二行, 同 nodeFit 口径) */
  sub?: string;
  /** 语义槽: 这一列在图上是什么角色(客户端 / 存储 / 外部系统…) */
  tone?: Tone;
  variant?: Variant;
};

/** 一条消息。**行序就是数组序** —— 先后是作者决策, 模板只按 `rowGap` 累加 y */
export type SeqMessage = {
  /** 发起方泳道 id */
  from: string;
  /** 接收方泳道 id; 与 `from` 相同 = 自调用(模板画环回) */
  to: string;
  /** 消息名(边标签) */
  label?: string;
  /** 语义槽: 这条消息属于哪一族(请求 / 返回 / 异常回流) */
  tone?: Tone;
};

/**
 * 一段**激活条**(activation bar)—— 泳道线上的纵向圆角条, 说的是
 * "这段消息区间里这个参与者处于活跃态"(archify 同名元素的对应物)。
 *
 * 区间用**消息下标**表达(`from` ~ `to`, **含两端**), 不用 y 像素 ——
 * 这正是模板该干的活: 作者说"从第几条到第几条", 模板把它翻译成 y 区间 + 圆角矩形 + lifeline 切口。
 * 参照实现里这一项是作者手写 y 像素(`activations[].from/to` 明写 "are y pixel coordinates"),
 * 于是改一行消息就要重排一次激活条; 换成下标之后, 行距怎么调都不用动它。
 */
export type SeqActivation = {
  /** 哪条泳道是活跃的(必须是已知 id) */
  actor: string;
  /** 起始消息下标(含) */
  from: number;
  /** 结束消息下标(含); `from === to` = 只覆盖这一条消息(高度落到 `barMinH`) */
  to: number;
  /** 色(缺省取该泳道的 `tone`, 再缺省 slate) */
  tone?: Tone;
  /** 缺省 `tint`(浅底深边) —— 与 archify 的激活条同档: 抢眼, 但不与 solid 的"唯一权威"抢语义 */
  variant?: Variant;
};

export type SequenceSpec = {
  actors: readonly SeqActor[];
  messages: readonly SeqMessage[];
  /** 激活条(可缺省) —— 决策表, 模板只做"下标 → 像素"的翻译 */
  activations?: readonly SeqActivation[];
  // --- 版式旋钮(缺省见 SEQ_DEFAULTS; 传了就是你说了算) ---
  /** 泳道中距下限(px) */
  colGapMin?: number;
  /** 相邻泳道盒之间的最小净空(px) */
  boxGap?: number;
  /** 边标签与泳道线之间的最小净空(px) —— 列距不足时会被它顶开 */
  labelGap?: number;
  /** 边标签抬离消息线的高度(px, 除自身包围盒高的一半) */
  labelLift?: number;
  /** 相邻消息线的间距(px) */
  rowGap?: number;
  /** 泳道盒底到第一条消息线的距离(px) */
  headGap?: number;
  /** 最后一条消息线到泳道线末端的余量(px) */
  tail?: number;
  /** 自调用环的宽 / 高(px) */
  loopW?: number;
  loopH?: number;
  /** 消息端点与泳道线之间的横向间隙(px) */
  msgInset?: number;
  /** 激活条宽度(px); **必须 < 2·msgInset**, 否则消息端点会落进条里(守卫会拦) */
  barW?: number;
  /** 激活条最小高度(px) —— `from === to` 时条的退化高度 */
  barMinH?: number;
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
  /** 逐元素样式覆盖(最高优先级); 模板给的泳道线样式也在这张表里, 你的值覆盖它 */
  edgeStyles?: ExportOptions['edgeStyles'];
  nodeStyles?: ExportOptions['nodeStyles'];
};

/**
 * 版式缺省 —— **这张表同时就是旋钮的声明**(键集 = 可覆盖的旋钮名, 由 `resolveKnobs` 读取)。
 * 文档引用的就是这一份, 不许在别处再写一遍字面量。
 */
export const SEQ_DEFAULTS = {
  /** 泳道中距下限。132 ≈ 一屏放得下 4-5 列, 且够写 100px 的边标签 */
  colGapMin: 132,
  /** 相邻泳道盒最小净空(与门禁 `node_gap` 的 showcase 档 12 同一量级再宽一点) */
  boxGap: 18,
  /** 边标签与泳道线的净空(showcase 的 `label_clearance` 要 4, 这里给 12 的观感余量) */
  labelGap: 12,
  /** 边标签抬离消息线的高度(除自身包围盒高的一半) */
  labelLift: 4,
  /**
   * 相邻消息线的间距。56 = 标签 14.8 + 抬 4 + 上方留白 37.2
   * (标签盒走过三轮口径换代: 260923 行块 23.6 → 260925 内边距 4/2 的 19.6 → 260925 墨迹行高 +
   *  内边距 3/1 的 **14.8**。这个缺省**不动** —— 多出来的就是留白; 它是版式下限, 内容真挤时由
   *  `rowGap` 旋钮顶开, 不靠字号反推)
   */
  rowGap: 56,
  /** 泳道盒底 → 第一条消息线。要 > 14(`EDGE_OWNER_EPS`, 否则消息端点会被吸附成"属于"这个盒) */
  headGap: 52,
  /** 最后一条消息线 → 泳道线末端 */
  tail: 56,
  /** 自调用环宽 / 环高 */
  loopW: 36,
  loopH: 30,
  /** 消息端点与泳道线的横向间隙(箭头留白的那个 7) */
  msgInset: 7,
  /** 激活条宽。8 = archify 观感; 半宽 4 < msgInset 7, 端点仍落在条外(守卫会拦) */
  barW: 8,
  /** 激活条最小高度。24 ≈ 半个行距 —— `from === to` 时它是"一次快速调用"的可读下限 */
  barMinH: 24,
  /** 画布外侧留白 */
  margin: 40,
} as const;

/** 起手骨架推出来的几何账 —— **可观测**, 别让推导量藏在函数里 */
export type SequencePlan = {
  /** 每列泳道线中心 x(与 `actors` 同序) */
  columns: number[];
  /** 相邻列中距(长度 = actors.length - 1); 逐位取"版式下限 / 盒宽 / 标签宽"三者最大 */
  gaps: number[];
  /** 每条消息线所在 y(与 `messages` 同序) */
  rows: number[];
  /** 每个列距的三份需求与最终取值(差集可见: 是哪一件把这一格顶开的) */
  needs: Array<{ pair: string; index: number; box: number; label: number; used: number }>;
  /**
   * 激活条: 矩形 + 它由哪两条消息的下标翻译而来 + 最终语义槽。
   * `rect.h = max(barMinH, rows[to] − rows[from])` —— 两边的账都留着, 差集可见。
   */
  bars: Array<{ id: string; actor: string; from: number; to: number; rect: Rect; tone?: Tone; variant?: Variant }>;
  /** 泳道线底端 y */
  lifelineBottom: number;
  width: number;
  height: number;
};

// --- 起手骨架 ----------------------------------------------------------

// 旋钮守卫已上收 core(260920): 这里原来有个 6 行的 `knob()` 外加 12 行
// `const x = knob(spec.x, D.x, 'x')` 的搬运样板 —— 那条政策(缺省回落 / 非有限抛 / 负值抛)
// 与 `assertFiniteRect` 对宽高说的是**同一句话**("尺寸不是增量"), 原语也全是 `guard.ts` 的,
// 于是成了 `resolveKnobs`。键集由 `SEQ_DEFAULTS` 决定: **那张表就是旋钮的声明**, 不另立名字表。

/** 泳道线缺省样式: 细虚线、无端点 —— **样式类参数**, 走覆盖表(调用方的 edgeStyles 覆盖它) */
export const lifelineStyle = (theme: Theme): Omit<EdgeProps, 'points'> =>
  ({ dash: '2 7', width: 1, start: 'none', end: 'none', color: theme.tones.slate.border });

/**
 * 起手骨架: 决策进, 几何出。
 *
 * 它**只算不猜**: 列序 = `actors` 序, 行序 = `messages` 序, 色 = `tone`, 激活区间 = 消息下标。
 * 会算的全是"内容驱动的下限"(盒宽走 `nodeFit`, 列距取 盒宽 / 标签宽 / 版式下限 的最大),
 * 与 `nodeFit` 同一立场 —— 给的是下限不是"该给多少", 想更松就传旋钮。
 */
export function buildSequence(spec: SequenceSpec): { scene: Scene; opts: ExportOptions; plan: SequencePlan } {
  const D = SEQ_DEFAULTS;
  const level: AuditLevel = spec.level ?? 'showcase';
  const theme = spec.theme ?? THEMES.light;
  // 十三个版式旋钮一次收齐(缺省回落 + 越界当场抛全在 `resolveKnobs` 里), 键集 = SEQ_DEFAULTS 的键
  const {
    colGapMin, boxGap, labelGap, labelLift, rowGap, headGap, tail,
    loopW, loopH, msgInset, barW, barMinH, margin,
  } = resolveKnobs('sequence', D, spec);

  // --- ① 入参守卫(畸形是编程错误, 当场抛 —— 与 core 的 guard.ts 同一口径) ---

  const actors = spec.actors;
  if (!actors.length) {
    throw new ShapeInputError('sequence', 'actors', '是空数组', '至少一条泳道; 列序是作者决策, 模板不替你定');
  }
  const colIndex = new Map<string, number>();
  actors.forEach((a, i) => {
    if (!a?.id) throw new ShapeInputError('sequence', `actors[${i}].id`, '缺失', 'id 是消息引用泳道的唯一键');
    if (!a.label) throw new ShapeInputError('sequence', `actors[${i}].label`, '缺失', '泳道盒要有可读的标签; 空标签会上屏一块空白');
    if (colIndex.has(a.id)) throw new ShapeInputError('sequence', `actors[${i}].id`, `与前面的泳道重名(${a.id})`, '泳道 id 必须唯一');
    colIndex.set(a.id, i);
  });

  const messages = spec.messages;
  messages.forEach((m, i) => {
    for (const k of ['from', 'to'] as const) {
      if (typeof m?.[k] !== 'string' || !colIndex.has(m[k])) {
        throw new ShapeInputError(
          'sequence', `messages[${i}].${k}`, `不是任何泳道 id(${String(m?.[k])})`,
          `已知泳道: ${actors.map((a) => a.id).join(' / ')}`,
        );
      }
    }
  });

  // 激活条两条守卫。第二条是**两个旋钮的相互制约**, 单看任一个都合法 —— 必须联立检查:
  // 消息端点停在距泳道线 msgInset 处, 条以泳道线为中心、半宽 barW/2; 半宽一旦够到端点,
  // 端点就落进条里(或被 clamp 到条上), `edge_node_clearance` / `port_crowding` 立刻开火。
  const activations = spec.activations ?? [];
  activations.forEach((b, i) => {
    if (!colIndex.has(b?.actor)) {
      throw new ShapeInputError('sequence', `activations[${i}].actor`, `不是任何泳道 id(${String(b?.actor)})`, `已知泳道: ${actors.map((a) => a.id).join(' / ')}`);
    }
    for (const k of ['from', 'to'] as const) {
      const v = b?.[k];
      if (!Number.isInteger(v) || v < 0 || v >= messages.length) {
        throw new ShapeInputError('sequence', `activations[${i}].${k}`, `不是合法的消息下标(${String(v)})`, `区间是 [0, ${messages.length - 1}] 的闭区间; 本图有 ${messages.length} 条消息`);
      }
    }
    if (b.to < b.from) {
      throw new ShapeInputError('sequence', `activations[${i}].to`, `小于 from(${b.from} > ${b.to})`, '区间按消息行序给(上小下大); 想覆盖哪几条就写清 from/to, 模板不替你交换');
    }
  });
  if (activations.length && barW / 2 >= msgInset) {
    throw new ShapeInputError(
      'sequence', 'barW', `${barW}(半宽 ${barW / 2}) ≥ msgInset ${msgInset}`,
      `条会盖住消息端点(端点停在距泳道线 ${msgInset}px 处); 把 barW 调到 < ${2 * msgInset}px, 或把 msgInset 调大`,
    );
  }

  // --- ② 泳道盒(盒宽盒高走 nodeFit 反算; 行高取全列最大, 顶排才是齐的) ---
  //
  // 盒宽不给全图统一值: 每列按自己的文字量反算(`nodeFit` 与门禁 `label_fit` 同源)。
  // 盒高统一取 `max(fit.h)`: 盒高只取决于"几行文字", 各列往往同高; 真遇上多出一行的列,
  // 取 max 是为了让**顶排对齐** —— 各自为政会让下一行的泳道线起点参差。
  const fits = actors.map((a) => nodeFit({ label: a.label, sub: a.sub, level }));
  const boxH = Math.max(...fits.map((f) => f.h));

  // --- ③ 每条消息的落位需求(标签尺寸 / 自调用环), 先于列距算 ---
  //
  // 列距要装下三样东西, 其中"标签"这一样得先量出来 —— 所以先逐条消息量一次**遮罩片尺寸**。
  // 量法: `labelBoxSize`(260920 从 `edgeLabel` 拆出来的**尺寸唯一来源**)—— 上屏那条标签走的
  // 是同一个函数, 所以列距留出的宽度与图上贴的那块永远差不出一个像素。
  // (此前这里得造一条 1px 的假边喂 `edgeLabel` 再抠 `.width`; 那次拆分就是为它做的。)
  type Slot = {
    i: number;
    from: number;
    to: number;
    self: boolean;
    dir: 1 | -1;
    /** 这条消息的标签会落在哪个列距里(自调用 = 源列右侧那一格) */
    gapIdx: number;
    label?: string;
    /** 遮罩片尺寸(与上屏那份同源); 无标签 = null */
    size: LabelBoxSize | null;
    tone?: Tone;
  };
  const slots: Slot[] = messages.map((m, i) => {
    const from = colIndex.get(m.from) as number;
    const to = colIndex.get(m.to) as number;
    const self = from === to;
    // dir: 源在左 → +1(端点用 +msgInset / -msgInset); 源在右 → -1。端点几何全靠它, 不各写一遍
    const dir: 1 | -1 = to >= from ? 1 : -1;
    return {
      i, from, to, self, dir,
      // 标签落在"源侧那一格": 源在左 → 自己右边那格(i); 源在右 → 左边那格(i-1)。
      // 自调用没有"对侧", 环向右伸 ⇒ 吃源列右侧那格(末列时靠画布右缘的尾需兜住)
      gapIdx: self ? from : dir > 0 ? from : from - 1,
      label: m.label,
      size: m.label ? labelBoxSize(m.label) : null,
      tone: m.tone,
    };
  });

  // --- ④ 列距: 三份需求 → 一维约束账本, 交给 `solveAxis` 解 ---
  //
  // 一格列距 = 相邻两列心的距离, 它必须同时满足:
  //
  //   盒需   (fit_i.w + fit_{i+1}.w) / 2 + boxGap
  //          ↑ 两盒**半宽之和** + 净空 —— 不是"两个盒宽"，因为列距量的本来就是"心到心"。
  //            盒宽不等时这么算才正好留出 boxGap 的空隙。
  //   标签需 跨列: size.width + 2·labelGap           (标签居中在格心, 两侧各留 labelGap 到泳道线)
  //          自调用: msgInset + loopW + labelGap + size.width + labelGap
  //                  ↑ 环向右伸出的四段: 出线间隙 → 环宽 → 留白 → 标签 → 留白
  //   版式下限 colGapMin                              (内容都不长时的观感兜底)
  //
  // 260922 起这三样不再在这里手算 max, 而是**各喂一条 `AxisConstraint`**(同一个 a→b 上的多条
  // 约束 = 多源竞争, 最长路取最大的那条, `AxisPlan.attribution` 里读得出是哪一条顶开的)。
  // 为什么值得换刀: 手算 max 只对**相邻格**成立 —— 一旦出现跨格要求(一段区间横跨 3 列要装下
  // 一个标题), 要求就不再是原地的 max 而是沿链累积, 那正是一维账本存在的理由。
  //
  // 三样取 max 而不是"取全图最大铺给每一格": 一格要宽是那一格自己的事。
  // 账本解出来的是**相对**列距(origin = 0), 绝对坐标留给 ⑤ 加锚点 —— 内核的 0.1 量化碰不到锚点。
  // 向上取整到整像素是**模板的政策**(像素不要小数尾巴), 内核只保证"≥ 需求": 政策的数在账本里
  // 一个字不改, 只是不许它被舍入悄悄压到下界底下(内核自己抬的是 0.1 格那半格)。
  const axisConstraints: AxisConstraint[] = [];
  const demands: Array<{ pair: string; box: number; label: number }> = [];
  for (let i = 0; i < actors.length - 1; i++) {
    const pair = `${actors[i].id}→${actors[i + 1].id}`;
    const box = Math.ceil((fits[i].w + fits[i + 1].w) / 2 + boxGap);
    let label = 0;
    let greediest = ''; // 这一格里最贪的那条标签是谁(消息 id) —— 账目要能对回物
    for (const s of slots) {
      if (s.gapIdx !== i || !s.size) continue;
      const need = Math.ceil(s.self
        ? msgInset + loopW + labelGap + s.size.width + labelGap
        : s.size.width + 2 * labelGap);
      if (need > label) { label = need; greediest = `m${s.i}`; }
    }
    axisConstraints.push({ from: i, to: i + 1, minimum: colGapMin, contributor: 'colGapMin' });
    axisConstraints.push({ from: i, to: i + 1, minimum: box, contributor: `box:${pair}` });
    if (label > 0) axisConstraints.push({ from: i, to: i + 1, minimum: label, contributor: `label:${greediest}` });
    demands.push({ pair, box, label });
  }
  const axis = solveAxis({ count: actors.length, constraints: axisConstraints });
  const gaps = axis.gaps;
  // 每格的账(`used`)直接取账本的解, 不再另算一份 max —— 同一个数只许一个来源
  const needs: SequencePlan['needs'] = demands.map((d, i) => ({ pair: d.pair, index: i, box: d.box, label: d.label, used: gaps[i] }));

  // --- ⑤ 列心 (累加) ---
  //
  // 首列: 左缘贴 margin, 故列心 = margin + 半个盒宽。之后每列 = 前一列 + 前一格列距。
  // 全程只有这里的 `margin` 一个自由起点, 其余全是 ④ 算出来的差值 —— 挪 margin 就是整体平移。
  // ⚠ 这里**故意**仍是自家累加, 不走账本的 `positions`: 那条路要先给账本一个带小数的 origin
  //   (`margin + 半盒宽`) 再逐位取和, 浮点结合律会带来 ulp 级差异 —— 本模板的产物要求逐字节不变。
  const columns: number[] = [margin + fits[0].w / 2];
  for (let i = 1; i < actors.length; i++) columns.push(columns[i - 1] + gaps[i - 1]);


  // --- ⑥ 行 y (等差) ---
  //
  // 首行留白 headGap 必须 > 14(core 的 EDGE_OWNER_EPS): 端点离盒 ≤14px 会被"就近吸附"
  // 认成该盒的边 —— 序列图的消息端点不该被认成"属于泳道盒"。缺省 52 远超此线。
  const topY = margin;
  const bodyTop = topY + boxH; // 泳道线起点 = 泳道盒底边
  const rows = slots.map((_, i) => bodyTop + headGap + i * rowGap);

  // --- ⑦ 激活条(activation bars): 消息下标 → 矩形 ---
  //
  // 条骑在泳道线**中心**上(左右各 barW/2), 顶边落在起始消息线、底边落在结束消息线 ——
  // "从这条消息到那条消息, 这一列是活跃的"就是全部几何。圆角半径 = barW/2 ⇒ 两头是半圆
  // (圆头竖条), 与 archify 观感同档 —— 走的就是 core 现成的圆角矩形, **没有新形状**。
  //
  // 高度: `rows[to] − rows[from]`, 落空时(同一行 from === to)取 `barMinH` ——
  // 自调用那种"一次快速调用"至少要有 24px 才读得出是一段, 0 高的条会退化成一条横线。
  const bars: SequencePlan['bars'] = activations.map((b, i) => {
    const col = colIndex.get(b.actor) as number;
    const y0 = rows[b.from];
    const y1 = rows[b.to];
    return {
      id: `bar:${b.actor}#${i}`,
      actor: b.actor,
      from: b.from,
      to: b.to,
      rect: { x: Math.round(columns[col] - barW / 2), y: y0, w: barW, h: Math.max(barMinH, y1 - y0) },
      // 语义槽沿泳道走(缺省): 作者在泳道表里点的色 / 形态, 激活条自动跟上, 不必再点一遍
      tone: b.tone ?? actors[col].tone,
      variant: b.variant ?? 'tint',
    };
  });

  // --- ⑧ 装配 scene ---

  const nodes: SceneNode[] = actors.map((a, i) => ({
    id: a.id,
    rect: { x: Math.round(columns[i] - fits[i].w / 2), y: topY, w: fits[i].w, h: boxH },
    label: a.label,
    sub: a.sub,
    tone: a.tone,
    variant: a.variant,
  }));

  // 激活条进 `nodes`(不是 `edges`): 它是"这一段这一列在忙"的**状态**, 是对象而不是关系 ——
  // 于是圆角 / tint / tone 全是 core 原生能力, 不必拿一条粗线去冒充矩形(那会把宽度藏进
  // 样式覆盖表, 而宽度在这里是几何)。条宽 = barW 且骑在泳道线中心 ⇒ 消息端点仍在条外(守卫保证)。
  // 显式给 `radius = barW/2` 而不是吃缺省 10: 半径被盒宽钳到半宽是**同一个结果**, 但钳制是
  // "补救", 而这里两头本来就该是半圆(圆角矩形 = 圆头竖条)。显式写出来, 读者不必去推钳制。
  for (const b of bars) nodes.push({ id: b.id, rect: b.rect, radius: barW / 2, tone: b.tone, variant: b.variant });

  const bodyBottom = slots.reduce((acc, s, i) => Math.max(acc, rows[i] + (s.self ? loopH : 0)), bodyTop);
  const lifelineBottom = bodyBottom + tail;

  const edges: SceneEdge[] = [];
  const labels: SceneLabel[] = [];
  const hasBar = new Set(bars.map((b) => b.actor));

  // 泳道线: 端点在盒底边上 → 可以写 from/to(它不会与谁配成端口对; 消息边则必须留空, 见文件头 ①)。
  // ⚠ 有激活条的泳道线标 `noCheck`(纯视觉基准线豁免): 条骑在线上是设计, 不是"线压着盒子走"。
  //   **没 bar 的泳道线不标** —— 老产物(不带 activation 的图)一个字节都不许变。
  actors.forEach((a, i) => {
    const cx = columns[i];
    edges.push({
      id: `life:${a.id}`,
      from: a.id, to: a.id,
      points: [{ x: cx, y: bodyTop }, { x: cx, y: lifelineBottom }],
      ...(hasBar.has(a.id) ? { noCheck: true } : {}),
    });
  });

  slots.forEach((s, i) => {
    const y = rows[i];
    const cxFrom = columns[s.from];
    const cxTo = columns[s.to];
    const id = `m${i}`;
    let points: { x: number; y: number }[];
    if (s.self) {
      // 自调用: 右出 → 下 → 左回(四点正交; 箭头指向自己的泳道线)
      const x0 = cxFrom + msgInset;
      points = [{ x: x0, y }, { x: x0 + loopW, y }, { x: x0 + loopW, y: y + loopH }, { x: x0, y: y + loopH }];
    } else {
      // 端点 = 泳道线 ∓ msgInset: 源在左就向右伸 7px, 源在右就向左伸 7px —— 方向由 `dir` 一处给全
      points = [{ x: cxFrom + s.dir * msgInset, y }, { x: cxTo - s.dir * msgInset, y }];
    }
    // from/to 一律不写 —— 见文件头 ①(`SceneEdge.label` 只作自述, 上屏走 labels)
    edges.push({ id, points, label: s.label, tone: s.tone });

    // size 与 label 同生同灭(③ 里一起给的): 有标签才有遮罩片要量、要放
    if (!s.label || !s.size) return;
    // 落位由本模板推导, 显式交给 `edgeLabel`(`at` 一给, core 就不再算它自己那套中点落位)
    const at = s.self
      // 环的标签贴在环右侧: x = 环右缘 + labelGap + 半宽; y 居中对齐环高
      ? { x: cxFrom + msgInset + loopW + labelGap + s.size.width / 2, y: y + loopH / 2 }
      // 标签横向**只落在一个列距内**: 贴源侧那一格的中点(跨列消息居中放必被中间泳道线穿过);
      // 纵向抬到线上方 —— 自身半高 + labelLift。中点走 `vec.mid`(同一句话别在两处各写一遍)
      : {
          x: mid({ x: cxFrom, y: 0 }, { x: s.dir > 0 ? columns[s.from + 1] : columns[s.from - 1], y: 0 }).x,
          y: y - (s.size.height / 2 + labelLift),
        };
    // tone 一并烘进标签(260925): 消息边有肤色, 标签的字色就跟着它走 —— 与上面那条
    // `edges.push({ …, tone: s.tone })` 同一个值, 不许在标签这侧另给一个色
    labels.push(edgeLabel({ id, points, tone: s.tone }, s.label, { at }));
  });

  // --- ⑨ 画布 ---
  //
  // 右缘取两件的 max: ① 末列盒的右缘(= 列心 + 半盒宽); ② 末列自调用环 + 它标签伸出多少
  // (`msgInset + loopW + labelGap + size.width + labelGap` —— 与 ④ 里那一格的"标签需"同一个式子)。
  //
  // ⚠ 260920 实测: `opts.fit: true` 下**这两个声明的数根本不上屏** —— `fitScene` 走
  // `contentBounds`(折点列与标签矩形都在内), 把 width/height 砍成 1×1 后产物仍然逐字节相同
  // (内置示例: 声明 632 / 实际产物 586)。所以这里的价值只剩"给不 fit 的调用方一个兜底 +
  // `plan.width/height` 可读", 而那个式子与 ④ 逐字重复 —— 本轮不动: 它只喂"不 fit 的兜底数",
  // 产物与门禁都不看这个值(没有立项依据)。
  const tailNeed = slots.reduce(
    (acc, s) => (s.self && s.from === actors.length - 1 && s.size
      ? Math.max(acc, msgInset + loopW + labelGap + s.size.width + labelGap)
      : acc),
    0,
  );
  const rightEdge = Math.max(columns[columns.length - 1] + fits[fits.length - 1].w / 2, columns[columns.length - 1] + tailNeed);
  const width = Math.round(rightEdge + margin);
  const height = Math.round(lifelineBottom + margin);

  // 泳道线样式: 模板给缺省(细虚线/无端点), 调用方的 edgeStyles 覆盖它 —— 覆盖表永远赢(纪律 10)
  const edgeStyles: ExportOptions['edgeStyles'] = {
    ...Object.fromEntries(actors.map((a) => [`life:${a.id}`, lifelineStyle(theme)])),
    ...(spec.edgeStyles ?? {}),
  };

  const scene: Scene = { width, height, nodes, edges, labels };
  const opts: ExportOptions = {
    level,
    theme,
    fit: true,
    title: spec.title,
    fontFamily: spec.fontFamily,
    nodeStyles: spec.nodeStyles,
    edgeStyles,
  };
  const plan: SequencePlan = { columns, gaps, rows, needs, bars, lifelineBottom, width, height };
  return { scene, opts, plan };
}

/**
 * **模板的出口**: 骨架 → 门禁 → 产物。
 *
 * 与内核出口的分工一字不差(见 SKILL.md「出口」): 用的是 `tryExport`(**永不抛**),
 * 门禁没过也给草稿图 + `report.pass === false`; 诊断一律走 stderr、图走 `spec.out`
 * **由脚本自己写**(不经 shell 重定向, 也就没有 `2>&1` 可写错)。
 * 判决由调用方落到 exit code —— 库不擅自 `process.exitCode`。
 */
export function emitSequence(spec: SequenceSpec): ExportResult {
  const { scene, opts, plan } = buildSequence(spec);
  const result = tryExport(scene, opts);
  if (spec.out) writeFileSync(spec.out, result.svg);
  console.error(
    `sequence: pass=${result.report.pass} draft=${result.draft} `
    + `泳道=${spec.actors.length} 消息=${spec.messages.length} 激活条=${plan.bars.length} `
    + `画布=${plan.width}x${plan.height} 列距=[${plan.gaps.join(', ')}] bytes=${new TextEncoder().encode(result.svg).length}`,
  );
  for (const d of result.report.diagnostics) {
    console.error(`  [${d.severity}] ${d.code} @ ${d.subject.kind}:${d.subject.id} — ${d.message}`, d.evidence);
  }
  return result;
}

// --- 内置示例(演示怎么喂 + 当冒烟用例) --------------------------------
//
// 决策全在这里: 四条泳道、八条消息、三条激活区间、tone 分工 —— 模板一个都没替它定。
// 激活区间读法: "网关从第 1 条消息忙到最后一条" / "缓存在 miss 前后忙三条" / "数据库只忙那一次查询"。

export const DEMO_SEQUENCE: SequenceSpec = {
  title: '一次带缓存的读请求',
  actors: [
    { id: 'web', label: '浏览器', sub: '同源 · cookie', tone: 'slate' },
    { id: 'gw', label: 'API 网关', sub: '鉴权 + 路由', tone: 'blue', variant: 'solid' },
    { id: 'cache', label: '缓存', sub: 'Redis', tone: 'emerald' },
    { id: 'db', label: '数据库', sub: 'Postgres', tone: 'amber' },
  ],
  messages: [
    { from: 'web', to: 'gw', label: 'GET /v1/user/42', tone: 'blue' },
    { from: 'gw', to: 'cache', label: 'GET user:42', tone: 'blue' },
    { from: 'cache', to: 'cache', label: '校验本地 LRU', tone: 'violet' },
    { from: 'cache', to: 'gw', label: 'miss', tone: 'slate' },
    { from: 'gw', to: 'db', label: 'SELECT … WHERE id=42', tone: 'blue' },
    { from: 'db', to: 'gw', label: 'row', tone: 'slate' },
    { from: 'gw', to: 'cache', label: 'SET user:42 EX 300', tone: 'emerald' },
    { from: 'gw', to: 'web', label: '200 OK', tone: 'slate' },
  ],
  activations: [
    { actor: 'gw', from: 0, to: 7 },      // 网关: 从收到请求到回完响应, 全程在忙
    { actor: 'cache', from: 1, to: 3 },   // 缓存: 查缓存 → miss → 回 miss
    { actor: 'db', from: 4, to: 5 },      // 数据库: 收到 SELECT → 回一行
  ],
};

if (isMainModule(import.meta.url)) {
  const outArg = process.argv.find((a) => a.startsWith('--out='));
  const out = outArg ? outArg.slice('--out='.length) : undefined;
  const dark = process.argv.includes('--dark'); // 笔记配图走 light, deck / 深色页走 dark
  const result = emitSequence({ ...DEMO_SEQUENCE, out, theme: dark ? THEMES.dark : THEMES.light });
  if (!out) process.stdout.write(result.svg);
  if (!result.report.pass) process.exitCode = 1;
}
