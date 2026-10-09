"""从日志原文里抽取车辆属性，供单车主流程与多车道生成器共用。

只用日志里真实出现过的字段，并把「已验证」与「未验证」分开标注：
  * 车牌颜色：本窗口 257 辆车交叉验证 —— 车型 11（货一）配 0（蓝牌）、车型 12/13/14/16
    配 1（黄牌）、车型 1（客一）配 0/4（蓝/绿牌）、车型 4（客四，大客）配 1（黄牌），
    与「轻型货车蓝牌、重型货车与大客黄牌、新能源绿牌」的常识完全一致，
    因此采用部颁编码 0蓝 1黄 2黑 3白 4绿。
  * 车身颜色：日志里只有牌识的厂商码 vehicleColor（本窗口 81% 为 0/未上报，
    且车型识别设备 E3 恒为 00），日志中没有码表，故一律标记 verified=False。
  * 车型：部车型码（JT/T 489 分类：1~4 客车、11~16 货车、21~26 专项作业车），
    另有车型识别设备（E3）的判定车型与真实轴数、长宽高、轴距（十六进制毫米）。
"""
from __future__ import annotations

import re

# ---------------------------------------------------------------------------
# 码表
# ---------------------------------------------------------------------------

PLATE_COLORS = {
    0: "蓝色",
    1: "黄色",
    2: "黑色",
    3: "白色",
    4: "绿色",
    5: "黄绿双拼",
    255: "未上报",
}

# 车身颜色为牌识厂商码，日志未给出码表：仅作低置信度推断，界面上必须标注未验证。
# 依据是本窗口非零取值的分布（车型 1 以 2 最多、其次 1/3；货车以 4 居多），
# 与常见的「白/黑/红/银/灰/蓝」车色枚举吻合。
BODY_COLORS = {
    1: "白色",
    2: "黑色",
    3: "红色",
    4: "银色",
    5: "灰色",
    6: "蓝色",
    7: "绿色",
    8: "黄色",
    9: "棕色",
    13: "银灰",
}

# 部车型码 -> 三维模型族、默认几何（米，仅当日志没有真实尺寸时使用）
VEHICLE_CLASSES = {
    1: {"label": "客一", "kind": "car", "axles": 2, "length": 4.7, "width": 1.85, "height": 1.50, "seats": "≤9座"},
    2: {"label": "客二", "kind": "van", "axles": 2, "length": 5.9, "width": 2.00, "height": 2.45, "seats": "10~19座"},
    3: {"label": "客三", "kind": "bus", "axles": 2, "length": 8.9, "width": 2.45, "height": 3.30, "seats": "20~39座"},
    4: {"label": "客四", "kind": "coach", "axles": 2, "length": 11.9, "width": 2.55, "height": 3.80, "seats": "≥40座"},
    11: {"label": "货一", "kind": "lightTruck", "axles": 2, "length": 5.8, "width": 1.90, "height": 2.20, "note": "2轴轻卡"},
    12: {"label": "货二", "kind": "mediumTruck", "axles": 2, "length": 9.6, "width": 2.40, "height": 3.00, "note": "2轴货车"},
    13: {"label": "货三", "kind": "rigid3", "axles": 3, "length": 11.0, "width": 2.50, "height": 3.60, "note": "3轴货车"},
    14: {"label": "货四", "kind": "rigid4", "axles": 4, "length": 12.0, "width": 2.50, "height": 3.90, "note": "4轴货车"},
    15: {"label": "货五", "kind": "semi5", "axles": 5, "length": 16.5, "width": 2.55, "height": 4.00, "note": "5轴半挂"},
    16: {"label": "货六", "kind": "semi6", "axles": 6, "length": 18.5, "width": 2.55, "height": 4.00, "note": "6轴半挂"},
    21: {"label": "专一", "kind": "special", "axles": 2, "length": 8.0, "width": 2.50, "height": 3.20, "note": "专项作业车"},
    22: {"label": "专二", "kind": "special", "axles": 3, "length": 9.5, "width": 2.50, "height": 3.40, "note": "专项作业车"},
    23: {"label": "专三", "kind": "special", "axles": 4, "length": 11.0, "width": 2.50, "height": 3.60, "note": "专项作业车"},
    24: {"label": "专四", "kind": "special", "axles": 5, "length": 13.0, "width": 2.50, "height": 3.80, "note": "专项作业车"},
    25: {"label": "专五", "kind": "special", "axles": 6, "length": 15.0, "width": 2.55, "height": 4.00, "note": "专项作业车"},
    26: {"label": "专六", "kind": "special", "axles": 6, "length": 16.5, "width": 2.55, "height": 4.00, "note": "专项作业车"},
}

