# -*- coding: utf-8 -*-
"""一次性重构：把第 3 组「设施/硬件设备/软件服务」拆成独立对象。

- 原 Device（12 列）拆为 VehicleDetector / PlateRecognitionDevice / RsuUnit / BarrierGate / DisplaySignalUnit
- 原 SoftwareService（29 列）拆为 BillingService / TradeService / AuthorizationService /
  MessageCacheService / DeviceControlService / LaneFrontendService
- 设施对象 Station / Lane 保持；Vehicle / TollMedium 保持
- 所有已有属性块**逐字复用**（描述不重打），仅重组归属并重写对象头/关系/注释
- 硬件与服务对象均为归集表同行投影：主键属性 pass_record_id → vehicle_pass_record.id

运行：python _remodel_split.py   （会先备份为 highway_demo.ontology.bak.yaml）
"""
import io
import re
import shutil

P = "highway_demo.ontology.yaml"
BAK = "highway_demo.ontology.bak.yaml"
shutil.copyfile(P, BAK)

src = io.open(P, encoding="utf-8").read()
i_ot = src.index("\nobject_types:\n") + len("\nobject_types:\n")
i_lt = src.index("\nlink_types:\n")
i_fn = src.index("\nfunctions:\n")
i_rl = src.index("\nrules:\n")
i_nt = src.index("# 口径与待确认")
i_nt = src.rindex("# ═", 0, i_nt)  # 注释块起始横幅

objects_txt = src[i_ot:i_lt]
blocks = re.split(r"\n(?=  - name: )", objects_txt)
OBJ = {}
for b in blocks[1:]:
    OBJ[re.match(r"  - name: (\S+)", b).group(1)] = b.strip("\n")


def props_of(block):
    a = block.index("    properties:\n") + len("    properties:\n")
    b = block.index("    data_source:\n")
    body = block[a:b]
    out = {}
    order = []
    for m in re.finditer(r"(?ms)^      - name: (\S+)\n(.*?)(?=^      - name: |\Z)", body):
        name = m.group(1)
        lines = [ln for ln in m.group(0).rstrip("\n").split("\n")
                 if not ln.strip().startswith("#")]
        out[name] = "\n".join(lines)
        order.append(name)
    return out, order


DEV, dev_order = props_of(OBJ["Device"])
SVC, svc_order = props_of(OBJ["SoftwareService"])
# 上一轮给投影对象加的主键属性，拆分后由每个新对象各自重建，这里先摘掉
for pool, order in ((DEV, dev_order), (SVC, svc_order)):
    assert "pass_record_id" in order
    order.remove("pass_record_id")
    pool.pop("pass_record_id")
assert len(DEV) == 12 and len(dev_order) == 12, dev_order
assert len(SVC) == 29 and len(svc_order) == 29, svc_order

# ── 已有对象：逐字复用 + 少量归属口径修订 ──
VPR = OBJ["VehiclePassRecord"]
for old, new in [("a1_frame_time 属 Device，实际取值", "a1_frame_time 属 DeviceControlService，实际取值"),
                 ("detector7_time 属 Device", "detector7_time 属 VehicleDetector"),
                 ("（归属 SoftwareService·计费服务）", "（归属 BillingService·计费服务）")]:
    assert VPR.count(old) == 1, old
    VPR = VPR.replace(old, new)

KEEP = {"VehiclePassRecord": VPR, "Station": OBJ["Station"], "Lane": OBJ["Lane"],
        "Vehicle": OBJ["Vehicle"], "TollMedium": OBJ["TollMedium"],
        "BusinessResult": OBJ["BusinessResult"], "BusinessRule": OBJ["BusinessRule"],
        "LogRecord": OBJ["LogRecord"]}

PK_BLOCK = """      - name: pass_record_id
        display_name: 通行记录标识
        data_type: string
        required: true
        unique: true
        primary_key: true
        description: 同行投影的行身份，取 vehicle_pass_record.id，用于与通行记录建立关联"""


