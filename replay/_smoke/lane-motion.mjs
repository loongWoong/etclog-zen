/**
 * lane-motion.js — 把「日志时刻」还原成「车辆在车道上的位置」。
 *
 * 为什么需要它：日志里一条「设备事件」并不等于「车此刻在这个设备上」。
 * 实测一整窗口（8 条车道 / 103 趟过程 / 1889 条节点）里混着三类节点：
 *   ① 真实位置事件：线圈压上/释放、牌识上传、称重、轴型、读卡、ETC 天线帧
 *   ② 后台/流水事件：redis 入库、流水生成、过期缓存清理、名单/参数查询、MQTT、交易报文解析
 *   ③ 异常事件：ConnectException、发送失败、校验失败
 * ②③ 只是被过程窗口圈进来的邻居日志。旧实现把「凡是有设备字段的节点」都当成
 * 车辆的 z 锚点，还按数组顺序做了单调钳制，结果 65% 的锚点位置对不上、
 * 平均偏差 12.6m、最大 48m，车会「停在原地看设备乱亮」或瞬间跳到几十米外。
 *
 * 本模块的处理链：
 *   1. classifyEvent()：分清「位置事件」与「非位置事件」，给出所属站点
 *   2. 线圈占用区间 → 位置约束：车压着线圈就是停在那儿（含一直不释放=压着不走）
 *   3. 同站点连发（相机连拍、帧广播）合并成一个到达时刻
 *   4. 沿物理顺序重建单调轨迹：取「按 z 非降」的最大可信子序列（LNDS），
 *      互相矛盾的日志事件被剔除并计数（不硬凑、也不求平均）
 *   5. 限速摊平：按车道限速把过密的时刻往后挪，斜率受限于限速（不瞬移）
 *   6. 补入口段/出口段，PCHIP 单调三次插值 → 任意时刻的位置与速度
 *
 * 纯函数、无三方依赖，可在 Node 里直接跑（replay/_smoke/motion-test.mjs）。
 */

const EMPTY = "（无正文）";

/** 非位置事件（②）：命中即不当锚点。顺序有意义，先匹配到的原因会记录进诊断。 */
export const REJECT_RULES = [
  [/清理过期|过期数据|内存仓库|清除缓存/i, "过期缓存清理"],
  [/redis入库|入库成功|流水生成|生成交易.*流水|流水Id|流水号生成|完整tolling保存/i, "流水/入库"],
  [/ConnectException|Connection refused|连接[^，。；]{0,8}(异常|失败)|发送[^，。；]{0,10}失败|请求失败|调用失败|校验[^，。；]{0,6}失败/i, "异常/失败"],
  [/查询全网|名单服务|参数编码|查询语句|远程值守|MQTT|消息服务|组播|心跳|校时|对时|版本查询|有效性判断|重复交易|队列逻辑|参数获取|发行方校验|解析交易报文|计费请求|计费服务|费率/i, "后台服务"],
  [/收到消息：主题.*\/Ask\/|DevCtl|STDevctl|不交易|栏杆处于抬杆状态，且非车队开启/i, "控制/状态消息"],
];

const RE = {
  coilOn: /有信号/,
  coilOff: /无信号/,
  coilAny: /车检器(\d+)/,
  laneHex: /37016433[0-9A-Fa-f]{2}/g,
  barrierUp: /抬杆到位|抬落杆到位信号上报-\[抬杆到位\]/,
  barrierDown: /落杆到位|抬落杆到位信号上报-\[落杆到位\]/,
  barrierCmd: /控制指令执行成功|控制消息【(抬|落)杆】/,
  vlpr: /车牌识别结果上传|高清车牌识别设备数据|Push\/DevInfo\/Vlpr/i,
  weigh: /处理入口治超信息|称重数据|轴重|重量/i,
  axle: /Push\/DevInfo\/Axle|Reply\/DevInfo\/Axle|车轴型数据|轴型|车型识别|轴数/i,
  cpc: /CPC出口交易|CPC入口交易|读卡成功|收到CPC数据|CPC卡信息确认/i,
  rsu: /RSU数据|B4帧|收到OBU信息|查询标签是否|查询OBU/i,
  lanePass: /最后一辆车触发通过线圈|过车队列（交易成功）|交易成功|交易完成|放行成功/i,
  display: /显示屏|费显|显示控制|显示内容|\bLED\b/i,
};

/** 取节点正文：两个页面的字段名不一样（lanes 用 text，index 用 summary/raw） */
export function eventText(event) {
  return String(event?.text ?? event?.summary ?? event?.raw ?? EMPTY);
}

/** 从节点里解出线圈号与状态：lanes 用 coil:"车检器6有信号"，index 用 coilId/coilState */
export function coilReading(event) {  const text = eventText(event);
  if (event?.coilId && event?.coilState) return { id: String(event.coilId), on: event.coilState === "有信号" };
  const field = event?.coil;
  if (typeof field === "string" && field) {
    const match = RE.coilAny.exec(field);
    if (match) return { id: match[1], on: RE.coilOn.test(field) && !RE.coilOff.test(field) };
  }
  const match = RE.coilAny.exec(text);
  if (match && (RE.coilOn.test(text) || RE.coilOff.test(text))) return { id: match[1], on: RE.coilOn.test(text) && !RE.coilOff.test(text) };
  return null;
}