# 未知车型时的兜底：黄牌按 2 轴普通货车，蓝/绿牌按小型客车
FALLBACK_BY_PLATE_COLOR = {0: 1, 3: 1, 4: 1, 5: 1, 1: 12, 2: 12}

# 各车型族的合理车长区间（米）：车型识别设备的实测尺寸只在与车型族相符时才采用，
# 否则会出现"22.5 米长的轿车"这类把邻车尺寸套上来的错误。
KIND_LENGTH_RANGE = {
    "car": (2.4, 6.2),
    "van": (3.5, 8.5),
    "bus": (6.0, 12.5),
    "coach": (8.0, 14.0),
    "lightTruck": (3.5, 8.5),
    "mediumTruck": (5.0, 12.5),
    "rigid3": (7.0, 13.5),
    "rigid4": (8.0, 14.0),
    "semi5": (12.0, 19.5),
    "semi6": (13.0, 22.5),
    "special": (4.0, 22.5),
}

# ---------------------------------------------------------------------------
# 抽取
# ---------------------------------------------------------------------------

RE_DECLARED = re.compile(r"(?:通行)?车型[：:]\s*(\d+)")
RE_IDENTIFY_JSON = re.compile(r'"identifyVehicleType":\s*"?(\d+)"?')
RE_IDENTIFY_HEX = re.compile(r"\bidentifyType=([0-9A-Fa-f]{2})\b")
RE_AXLE_E3 = re.compile(r"\bvehicleAxleCount=(\d+)")
RE_AXLE_DECL = re.compile(r"货车轴数[：:]\s*(\d+)")
RE_AXLE_FEE = re.compile(r'"(?:feeAxleCount|enAxleCount|exAxleCount)":\s*"?(\d+)"?')
RE_AXLE_JSON = re.compile(r'"AxleNum":\s*"?(\d+)"?')
RE_AXLE_COUNT = re.compile(r'"axleCount":\s*(\d+)')
RE_DIM = re.compile(r"\bvehicle(Length|Width|Heigth|WheelBase)=([0-9A-Fa-f]{3,4})\b")
RE_PLATE_AUTO = re.compile(r'"AutoVLP":\s*"([^"]+)"')
RE_PLATE_CN = re.compile(r"车牌号[：:]\s*([\u4e00-\u9fff][A-Z][A-Z0-9]{4,6})")
RE_PLATE_BRACKET = re.compile(r"\[([\u4e00-\u9fff][A-Z][A-Z0-9]{4,6})\]")
RE_PLATE_COLOR_CN = re.compile(r"车牌颜色[：:]\s*(\d+)")
RE_PLATE_COLOR_JSON = re.compile(r'"plateColor":\s*"?(\d+)"?')
RE_LICENSE_COLOR = re.compile(r"\blicenseColor=(\d+)")
RE_VLP_C = re.compile(r'"AutoVLPC":\s*"?(\d+)"?')
RE_BODY_COLOR = re.compile(r"\bvehicleColor=(\d+)")
RE_DANGER = re.compile(r"\bdangerousGoods=([0-9A-Fa-f]{2})")
RE_SPECIAL = re.compile(r"\bvehicleSpecial=([0-9A-Fa-f]{6})")
RE_LOAD = re.compile(r"核载质量[：:]\s*(\d+)")
RE_CURB = re.compile(r"整备质量[：:]\s*(\d+)")
RE_GVW = re.compile(r"车辆总重[：:]\s*(\d+)")
RE_ACTUAL_WEIGHT = re.compile(r"货车总重[：:]\s*(\d+)")
RE_SPEED_E3 = re.compile(r"\bvehicleSpeed=([0-9A-Fa-f]{2})\b")

