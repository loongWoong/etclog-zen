"""探针 v3：为「车道字典 / 时间语义字典 / 身份键字典 + 本体实例规格」取证。

只读 ES，不改任何在用文件。产物：_lane_dict.md
覆盖问题：
  1) 每条车道的线圈集合（从 secondKey 的 "E5|车辆检测器|车检器N" 取）→ 车道类型
  2) laneType / laneDirection 分布，以及与车道号（hex 低字节）的对应
  3) 车型字段 vehClass / vehicleClass 的覆盖（按 logType）
  4) 抓拍时间字段 vlpTime / vlp / licenseCode 的覆盖与语义
  5) barSignal / ctrlType 等设备状态字段的覆盖（判断是否需要派生字段）
  6) passId 落在哪些 landId 上 → 通行记录与流水的关联路径
"""
import json
import re
import urllib.request
from collections import defaultdict

HOST = 'http://192.168.22.212:9200'
INDEX = 'ump_37016433_2026.07'
DAY = {"range": {"@timestamp": {"gte": "2026-06-30T16:00:00Z", "lt": "2026-07-01T16:00:00Z"}}}
HOUR = {"range": {"@timestamp": {"gte": "2026-07-01T04:00:00Z", "lt": "2026-07-01T05:00:00Z"}}}
OUT = []


def es(body, index=INDEX, path='_search'):
    req = urllib.request.Request(
        f'{HOST}/{index}/{path}',
        data=json.dumps(body).encode('utf-8'),
        headers={'Content-Type': 'application/json'},
    )
    return json.loads(urllib.request.urlopen(req, timeout=300).read().decode('utf-8'))


def b(body, name):
    return (body
            .setdefault('aggs', {})
            .setdefault(name, {}))


# ---------- 1) 车道字典：线圈集合 + 类型 ----------
body = {
    "size": 0,
    "query": {"bool": {"filter": [DAY, {"term": {"logType.keyword": "laneLog"}}]}},
    "aggs": {
        "lanes": {
            "terms": {"field": "landId.keyword", "size": 30},
            "aggs": {
                "keys": {"terms": {"field": "secondKey.keyword", "size": 60}},
                "types": {"terms": {"field": "laneType.keyword", "size": 10}},
                "dirs": {"terms": {"field": "laneDirection.keyword", "size": 10}},
            },
        }
    },
}
r = es(body)
lane_rows = []
for lb in r['aggregations']['lanes']['buckets']:
    keys = [(k['key'], k['doc_count']) for k in lb['keys']['buckets']]
    coils = sorted({int(m.group(1)) for k, _ in keys
                    for m in [re.fullmatch(r'E5\|车辆检测器\|车检器(\d+)', k)] if m})
    coil_docs = sum(c for k, c in keys if re.fullmatch(r'E5\|车辆检测器\|车检器\d+', k))
    barrier = sum(c for k, c in keys if k in ('E4|电动栏杆机|栏杆机1',))
    lane_rows.append({
        'lane': lb['key'], 'docs': lb['doc_count'],
        'types': {t['key']: t['doc_count'] for t in lb['types']['buckets']},
        'dirs': {d['key']: d['doc_count'] for d in lb['dirs']['buckets']},
        'coils': coils, 'coil_docs': coil_docs, 'barrier_docs': barrier,
    })

