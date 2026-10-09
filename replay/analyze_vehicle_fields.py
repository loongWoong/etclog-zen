"""从 ES 采样统计车型 / 车牌颜色 / 车身颜色字段，用来验证码表、指导三维车辆建模。

用法：
    python analyze_vehicle_fields.py --from "2026-07-01 11:00" --to "2026-07-01 13:00"
    python analyze_vehicle_fields.py --probe                # 只看文档结构
"""
from __future__ import annotations

import argparse
import collections
import json
import re
import sys
import urllib.request

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DEFAULT_HOST = "http://192.168.22.212:9200"
DEFAULT_INDEX = "ump_37016433_2026.07*"

PLATE_RE = re.compile(r"([\u4e00-\u9fff][A-Z][A-Z0-9]{4,6})(?:_\d)?")
SIZE_RE = re.compile(r"(?:通行)?车型[：:]\s*(\d+)")
COLOR_RE = re.compile(r"车牌颜色[：:]\s*(\d+)")
AXLE_RE = re.compile(r"货车轴数[：:]\s*(\d+)")
LICE_RE = re.compile(r"licenseColor=(\d+)")
VCOLOR_RE = re.compile(r"vehicleColor=(\d+)")
VMODEL_RE = re.compile(r"vehicleModel=([0-9A-Fa-f]{4})")
PLATECOLOR_JSON_RE = re.compile(r'"plateColor":\s*"?(\d+)"?')
AXLENUM_RE = re.compile(r'"AxleNum":\s*"?(\d+)"?')
VEHCLASS_RE = re.compile(r'"(?:vehClass|EnVT|bVehClass|feeVehicleType|obuVehicleType)":\s*"?(\d+)"?')
WEIGHT_RE = re.compile(r"车辆总重[：:]\s*(\d+)")
REPORT_RE = re.compile(r"(前车牌识别设备|匝道车牌识别设备|后车牌识别设备)结果上报")


def request(url: str, body=None, method="GET"):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def probe(host, index):
    result = request(f"{host}/{index}/_search", {"size": 1, "query": {"match_all": {}}}, "POST")
    hits = result["hits"]["hits"]
    if not hits:
        print("索引里没有文档")
        return
    source = hits[0]["_source"]
    print("文档字段：")
    for key, value in source.items():
        text = str(value)
        print(f"  {key:22s} {text[:110]}{'…' if len(text) > 110 else ''}")