PLATE_NOISE = {"未识别", "无牌", "null"}


def _first(pattern: re.Pattern, texts, cast=str):
    for text in texts:
        match = pattern.search(text)
        if match:
            try:
                return cast(match.group(1)), text
            except (TypeError, ValueError):
                continue
    return None, None


def _hex_to_m(value: str):
    try:
        number = int(value, 16)
    except ValueError:
        return None
    return number / 1000.0 if number > 100 else None


def _clamp(value, low, high, default):
    if not value or not (low <= value <= high):
        return default
    return value


def extract_vehicle(texts) -> dict:
    """把一段日志原文转成车辆规格。texts 可以是同一辆车/同一趟过程的全部原文。"""
    texts = [text for text in texts if text]
    joined = "\n".join(texts)
    evidence: list[str] = []

    # --- 车牌 ---
    plate = None
    for pattern in (RE_PLATE_AUTO, RE_PLATE_CN, RE_PLATE_BRACKET):
        value, _ = _first(pattern, texts)
        if value and value not in PLATE_NOISE:
            plate = value
            break

    # --- 车牌颜色（已验证码表）---
    plate_color = None
    for pattern, label in (
        (RE_PLATE_COLOR_CN, "车牌颜色"),
        (RE_PLATE_COLOR_JSON, "plateColor"),
        (RE_LICENSE_COLOR, "licenseColor"),
        (RE_VLP_C, "AutoVLPC"),
    ):
        value, _ = _first(pattern, texts, int)
        if value is not None and value != 255:
            plate_color = value
            evidence.append(f"{label}={value}（{PLATE_COLORS.get(value, '未知')}）")
            break

    # --- 申报车型 ---
    declared, _ = _first(RE_DECLARED, texts, int)
    if declared is not None:
        evidence.append(f"申报车型={declared}")

    # --- 车型识别设备判定车型（十六进制部车型码）---
    identified, _ = _first(RE_IDENTIFY_JSON, texts, int)
    if not identified:
        raw, _ = _first(RE_IDENTIFY_HEX, texts)
        if raw:
            identified = int(raw, 16)
    if identified:
        evidence.append(f"车型识别判定={identified}")

    # --- 轴数：只用与车型证据同源、且取值合理的轴数 ---
    # 255（0xFF）与 0 是日志里的"未知"哨兵，直接当轴数会画出 6 轴小客车；
    # 车型来源不明时（纯车牌颜色兜底）也不借用本趟窗口里其他车的轴数。
    def valid_axle(value):
        return bool(value) and 2 <= value <= 6

    axle_count = None
    axle_source = None
    if identified:
        source_patterns = ((RE_AXLE_E3, "车型识别轴数"), (RE_AXLE_COUNT, "称重轴数"))
    elif declared:
        source_patterns = (
            (RE_AXLE_DECL, "卡内货车轴数"),
            (RE_AXLE_FEE, "计费轴数"),
            (RE_AXLE_JSON, "流水轴数"),
            (RE_AXLE_COUNT, "称重轴数"),
        )
    else:
        source_patterns = ()
    for pattern, source in source_patterns:
        for text in texts:
            for raw in pattern.findall(text):
                value = int(raw)
                if valid_axle(value):
                    axle_count, axle_source = value, source
                    evidence.append(f"{source}={value}")
                    break
            if axle_count:
                break
        if axle_count:
            break

    # --- 真实尺寸（车型识别设备，十六进制毫米）---
    dims: dict[str, float] = {}
    for key, target in (("Length", "length"), ("Width", "width"), ("Heigth", "height"), ("WheelBase", "wheelbase")):
        raw, _ = _first(re.compile(rf"\bvehicle{key}=([0-9A-Fa-f]{{3,4}})\b"), texts)
        value = _hex_to_m(raw) if raw else None
        if value:
            dims[target] = round(value, 3)
    if dims:
        evidence.append("尺寸来自车型识别设备：" + "、".join(f"{k}={v}m" for k, v in dims.items()))

    # --- 车身颜色（厂商码，未验证）---
    body_code, _ = _first(RE_BODY_COLOR, texts, int)
    if body_code:
        evidence.append(f"牌识车身色码={body_code}（厂商码表未验证）")

    # --- 危险品 / 专项作业车 ---
    danger_raw, _ = _first(RE_DANGER, texts)
    dangerous = bool(danger_raw) and danger_raw.upper() != "00"
    special_raw, _ = _first(RE_SPECIAL, texts)
    special = bool(special_raw) and special_raw.upper() != "000000"
    if dangerous:
        evidence.append("危险品运输标志=是")

    # --- 质量与速度 ---
    mass = {}
    for pattern, key, label in (
        (RE_LOAD, "load", "核载质量"),
        (RE_CURB, "curb", "整备质量"),
        (RE_GVW, "gvw", "车辆总重"),
        (RE_ACTUAL_WEIGHT, "actual", "货车总重"),
    ):
        value, _ = _first(pattern, texts, int)
        if value:
            mass[key] = value
    speed_raw, _ = _first(RE_SPEED_E3, texts)
    speed = int(speed_raw, 16) if speed_raw else None

    # --- 归类 ---
    code = identified or declared or 0
    if code not in VEHICLE_CLASSES:
        code = 0
    if not code:
        code = FALLBACK_BY_PLATE_COLOR.get(plate_color or -1, 1)
        basis = "未知车型，按车牌颜色兜底"
        axle_count, axle_source = None, None       # 兜底时轴数一律用车型默认值
    elif identified and declared and identified != declared:
        basis = f"车型识别（{VEHICLE_CLASSES[identified]['label']}）与申报（{VEHICLE_CLASSES[declared]['label']}）不一致"
    elif identified:
        basis = "车型识别设备判定"
    else:
        basis = "ETC 卡/OBU 申报"

    spec = VEHICLE_CLASSES[code]
    kind = spec["kind"]
    low, high = KIND_LENGTH_RANGE.get(kind, (2.4, 22.5))
    real_dims = bool(dims)
    if real_dims and not (low <= dims.get("length", 0) <= high):
        evidence.append(
            f"车型识别实测车长 {dims.get('length')}m 与车型族 {kind} 不符（合理区间 {low}~{high}m），已忽略实测尺寸"
        )
        dims = {}
        real_dims = False
    length = _clamp(dims.get("length"), low, high, spec["length"])
    width = _clamp(dims.get("width"), 1.2, 3.2, spec["width"])
    height = _clamp(dims.get("height"), 1.1, 4.6, spec["height"])
    wheelbase = _clamp(dims.get("wheelbase"), 1.6, 16.0, None)
    axles = axle_count or spec["axles"]
    axles = max(2, min(6, axles))

    class_label = spec["label"] if code else "未知"
    return {
        "plate": plate or "",
        "classCode": code,
        "classLabel": class_label,
        "classBasis": basis,
        "declaredClass": declared,
        "identifiedClass": identified or None,
        "classMismatch": bool(declared and identified and declared != identified),
        "axleMismatch": bool(axle_count and axle_count != spec["axles"]),
        "kind": kind,
        "axles": axles,
        "axleSource": axle_source,
        "dims": {"length": length, "width": width, "height": height, "wheelbase": wheelbase},
        "realDims": real_dims,
        "plateColorCode": plate_color,
        "plateColorLabel": PLATE_COLORS.get(plate_color) if plate_color is not None else None,
        "bodyColorCode": body_code if body_code else None,
        "bodyColorLabel": BODY_COLORS.get(body_code) if body_code else None,
        "bodyColorVerified": False,
        "dangerous": dangerous,
        "special": special,
        "mass": mass,
        "speed": speed,
        "note": spec.get("note") or spec.get("seats") or "",
        "evidence": evidence,
    }
