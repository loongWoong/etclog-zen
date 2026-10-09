#!/usr/bin/env python3
"""merge_vehicle_logs_es.py —— merge_vehicle_logs.py 的 Elasticsearch 版本。

与原脚本的区别只有一个：日志来源。原脚本扫描本地 ``*.log`` 目录，
本脚本改为从 Elasticsearch 拉取 ``message`` 字段（就是原始日志行），
其余部分（明文车牌防污染、关联键多轮扩展、线圈物理事件补齐、Markdown 输出格式）
全部复用 ``merge_vehicle_logs.py`` 里的函数，因此生成的 ``merged_*.md``
可以直接喂给 ``replay/generate_replay_data.py`` 做 3D 回放。

实测环境：Elasticsearch 7.17.0，索引形如 ``ump_<站点>_<yyyy.MM>``，
字段含义：

    message      完整原始日志行，形如 "[2026-07-01 12:06:54.640] [370164335F] [INFO] ..."
    time         本地时间字符串 "2026-07-01 12:06:54.640"
    @timestamp   UTC 时间，date 类型，用于范围过滤与排序
    logType      laneLog / etc / mtc / data / fee / namelist（对应原脚本的 file_kind）
    landId       车道号，如 3701643319
    vlp          车牌（text + keyword 子字段）

查询策略（重要）：
    ES 的 ``message`` 字段是 text 类型、按 token 检索，而原脚本是子串匹配。
    两者并不等价，例如 ``鲁UG6595`` 与 token ``ug6595_1``（带车牌颜色后缀）:
    ``match_phrase`` 匹配不到，前缀通配 ``ug6595*`` 才能匹配到。
    所以本脚本把 ES 查询当作"高召回候选集"，再用原脚本的
    ``line_matches`` 做权威子串过滤——查询多召回一些没有代价，漏召回才是问题。
    默认查询 = 每个 key 的 match_phrase + 前缀通配；再叠加一次"已发现车道的全量重扫"，
    用来兜住 token 边界的漏召回。若需要与原脚本 100% 等价的语义，用
    ``--full-window-scan``（把整个时间窗的日志全部拉下来在本地做子串匹配）。

用法示例见文件末尾或 README。
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import importlib.util
import json
import re
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path


# ---------------------------------------------------------------------------
# 复用 merge_vehicle_logs.py 的解析核心
# ---------------------------------------------------------------------------
def _load_core():
    here = Path(__file__).resolve().parent
    if str(here) not in sys.path:
        sys.path.insert(0, str(here))
    try:
        import merge_vehicle_logs as core  # type: ignore

        return core
    except ImportError:
        path = here / "merge_vehicle_logs.py"
        if not path.exists():
            raise SystemExit(f"找不到解析核心: {path}")
        spec = importlib.util.spec_from_file_location("merge_vehicle_logs", path)
        module = importlib.util.module_from_spec(spec)
        sys.modules["merge_vehicle_logs"] = module
        spec.loader.exec_module(module)
        return module


core = _load_core()

for _stream in (sys.stdout, sys.stderr):
    try:  # Windows 控制台默认 GBK，输出中文/车牌会炸，这里统一成 UTF-8
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass


DEFAULT_ES_HOST = "http://192.168.22.212:9200"
DEFAULT_INDEX = "ump_*"
DETECTOR_MARKERS = list(core.DETECTOR_LINE_MARKERS)
ASCII_RUN_RE = re.compile(r"[0-9A-Za-z_]{6,}")
WILDCARD_ESCAPE_RE = re.compile(r"([*?\\])")
MONTH_RE = re.compile(r"\d{4}\.\d{2}")
PIT_KEEP_ALIVE = "5m"
MAX_CLAUSES_PER_BATCH = 256  # 每个 bool.should 承载的 key 数量上限（ES max_clause_count 默认 1024）


# ---------------------------------------------------------------------------
# 时间与工具函数
# ---------------------------------------------------------------------------
def parse_datetime(value: str) -> dt.datetime:
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M"):
        try:
            return dt.datetime.strptime(value, fmt)
        except ValueError:
            pass
    raise argparse.ArgumentTypeError(f"invalid datetime: {value!r}")


def resolve_timezone(spec: str | None) -> dt.tzinfo:
    if not spec:
        return dt.datetime.now().astimezone().tzinfo or dt.timezone.utc
    text = spec.strip()
    if text.upper() in {"UTC", "Z", "GMT"}:
        return dt.timezone.utc
    match = re.fullmatch(r"([+-])(\d{1,2})(?::?(\d{2}))?", text)
    if match:
        sign = 1 if match.group(1) == "+" else -1
        minutes = int(match.group(3) or 0)
        return dt.timezone(sign * dt.timedelta(hours=int(match.group(2)), minutes=minutes))
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(text)
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"无法识别的 --timezone {spec!r}: {exc}") from exc


def to_utc_iso(local_time: dt.datetime, tz: dt.tzinfo) -> str:
    aware = local_time if local_time.tzinfo else local_time.replace(tzinfo=tz)
    return aware.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def from_es_timestamp(value: str, tz: dt.tzinfo) -> dt.datetime | None:
    """@timestamp（UTC ISO）-> 本地 naive 时间。"""
    if not isinstance(value, str) or not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(tz).replace(tzinfo=None)


def parse_time_field(value: str, default_year: int | None) -> dt.datetime | None:
    """解析 time 字段（可能没有年份，例如 "10-10 16:09:04.824"）。"""
    if not isinstance(value, str) or not value:
        return None
    text = value.strip()
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
        try:
            return dt.datetime.strptime(text, fmt)
        except ValueError:
            pass
    if default_year:
        for fmt in ("%m-%d %H:%M:%S.%f", "%m-%d %H:%M:%S"):
            try:
                parsed = dt.datetime.strptime(text, fmt)
                return parsed.replace(year=default_year)
            except ValueError:
                pass
    return None


def first_str(src: dict, names) -> str | None:
    for name in names:
        value = src.get(name)
        if isinstance(value, str) and value.strip():
            return value
        if isinstance(value, (list, tuple)) and value:
            return " ".join(str(item) for item in value)
    return None


def wildcard_prefix_for(key: str) -> str | None:
    """取 key 里最长的 ASCII 串作为前缀通配，用来兜住 token 后缀变体。

    例：``鲁UG6595`` -> ``ug6595``，于是 ``鲁UG6595_1``（token: ug6595_1）也能被命中。
    """
    runs = ASCII_RUN_RE.findall(key)
    if not runs:
        return None
    best = max(runs, key=len).strip("_")
    if len(best) < 6:
        return None
    return WILDCARD_ESCAPE_RE.sub(r"\\\1", best.lower())


# ---------------------------------------------------------------------------
# ES 客户端
# ---------------------------------------------------------------------------
class EsError(RuntimeError):
    pass


class EsClient:
    def __init__(self, host, timeout=60.0, username=None, password=None, verify_tls=True, verbose=False):
        self.host = host.rstrip("/")
        self.timeout = timeout
        self.verbose = verbose
        self._auth = None
        if username:
            token = base64.b64encode(f"{username}:{password or ''}".encode("utf-8")).decode("ascii")
            self._auth = f"Basic {token}"
        self._ssl_context = None
        if self.host.startswith("https") and not verify_tls:
            self._ssl_context = ssl._create_unverified_context()
        self.request_count = 0
        self.bytes_read = 0
        self._pit: str | None = None
        self._pit_index: str | None = None
        self.pit_unavailable = False

    # -- 低层请求 ---------------------------------------------------------
    def request(self, method: str, path: str, body=None, timeout: float | None = None):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        req = urllib.request.Request(f"{self.host}{path}", data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if self._auth:
            req.add_header("Authorization", self._auth)
        try:
            with urllib.request.urlopen(
                req, timeout=timeout or self.timeout, context=self._ssl_context
            ) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:1200]
            raise EsError(f"{method} {path} -> HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise EsError(
                f"{method} {path} -> 连接失败: {exc.reason}\n"
                f"    检查 ES 地址是否可达（{self.host}）、是否需要 VPN、防火墙是否放行。"
            ) from exc
        except OSError as exc:
            # urllib 只把 h.request() 阶段的失败包成 URLError；getresponse()/read() 阶段的
            # 超时（socket.timeout 在 3.10+ 就是 TimeoutError）会以 OSError 原样抛出。
            # 不兜住的话，合并跑到一半（或连接慢时的 client.info()）会直接吐 traceback。
            raise EsError(
                f"{method} {path} -> 请求失败: {exc}\n"
                f"    检查 ES 地址是否可达（{self.host}）、网络是否稳定，或调大 --timeout。"
            ) from exc
        finally:
            self.request_count += 1
        self.bytes_read += len(raw)
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise EsError(f"{method} {path} -> 响应不是合法 JSON: {raw[:300]!r}") from exc

    def info(self) -> dict:
        return self.request("GET", "/")

    # -- 索引发现 ---------------------------------------------------------
    def list_indices(self, pattern: str) -> list[dict]:
        quoted = urllib.parse.quote(pattern, safe="*,-_.")
        rows = self.request("GET", f"/_cat/indices/{quoted}?h=index,docs.count,store.size&format=json&s=index")
        if not isinstance(rows, list):
            return []
        result = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            try:
                docs = int(row.get("docs.count") or 0)
            except (TypeError, ValueError):
                docs = 0
            result.append({"index": row.get("index", ""), "docs": docs, "size": row.get("store.size") or "-"})
        return result

    # -- PIT / 分页 -------------------------------------------------------
    def _open_pit(self, index: str) -> str | None:
        if self.pit_unavailable:
            return None
        if self._pit and self._pit_index == index:
            return self._pit
        if self._pit:
            self.close_pit()
        try:
            response = self.request("POST", f"/{urllib.parse.quote(index, safe='*,-_.')}/_pit?keep_alive={PIT_KEEP_ALIVE}")
            self._pit = response.get("id")
            self._pit_index = index
            return self._pit
        except EsError as exc:
            self.pit_unavailable = True
            self._log(f"[es] PIT 不可用，退回 from/size 分页（单次最多 10000 条）: {exc}")
            return None

    def close_pit(self):
        if self._pit:
            try:
                self.request("DELETE", "/_pit", {"id": self._pit})
            except EsError:
                pass
            self._pit = None
            self._pit_index = None

    def _log(self, message: str):
        print(message, file=sys.stderr)

    def search_all(self, index, query, source_fields, sort_field, page_size, max_docs, stats=None):
        """按 search_after 拉取全部命中（优先 PIT，避免 10000 条上限）。"""
        hits: list[dict] = []
        pit = self._open_pit(index)
        search_after = None
        truncated = False
        total: int | None = None
        pit_reopens = 0
        fallback_window = False
        while True:
            size = min(page_size, max_docs - len(hits))
            if size <= 0:
                truncated = True
                break
            body = {
                "size": size,
                "query": query,
                "_source": source_fields,
                # 只在第一页统计总数：用来精确判断是否真的被 --max-docs 截断，
                # 避免"命中数刚好等于 --max-docs"时误报截断。
                "track_total_hits": total is None,
            }
            if pit:
                body["pit"] = {"id": pit, "keep_alive": PIT_KEEP_ALIVE}
                body["sort"] = [{sort_field: "asc"}, {"_shard_doc": "asc"}]
            else:
                # from/size 深分页必须带唯一 tiebreaker，否则同一毫秒的文档之间顺序
                # 不稳定，会出现重复行/漏行（重复会被去重吃掉，漏行是静默的）。
                body["sort"] = [{sort_field: "asc"}, {"_doc": "asc"}]
                body["from"] = len(hits)
            if search_after:
                body["search_after"] = search_after
            try:
                response = self.request("POST", "/_search" if pit else f"/{index}/_search", body)
            except EsError:
                # PIT 过期时重开。search_after 游标只对原来那个 PIT 有效，跨 PIT
                # 复用会停在错误的相对位置上而静默漏文档，所以游标和已累计页都要重置，
                # 从新 PIT 的开头重拉（重复结果由调用方的 (_index,_id) 去重兜住）。
                if pit and pit_reopens < 2:
                    pit_reopens += 1
                    self.close_pit()
                    pit = self._open_pit(index)
                    search_after = None
                    hits.clear()
                    continue
                raise
            page = response.get("hits", {}).get("hits", []) or []
            if total is None:
                raw_total = response.get("hits", {}).get("total")
                if isinstance(raw_total, dict) and isinstance(raw_total.get("value"), int):
                    total = raw_total["value"]
            hits.extend(page)
            if stats is not None:
                stats["pages"] = stats.get("pages", 0) + 1
            if self.verbose:
                suffix = f" / 共 {total}" if total is not None else ""
                self._log(f"[es] 已拉取 {len(hits)} 条{suffix} ...")
            if total is not None and len(hits) >= total:
                break
            if len(page) < size:
                break
            if pit:
                search_after = page[-1].get("sort")
            elif len(hits) + size > 10000:
                # from/size 的结果窗口上限就是 10000 条，跟 --max-docs 无关
                fallback_window = True
                break
        if total is not None:
            truncated = len(hits) < total
        if fallback_window:
            truncated = True
        if stats is not None:
            stats["total"] = total
        if truncated:
            reasons = []
            if fallback_window:
                reasons.append("PIT 不可用时 from/size 单次最多返回 10000 条")
            if total is not None and len(hits) < total:
                reasons.append(f"命中总数 {total} 条，超过 --max-docs={max_docs}")
            detail = "；".join(reasons) or f"已到 --max-docs={max_docs} / --page-size={page_size} 上限"
            self._log(f"[es] 警告：结果被截断（{detail}），请缩小窗口或调大上限。")
        return hits, truncated


# ---------------------------------------------------------------------------
# 日志行
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class EsLine:
    """与 core.LogLine 字段兼容，另外带上 ES 侧信息。

    path 是虚拟路径：把车道号塞进文件名，这样 core.line_lane(path, text) 也
    能找到车道；kind 直接用 logType 字段，不必再从文件名猜。
    """

    ts: dt.datetime
    path: Path
    line_no: int
    text: str
    kind: str
    index: str
    doc_id: str
    lane: str | None = None

    @property
    def key(self) -> tuple[str, str]:
        return (self.index, self.doc_id)

    @property
    def source_label(self) -> str:
        return f"{self.kind or 'log'}:{self.index}#{self.doc_id}"


# ---------------------------------------------------------------------------
# 查询构造 + 拉取
# ---------------------------------------------------------------------------
class EsFetcher:
    def __init__(self, client: EsClient, args, tz: dt.tzinfo, index: str):
        self.client = client
        self.args = args
        self.tz = tz
        self.index = index
        self.message_fields = [item.strip() for item in args.message_field.split(",") if item.strip()]
        if not self.message_fields:
            raise SystemExit("--message-field 不能为空，例如 --message-field 'message,msg'")
        self.query_field = self.message_fields[0]
        try:
            self._lane_re = re.compile(args.lane_regex) if args.lane_regex else None
        except re.error as exc:
            raise SystemExit(f"--lane-regex 不是合法正则: {exc}") from exc
        self.source_fields = self._source_fields()
        self.stats: dict = {"pages": 0, "docs": 0, "queries": 0, "bytes": 0, "total": None}
        self._seen: dict[tuple[str, str], EsLine] = {}
        self._key_docs: dict[tuple[str, str], EsLine] = {}
        self._queried_keys: set[str] = set()
        self._lane_docs: dict[tuple[str, str], EsLine] = {}
        self._lane_scanned: set[str] = set()
        self._time_scan_done = False
        self._time_scan_window: tuple = (None, None)
        self._time_docs: list[EsLine] = []
        self._default_year: int | None = None
        self.truncated = False

    # -- 字段名 -----------------------------------------------------------
    def _source_fields(self) -> list[str]:
        fields = list(self.message_fields)
        for name in (self.args.time_field, self.args.kind_field, self.args.lane_field, "time", "landId"):
            base = name.split(".")[0]
            if base and base not in fields:
                fields.append(base)
        return fields

    def _lane_query_field(self) -> str:
        field_name = self.args.lane_field
        return field_name if "." in field_name else f"{field_name}.keyword"

    def _kind_query_field(self) -> str:
        field_name = self.args.kind_field
        return field_name if "." in field_name else f"{field_name}.keyword"

    def _lane_source_field(self) -> str:
        return self.args.lane_field.split(".")[0]

    # -- 时间过滤 ---------------------------------------------------------
    def _time_filter(self, start: dt.datetime | None, end: dt.datetime | None) -> list[dict]:
        if start is None or end is None:
            return []
        return [
            {
                "range": {
                    self.args.time_field: {
                        "gte": to_utc_iso(start, self.tz),
                        "lte": to_utc_iso(end, self.tz),
                    }
                }
            }
        ]

    def _extra_filters(self) -> list[dict]:
        filters = []
        if self.args.log_type:
            filters.append({"terms": {self._kind_query_field(): list(self.args.log_type)}})
        if self.args.extra_query:
            try:
                filters.append(json.loads(self.args.extra_query))
            except json.JSONDecodeError as exc:
                raise SystemExit(f"--extra-query 不是合法 JSON: {exc}") from exc
        return filters

    def _build_query(self, should: list[dict] | None, filters: list[dict]) -> dict:
        if should:
            return {"bool": {"should": should, "minimum_should_match": 1, "filter": filters}}
        if filters:
            return {"bool": {"filter": filters}}
        return {"match_all": {}}

    # -- 行构造 -----------------------------------------------------------
    def _line_from_hit(self, hit: dict) -> EsLine | None:
        src = hit.get("_source") or {}
        text = first_str(src, self.message_fields)
        if not text:
            return None
        index = hit.get("_index", self.index)
        doc_id = hit.get("_id", "")
        ts = core.parse_ts(text)
        if ts is None:
            ts = parse_time_field(src.get(self.args.time_field.split(".")[0]), self._default_year)
        if ts is None and self.args.time_field in src:
            ts = from_es_timestamp(src.get(self.args.time_field), self.tz)
        if ts is None:
            ts = parse_time_field(src.get("time"), self._default_year)
        if ts is None:
            ts = from_es_timestamp(src.get("@timestamp", ""), self.tz)
        if ts is None:
            return None
        # 没有年份的时间（例如 "10-10 16:09:04.824"）用 @timestamp 兜底校正年份
        fallback = from_es_timestamp(src.get("@timestamp", ""), self.tz)
        if fallback and abs((ts - fallback).total_seconds()) > 300 * 86400:
            ts = fallback

        lane = None
        raw_lane = src.get(self._lane_source_field())
        if isinstance(raw_lane, str) and self._lane_re:
            candidate = raw_lane.strip()
            if self._lane_re.fullmatch(candidate):
                lane = candidate
        if lane is None:
            match = core.LANE_RE.search(text)
            if match:
                lane = match.group(0)

        kind = first_str(src, [self.args.kind_field]) or ""
        virtual = f"{kind or 'log'}_{lane or 'noLane'}_{index}#{doc_id}"
        return EsLine(
            ts=ts,
            path=Path(virtual),
            line_no=0,
            text=text,
            kind=kind,
            index=index,
            doc_id=doc_id,
            lane=lane,
        )

    # -- 检索入口 ---------------------------------------------------------
    def _collect(self, hits, store: dict | None) -> list[EsLine]:
        """把命中转成 EsLine；_seen 记录本次运行拉取过的唯一文档数（用于统计）。"""
        lines = []
        for hit in hits:
            key = (hit.get("_index", self.index), hit.get("_id", ""))
            line = self._seen.get(key)
            if line is None:
                line = self._line_from_hit(hit)
                if line is None:
                    continue
                self._seen[key] = line
            if store is not None:
                store[key] = line
            lines.append(line)
        self.stats["docs"] = len(self._seen)
        return lines

    def _set_window(self, start, end):
        reference = start or end
        self._default_year = reference.year if reference else None

    def key_candidates(self, keys, start: dt.datetime | None, end: dt.datetime | None) -> list[EsLine]:
        """按 key 拉取候选（只查询还没查过的 key），返回累计候选集合。"""
        self._set_window(start, end)
        # 注意：pending 在请求前就记入 _queried_keys，所以若某次检索被 --max-docs 截断，
        # 这些 key 不会在后续轮次重查（同一查询重查也会同样被截断）。需要完整结果时
        # 请调大 --max-docs 或改用 --full-window-scan。
        pending = sorted({key for key in keys if key and key not in self._queried_keys})
        if pending:
            self._queried_keys.update(pending)
            filters = self._time_filter(start, end) + self._extra_filters()
            for offset in range(0, len(pending), MAX_CLAUSES_PER_BATCH):
                batch = pending[offset : offset + MAX_CLAUSES_PER_BATCH]
                should = []
                for key in batch:
                    should.append({"match_phrase": {self.query_field: key}})
                    prefix = wildcard_prefix_for(key)
                    if prefix:
                        should.append({"wildcard": {self.query_field: f"{prefix}*"}})
                query = self._build_query(should, filters)
                if self.args.verbose:
                    print(f"[es] key 批次 {len(batch)} 个 key，{len(should)} 个 should 子句", file=sys.stderr)
                hits, truncated = self.client.search_all(
                    self.index,
                    query,
                    self.source_fields,
                    self.args.time_field,
                    self.args.page_size,
                    self.args.max_docs,
                    self.stats,
                )
                self.truncated = self.truncated or truncated
                self.stats["queries"] = self.stats.get("queries", 0) + 1
                self._collect(hits, self._key_docs)
        return list(self._key_docs.values())

    def lane_candidates(self, lanes, start, end, detector_only: bool) -> list[EsLine]:
        """按车道拉取日志（一次拉全量，同时服务"车道重扫"与"线圈补齐"两件事）。"""
        self._set_window(start, end)
        wanted = sorted({lane for lane in lanes if lane})
        fresh = [lane for lane in wanted if lane not in self._lane_scanned]
        if fresh:
            self._lane_scanned.update(fresh)
            filters = self._time_filter(start, end) + self._extra_filters()
            # 车道过滤 = landId 字段精确匹配 OR 正文里出现该车道号。
            # 加正文这一路很关键：像 "接收到消息-FFFF0002...3701084323005665..." 这类原始帧日志
            # 的 landId 字段是空的，而里面的身份证号/卡号又被拼进了一整条长 token，
            # 任何 token 级检索都命中不了；但它们的正文里有 [370164335F] 这个独立 token，
            # 所以能靠车道号把它们捞起来，再交给本地子串匹配。
            lane_should = [{"terms": {self._lane_query_field(): fresh}}]
            lane_should.extend({"match_phrase": {self.query_field: lane}} for lane in fresh)
            filters.append({"bool": {"should": lane_should, "minimum_should_match": 1}})
            should = None
            if detector_only:
                should = [{"match_phrase": {self.query_field: marker}} for marker in DETECTOR_MARKERS]
            query = self._build_query(should, filters)
            hits, truncated = self.client.search_all(
                self.index,
                query,
                self.source_fields,
                self.args.time_field,
                self.args.page_size,
                self.args.max_docs,
                self.stats,
            )
            self.truncated = self.truncated or truncated
            self.stats["queries"] = self.stats.get("queries", 0) + 1
            self._collect(hits, self._lane_docs)
        return [line for line in self._lane_docs.values() if line.lane in wanted]

    def time_window_docs(self, start, end) -> list[EsLine]:
        """整窗全量拉取（--full-window-scan / 发现模式）。"""
        self._set_window(start, end)
        if not self._time_scan_done or self._time_scan_window != (start, end):
            filters = self._time_filter(start, end) + self._extra_filters()
            query = self._build_query(None, filters)
            hits, truncated = self.client.search_all(
                self.index,
                query,
                self.source_fields,
                self.args.time_field,
                self.args.page_size,
                self.args.max_docs,
                self.stats,
            )
            self.truncated = self.truncated or truncated
            self.stats["queries"] = self.stats.get("queries", 0) + 1
            self._time_docs = self._collect(hits, None)
            self._time_scan_done = True
            self._time_scan_window = (start, end)
        return list(self._time_docs)

    # -- 车牌聚合发现 -----------------------------------------------------
    def plates_by_aggregation(self, start, end, size, min_count) -> list[str] | None:
        if not self.args.plate_field:
            return None
        body = {
            "size": 0,
            "query": self._build_query(None, self._time_filter(start, end) + self._extra_filters()),
            "aggs": {"veh": {"terms": {"field": self.args.plate_field, "size": size, "min_doc_count": min_count}}},
        }
        try:
            response = self.client.request("POST", f"/{self.index}/_search", body)
        except EsError as exc:
            print(f"[es] 车牌聚合不可用（{self.args.plate_field}）: {exc}", file=sys.stderr)
            return None
        buckets = response.get("aggregations", {}).get("veh", {}).get("buckets", []) or []
        plates = []
        for bucket in buckets:
            value = str(bucket.get("key", "")).strip()
            base = core.normalize_plate(value)
            if not base or base[0] not in core.PLATE_PREFIXES:
                continue
            if base not in plates:
                plates.append(base)
        return plates


# ---------------------------------------------------------------------------
# 线圈事件（用 ES 的车道字段，不依赖原脚本写死的 37016433 前缀）
# ---------------------------------------------------------------------------
def detector_transition_es(line: EsLine):
    if not line.lane:
        return None
    match = core.COIL_TRANSITION_RE.search(line.text)
    if match:
        coil_id, state = match.groups()
        return core.CoilTransition(item=line, lane=line.lane, coil_id=coil_id, active=state == "true")
    match = core.DETECTOR_RE.search(line.text)
    if match:
        coil_id, state = match.groups()
        return core.CoilTransition(item=line, lane=line.lane, coil_id=coil_id, active=state == "有信号")
    return None


def coil_passages_es(detector_lines: list[EsLine]) -> list:
    """与 core.coil_passages 同一套算法，只是车道取自 ES 字段。"""
    transitions_by_lane: dict[str, list] = {}
    seen = set()
    for line in detector_lines:
        transition = detector_transition_es(line)
        if transition is None:
            continue
        key = (transition.lane, transition.coil_id, transition.active, transition.item.ts)
        if key in seen:
            continue
        seen.add(key)
        transitions_by_lane.setdefault(transition.lane, []).append(transition)

    passages = []
    for lane, transitions in transitions_by_lane.items():
        transitions.sort(key=lambda item: (item.item.ts, item.coil_id))
        active_coils: set[str] = set()
        current: list = []
        for transition in transitions:
            if not current and transition.active:
                current = [transition]
                active_coils.add(transition.coil_id)
                continue
            if not current:
                continue
            current.append(transition)
            if transition.active:
                active_coils.add(transition.coil_id)
            else:
                active_coils.discard(transition.coil_id)
            if not active_coils:
                passages.append(
                    core.CoilPassage(
                        lane=lane,
                        start=current[0].item.ts,
                        end=current[-1].item.ts,
                        transitions=list(current),
                    )
                )
                current = []
        if current:
            passages.append(
                core.CoilPassage(
                    lane=lane,
                    start=current[0].item.ts,
                    end=current[-1].item.ts,
                    transitions=list(current),
                )
            )
    return passages


def enrich_with_detector_lines_es(detector_lines, matches, around, window) -> list[EsLine]:
    lanes = {line.lane for line in matches if line.lane}
    if not lanes:
        return []
    if around:
        anchor = around
    elif matches:
        anchor = sorted(matches, key=lambda item: item.ts)[len(matches) // 2].ts
    else:
        return []

    start, end = anchor - window, anchor + window
    windowed = [line for line in detector_lines if line.lane in lanes and start <= line.ts <= end]
    passages = core.select_physical_passages(coil_passages_es(windowed), lanes, anchor)
    if not passages:
        return []

    selected: list[EsLine] = []
    for passage in passages:
        low = passage.start - dt.timedelta(milliseconds=2)
        high = passage.end + dt.timedelta(milliseconds=2)
        for line in windowed:
            if line.lane == passage.lane and low <= line.ts <= high:
                selected.append(line)
    return selected


# ---------------------------------------------------------------------------
# 归并主流程
# ---------------------------------------------------------------------------
@dataclass
class MergeResult:
    matches: list[EsLine]
    keys: set[str]
    stats: dict = field(default_factory=dict)
    truncated: bool = False


def merge_vehicle_es(fetcher: EsFetcher, vehicle, around, window, max_rounds, start, end, lane_scan=True):
    """与 core.merge_vehicle 等价，只是把"读文件"换成"从 ES 取候选"。"""
    keys = {vehicle, f"{vehicle}_0"}
    collected: dict[tuple[str, str], EsLine] = {}

    if fetcher.args.full_window_scan:
        # 严格等价模式：整窗全量拉取后在本地做子串匹配
        window_lines = fetcher.time_window_docs(start, end)
        for _ in range(max_rounds):
            new_keys: set[str] = set()
            for line in window_lines:
                if not core.line_matches(line.text, keys, vehicle):
                    continue
                collected[line.key] = line
                new_keys.update(core.extract_keys(line.text, vehicle, expandable_only=True))
            before = len(keys)
            keys.update(key for key in new_keys if core.should_keep_value(key))
            if len(keys) == before:
                break
        detector_lines = [line for line in window_lines if core.is_detector_line(line.text)]
        for line in enrich_with_detector_lines_es(detector_lines, list(collected.values()), around, window):
            collected[line.key] = line
        return MergeResult(_sorted_lines(collected.values()), keys, dict(fetcher.stats), fetcher.truncated)

    for round_no in range(1, max_rounds + 1):
        candidates = fetcher.key_candidates(keys, start, end)
        new_keys: set[str] = set()
        for line in candidates:
            if not core.line_matches(line.text, keys, vehicle):
                continue
            collected[line.key] = line
            new_keys.update(core.extract_keys(line.text, vehicle, expandable_only=True))
        before = len(keys)
        keys.update(key for key in new_keys if core.should_keep_value(key))
        if fetcher.args.verbose:
            print(
                f"[merge] 第 {round_no} 轮：候选 {len(candidates)} 条，命中 {len(collected)} 条，key {before} -> {len(keys)}",
                file=sys.stderr,
            )
        if len(keys) == before:
            break

    lanes = {line.lane for line in collected.values() if line.lane}
    detector_lines: list[EsLine] = []
    if lanes:
        lane_docs = fetcher.lane_candidates(lanes, start, end, detector_only=not lane_scan)
        if lane_scan:
            # 车道重扫：同车道同窗口的全量日志再按权威子串规则过一遍，兜住 token 边界漏召回
            for line in lane_docs:
                if core.line_matches(line.text, keys, vehicle):
                    collected[line.key] = line
        detector_lines = [line for line in lane_docs if core.is_detector_line(line.text)]

    for line in enrich_with_detector_lines_es(detector_lines, list(collected.values()), around, window):
        collected[line.key] = line

    return MergeResult(_sorted_lines(collected.values()), keys, dict(fetcher.stats), fetcher.truncated)


def _sorted_lines(lines) -> list[EsLine]:
    return sorted(lines, key=lambda item: (item.ts, item.index, item.doc_id))


def summarize_lines(lines, vehicle) -> str:
    lanes = {line.lane for line in lines if line.lane}
    kinds = {line.kind for line in lines if line.kind}
    start = lines[0].ts.strftime("%Y-%m-%d %H:%M:%S")
    end = lines[-1].ts.strftime("%Y-%m-%d %H:%M:%S")
    lane_text = ", ".join(sorted(lanes)) if lanes else "-"
    kind_text = ", ".join(sorted(kinds)) if kinds else "-"
    return f"{vehicle} | {start} ~ {end} | lines={len(lines)} | lanes={lane_text} | sources={kind_text}"


def cluster_by_gap(lines, gap: dt.timedelta) -> list[list[EsLine]]:
    ordered = sorted(lines, key=lambda item: (item.ts, item.index, item.doc_id))
    clusters: list[list[EsLine]] = []
    for line in ordered:
        if not clusters or line.ts - clusters[-1][-1].ts > gap:
            clusters.append([line])
        else:
            clusters[-1].append(line)
    return clusters


def write_markdown_es(out, *, vehicle, args, index_expr, around, window, result: MergeResult, scanned: int):
    print(f"# Vehicle Log Merge: {vehicle}", file=out)
    print("", file=out)
    print(f"- source: `elasticsearch`", file=out)
    print(f"- es_host: `{args.es_host}`", file=out)
    print(f"- index: `{index_expr}`", file=out)
    if around:
        print(f"- time_window: `{around - window}` ~ `{around + window}`", file=out)
    else:
        print("- time_window: full index", file=out)
    print(f"- matched_lines: {len(result.matches)}", file=out)
    print(f"- extracted_keys: {len(result.keys)}", file=out)
    print(f"- es_docs_scanned: {scanned}", file=out)
    print(f"- es_requests: {result.stats.get('queries', 0)}", file=out)
    if result.truncated:
        total = result.stats.get("total")
        detail = f"命中总数 {total} 条超过 --max-docs={args.max_docs}" if total else "命中数超过 --max-docs"
        print(f"- es_truncated: `true`（{detail}，结果可能不完整）", file=out)
    print("", file=out)
    print("## Keys", file=out)
    print("", file=out)
    for key in sorted(result.keys):
        print(f"- `{key}`", file=out)
    print("", file=out)
    print("## Timeline", file=out)
    print("", file=out)

    for index, line in enumerate(result.matches):
        print(f"### {line.ts.strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]} `{line.source_label}`", file=out)
        print("", file=out)
        print("```text", file=out)
        print(line.text.rstrip(), file=out)
        print("```", file=out)
        if index < len(result.matches) - 1:
            print("", file=out)


# ---------------------------------------------------------------------------
# 时间范围 / 索引解析
# ---------------------------------------------------------------------------
def resolve_range(args, tz):
    window = dt.timedelta(minutes=args.window_minutes)
    if args.from_time or args.to_time:
        if not (args.from_time and args.to_time):
            raise SystemExit("--from 与 --to 必须同时提供")
        if args.to_time <= args.from_time:
            raise SystemExit("--to 必须晚于 --from")
        notes = []
        if args.at:
            notes.append("--at 被忽略")
        if args.window_minutes != 5:
            notes.append("--window-minutes 无效（窗口由 --from/--to 决定）")
        if notes:
            print(f"[es] 提示：使用 --from/--to 时 {'；'.join(notes)}。", file=sys.stderr)
        start, end = args.from_time, args.to_time
        return start + (end - start) / 2, (end - start) / 2, start, end
    if args.at:
        return args.at, window, args.at - window, args.at + window
    return None, None, None, None


def resolve_index(client: EsClient, args, start, end, verbose=False) -> tuple[str, list[dict]]:
    rows = client.list_indices(args.index)
    if not rows:
        raise SystemExit(
            f"索引模式 {args.index!r} 没有匹配到任何索引。\n"
            f"    用 --list-indices 看看有哪些索引，例如：--index 'ump_37016433_2026.07'"
        )
    alive = [row for row in rows if row["docs"] > 0 and "_test_" not in row["index"]]
    if not alive:
        alive = [row for row in rows if "_test_" not in row["index"]]
    if not alive:
        alive = rows

    if not args.no_auto_index and start is not None and end is not None:
        months = set()
        cursor = start.replace(day=1)
        while cursor <= end:
            months.add(cursor.strftime("%Y.%m"))
            cursor = (cursor.replace(day=1) + dt.timedelta(days=32)).replace(day=1)
        selected = [row for row in alive if not MONTH_RE.search(row["index"]) or MONTH_RE.search(row["index"]).group(0) in months]
        if selected:
            alive = selected
        elif verbose:
            print(f"[es] 按月裁剪没有命中（目标月份 {sorted(months)}），改用全部匹配索引", file=sys.stderr)

    names = sorted(row["index"] for row in alive)
    if len(names) == 1:
        return names[0], alive
    return ",".join(names), alive


def list_indices_report(client: EsClient, args, start, end):
    rows = client.list_indices(args.index)
    if not rows:
        print(f"索引模式 {args.index!r} 没有匹配到任何索引")
        return 1
    print(f"索引模式 {args.index!r} 命中 {len(rows)} 个索引：")
    for row in rows:
        print(f"  {row['index']:<46} docs={row['docs']:<10} size={row['size']}")
    if start is not None:
        print(f"\n按时间窗 {start} ~ {end} 自动裁剪后会查询：")
        index_expr, chosen = resolve_index(client, args, start, end, verbose=True)
        for row in chosen:
            print(f"  {row['index']}")
        print(f"\nindex 表达式: {index_expr}")
    return 0


# ---------------------------------------------------------------------------
# 发现模式
# ---------------------------------------------------------------------------
def discover_plates(fetcher: EsFetcher, args, start, end, gap) -> list[tuple[str, list[EsLine]]]:
    """返回 [(车牌, 该车牌在本窗口内的日志行)]。优先用 vlp 聚合，失败则整窗扫描。"""
    plates = fetcher.plates_by_aggregation(start, end, max(args.limit or 50, 50), max(1, args.min_lines))
    lines_by_plate: dict[str, list[EsLine]] = {}
    if plates:
        for plate in plates[: args.limit] if args.limit else plates:
            candidates = fetcher.key_candidates({plate, f"{plate}_0"}, start, end)
            matched = [line for line in candidates if core.line_matches(line.text, {plate, f"{plate}_0"}, plate)]
            if len(matched) >= max(1, args.min_lines):
                lines_by_plate[plate] = matched
    else:
        print("[es] 退化为整窗扫描发现车牌（较慢）", file=sys.stderr)
        for line in fetcher.time_window_docs(start, end):
            for plate in core.extract_plate_tokens(line.text):
                lines_by_plate.setdefault(plate, []).append(line)

    events = []
    for plate, lines in lines_by_plate.items():
        for cluster in cluster_by_gap(lines, gap):
            if len(cluster) >= max(1, args.min_lines):
                events.append((plate, cluster))
    events.sort(key=lambda item: (item[1][0].ts, item[0]))
    return events


def run_discovery(args, fetcher, client, tz, start, end, around, window, index_expr, write_files: bool):
    gap = dt.timedelta(minutes=args.gap_minutes)
    events = discover_plates(fetcher, args, start, end, gap)
    if not events:
        print("no vehicle events found")
        return 1
    if args.limit:
        events = events[: args.limit]

    output_dir = args.discover_output_dir
    if write_files and output_dir is None:
        output_dir = Path(f"{re.sub(r'[^A-Za-z0-9_.-]', '_', index_expr)}_merged")
    if output_dir:
        output_dir.mkdir(parents=True, exist_ok=True)

    for number, (plate, cluster) in enumerate(events, 1):
        print(f"{number}. {summarize_lines(cluster, plate)}")
        if not output_dir:
            continue
        event_anchor, event_window = core.anchor_and_window_for_event(
            core.VehicleEvent(plate, cluster), dt.timedelta(minutes=args.window_minutes)
        )
        event_start = event_anchor - event_window
        event_end = event_anchor + event_window
        event_fetcher = EsFetcher(client, args, tz, index_expr)
        result = merge_vehicle_es(
            event_fetcher,
            plate,
            event_anchor,
            event_window,
            args.rounds,
            event_start,
            event_end,
            lane_scan=not args.no_lane_scan,
        )
        output_path = output_dir / core.output_name_for_event(core.VehicleEvent(plate, cluster))
        with output_path.open("w", encoding="utf-8") as handle:
            write_markdown_es(
                handle,
                vehicle=plate,
                args=args,
                index_expr=index_expr,
                around=event_anchor,
                window=event_window,
                result=result,
                scanned=event_fetcher.stats.get("docs", 0),
            )
        print(f"   wrote {output_path} ({len(result.matches)} lines, {len(result.keys)} keys)")

    if output_dir:
        print(f"done: wrote {len(events)} files to {output_dir}")
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="merge_vehicle_logs_es.py",
        description="从 Elasticsearch 归并一辆车一次通行的日志（merge_vehicle_logs.py 的 ES 版本）。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例:\n"
            "  # 列出索引（先确认要查哪个索引 / 哪个月）\n"
            "  python merge_vehicle_logs_es.py --list-indices\n\n"
            "  # 归并一辆车，输出 Markdown\n"
            "  python merge_vehicle_logs_es.py 鲁UG6595 --index 'ump_37016433_2026.07' \\\n"
            "      --at '2026-07-01 12:06:54' --window-minutes 5 -o merged_鲁UG6595.md\n\n"
            "  # 自动发现并发每一辆车（车牌聚合发现，速度快）\n"
            "  python merge_vehicle_logs_es.py --auto --index 'ump_37016433_2026.07' \\\n"
            "      --at '2026-07-01 12:06:54' --window-minutes 10 --limit 5\n"
        ),
    )
    parser.add_argument("vehicle", nargs="?", help="车牌，例如：鲁UG6595")
    parser.add_argument("--es-host", default=DEFAULT_ES_HOST, help=f"ES 地址，默认 {DEFAULT_ES_HOST}")
    parser.add_argument("--es-user", help="Basic Auth 用户名（可省略）")
    parser.add_argument("--es-password", help="Basic Auth 密码（可省略）")
    parser.add_argument("--no-verify-tls", action="store_true", help="https 时跳过证书校验")
    parser.add_argument("--timeout", type=float, default=60.0, help="单次请求超时秒数，默认 60")
    parser.add_argument("--index", default=DEFAULT_INDEX, help=f"索引模式，默认 {DEFAULT_INDEX}")
    parser.add_argument("--no-auto-index", action="store_true",
                        help="不做按月份裁剪（仍会展开 --index 模式，并跳过 _test_ 索引与 0 文档索引）")
    parser.add_argument("--list-indices", action="store_true", help="列出 --index 命中的索引后退出")
    parser.add_argument("--time-field", default="@timestamp", help="时间字段（date 类型，用于范围过滤与排序），默认 @timestamp")
    parser.add_argument("--message-field", default="message,msg", help="日志正文字段，可逗号分隔多个作为兜底，默认 message,msg")
    parser.add_argument("--kind-field", default="logType", help="日志来源类型字段，默认 logType")
    parser.add_argument("--lane-field", default="landId", help="车道号字段，默认 landId")
    parser.add_argument("--plate-field", default="vlp.keyword", help="车牌聚合字段（--auto/--discover 用），默认 vlp.keyword")
    parser.add_argument("--lane-regex", default=r"(?!0{10}$)[0-9A-Fa-f]{10}", help="车道号字段的校验正则")
    parser.add_argument("--timezone", help="解释 --at/--from/--to 的时区，默认本机时区，例如 +08:00")
    parser.add_argument("--log-type", action="append", help="只查指定 logType（可重复），例如 --log-type laneLog")
    parser.add_argument("--extra-query", help="追加的 ES 查询 JSON（filter 片段）")
    parser.add_argument("--page-size", type=int, default=1000, help="分页大小，默认 1000")
    parser.add_argument("--max-docs", type=int, default=20000, help="单次检索最多拉取的文档数，默认 20000")
    parser.add_argument("--full-window-scan", action="store_true",
                        help="整窗全量拉取后在本地做子串匹配，语义与原脚本完全等价（较慢）")
    parser.add_argument("--no-lane-scan", action="store_true", help="关闭「已发现车道全量重扫」这一步")
    parser.add_argument("--at", type=parse_datetime, help="锚点时间，例如 '2026-07-01 12:06:54'")
    parser.add_argument("--from", dest="from_time", type=parse_datetime, help="时间窗起点（与 --to 搭配）")
    parser.add_argument("--to", dest="to_time", type=parse_datetime, help="时间窗终点（与 --from 搭配）")
    parser.add_argument("--window-minutes", type=int, default=5, help="--at 前后的时间窗，默认 5 分钟")
    parser.add_argument("--rounds", type=int, default=2, help="关联扩展轮数，默认 2")
    parser.add_argument("--auto", action="store_true", help="自动发现并归并多辆车（需要时间范围）")
    parser.add_argument("--discover", action="store_true",
                        help="只发现候选车辆事件不写文件；若同时给了 --discover-output-dir 则会写文件")
    parser.add_argument("--discover-output-dir", type=Path,
                        help="输出目录（--auto 不给时自动生成；--discover 给了就写文件）")
    parser.add_argument("--min-lines", type=int, default=1,
                        help="候选事件的最小行数，默认 1（--discover/--auto 下同时作为车牌聚合的 min_doc_count）")
    parser.add_argument("--limit", type=int, help="最多处理多少辆车")
    parser.add_argument("--list-events", action="store_true", help="只列出该车牌的候选通行事件")
    parser.add_argument("--gap-minutes", type=int, default=10, help="事件切分间隔，默认 10 分钟")
    parser.add_argument("-o", "--output", type=Path, help="Markdown 输出路径")
    parser.add_argument("--verbose", action="store_true", help="打印 ES 查询与合并过程")
    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    # 参数校验放在最前面，避免 typo 变成"跑完才失败"或"静默空结果"
    if args.page_size < 1:
        parser.error("--page-size 必须 >= 1")
    if args.max_docs < 1:
        parser.error("--max-docs 必须 >= 1")
    if args.window_minutes < 0:
        parser.error("--window-minutes 必须 >= 0")
    if not [item for item in (args.message_field or "").split(",") if item.strip()]:
        parser.error("--message-field 不能为空，例如 --message-field 'message,msg'")
    for name in ("time_field", "kind_field", "lane_field"):
        if not (getattr(args, name) or "").strip():
            parser.error(f"--{name.replace('_', '-')} 不能为空")
    if args.lane_regex:
        try:
            re.compile(args.lane_regex)
        except re.error as exc:
            parser.error(f"--lane-regex 不是合法正则: {exc}")
    tz = resolve_timezone(args.timezone)
    client = EsClient(
        args.es_host,
        timeout=args.timeout,
        username=args.es_user,
        password=args.es_password,
        verify_tls=not args.no_verify_tls,
        verbose=args.verbose,
    )

    try:
        info = client.info()
        if args.verbose:
            if not isinstance(info, dict):
                info = {}
            version = info.get("version")
            number = version.get("number") if isinstance(version, dict) else version
            print(
                f"[es] {info.get('cluster_name')} / ES {number} @ {args.es_host}",
                file=sys.stderr,
            )
    except EsError as exc:
        print(f"连接 Elasticsearch 失败：\n  {exc}", file=sys.stderr)
        return 2

    try:
        around, window, start, end = resolve_range(args, tz)

        if args.list_indices:
            return list_indices_report(client, args, start, end)

        if args.discover or args.auto:
            if start is None:
                print(
                    "错误：从 ES 发现车辆需要明确时间范围，请提供 --at 'YYYY-MM-DD HH:MM:SS'"
                    "（配合 --window-minutes）或 --from/--to。",
                    file=sys.stderr,
                )
                return 2
            index_expr, rows = resolve_index(client, args, start, end, verbose=args.verbose)
            print(
                f"[es] host={args.es_host} index={index_expr} ({len(rows)} 个索引) "
                f"window={start} ~ {end} (本地时区 {tz})",
                file=sys.stderr,
            )
            fetcher = EsFetcher(client, args, tz, index_expr)
            return run_discovery(args, fetcher, client, tz, start, end, around, window, index_expr, write_files=args.auto)

        if not args.vehicle:
            print("错误：请提供车牌，或使用 --auto / --discover / --list-indices。", file=sys.stderr)
            return 2

        if start is None:
            print(
                "错误：从 ES 归并必须限定时间范围，请提供 --at 'YYYY-MM-DD HH:MM:SS'"
                "（配合 --window-minutes）或 --from/--to。\n"
                "    提示：先用 --list-indices 看有哪些索引，再确认大致时间。",
                file=sys.stderr,
            )
            return 2

        index_expr, rows = resolve_index(client, args, start, end, verbose=args.verbose)
        if args.verbose:
            print(f"[es] 将查询 {len(rows)} 个索引: {index_expr}", file=sys.stderr)

        fetcher = EsFetcher(client, args, tz, index_expr)

        if args.list_events:
            candidates = fetcher.time_window_docs(start, end) if args.full_window_scan else fetcher.key_candidates(
                {args.vehicle, f"{args.vehicle}_0"}, start, end
            )
            lines = [line for line in candidates if core.line_matches(line.text, {args.vehicle, f"{args.vehicle}_0"}, args.vehicle)]
            clusters = cluster_by_gap(lines, dt.timedelta(minutes=args.gap_minutes))
            if not clusters:
                print(f"no events found for {args.vehicle}")
                return 1
            for number, cluster in enumerate(clusters, 1):
                print(f"{number}. {summarize_lines(cluster, args.vehicle)}")
            return 0

        print(
            f"[es] host={args.es_host} index={index_expr} ({len(rows)} 个索引) "
            f"window={start} ~ {end} (本地时区 {tz})",
            file=sys.stderr,
        )
        if args.full_window_scan:
            print(
                f"[es] --full-window-scan：整窗全量拉取（最多 {args.max_docs} 条），语义与原脚本一致",
                file=sys.stderr,
            )

        result = merge_vehicle_es(
            fetcher,
            args.vehicle,
            around,
            window,
            args.rounds,
            start,
            end,
            lane_scan=not args.no_lane_scan,
        )
        scanned = fetcher.stats.get("docs", 0)
        print(
            f"[es] 命中 {len(result.matches)} 行 / key {len(result.keys)} 个 / "
            f"拉取文档 {scanned} 条 / 检索 {fetcher.stats.get('queries', 0)} 次"
            f"（HTTP 共 {client.request_count} 次）",
            file=sys.stderr,
        )
        if fetcher.truncated:
            print("[es] 提示：本次检索被截断，结果可能不完整（调大 --max-docs 或缩小时间窗）。", file=sys.stderr)

        if args.output:
            if args.output.parent and not args.output.parent.exists():
                args.output.parent.mkdir(parents=True, exist_ok=True)
            with args.output.open("w", encoding="utf-8") as handle:
                write_markdown_es(
                    handle,
                    vehicle=args.vehicle,
                    args=args,
                    index_expr=index_expr,
                    around=around,
                    window=window,
                    result=result,
                    scanned=scanned,
                )
            print(f"wrote {args.output} ({len(result.matches)} lines, {len(result.keys)} keys)")
        else:
            write_markdown_es(
                sys.stdout,
                vehicle=args.vehicle,
                args=args,
                index_expr=index_expr,
                around=around,
                window=window,
                result=result,
                scanned=scanned,
            )
        return 0
    except EsError as exc:
        print(f"Elasticsearch 查询失败：\n  {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\n已中断", file=sys.stderr)
        return 130
    finally:
        client.close_pit()


if __name__ == "__main__":
    raise SystemExit(main())
