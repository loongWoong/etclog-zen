# ETC Log Merge

这个目录里的 `merge_vehicle_logs.py` 用来把同一辆车一次通行过程中散落在车道日志、ETC/MTC 服务日志、数据服务日志、名单服务日志里的相关记录归并成一个 Markdown 文件。

脚本的核心思路是：先用车牌找到一批种子日志，再从这些日志里提取能代表同一笔交易或同一辆车的关联键，反复扩大匹配范围，最后按时间线输出。

## 基本用法

最常用的方式是只指定日志目录，让脚本自动发现并聚合目录里的车辆事件：

```bash
python3 merge_vehicle_logs.py --auto --log-dir 20260514
```

默认会输出到 `20260514_merged/`。也可以指定输出目录：

```bash
python3 merge_vehicle_logs.py \
  --auto \
  --log-dir 20260514 \
  --discover-output-dir discovered
```

列出某辆已知车牌在日志目录里的候选事件：

```bash
python3 merge_vehicle_logs.py <车牌> --log-dir 20260514 --list-events
```

围绕某个时间点合并一辆车的日志：

```bash
python3 merge_vehicle_logs.py <车牌> \
  --log-dir 20260514 \
  --at '2026-05-14 08:00:28' \
  --window-minutes 4 \
  -o merged_SAMPLE_20260514_080028.md
```

常用参数：

- `vehicle`：车牌，例如 `<车牌>`。脚本也会把 `<车牌>_0` 作为初始 key。
- `--log-dir`：日志目录，默认 `20260514`。
- `--at`：锚点时间。建议总是提供，否则会扫描整个目录，容易把同一车多次通行合在一起。
- `--window-minutes`：锚点前后的时间窗口，默认 `5`。
- `--rounds`：关联扩展轮数，默认 `2`。
- `--auto`：自动发现并聚合日志目录里的车辆事件，不需要输入车牌。
- `--list-events`：只列出候选通行事件，不生成合并文件。
- `--discover`：不知道车牌时，自动从日志中发现候选车辆事件。
- `--discover-output-dir`：配合 `--auto` / `--discover` 使用，指定批量生成 Markdown 的输出目录。`--auto` 未指定时默认输出到 `<日志目录名>_merged/`。
- `--gap-minutes`：事件切分间隔，默认 `10`。同一车牌相邻两条种子日志的时间差超过这个值时，会被拆成两次车辆事件。
- `--min-lines`：配合 `--auto` / `--discover` 使用，只保留至少包含这么多种子行的事件，默认 `1`。
- `--limit`：配合 `--auto` / `--discover` 使用，限制输出或生成的事件数量。
- `-o/--output`：输出 Markdown 文件。

## 不知道车牌时

如果希望指定一个日志目录后自动完成每辆车的聚合，用 `--auto`：

```bash
python3 merge_vehicle_logs.py \
  --auto \
  --log-dir 20260514 \
  --gap-minutes 10 \
  --min-lines 20
```

这会扫描整个 `20260514/`，自动发现车辆事件，并把每个事件生成一个 Markdown 文件，默认输出到 `20260514_merged/`。

这里的 `--gap-minutes 10` 表示：同一车牌如果前后两段明文车牌日志间隔超过 10 分钟，就认为是两次不同通行事件，分别生成两个 md。调小会把事件切得更细，调大则更容易把同一车当天相邻多次通行合在一起。

如果只想先看发现到了哪些车辆事件，不生成文件，可以使用 `--discover`：

```bash
python3 merge_vehicle_logs.py \
  --discover \
  --log-dir 20260514 \
  --at '2026-05-14 08:10:04' \
  --window-minutes 2 \
  --gap-minutes 1 \
  --min-lines 10
```

输出会按候选事件列出车牌、起止时间、种子行数、关联车道和来源类型：

```text
1. <车牌A> | 2026-05-14 08:10:00 ~ 2026-05-14 08:10:31 | lines=253 | lanes=3701643301 | sources=data, etc, fee, field, mtc, namelist
```

`--auto` 也可以限制规模或指定输出目录：