def build(name, display, desc, role, order, pool):
    lines = [f"  - name: {name}", f"    display_name: {display}", f"    description: {desc}",
             f"    role: {role}", "    properties:", PK_BLOCK]
    lines += [pool[p] for p in order]
    lines += ["    data_source:", '      connection_id: "highway_demo"',
              "      table: vehicle_pass_record", "      id_column: id", "      field_mapping:",
              "        pass_record_id: id"]
    lines += [f"        {p}: {p}" for p in order]
    assert len(desc) <= 100, (name, len(desc))
    return "\n".join(lines)


DET = ["detector1_time", "detector1_leave_time", "detector2_time", "detector2_leave_time",
       "detector6_time", "detector6_leave_time", "detector7_time", "detector7_leave_time"]
LPR = ["plate_capture_time", "plate_capture_plate"]
BAR = ["gate_open_time", "gate_finish_time"]
BILL = ["billing_req_time", "billing_resp_time", "pay_time", "trans_time", "pay_type", "fee", "pay_fee"]
TRADE = ["xp_time", "cpc_time", "full_tolling_save_time", "redis_save_time", "error_code",
         "batch_num", "shift", "work_date"]
CACHE = ["waste_generate_time"]
DCS = ["b2_frame_time", "b4_frame_time", "b5_frame_time", "c2_frame_time", "c6_frame_time",
       "a1_frame_time", "ba_frame_time", "e1_frame_time",
       "b2_errcode", "b4_errcode", "b5_errcode", "c2_errcode", "c6_errcode"]
used = DET + LPR + BAR + BILL + TRADE + CACHE + DCS
assert sorted(used) == sorted(dev_order + svc_order), set(dev_order + svc_order) ^ set(used)

NEW = [
    ("VehicleDetector", "车辆检测器",
     "车辆检测器（硬件）：车检器 1/2/6/7 的有信号与离开时间点，是 T1/T4 与耗时基线的来源。", "fact", DET, DEV),
    ("PlateRecognitionDevice", "车牌识别设备",
     "车牌识别设备（硬件）：抓拍时间 B1 与牌识车牌，用于与交易侧车牌比对。", "fact", LPR, DEV),
    ("RsuUnit", "RSU读写单元",
     "RSU 读写单元（硬件）：以 B2/B4/B5 帧与 OBU 交互；本表无 RSU 编号列，帧时间归属设备控制服务。", "fact", [], DEV),
    ("BarrierGate", "栏杆机",
     "栏杆机（硬件）：执行抬杆请求 T2 与抬杆到位 T3 上报，是放行判定与 T3-T1 的证据。", "fact", BAR, DEV),
    ("DisplaySignalUnit", "显示屏信号灯",
     "显示屏/信号灯（硬件）：发布费额与放行指示；本表无专属列，证据由抬杆与帧时间间接体现。", "fact", [], DEV),
    ("BillingService", "计费服务",
     "计费服务（软件）：计费请求与响应、支付与交易时间，以及应收 fee、实收 pay_fee。", "fact", BILL, SVC),
    ("TradeService", "交易服务",
     "交易服务（软件）：ETC/CPC 交易与流水落库，含 B2-B5 耗时、CPC 耗时、完整 tolling 保存与特情码。", "fact", TRADE, SVC),
    ("AuthorizationService", "授权服务",
     "授权服务（软件）：下发车道通行授权；本表无专属列，结果由特情码与 E1 帧间接体现。", "fact", [], SVC),
    ("MessageCacheService", "消息缓存服务",
     "消息缓存服务（软件）：流水消息生成与 Redis 落库，对应流水生成时间与流水ID。", "fact", CACHE, SVC),
    ("DeviceControlService", "设备控制服务",
     "设备控制服务（软件）：B2/B4/B5/C2/C6/A1/BA/E1 帧交互与帧错误码，汇聚各设备指令。", "fact", DCS, SVC),
    ("LaneFrontendService", "车道前端服务",
     "车道前端服务（软件）：编排一次过车的感知、计费、交易、授权与放行流程。", "fact", [], SVC),
]

