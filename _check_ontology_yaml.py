# -*- coding: utf-8 -*-
"""只读校验：highway_demo.ontology.yaml 与 vehicle_pass_record.ddl.sql 的一致性。

模型：归集表 vehicle_pass_record 被拆为多个对象（每列唯一归属一个对象），
      BusinessResult/BusinessRule/LogRecord 沿用原本体演示表。

校验项：
  1. YAML 可解析、顶层键齐全；对象/属性/关系/函数/规则的关键键齐全
  2. 每列（62 DDL 列 + 5 个补充列）至少被一个属性映射；无凭空列
  3. 归属唯一：同名物理属性（属性名==列名）在全文件中只出现一次
  4. 类型一致：同一列被多个属性（别名派生）映射时 data_type 必须相同
  5. DDL 物理属性的 data_type 与 PG 类型一致、required 与 NOT NULL 一致
  6. 关系 13 条，source/target 可解析；归集表内的关系键列存在
  7. 与上一版快照（TEMP/etclog_old_props.json）比对，列出属性变化，便于确认改动都是有意为之

用法： python _check_ontology_yaml.py     （不写任何文件，退出码 0=通过）
"""
import json
import os
import re
import sys
from pathlib import Path

import yaml

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent
YAML_PATH = ROOT / "highway_demo.ontology.yaml"
DDL_PATH = ROOT / "vehicle_pass_record.ddl.sql"
SNAPSHOT = Path(os.environ.get("TEMP", ".")) / "etclog_old_props.json"

FACT_TABLE = "vehicle_pass_record"
DEMO_TABLES = {"BUSINESS_RESULT", "BUSINESS_RULE", "LOG_RECORD", "RULE_PASS_REL",
               "RULE_RESULT_REL", "SERVICE_PASS_REL", "SERVICE_DRIVE_REL", "TOLL_MEDIUM"}

# 本次补充属性：用户标注存在、但提供的 62 列 DDL 中尚无对应列
SUPPLEMENTAL = {"b2_errcode", "b4_errcode", "b5_errcode", "c2_errcode", "c6_errcode"}

# 用户标注的字段→对象归属（组名 → 列）
ATTRIBUTION = {
    "VehiclePassRecord": {"id", "pass_id", "trade_id", "waste_id",
                          "ext_attributes", "create_time", "update_time"},
    "Station": {"station_id", "station_name"},
    "Lane": {"lane_id", "lane_hex", "lane_type"},
    "Vehicle": {"plate_no", "plate_color", "vehicle_type", "actual_fee_class",
                "vehicle_model", "axle_count", "identify_axle_count", "axle_type"},
    "TollMedium": {"obu_id", "obu_mac", "obu_serial_number", "card_no",
                   "media_no", "media_type"},
    "VehicleDetector": {"detector1_time", "detector1_leave_time", "detector2_time",
                        "detector2_leave_time", "detector6_time", "detector6_leave_time",
                        "detector7_time", "detector7_leave_time"},
    "PlateRecognitionDevice": {"plate_capture_time", "plate_capture_plate"},
    "BarrierGate": {"gate_open_time", "gate_finish_time"},
    "BillingService": {"billing_req_time", "billing_resp_time", "pay_time", "trans_time",
                       "pay_type", "fee", "pay_fee"},
    "TradeService": {"xp_time", "cpc_time", "full_tolling_save_time", "redis_save_time",
                     "error_code", "batch_num", "shift", "work_date"},
    "MessageCacheService": {"waste_generate_time"},
    "DeviceControlService": {"b2_frame_time", "b4_frame_time", "b5_frame_time", "c2_frame_time",
                             "c6_frame_time", "a1_frame_time", "ba_frame_time", "e1_frame_time",
                             "b2_errcode", "b4_errcode", "b5_errcode", "c2_errcode", "c6_errcode"},
    # 归集表无专属列、仅含同行投影主键的对象
    "RsuUnit": set(), "DisplaySignalUnit": set(),
    "AuthorizationService": set(), "LaneFrontendService": set(),
}

TYPE_MAP = {"uuid": "string", "varchar": "string", "text": "string", "timestamp": "date",
            "date": "date", "int2": "int", "int4": "int", "tinyint": "int"}


