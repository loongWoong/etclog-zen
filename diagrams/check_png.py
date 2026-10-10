"""栅格化后的机器体检：确认每张图有内容、内容填满画布、无边缘裁切、纵向分布不塌。

用法：python check_png.py  （读 out/_preview-*.png）
"""
import glob
import os
import sys

from PIL import Image

rows = []
bad = []
for path in sorted(glob.glob('F:/caochun/etclog/diagrams/out/preview/*.png')):
    im = Image.open(path).convert('L')
    w, h = im.size
    px = im.load()
    ink_pts = 0
    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            if px[x, y] < 245:
                ink_pts += 1
                minx = min(minx, x); maxx = max(maxx, x)
                miny = min(miny, y); maxy = max(maxy, y)
    ink = ink_pts / (w * h)
    # 纵向 10 段墨迹占比：塌成一条 / 大片空白都会在这里露出来
    bands = []
    for b in range(10):
        y0, y1 = h * b // 10, h * (b + 1) // 10
        c = 0
        for y in range(y0, y1):
            for x in range(w):
                if px[x, y] < 245:
                    c += 1
        bands.append(round(c / max(1, (y1 - y0) * w), 4))
    edge = 0
    for y in range(h):
        if px[0, y] < 245 or px[w - 1, y] < 245:
            edge += 1
    for x in range(w):
        if px[x, 0] < 245 or px[x, h - 1] < 245:
            edge += 1
    empty = sum(1 for b in bands if b < 0.0005)
    rows.append((os.path.basename(path), w, h, round(ink, 4), empty, edge, bands))
    if ink < 0.002:
        bad.append(f'{path} 墨迹过少({ink:.4f})——疑似空白图')
    if empty >= 3:
        bad.append(f'{path} 有 {empty}/10 段几乎全空')
    if edge > 0:
        bad.append(f'{path} 内容触到画布边缘 {edge} px——疑似被裁切')

print(f"{'文件':<22}{'尺寸':>12}{'墨迹占比':>10}{'空段':>6}{'触边':>6}  纵向 10 段墨迹")
for name, w, h, ink, empty, edge, bands in rows:
    print(f'{name:<22}{w:>6}x{h:<5}{ink:>10.4f}{empty:>6}{edge:>6}  ' + ' '.join(f'{b:.3f}' for b in bands))
print()
print('\n'.join(bad) if bad else '结论：每张图都有内容、无触边裁切、纵向分布不塌。')
sys.exit(1 if bad else 0)
