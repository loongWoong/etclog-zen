"""把 replay 下的 ESM 模块（含 vendor/addons）复制成 .mjs 临时副本，好在 Node 里直接跑几何代码。

浏览器不在乎 .js 的模块类型，Node 在乎（没有 package.json 时 .js 一律当 CommonJS）。所以这里：
  · 保持**仓库相对目录结构**复制到 _smoke/ 下（addons 之间互相用 "../shaders/xxx.js" 引用，摊平会断）；
  · 把每个文件里的相对 import 改写成对应的 .mjs；
  · `from "three"` / `from 'three'` 改写成 vendored three.module.mjs 的相对路径。

入口自己写在 _smoke/run.mjs，按"仓库根"写相对 import（写成 .mjs，幂等）。

用法：python _smoketool.py [入口.mjs]（默认 _smoke/run.mjs）→ 然后 node _smoke/run.mjs
"""

import io
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT / "_smoke"
THREE = "vendor/three/build/three.module"


def copy_graph(entry: pathlib.Path) -> None:
    pending = [(entry, ROOT)]
    seen = set()
    while pending:
        src, base = pending.pop()
        if src in seen:
            continue
        seen.add(src)
        text = io.open(src, encoding="utf-8").read()
        if src == entry:
            out = src
        else:
            out = OUT / src.relative_to(ROOT).with_suffix(".mjs")
            out.parent.mkdir(parents=True, exist_ok=True)
        depth = len(out.relative_to(OUT).parts) - 1
        prefix = "../" * depth if depth else "./"
        for spec in re.findall(r'from\s+["\']([^"\']+)["\']', text):
            if spec == "three":
                text = re.sub(r'from\s+["\']three["\']', f'from "{prefix}{THREE}.mjs"', text)
            elif spec.startswith("three/addons/"):
                tail = spec[len("three/addons/"):]
                dep = ROOT / "vendor/three/examples/jsm" / tail
                pending.append((dep, dep.parent))
                text = re.sub(r'from\s+["\']' + re.escape(spec) + r'["\']',
                              f'from "{prefix}vendor/three/examples/jsm/{tail[:-3]}.mjs"', text)
            elif spec.startswith("."):
                dep = (base / spec).resolve()
                if spec.endswith(".mjs") and not dep.exists():
                    # 入口按 .mjs 写（幂等），仓库里的源文件仍是 .js：说明符不必改写
                    dep = dep.with_suffix(".js")
                    pending.append((dep, dep.parent))
                    continue
                pending.append((dep, dep.parent))
                text = re.sub(r'from\s+["\']' + re.escape(spec) + r'["\']', f'from "{spec[:-3]}.mjs"', text)
        io.open(out, "w", encoding="utf-8", newline="\n").write(text)
    print(f"copied {len(seen)} modules")


if __name__ == "__main__":
    target = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else OUT / "run.mjs"
    copy_graph(target.resolve())