/**
 * 一个节点是不是「车辆位置事件」。
 * @param {object} event 节点/事件
 * @param {object} stations 站点 z 表（键见文件尾的 stationsFrom）
 * @param {object} stage 过程上下文：{ tradeSeen } 用于分前/后 ETC 天线
 * @returns {{key:string, z:number, trust:number, why:string, coil?:{id:string,on:boolean}}|null}
 */
/**
 * 这条日志是不是在本车道上发生的？
 * 一次合并日志里会混进相邻车道/匝道门架的记录（例：同一辆车的「匝道车牌识别」
 * 和「车道车牌识别」相差 19s，是两个不同的物理位置），必须按车道号剔掉。
 * @returns {string|null} 不是本车道时返回命中的车道号
 */
export function foreignLane(event, laneId) {
  if (!laneId) return null;
  const own = String(laneId).toUpperCase();
  const declared = event?.lane ? String(event.lane).toUpperCase() : null;
  if (declared && declared !== own && /^[0-9A-F]{10}$/.test(declared)) return declared;
  const hexes = eventText(event).match(RE.laneHex);
  if (!hexes) return null;
  for (const hex of hexes) if (hex.toUpperCase() !== own) return hex.toUpperCase();
  return null;
}

export function classifyEvent(event, stations, stage = {}) {
  const text = eventText(event);
  const device = event?.device ?? null;

  // 别的车道/匝道门架的日志一律不算（它们的物理位置与本车道无关）
  if (foreignLane(event, stage.laneId)) return null;
  const coil = coilReading(event);
  if (coil) {
    const z = stations[`coil${coil.id}`];
    if (typeof z === "number") return { key: `coil${coil.id}`, z, trust: 1, why: "线圈信号", coil };
  }
  if (RE.barrierUp.test(text) || RE.barrierDown.test(text)) {
    if (typeof stations.barrier === "number") return { key: "barrier", z: stations.barrier, trust: 0.5, why: "栏杆到位" };
  }
  if ((event?.kind === "billing" || event?.kind === "store")) return null;
  for (const [re] of REJECT_RULES) if (re.test(text)) return null;
  if ((event?.severity ?? "info") === "error") return null;

  if (device === "barrier" && RE.barrierCmd.test(text) && typeof stations.barrier === "number") {
    return { key: "barrier", z: stations.barrier, trust: 0.4, why: "栏杆动作" };
  }
  if (device === "lane" && RE.lanePass.test(text) && typeof stations.lane === "number") {
    return { key: "lane", z: stations.lane, trust: 0.5, why: "车道交易/过车" };
  }
  if (device === "vlpr" && RE.vlpr.test(text) && typeof stations.vlpr === "number") {
    return { key: "vlpr", z: stations.vlpr, trust: 0.9, why: "牌识上传" };
  }
  if (device === "weigh" && RE.weigh.test(text) && typeof stations.weigh === "number") {
    return { key: "weigh", z: stations.weigh, trust: 0.6, why: "称重" };
  }
  if (device === "axle" && RE.axle.test(text) && typeof stations.axle === "number") {
    return { key: "axle", z: stations.axle, trust: 0.6, why: "轴型" };
  }
  if (device === "cpc" && RE.cpc.test(text) && typeof stations.cpc === "number") {
    return { key: "cpc", z: stations.cpc, trust: 0.6, why: "读卡" };
  }
  if (device === "rsu" && RE.rsu.test(text)) {
    const key = stage.tradeSeen ? "rsu" : "rsuFront";
    const z = stations[key] ?? stations.rsu;
    if (typeof z === "number") return { key, z, trust: 0.8, why: stage.tradeSeen ? "ETC交易天线" : "ETC预交易天线" };
  }
  // 信息显示屏/费显：控制指令发出时车还在岗亭一侧，屏在车道下游十几米，
  // 它不是「车到了屏幕这里」→ 不当轨迹锚点（见 README「位置事件的口径」）。
  if (device === "display" && RE.display.test(text)) return null;
  return null;
}

/** 位置事件被剔除的原因（用于诊断/自检） */
export function rejectReason(event, stations, laneId = null) {
  const text = eventText(event);
  const foreign = foreignLane(event, laneId);
  if (foreign) return `别的车道(${foreign})`;
  for (const [re, why] of REJECT_RULES) if (re.test(text)) return why;
  if ((event?.severity ?? "info") === "error") return "异常/失败";
  if (event?.device === "display") return "信息屏（非位置设备）";
  if (event?.kind === "billing" || event?.kind === "store") return "流水/入库";
  return "无位置语义";
}

/** 同站点连发合并（相机连拍、帧广播）：保留第一次到达时刻 */
function collapseBursts(anchors, gapMs = 3000) {
  const out = [];
  for (const anchor of anchors) {
    const previous = out[out.length - 1];
    const same = previous && previous.key === anchor.key && Math.abs(previous.z - anchor.z) < 1e-9;
    if (same && !previous.hold && !anchor.hold && anchor.o - previous.o <= gapMs) {
      previous.repeats += 1;
      previous.lastO = anchor.o;
      previous.trust = Math.max(previous.trust, anchor.trust);
      continue;
    }
    out.push({ ...anchor, repeats: 1, lastO: anchor.o });
  }
  return out;
}

