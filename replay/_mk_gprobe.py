"""生成车辆总览页的无头探针页 + 探针脚本（临时脚本）。"""
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(r"F:\caochun\etclog\replay")

PROBE = '''// 车辆总览页无头验证（临时）
import * as THREE from "three";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await sleep(6000);
const api = window.__GALLERY__;
const out = { page: "vehicles", errors: (window.__ERRORS__ || []).slice(0, 8) };
if (!api) {
  out.fatal = "window.__GALLERY__ 未就绪";
} else {
  out.families = api.holders.map(({ family, built }) => {
    const box = new THREE.Box3().setFromObject(built.group);
    const size = box.getSize(new THREE.Vector3());
    let meshes = 0;
    let plate = false;
    let nan = false;
    built.group.traverse((child) => {
      if (!child.isMesh) return;
      meshes += 1;
      if (child.material?.map) plate = true;
      const position = child.getWorldPosition(new THREE.Vector3());
      if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) nan = true;
    });
    return {
      label: family.label,
      kind: family.kind,
      axles: family.axles,
      meshes,
      nan,
      hasPlate: plate,
      minY: Math.round(box.min.y * 1000) / 1000,
      size: { z: Math.round(size.z * 1000) / 1000, x: Math.round(size.x * 1000) / 1000, y: Math.round(size.y * 1000) / 1000 },
    };
  });

  // 相机取景：把所有模型包围盒的角点投到 NDC，确认都落在画面里
  const sceneBox = new THREE.Box3();
  api.holders.forEach(({ built }) => sceneBox.expandByObject(built.group));
  api.camera.updateMatrixWorld(true);
  const ndc = { minX: 9, maxX: -9, minY: 9, maxY: -9 };
  const corners = [];
  for (const x of [sceneBox.min.x, sceneBox.max.x]) {
    for (const y of [sceneBox.min.y, sceneBox.max.y]) {
      for (const z of [sceneBox.min.z, sceneBox.max.z]) corners.push(new THREE.Vector3(x, y, z));
    }
  }
  corners.forEach((corner) => {
    const projected = corner.clone().project(api.camera);
    ndc.minX = Math.min(ndc.minX, projected.x);
    ndc.maxX = Math.max(ndc.maxX, projected.x);
    ndc.minY = Math.min(ndc.minY, projected.y);
    ndc.maxY = Math.max(ndc.maxY, projected.y);
  });
  out.ndc = {
    minX: Math.round(ndc.minX * 100) / 100, maxX: Math.round(ndc.maxX * 100) / 100,
    minY: Math.round(ndc.minY * 100) / 100, maxY: Math.round(ndc.maxY * 100) / 100,
    fits: ndc.minX >= -1 && ndc.maxX <= 1 && ndc.minY >= -1 && ndc.maxY <= 1,
  };
  out.stats = { fps: api.LOOP?.fps, spinning: api.LOOP?.spinning, errors: api.LOOP?.errorCount };
}
try {
  await fetch("http://127.0.0.1:8799/log", { method: "POST", body: JSON.stringify(out) });
} catch (error) {
  (window.__ERRORS__ || []).push("report failed: " + error);
}
'''

(HERE / "_gprobe.js").write_text(PROBE, encoding="utf-8")

html = (HERE / "vehicles.html").read_text(encoding="utf-8")
SHIM = """    <script>
      window.__ERRORS__ = [];
      window.addEventListener("error", (event) => window.__ERRORS__.push(String(event.message || event.error)));
      window.addEventListener("unhandledrejection", (event) => window.__ERRORS__.push("rejection: " + event.reason));
      (function () {
        let clock = 0;
        window.requestAnimationFrame = function (callback) {
          return setTimeout(function () { clock += 16.7; callback(clock); }, 8);
        };
        window.cancelAnimationFrame = function (id) { clearTimeout(id); };
        const realNow = performance.now.bind(performance);
        performance.now = function () { return clock || realNow(); };
        Object.defineProperty(document, "hidden", { get: () => false });
      })();
    </script>
"""
lines = html.splitlines(keepends=True)
out_lines = []
injected = [False, False]
for line in lines:
    if not injected[0] and 'type="importmap"' in line:
        out_lines.append(SHIM)
        injected[0] = True
    if not injected[1] and "</body>" in line:
        out_lines.append('    <script type="module" src="./_gprobe.js"></script>\n')
        injected[1] = True
    out_lines.append(line)
if not all(injected):
    print(f"锚点缺失 {injected}", file=sys.stderr)
    raise SystemExit(1)
(HERE / "_gprobe.html").write_text("".join(out_lines), encoding="utf-8")
print("已生成 _gprobe.js / _gprobe.html")
