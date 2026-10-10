"""探针：单小时内“同一 OBU 被多条车道在 5s 内读到”的次数与形态（邻道干扰场景一的可行性验证）。

只读 ES，不改任何在用的脚本。产物：_b2_crosslane.md
"""
import json
import urllib.request
from collections import defaultdict

ES = 'http://192.168.22.212:9200/ump_37016433_2026.07/_search'
WIN = {"range": {"@timestamp": {"gte": "2026-07-01T04:00:00Z", "lt": "2026-07-01T05:00:00Z"}}}

body = {
    "size": 3000,
    "_source": ["ObuCode", "landId", "time", "@timestamp", "secondKey", "firstKey", "msg"],
    "sort": [{"@timestamp": "asc"}],
    "query": {"bool": {"filter": [WIN, {"term": {"secondKey.keyword": "收到B2帧"}}]}},
}

req = urllib.request.Request(ES, data=json.dumps(body).encode('utf-8'),
                             headers={'Content-Type': 'application/json'})
resp = json.loads(urllib.request.urlopen(req, timeout=120).read().decode('utf-8'))
hits = resp['hits']['hits']
print('B2 hits returned:', len(hits), 'total:', resp['hits']['total']['value'])

rows = []
for h in hits:
    s = h['_source']
    rows.append((s.get('ObuCode') or '', s.get('landId') or '', s.get('time') or ''))

by_obu = defaultdict(list)
for obu, lane, t in rows:
    if obu:
        by_obu[obu].append((t, lane))
print('distinct OBU with B2 in hour:', len(by_obu))

multi = {k: v for k, v in by_obu.items() if len({l for _, l in v}) > 1}
print('OBU seen on >1 lane in the hour:', len(multi))

# 5s 内跨车道
def to_ms(t):
    import datetime as dt
    try:
        return int(dt.datetime.strptime(t, '%Y-%m-%d %H:%M:%S.%f').timestamp() * 1000)
    except Exception:
        return None

near = []
for obu, obs in multi.items():
    obs2 = sorted((to_ms(t), l, t) for t, l in obs if to_ms(t))
    for i in range(len(obs2)):
        for j in range(i + 1, len(obs2)):
            if obs2[j][0] - obs2[i][0] <= 5000 and obs2[j][1] != obs2[i][1]:
                near.append((obu, obs2[i][2], obs2[i][1], obs2[j][2], obs2[j][1], obs2[j][0] - obs2[i][0]))
print('same-OBU cross-lane pairs within 5s:', len(near))

w = open('_b2_crosslane.md', 'w', encoding='utf-8')
w.write('# 单小时 B2 帧跨车道共读探针（2026-07-01 12:00-13:00 本地）\n\n')
w.write('- B2 命中: %d (total %d)\n' % (len(hits), resp['hits']['total']['value']))
w.write('- 有 OBU 的 B2 记录: %d，distinct OBU: %d\n' % (len(rows), len(by_obu)))
w.write('- 单小时内出现在 >1 条车道的 OBU: %d\n' % len(multi))
w.write('- 5s 内跨车道共读对: %d\n\n' % len(near))
w.write('## 5s 内跨车道共读明细\n\n')
for obu, t1, l1, t2, l2, gap in sorted(near, key=lambda x: x[1])[:60]:
    w.write('- OBU %s: %s [%s] -> %s [%s]  Δ=%dms\n' % (obu, t1, l1, t2, l2, gap))
w.write('\n## 单小时跨车道（不限 5s）OBU 数：%d，示例\n\n' % len(multi))
for obu, obs in list(sorted(multi.items()))[:30]:
    w.write('- %s : %s\n' % (obu, ' | '.join('%s[%s]' % (t, l) for t, l in sorted(obs))))
w.close()
print('written _b2_crosslane.md')