/**
 * 取「按 z 非降」的最大可信子序列（LNDS）：
 * 日志里偶尔会把下游设备记在上游设备之前（上传延迟、缓存刷新、别的车道的邻居日志），
 * 这类节点无法与物理顺序同时满足，只能剔除 —— 但会如实计数，不硬凑、也不求平均。
 */
function selectMonotone(anchors) {
  const n = anchors.length;
  if (n <= 1) return anchors.slice();
  const weight = new Array(n).fill(0);
  const count = new Array(n).fill(1);
  const from = new Array(n).fill(-1);
  for (let i = 0; i < n; i += 1) {
    weight[i] = anchors[i].trust;
    for (let j = 0; j < i; j += 1) {
      if (anchors[j].z > anchors[i].z + 1e-9) continue;
      const w = weight[j] + anchors[i].trust;
      const c = count[j] + 1;
      if (w > weight[i] + 1e-9 || (Math.abs(w - weight[i]) < 1e-9 && c > count[i])) {
        weight[i] = w;
        count[i] = c;
        from[i] = j;
      }
    }
  }
  let best = 0;
  for (let i = 1; i < n; i += 1) {
    if (weight[i] > weight[best] + 1e-9 || (Math.abs(weight[i] - weight[best]) < 1e-9 && count[i] > count[best])) best = i;
  }
  const chain = [];
  for (let i = best; i >= 0; i = from[i]) {
    chain.push(anchors[i]);
    if (from[i] < 0) break;
  }
  return chain.reverse();
}