```bash
python3 merge_vehicle_logs.py \
  --auto \
  --log-dir 20260514 \
  --gap-minutes 10 \
  --min-lines 50 \
  --limit 10 \
  --discover-output-dir discovered
```

这时脚本会对每个候选事件复用同一套单车归并逻辑，输出文件名形如：

```text
discovered/merged_SAMPLE_20260514_081000.md
```

批量生成时，脚本会用候选事件的时间中点作为锚点，并自动把窗口扩大到覆盖整个候选事件，避免只用事件开始时间导致后半段被截掉。

## 输出结构

生成的 Markdown 主体由脚本自动写出：

- `# Vehicle Log Merge: <车牌>`
- `log_dir`、`time_window`、`matched_lines`、`extracted_keys`
- `## Keys`：本次归并使用/扩展出的关联键
- `## Timeline`：按时间排序后的日志原文，每条带来源文件和行号

部分 `merged_*.md` 文件顶部的 `## 解读摘要` 是人工补充的解读，不属于脚本自动生成内容。

## 从 Elasticsearch 取日志

`merge_vehicle_logs_es.py` 是同一套归并逻辑的 Elasticsearch 版本：日志不再从本地 `.log` 目录读，而是从 ES 的 `message` 字段取，其余部分（明文车牌防污染、关联键多轮扩展、线圈物理事件补齐、Markdown 输出格式）直接复用 `merge_vehicle_logs.py`。因此它生成的 `merged_*.md` 照样能转成 3D 回放数据。

默认连接 `http://192.168.22.212:9200`，可用 `--es-host` 覆盖。

### 字段对应关系

实测环境为 ES 7.17，索引形如 `ump_<站点>_<yyyy.MM>`：

| ES 字段 | 含义 | 对应原脚本 |
| --- | --- | --- |
| `message` | 完整原始日志行（含 `[时间] [车道] [级别]` 前缀） | `.log` 文件里的一行 |
| `time` | 本地时间字符串，如 `2026-07-01 12:06:54.640` | 行首时间戳 |
| `@timestamp` | UTC 时间，date 类型 | 时间窗口过滤与排序 |
| `logType` | `laneLog` / `etc` / `mtc` / `data` / `fee` / `namelist` | `file_kind()` 推导出的 `sources` |
| `landId` | 车道号，如 `3701643319` | 文件名/正文里的 `37016433xx` |
| `vlp` | 车牌（`keyword` 子字段用于聚合发现） | 明文车牌 |

时间窗口用 `@timestamp` 过滤；每行的时间戳优先从 `message` 行首解析（本地时间），解析不到时依次退化为 `--time-field` 字段、`time` 字段、`@timestamp`（后两者会转成本地时区）。默认 `--time-field` 本身就是 `@timestamp`，所以实际顺序是 `message` → `@timestamp` → `time` → `@timestamp`。

### 快速开始

先看有哪些索引，以及某个时间点会自动命中哪个索引（`--index` 支持通配，并会按索引名里的月份自动裁剪）：

```bash
python merge_vehicle_logs_es.py --index 'ump_*' --at '2026-07-01 12:06:54' --list-indices
```

归并一辆车的一次通行，参数与原脚本同名：

```bash
python merge_vehicle_logs_es.py <车牌> \
  --index 'ump_37016433_2026.07' \
  --at '2026-07-01 12:06:54' \
  --window-minutes 5 \
  -o merged_<车牌>_20260701_120654.md
```

从 ES 归并必须限定时间范围（`--at` 配 `--window-minutes`，或者 `--from`/`--to`），否则会在 18M 文档的索引上全表扫描：

```bash
python merge_vehicle_logs_es.py <车牌> --index 'ump_37016433_2026.07' \
  --from '2026-07-01 12:00:00' --to '2026-07-01 12:20:00' -o merged_sample.md
```

发现候选车辆（用 `vlp.keyword` 聚合，比整窗扫描快很多）：

```bash
python merge_vehicle_logs_es.py --discover --index 'ump_37016433_2026.07' \
  --at '2026-07-01 12:06:54' --window-minutes 10 --limit 10
```

不知道车牌时批量归并：

