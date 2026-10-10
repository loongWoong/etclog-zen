import re

p = 'merged_鲁UG6595_20260701_120654.md'
txt = open(p, encoding='utf-8').read()
blocks = re.split(r'\n### ', txt)
out = []
for b in blocks[1:]:
    head = b.split('\n', 1)[0]
    m = re.search(r'```text\n(.*?)\n```', b, re.S)
    if not m:
        continue
    line = m.group(1).strip()
    lane = re.search(r'\[(3701643[0-9A-F]{1,3})\]', line)
    lane = lane.group(1) if lane else '?'
    out.append((head[:23], lane, line))

kw = ['抬杆', '栏杆', '线圈', '车检器', '抓拍', '图片', '车牌识别', 'RSU数据', 'B2帧', 'B4帧',
      'B5帧', '交易成功', '计费成功', '流水', '费显', 'EF04', '0015', '0019', 'C1帧', '称重', '车型']
w = open('_trip_evidence.md', 'w', encoding='utf-8')
w.write('# 鲁UG6595 一次通行的关键证据（按日志时间）\n\n')
for ts, lane, line in out:
    if any(k in line for k in kw):
        w.write('- %s [%s] %s\n' % (ts, lane, line[:420]))
w.close()

# 车道-时间矩阵：同一 OBU 在哪些车道被读到
print('events', len(out))
lanes = {}
for ts, lane, line in out:
    lanes.setdefault(lane, 0)
    lanes[lane] += 1
print('lanes seen:', lanes)