def fetch(host, index, start_utc, end_utc, max_docs, page=1000):
    query = {
        "bool": {
            "filter": [{"range": {"@timestamp": {"gte": start_utc, "lte": end_utc}}}],
            "should": [
                {"match_phrase": {"message": "VehPlateReport"}},
                {"match_phrase": {"message": "车牌颜色："}},
                {"match_phrase": {"message": "货车轴数："}},
                {"match_phrase": {"message": "车型："}},
                {"match_phrase": {"message": '"AxleNum"'}},
            ],
            "minimum_should_match": 1,
        }
    }
    docs = []
    search_after = None
    while len(docs) < max_docs:
        body = {
            "size": min(page, max_docs - len(docs)),
            "query": query,
            "_source": ["@timestamp", "message", "msg", "landId", "logType"],
            "sort": [{"@timestamp": "asc"}, {"_doc": "asc"}],
        }
        if search_after:
            body["search_after"] = search_after
        result = request(f"{host}/{index}/_search", body, "POST")
        hits = result["hits"]["hits"]
        if not hits:
            break
        docs.extend(hits)
        search_after = hits[-1]["sort"]
        if len(hits) < body["size"]:
            break
    return docs


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--es-host", default=DEFAULT_HOST)
    parser.add_argument("--index", default=DEFAULT_INDEX)
    parser.add_argument("--from", dest="start", default="2026-07-01 11:00")
    parser.add_argument("--to", dest="end", default="2026-07-01 13:00")
    parser.add_argument("--max-docs", type=int, default=8000)
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args()
    host = args.es_host.rstrip("/")

    if args.probe:
        print(f"索引 {args.index} 文档结构：")
        probe(host, args.index)
        return

    # @timestamp 是 UTC，本地 +08:00
    import datetime as dt

    start = dt.datetime.strptime(args.start, "%Y-%m-%d %H:%M") - dt.timedelta(hours=8)
    end = dt.datetime.strptime(args.end, "%Y-%m-%d %H:%M") - dt.timedelta(hours=8)
    docs = fetch(host, args.index, start.isoformat() + "Z", end.isoformat() + "Z", args.max_docs)
    print(f"窗口 {args.start} ~ {args.end}（本地）共取回 {len(docs)} 条文档\n")
    if not docs:
        return

    size_counter = collections.Counter()
    color_counter = collections.Counter()
    vcolor_counter = collections.Counter()
    vmodel_counter = collections.Counter()
    axle_counter = collections.Counter()
    joint_size_color = collections.Counter()
    joint_size_axle = collections.Counter()
    joint_color_vcolor = collections.Counter()
    vcolor_by_size = collections.defaultdict(collections.Counter)
    weight_counter = collections.Counter()
    per_plate = collections.defaultdict(lambda: collections.defaultdict(set))

    for hit in docs:
        text = hit["_source"].get("message") or hit["_source"].get("msg") or ""
        plates = PLATE_RE.findall(text)
        plate = plates[0] if plates else "(未识别车牌)"
        for name, pattern, store in (
            ("车型", SIZE_RE, size_counter),
            ("车牌颜色", COLOR_RE, color_counter),
            ("货车轴数", AXLE_RE, axle_counter),
            ("vehicleColor", VCOLOR_RE, vcolor_counter),
            ("vehicleModel", VMODEL_RE, vmodel_counter),
            ("车辆总重", WEIGHT_RE, weight_counter),
        ):
            for value in pattern.findall(text):
                store[value] += 1
                per_plate[plate][name].add(value)
        for value in LICE_RE.findall(text):
            per_plate[plate]["licenseColor"].add(value)
        for value in PLATECOLOR_JSON_RE.findall(text):
            per_plate[plate]["plateColor"].add(value)
        for value in AXLENUM_RE.findall(text):
            per_plate[plate]["AxleNum"].add(value)
        for value in VEHCLASS_RE.findall(text):
            per_plate[plate]["vehClass"].add(value)
        if REPORT_RE.search(text):
            per_plate[plate]["报告"].add(REPORT_RE.search(text).group(1))

    def show(title, counter, limit=12):
        print(f"=== {title}（{sum(counter.values())} 次）===")
        for key, count in counter.most_common(limit):
            print(f"  {key:>6}  {count:5d}")
        print()

    show("车型码", size_counter)
    show("车牌颜色码", color_counter)
    show("牌识 vehicleColor", vcolor_counter)
    show("牌识 vehicleModel", vmodel_counter)
    show("货车轴数", axle_counter)
    show("车辆总重(kg)", weight_counter)

    print("=== 按车辆聚合（有车型或颜色的车）===")
    for plate, fields in list(per_plate.items())[:0]:
        pass
    rows = []
    for plate, fields in per_plate.items():
        sizes = fields.get("车型") or fields.get("vehClass")
        colors = fields.get("车牌颜色") or fields.get("plateColor") or fields.get("licenseColor")
        if not sizes and not colors:
            continue
        rows.append((plate, sorted(sizes or []), sorted(colors or []), sorted(fields.get("货车轴数") or fields.get("AxleNum") or []),
                     sorted(fields.get("vehicleColor") or []), sorted(fields.get("vehicleModel") or [])))
        size = rows[-1][1][0] if rows[-1][1] else "-"
        color = rows[-1][2][0] if rows[-1][2] else "-"
        axle = rows[-1][3][0] if rows[-1][3] else "-"
        joint_size_color[(size, color)] += 1
        joint_size_axle[(size, axle)] += 1
        for vc in rows[-1][4]:
            vcolor_by_size[size][vc] += 1
            joint_color_vcolor[(color, vc)] += 1
    print(f"共 {len(rows)} 辆车（按车牌聚合）")
    for row in rows[:60]:
        print(f"  {row[0]:<10} 车型={','.join(row[1]) or '-':<6} 车牌颜色={','.join(row[2]) or '-':<5} 轴数={','.join(row[3]) or '-':<4} vehicleColor={','.join(row[4]) or '-':<5} vehicleModel={','.join(row[5]) or '-'}")

    print("\n=== 联合分布 车型 × 车牌颜色 ===")
    sizes = sorted({s for s, _ in joint_size_color}, key=lambda v: (v == "-", v))
    colors = sorted({c for _, c in joint_size_color}, key=lambda v: (v == "-", v))
    print("车型\\颜色 " + "".join(f"{c:>6}" for c in colors) + "  合计")
    for size in sizes:
        cells = [joint_size_color[(size, c)] for c in colors]
        print(f"{size:>7}  " + "".join(f"{v:>6}" for v in cells) + f"  {sum(cells):>4}")

    print("\n=== 联合分布 车型 × 轴数 ===")
    axles = sorted({a for _, a in joint_size_axle}, key=lambda v: (v == "-", v))
    print("车型\\轴数 " + "".join(f"{a:>6}" for a in axles))
    for size in sorted({s for s, _ in joint_size_axle}, key=lambda v: (v == "-", v)):
        cells = [joint_size_axle[(size, a)] for a in axles]
        print(f"{size:>7}  " + "".join(f"{v:>6}" for v in cells))

    print("\n=== vehicleColor 按车型分布（判断它是不是车牌颜色表）===")
    for size in sorted(vcolor_by_size, key=lambda v: (v == "-", v)):
        print(f"  车型 {size:>4}: " + "  ".join(f"{vc}={n}" for vc, n in vcolor_by_size[size].most_common()))

    print("\n=== 联合分布 车牌颜色 × vehicleColor ===")
    for (color, vc), count in sorted(joint_color_vcolor.items()):
        print(f"  车牌颜色 {color:>3} × vehicleColor {vc:>3} = {count}")


if __name__ == "__main__":
    main()