```bash
python merge_vehicle_logs_es.py --auto --index 'ump_37016433_2026.07' \
  --at '2026-07-01 12:06:54' --window-minutes 10 \
  --min-lines 20 --limit 10 --discover-output-dir discovered
```

已知车牌时先列候选通行，再挑锚点时间：

```bash
python merge_vehicle_logs_es.py <车牌> --index 'ump_37016433_2026.07' \
  --at '2026-07-01 12:06:54' --window-minutes 20 --list-events
```

### 常用参数

- `--index`：索引模式（支持 `*` 与逗号），默认 `ump_*`；给出时间范围时会按索引名里的 `yyyy.MM` 自动裁剪到相关月份（`--no-auto-index` 关闭）。
- `--es-host` / `--es-user` / `--es-password` / `--no-verify-tls` / `--timeout`：ES 连接。
- `--time-field` / `--message-field` / `--kind-field` / `--lane-field` / `--plate-field`：字段名，换一套索引体系时改这里。
- `--log-type`：只查指定 `logType`（可重复），例如 `--log-type laneLog`。
- `--extra-query`：追加任意 ES 查询 JSON 作为 filter 片段，例如按 `sectionId` 过滤。
- `--max-docs` / `--page-size`：**单次**检索的拉取上限与分页大小，默认 `20000` / `1000`，两者都必须是 ≥ 1 的整数。触顶会告警，并在 Markdown 头部写 `es_truncated: true`；若确实存在但被 `--max-docs` 截断，头部会带上命中总数。PIT 不可用时会退化为 `from/size`，此时单次最多只能取到 10000 条。
- `--min-lines`：候选事件的最小行数（与原脚本一致）；在 `--discover`/`--auto` 下它同时作为车牌聚合的 `min_doc_count`，也就是按窗口内的文档数先过滤一道。
- `--full-window-scan`：整窗全量拉取后在本地做子串匹配，语义与原脚本完全等价（较慢，窗口大时要调大 `--max-docs`）。
- `--no-lane-scan`：关闭「已发现车道全量重扫」。
- 以及与原脚本一致的 `--at`、`--from`/`--to`、`--window-minutes`、`--rounds`、`--gap-minutes`、`--min-lines`、`--limit`、`-o`。

### 查询策略与召回

`message` 是 text 字段、按 token 检索，而原脚本是子串匹配，两者并不等价。所以 ES 侧只负责「高召回候选」，最终某一行是否纳入一律由原脚本的 `line_matches`（子串匹配 + 明文车牌防污染）决定：

1. 每个关联 key 生成 `match_phrase` 加一条前缀通配，这样 `鲁UG6595` 也能命中 token `ug6595_1` 这种带车牌颜色后缀的形态；
2. 拿到车道后，对该车道在窗口内做一次全量重扫（`landId` 字段匹配，或正文里出现该车道号），兜住 token 边界的漏召回；
3. 仍会漏的是「key 落在更长 token 内部、且不在 token 开头」的行，例如 `|流水Id:G0015370050030202091020260701120003590801` 分词后整条是 `id:g0015...`。这类行只有 `--full-window-scan` 能拿到。

实测一次 5 分钟窗口的单车归并：默认模式 277 行，`--full-window-scan` 278 行，并且默认模式**命中 key 的那些行**是严格模式结果的子集——不会多出不属于该车的行（实测多出 0 条，缺 1 条）。日常分析用默认模式，需要绝对完整时用 `--full-window-scan`。

严格来说，子集关系只对「按 key 命中的行」成立：线圈/车检器那一段是另一条按车道查询的路径，如果车道查询漏了某条落杆信号，`coil_passages` 有可能把前后两个物理过车合并成一个，选出的过车段就和严格模式不完全一致。它带来的只会是同车道、无车牌的车检器行，不会引入别的车的数据。

### 与原脚本的差异

- 去重键从 `(文件路径, 行号)` 换成 `(_index, _id)`。
- `## Timeline` 里每条来源写成 `` `logType:索引#文档id` ``，便于回 ES 复查原文。
- Markdown 头部多出 `source`、`es_host`、`index`、`es_docs_scanned`、`es_requests`（检索次数，不含 PIT/元数据请求），截断时还有 `es_truncated`。控制台那行会同时给出检索次数和 HTTP 总请求数。
- `--log-dir` 不再存在；`--at` 变成必填（或改用 `--from`/`--to`）。