HEAD = """# ═══════════════════════════════════════════════════════════════════════════
# 高速公路 ETC 车道过车记录本体  highway_demo.ontology
# ───────────────────────────────────────────────────────────────────────────
# 生成依据（四合一）：
#   1) 原本体：com.highway.ontology 的对象类型/关系/函数/规则
#   2) 物理结构：PostgreSQL 表 public.vehicle_pass_record（62 列，见 vehicle_pass_record.ddl.sql）
#   3) 日志口径：《交易日志监测和分析系统方案设计V2.1》4.2 时间节点表
#                《本体分析方案与实例规格V1》2.2 时间语义字典 / 5.2 T1 与两个耗时
#   4) 对象归属：用户《高速日志归集表与对象关系标注》5 组对象 + 第 3 组按
#                「设施 / 硬件设备 / 软件服务」单独拆分（本轮重构）
#
# 对象清单（每列只归属一个对象；同名物理属性在全文件中只出现一次）：
#   过车记录·整体对象  VehiclePassRecord  id/pass_id/trade_id/waste_id + 审计列 + 派生
#   设施  Station 收费站      station_id/station_name
#         Lane    收费车道    lane_id/lane_hex/lane_type
#   车辆与介质  Vehicle 车辆  plate_no…axle_type
#         TollMedium 通行介质  obu_id/obu_mac/obu_serial_number/card_no/media_no/media_type
#   硬件设备  VehicleDetector         车辆检测器  detector1|2|6|7 信号与离开时间
#         PlateRecognitionDevice 车牌识别设备  plate_capture_time/plate_capture_plate
#         RsuUnit                RSU读写单元  （本表无专属列，仅同行投影主键）
#         BarrierGate            栏杆机      gate_open_time/gate_finish_time
#         DisplaySignalUnit      显示屏信号灯 （本表无专属列，仅同行投影主键）
#   软件服务  BillingService        计费服务  billing_*/pay_*/trans_time/pay_type/fee/pay_fee
#         TradeService          交易服务  xp_time/cpc_time/full_tolling_save_time/
#                                        redis_save_time/error_code/batch_num/shift/work_date
#         AuthorizationService  授权服务  （本表无专属列，仅同行投影主键）
#         MessageCacheService   消息缓存服务  waste_generate_time
#         DeviceControlService  设备控制服务  b2…e1 帧时间与 5 个帧错误码
#         LaneFrontendService   车道前端服务  （本表无专属列，仅同行投影主键）
#   原本体保留  BusinessResult / BusinessRule / LogRecord（演示库表）
#
# 投影说明：Station/Lane/Vehicle/TollMedium 及全部硬件/服务对象的数据源都是归集表
#   vehicle_pass_record（同表投影）。硬件与服务对象的行身份用属性 pass_record_id
#   （→ vehicle_pass_record.id）作主键；除该表外的对象/关系表沿用原本体定义。
#   FacilityAndService、Device、SoftwareService 三个粗粒度对象已被上述细分对象取代。
#
# 映射约定：
#   · 属性名 = 物理列名（DDL 原样小写），field_mapping 为同名映射；派生属性为别名映射
#   · required 与 DDL 的 NOT NULL 对齐；timestamp→date、int2/int4/tinyint→int、varchar/text→string
#   · 5 个 *_errcode 为本次补充属性，提供的 DDL 中尚无对应列（见文末第 12 条）
#   · 每个对象恰有一个 primary_key: true 属性（平台保存强约束）
# ═══════════════════════════════════════════════════════════════════════════
version: "1.0"
namespace: com.highway.ontology

data_sources:
  - id: "highway_demo"
    type: postgresql
    database: highway_demo
    jdbc_url: "jdbc:postgresql://127.0.0.1:5432/highway_demo?currentSchema=public"
    # 若需与示例同构的本地演示库（sqlite），仅替换下面两行为：
    #   type: sqlite
    #   jdbc_url: jdbc:sqlite:data/highway_demo.db

"""