/** Fritsch–Carlson 单调三次插值（PCHIP）：过锚点、不越界、速度连续 */
export function pchipSlopes(xs, ys) {
  const n = xs.length;
  const h = new Array(n - 1);
  const d = new Array(n - 1);
  for (let i = 0; i < n - 1; i += 1) {
    h[i] = xs[i + 1] - xs[i];
    d[i] = (ys[i + 1] - ys[i]) / h[i];
  }
  const m = new Array(n).fill(0);
  if (n === 2) {
    m[0] = d[0];
    m[1] = d[0];
    return m;
  }
  for (let i = 1; i < n - 1; i += 1) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  const endSlope = (ha, hb, da, db) => {
    let value = ((2 * ha + hb) * da - ha * db) / (ha + hb);
    if (value * da <= 0) value = 0;
    else if (da * db < 0 && Math.abs(value) > Math.abs(3 * da)) value = 3 * da;
    return value;
  };
  m[0] = endSlope(h[0], h[1], d[0], d[1]);
  m[n - 1] = endSlope(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
  return m;
}

/** 三次 Hermite 在 [t0,t1] 上是否单调（导数 q(s)=3a·s²+2b·s+m0 在 [0,1] 不变号）。 */
function segmentMonotone(z0, z1, h, m0, m1) {
  const dz = z1 - z0;
  const a = (h * (m0 + m1) - 2 * dz) / (h * h * h);
  const b = (3 * dz - h * (2 * m0 + m1)) / (h * h);
  const rising = dz >= 0;
  const ok = (value) => (rising ? value >= -1e-12 : value <= 1e-12);
  if (!ok(m0) || !ok(3 * a + 2 * b + m0)) return false;
  if (Math.abs(a) < 1e-18) return true;
  const vertex = -b / (3 * a);
  if (vertex > 0 && vertex < 1) return ok(3 * a * vertex * vertex + 2 * b * vertex + m0);
  return true;
}

/**
 * 锚点上的速度（曲线斜率）再做一轮**松弛**：把某一点的速度往左右相邻两点的平均值拉，
 * 让加/减速摊到更长的段落上。
 *
 * 为什么需要：Fritsch–Carlson 的斜率只看相邻两段（纯局部）。日志经常是"先慢后快"——
 * 例：vlpr 到线圈1 平均 2.8m/s，紧接着 4m 只用 0.4s（平均 10m/s）。局部斜率会让曲线
 * 在 0.4s 内把速度从 2.8 拉到 10，顶点加速度 117m/s²（像瞬移）。锚点的**时刻**是证据
 * （不能动），但锚点上的**速度**没有证据：把速度"提前预热"，就能既守住每个锚点时刻、
 * 又把 |a| 摊平（同一段实测 117 → 4 以内）。
 *
 * 可行性用**逐段精确**单调判定（三次导数的抛物线），不用 Fritsch–Carlson 的
 * `|m| ≤ 3·min(段斜率)` 充分条件 —— 那个条件在"先慢后快"的锚点上过保守，
 * 正好把需要的预热速度挡在外面。
 */
export function relaxSlopes(times, zs, slopes, options = {}) {
  const { startAtRest = false, endAtRest = false, rounds = 40, weight = 0.5, maxSpeed = null } = options;
  const n = times.length;
  if (n < 4) return slopes.slice();
  const cap = maxSpeed === null ? null : maxSpeed / 1000;
  const out = slopes.slice();
  const feasible = (i, value) => {
    const bounded = cap === null ? value : Math.max(-cap, Math.min(cap, value));
    if (bounded !== value) return null;
    if (i > 0 && !segmentMonotone(zs[i - 1], zs[i], times[i] - times[i - 1], out[i - 1], value)) return false;
    if (i < n - 1 && !segmentMonotone(zs[i], zs[i + 1], times[i + 1] - times[i], value, out[i + 1])) return false;
    return true;
  };
  for (let round = 0; round < rounds; round += 1) {
    const next = out.slice();
    for (let i = 1; i < n - 1; i += 1) {
      const blended = out[i] * (1 - weight) + ((out[i - 1] + out[i + 1]) / 2) * weight;
      if (blended === out[i]) continue;
      if (feasible(i, blended) === true) { next[i] = blended; continue; }
      // 不可行就二分找最远的可行点，保证每一轮都在往"摊平"的方向走
      let low = 0;
      let high = 1;
      for (let step = 0; step < 14; step += 1) {
        const mid = (low + high) / 2;
        if (feasible(i, out[i] + (blended - out[i]) * mid) === true) low = mid;
        else high = mid;
      }
      const value = out[i] + (blended - out[i]) * low;
      if (cap !== null) next[i] = Math.max(-cap, Math.min(cap, value));
      else next[i] = value;
    }
    if (startAtRest) next[0] = 0;
    if (endAtRest) next[n - 1] = 0;
    for (let i = 0; i < n; i += 1) out[i] = next[i];
  }
  return out;
}

/**
 * 单调三次路径（Fritsch–Carlson 保形 Hermite）。times 单位 ms，z 单位 m。
 *
 * maxSpeed（m/s）夹住各锚点处的瞬时速度；三段 Bézier 控制斜率的凸包能保证瞬时速度落在
 * [0, 3·max(段斜率)] 里，所以真正"不超速"是由 buildMotion 的速度预算迭代来保证的
 * （实测峰值 ≤ 限速）。
 *
 * startAtRest/endAtRest：把首/末锚点处的斜率钉成 0。车是从入口**静止起步**的，
 * 停在栏杆上的那趟也是**减速停住**的；不钉的话曲线在两端会以限速斜率"起步"，
 * 而曲线端点之外是常量段（速度 0），接上去就是一个速度突变 —— 看起来像瞬移，
 * 交给刹车灯/悬挂更会算出一个几百 m/s² 的假急刹。
 */
export function makePath(times, zs, maxSpeed = null, options = {}) {
  // relax 默认关：单纯"把斜率往邻居平均值拉"会同时破坏逐段的单调性（相邻段的约束互相交叉），
  // 而且它的不动点是"斜率随锚点序号线性变化"，不是"让每段速度尽量恒定"——实测反而把
  // |a| 峰值从 21.7 抬到 31.7、并引入 223 个后退采样。要做对需要整体时间重参数化
  // （最小化 max|a| 的小型可行性问题），已记在 README 的已知限制里，这里只留开关。
  const { startAtRest = false, endAtRest = false, relax = false } = options;
  const n = times.length;
  const initial = pchipSlopes(times, zs);
  const slopes = relax ? relaxSlopes(times, zs, initial, { startAtRest, endAtRest, maxSpeed }) : initial;
  if (maxSpeed !== null && n > 1) {
    const cap = maxSpeed / 1000;   // m/ms
    for (let i = 0; i < n; i += 1) slopes[i] = Math.max(0, Math.min(slopes[i], cap));
  }
  if (n > 1 && startAtRest) slopes[0] = 0;
  if (n > 1 && endAtRest) slopes[n - 1] = 0;
  const at = (x) => {
    if (x <= times[0]) return zs[0];
    if (x >= times[n - 1]) return zs[n - 1];
    let low = 0;
    let high = n - 1;
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if (times[mid] <= x) low = mid;
      else high = mid;
    }
    const h = times[low + 1] - times[low];
    const s = (x - times[low]) / h;
    const s2 = s * s;
    const s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * zs[low]
      + (s3 - 2 * s2 + s) * h * slopes[low]
      + (-2 * s3 + 3 * s2) * zs[low + 1]
      + (s3 - s2) * h * slopes[low + 1];
  };
  return { at, times, zs, slopes };
}

/**
 * 同一个 z 上、20ms 以内的两个锚点（线圈"压上/释放"被时间预算或撑段挤到一起了）在物理上
 * 就是同一时刻：留着会在曲线里造出一个"零长度停留"，把该点的斜率钉死成 0，
 * 于是前一段只能"从 0 起步、到 0 收尾"—— 4m/0.4s 就变成 ~140m/s² 的假急刹。
 * 合并时保留后者（时刻更靠后 ≈ 占位结束）。
 */
const DEGENERATE_MS = 20;

/**
 * 从节点序列里挑出位置锚点（供轨迹与 3D 设备脉冲共用）。
 * @returns {{anchors:Array, dropped:Array, rejected:object, coilWindows:Array}}
 */
