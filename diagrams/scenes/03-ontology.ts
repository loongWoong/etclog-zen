// 图 3 · 本体实例关系（实体卡片 + 关系边）：Passage 为锚点，其余实体挂在它周围
import { card, emit, note, sceneOf, wire } from './kit.ts';

const nodes = []; const edges = []; const texts = [];
const put = (b) => { nodes.push(b.node); return b.rect; };

const passage = put(card('passage', [
  '**Passage 一次通行**（锚点）',
  'passageId = 车道 + 分钟 + 主标识',
  'vehicle：车牌 / 车型 / 完整 OBU',
  'times：A1·B1·C1·T2·T3·T4',
  'elapsedBarrierMs / elapsedPassMs',
  'result：released / blocked',
], { x: 1000, y: 620 }, { tone: 'amber', variant: 'solid' }));

const step = put(card('step', [
  '**PassageStep 过程节点**',
  'kind：线圈 / 栏杆 / 牌识 / 天线',
  'at + device + 原文摘要',
  'evidenceRef → ES _id',
], { x: 1720, y: 200 }, { tone: 'emerald' }));

const trade = put(card('trade', [
  '**Transaction 交易**',
  'obuId / fee / payFee',
  'checkResult / vehicleClass',
  'passId（入口、出口各一条）',
], { x: 1780, y: 690 }, { tone: 'emerald' }));

const waste = put(card('waste', [
  '**WasteRecord 流水**',
  'generateAt → uploadAt',
  'uploadDelayMs',
  '牌识匹配（车牌 + 牌识时间戳）',
], { x: 1560, y: 1100 }, { tone: 'emerald' }));

const lane = put(card('lane', [
  '**Lane 车道**',
  'laneNo / type / role / coils',
  'adjacency 邻接（待现场确认）',
], { x: 240, y: 200 }, { tone: 'blue' }));

const device = put(card('device', [
  '**Device 设备**',
  'E4 栏杆 · E5 线圈',
  'E6 牌识 · E2 车型识别',
], { x: 900, y: 130 }, { tone: 'blue' }));

const evid = put(card('evid', [
  '**Evidence 证据**',
  'index + _id + 日志行时间',
  'caliber 口径 / confidence',
  '缺证据 = MISSING(node)',
], { x: 300, y: 1090 }, { tone: 'violet' }));

const metric = put(card('metric', [
  '**Metric 基线**',
  '(车道 × 车型) 分组',
  'median + mad + k + 样本数',
  'source：dynamic / coldstart',
], { x: 230, y: 660 }, { tone: 'violet' }));

const anomaly = put(card('anomaly', [
  '**Anomaly 异常**',
  'type + rootCause',
  'observedMs / thresholdMs / rule',
  'verdict：已证实 / 规则推断 / 待核实',
  'status：open / confirmed / closed',
], { x: 900, y: 1170 }, { tone: 'rose' }));

edges.push(
  wire('passage', 'step', passage, step, { fromSide: 'right', toSide: 'left', label: '1:N 过程节点', tone: 'emerald' }),
  wire('passage', 'trade', passage, trade, { fromSide: 'right', toSide: 'left', fromT: 0.7, toT: 0.3, label: '1:0..N 交易', tone: 'emerald' }),
  wire('trade', 'waste', trade, waste, { fromSide: 'bottom', toSide: 'right', label: '1:1 流水', tone: 'emerald' }),
  wire('passage', 'lane', passage, lane, { fromSide: 'left', toSide: 'right', fromT: 0.3, toT: 0.7, label: 'N:1 发生车道', tone: 'blue' }),
  wire('lane', 'device', lane, device, { fromSide: 'right', toSide: 'left', label: '1:N 设备归属', tone: 'blue' }),
  wire('passage', 'metric', passage, metric, { fromSide: 'left', toSide: 'right', fromT: 0.7, toT: 0.3, label: '基线作用于趟次', tone: 'violet' }),
  wire('passage', 'anomaly', passage, anomaly, { fromSide: 'bottom', toSide: 'top', label: '1:N 异常', tone: 'rose' }),
  wire('anomaly', 'evid', anomaly, evid, { fromSide: 'left', toSide: 'right', label: 'N:N 证据', tone: 'violet' }),
);

texts.push(
  note('n-title', '**图 3 · 本体实例关系**：卡片 = 实体（首行实体名，其后是属性行）；线 = 关系；每条结论都必须能沿 Evidence 回指到原始日志。', { x: 200, y: 1420 }, { anchor: 'start', fontSize: 14 }),
  note('n-gap', '缺口：Lane.adjacency 需要现场/图纸确认；Metric/Baseline 当前不存在，需新增；Anomaly 需从 anomalyType 升格为带根因与证据的实例。', { x: 200, y: 1455 }, { anchor: 'start', color: '#b42318' }),
);

emit(sceneOf({ nodes, edges, texts }), '03-本体实例关系.svg', '本体实例关系：Passage 锚点 + 实体属性 + 关系边');