OUT.append('# 车道字典取证（2026-07-01 全天，laneLog）\n')
OUT.append('| 车道 landId | hex 低字节 | 文档 | laneType | laneDirection | 线圈(E5) | 线圈上报 | 栏杆(E4) | 推断角色 |')
OUT.append('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for x in lane_rows:
    dec = int(x['lane'][-2:], 16)
    if x['coils'] == [1, 2, 7]:
        role = 'ETC 专用车道'
    elif x['coils'] == [6, 7]:
        role = '混合车道'
    elif not x['coils']:
        role = '无线圈上报（需人工确认；35F 为匝道）'
    else:
        role = '其他/待确认'
    OUT.append('| %s | %d | %d | %s | %s | %s | %d | %d | %s |' % (
        x['lane'], dec, x['docs'],
        ','.join(f'{k}:{v}' for k, v in x['types'].items()) or '-',
        ','.join(f'{k}:{v}' for k, v in x['dirs'].items()) if x['dirs'] else '-',
        ','.join(str(c) for c in x['coils']) or '-',
        x['coil_docs'], x['barrier_docs'], role))

# ---------- 2) 设备状态字段覆盖（全天） ----------
body = {
    "size": 0,
    "query": {"bool": {"filter": [DAY]}},
    "aggs": {
        "barSignal": {"filter": {"exists": {"field": "barSignal.keyword"}}},
        "ctrlType": {"filter": {"exists": {"field": "ctrlType.keyword"}}},
        "anomalyType": {"filter": {"exists": {"field": "anomalyType.keyword"}}},
        "checkResult": {"filter": {"exists": {"field": "checkResult.keyword"}}},
        "vlpTime": {"filter": {"exists": {"field": "vlpTime.keyword"}}},
        "vlp": {"filter": {"exists": {"field": "vlp.keyword"}}},
        "licenseCode": {"filter": {"exists": {"field": "licenseCode.keyword"}}},
        "vehClass": {"filter": {"exists": {"field": "vehClass.keyword"}}},
        "vehicleClass": {"filter": {"exists": {"field": "vehicleClass.keyword"}}},
        "passId": {"filter": {"exists": {"field": "passId.keyword"}}},
        "byType": {
            "terms": {"field": "logType.keyword", "size": 10},
            "aggs": {
                "vehClass": {"filter": {"exists": {"field": "vehClass.keyword"}}},
                "vehicleClass": {"filter": {"exists": {"field": "vehicleClass.keyword"}}},
                "passId": {"filter": {"exists": {"field": "passId.keyword"}}},
                "vlpTime": {"filter": {"exists": {"field": "vlpTime.keyword"}}},
            },
        },
    },
}
r = es(body)
OUT.append('\n# 结构化字段覆盖（2026-07-01 全天，%d 文档）\n' % r['hits']['total']['value'])
for k in ('barSignal', 'ctrlType', 'anomalyType', 'checkResult', 'vlpTime', 'vlp',
          'licenseCode', 'vehClass', 'vehicleClass', 'passId'):
    OUT.append('- %s: %d' % (k, r['aggregations'][k]['doc_count']))
OUT.append('\n## 按 logType\n')
OUT.append('| logType | docs | vehClass | vehicleClass | passId | vlpTime |')
OUT.append('| --- | --- | --- | --- | --- | --- |')
for t in r['aggregations']['byType']['buckets']:
    OUT.append('| %s | %d | %d | %d | %d | %d |' % (
        t['key'], t['doc_count'],
        t['vehClass']['doc_count'], t['vehicleClass']['doc_count'],
        t['passId']['doc_count'], t['vlpTime']['doc_count']))

# ---------- 3) passId 落在哪些 landId（一小时） ----------
body = {
    "size": 0,
    "query": {"bool": {"filter": [HOUR, {"exists": {"field": "passId.keyword"}}]}},
    "aggs": {"lanes": {"terms": {"field": "landId.keyword", "size": 20}},
             "types": {"terms": {"field": "logType.keyword", "size": 10}}},
}
r = es(body)
OUT.append('\n# passId 文档分布（一小时）\n')
OUT.append('- 总数 %d' % r['hits']['total']['value'])
OUT.append('- 按 landId: ' + ', '.join('%s=%d' % (x['key'], x['doc_count']) for x in r['aggregations']['lanes']['buckets']))
OUT.append('- 按 logType: ' + ', '.join('%s=%d' % (x['key'], x['doc_count']) for x in r['aggregations']['types']['buckets']))

# ---------- 4) vlpTime 语义抽样 ----------
body = {
    "size": 5,
    "_source": ["landId", "time", "vlpTime", "vlp", "licenseCode", "logType", "secondKey"],
    "query": {"bool": {"filter": [HOUR], "must": [{"exists": {"field": "vlpTime.keyword"}}]}},
    "sort": [{"@timestamp": "asc"}],
}
r = es(body)
OUT.append('\n# vlpTime 抽样（判断它是抓拍时间还是上传时间）\n')
for h in r['hits']['hits']:
    s = h['_source']
    OUT.append('- time=%s vlpTime=%s vlp=%s licenseCode=%s logType=%s secondKey=%s' % (
        s.get('time'), s.get('vlpTime'), s.get('vlp'), s.get('licenseCode'),
        s.get('logType'), s.get('secondKey')))

# ---------- 5) 车道号（十进制）在日志正文里的形态 ----------
body = {
    "size": 200,
    "_source": ["landId", "msg", "message"],
    "query": {"bool": {"filter": [HOUR], "must": [{"match_phrase": {"secondKey": "收到设备控制服务数据"}}]}},
    "sort": [{"@timestamp": "asc"}],
}
try:
    r = es(body)
    found = defaultdict(set)
    pat = re.compile(r'(\d{1,3})\s*车道')
    for h in r['hits']['hits']:
        s = h['_source']
        lane = s.get('landId', '')
        for txt in (s.get('msg') or '', s.get('message') or ''):
            for m in pat.finditer(txt):
                found[lane].add(m.group(1))
    OUT.append('\n# 车道号（正文里的 "N车道"）与 landId 对应抽样\n')
    for lane in sorted(found):
        OUT.append('- %s : %s' % (lane, sorted(found[lane], key=int)))
except Exception as exc:  # noqa: BLE001
    OUT.append('\n# 车道号抽样失败: %s\n' % exc)

open('_lane_dict.md', 'w', encoding='utf-8').write('\n'.join(OUT) + '\n')
print('written _lane_dict.md')
print('\n'.join(OUT[:60]))