def link(name, display, desc, s, t, card, mappings, table="vehicle_pass_record",
         src_col="id", tgt_col="id"):
    lines = [f"  - name: {name}", f"    display_name: {display}", f"    description: {desc}",
             f"    source_type: {s}", f"    target_type: {t}",
             f"    cardinality: {card}", "    direction: directed"]
    if mappings:
        lines.append("    property_mappings:")
        lines += [f"      {k}: {v}" for k, v in mappings.items()]
    else:
        lines.append("    property_mappings: {}")
    lines += ["    data_source:", '      connection_id: "highway_demo"',
              f"      table: {table}", f"      source_id_column: {src_col}",
              f"      target_id_column: {tgt_col}", "      field_mapping: {}"]
    assert len(display) <= 128 and not re.search(r"\s", display), display
    return "\n".join(lines)


P2 = {"pass_record_id": "id"}
PP = {"pass_record_id": "pass_record_id"}
LINKS = [
    link("vehicle_participates_pass_record", "车辆参与通行记录",
         "一辆车辆可以产生多条通行记录；本表无车辆外键，以 plate_no 关联（对象 id_column 也是 plate_no）。",
         "Vehicle", "VehiclePassRecord", "one-to-many", None, src_col="plate_no"),
    link("vehicle_has_medium", "车辆持有通行介质",
         "一辆车辆可持有/标识多个通行介质（OBU、ETC卡、CPC卡、车牌）；同为车辆下属对象，以 plate_no → media_no 关联。",
         "Vehicle", "TollMedium", "one-to-many", None, src_col="plate_no", tgt_col="media_no"),
    link("pass_record_uses_medium", "通行记录使用通行介质",
         "一条通行记录关联一个通行介质，一个介质可参与多条通行记录；以 media_no 关联。",
         "TollMedium", "VehiclePassRecord", "one-to-many", None, src_col="media_no"),
    link("station_serves_pass_record", "收费站产生通行记录",
         "收费站/门架维度与通行记录的关系（设施对象），按 station_id 关联。",
         "Station", "VehiclePassRecord", "one-to-many", None, src_col="station_id"),
    link("lane_serves_pass_record", "车道产生通行记录",
         "收费车道维度与通行记录的关系（设施对象），按 lane_hex 关联；过车慢分组与邻道干扰分析以车道为主键。",
         "Lane", "VehiclePassRecord", "one-to-many", None, src_col="lane_hex"),
    link("detector_serves_pass_record", "车辆检测器支撑通行记录",
         "车检器 1/2/6/7 的信号与离开时间点支撑本次通行；同行投影，pass_record_id → 通行记录 id。",
         "VehicleDetector", "VehiclePassRecord", "one-to-one", P2),
    link("plate_recognition_serves_pass_record", "车牌识别设备支撑通行记录",
         "牌识设备完成抓拍与识别，给出抓拍时间 B1 与牌识车牌，是车牌比对与 T1 兜底的来源。",
         "PlateRecognitionDevice", "VehiclePassRecord", "one-to-one", P2),
    link("rsu_serves_pass_record", "RSU读写单元支撑通行记录",
         "RSU 与 OBU 的 B2/B4/B5 交互是交易耗时（C2/xp_time）的物理来源；本表无 RSU 编号列。",
         "RsuUnit", "VehiclePassRecord", "one-to-one", P2),
    link("barrier_gate_serves_pass_record", "栏杆机支撑通行记录",
         "栏杆机执行抬杆请求（T2）与抬杆到位（T3）上报，是放行判定与 T3-T1 耗时基线的来源。",
         "BarrierGate", "VehiclePassRecord", "one-to-one", P2),
    link("display_signal_serves_pass_record", "显示屏信号灯支撑通行记录",
         "显示屏/信号灯发布费额与放行指示；本表无专属时间列，由栏杆机与设备控制服务帧间接体现。",
         "DisplaySignalUnit", "VehiclePassRecord", "one-to-one", P2),
    link("billing_service_serves_pass_record", "计费服务支撑通行记录",
         "计费服务处理计费请求/响应并给出应收与实收（fee/pay_fee）、支付与交易时间。",
         "BillingService", "VehiclePassRecord", "one-to-one", P2),
    link("trade_service_serves_pass_record", "交易服务支撑通行记录",
         "交易服务完成 ETC/CPC 交易与流水落库，给出 B2-B5 耗时、CPC 卡耗时、完整 tolling 保存时间与交易特情码。",
         "TradeService", "VehiclePassRecord", "one-to-one", P2),
    link("authorization_service_serves_pass_record", "授权服务支撑通行记录",
         "授权服务下发车道通行授权并返回授权结果；本表无专属列，授权结果由特情码/E1 帧失败原因间接体现。",
         "AuthorizationService", "VehiclePassRecord", "one-to-one", P2),
    link("message_cache_serves_pass_record", "消息缓存服务支撑通行记录",
         "消息/缓存服务负责流水消息的生成与 Redis 落库，给出流水生成时间。",
         "MessageCacheService", "VehiclePassRecord", "one-to-one", P2),
    link("device_control_serves_pass_record", "设备控制服务支撑通行记录",
         "设备控制服务完成 B2/B4/B5/C2/C6/A1/BA/E1 帧交互并上报各帧错误码，是设备指令与帧时间点的汇聚点。",
         "DeviceControlService", "VehiclePassRecord", "one-to-one", P2),
    link("lane_frontend_serves_pass_record", "车道前端服务支撑通行记录",
         "车道前端服务（车道收费软件）编排一次过车的感知、计费、交易、授权与放行流程。",
         "LaneFrontendService", "VehiclePassRecord", "one-to-one", P2),
    link("device_control_drives_barrier_gate", "设备控制服务驱动栏杆机",
         "设备控制服务下发抬杆/落杆指令并接收到位反馈（E4010101/E4）。",
         "DeviceControlService", "BarrierGate", "one-to-many", PP),
    link("device_control_drives_display_signal", "设备控制服务驱动显示屏信号灯",
         "设备控制服务驱动显示屏发布费额并切换信号灯放行指示。",
         "DeviceControlService", "DisplaySignalUnit", "one-to-many", PP),
    link("device_control_manages_rsu", "设备控制服务管理RSU读写单元",
         "设备控制服务通过 RSU 与 OBU 交互（B2/B4/B5 帧）并维护天线状态。",
         "DeviceControlService", "RsuUnit", "one-to-many", PP),
    link("lane_frontend_calls_device_control", "车道前端服务调用设备控制服务",
         "车道前端服务通过设备控制服务驱动外场设备并获取帧结果。",
         "LaneFrontendService", "DeviceControlService", "one-to-many", PP),
    link("lane_frontend_calls_billing", "车道前端服务调用计费服务",
         "车道前端服务向计费服务发起计费请求并接收计费结果。",
         "LaneFrontendService", "BillingService", "one-to-many", PP),
    link("lane_frontend_calls_trade", "车道前端服务调用交易服务",
         "车道前端服务发起 ETC/CPC 交易并写入流水。",
         "LaneFrontendService", "TradeService", "one-to-many", PP),
    link("lane_frontend_requests_authorization", "车道前端服务请求授权服务",
         "车道前端服务请求通行授权，授权失败需按特情处理。",
         "LaneFrontendService", "AuthorizationService", "one-to-many", PP),
    link("lane_frontend_publishes_message", "车道前端服务投递消息缓存服务",
         "车道前端服务将通行/交易消息投递到消息缓存服务落库。",
         "LaneFrontendService", "MessageCacheService", "one-to-many", PP),
    link("pass_record_generates_result", "通行记录产生业务结果",
         "一条通行记录在处理过程中产生多个业务结果（识别/计费/交易/放行/特情/流水）。",
         "VehiclePassRecord", "BusinessResult", "one-to-many", {"id": "record_id"},
         table="BUSINESS_RESULT", src_col="RECORD_ID", tgt_col="ID"),
    link("rule_constrains_pass_record", "业务规则约束通行记录",
         "业务规则对通行记录的处理进行校验和约束；一条记录被多条规则约束的多对多语义由规则关联表的多行表达。",
         "BusinessRule", "VehiclePassRecord", "one-to-many", None,
         table="RULE_PASS_REL", src_col="RULE_ID", tgt_col="RECORD_ID"),
    link("rule_constrains_result", "业务规则约束业务结果",
         "业务规则对识别结果、计费结果、交易结果等进行校验。",
         "BusinessRule", "BusinessResult", "one-to-many", None,
         table="RULE_RESULT_REL", src_col="RULE_ID", tgt_col="RESULT_ID"),
    link("pass_record_logs_evidence", "通行记录生成日志证据",
         "通行记录的全生命周期数据留痕为日志记录，用于结论回指与口径核对。",
         "VehiclePassRecord", "LogRecord", "one-to-many", {"id": "record_id"},
         table="LOG_RECORD", src_col="RECORD_ID", tgt_col="ID"),
    link("result_logs_evidence", "业务结果生成日志证据",
         "各业务结果（识别、计费、交易、放行等）留痕为日志记录。",
         "BusinessResult", "LogRecord", "one-to-many", {"id": "result_id"},
         table="LOG_RECORD", src_col="RESULT_ID", tgt_col="ID"),
]
assert len(LINKS) == 29

