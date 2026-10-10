"""探针 v2：现有 ES 的 ObuCode 字段只有 1 字节，必须从 message 解析完整 OBU。

对比：
  A) 用 ES 字段 ObuCode.keyword 做跨车道共读 → 假阳性多少
  B) 从 message 的 B2 帧原文解析 8 位 OBU → 真实跨车道共读
只读 ES。产物：_b2_crosslane_v2.md
"""
import json
import re
import urllib.request
import datetime as dt
from collections import defaultdict

ES = 'http://192.168.22.212:9200/ump_37016433_2026.07/_search'
WIN = {"range": {"@timestamp": {"gte": "2026-07-01T04:00:00Z", "lt": "2026-07-01T05:00:00Z"}}}
B2_RE = re.compile(r'B2帧原始数据：([0-9A-Fa-f]+)')
HDR_RE = re.compile(r'^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]')

body = {
    "size": 3000,
    "_source": ["ObuCode", "landId", "time", "message"],
    "sort": [{"@timestamp": "asc"}],
    "query": {"bool": {"filter": [WIN, {"term": {"secondKey.keyword": "收到B2帧"}}]}},
}
req = urllib.request.Request(ES, data=json.dumps(body).encode('utf-8'),
                             headers={'Content-Type': 'application/json'})
resp = json.loads(urllib.request.urlopen(req, timeout=180).read().decode('utf-8'))
hits = resp['hits']['hits']

rows = []
field_only = defaultdict(list)
for h in hits:
    s = h['_source']
    lane = s.get('landId') or ''
    t = s.get('time') or ''
    msg = s.get('message') or ''
    m = B2_RE.search(msg)
    full = None
    if m and len(m.group(1)) >= 12:
        # 帧头 E101B2 + 8 位 OBU ID
        full = m.group(1)[6:14].upper()
    if not full:
        h2 = re.search(r'\[([0-9A-F]{8})\]', msg)
        full = h2.group(1) if h2 else None
    code = (s.get('ObuCode') or '').strip()
    rows.append((lane, t, code, full))
    if code:
        field_only[code].append((t, lane))

def to_ms(t):
    try:
        return int(dt.datetime.strptime(t, '%Y-%m-%d %H:%M:%S.%f').timestamp() * 1000)
    except Exception:
        return None

def pairs(groups):
    out = []
    for key, obs in groups.items():
        obs2 = sorted((to_ms(t), l, t) for t, l in obs if to_ms(t))
        for i in range(len(obs2)):
            for j in range(i + 1, len(obs2)):
                gap = obs2[j][0] - obs2[i][0]
                if gap > 5000:
                    break
                if obs2[j][1] != obs2[i][1]:
                    out.append((key, obs2[i][2], obs2[i][1], obs2[j][2], obs2[j][1], gap))
    return out

# A) 字段法
A = {k: v for k, v in field_only.items() if len({l for _, l in v}) > 1}
pa = pairs(A)
# B) message 解析法
by_obu = defaultdict(list)
for lane, t, code, full in rows:
    if full:
        by_obu[full].append((t, lane))
B = {k: v for k, v in by_obu.items() if len({l for _, l in v}) > 1}
pb = pairs(B)

w = open('_b2_crosslane_v2.md', 'w', encoding='utf-8')
w.write('# B2 跨车道共读：ES 字段法 vs message 解析法（2026-07-01 12:00-13:00 本地）\n\n')
w.write('- B2 文档: %d\n' % len(rows))
w.write('- 解析出完整 OBU 的: %d\n' % sum(1 for r in rows if r[3]))
w.write('- A) 用 ObuCode 字段：distinct=%d，跨车道 OBU=%d，5s 内跨车道对=%d\n'
        % (len(field_only), len(A), len(pa)))
w.write('- B) 用 message 解析：distinct=%d，跨车道 OBU=%d，5s 内跨车道对=%d\n\n'
        % (len(by_obu), len(B), len(pb)))
w.write('## ObuCode 字段取值样本（前 20）\n\n')
for k in sorted(field_only)[:20]:
    w.write('- `%s` 出现 %d 次\n' % (k, len(field_only[k])))
w.write('\n## B) 5s 内跨车道共读明细（全部 %d 对）\n\n' % len(pb))
for k, t1, l1, t2, l2, gap in sorted(pb, key=lambda x: x[1]):
    w.write('- OBU %s: %s [%s] -> %s [%s]  Δ=%dms\n' % (k, t1, l1, t2, l2, gap))
w.write('\n## B) 跨车道 OBU 的完整观测序列（全部 %d 个）\n\n' % len(B))
for k in sorted(B):
    w.write('- %s : %s\n' % (k, ' | '.join('%s[%s]' % (t, l) for t, l in sorted(B[k]))))
w.close()
print('A) field-based cross-lane pairs:', len(pa), 'distinct field values:', len(field_only))
print('B) message-based cross-lane pairs:', len(pb), 'distinct full OBU:', len(by_obu))
print('parsed full OBU rows:', sum(1 for r in rows if r[3]), '/', len(rows))
print('written _b2_crosslane_v2.md')
