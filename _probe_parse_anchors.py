"""探针 v4：整月车道清单 + 关键事件行的解析锚点抽样（供规格文档写具体解析规则）。

只读 ES。产物：_parse_anchors.md
"""
import json
import urllib.request

HOST = 'http://192.168.22.212:9200'
INDEX = 'ump_37016433_2026.07'
MONTH = {"range": {"@timestamp": {"gte": "2026-06-30T16:00:00Z", "lt": "2026-07-31T16:00:00Z"}}}
HOUR = {"range": {"@timestamp": {"gte": "2026-07-01T04:00:00Z", "lt": "2026-07-01T05:00:00Z"}}}
OUT = []


def es(body, index=INDEX):
    req = urllib.request.Request(f'{HOST}/{index}/_search',
                                 data=json.dumps(body).encode('utf-8'),
                                 headers={'Content-Type': 'application/json'})
    return json.loads(urllib.request.urlopen(req, timeout=600).read().decode('utf-8'))


# 1) 整月每车道 laneLog 文档量
r = es({
    "size": 0, "track_total_hits": True,
    "query": {"bool": {"filter": [MONTH, {"term": {"logType.keyword": "laneLog"}}]}},
    "aggs": {"lanes": {"terms": {"field": "landId.keyword", "size": 40}}},
})
OUT.append('# 整月（2026-07-01 ~ 2026-07-31 本地）laneLog 文档量\n')
OUT.append('laneLog 合计: %d\n' % r['hits']['total']['value'])
OUT.append('| landId | hex低字节 | laneLog 文档 |')
OUT.append('| --- | --- | --- |')
for x in r['aggregations']['lanes']['buckets']:
    lane = x['key']
    dec = int(lane[-2:], 16) if lane[-2:].isalnum() else -1
    OUT.append('| %s | %s | %d |' % (lane, dec, x['doc_count']))

# 2) 关键事件行抽样
keys = ['收到高清车牌图像识别设备模块数据', 'E4|电动栏杆机|栏杆机1',
        '收到车辆检测器模块数据', '交易结果', '队列逻辑', '收到B2帧']
for k in keys:
    try:
        r = es({
            "size": 3, "track_total_hits": True,
            "_source": ["landId", "time", "secondKey", "firstKey", "msg", "message"],
            "query": {"bool": {"filter": [HOUR, {"term": {"secondKey.keyword": k}}]}},
            "sort": [{"@timestamp": "asc"}],
        })
        OUT.append('\n## secondKey = `%s`  （本小时 %d 条）\n' % (k, r['hits']['total']['value']))
        for h in r['hits']['hits']:
            s = h['_source']
            OUT.append('- landId=%s time=%s' % (s.get('landId'), s.get('time')))
            OUT.append('  - msg: `%s`' % (s.get('msg') or '')[:400])
            OUT.append('  - message: `%s`' % (s.get('message') or '')[:400])
    except Exception as exc:  # noqa: BLE001
        OUT.append('\n## %s 抽样失败: %s\n' % (k, exc))

open('_parse_anchors.md', 'w', encoding='utf-8').write('\n'.join(OUT) + '\n')
print('written _parse_anchors.md')
print('\n'.join(OUT[:40]))