NOTES = """
# ═══════════════════════════════════════════════════════════════════════════
# 口径与待确认（纯注释，不影响解析）
# ═══════════════════════════════════════════════════════════════════════════
# 1) 时间节点口径：A1=车辆压到存在线圈、B1=抓拍时间、C1=首个 B2 帧、C2=B5−B2（落库 xp_time）、
#    T2=gate_open_time 抬杆请求、T3=gate_finish_time 抬杆到位（禁用 E4 回声行）、T4=车检器7。
#    见《交易日志监测和分析系统方案设计V2.1》4.2、《本体分析方案与实例规格V1》2.2 与 5.2。
# 2) 用户标注已消解三项旧待确认：xp_time=B2-B5 耗时（交易服务）、cpc_time=CPC 卡交易耗时、
#    gate_open/finish=抬杆请求/到位；waste_id/waste_generate_time 按"流水ID/流水生成时间"理解，
#    error_code 按"交易特情码"理解。
# 3) 本表无通行方向列（入口/出口）、无入口站与入口时间；direction、EnStation/EnTime 需由站级流水
#    或位元实体（ext_attributes）回填，方案中 laneDirection 整月为空。
# 4) 金额：fee=费用/应收、pay_fee=实收/支付费用；本站样例 pay_fee(5318) 大于 fee(4520)，差额 798
#    与计费响应 discountFee 一致，故库内单位（分/元）与折前折后归属仍须生产字段字典确认。
# 5) 除 vehicle_pass_record 外，BusinessResult/BusinessRule/LogRecord 及其关系表沿用原本体定义，
#    本次未提供其 DDL，落地时按生产库/日志源校正。
# 6) redis_save_time 归交易服务（沿用用户标注的 ETC 交易服务口径）；若按"Redis 入库"语义应归
#    消息缓存服务，请确认后调整（新增的 MessageCacheService 已存在）。
# 7) 码表类取值（plate_color、media_type、pay_type、lane_type 的混合车道等取值）现有依据只覆盖
#    本站样例值，须以生产编码表补齐；ba/c6 帧类型定义仍缺失。
# 8) 规则头谓词 has_abnormal_reason / has_result 沿用原本体命名，未声明为 link_type 或属性，
#    按开放词表处理；has_result 语义上等同 pass_record_generates_result 的谓词形式。
# 9) script_path 采用「数据源 id + .ontology/」前缀 highway_demo.ontology/（沿用原本体约定），
#    与 namespace com.highway.ontology 不是同一套命名；Java 实现尚未提供。
# 10) 对象归属实现方式：每列由"同名物理属性"唯一归属一个对象（全文件只出现一次）；派生属性是
#     别名映射（vehicle_id→plate_no、medium_id→media_no、entry_time→a1_frame_time、
#     exit_time→detector7_time、total_fee→fee、status→error_code），可跨对象引用载体列。
# 11) 硬件/软件服务对象均为归集表同行投影：主键属性 pass_record_id 映射 vehicle_pass_record.id，
#     同一次通行的设备/服务侧取值即该行；设备实例标识（车检器编号/栏杆机编号/屏号/RSU 编号）
#     需车道设备字典补全后才能建成独立主数据对象。
# 12) 5 个 *_errcode（B2/B4/B5/C2/C6）为补充属性，提供的 62 列 DDL 中尚无对应列，落地前须确认
#     是新增列还是由帧解析回填；其 field_mapping 目前指向同名占位列。
# 13) 第 3 组已按「设施 / 硬件设备 / 软件服务」拆为独立对象：设施=收费站、收费车道；硬件=车辆检测器、
#     车牌识别设备、RSU 读写单元、栏杆机、显示屏/信号灯；服务=计费、交易、授权、消息缓存、设备控制、
#     车道前端。FacilityAndService、Device、SoftwareService 不再单独存在；如需"硬件设备/软件服务"
#     基类（parent_object_types + base_type）请告知——平台上关系端点必须声明在 object_types 中，
#     不能用基类做端点，故关系按具体类型逐一声明（共 29 条）。
# 14) 归集表无专属列的 4 个对象：RsuUnit、DisplaySignalUnit、AuthorizationService、LaneFrontendService，
#     目前仅含同行投影主键 pass_record_id，其证据由帧时间（设备控制服务）、特情码、抬杆时间间接体现；
#     若补齐 RSU 编号/屏号/授权结果/前端心跳等字段，可再挂属性。
# 15) 关系属性映射遵循平台口径「键=源属性，值=目标属性」：硬件/服务→通行记录用
#     {pass_record_id: id}，服务→设备与服务→服务用 {pass_record_id: pass_record_id}（共 24 条）；
#     收费站/车道/车辆/介质与通行记录之间因拆分后两侧无同名列，未配置映射——需要的话可把
#     station_id/lane_hex/plate_no/media_no 挂回聚合根，或在维度对象上加 pass_record_id 镜像属性。
# 16) 平台导入约束（已本地镜像校验）：每个对象恰好一个 primary_key: true；对象 display_name≤42 且不含
#     空格、description≤100；属性 name/display_name≤64、description≤1000；关系 display_name≤128；
#     cardinality 仅 one-to-one / one-to-many / many-to-one（direction 由后端固定 directed）。
# 17) work_date 标注为 DATETIME、物理列为 date，按日期粒度归一；axle_count 标注 TINYINT、物理列为
#     int2，统一映射为 int。Station/Lane/Vehicle/TollMedium 的主键属性 required=false 与 DDL 可空性一致。
"""

