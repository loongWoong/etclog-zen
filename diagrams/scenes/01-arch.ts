// 图 1 · 本体驱动的分析链路（五层）+ 数据源
// 决策（层序 / 成员 / 连边 / 色调）全在这里；盒宽、层距、层框、画布由模板算。
import { emitLayered } from '../dia/layered.ts';
import { FONT } from './kit.ts';

const r = emitLayered({
  out: 'F:/caochun/etclog/diagrams/out/01-架构与链路.svg',
  title: '本体驱动的过车慢 / 邻道干扰分析 · 五层链路（单站 37016433）',
  level: 'showcase',
  fontFamily: FONT,
  nodeH: 54,
  nodeGapX: 44,
  layerGap: 130,
  layers: [
    {
      id: 'src',
      label: '数据源 · ES ump_37016433_2026.07（1868 万条 / 10 个有数据日 / laneLog 841 万）',
      tone: 'slate',
      rows: [
        [
          { id: 'laneLog', label: 'laneLog 车道日志', sub: '外场事实：线圈/栏杆/牌识' },
          { id: 'etc', label: 'etc 服务日志', sub: 'B2/B5 帧、交易结果、passId' },
          { id: 'dataSvc', label: 'data 数据服务', sub: '流水生成/入库' },
        ],
        [
          { id: 'fee', label: 'fee 计费', sub: '金额 / 免费' },
          { id: 'mtc', label: 'mtc 人工', sub: 'MTC 交易' },
          { id: 'namelist', label: 'namelist 名单', sub: '黑白名单校验' },
          { id: 'station', label: '0000000000 站级桶', sub: '站级流水日志' },
        ],
      ],
    },
    {
      id: 'l0',
      label: 'L0 事实层 · 字段优先抽取（keyword 精确过滤 → 按窗拉取 → 本地解析）',
      tone: 'blue',
      rows: [
        [
          { id: 'dictLane', label: '车道字典', sub: '角色/类型/线圈/车道号', tone: 'blue', variant: 'tint' },
          { id: 'dictTime', label: '时间语义字典', sub: '事件时间 vs 上报时间', tone: 'blue', variant: 'tint' },
          { id: 'dictId', label: '身份键字典', sub: '完整 OBU / 车牌 / passId', tone: 'blue', variant: 'tint' },
        ],
      ],
    },
    {
      id: 'l1',
      label: 'L1 本体实例层 · 候选窗实例化（只做实体的指针，不复制全部日志）',
      tone: 'emerald',
      rows: [
        [
          { id: 'passage', label: 'Passage 一次通行', sub: '锚点：聚合根' },
          { id: 'step', label: 'PassageStep 过程节点', sub: '线圈/栏杆/牌识/天线' },
          { id: 'trade', label: 'Transaction 交易', sub: 'OBU/金额/校验' },
          { id: 'waste', label: 'WasteRecord 流水', sub: '生成→上传延迟' },
        ],
        [
          { id: 'lane', label: 'Lane / Device', sub: '车道与设备归属' },
          { id: 'evidence', label: 'Evidence 证据', sub: 'ES _id + 口径 + 可信度' },
        ],
      ],
    },
    {
      id: 'l2',
      label: 'L2 推理层 · 阈值、基线与可信度（口径必须先于规则）',
      tone: 'violet',
      rows: [
        [
          { id: 'mad', label: 'MAD 基线', sub: '(车道,车型) 最近 7 个有数据日' },
          { id: 'temporal', label: '时序规则', sub: '单调性 / 缺失 / 倒车' },
          { id: 'cross', label: '跨车道关联', sub: '完整 OBU 比对' },
          { id: 'trust', label: '可信度与口径', sub: 'T3 可信 / B1_LOW' },
        ],
      ],
    },
    {
      id: 'l3',
      label: 'L3 应用层 · 场景规则（本轮优先：过车慢 + 三子模型根因）',
      tone: 'amber',
      rows: [
        [
          { id: 'slow', label: '过车慢', sub: '天线 / 栏杆 / 交易', tone: 'amber', variant: 'solid' },
          { id: 'adj', label: '邻道干扰', sub: '第二轮' },
          { id: 'free', label: '私自放车', sub: '后续' },
          { id: 'hw', label: '硬件监测', sub: '后续' },
        ],
      ],
    },
    {
      id: 'l4',
      label: 'L4 结论层 · 结论三分法（已证实 / 规则推断 / 待核实）',
      tone: 'rose',
      rows: [
        [
          { id: 'anomaly', label: 'Anomaly 异常实例', sub: '根因 + 阈值 + 实测值', tone: 'rose', variant: 'tint' },
          { id: 'chain', label: '证据链', sub: '每条结论可回指原始日志' },
          { id: 'status', label: '处置状态', sub: 'open / confirmed / closed' },
        ],
      ],
    },
  ],
  edges: [
    { id: 'e-src-l0', from: 'src', to: 'l0', label: '字段过滤 + 本地解析', tone: 'blue' },
    { id: 'e-l0-l1', from: 'l0', to: 'l1', label: '候选窗实例化', tone: 'emerald' },
    { id: 'e-l1-l2', from: 'l1', to: 'l2', label: '指标 + 基线', tone: 'violet' },
    { id: 'e-l2-l3', from: 'l2', to: 'l3', label: '场景规则判定', tone: 'amber' },
    { id: 'e-l3-l4', from: 'l3', to: 'l4', label: '结论 + 证据', tone: 'rose' },
  ],
});

if (!r.report.pass) process.exitCode = 1;