## 从 ES 到可视化：完整跑一遍

```bash
# 1) 从 ES 归并一辆车，生成 merged_*.md
python merge_vehicle_logs_es.py <车牌> --index 'ump_37016433_2026.07' \
  --at '2026-07-01 12:06:54' --window-minutes 5 \
  -o merged_<车牌>_20260701_120654.md

# 2) 转成 3D 回放数据（写出 replay/data/*.json 和 replay/data/index.json）
python replay/generate_replay_data.py merged_<车牌>_20260701_120654.md --out-dir replay/data

# 3) 在仓库根目录起静态服务
python -m http.server 8765

# 4) 浏览器打开
#    http://localhost:8765/replay/index.html
```

页面左上角的下拉框会自动列出 `replay/data/index.json` 里的全部车辆事件，选中后即可播放。也可以批量生成多辆车再一起转回放数据：

```bash
python merge_vehicle_logs_es.py --auto --index 'ump_37016433_2026.07' \
  --at '2026-07-01 12:06:54' --window-minutes 10 \
  --min-lines 20 --limit 10 --discover-output-dir discovered

python replay/generate_replay_data.py discovered/merged_*.md --out-dir replay/data
```

三点注意：

- 必须从仓库根目录启动 `python -m http.server`，因为页面用相对路径 `./data/index.json` 取数据。
- 必须通过 `http://` 访问。直接用 `file://` 打开 `replay/index.html` 会因为浏览器的 ES module/跨域限制而加载不了 three.js。
- 如果不用 8765 端口，换成 `python -m http.server 9000`，URL 里的端口同步改掉即可。页面左上角下拉框为空，通常是因为第 2 步没跑或 `replay/data/index.json` 不存在。

## 3D 回放

`replay/` 目录里有一个基于 Three.js 的静态回放器，可以把 `merged_*.md` 转成车辆过站/出站的语义回放。

如果本地还没有 `merged_*.md`，先用单车或自动聚合命令生成 Markdown。生成后的 `merged_*.md` 属于本地分析产物，默认不会提交到 Git。

先把 Markdown 转成回放数据：

```bash
python3 replay/generate_replay_data.py merged_*.md --out-dir replay/data
```

再在仓库根目录启动静态服务：

```bash
python3 -m http.server 8765
```

浏览器打开：

```text
http://localhost:8765/replay/index.html
```

也可以直接打开某个回放文件：

```text
http://localhost:8765/replay/index.html?file=merged_SAMPLE_20260514_080028.json
```

页面操作：

- 左上角下拉框选择车辆事件。
- 底部 `播放/暂停` 控制回放，进度条可以拖到任意日志事件。
- 倍速支持 `0.05x`、`0.1x`、`0.25x`、`0.5x`、`1x`、`2x`、`4x`。
- 右上角四个视角按钮：`全景`、`车道现场`、`虚拟机房`、`省中心`，点击后相机平滑切到对应视角。
- 鼠标左键拖拽旋转视角，滚轮缩放，右键拖拽平移视角。
- 右侧面板只显示本次通行标题和日志列表；当前事件会高亮，并跟随播放自动滚动。
- 点击右侧任意日志行，可以跳到对应事件并暂停播放。

场景分成两块，中间用一条链路连接：

- **车道现场（通行设备）**：沿车辆行驶方向（+Z）按实际过车顺序排布：`车牌识别 → 称重/治超 → 车型识别 → 车检器1 → 前 ETC 天线（预交易）→ 车检器2 → CPC 读卡 → 车道控制器 → 车检器6（存在线圈）→ 后 ETC 天线（交易）→ 费显/LED → 车检器7（落杆线圈）→ 栏杆`。线圈和称重平台在路面上，栏杆、费显、CPC 读卡、车道控制器放在右侧收费岛上，车牌识别/车型识别/车道摄像机用立柱横臂悬在车道上，前后 RSU 由龙门架承载，岗亭、关道设备、存在线圈标注等按车道类型显示。
- **虚拟机房（收费系统）**：交易服务、名单服务、计费服务、消息/MQ、流水/Redis 各自一台机柜，独立放在车道右侧的玻璃机房里（另有精密空调、配电柜、核心交换/ODF 等非事件设备作为机房配套），不再和通行设备挤在车道旁。
- **虚拟省中心**：在机房更外侧，建模为带窗带、天线和信号灯的多层建筑。