order = ["VehiclePassRecord", "Station", "Lane", "Vehicle", "TollMedium"]
out = [HEAD, "object_types:\n"]
for name in order:
    out.append(KEEP[name] + "\n")
for name, display, desc, role, props, pool in NEW:
    out.append(build(name, display, desc, role, props, pool) + "\n")
for name in ["BusinessResult", "BusinessRule", "LogRecord"]:
    out.append(KEEP[name] + "\n")
out.append("\n# ═══════════════════════════════════════════════════════════════════════════\n"
           "# 关系边（29 条）：设施/车辆/介质/硬件设备/软件服务 → 过车记录，服务驱动设备与服务编排，\n"
           "#   以及原本体的业务结果/规则/日志关系。property_mappings 键=源属性、值=目标属性。\n"
           "# ═══════════════════════════════════════════════════════════════════════════\n")
out.append("link_types:\n")
out += [l + "\n" for l in LINKS]
out.append("\n" + src[i_fn:i_rl].strip("\n") + "\n")
out.append("\n" + src[i_rl:i_nt].strip("\n") + "\n")
out.append(NOTES)

io.open(P, "w", encoding="utf-8", newline="\n").write("\n".join(out))
print("备份:", BAK)
print("对象:", len(order) + len(NEW) + 3, " 关系:", len(LINKS))
print("复用属性块:", len(used), " 硬件对象:", sum(1 for s in NEW if s[5] is DEV),
      " 服务对象:", sum(1 for s in NEW if s[5] is SVC))
