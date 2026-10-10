// 把 6 张图内嵌成一张可投屏/可打印的索引页。用法：bun run index.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const DIR = 'F:/caochun/etclog/diagrams/';
const files = readdirSync(DIR + 'out').filter((f) => /^\d\d-.*\.svg$/.test(f)).sort();
const CAPTION = {
  '01': ['图 1 · 五层链路与数据源', '先对齐"哪些数据进本体、哪些不进"：L0 事实 → L1 实例 → L2 推理 → L3 场景 → L4 结论。'],
  '02': ['图 2 · 过车慢判定流', '争论重点：T3 可信的定义（T3−T2 ≥ a1）、b1/b2 分支、动态基线与冷启动值的来源。'],
  '03': ['图 3 · 本体实例关系', '缺口：Metric/Baseline 需新增；Lane.adjacency 待现场确认；Anomaly 需从 anomalyType 升格。'],
  '04': ['图 4 · 口径对照时序（真实数据）', '同一趟车（鲁UG6595 · 91 车道）在两个 B1 口径下得到相反结论 —— 口径必须进字段与清单。'],
  '05': ['图 5 · 邻道干扰判定流', '主判据落在方案「场景二」；本站实测 5 秒内跨车道 0 对，「场景一」几乎不产出。'],
  '06': ['图 6 · 数据可用性', '26 天里只有 10 天有数据 —— MAD 的"最近 7 天"必须改按"有数据日"，否则窗口只有 5 天。'],
};
const OPEN = [
  ['车道邻接表', '图纸（etc车道布局.jpg / mtc车道布局.png）需要人工确认，尤其 95 匝道与 91/81/24/25 的物理相邻关系。'],
  ['3701643300 的角色', '索引内 0 条 laneLog，但 passId 文档最多（125/小时）：入口车道？自助车道？门架/站级桶？'],
  ['车型口径', 'vehClass 6,409/天、vehicleClass 2,771/天都太稀疏；MAD 分组的车型以「交易流水 > 车型识别(E2) > 费显 > 车牌颜色兜底」为准是否可以？'],
  ['车道方向', 'laneDirection 全为空，是否允许用「入口交易/出口交易」反推 direction？'],
  ['b2 冷启动货车 15s', '样例 elapsedPass = 5.05s，若阈值 15s 则 b2 分支几乎不触发。'],
  ['数据非连续', '10/26 天有数据、其中 2 天是部分日：采集缺口还是导出裁剪？按"有数据日"建基线是否可接受？'],
  ['派生数据', '是否允许新增分析侧物化表/派生字段（不改 ES 索引与在用脚本）？'],
];

const figures = files.map((f) => {
  const key = f.slice(0, 2);
  const [title, note] = CAPTION[key] ?? [f, ''];
  const svg = readFileSync(DIR + 'out/' + f, 'utf8')
    .replace(/^<\?xml[^>]*\?>\s*/, '')
    .replace(/^<svg /, '<svg class="fig" ');
  return { f, title, note, svg };
});

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>过车慢 / 邻道干扰 本体分析 · 讨论图</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 32px 40px 64px; background: #f6f7f9; color: #101828;
         font-family: "Microsoft YaHei", "PingFang SC", ui-sans-serif, system-ui, sans-serif; }
  h1 { font-size: 26px; margin: 0 0 6px; }
  .sub { color: #475467; font-size: 14px; margin-bottom: 28px; }
  figure { margin: 0 0 40px; background: #fff; border: 1px solid #e4e7ec; border-radius: 10px;
           padding: 20px 24px 26px; break-inside: avoid; }
  figcaption { font-size: 15px; font-weight: 600; margin-bottom: 4px; }
  figcaption span { font-weight: 400; color: #475467; display: block; margin-top: 4px; font-size: 13px; }
  .fig { display: block; width: 100%; height: auto; margin-top: 14px; }
  .file { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: #667085; margin-top: 10px; }
  ol { background: #fff; border: 1px solid #e4e7ec; border-radius: 10px; padding: 20px 24px 20px 44px; font-size: 14px; }
  li { margin-bottom: 10px; }
  li b { color: #b42318; }
  @media print { body { background: #fff; padding: 0; } figure { border: none; page-break-inside: avoid; } }
  @page { size: A4 landscape; margin: 10mm; }
</style></head>
<body>
<h1>过车慢 / 邻道干扰 · 本体分析讨论图</h1>
<div class="sub">单站 37016433 · 索引 ump_37016433_2026.07（10 个有数据日）· 数据口径与结论均来自实测探针；每张图由脚本生成并过了出图门禁（showcase 档）。</div>
${figures.map((f) => `<figure>
  <figcaption>${f.title}<span>${f.note}</span></figcaption>
  ${f.svg}
  <div class="file">源文件：diagrams/out/${f.f}　·　生成脚本：diagrams/scenes/${f.f.slice(0, 2)}-*.ts</div>
</figure>`).join('\n')}
<h2 style="font-size:18px;margin:32px 0 12px">附录 · 需要各方拍板的开放项</h2>
<ol>${OPEN.map(([t, d]) => `<li><b>${t}</b> —— ${d}</li>`).join('')}</ol>
</body></html>
`;
writeFileSync(DIR + '讨论图索引.html', html);
console.log(`written 讨论图索引.html  figures=${figures.length}  bytes=${new TextEncoder().encode(html).length}`);