export function planAnchors(options) {
  const {
    events = [],
    stations = {},
    windowTo = 0,
    stopThresholdMs = 1500,
    minHoldMs = 250,
    collapseGapMs = 3000,
    laneId = null,
    coilTrust = 50,
    mergeCoilGapMs = 3000,
  } = options;
  const sorted = events.slice().sort((a, b) => a.o - b.o);
  const rejected = {};
  const coilWindows = [];
  const raw = [];
  let tradeSeen = false;
  const open = new Map();

  for (const event of sorted) {
    if (event.device === "lane" && RE.lanePass.test(eventText(event))) tradeSeen = true;
    const hit = classifyEvent(event, stations, { tradeSeen, laneId });
    if (!hit) {
      const why = rejectReason(event, stations, laneId);
      rejected[why] = (rejected[why] ?? 0) + 1;
      continue;
    }
    if (hit.coil && hit.coil.on) {
      open.set(hit.key, { key: hit.key, z: hit.z, t0: event.o });
      continue;
    }
    if (hit.coil && !hit.coil.on) {
      const start = open.get(hit.key);
      open.delete(hit.key);
      coilWindows.push({ key: hit.key, z: hit.z, t0: start ? start.t0 : event.o, t1: event.o, open: !start });
      continue;
    }
    raw.push({ o: event.o, z: hit.z, key: hit.key, trust: hit.trust, why: hit.why, at: event });
  }
  // 一直没释放的线圈：车压着不走（这正是"超时"在 3D 里的样子），平台延伸到窗口末
  for (const start of open.values()) {
    coilWindows.push({ key: start.key, z: start.z, t0: start.t0, t1: Math.max(start.t0, windowTo), open: false, stuck: true });
  }

  // 同一根线圈在一次过车里被反复"压上→释放"（信号抖动）：并成一个占用区间，
  // 否则会出现 1ms 的"两次占用"，把轨迹钉在同一个点上。
  coilWindows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.t0 - b.t0));
  const mergedWindows = [];
  for (const window of coilWindows) {
    const previous = mergedWindows[mergedWindows.length - 1];
    if (previous && previous.key === window.key && window.t0 - previous.t1 <= mergeCoilGapMs) {
      previous.t1 = Math.max(previous.t1, window.t1);
      previous.merged += 1;
      continue;
    }
    mergedWindows.push({ ...window, merged: 1 });
  }

  const coilAnchors = [];
  for (const window of mergedWindows) {
    const span = window.t1 - window.t0;
    window.span = span;
    window.stop = span > stopThresholdMs;
    if (window.stuck) {
      // 到窗口结束都没释放：车压着线圈不走。只钉"到达"这一刻，
      // 后面的停留时间由"下一个锚点要开多远"自然算出来（不会被硬钉在窗口末）。
      const hold = Math.min(minHoldMs, Math.max(1, span * 0.2));
      window.anchors = [window.t0 + hold];
      coilAnchors.push({ o: window.anchors[0], z: window.z, key: window.key, trust: coilTrust, why: "线圈压上后一直未释放（压着不走）", coil: window });
    } else if (window.stop) {
      const hold = Math.min(minHoldMs, span * 0.2);
      window.anchors = [window.t0 + hold, Math.max(window.t0 + hold + 1, window.t1 - hold)];
      coilAnchors.push({ o: window.anchors[0], z: window.z, key: window.key, trust: coilTrust, why: "线圈压上（停在线圈上）", hold: true, coil: window });
      coilAnchors.push({ o: window.anchors[1], z: window.z, key: window.key, trust: coilTrust, why: "线圈释放", hold: true, coil: window });
    } else {
      window.anchors = [(window.t0 + window.t1) / 2];
      coilAnchors.push({ o: window.anchors[0], z: window.z, key: window.key, trust: coilTrust, why: "线圈压上/释放", coil: window });
    }
  }

  const merged = collapseBursts(raw.slice().sort((a, b) => a.o - b.o), collapseGapMs)
    .concat(coilAnchors)
    .sort((a, b) => a.o - b.o);
  const anchors = selectMonotone(merged);
  const kept = new Set(anchors);
  const dropped = merged.filter((item) => !kept.has(item));
  return { anchors, dropped, rejected, coilWindows: mergedWindows, tradeSeen };
}

/**
 * 把一趟过程的节点还原成运动曲线。
 *
 * @param {object} options
 * @param {Array}  options.events     节点/事件（不必预先排序）
 * @param {object} options.stations   {vlpr:-22, weigh:-19.5, axle:-16.5, rsuFront:-12.4,
 *                                     cpc:6, lane:9, rsu:14.5, barrier:24, coil1:-14.5, ...}
 * @param {number} options.windowFrom 过程起点（日志时刻 ms）
 * @param {number} options.windowTo   过程终点
 * @param {number} options.zMin/zMax  车道可行驶范围
 * @param {number} options.entrySpeed 从入口开进来（m/s）
 * @param {number} options.maxSpeed   车道限速（m/s），也是插值斜率上限
 */