def parse_ddl(path):
    cols, pk = {}, None
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip().rstrip(",")
        if not line or line.startswith("--") or line.upper().startswith("CREATE TABLE"):
            continue
        if line.upper().startswith("CONSTRAINT"):
            m = re.search(r"PRIMARY KEY\s*\(([^)]+)\)", line, re.I)
            if m:
                pk = m.group(1).strip()
            continue
        if line == ");":
            continue
        m = re.match(r"^([a-z_][a-z0-9_]*)\s+([a-z0-9_]+)(?:\((\d+)\))?", line, re.I)
        if not m:
            continue
        cols[m.group(1)] = (m.group(2).lower(), "NOT NULL" in line.upper())
    return cols, pk


def main():
    problems, notes = [], []
    doc = yaml.safe_load(YAML_PATH.open(encoding="utf-8"))
    for key in ("version", "namespace", "data_sources", "object_types",
                "link_types", "functions", "rules"):
        if key not in doc:
            problems.append(f"缺少顶层键 {key}")

    ddl_cols, pk = parse_ddl(DDL_PATH)
    known_cols = set(ddl_cols) | SUPPLEMENTAL
    notes.append(f"DDL {len(ddl_cols)} 列 + 补充 {len(SUPPLEMENTAL)} 列，主键 {pk}")

    objects = {o["name"]: o for o in doc["object_types"]}
    # 归属核对（用户标注表）
    for obj, cols in ATTRIBUTION.items():
        if obj not in objects:
            problems.append(f"对象 {obj} 缺失")
            continue
        got = {p["name"] for p in objects[obj]["properties"]}
        miss, extra = cols - got, {c for c in got if c in known_cols} - cols
        if miss:
            problems.append(f"{obj} 缺少标注列 {sorted(miss)}")
        if extra:
            problems.append(f"{obj} 出现不属于它的物理属性 {sorted(extra)}")

    # 收集全部属性与映射
    all_props, by_col, physical_owner = {}, {}, {}
    for oname, o in objects.items():
        fm = o["data_source"]["field_mapping"]
        props = {p["name"]: p for p in o["properties"]}
        if set(fm) != set(props):
            problems.append(f"{oname} 属性与 field_mapping 键不一致: "
                            f"仅属性={sorted(set(props)-set(fm))} 仅映射={sorted(set(fm)-set(props))}")
        table = o["data_source"]["table"]
        if table == FACT_TABLE:
            ic = o["data_source"]["id_column"]
            if ic not in known_cols:
                problems.append(f"{oname}.id_column={ic} 不是归集表列")
        for n, p in props.items():
            all_props[f"{oname}.{n}"] = p
            col = fm.get(n)
            if col is None:
                continue
            by_col.setdefault(col, []).append((oname, n, p["data_type"]))
            if n == col:  # 同名物理属性：唯一归属
                if col in physical_owner:
                    problems.append(f"列 {col} 被多个对象重复归属: "
                                    f"{physical_owner[col]} 与 {oname}")
                physical_owner[col] = oname
            if table != FACT_TABLE and col not in known_cols:
                continue
            if table == FACT_TABLE and col not in known_cols:
                problems.append(f"{oname}.{n} 映射到未知列 {col}")

    uncovered = known_cols - set(by_col)
    if uncovered:
        problems.append(f"未映射的列: {sorted(uncovered)}")

    # 归属唯一性 + 类型一致性
    for col, users in sorted(by_col.items()):
        if col not in known_cols:
            continue
        types = {t for _, _, t in users}
        if len(types) > 1:
            problems.append(f"列 {col} 被映射为冲突类型 {sorted(types)}: "
                            f"{[f'{o}.{n}' for o, n, _ in users]}")
    alias = {c: [n for _, n, _ in u] for c, u in by_col.items()
             if len(u) > 1 and c in known_cols}
    notes.append(f"归属唯一性: {len(physical_owner)}/{len(known_cols)} 列有唯一同名物理属性")
    if alias:
        notes.append("别名列: " + "; ".join(f"{c}←{','.join(ns)}" for c, ns in sorted(alias.items())))

    # 类型与可空性（DDL 物理属性）
    for col, (pgtype, not_null) in ddl_cols.items():
        owner = physical_owner.get(col)
        if owner is None:
            continue
        p = next(p for p in objects[owner]["properties"] if p["name"] == col)
        expect = TYPE_MAP[pgtype]
        if p["data_type"] != expect:
            problems.append(f"{owner}.{col}: data_type={p['data_type']} 应为 {expect}（PG {pgtype}）")
        if bool(p["required"]) != not_null:
            problems.append(f"{owner}.{col}: required={p['required']} 与 NOT NULL={not_null} 不一致")

    # 补充属性必须被标注为"DDL 中尚无对应列"
    for col in SUPPLEMENTAL:
        owner = physical_owner.get(col)
        if owner is None:
            problems.append(f"补充列 {col} 未归属任何对象")
            continue
        p = next(p for p in objects[owner]["properties"] if p["name"] == col)
        if "DDL" not in p["description"]:
            problems.append(f"补充列 {owner}.{col} 的描述未标注其为 DDL 外补充列")

    # 关系
    otypes = set(objects)
    if len(doc["link_types"]) < 10:
        problems.append(f"link_types 数量={len(doc['link_types'])} 少于原本体的 10")
    for link in doc["link_types"]:
        for f in ("source_type", "target_type"):
            if link[f] not in otypes:
                problems.append(f"关系 {link['name']} 的 {f}={link[f]} 不在 object_types 中")
        ds = link.get("data_source") or {}
        if ds.get("table") == FACT_TABLE:
            for cf in ("source_id_column", "target_id_column"):
                if ds.get(cf) not in known_cols:
                    problems.append(f"关系 {link['name']} 的 {cf}={ds.get(cf)} 不是归集表列")
    notes.append(f"关系 {len(doc['link_types'])} 条，函数 {len(doc['functions'])} 个，规则 {len(doc['rules'])} 条")

    # 关系属性映射（平台口径：键=源对象属性，值=目标对象属性）
    for link in doc["link_types"]:
        pm = link.get("property_mappings")
        if pm is None:
            problems.append(f"关系 {link['name']} 缺少 property_mappings 键")
            continue
        if not isinstance(pm, dict):
            problems.append(f"关系 {link['name']} 的 property_mappings 不是映射")
            continue
        src_props = {p["name"] for p in objects.get(link["source_type"], {}).get("properties", [])}
        tgt_props = {p["name"] for p in objects.get(link["target_type"], {}).get("properties", [])}
        if not src_props or not tgt_props:
            problems.append(f"关系 {link['name']} 的端点对象不存在")
            continue
        for k, v in pm.items():
            if k not in src_props:
                problems.append(f"关系 {link['name']} 映射键 {k} 不是源对象 {link['source_type']} 的属性")
            if v not in tgt_props:
                problems.append(f"关系 {link['name']} 映射值 {v} 不是目标对象 {link['target_type']} 的属性")
    mapped = sum(1 for l in doc["link_types"] if l.get("property_mappings"))
    notes.append(f"关系属性映射: {mapped}/{len(doc['link_types'])} 条已配置")

    # ══ 平台(dome-ontology)导入规则镜像：来源为
    #    OntologyImportFieldRuleValidator.java（字段规则）
    #    OntologyYamlImportServiceImpl.java:908（primary_key/primaryKey 读取）
    #    ObjectTypeServiceImpl.java:1320-1326（保存时必须至少一个主键属性）
    #    OntologyYamlExportServiceImpl.java:200-228（导出/导入字段顺序与键名）
    # ═════════════════════════════════════════════════════════════════════════
    IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
    LINK_IDENT = re.compile(r"[A-Za-z0-9_-]+")
    NOSPACE = re.compile(r"^\S+$")

    def check_len(val, limit, where, label):
        if len(val) > limit:
            problems.append(f"{where} {label} 长度 {len(val)} > {limit}")

    for o in doc["object_types"]:
        where = f"对象 {o['name']}"
        check_len(o["name"], 128, where, "name")
        if not IDENT.fullmatch(o["name"]):
            problems.append(f"{where}.name 不符合 [A-Za-z_][A-Za-z0-9_]*")
        dn = o["display_name"] or o["name"]
        check_len(dn, 42, where, "display_name")
        if not NOSPACE.match(dn):
            problems.append(f"{where}.display_name 含空格: {dn!r}")
        check_len(o["description"] or "", 100, where, "description")

        # 主键：平台保存时强约束"至少一个"，且只保留第一个 → 本地要求恰好一个
        pks = [p for p in o["properties"] if p.get("primary_key") is True]
        if len(pks) != 1:
            problems.append(f"{where} 主键属性数量={len(pks)}（平台要求至少一个，且只保留第一个）: "
                            f"{[p['name'] for p in pks]}")
        # 属性名/显示名在对象内唯一；字段规则与长度
        seen_n, seen_d = set(), set()
        for p in o["properties"]:
            pw = f"{where}.{p['name']}"
            check_len(p["name"], 64, pw, "name")
            if not IDENT.fullmatch(p["name"]):
                problems.append(f"{pw}.name 需以字母/下划线开头，仅含字母数字下划线")
            if p["name"].lower() in seen_n:
                problems.append(f"{where} 属性英文名重复: {p['name']}")
            seen_n.add(p["name"].lower())
            pdn = p["display_name"] or p["name"]
            check_len(pdn, 64, pw, "display_name")
            if not NOSPACE.match(pdn):
                problems.append(f"{pw}.display_name 含空格: {pdn!r}")
            if pdn in seen_d:
                problems.append(f"{where} 属性显示名重复: {pdn}")
            seen_d.add(pdn)
            check_len(p.get("description") or "", 1000, pw, "description")
            dc = p.get("data_classification")
            if dc is not None and dc not in (0, 1, 2):
                problems.append(f"{pw}.data_classification={dc} 不在 0/1/2")

    # 显示名不得含空白字符（函数/规则不在平台导入范围，仅作一致性检查）
    extra_dn = [(l["name"], l["display_name"]) for l in doc["link_types"]]
    extra_dn += [(f["name"], f["display_name"]) for f in doc["functions"]]
    extra_dn += [(r["name"], r["display_name"]) for r in doc["rules"]]
    for name, dn in extra_dn:
        if not NOSPACE.match(dn):
            problems.append(f"{name}.display_name 含空白字符: {dn!r}")

    # 关系：名称/显示名规则 + 基数白名单
    allowed = {"one-to-one", "one-to-many", "many-to-one"}
    link_dn = set()
    for link in doc["link_types"]:
        lw = f"关系 {link['name']}"
        check_len(link["name"], 64, lw, "name")
        if not LINK_IDENT.fullmatch(link["name"]):
            problems.append(f"{lw}.name 只允许字母/数字/下划线/连字符")
        check_len(link["display_name"] or link["name"], 128, lw, "display_name")
        if link["display_name"] in link_dn:
            problems.append(f"关系显示名重复: {link['display_name']}")
        link_dn.add(link["display_name"])
        if link["cardinality"] not in allowed:
            problems.append(f"{lw} 基数 {link['cardinality']} 不在 {sorted(allowed)}")
    notes.append(f"平台规则镜像: 主键 {sum(1 for o in doc['object_types'] if any(p.get('primary_key') for p in o['properties']))}"
                 f"/{len(doc['object_types'])} 个对象已配置 primary_key")

    # 与上一版快照比对（只报告，不判错）
    if SNAPSHOT.exists():
        old = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
        new = {}
        for oname, o in objects.items():
            fm = o["data_source"]["field_mapping"]
            for p in o["properties"]:
                new[p["name"]] = (oname, fm.get(p["name"]), p["description"], p["data_type"])
        changed = []
        for name in sorted(new):
            oname, mp, desc, dt = new[name]
            o = old.get(name)
            if o is None:
                changed.append(f"+ 新增 {name}（{oname}）")
                continue
            d = []
            if o["obj"] != oname:
                d.append(f"对象 {o['obj']}→{oname}")
            if o["map"] != mp:
                d.append(f"映射 {o['map']}→{mp}")
            if o["desc"] != desc:
                d.append("描述更新")
            if o["type"] != dt:
                d.append(f"类型 {o['type']}→{dt}")
            if d:
                changed.append(f"~ {name}: " + "; ".join(d))
        removed = [n for n in old if n not in new]
        notes.append(f"与上一版比对: {len(changed)} 项变化, {len(removed)} 项移除")
        for c in changed:
            notes.append("   " + c)
        for r in sorted(removed):
            notes.append(f"   - 移除 {r}（原 {old[r]['obj']}）")

    print("== 校验 ==")
    for n in notes:
        print(f"  · {n}")
    if problems:
        print(f"\n失败：{len(problems)} 项")
        for p in problems:
            print(f"  x {p}")
        return 1
    print("\n通过：对象归属、列覆盖唯一性、类型/可空性、补充列标注、关系引用均一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