两条链路跟着事件亮起并在路径上跑数据包：事件落在机房服务上时点亮「车道 → 机房」链路；与省中心交互的服务（交易、名单、计费、消息/MQ）还会点亮「机房 → 省中心」链路，而流水/Redis 属于本地落库，只点亮车道到机房这一段。车辆模型上带有 OBU 车载单元；当日志事件属于 RSU/OBU 通信时，会高亮 RSU 到车辆 OBU 的通信连线；`success` 事件会把栏杆臂抬起（绕岛上的转轴旋转），`reject` 事件落杆。右侧时间线同步显示对应日志原文。

车辆本身按日志时间单向沿车道推进；当前事件对应的设备或服务节点会高亮。这样可以避免后台补写流水、牌识匹配、MQ 回执等事件把车辆“拉回”到前面的设备位置。左侧图例按「通行设备 · 车道现场」和「收费系统 · 虚拟机房」分组；被车道类型过滤掉的设备（例如 ETC 车道里的称重/治超、CPC 读卡）平时不显示，但当事件正好落在它身上时会临时显示，避免高亮一个看不见的对象。

车辆本身按日志时间单向沿车道推进；当前事件对应的设备或服务节点会高亮。这样可以避免后台补写流水、牌识匹配、MQ 回执等事件把车辆“拉回”到前面的设备位置。

线圈会按车道类型显示为具体车检器位置。ETC 车道中，`车检器1` 对应从左往右第一个车辆检测器，`车检器2` 对应第二个车辆检测器，`车检器7` 对应落杆线圈；MTC/混合车道中，`车检器6` 对应存在线圈，`车检器7` 对应落杆线圈。如果日志中出现 `车检器x` 或 `线圈为:x号`，回放会高亮对应线圈。

## 归并流程

### 1. 选择文件

如果传入 `--at`，脚本只读取时间窗口覆盖到的小时日志文件。

例如锚点为 `2026-05-14 08:10:04`，窗口为 4 分钟，就会选择文件名中包含 `20260514_08` 的日志。这样能避免跨小时或全天扫描造成的污染。

如果没有传入 `--at`，脚本会扫描整个日志目录，并在标准错误输出警告。

### 2. 初始 key

脚本从两个初始 key 开始：

```text
<车牌>
<车牌>_0
```

例如目标车牌是 `<车牌>`，初始 key 就是：

```text
<车牌>
<车牌>_0
```

后续只要日志行包含当前 key 集合中的任意一个 key，就可能被纳入。

### 3. 明文车牌优先过滤

这是脚本里最重要的防污染规则。

如果一行日志中出现了明文车牌，并且这些车牌全都不是目标车牌，脚本会直接排除这一行。

实现上会先把车牌颜色后缀去掉再比较，例如：

```text
<车牌>
<车牌>_0
<车牌>_1
```

都会被视为同一辆基础车牌 `<车牌>`。

这个规则可以挡住同一车道、同一服务、同一时间窗口内的其他车辆日志。例如日志中明确是 `<其他车牌A>_4`、`<其他车牌B>_0`，而目标车不是它们，就不会因为共用 topic、trace 或时间窗口被合入。

有一种例外需要人工解读：同一条交易报文里可能同时出现目标车牌和另一个识别字段，例如入口牌、出口牌不一致。这种行不会被过滤，因为它仍然包含目标车牌，脚本会保留原文，交给后续分析判断是否属于同一笔交易。

### 4. 提取关联 key

脚本会从匹配到的日志行里提取关联键，用于下一轮扩大匹配范围。

支持的 key 类型包括：

