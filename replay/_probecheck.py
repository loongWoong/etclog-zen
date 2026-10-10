"""把注入页面的探针模块拼出来（HELPERS + 各页 TEMPLATES），交给 `node --check` 验证语法。

为什么必须做这一步：探针是"注入的 JS 字符串"，它自己语法错的话，页面会整片不执行 ——
现象是"没有收到探针数据"，看不出根因。所以开浏览器之前先过一遍 node --check。

用法：python _probecheck.py   （三个页面各检查一遍，失败退出码非 0）
"""

import importlib.util
import io
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent


def load_checker():
    spec = importlib.util.spec_from_file_location("cre", ROOT / "check_render_effects.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    module = load_checker()
    templates = getattr(module, "TEMPLATES", {})
    helpers = getattr(module, "HELPERS", "")
    if not templates:
        print("没有找到 TEMPLATES")
        return 1
    failed = 0
    for page, body in templates.items():
        text = body.replace("__PORT__", "8799")
        # 只留 <script type="module"> 里面的那一段
        chunks = re.findall(r'<script type="module">(.*?)</script>', text, re.S)
        script = "\n".join(chunks) if chunks else text
        source = (
            'import * as THREE from "three";\n'
            'import { createBloomPipeline } from "./scene-look.js";\n'
            'import { createBrakeController } from "./vehicle-models.js";\n'
            + helpers
            + "\n"
            + script
        )
        out = ROOT / f"_probe_{page}.mjs"
        io.open(out, "w", encoding="utf-8", newline="\n").write(source)
        result = subprocess.run(["node", "--check", str(out)], capture_output=True, text=True)
        ok = result.returncode == 0
        print(f"{page:9} {'OK' if ok else 'FAIL'}  {len(source)} 字符")
        if not ok:
            failed += 1
            print(result.stderr.strip()[:1200])
        out.unlink()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
