# 讨论图（过车慢 / 邻道干扰 本体分析）

给多方评审会用的 6 张结构图。**图全部由脚本生成**，改图请改 `scenes/*.ts`，不要手改 `out/*.svg`（会被下一次生成覆盖）。

| 图 | 源文件 | 产物 | 讲什么 |
| --- | --- | --- | --- |
| 1 · 架构与链路 | [`scenes/01-arch.ts`](scenes/01-arch.ts) | `out/01-架构与链路.svg` | 数据源 → L0 事实 → L1 本体 → L2 推理 → L3 场景 → L4 结论 |
| 2 · 过车慢判定流 | [`scenes/02-slow-flow.ts`](scenes/02-slow-flow.ts) | `out/02-过车慢判定流.svg` | T3 可信判定 → b1/b2 口径分支 → 动态基线 → 三子模型根因 |
| 3 · 本体实例关系 | [`scenes/03-ontology.ts`](scenes/03-ontology.ts) | `out/03-本体实例关系.svg` | Passage 锚点 + 9 类实体的属性行 + 8 条关系 |
| 4 · 口径对照时序 | [`scenes/04-caliber-timeline.ts`](scenes/04-caliber-timeline.ts) | `out/04-口径对照时序.svg` | 鲁UG6595 真实时间轴：两个 B1 口径得到相反结论 |
| 5 · 邻道干扰判定流 | [`scenes/05-adjacent-flow.ts`](scenes/05-adjacent-flow.ts) | `out/05-邻道干扰判定流.svg` | 主规则（场景二）+ 辅助证据 + 必须排除的匝道正常链 |
| 6 · 数据可用性 | [`scenes/06-data-availability.ts`](scenes/06-data-availability.ts) | `out/06-数据可用性.svg` | 26 天里只有 10 天有数据 → MAD 窗口口径必须改 |

- **一页投屏/打印**：[`讨论图索引.html`](讨论图索引.html)（6 张图内嵌 + 开放项附录，A4 横向打印样式）
- **光栅预览**：`out/preview/*.png`（`*.png` 被 .gitignore 忽略，仅本机看）

## 重新生成

```powershell
cd F:\caochun\etclog\diagrams
bun run all.ts        # 跑完 6 个 scene（每张都过出图门禁，不过就 exit 1）
bun run index.mjs     # 重出 讨论图索引.html
bun run check.mjs     # 结构体检：prolog / xmlns / 跨图 id / 内嵌一致性
. .\render.ps1 -Svg 'out/01-架构与链路.svg' -Png 'out/preview/01-架构与链路.png'   # Edge 无头栅格化
python check_png.py   # 栅格体检：墨迹占比 / 空段 / 是否触边裁切
```

`render.ps1` 只收 ASCII 参数名（PS 5.1 按 ANSI 读 `.ps1`，中文注释里的 GBK 乱码会吞掉换行）。

## 纪律与已知限制

- **门禁**：每张图必须 `pass=true`（`showcase` 档：净空 4px / 间距 12px / 呼吸位 10px）。`all.ts` 的退出码就是判决。
- **不手写 SVG**：几何（盒宽、折点、层框、画布）由 `@watert/svg-infovis` 解算，`scenes/kit.ts` 只做组装。
- 出图依赖是本机离线缓存里复制的 `@watert/svg-infovis@0.2.1`（+ `lucide-static`）：registry 在本机不可达，`node_modules/` 已被 .gitignore 忽略，不需要联网安装。
- 字宽用的是库内宽度表估算（全角按 1.2em，实际系统字体约 1.0em）→ 盒宽偏松、不会溢出；未做浏览器实测字宽。
- 图上所有数字都来自探针实测，出处见根目录 `_*.md` 与 [`本体分析方案与实例规格V1.md`](../本体分析方案与实例规格V1.md)：
  - 车道字典/字段覆盖 → `_lane_dict.md`、`_parse_anchors.md`
  - 索引逐日文档量（图 6）→ `_index_span.md`
  - 鲁UG6595 时刻表（图 4）→ `_trip_evidence.md`、`merged_鲁UG6595_20260701_120654.md`
  - OBU 身份键与跨车道统计（图 5）→ `_b2_crosslane_v2.md`