export function buildMotion(options) {
  const {
    events = [],
    stations = {},
    windowFrom = 0,
    windowTo = 0,
    zMin = -35,
    zMax = 35,
    entrySpeed = 11.1,      // 40 km/h：从入口/广场驶入
    maxSpeed = 16.7,        // 60 km/h：车道内上限（日志里相邻锚点要求的中位速度约 12 m/s）
    exitSpeed = 13.9,       // 50 km/h：放行后驶离
    entryInset = 3,
    laneId = null,
  } = options;

  const plan = planAnchors({ events, stations, windowTo, laneId });
  const anchors = plan.anchors.map((item) => ({
    o: item.o,
    logO: item.o,
    z: item.z,
    key: item.key,
    trust: item.trust,
    why: item.why,
    repeats: item.repeats ?? 1,
  }));
  const zEntry = zMin + entryInset;
  const GATE_HOLD_MS = 2500;    // 闸口处理（收费/抬杆）最多算这么久
  const GATE_DEPART_M = 10;     // 处理完驶出画面：再往前开 10m

  /**
   * 用给定的"速度预算"（m/s，越小=时刻摊得越开）重建一次时间轴。
   * 只在预算内挪动锚点时刻（只往后，不会比日志更早），所以日志时刻能保就保。
   * 再加一轮**加速度限制**：相邻锚点挨得太近时（日志的事件时刻很密、位移却不小），
   * 三次曲线会在那一小段里把速度从 0 拉到限速 —— 那是几十上百 m/s² 的假急刹。
   * 处理办法是按段把"挨太近的锚点"再往后摊（仍然只往后），直到段内 |dv/dt| 落在可行区间；
   * 线圈占用是硬证据（锚点被夹在窗口内），冲突时的残差记在 accelMax 里如实报告。
   */
  const accelLimit = options.accelLimit ?? 3.0;   // m/s²：车道内加减速的可行上限
  const fit = (budget) => {
    const unit = 1000 / budget;               // ms/m
    // 入口/出口也按预算放慢一点：三次曲线在"快段接平台"处会有速度波动，
    // 留出余量才能保证插值出来的瞬时速度也不越限。
    const entryRate = Math.min(entrySpeed, budget * 0.8);
    const exitRate = Math.min(exitSpeed, budget * 0.8);
    const list = anchors.map((anchor) => ({ ...anchor }));
    const spreadTimes = () => {
      for (let i = 1; i < list.length; i += 1) {
        const need = (list[i].z - list[i - 1].z) * unit;
        if (list[i].o < list[i - 1].o + Math.max(need, 1)) list[i].o = list[i - 1].o + Math.max(need, 1);
      }
    };
    const pinWindows = () => {
      for (const window of plan.coilWindows) {
        for (const anchor of list) {
          if (anchor.key !== window.key || Math.abs(anchor.z - window.z) > 1e-9) continue;
          if (anchor.o < window.t0 - 200) anchor.o = window.t0 - 200;
          else if (anchor.o > window.t1 + 200) anchor.o = window.t1 + 200;
        }
      }
    };
    spreadTimes();
    pinWindows();
    spreadTimes();
    // 入口提前量倍数 / 出口段最短时长：这两段没有日志锚点（是合成点），
    // 加速度超限时可以把"从哪里起步、到哪里驶离"拉长，不影响任何日志证据。
    let leadScale = 1;
    let exitPadMs = 800;

    /**
     * 同一个 z 上、20ms 以内的两个锚点在物理上就是同一时刻（见模块顶部 DEGENERATE_MS），
     * 合并时保留后者（时刻更靠后 ≈ 占位结束），并让曲线在这个点上重新拿到一个真实速度。
     */
    const liveAnchors = () => {
      const out = [];
      for (const anchor of list) {
        const previous = out[out.length - 1];
        if (previous && Math.abs(anchor.z - previous.z) < 0.05 && anchor.o - previous.o < DEGENERATE_MS) {
          out[out.length - 1] = anchor;
          continue;
        }
        out.push(anchor);
      }
      return out;
    };

    /** 把当前锚点时刻拼成曲线（入口点 + 锚点 + 出口点） */
    const assemble = () => {
      const live = liveAnchors();
      const firstAnchor = live[0] ?? null;
      const lastAnchor = live[live.length - 1] ?? null;
      // 这趟车最后压在栏杆/落杆线圈上：到闸口还要"处理 + 驶离"，不是原地不动。
      const gateZ = (stations.barrier ?? 24) - 3.5;
      const stopsAtGate = Boolean(
        lastAnchor && (lastAnchor.hold || lastAnchor.coil?.stop || lastAnchor.z >= gateZ)
      );
      const entry = {
        o: firstAnchor
          ? firstAnchor.o - ((firstAnchor.z - zEntry) / entryRate) * 1000 * leadScale
          : windowFrom,
        z: zEntry,
        key: "entry",
        trust: 1,
        why: "入口驶入",
      };
      const points = [entry, ...live];
      let exit;
      if (lastAnchor) {
        const free = Math.max(0, windowTo - lastAnchor.o);
        // 车在道内的**物理占位**只到"驶离"为止：闸口处理（收费/抬杆，最多 GATE_HOLD_MS）
        // 加上驶出画面的那一小段。日志窗口里剩下的后台/流水事件不算占位 ——
        // 否则车会在闸口一直"停"到窗口末（中位 10.4s、最长 51.8s），
        // 把下一趟车的起点挤到它后面，下一趟就会凭空出现在线圈6/闸机上。
        const hold = Math.min(free, stopsAtGate ? GATE_HOLD_MS : 0);
        const drift = stopsAtGate ? 0 : (free / 1000) * exitRate;
        const zExit = Math.min(
          zMax - 1,
          lastAnchor.z + (stopsAtGate ? GATE_DEPART_M : 0) + drift
        );
        const travel = ((zExit - lastAnchor.z) / exitRate) * 1000;
        const tExit = lastAnchor.o + hold + Math.max(travel, exitPadMs);
        exit = {
          o: tExit,
          z: Math.max(lastAnchor.z, zExit),
          key: "exit",
          trust: 0.8,
          why: stopsAtGate ? "闸口处理完驶离" : "驶向出口",
        };
      } else {
        exit = { o: windowFrom + 1000, z: zEntry, key: "exit", trust: 0.5, why: "无位置事件" };
      }
      points.push(exit);

      const xs = points.map((item) => item.o);
      const zs = points.map((item) => item.z);
      for (let i = 1; i < xs.length; i += 1) if (xs[i] <= xs[i - 1]) xs[i] = xs[i - 1] + 1;
      // 曲线两端都从静止起/止：曲线之外是常量段（速度 0），端点上还留着速度的话
      // 接过去就是一个速度突变（看起来像瞬移，交给刹车灯/悬挂就是几百 m/s² 的假急刹）。
      // 车在出口之后就隐藏（驶离画面），所以"在出口减速到静止"不会被看成半路停车。
      const path = makePath(xs, zs, maxSpeed, { startAtRest: true, endAtRest: true });
      return { first: firstAnchor, last: lastAnchor, points, entry, exit, xs, zs, path, stopsAtGate, live };
    };

    /** 逐段量段内 |dv/dt|（每个采样点归到它所在的那一段） */
    const measureAccel = (built) => {
      const seg = built.xs;
      const accelOfSeg = [];
      for (let i = 0; i < seg.length - 1; i += 1) {
        const h = seg[i + 1] - seg[i];
        const n = Math.max(2, Math.min(240, Math.ceil(h / 5)));
        let previousZ = built.path.at(seg[i]);
        let previousV = null;
        let worst = 0;
        for (let k = 1; k <= n; k += 1) {
          const o = seg[i] + (h * k) / n;
          const z = built.path.at(o);
          const dt = (o - seg[i] - (h * (k - 1)) / n) / 1000;
          const v = (z - previousZ) / (dt || 1e-3);
          if (previousV !== null) worst = Math.max(worst, Math.abs(v - previousV) / (dt || 1e-3));
          previousV = v;
          previousZ = z;
        }
        accelOfSeg.push(worst);
      }
      return accelOfSeg;
    };

    let built = assemble();
    let accelOfSeg = measureAccel(built);
    for (let round = 0; round < 7 && Math.max(0, ...accelOfSeg) > accelLimit * 1.05; round += 1) {
      let touched = false;
      const live = built.live || [];
      const lastSeg = built.points.length - 2;
      for (let seg = 0; seg <= lastSeg; seg += 1) {
        const worst = accelOfSeg[seg] ?? 0;
        if (worst <= accelLimit * 1.05) continue;
        // 段内加速度 ∝ 1/时长²：按 sqrt(实测/限值) 把这一段撑开（最多 3 倍/轮）
        const grow = Math.min(3, Math.sqrt(worst / accelLimit));
        if (seg === 0) {
          leadScale *= grow;                       // 入口段：从更远处起步（入口是合成点）
        } else if (seg === lastSeg) {
          exitPadMs = Math.max(exitPadMs, built.exit.o - built.last.o) * grow;   // 出口段：停稳留够时间
        } else if (seg < live.length) {            // 锚点 a_seg 与 a_{seg-1} 之间
          const gap = Math.max(1, live[seg].o - live[seg - 1].o);
          const need = Math.max(gap * grow, (live[seg].z - live[seg - 1].z) * unit);
          live[seg].o = live[seg - 1].o + need;    // 把后一个锚点往后挪
        }
        touched = true;
      }
      if (!touched) break;
      pinWindows();
      spreadTimes();
      built = assemble();
      accelOfSeg = measureAccel(built);
    }
    const accelMax = Math.max(0, ...accelOfSeg);
    const { points, entry, exit, path, xs, zs, stopsAtGate } = built;
    const from = Math.min(xs[0], windowFrom);
    const to = Math.max(xs[xs.length - 1], windowTo);
    // 细采样：粗采样会漏掉短段上的速度尖峰（那样"峰值 ≤ 限速"就只是采样侥幸）
    const step = Math.max(4, (to - from) / 3000);
    let peak = 0;
    let backwards = 0;
    let previous = null;
    for (let o = from; o <= to + 1e-6; o += step) {
      const z = path.at(o);
      if (previous !== null) {
        const dz = z - previous;
        if (dz < -1e-6) backwards += 1;
        peak = Math.max(peak, Math.abs(dz) / (step / 1000));
      }
      previous = z;
    }
    const live = built.live || list;
    const mergedAway = list.filter((anchor) => live.indexOf(anchor) < 0);
    return { list: live, mergedAway, points, entry, exit, path, xs, zs, from, to, step, peak, backwards, accelMax };
  };

  // 车速不能超过限速：先按 0.7 倍限速摊（给三次曲线的速度波动留余量），
  // 若实测峰值仍越界就继续压低预算重算。1~3 轮即收敛。
  let budget = maxSpeed * 0.7;
  let built = fit(budget);
  for (let round = 0; round < 8 && built.peak > maxSpeed * 1.0005; round += 1) {
    budget = Math.max(0.4, budget * (maxSpeed / built.peak) * 0.98);
    built = fit(budget);
  }

  const { list: anchorsFinal, mergedAway, points, entry, exit, path, from, to, step, accelMax } = built;
  const first = anchorsFinal[0] ?? null;
  const last = anchorsFinal[anchorsFinal.length - 1] ?? null;
  const zAt = (o) => path.at(o);

  let maxDelayMs = 0;
  let movedEarlyMs = 0;
  for (const anchor of anchorsFinal) {
    const delay = anchor.o - anchor.logO;
    if (delay > maxDelayMs) maxDelayMs = delay;
    if (-delay > movedEarlyMs) movedEarlyMs = -delay;
  }

  // 诊断采样
  let peakSpeed = 0;
  let backwards = 0;
  let previous = null;
  const samples = [];
  for (let o = from; o <= to + 1e-6; o += step) {
    const z = zAt(o);
    samples.push(z);
    if (previous !== null) {
      const dz = z - previous;
      if (dz < -1e-6) backwards += 1;
      peakSpeed = Math.max(peakSpeed, Math.abs(dz) / (step / 1000));
    }
    previous = z;
  }

  // 线圈占用区间是硬证据：车中心必须在占用期间到过线圈附近（±3.6m ≈ 车长一半）。
  // 覆盖不上说明这条过程的日志自相矛盾（例如"车还在牌识处，线圈却已经压了 5s"）。
  let coilUncovered = 0;
  const uncovered = [];
  for (const window of plan.coilWindows) {
    let ok = false;
    const step2 = Math.max(20, (window.t1 - window.t0) / 40);
    for (let o = window.t0 - 200; o <= window.t1 + 200; o += step2) {
      if (Math.abs(zAt(o) - window.z) <= 3.6) { ok = true; break; }
    }
    if (!ok) {
      coilUncovered += 1;
      uncovered.push({ key: window.key, z: window.z, t0: window.t0, t1: window.t1, stuck: Boolean(window.stuck) });
    }
  }

  const stationSummary = {};
  for (const anchor of anchorsFinal) {
    const row = stationSummary[anchor.key] ?? (stationSummary[anchor.key] = { z: anchor.z, count: 0, firstLogO: anchor.logO, lastLogO: anchor.logO, maxDelayMs: 0 });
    row.count += 1;
    row.firstLogO = Math.min(row.firstLogO, anchor.logO);
    row.lastLogO = Math.max(row.lastLogO, anchor.logO);
    row.maxDelayMs = Math.max(row.maxDelayMs, anchor.o - anchor.logO);
  }

  return {
    anchors: anchorsFinal,
    dropped: plan.dropped.map((item) => ({ o: item.o, z: item.z, key: item.key, why: item.why, repeats: item.repeats ?? 1 }))
      .concat((mergedAway || []).map((item) => ({
        o: item.o, z: item.z, key: item.key, repeats: 1,
        why: `与同一位置的另一条锚点相隔 <${DEGENERATE_MS}ms（时间预算挤到一起了），合并成一个时刻`,
      }))),
    coilWindows: plan.coilWindows,
    path,
    points,
    entry,
    exit,
    zAt,
    // 没有任何位置事件的过程（只有后台日志）不该凭空画一辆车
    hasEvidence: anchorsFinal.length > 0,
    leadMs: first ? Math.max(0, first.o - entry.o) : 0,
    diagnostics: {
      anchorCount: anchorsFinal.length,
      droppedCount: plan.dropped.length,
      rejected: Object.values(plan.rejected).reduce((a, b) => a + b, 0),
      rejectedByReason: plan.rejected,
      stations: stationSummary,
      maxDelayMs: Math.round(maxDelayMs),
      movedEarlyMs: Math.round(movedEarlyMs),
      speedBudget: Number(budget.toFixed(2)),
      peakSpeed: Number(peakSpeed.toFixed(3)),
      accelMax: Number(accelMax.toFixed(2)),
      coilWindows: plan.coilWindows.length,
      coilUncovered,
      uncovered,
      backwards,
      windowFrom,
      windowTo,
      from,
      to,
      samples,
    },
  };
}

/** lane-kit / app.js 的 z 表 → 本模块的 stations 表 */
export function stationsFrom(devices = {}, coils = {}, extra = {}) {
  const stations = {};
  for (const [key, value] of Object.entries(devices)) {
    const z = typeof value === "number" ? value : value?.z;
    if (typeof z === "number") stations[key] = z;
  }
  for (const [key, value] of Object.entries(coils)) {
    const z = typeof value === "number" ? value : value?.z;
    if (typeof z === "number") stations[`coil${key}`] = z;
  }
  return { ...stations, ...extra };
}
