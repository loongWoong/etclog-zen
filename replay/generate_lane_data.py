#!/usr/bin/env python3
"""按车道号（landId）汇总站级多车道过程数据，供 replay/lanes.html 使用。

和 generate_replay_data.py 的区别：
  - 那份脚本处理「一台车的合并日志」（单车通行回放）；
  - 这份脚本处理一个时间窗内「整个收费站所有车道」的日志，按车道号分组，
    再把每条车道切成一趟一趟的过车过程。

分段口径（按优先级，每条过程都带 basis 说明它凭什么划出来）：
  1. 线圈闭环：`线圈为:N号,改变后的状态为:true|false`、`车检器N有信号|无信号`，
     以「第一只线圈压上 → 全部释放」为一次物理过车；只在闭环足够多、覆盖度够好时采用。
  2. 锚点间隔：过车锚点事件（栏杆/线圈/牌识/RSU/CPC/称重/费显/名单）按时间间隔切分。
  3. 车牌/通行号：按 passId / 车牌分组（至少 2 条日志才算一趟）。

每条过程还会给证据强度 confidence（高/中/低），说明这趟过程凭什么被认定为「一辆车」：
  高 = 有完整线圈闭环，或同时有车牌 + 交易/抬杆；
  中 = 有车牌、有交易或抬杆其中之一；
  低 = 只能靠时间窗口相邻推断。
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
for candidate in (HERE, HERE.parent):
    if str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

from generate_replay_data import classify, detect_coil_id  # noqa: E402
from merge_vehicle_logs_es import EsClient, EsError, resolve_timezone, to_utc_iso  # noqa: E402
from vehicle_info import extract_vehicle  # noqa: E402

COIL_TRANSITION_RE = re.compile(r"线圈为:(\d+)号,改变后的状态为:(true|false)")
DETECTOR_RE = re.compile(r"车检器(\d+)(有信号|无信号)")
LANE_RE = re.compile(r"\b(37016433[0-9A-Fa-f]{2})\b")
LANE_ANY_RE = re.compile(r"^[0-9A-Fa-f]{10}$")
ZERO_LANE = "0000000000"

SOURCE_FIELDS = [
    "time", "@timestamp", "landId", "laneId", "laneType", "laneDirection", "stationId", "logType",
    "message", "vlp", "passId", "ObuCode", "mediaNo", "anomalyType", "barSignal", "barrierCmd",
    "resultsMsg", "fee", "payFee", "checkResult", "vehicleClass",
]

TIER1 = {"barrier", "lane"}                      # 线圈 + 栏杆：过车最硬的物理证据
TIER2 = {"vlpr", "rsu", "cpc", "weigh", "axle", "display", "fee", "namelist"}
BARRIER_LABELS = (("抬杆", "抬杆"), ("落杆", "落杆"), ("放行", "放行"))
# 只有这些词才算「拦截」证据；泛化的「失败/异常」不算，避免把普通协议回执误判成拦截
BLOCK_MARKERS = ("拒绝", "不允通行", "拦截", "黑名单", "标签无卡", "拆卸", "超限", "禁止通行", "无卡", "闯关")
RELEASE_MARKERS = ("交易成功", "操作成功", "放行", "抬杆")


# ---------------------------------------------------------------------------
def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="按车道号汇总多车道过程数据")
    parser.add_argument("--es", default="http://192.168.22.212:9200", help="Elasticsearch 地址")
    parser.add_argument("--index", default="ump_37016433_2026.07", help="索引名或通配")
    parser.add_argument("--from", dest="start", required=True, help='窗口起点（本地时间），如 "2026-07-01 12:05:00"')
    parser.add_argument("--minutes", type=float, default=5.0, help="窗口长度（分钟），默认 5")
    parser.add_argument("--to", dest="end", help="窗口终点（本地时间），优先于 --minutes")
    parser.add_argument("--tz", default="Asia/Shanghai", help="本地时区，默认 Asia/Shanghai")
    parser.add_argument("--out", default=str(HERE / "data" / "lanes.json"), help="输出 JSON 路径")
    parser.add_argument("--lane", action="append", help="只统计指定车道号（可重复）")
    parser.add_argument("--include-unassigned", action="store_true", help="把 landId 全 0/空的活动也当成一条车道")
    parser.add_argument("--gap-seconds", type=float, default=15.0, help="锚点事件间隔超过该值即切分，默认 15")
    parser.add_argument("--max-nodes", type=int, default=40, help="单趟过程最多保留多少个过程节点，默认 40")
    parser.add_argument("--max-passages-per-lane", type=int, default=400, help="单条车道最多保留多少趟过程")
    parser.add_argument("--min-coil-cycles", type=int, default=3, help="闭环数达到该值才优先用线圈分段，默认 3")
    parser.add_argument("--max-signals", type=int, default=400, help="单车道单类信号时间线最多保留多少个状态跳变，默认 400")
    parser.add_argument("--page-size", type=int, default=2000, help="ES 分页大小，默认 2000")
    parser.add_argument("--max-docs", type=int, default=60000, help="最多拉取多少条日志，默认 60000")
    parser.add_argument("--timeout", type=float, default=90.0, help="单次 ES 请求超时秒数")
    parser.add_argument("--verbose", action="store_true")
    return parser.parse_args(argv)


def parse_clock(value):
    if not isinstance(value, str):
        return None
    text = value.strip().replace("T", " ")
    if not text:
        return None
    for fmt, size in (("%Y-%m-%d %H:%M:%S.%f", 23), ("%Y-%m-%d %H:%M:%S", 19), ("%Y-%m-%d %H:%M", 16)):
        try:
            return dt.datetime.strptime(text[:size], fmt)
        except ValueError:
            continue
    return None


def first_str(src: dict, names):
    for name in names:
        value = src.get(name)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def lane_of(src: dict):
    raw = first_str(src, ("landId", "laneId"))
    if raw and LANE_ANY_RE.match(raw) and raw != ZERO_LANE:
        return raw
    match = LANE_RE.search(src.get("message") or "")
    return match.group(1) if match else None


def clock_text(moment):
    return moment.strftime("%H:%M:%S.") + f"{moment.microsecond // 1000:03d}"


def coil_transition(text):
    match = COIL_TRANSITION_RE.search(text)
    if match:
        return match.group(1), match.group(2) == "true"
    match = DETECTOR_RE.search(text)
    if match:
        return match.group(1), match.group(2) == "有信号"
    return None


def barrier_action(text):
    for label, needle in BARRIER_LABELS:
        if needle in text:
            return label
    return None


# 栏杆状态专用解析：只认"到位/状态上报/控制指令值"这几种确凿写法。
# 不能用 barrier_action 做状态时间线——它会把说明文字里的"抬杆"当成动作：
#   「电动栏杆机01(00-落杆 01-抬杆 02-长抬)控制指令执行成功」方向其实是未知的；
#   「栏杆处于抬杆状态」是状态描述而非一次抬杆动作。
BARRIER_CMD_VALUE_RE = re.compile(r"控制类型\(00-落杆 01-抬杆 02-长抬\)\s*:\s*(\d{2})")
BARRIER_CMD_VALUE = {"00": "down", "01": "up", "02": "up"}  # 02=长抬，按抬起处理
BARRIER_STATE_PHRASES = (
    ("抬杆到位", "up"),
    ("落杆到位", "down"),
    ("抬杆状态", "up"),
    ("落杆状态", "down"),
    ("【抬杆】", "up"),
    ("【落杆】", "down"),
    ("抬杆放行", "up"),
)


def barrier_state(text):
    body = text.split("|", 1)[-1] if "|" in text else text
    match = BARRIER_CMD_VALUE_RE.search(body)
    if match:
        return BARRIER_CMD_VALUE.get(match.group(1))
    for needle, state in BARRIER_STATE_PHRASES:
        if needle in body:
            return state
    return None


def short_text(text):
    """去掉日志前缀（如 "2026-07-01 12:05:01.123|..."），只留可读正文。"""
    stripped = text.split("|", 1)[-1] if "|" in text else text
    return stripped.strip()[:140]


def build_signals(events, cap):
    """整窗口的设备状态时间线。

    与 passages 不同，这里不做分段，保留全部线圈压上/释放、栏杆抬/落跳变，
    这样「线圈一直压着不释放」「栏杆抬起来不落」这类超时才能被看见。
    只记录**状态发生变化**的时刻：同状态的重复上报（例如每 10s 一次的
    「栏杆处于抬杆状态」）折成一次跳变，否则时间线上会全是同一个状态。
    """
    coils: dict[str, list] = {}
    barrier: list = []
    last_coil: dict[str, bool] = {}
    last_barrier: str | None = None
    for event in events:
        if event["coilId"] and event["coilState"]:
            state = event["coilState"] == "有信号"
            series = coils.setdefault(event["coilId"], [])
            if last_coil.get(event["coilId"]) != state and len(series) < cap:
                last_coil[event["coilId"]] = state
                series.append({
                    "o": event["o"],
                    "t": event["clock"],
                    "s": state,
                    "d": event["device"],
                    "k": event["kind"],
                    "x": short_text(event["text"]),
                })
        if event["barrier"]:
            state = barrier_state(event["text"])
            if state and state != last_barrier and len(barrier) < cap:
                last_barrier = state
                barrier.append({
                    "o": event["o"],
                    "t": event["clock"],
                    "s": state,
                    "d": event["device"],
                    "k": event["kind"],
                    "x": short_text(event["text"]),
                })
    return {
        "coils": {key: value for key, value in sorted(coils.items())},
        "barrier": barrier,
        "counts": {
            "coils": sum(len(value) for value in coils.values()),
            "barrier": len(barrier),
        },
    }


def tier_of(event):
    if event["device"] in TIER1 or event["coilId"] or event["barrier"]:
        return 1
    if event["device"] in TIER2:
        return 2
    return 3


def passage_result(members):
    texts = [event["text"] for event in members]
    blocked = any(any(marker in text for marker in BLOCK_MARKERS) for text in texts) \
        or any(event["anomaly"] for event in members)
    released = any(event["barrier"] == "抬杆" for event in members) \
        or any(event["kind"] == "success" for event in members) \
        or any(any(marker in text for marker in RELEASE_MARKERS) for text in texts)
    if blocked and released:
        return "混合"
    if blocked:
        return "拦截"
    if released:
        return "放行"
    return "未知"


# ---------------------------------------------------------------------------
def build_events(docs, day_start):
    events = []
    for src in docs:
        moment = parse_clock(src.get("time"))
        if moment is None:
            continue
        text = src.get("message") or ""
        device, kind, severity = classify(text)
        coil = coil_transition(text)
        events.append({
            "ts": moment,
            "o": int((moment - day_start).total_seconds() * 1000),
            "clock": clock_text(moment),
            "device": device,
            "kind": kind,
            "severity": severity,
            "coilId": coil[0] if coil else detect_coil_id(text),
            "coilState": ("有信号" if coil[1] else "无信号") if coil else None,
            "barrier": barrier_action(text),
            "logType": src.get("logType"),
            "plate": first_str(src, ("vlp",)),
            "passId": first_str(src, ("passId",)),
            "anomaly": first_str(src, ("anomalyType",)),
            "text": text,
        })
    events.sort(key=lambda item: (item["ts"], item["clock"]))
    for event in events:
        event["tier"] = tier_of(event)
    return events


def coil_cycles(events, gap_seconds):
    """线圈闭环：第一只线圈压上 → 全部释放；丢弃没有真正闭环的碎片。"""
    seen = set()
    transitions = []
    for event in events:
        if not event["coilId"] or not event["coilState"]:
            continue
        key = (event["coilId"], event["coilState"], event["ts"])
        if key in seen:
            continue
        seen.add(key)
        transitions.append(event)

    cycles = []
    active = set()
    current = []
    for event in transitions:
        if not current:
            if event["coilState"] != "有信号":
                continue
            current = [event]
            active = {event["coilId"]}
            continue
        if gap_seconds and (event["ts"] - current[-1]["ts"]).total_seconds() > gap_seconds * 4:
            # 长时间没释放，按信号丢失收口
            if current[-1]["ts"] > current[0]["ts"]:
                cycles.append({"start": current[0]["ts"], "end": current[-1]["ts"], "coils": sorted(active)})
            current = [event] if event["coilState"] == "有信号" else []
            active = {event["coilId"]} if current else set()
            continue
        current.append(event)
        if event["coilState"] == "有信号":
            active.add(event["coilId"])
        else:
            active.discard(event["coilId"])
        if not active:
            cycles.append({"start": current[0]["ts"], "end": current[-1]["ts"], "coils": sorted({e["coilId"] for e in current})})
            current = []
    if current and current[-1]["ts"] > current[0]["ts"]:
        cycles.append({"start": current[0]["ts"], "end": current[-1]["ts"], "coils": sorted(active)})
    return [cycle for cycle in cycles if cycle["end"] > cycle["start"]]


def anchor_clusters(events, gap_seconds):
    clusters = []
    current = []
    for event in events:
        if event["tier"] > 2:
            continue
        if current and (event["ts"] - current[-1]["ts"]).total_seconds() > gap_seconds:
            clusters.append(current)
            current = []
        current.append(event)
    if current:
        clusters.append(current)
    return clusters


def adaptive_gap(events, base_gap):
    """锚点很密的车道（设备协议日志持续刷）用固定间隔切不开，按间隔中位数自适应。"""
    anchors = [event for event in events if event["tier"] <= 2]
    if len(anchors) < 4:
        return base_gap
    intervals = sorted(
        (anchors[index + 1]["ts"] - anchors[index]["ts"]).total_seconds()
        for index in range(len(anchors) - 1)
    )
    positive = [value for value in intervals if value > 0]
    if not positive:
        return base_gap
    median = positive[len(positive) // 2]
    return max(3.0, min(base_gap, median * 8.0))


def plate_groups(events):
    buckets = {}
    for event in events:
        key = event["passId"] or event["plate"]
        if key:
            buckets.setdefault(key, []).append(event)
    return [group for group in buckets.values() if len(group) >= 2]


def segment_lane(events, args):
    """返回 [(start, end, basis, coils)]。"""
    cycles = coil_cycles(events, args.gap_seconds)
    gap = adaptive_gap(events, args.gap_seconds)
    clusters = anchor_clusters(events, gap)
    if len(cycles) >= args.min_coil_cycles and len(cycles) * 2 >= len(clusters):
        return [(cycle["start"], cycle["end"], "线圈", cycle["coils"]) for cycle in cycles]
    if clusters:
        windows = []
        for cluster in clusters:
            coils = sorted({event["coilId"] for event in cluster if event["coilId"]},
                           key=lambda value: int(value) if value.isdigit() else 99)
            windows.append((cluster[0]["ts"], cluster[-1]["ts"], "锚点间隔", coils))
        return windows
    return [(group[0]["ts"], group[-1]["ts"], "车牌/通行号", []) for group in plate_groups(events)]


def state_nodes(members, cap):
    """压缩成状态变化点；节点超限时按证据层级优先保留（物理证据优先于后台日志）。"""
    nodes = []
    last_signature = None
    for event in members:
        signature = (event["device"], event["kind"], event["coilId"], event["coilState"], event["barrier"], event["severity"])
        if signature == last_signature:
            continue
        last_signature = signature
        nodes.append(event)
    if len(nodes) <= cap:
        return nodes
    head, tail = nodes[0], nodes[-1]
    middle = nodes[1:-1]
    ranked = sorted(range(len(middle)), key=lambda index: (middle[index]["tier"], index))
    keep = set(ranked[: max(cap - 2, 0)])
    return [head] + [node for index, node in enumerate(middle) if index in keep] + [tail]


def coil_confirmed(members):
    opened = {event["coilId"] for event in members if event["coilState"] == "有信号" and event["coilId"]}
    closed = {event["coilId"] for event in members if event["coilState"] == "无信号" and event["coilId"]}
    return bool(opened & closed)


def confidence_of(members):
    plates = any(event["plate"] for event in members)
    trades = any(event["kind"] in ("success", "billing", "read") and event["device"] in ("rsu", "cpc", "fee", "service")
                 for event in members)
    barriers = any(event["barrier"] for event in members)
    if coil_confirmed(members) or (plates and (trades or barriers)):
        return "高"
    if plates or trades or barriers:
        return "中"
    return "低"


def backfill_vehicle_classes(lanes) -> None:
    """同一车牌在同一时间窗内可能只有部分车道留下车型记录：用车牌把有车型的过程补齐。

    只在「本趟完全没有车型证据（只有车牌颜色兜底）」时才补，并标注来源，
    避免把 A 车的车型写到 B 车上。
    """
    known: dict[str, dict] = {}
    for lane in lanes:
        for passage in lane["passages"]:
            vehicle = passage.get("vehicle") or {}
            if not vehicle.get("declaredClass") and not vehicle.get("identifiedClass"):
                continue
            plate = vehicle.get("plate")
            if plate and plate not in known:
                known[plate] = vehicle

    filled = 0
    for lane in lanes:
        for passage in lane["passages"]:
            vehicle = passage.get("vehicle") or {}
            if vehicle.get("declaredClass") or vehicle.get("identifiedClass"):
                continue
            source = known.get(vehicle.get("plate") or "")
            if not source:
                continue
            for key in ("classCode", "classLabel", "kind", "axles", "note", "dangerous", "special"):
                vehicle[key] = source.get(key)
            vehicle["dims"] = dict(source.get("dims") or {})
            vehicle["realDims"] = source.get("realDims", False)
            vehicle["classBasis"] = "同窗口其他车道记录的车型"
            vehicle["evidence"] = list(vehicle.get("evidence") or []) + ["车型来自同窗口其他车道的同车牌记录"]
            filled += 1
    if filled:
        print(f"[sum] 用车牌补齐车型的过程：{filled} 个", file=sys.stderr)


def build_lane(lane, docs, day_start, window_start, window_end, args):
    events = build_events(docs, day_start)
    windows = segment_lane(events, args)
    windows.sort(key=lambda item: item[0])
    if len(windows) > args.max_passages_per_lane:
        windows = windows[: args.max_passages_per_lane]

    passages = []
    used: set[int] = set()
    for start, end, basis, coils in windows:
        members = [event for event in events if start <= event["ts"] <= end]
        if not members:
            continue
        for event in members:
            used.add(id(event))
        nodes = state_nodes(members, args.max_nodes)
        if not nodes:
            continue
        informative = len(members) >= 2 or any(event["plate"] or event["anomaly"] for event in members)
        if not informative:
            continue
        steps = []
        for node in nodes:
            if node["device"] not in steps:
                steps.append(node["device"])
        plates = sorted({event["plate"] for event in members if event["plate"]})[:3]
        # 车辆属性只取「本趟主车牌」的日志行，避免同趟夹杂的跟车车辆把车型/颜色带偏
        if plates:
            scoped = [event["text"] for event in members if plates[0] in event["text"]]
        else:
            scoped = [event["text"] for event in members]
        vehicle = extract_vehicle(scoped or [event["text"] for event in members])
        if not vehicle["plate"] and plates:
            vehicle["plate"] = plates[0]
        vehicle["otherPlates"] = plates[1:]
        passages.append({
            "i": len(passages),
            "o0": members[0]["o"],
            "o1": members[-1]["o"],
            "start": clock_text(start),
            "end": clock_text(end),
            "durationMs": int((end - start).total_seconds() * 1000),
            "basis": basis,
            "confidence": confidence_of(members),
            "coilConfirmed": coil_confirmed(members),
            "result": passage_result(members),
            "eventCount": len(members),
            "coilIds": coils,
            "devices": steps,
            "plates": plates,
            "passIds": sorted({event["passId"] for event in members if event["passId"]})[:3],
            "anomalies": sorted({event["anomaly"] for event in members if event["anomaly"]})[:3],
            "vehicle": vehicle,
            "nodes": [
                {
                    "o": node["o"],
                    "t": node["clock"],
                    "device": node["device"],
                    "kind": node["kind"],
                    "severity": node["severity"],
                    "coil": f"车检器{node['coilId']}{node['coilState']}" if node["coilId"] and node["coilState"] else None,
                    "barrier": node["barrier"],
                    "text": short_text(node["text"]),
                }
                for node in nodes
            ],
        })

    signals = build_signals(events, args.max_signals)

    background = len(events) - len(used)
    devices: dict[str, int] = {}
    log_types: dict[str, int] = {}
    # 活跃度按「窗口内第几分钟」统计，不按从午夜起算的分钟，否则前面全是空档
    window_minutes = max(1, int(round((window_end - window_start).total_seconds() / 60.0)))
    per_minute: dict[int, int] = {}
    for event in events:
        devices[event["device"]] = devices.get(event["device"], 0) + 1
        if event["logType"]:
            log_types[event["logType"]] = log_types.get(event["logType"], 0) + 1
        minute = int((event["ts"] - window_start).total_seconds() // 60)
        minute = min(max(minute, 0), window_minutes)
        per_minute[minute] = per_minute.get(minute, 0) + 1

    results = {"放行": 0, "拦截": 0, "混合": 0, "未知": 0}
    confidences = {"高": 0, "中": 0, "低": 0}
    for passage in passages:
        results[passage["result"]] = results.get(passage["result"], 0) + 1
        confidences[passage["confidence"]] = confidences.get(passage["confidence"], 0) + 1
    durations = [passage["durationMs"] for passage in passages if passage["durationMs"] > 0]

    return {
        "id": lane,
        "types": sorted({first_str(src, ("laneType",)) for src in docs if first_str(src, ("laneType",))}),
        "directions": sorted({first_str(src, ("laneDirection",)) for src in docs if first_str(src, ("laneDirection",))}),
        "docCount": len(docs),
        "basis": windows[0][2] if windows else None,
        "gapSeconds": round(adaptive_gap(events, args.gap_seconds), 1),
        "metrics": {
            "passages": len(passages),
            "released": results.get("放行", 0),
            "blocked": results.get("拦截", 0),
            "mixed": results.get("混合", 0),
            "unknown": results.get("未知", 0),
            "confidence": confidences,
            "avgDurationMs": int(sum(durations) / len(durations)) if durations else 0,
            "maxDurationMs": max(durations) if durations else 0,
            "nodes": sum(len(passage["nodes"]) for passage in passages),
            "background": max(background, 0),
            "devices": dict(sorted(devices.items(), key=lambda item: -item[1])),
            "logTypes": dict(sorted(log_types.items(), key=lambda item: -item[1])),
            "perMinute": [per_minute.get(minute, 0) for minute in range(window_minutes + 1)],
            "signals": signals["counts"],
        },
        "signals": signals,
        "passages": passages,
    }


def main(argv=None) -> int:
    args = parse_args(argv)
    tz = resolve_timezone(args.tz)
    start_local = parse_clock(args.start)
    if start_local is None:
        print(f"--from 不是合法时间: {args.start}", file=sys.stderr)
        return 2
    if args.end:
        end_local = parse_clock(args.end)
        if end_local is None:
            print(f"--to 不是合法时间: {args.end}", file=sys.stderr)
            return 2
    else:
        end_local = start_local + dt.timedelta(minutes=args.minutes)

    query = {"range": {"@timestamp": {"gte": to_utc_iso(start_local, tz), "lte": to_utc_iso(end_local, tz)}}}
    client = EsClient(args.es, timeout=args.timeout, verbose=args.verbose)
    print(f"[es] {args.es} {args.index} {start_local} ~ {end_local} ({args.tz})", file=sys.stderr)
    try:
        stats: dict = {}
        hits, truncated = client.search_all(
            args.index, query, SOURCE_FIELDS, "@timestamp", args.page_size, args.max_docs, stats
        )
    except EsError as exc:
        print(f"[es] 查询失败: {exc}", file=sys.stderr)
        return 1
    finally:
        client.close_pit()

    wanted = set(args.lane or [])
    buckets: dict[str, list[dict]] = {}
    unassigned: list[dict] = []
    for hit in hits:
        src = hit.get("_source") or {}
        lane = lane_of(src)
        if lane is None:
            unassigned.append(src)
            continue
        if wanted and lane not in wanted:
            continue
        buckets.setdefault(lane, []).append(src)

    day_start = start_local.replace(hour=0, minute=0, second=0, microsecond=0)
    lanes = [build_lane(lane, docs, day_start, start_local, end_local, args) for lane, docs in sorted(buckets.items())]
    if args.include_unassigned and unassigned:
        lanes.append(build_lane(ZERO_LANE, unassigned, day_start, start_local, end_local, args))
    backfill_vehicle_classes(lanes)

    station_match = re.search(r"(\d{6,})", args.index)
    payload = {
        "kind": "station-lanes",
        "station": station_match.group(1) if station_match else None,
        "index": args.index,
        "es": args.es,
        "window": {
            "from": start_local.strftime("%Y-%m-%d %H:%M:%S"),
            "to": end_local.strftime("%Y-%m-%d %H:%M:%S"),
            "minutes": round((end_local - start_local).total_seconds() / 60.0, 3),
            "tz": args.tz,
            "startMs": int(start_local.timestamp() * 1000),
            "endMs": int(end_local.timestamp() * 1000),
            "offsetMs": int((start_local - day_start).total_seconds() * 1000),
        },
        "generatedAt": dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "source": {"fetched": len(hits), "matched": stats.get("total"), "truncated": bool(truncated), "maxDocs": args.max_docs},
        "unassignedCount": len(unassigned),
        "lanes": lanes,
        "summary": {
            "lanes": len(lanes),
            "docs": sum(lane["docCount"] for lane in lanes),
            "passages": sum(lane["metrics"]["passages"] for lane in lanes),
            "released": sum(lane["metrics"]["released"] for lane in lanes),
            "blocked": sum(lane["metrics"]["blocked"] for lane in lanes),
            "nodes": sum(lane["metrics"]["nodes"] for lane in lanes),
        },
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    print(f"[out] {out_path}  {out_path.stat().st_size / 1024:.0f} KB", file=sys.stderr)
    print(
        f"[sum] 车道={payload['summary']['lanes']} 文档={payload['summary']['docs']} "
        f"过程={payload['summary']['passages']} 放行={payload['summary']['released']} "
        f"拦截={payload['summary']['blocked']} 未归属={len(unassigned)} 截断={bool(truncated)}",
        file=sys.stderr,
    )
    for lane in lanes:
        m = lane["metrics"]
        print(
            f"  {lane['id']}  docs={lane['docCount']:<6} 过程={m['passages']:<4} 放行={m['released']:<4} "
            f"拦截={m['blocked']:<3} 强={m['confidence']['高']:<3} 中={m['confidence']['中']:<3} 弱={m['confidence']['低']:<3} "
            f"节点={m['nodes']:<5} 背景={m['background']:<6} 平均={m['avgDurationMs']}ms",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
