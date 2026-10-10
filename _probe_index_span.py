"""探针 v5：索引真实时间跨度（决定"整月"是几天，影响所有按天的量级换算）。只读 ES。"""
import json
import urllib.request

HOST = 'http://192.168.22.212:9200'
OUT = []


def es(body, index, path='_search'):
    req = urllib.request.Request(f'{HOST}/{index}/{path}',
                                 data=json.dumps(body).encode('utf-8'),
                                 headers={'Content-Type': 'application/json'})
    return json.loads(urllib.request.urlopen(req, timeout=600).read().decode('utf-8'))


for idx in ['ump_37016433_2026.06', 'ump_37016433_2026.07', 'ump_37016433_2026.08']:
    r = es({"size": 1, "sort": [{"@timestamp": "asc"}], "_source": ["@timestamp", "time", "logType"]}, idx)
    lo = r['hits']['hits'][0]['_source'] if r['hits']['hits'] else None
    r2 = es({"size": 1, "sort": [{"@timestamp": "desc"}], "_source": ["@timestamp", "time", "logType"]}, idx)
    hi = r2['hits']['hits'][0]['_source'] if r2['hits']['hits'] else None
    tot = es({"size": 0, "track_total_hits": True, "query": {"match_all": {}}}, idx)['hits']['total']['value']
    OUT.append('## %s  total=%s' % (idx, f'{tot:,}'))
    OUT.append('- 最早: %s / %s' % (lo.get('@timestamp'), lo.get('time')) if lo else '- 空索引')
    OUT.append('- 最晚: %s / %s' % (hi.get('@timestamp'), hi.get('time')) if hi else '')
    # 按天直方图（本地日）
    r3 = es({
        "size": 0, "track_total_hits": True,
        "aggs": {"days": {"date_histogram": {"field": "@timestamp", "calendar_interval": "day",
                                             "time_zone": "+08:00"}, "aggs": {
            "laneLog": {"filter": {"term": {"logType.keyword": "laneLog"}}},
            "data": {"filter": {"term": {"logType.keyword": "data"}}},
        }}},
    }, idx)
    OUT.append('| 本地日 | 全部 | laneLog | data |')
    OUT.append('| --- | --- | --- | --- |')
    for b in r3['aggregations']['days']['buckets']:
        OUT.append('| %s | %d | %d | %d |' % (b['key_as_string'][:10], b['doc_count'],
                                              b['laneLog']['doc_count'], b['data']['doc_count']))
    OUT.append('')

open('_index_span.md', 'w', encoding='utf-8').write('\n'.join(OUT) + '\n')
print('\n'.join(OUT))