- 明文车牌：`vehicleId`、`feeVehicleId`、`identifyVehicleId`、`plateNum`、`vlp`
- 介质/卡/OBU：`mediaNo`、`cardId`、`cpuId`、`obuId`、`serialNumber`
- 交易链路：`passId`、`tradeId`、`vehiclesignid`
- Redis 流水 key：`WASTE_...`、`BAK_WASTE_...`
- 部分请求文件名：`*_REQ_*.json`、`*_RES_*.json`

提取时会过滤一些明显噪声：

- `NONE`
- `null`
- `null_null`
- 全 0 长串
- URL
- `plateNum` / `vlp` 里的十六进制编码值

### 5. 关联扩展

每一轮归并流程是：

1. 用当前 key 集合扫描选中的日志文件。
2. 找到匹配行后记录时间、文件、行号和原文。
3. 从这些匹配行里提取新的可扩展 key。
4. 把新 key 加入集合，进入下一轮。
5. 如果没有新 key，提前结束。

默认扩展两轮。两轮通常足够把车道日志、服务日志、数据服务流水、Redis key 串起来。

为了减少误扩散，`msgId` 和 `filename` 会出现在输出的 `Keys` 中，但不会作为后续扩展 key 使用。它们太容易把同一窗口内的服务请求批量拉进来。

### 6. 去重与排序

脚本用 `(文件路径, 行号)` 去重，因此同一行即使被多个 key 命中，也只输出一次。

最终按以下顺序排序：

```text
日志时间 -> 文件路径 -> 行号
```

这样可以把车道侧和服务侧日志交错排成一条时间线。

### 7. 线圈物理事件补齐

车检器/线圈日志通常不带车牌，单纯靠车牌和交易 key 无法命中。但在理解车道布局后，这类日志反而是判断车辆实际位置的关键证据。

脚本会在已经归并出的日志中提取车道号，再读取同一车道、同一时间窗口内的车辆检测器日志，并按 `有信号/无信号` 或 `true/false` 状态变化切成物理通行片段。随后选择最接近本次车辆事件锚点的片段，把该片段内的线圈日志补进结果。

当前按两种布局理解线圈：

- ETC 专用车道：`车检器1`、`车检器2`、`车检器7`，其中 `车检器7` 是落杆线圈。
- ETC/MTC 混合车道：`车检器6`、`车检器7`，其中 `车检器6` 是存在线圈，`车检器7` 是落杆线圈。

这一步只在已经确认的车道内取最近的物理通行片段，不会因为同一时间窗口里其他车道的线圈变化而合入无关日志。

## 事件列表模式

`--list-events` 用于已知某个车牌时，不做完整合并，只扫描包含目标车牌的日志行，并按时间间隔聚类。

例如：

```bash
python3 merge_vehicle_logs.py <车牌> --log-dir 20260514 --list-events --gap-minutes 10
```

输出类似：

```text
1. <车牌A> | 2026-05-14 08:10:00 ~ 2026-05-14 08:10:31 | lines=... | lanes=3701643301 | sources=data, etc, field
```

这个模式主要用于先找锚点时间，再用 `--at` 做精确合并。

## 使用建议

- 未知车牌时优先用 `--auto --log-dir <目录>` 批量生成；已知车牌时可以用 `--list-events` 找候选通行，再选最接近交易发生时间的 `--at`。
- 窗口不要开太大。入口/出口成功交易一般 3 到 5 分钟够用，复杂恢复链路可以适当加大。
- 如果输出中出现明显其他车辆，优先检查这些行是否同时包含目标车牌。如果不包含，说明过滤规则可能还需要加强；如果同时包含，通常是同一交易中的识别不一致或入出口信息差异。
- 对 CPC 出口、ETC 出口、入口拒绝、称重缺失恢复这类形态，可以分别生成样本文件做对照。

## 本地样本

`merged_*.md`、`*.docx`、`*.png` 都属于本地分析材料，默认被 `.gitignore` 忽略。可以在本地保留不同交易形态的样本，例如 MTC/CPC 入口、ETC 出口成功、ETC 入口、CPC 出口成功、入口拒绝、称重缺失恢复、标签异常拒绝等。
