"""车道布局还原度校验：lane-kit.js 的尺寸表必须与 index.html(app.js) 的车道现场一致。

lanes.html 里每条车道的现场（路面/收费岛/收费亭/线圈/龙门架/路侧设备）是从 app.js 抽出来的，
这个脚本从两个文件里解析尺寸表逐项比对标签、颜色、z、x，防止以后改布局时两边走偏。

用法：cd replay && python check_lane_layout.py
"""
import re
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# app.js 的表值偶尔被 buildLaneDevice 覆盖（axle 实际建在 x=-3.2），以实际渲染位置为准
RENDERED_OVERRIDE = {("axle", "x"): "-3.2"}


def grab(source, name):
    start = source.index(name + " = {")
    depth = 0
    for index in range(start, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise ValueError(name)


def entries(block):
    out = {}
    for line in block.splitlines():
        match = re.match(r"\s*[\"']?([A-Za-z0-9\u4e00-\u9fff]+)[\"']?:\s*\{([^}]*)\}", line)
        if not match:
            continue
        key, body = match.group(1), match.group(2)
        row = {}
        for field in ("label", "color", "z", "x"):
            found = re.search(field + r":\s*\"?([^,}\"]+)", body)
            if found:
                row[field] = found.group(1).strip().strip('"')
        out[key] = row
    return out


def main():
    app = open("app.js", encoding="utf-8").read()
    kit = open("lane-kit.js", encoding="utf-8").read()
    app_devices = entries(grab(app, "LANE_DEVICES"))
    kit_devices = entries(grab(kit, "DEVICES"))
    app_coils = entries(grab(app, "coilInfo"))
    kit_coils = entries(grab(kit, "COILS"))

    problems = []
    for key, want in app_devices.items():
        got = kit_devices.get(key)
        if not got:
            problems.append(f"设备 {key} 在 lane-kit 里缺失")
            continue
        for field in ("label", "color", "z", "x"):
            if field not in want:
                continue
            expected = RENDERED_OVERRIDE.get((key, field), want[field])
            if expected.lower() != str(got.get(field, "")).lower():
                problems.append(f"设备 {key}.{field}: app.js={expected} lane-kit={got.get(field)}")

    for key, want in app_coils.items():
        got = kit_coils.get(key)
        if not got:
            problems.append(f"线圈 {key} 在 lane-kit 里缺失")
            continue
        for field in ("label", "z", "color"):
            if field in want and want[field].lower() != str(got.get(field, "")).lower():
                problems.append(f"线圈 {key}.{field}: app.js={want[field]} lane-kit={got.get(field)}")

    extra = set(kit_devices) - set(app_devices)
    if extra:
        problems.append(f"lane-kit 多出设备: {sorted(extra)}")

    print(f"app.js 设备 {len(app_devices)} / lane-kit 设备 {len(kit_devices)}")
    print(f"app.js 线圈 {len(app_coils)} / lane-kit 线圈 {len(kit_coils)}")
    if problems:
        print("不一致：")
        for item in problems:
            print("  -", item)
        return 1
    print("完全一致：每条车道的设备/线圈 标签、颜色、z、x 与 index.html 相同")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
