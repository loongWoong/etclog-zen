"""无头渲染自检：三个页面在无头 Edge（SwiftShader）里跑一遍，用页面内的 gl.readPixels 回读画面。

为什么不用截图：无头浏览器截图抓不到 WebGL 画布，只能"画面里的像素自己报数"。
所以这里把一段探针脚本注入页面的**副本**（`_probe_<page>.html`，跑完即删），探针做四件事：

  1. 收集 window.onerror / unhandledrejection；
  2. 回读帧缓冲算亮度统计（mean / median / 高光裁剪比例），作为"画面变没变"的量化依据；
  3. 校验本轮新增/依赖的动态细节：刹车灯（材质、光晕、随减速的点亮行为）、接地阴影、道具组；
  4. 校验泛光后处理管线的正确性 ——
     · 管线「关掉泛光」时必须与直接 renderer.render 完全等价（three 渲染进 render target 时会自动
       改用 NoToneMapping + 线性色彩空间，最后由 OutputPass 统一做色调映射与 sRGB 编码）；
     · 打开泛光后必须确实把高光抬起来（像素变亮、裁剪增加）。

用法：
    python check_render_effects.py                 # 三个页面都跑
    python check_render_effects.py lanes index     # 只跑指定页面
    python check_render_effects.py --budget 90000 --size 1600,900

退出码 0 = 全部断言通过。
"""
from __future__ import annotations

import json
import math
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
SINK_PORT = 8799
SITE = "http://127.0.0.1:8765/replay"
ALL_PAGES = ["index", "lanes", "vehicles"]
KEEP_PROBES = False        # --keep：保留 _probe_<page>.html 便于排查

# ---------------------------------------------------------------------------
# 页面内注入：虚拟时钟 + 错误收集（放在 importmap 之前，页面脚本一开始就生效）
# ---------------------------------------------------------------------------
SHIM = """    <script>
      (function () {
        const ERRORS = [];
        window.__ERRORS__ = ERRORS;
        const push = (text) => { if (ERRORS.length < 12) ERRORS.push(String(text)); };
        window.addEventListener("error", (e) => push((e && (e.message || e.type)) || "error"));
        window.addEventListener("unhandledrejection", (e) => push("unhandledrejection: " + ((e.reason && e.reason.message) || e.reason)));
        // 虚拟时钟：无头 + virtual-time-budget 下 rAF 会被压成"每次推进一点虚拟时间"，
        // 用 setTimeout 驱动、performance.now 走虚拟秒表，页面里的 dt 逻辑才可复现。
        let vclock = 0;
        performance.now = () => vclock;
        window.requestAnimationFrame = (cb) => setTimeout(() => { vclock += 16.7; cb(vclock); }, 8);
        window.cancelAnimationFrame = (id) => clearTimeout(id);
        Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
      })();
    </script>
"""

HELPERS = r"""
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const round = (value, digits = 3) => {
        const scale = 10 ** digits;
        return Math.round((Number(value) || 0) * scale) / scale;
      };

      /** sRGB 编码值（0~1）→ 线性。影子贴图是 sRGB 编的、乘法乘的是线性值，核对时要转过来。 */
      function srgbToLinear(value) {
        return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
      }

      /**
       * 等页面进入某个状态。注意用的是**真实墙钟**（Date.now）而不是被替换成虚拟秒表的
       * performance.now：无头 + virtual-time-budget 下 setTimeout 会被快进，
       * 用虚拟时间计时会瞬间把预算烧完，而页面的 fetch 回调还没跑。
       */
      /** 等页面把调试句柄挂出来；等不到就报一句人话，而不是后面莫名其妙的 TypeError。 */
      async function waitForApi(name, probe) {
        const ready = await until(() => {
          const api = window[name];
          return api && probe(api);
        }, 120000);
        if (!ready) throw new Error(`页面没有在 120s 内挂出 ${name}（脚本没跑完或加载失败）`);
        return window[name];
      }

      async function until(predicate, timeoutMs = 45000, stepMs = 60) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          let ok = false;
          try { ok = Boolean(predicate()); } catch (error) { ok = false; }
          if (ok) return true;
          await new Promise((resolve) => setTimeout(resolve, stepMs));
        }
        return false;
      }

      function readPixels(renderer) {
        const gl = renderer.getContext();
        const width = gl.drawingBufferWidth;
        const height = gl.drawingBufferHeight;
        const buf = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        return { width, height, buf };
      }

      function grab(renderer, scene, camera) {
        renderer.render(scene, camera);
        return readPixels(renderer);
      }

      function grabVia(renderer, render) {
        render();
        return readPixels(renderer);
      }

      /**
       * 扫掠形状核对：真影子 = 车身矩形沿影子方向平移 sweep 的扫掠。
       *
       * 取一个"在平面矩形里、但根本不在真影子里"的角点（近垂直日照下的长车，这种角很大），
       * 再取一个"真影子里"的控制点，各自把影子藏起来前后采同一个像素：
       * 角点必须**不变**（那边没有东西挡光），控制点必须**变**（影子真的画上了）。
       * 只比面积大小是不够的——面积对了也可能铺错地方。
       */
      /**
       * 贴图是拿哪一套几何画的。贴图按整数度缓存、转台又在转，图里那一版形状可能与
       * 当前帧的方案差半度 —— 核对形状时必须用**图自己**记下的那一版。
       */
      function drawnShape(map, plan) {
        const shape = map && map.userData && map.userData.shape;
        if (!shape) return plan;
        const rel = Math.atan2(shape.sinRel, shape.cosRel);
        return Object.assign({}, plan, {
          width: shape.width,
          length: shape.length,
          sweep: shape.sweep,
          crossPlane: shape.crossPlane,
          alongPlane: shape.alongPlane,
          penumbra: shape.penumbra,
          tint: shape.tint,
          relDeg: THREE.MathUtils.radToDeg(rel),
        });
      }

      /**
       * 乘法贴图核对：白底（形状外=完全不变）+ 均匀的影核（形状内=天光比例）。
       * 画布是 sRGB 编的、贴图标了 sRGB，所以这里解回**线性**再和方案里的影色比。
       * 采样点用 (c,p) 平面坐标，走的是画贴图时同一套映射（探针里再算一遍）。
       */
      function shadowTextureProbe(map, plan) {
        const canvas = map && map.image;
        if (!canvas || !canvas.getContext || !plan) return null;
        plan = drawnShape(map, plan);
        const W = canvas.width;
        const H = canvas.height;
        const img = canvas.getContext("2d").getImageData(0, 0, W, H);
        const linearAt = (c, p) => {
          const x = Math.round(((p + plan.crossPlane / 2) / plan.crossPlane) * W);
          const y = Math.round((1 - (c - plan.sweep / 2 + plan.alongPlane / 2) / plan.alongPlane) * H);
          if (x < 0 || y < 0 || x >= W || y >= H) return null;
          const k = (y * W + x) * 4;
          return [srgbToLinear(img.data[k] / 255), srgbToLinear(img.data[k + 1] / 255), srgbToLinear(img.data[k + 2] / 255)];
        };
        // 影核中心：取扫掠形状里离四边都远的一点（车身占地中心偏背光侧）
        const centre = linearAt(plan.sweep / 2, 0);
        // 均匀性：在**车身矩形自己的坐标系**里取 3×3 点，再按同一套映射投到 (c,p) ——
        // 扫掠形状是"斜的平行四边形"（车身转过的角度 + 沿影子方向平移），直接按平面的
        // c/p 比例取样会取到形状外面（那里是纯白 1.0），于是把"涂装对了"误判成"影核不平"。
        const rel = THREE.MathUtils.degToRad(plan.relDeg || 0);
        const sinRel = Math.sin(rel);
        const cosRel = Math.cos(rel);
        const samples = [];
        const at = (x, z, extraC) => {
          const value = linearAt(
            plan.sweep / 2 + extraC + x * sinRel + z * cosRel,
            x * cosRel - z * sinRel);
          if (value) samples.push(value);
        };
        for (const fx of [-0.4, 0, 0.4]) {
          for (const fz of [-0.4, 0, 0.4]) at(plan.width * fx, plan.length * fz, 0);
        }
        // 再取"沿影子方向扫出去"的那一段（车顶影子）—— 形状内部整片都该是同一个乘数
        at(0, 0, plan.sweep * 0.5);
        at(plan.width * 0.4, 0, plan.sweep * 0.5);
        at(-plan.width * 0.4, 0, plan.sweep * 0.5);
        let spread = null;
        if (samples.length) {
          spread = 0;
          for (let k = 0; k < 3; k += 1) {
            const values = samples.map((v) => v[k]);
            spread = Math.max(spread, Math.max(...values) - Math.min(...values));
          }
        }
        // 形状外：沿影子方向再往外一个半影宽度以上，必须是纯白
        const outside = linearAt(plan.sweep / 2 + plan.alongPlane / 2 + plan.penumbra * 2, 0)
          || linearAt(plan.sweep / 2 + plan.alongPlane / 2 - 0.02, 0);
        return {
          centre: centre ? centre.map((v) => round(v, 3)) : null,
          spread: spread === null ? null : round(spread, 3),
          outside: outside ? outside.map((v) => round(v, 3)) : null,
          // 9 个内部采样点（3×3 网格）：不平时直接看得出来是哪一格跑掉了
          grid: samples.map((v) => v.map((x) => round(x, 3))),
          canvas: [W, H],
        };
      }

      /**
       * 影子贴图的覆盖度栅格：白=0（完全不变）、色调=1（全影）。
       * 逐格拿"贴图画出来的覆盖度"和"解析上在不在真扫掠区域里"对数。
       */
      function shadowShapeReport(shadowMesh, plan) {
        const tex = shadowMesh.material && shadowMesh.material.map;
        const canvas = tex && tex.image;
        if (!canvas || !canvas.getContext) return { grid: null, samples: [] };
        plan = drawnShape(tex, plan);
        const W = canvas.width;
        const H = canvas.height;
        const img = canvas.getContext("2d").getImageData(0, 0, W, H);
        // 覆盖度：贴图是"线性乘数"、画布按 sRGB 编的，所以先解回线性再和色调比。
        // 红通道最低、对比最大，用它反推覆盖度最灵敏。
        const tintRed = Math.max(0.02, 1 - (plan.tint ? plan.tint[0] : 0.12));
        const coverageAt = (c, p) => {
          // 与 vehicle-models.js 画贴图时同一套映射；探针里再算一遍，用来核对"画对了没有"
          const x = Math.round(((p + plan.crossPlane / 2) / plan.crossPlane) * W);
          const y = Math.round((1 - (c - plan.sweep / 2 + plan.alongPlane / 2) / plan.alongPlane) * H);
          if (x < 0 || y < 0 || x >= W || y >= H) return null;
          const k = (y * W + x) * 4;
          const linear = srgbToLinear(img.data[k] / 255);
          return Math.max(0, Math.min(1, (1 - linear) / tintRed));
        };
        const rel = THREE.MathUtils.degToRad(plan.relDeg || 0);
        const sinR = Math.sin(rel);
        const cosR = Math.cos(rel);
        // 点 (c,p) 在不在扫掠里：是否存在 t∈[0,sweep]，让 (c-t,p) 落进车身矩形
        const inside = (c, p) => {
          let lo = 0;
          let hi = plan.sweep;
          const limits = [[sinR, c * sinR + p * cosR, plan.width / 2],
                          [cosR, c * cosR - p * sinR, plan.length / 2]];
          for (const [k, a, h] of limits) {
            if (Math.abs(k) < 1e-6) {
              if (Math.abs(a) > h) return false;
              continue;
            }
            const t1 = (a - h) / k;
            const t2 = (a + h) / k;
            lo = Math.max(lo, Math.min(t1, t2));
            hi = Math.min(hi, Math.max(t1, t2));
            if (lo > hi) return false;
          }
          return lo <= hi + 1e-9;
        };
        // 形状轮廓（8 个点取凸包），用来算"这个点离真影子有多远"
        const corners = [];
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            const x = (sx * plan.width) / 2;
            const z = (sz * plan.length) / 2;
            corners.push([x * sinR + z * cosR, x * cosR - z * sinR]);
          }
        }
        const pts = corners.concat(corners.map(([c, p]) => [c + plan.sweep, p]));
        const sorted = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const turn = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
        const chain = (list) => {
          const out = [];
          for (const q of list) {
            while (out.length >= 2 && turn(out[out.length - 2], out[out.length - 1], q) <= 0) out.pop();
            out.push(q);
          }
          return out;
        };
        const lower = chain(sorted);
        const upper = chain(sorted.slice().reverse());
        const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
        const distToEdge = (c, p, a, b) => {
          const vx = b[0] - a[0];
          const vy = b[1] - a[1];
          const wx = c - a[0];
          const wy = p - a[1];
          const len2 = vx * vx + vy * vy || 1;
          const t = Math.min(1, Math.max(0, (wx * vx + wy * vy) / len2));
          return Math.hypot(c - (a[0] + t * vx), p - (a[1] + t * vy));
        };
        const distToShape = (c, p) => {
          if (inside(c, p)) return -1;
          let best = Infinity;
          for (let i = 0; i < hull.length; i += 1) {
            best = Math.min(best, distToEdge(c, p, hull[i], hull[(i + 1) % hull.length]));
          }
          return best;
        };
        // 在平面里铺网格：逐点比"贴图画出来的覆盖度"和"解析上在不在真扫掠里"。
        // 覆盖度 0 = 白（完全不变），1 = 全影（天光比例）。
        // 半影带内不判（本来就该糊出边界）；另外至少要躲开 2 个贴图像素 ——
        // 画布只有 256×96，一个 texel 就是十几厘米，边界像素本身必然是混色。
        const texel = Math.max(plan.alongPlane / canvas.height, plan.crossPlane / canvas.width);
        const band = Math.max(0.05, plan.penumbra * 1.7, texel * 2.5);
        let tested = 0;
        let outsideMismatch = 0;
        let insideMiss = 0;
        let insideMin = 1;
        const mismatches = [];
        const pixelOf = (c, p) => [
          Math.round(((p + plan.crossPlane / 2) / plan.crossPlane) * W),
          Math.round((1 - (c - plan.sweep / 2 + plan.alongPlane / 2) / plan.alongPlane) * H),
        ];
        for (let i = -8; i <= 8; i += 1) {
          for (let j = -8; j <= 8; j += 1) {
            const c = plan.sweep / 2 + (plan.alongPlane / 2) * (i / 8);
            const p = (plan.crossPlane / 2) * (j / 8);
            const coverage = coverageAt(c, p);
            if (coverage === null) continue;
            const isIn = inside(c, p);
            const dist = distToShape(c, p);
            if (Math.abs(dist) <= band) continue;
            if (!isIn) {
              tested += 1;
              if (coverage > 0.06) {
                outsideMismatch += 1;
                if (mismatches.length < 6) {
                  mismatches.push({ kind: "outside", c: round(c, 2), p: round(p, 2), coverage: round(coverage, 3),
                                    dist: round(dist, 3), px: pixelOf(c, p) });
                }
              }
            } else {
              tested += 1;
              insideMin = Math.min(insideMin, coverage);
              if (coverage < 0.94) {
                insideMiss += 1;
                if (mismatches.length < 6) {
                  mismatches.push({ kind: "inside", c: round(c, 2), p: round(p, 2), coverage: round(coverage, 3),
                                    dist: round(-dist, 3), px: pixelOf(c, p) });
                }
              }
            }
          }
        }
        return {
          grid: {
            tested, outsideMismatch, insideMiss, band: round(band, 2), texel: round(texel, 3), canvas: [W, H],
            mismatches, insideMin: round(insideMin, 3), penumbra: plan.penumbra,
          },
          areaTrue: plan.areaTrue,
          areaRect: plan.areaRect,
          scale: [round(shadowMesh.scale.x, 2), round(shadowMesh.scale.y, 2)],
        };
      }

      /** 世界点投影到屏幕像素；落在画面外就返回 null。 */
      function toScreenPoint(vector, camera, renderer) {
        const size = renderer.getDrawingBufferSize(new THREE.Vector2());
        const p = vector.clone().project(camera);
        if (!Number.isFinite(p.x) || p.x < -0.98 || p.x > 0.98 || p.y < -0.98 || p.y > 0.98) return null;
        return [Math.round((p.x * 0.5 + 0.5) * size.x), Math.round((p.y * 0.5 + 0.5) * size.y)];
      }

      /** 两帧在同一像素上的 RGB 差（>=26 视为"肉眼可见地变了"，与其它探针同一阈值）。 */
      function framePixelDelta(a, b, x, y) {
        if (x < 0 || y < 0 || x >= a.width || y >= a.height) return null;
        const i = (y * a.width + x) * 4;
        return Math.abs(a.buf[i] - b.buf[i]) + Math.abs(a.buf[i + 1] - b.buf[i + 1])
          + Math.abs(a.buf[i + 2] - b.buf[i + 2]);
      }

      /**
       * 车辆接地阴影：逐辆读它的方案（cot、车高、跨度、影子方向），并把平面长轴换算到世界，
       * 核对它是否真的指向影子方向 —— 只比数值容易被"平面转错 90°"骗过。
       */
      function vehicleShadowReport(scene) {
        const list = [];
        scene.traverse((node) => {
          if (node.name !== "contactShadow" || !node.userData || !node.userData.shadowPlan) return;
          const plan = node.userData.shadowPlan;
          node.updateWorldMatrix(true, false);
          const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(node.getWorldQuaternion(new THREE.Quaternion()));
          const localAxis = new THREE.Vector3(0, 1, 0).applyEuler(node.rotation);
          const length = Math.hypot(axis.x, axis.z);
          const dot = length > 1e-6
            ? (axis.x / length) * plan.shadowDir[0] + (axis.z / length) * plan.shadowDir[1]
            : 0;
          // 局部量不受转台转动影响：转台每帧在转，世界量在"读"的这一刻必然与"算"的那一刻差一点
          const planRel = THREE.MathUtils.degToRad(plan.relDeg || 0);
          const localDot = localAxis.x * Math.sin(planRel) + localAxis.z * Math.cos(planRel);
          const parent = node.parent;
          const origin = new THREE.Vector3();
          if (parent) parent.getWorldPosition(origin);
          list.push({
            cot: plan.cot,
            height: plan.height,
            sweep: plan.sweep,
            proj: plan.proj,
            cross: plan.cross,
            along: plan.along,
            crossPlane: plan.crossPlane,
            alongPlane: plan.alongPlane,
            penumbra: plan.penumbra,
            width: plan.width,
            length: plan.length,
            areaTrue: plan.areaTrue,
            areaRect: plan.areaRect,
            relDeg: plan.relDeg,
            shadowDir: plan.shadowDir,
            offsetWorldDir: plan.offsetWorldDir || null,
            anchor: plan.anchor || null,
            yawDeg: plan.yawDeg,
            scaleX: round(node.scale.x, 2),
            scaleY: round(node.scale.y, 2),
            offset: round(Math.hypot(node.position.x, node.position.z), 2),
            offsetDir: node.userData.shadowPlan.sweep > 0
              ? [round(node.position.x / (plan.sweep / 2 || 1), 2), round(node.position.z / (plan.sweep / 2 || 1), 2)]
              : null,
            worldAxis: [round(axis.x / (length || 1), 3), round(axis.z / (length || 1), 3)],
            // 这层是"乘法贴图"：白=不变、色调=影子里剩下的天光。下面几项把它查实。
            multiply: Boolean(node.material && node.material.blending === THREE.MultiplyBlending),
            toneMapped: node.material ? node.material.toneMapped : null,
            materialFog: node.material ? node.material.fog : null,
            baseColor: node.material
              ? [round(node.material.color.r, 3), round(node.material.color.g, 3), round(node.material.color.b, 3)]
              : null,
            tint: plan.tint || null,
            texture: shadowTextureProbe(node.material && node.material.map, plan),
            axisErrorDeg: round(THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.max(-1, dot)))), 2),
            localAxisErrorDeg: round(THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.max(-1, localDot)))), 3),
            origin: [round(origin.x, 2), round(origin.z, 2)],
          });
        });
        return list;
      }

      /**
       * 车身在地面上的投影中心（**不含**那片影子）：车体组的原点常在车头/挂车一端，
       * 直接拿它当"车身位置"会把重心方向算歪。量的时候先把影子藏起来。
       */
      function footprintCentre(parent, shadowMesh) {
        const was = shadowMesh.visible;
        shadowMesh.visible = false;
        const box = new THREE.Box3().setFromObject(parent);
        shadowMesh.visible = was;
        return new THREE.Vector3((box.min.x + box.max.x) / 2, 0.011, (box.min.z + box.max.z) / 2);
      }

      /**
       * 只藏一辆车的接地阴影，量差异像素：面积，以及"影子重心相对车身位置"的走向。
       * 前者证明影子真的画进了画面，后者证明它落在背离太阳的一侧（形状长什么样先不管，
       * 长条车身的影子本来就可能是一块宽板，主轴未必沿影子方向——比重心方向才稳）。
       */
      /**
       * 影子颜色/深浅的**独立复算**：直接从场景里的太阳光、半球光与天空穹顶的画布算一遍
       * `天光 / (天光 + 直射)`。页面里那一份是 setupSky 自己算的，这里换一套读数（天空贴图的像素）
       * 再算一遍，两条路对得上才算"影色来自这套光照"。
       */
      function shadowLightReport(scene) {
        let sun = null;
        let hemi = null;
        let dome = null;
        scene.traverse((node) => {
          if (!sun && node.isDirectionalLight) sun = node;
          if (!hemi && node.isHemisphereLight) hemi = node;
          if (!dome && node.name === "skyDome") dome = node;
        });
        if (!sun || !hemi) return null;
        const canvas = dome && dome.material && dome.material.map ? dome.material.map.image : null;
        let sky = [0.25, 0.38, 0.62];
        let haloShare = 0;
        let halo = null;
        const bands = [];
        const sampleCanvas = (canvasImage, w, h) => {
          const small = document.createElement("canvas");
          small.width = w;
          small.height = h;
          const ctx = small.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(canvasImage, 0, 0, w, h);
          return ctx.getImageData(0, 0, w, h).data;
        };
        // 日面只有 44px（在 2048 宽的图上），32×16 会把整颗太阳平均掉 —— 找太阳用细网格
        if (canvas && canvas.getContext) {
          const w = 128;
          const h = 64;
          const data = sampleCanvas(canvas, w, h);
          const sunDirection = sun.position.clone().normalize();
          for (let j = 0; j < h; j += 1) {
            const theta = ((j + 0.5) / h) * Math.PI;
            if (theta >= Math.PI / 2) break;
            for (let i = 0; i < w; i += 1) {
              const k = (j * w + i) * 4;
              const luma = srgbToLinear(data[k] / 255) + srgbToLinear(data[k + 1] / 255) + srgbToLinear(data[k + 2] / 255);
              if (halo && luma <= halo.luma) continue;
              const phi = (((i + 0.5) / w) - 0.5) * Math.PI * 2;
              const sinTheta = Math.sin(theta);
              const dir = [Math.cos(phi) * sinTheta, Math.cos(theta), Math.sin(phi) * sinTheta];
              const dot = dir[0] * sunDirection.x + dir[1] * sunDirection.y + dir[2] * sunDirection.z;
              halo = {
                luma: round(luma, 3),
                angleDeg: round(THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.max(-1, dot)))), 1),
                uv: [round((i + 0.5) / w, 3), round((j + 0.5) / h, 3)],
              };
            }
          }
        }
        if (canvas && canvas.getContext) {
          const w = 32;
          const h = 16;
          const data = sampleCanvas(canvas, w, h);
          // 天空画布上几个已知位置（uv 的 v 从画布顶边算）：天顶该是蓝的、地面半天该是暗的。
          // 这条同时守住"云别用加法叠到整片纯白"——曾经 768 宽的天空上半球全是 255,255,255，
          // 天空变白幕、影子也算不出冷色。
          try {
            const fctx = canvas.getContext("2d");
            for (const [name, u, v] of [["天顶", 0.5, 0.02], ["中天", 0.5, 0.28], ["地平线", 0.5, 0.5], ["地面半天", 0.5, 0.9]]) {
              const px = Math.min(canvas.width - 1, Math.max(0, Math.round(u * canvas.width)));
              const py = Math.min(canvas.height - 1, Math.max(0, Math.round(v * canvas.height)));
              const d = fctx.getImageData(px, py, 1, 1).data;
              bands.push({ name, rgb: [d[0], d[1], d[2]] });
            }
          } catch (error) {
            bands.push({ name: "读取失败", error: String(error) });
          }
          // 与页面同一套：等距柱状投影 + 扣掉日面/日晕（那是直射散射，已算在直射项里）
          const sunDirection = sun.position.clone().normalize();
          const excludeCos = Math.cos(THREE.MathUtils.degToRad(30));
          const sum = [0, 0, 0];
          let weight = 0;
          let excluded = 0;
          for (let j = 0; j < h; j += 1) {
            const theta = ((j + 0.5) / h) * Math.PI;
            if (theta >= Math.PI / 2) break;
            const wj = Math.cos(theta) * Math.sin(theta);
            for (let i = 0; i < w; i += 1) {
              const phi = (((i + 0.5) / w) - 0.5) * Math.PI * 2;
              const sinTheta = Math.sin(theta);
              const dir = [Math.cos(phi) * sinTheta, Math.cos(theta), Math.sin(phi) * sinTheta];
              const dot = dir[0] * sunDirection.x + dir[1] * sunDirection.y + dir[2] * sunDirection.z;
              const k = (j * w + i) * 4;
              if (dot > excludeCos) {
                excluded += wj;
                continue;
              }
              sum[0] += srgbToLinear(data[k] / 255) * wj;
              sum[1] += srgbToLinear(data[k + 1] / 255) * wj;
              sum[2] += srgbToLinear(data[k + 2] / 255) * wj;
            }
            weight += wj * w;
          }
          if (weight > 0) sky = sum.map((v) => v / weight);
          haloShare = excluded / Math.max(1e-6, excluded + weight);
        }
        const sinElev = Math.max(0.05, sun.position.clone().normalize().y);
        const sunColor = [sun.color.r, sun.color.g, sun.color.b];
        const hemiColor = [hemi.color.r, hemi.color.g, hemi.color.b];
        const direct = sunColor.map((c) => c * sun.intensity * sinElev);
        // 环境贴图那一份：three 的间接漫反射是 π × PMREM，而 sky 是"辐照度/π"；路面 envMapIntensity=0.35
        const ambient = hemiColor.map((c, i) => c * hemi.intensity + Math.PI * sky[i] * 0.35);
        return {
          sunIntensity: sun.intensity,
          hemiIntensity: hemi.intensity,
          skyDebug: window.__skySampleDebug || null,
          skyBands: bands,
          sinElev: round(sinElev, 3),
          skyAverage: sky.map((v) => round(v, 3)),
          sunHaloShare: round(haloShare, 3),
          halo,
          direct: direct.map((v) => round(v, 3)),
          ambient: ambient.map((v) => round(v, 3)),
          ratio: ambient.map((a, i) => round(a / (a + direct[i]), 3)),
        };
      }

      /**
       * 影子真正压暗了多少、往哪个方向偏色：只统计"藏掉影子就会变"的那些像素，
       * 比较同一点上有影子/没影子的颜色。影子里的地面只剩天光，所以除了更暗，还该更蓝。
       */
      function shadowToneReport(withIt, withoutIt, threshold = 26) {
        let count = 0;
        const lit = [0, 0, 0];
        const dark = [0, 0, 0];
        for (let i = 0; i < withIt.buf.length; i += 4) {
          const delta = Math.abs(withIt.buf[i] - withoutIt.buf[i])
            + Math.abs(withIt.buf[i + 1] - withoutIt.buf[i + 1])
            + Math.abs(withIt.buf[i + 2] - withoutIt.buf[i + 2]);
          if (delta <= threshold) continue;
          count += 1;
          for (let c = 0; c < 3; c += 1) {
            dark[c] += withIt.buf[i + c];
            lit[c] += withoutIt.buf[i + c];
          }
        }
        if (!count) return { pixels: 0 };
        const mean = (list) => list.map((v) => v / count / 255);
        const darkMean = mean(dark);
        const litMean = mean(lit);
        const lum = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
        return {
          pixels: count,
          shadow: darkMean.map((v) => round(v, 3)),
          sunlit: litMean.map((v) => round(v, 3)),
          ratio: darkMean.map((v, i) => round(v / Math.max(1e-6, litMean[i]), 3)),
          luminanceRatio: round(lum(darkMean) / Math.max(1e-6, lum(litMean)), 3),
          blueRedShadow: round(darkMean[2] / Math.max(1e-6, darkMean[0]), 3),
          blueRedSunlit: round(litMean[2] / Math.max(1e-6, litMean[0]), 3),
        };
      }

      function shadowPixelReport(renderer, scene, camera, shadowMesh, shadowDir, origin) {
        const previous = shadowMesh.visible;
        const withIt = grab(renderer, scene, camera);
        shadowMesh.visible = false;
        const withoutIt = grab(renderer, scene, camera);
        shadowMesh.visible = previous;
        const width = withIt.width;
        const height = withIt.height;
        let changed = 0;
        let sumX = 0;
        let sumY = 0;
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const i = (y * width + x) * 4;
            const delta = Math.abs(withIt.buf[i] - withoutIt.buf[i])
              + Math.abs(withIt.buf[i + 1] - withoutIt.buf[i + 1])
              + Math.abs(withIt.buf[i + 2] - withoutIt.buf[i + 2]);
            if (delta < 26) continue;
            changed += 1;
            sumX += x;
            sumY += y;
          }
        }
        if (!changed) return { changed: 0, frame: [width, height] };
        // readPixels 第 0 行 = 画面底部：直接用 NDC 换算，两边都在同一套行坐标里
        const toScreen = (vector) => {
          const p = vector.clone().project(camera);
          return [(p.x * 0.5 + 0.5) * width, (p.y * 0.5 + 0.5) * height];
        };
        const centre = [(sumX / changed), (sumY / changed)];
        const base = toScreen(origin);
        const ahead = toScreen(origin.clone().add(new THREE.Vector3(shadowDir[0], 0, shadowDir[1]).multiplyScalar(2)));
        const expect = [ahead[0] - base[0], ahead[1] - base[1]];
        const measured = [centre[0] - base[0], centre[1] - base[1]];
        const angleOf = (v) => Math.atan2(v[1], v[0]);
        let error = THREE.MathUtils.radToDeg(angleOf(measured) - angleOf(expect));
        while (error > 180) error -= 360;
        while (error < -180) error += 360;
        // 光看重心的方位角会被"车身把影子切掉一大块"带偏（长车尤其明显），
        // 所以再沿"影子方向 / 垂直方向"分解一次：沿向均值该落在背光侧，垂直向该互相抵消。
        const span = Math.hypot(expect[0], expect[1]) || 1;      // = 2 米在地面上的像素长度
        const unit = [expect[0] / span, expect[1] / span];
        const perp = [-unit[1], unit[0]];
        let sumAlong = 0;
        let sumPerp = 0;
        let behind = 0;                                          // 落在背光侧的像素数
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const i = (y * width + x) * 4;
            const delta = Math.abs(withIt.buf[i] - withoutIt.buf[i])
              + Math.abs(withIt.buf[i + 1] - withoutIt.buf[i + 1])
              + Math.abs(withIt.buf[i + 2] - withoutIt.buf[i + 2]);
            if (delta < 26) continue;
            const vx = x - base[0];
            const vy = y - base[1];
            const a = vx * unit[0] + vy * unit[1];
            sumAlong += a;
            sumPerp += vx * perp[0] + vy * perp[1];
            if (a > 0) behind += 1;
          }
        }
        return {
          changed,
          frame: [width, height],
          centroid: [round(centre[0], 1), round(centre[1], 1)],
          originScreen: [round(base[0], 1), round(base[1], 1)],
          expectedDeg: round(THREE.MathUtils.radToDeg(angleOf(expect)), 1),
          measuredDeg: round(THREE.MathUtils.radToDeg(angleOf(measured)), 1),
          directionErrorDeg: round(Math.abs(error), 1),
          pxPerMetre: round(span / 2, 1),
          alongMeanM: round(sumAlong / changed / (span / 2), 2),
          perpMeanM: round(sumPerp / changed / (span / 2), 2),
          behindRatio: round(behind / changed, 3),
          tone: shadowToneReport(withIt, withoutIt),
        };
      }

      /**
       * 栏杆臂的像素级外观：把臂藏起来再画一帧，差异像素就是"臂本身"。
       * 于是可以量它投在屏幕上的形状（横还是竖）、红白涂装的相间段数、以及顶部抬到多高。
       * readPixels 的第 0 行是画面底部，所以 bbox 的 y 越大越靠上。
       */
      function armPixelReport(renderer, scene, camera, pivot) {
        const previous = pivot.visible;
        pivot.visible = false;
        const without = grab(renderer, scene, camera);
        pivot.visible = previous;
        const withArm = grab(renderer, scene, camera);
        const width = withArm.width;
        const height = withArm.height;
        const mask = new Uint8Array(width * height);
        let x0 = width, x1 = -1, y0 = height, y1 = -1, changed = 0;
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const i = (y * width + x) * 4;
            const delta = Math.abs(withArm.buf[i] - without.buf[i])
              + Math.abs(withArm.buf[i + 1] - without.buf[i + 1])
              + Math.abs(withArm.buf[i + 2] - without.buf[i + 2]);
            if (delta < 30) continue;
            changed += 1;
            mask[y * width + x] = 1;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
        // 分类用**相对**亮度而不是绝对阈值：天空换成真实蓝天之后环境光低了一档，
        // "白 > 185"会把白涂装判成"其他"，红白相间就数不出来了（红=415/白=127 却只有 1 次换色）。
        // 红：与蓝通道比（不受整体明暗影响）；白：非红像素里亮度高于中位数的那半边。
        const isRed = (r, b) => (r - b) > 42 && r > 95;
        const lumaOf = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const lumas = [];
        for (let i = 0; i < mask.length; i += 1) {
          if (mask[i] !== 1) continue;
          const k = i * 4;
          if (isRed(withArm.buf[k], withArm.buf[k + 2])) continue;
          lumas.push(lumaOf(withArm.buf[k], withArm.buf[k + 1], withArm.buf[k + 2]));
        }
        lumas.sort((a, b) => a - b);
        const lightLuma = lumas.length ? lumas[Math.floor(lumas.length * 0.5)] : 0;
        let red = 0, white = 0, other = 0;
        for (let i = 0; i < mask.length; i += 1) {
          if (mask[i] !== 1) continue;
          const k = i * 4;
          const r = withArm.buf[k], g = withArm.buf[k + 1], b = withArm.buf[k + 2];
          if (isRed(r, b)) red += 1;
          else if (lumaOf(r, g, b) >= lightLuma) white += 1;
          else other += 1;
        }
        const kindAt = (x, y) => {
          if (x < 0 || y < 0 || x >= width || y >= height) return null;
          if (mask[y * width + x] !== 1) return null;
          const i = (y * width + x) * 4;
          const r = withArm.buf[i], g = withArm.buf[i + 1], b = withArm.buf[i + 2];
          if (isRed(r, b)) return "red";
          if (lumaOf(r, g, b) >= lightLuma) return "white";
          return "other";
        };
        const boxWidth = changed ? x1 - x0 + 1 : 0;
        const boxHeight = changed ? y1 - y0 + 1 : 0;
        const horizontal = boxWidth >= boxHeight;
        // 沿长轴走中线，数"红 ↔ 白"换了几次 —— 涂装相间的直接证据
        let alternations = 0;
        let last = null;
        const steps = horizontal ? boxWidth : boxHeight;
        for (let s = 0; s < steps; s += 1) {
          const x = horizontal ? x0 + s : Math.round((x0 + x1) / 2);
          const y = horizontal ? Math.round((y0 + y1) / 2) : y0 + s;
          const kind = kindAt(x, y);
          if (kind === null || kind === "other") continue;
          if (last !== null && kind !== last) alternations += 1;
          last = kind;
        }
        return {
          changed,
          red,
          white,
          other,
          boxWidth,
          boxHeight,
          aspect: boxHeight > 0 ? round(boxWidth / boxHeight, 2) : null,
          horizontal,
          top: changed ? y1 : null,
          bottom: changed ? y0 : null,
          alternations,
          frame: [width, height],
        };
      }

      /** 把 b 平移 (dx,dy) 后与 a 比较：用来判断差异是不是"半像素错位"。 */
      function diffShifted(a, b, dx, dy, stride = 9) {
        let changed = 0, sum = 0, count = 0;
        for (let y = 0; y < a.height; y += stride) {
          const sy = y + dy;
          if (sy < 0 || sy >= a.height) continue;
          for (let x = 0; x < a.width; x += stride) {
            const sx = x + dx;
            if (sx < 0 || sx >= a.width) continue;
            const i = (sy * a.width + sx) * 4;
            const j = (y * a.width + x) * 4;
            const d = Math.abs(a.buf[i] - b.buf[j]) + Math.abs(a.buf[i + 1] - b.buf[j + 1]) + Math.abs(a.buf[i + 2] - b.buf[j + 2]);
            sum += d;
            count += 1;
            if (d > 12) changed += 1;
          }
        }
        return { dx, dy, meanDelta: round(sum / count / 3), changedRatio: round(changed / count, 4) };
      }

      /** 差异在画面上的分布：按网格统计平均差与"大差"计数，外加差值最大的几个像素。 */
      function diffMap(a, b, cols = 16, rows = 10, stride = 3) {
        const cells = [];
        for (let r = 0; r < rows; r += 1) cells.push(new Array(cols).fill(0).map(() => ({ sum: 0, n: 0, big: 0 })));
        const worst = [];
        for (let y = 0; y < a.height; y += stride) {
          const row = Math.min(rows - 1, Math.floor((y / a.height) * rows));
          for (let x = 0; x < a.width; x += stride) {
            const i = (y * a.width + x) * 4;
            const d = Math.abs(a.buf[i] - b.buf[i]) + Math.abs(a.buf[i + 1] - b.buf[i + 1]) + Math.abs(a.buf[i + 2] - b.buf[i + 2]);
            const col = Math.min(cols - 1, Math.floor((x / a.width) * cols));
            const cell = cells[row][col];
            cell.sum += d;
            cell.n += 1;
            if (d > 60) cell.big += 1;
            if (worst.length < 6 || d > worst[worst.length - 1].d) {
              worst.push({ d, x, y, direct: [a.buf[i], a.buf[i + 1], a.buf[i + 2]], pipeline: [b.buf[i], b.buf[i + 1], b.buf[i + 2]] });
              worst.sort((p, q) => q.d - p.d);
              if (worst.length > 6) worst.pop();
            }
          }
        }
        return {
          width: a.width,
          height: a.height,
          rows: cells.map((row) => row.map((cell) => (cell.n ? round(cell.sum / cell.n / 3, 1) : 0))),
          bigRows: cells.map((row) => row.map((cell) => cell.big)),
          worst,
        };
      }

      /**
       * 刹车控制器的单元测试：直接喂合成位移，验证"减速才亮 / 停住 2.5 秒后松开 / 突跳重置"三条规则。
       * 回放窗口里车可能大半时间停着，靠采样很难覆盖，所以规则本身单测，回放只做集成印证。
       */
      function brakeControllerUnit(createBrakeController) {
        const dt = 1 / 60;
        const run = (position, seconds) => {
          const controller = createBrakeController();
          const levels = [];
          let previous = position(0);
          const steps = Math.round(seconds / dt);
          for (let i = 1; i <= steps; i += 1) {
            const z = position(i * dt);
            controller.update(dt, z - previous);
            previous = z;
            levels.push(round(controller.level));
          }
          return { controller, levels };
        };
        const max = (list) => (list.length ? Math.max(...list) : 0);
        const at = (levels, seconds) => levels[Math.min(levels.length - 1, Math.round(seconds / dt) - 1)];

        const cruise = run((t) => 8 * t, 3);                                  // 匀速 8m/s
        const decel = run((t) => (t < 3 ? 8 * t - 1.6 * t * t : 8 * 3 - 1.6 * 9), 4);   // 匀减速到停
        const parked = run(() => 0, 6);                                       // 一直停着
        const stoppedAfterStop = run((t) => (t < 1 ? 6 * Math.min(t, 1) : 6), 2);        // 停住前的最后 1 秒

        // 突跳（拖时间轴）必须重置，不能误判成急刹
        const jump = createBrakeController();
        jump.update(1 / 60, 0.5);
        jump.update(1 / 60, 30);            // 30m 的米级突跳
        const afterJump = round(jump.level);

        return {
          cruiseMax: max(cruise.levels),
          cruiseLast: cruise.levels[cruise.levels.length - 1],
          decelMax: max(decel.levels),
          decelFirstHalf: max(decel.levels.slice(0, Math.round(1.5 / dt))),
          parkedAt1s: at(parked.levels, 1),
          parkedAt2s: at(parked.levels, 2),
          parkedAt5s: at(parked.levels, 5),
          stopLastSecondMax: max(stoppedAfterStop.levels),
          afterJump,
        };
      }

      /** 逐一藏起大件背景物体，看"两条路径的差异"是哪一件贡献的。 */
      function isolateReport(renderer, scene, camera, createBloomPipeline) {
        const pipeline = createBloomPipeline(renderer, scene, camera, { enabled: true, samples: 0 });
        pipeline.setEnabled(false);
        const out = {};
        const toggle = (apply) => {
          const direct = grab(renderer, scene, camera);
          const viaPipeline = grabVia(renderer, () => pipeline.render());
          return diffFrames(direct, viaPipeline, 9);
        };
        for (const name of ["skyDome", "groundHaze", "grid", "ground"]) {
          const object = scene.getObjectByName(name);
          if (!object) {
            out[name] = null;
            continue;
          }
          const wasVisible = object.visible;
          object.visible = false;
          out[name] = toggle();
          object.visible = wasVisible;
        }
        const savedFog = scene.fog;
        const directWithFog = grab(renderer, scene, camera);
        const pipelineWithFog = grabVia(renderer, () => pipeline.render());
        scene.fog = null;
        out.fog = diffFrames(directWithFog, grabVia(renderer, () => pipeline.render()), 9);
        out.fogEffect = {
          direct: diffFrames(directWithFog, grab(renderer, scene, camera), 9),
          pipeline: diffFrames(pipelineWithFog, grabVia(renderer, () => pipeline.render()), 9),
        };
        scene.fog = savedFog;
        out.all = toggle();
        pipeline.dispose();
        return out;
      }

      function imageStats(image, stride = 7) {
        const { buf } = image;
        const lumas = [];
        let sum = 0;
        let clip = 0;
        let count = 0;
        for (let y = 0; y < image.height; y += stride) {
          for (let x = 0; x < image.width; x += stride) {
            const i = (y * image.width + x) * 4;
            const r = buf[i];
            const g = buf[i + 1];
            const b = buf[i + 2];
            const luma = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255;
            sum += luma;
            if (r >= 250 || g >= 250 || b >= 250) clip += 1;
            lumas.push(luma);
            count += 1;
          }
        }
        lumas.sort((a, b) => a - b);
        const top = lumas.slice(Math.max(0, Math.floor(lumas.length * 0.99)));
        return {
          samples: count,
          mean: round(sum / count),
          median: round(lumas[Math.floor(lumas.length / 2)]),
          clip: round(clip / count, 4),
          topPctMean: round(top.reduce((s, v) => s + v, 0) / Math.max(1, top.length)),
        };
      }

      /** 两张帧缓冲逐点比较：变亮 / 变暗 / 变化像素占比 + 差值分布。 */
      function diffFrames(a, b, stride = 7) {
        let changed = 0, brighter = 0, darker = 0, sum = 0, count = 0;
        let over24 = 0, over60 = 0, maxDelta = 0;
        let brighterSum = 0, darkerSum = 0;
        for (let y = 0; y < a.height; y += stride) {
          for (let x = 0; x < a.width; x += stride) {
            const i = (y * a.width + x) * 4;
            const dr = b.buf[i] - a.buf[i];
            const dg = b.buf[i + 1] - a.buf[i + 1];
            const db = b.buf[i + 2] - a.buf[i + 2];
            const d = Math.abs(dr) + Math.abs(dg) + Math.abs(db);
            sum += d;
            count += 1;
            if (d > maxDelta) maxDelta = d;
            if (d > 12) changed += 1;
            if (d > 24) over24 += 1;
            if (d > 60) over60 += 1;
            if (dr > 6 && dg > 6 && db > 6) { brighter += 1; brighterSum += d / 3; }
            if (dr < -6 && dg < -6 && db < -6) { darker += 1; darkerSum += d / 3; }
          }
        }
        return {
          changedRatio: round(changed / count, 4),
          over24Ratio: round(over24 / count, 4),
          over60Ratio: round(over60 / count, 4),
          brighterRatio: round(brighter / count, 4),
          brighterMean: brighter ? round(brighterSum / brighter, 1) : 0,
          darkerRatio: round(darker / count, 4),
          darkerMean: darker ? round(darkerSum / darker, 1) : 0,
          meanDelta: round(sum / count / 3),
          maxDelta: maxDelta,
        };
      }

      function countNamed(root, name) {
        let total = 0;
        root.traverse((o) => { if (o.name === name) total += 1; });
        return total;
      }

      function inspectBrake(model) {
        const lights = model && model.brakeLights;
        if (!lights) return { hasBrakeLights: false };
        const tail = lights.tail;
        const sprite = lights.glows.length ? lights.glows[0] : null;
        let tailMeshes = 0;
        if (model.group) model.group.traverse((o) => { if (o.isMesh && o.material === tail) tailMeshes += 1; });
        const read = () => ({
          emissive: round(tail.emissiveIntensity),
          glow: round(sprite ? sprite.material.opacity : 0),
          glowScale: round(sprite ? sprite.scale.x : 0),
        });
        model.setBrake(1);
        const on = read();
        model.setBrake(0.5);
        const half = read();
        model.setBrake(0);
        const off = read();
        return {
          hasBrakeLights: true,
          tailMeshes,
          glows: lights.glows.length,
          materialIsPerVehicle: tail.uuid,
          glowIsPerVehicle: sprite ? sprite.material.uuid : null,
          on,
          half,
          off,
          emissiveIdleBack: round(tail.emissiveIntensity),
        };
      }

      /** 按"画面行"统计变化像素占比：用来验证某一层到底画在画面的哪个部位。
       *  注意 `gl.readPixels` 从**左下角**开始读，所以 profile[0] 是画面**底部**，
       *  这一点搞反会把"地面"和"天空"的结论整个倒过来。 */
      function rowProfile(a, b, rows = 10, stride = 4) {
        const changed = new Array(rows).fill(0);
        const totals = new Array(rows).fill(0);
        for (let y = 0; y < a.height; y += stride) {
          const row = Math.min(rows - 1, Math.floor((y / a.height) * rows));
          for (let x = 0; x < a.width; x += stride) {
            const i = (y * a.width + x) * 4;
            const d = Math.abs(a.buf[i] - b.buf[i]) + Math.abs(a.buf[i + 1] - b.buf[i + 1]) + Math.abs(a.buf[i + 2] - b.buf[i + 2]);
            totals[row] += 1;
            if (d > 12) changed[row] += 1;
          }
        }
        return changed.map((value, row) => (totals[row] ? round(value / totals[row], 4) : 0));
      }

      function shareOf(profile, from, to) {
        const slice = profile.slice(from, to);
        const total = profile.reduce((sum, value) => sum + value, 0);
        return total ? round(slice.reduce((sum, value) => sum + value, 0) / total, 3) : 0;
      }

      /** 整帧平均亮度（0~1），用来判断"改动是否只是把画面整体提亮/压暗"。 */
      function frameMean(image, stride = 7) {
        let sum = 0;
        let count = 0;
        for (let y = 0; y < image.height; y += stride) {
          for (let x = 0; x < image.width; x += stride) {
            const i = (y * image.width + x) * 4;
            sum += (image.buf[i] + image.buf[i + 1] + image.buf[i + 2]) / 3;
            count += 1;
          }
        }
        return round(sum / count / 255, 4);
      }

      /**
       * 地表风化（weathering 组）与远景层次（distant 组）的因果检验 + 粗糙度贴片的"只改反射"验证。
       * 都靠"藏起来再回读帧缓冲"判断，不看截图。
       */
      function siteDetailReport(renderer, scene, camera) {
        const weathering = scene.getObjectByName("weathering");
        const distant = scene.getObjectByName("distant");
        const baseline = grab(renderer, scene, camera);
        const compare = (object, cam, base) => {
          if (!object) return null;
          object.visible = false;
          const without = grab(renderer, scene, cam);
          object.visible = true;
          const profile = rowProfile(base, without, 10);
          return Object.assign(diffFrames(base, without, 7), {
            // profile[0] 是画面底部（readPixels 从左下角读）
            rows: profile,
            bottomShare: shareOf(profile, 0, 5),
            topShare: shareOf(profile, 5, 10),
          });
        };
        const weatheringDiff = compare(weathering, camera, baseline);
        const distantDefault = compare(distant, camera, baseline);

        // 多车道页默认是 58m 高的俯视（45° 视场只覆盖水平线以下 14.9°~59.9°），地平线根本不在画面里，
        // 所以远景层另用一个"能看见地平线"的探针机位来验证确实入画（探针自己的相机，不动页面相机）。
        const horizonCamera = camera.clone();
        horizonCamera.position.set(0, 14, 190);
        horizonCamera.up.set(0, 1, 0);
        horizonCamera.lookAt(0, 8, -60);
        horizonCamera.updateMatrixWorld(true);
        const horizonBaseline = grab(renderer, scene, horizonCamera);
        const distantHorizon = compare(distant, horizonCamera, horizonBaseline);

        // 粗糙度贴片：清掉它以后漫反射亮度应该几乎不变（它只该影响反射那一项）
        const materials = new Set();
        scene.traverse((object) => {
          if (!object.isMesh) return;
          const list = Array.isArray(object.material) ? object.material : [object.material];
          list.forEach((material) => { if (material && material.roughnessMap) materials.add(material); });
        });
        let roughnessDiff = null;
        if (materials.size) {
          const saved = new Map();
          materials.forEach((material) => {
            saved.set(material, material.roughnessMap);
            material.roughnessMap = null;
            material.needsUpdate = true;
          });
          const without = grab(renderer, scene, camera);
          saved.forEach((texture, material) => { material.roughnessMap = texture; material.needsUpdate = true; });
          const restored = grab(renderer, scene, camera);
          roughnessDiff = Object.assign(diffFrames(baseline, without, 7), {
            materials: materials.size,
            // 粗糙度只该改"反射/高光"那一项，整帧平均亮度应当基本不动
            meanWithMap: frameMean(baseline),
            meanWithoutMap: frameMean(without),
            restoredVsBaseline: diffFrames(baseline, restored, 7).changedRatio,
          });
        }

        return {
          counts: {
            stainDecal: countNamed(scene, "stainDecal"),
            patchRepair: countNamed(scene, "patchRepair"),
            crack: countNamed(scene, "crack"),
            drainChannel: countNamed(scene, "drainChannel"),
            drainGrate: countNamed(scene, "drainGrate"),
            manholeSeat: countNamed(scene, "manholeSeat"),
            manholeCover: countNamed(scene, "manholeCover"),
            farHill: countNamed(scene, "farHill"),
            farBuilding: countNamed(scene, "farBuilding"),
            farRoof: countNamed(scene, "farRoof"),
            farSilo: countNamed(scene, "farSilo"),
            farTreeGroup: countNamed(scene, "farTrees"),
          },
          declared: {
            weathering: (weathering && weathering.userData.counts) || null,
            distant: (distant && distant.userData.counts) || null,
          },
          children: {
            weathering: weathering ? weathering.children.length : 0,
            distant: distant ? distant.children.length : 0,
          },
          weathering: weatheringDiff,
          distant: distantDefault,
          distantHorizon: distantHorizon,
          roughness: roughnessDiff,
        };
      }

      /**
       * 静态构件硬影层（propShadows）自检。
       * 这一层是**解析投影**：平行光下 (x,y,z) → (x + dir·cot·y, z)，所以每个构件的影长、偏移、
       * 轮廓重心都能用几何公式独立复算（影长 = cot × 自身高度、偏移 = cot × 离地高度）。
       * 这里只报"实际画出来的数"，公式核对放在 Python 侧（报告里那份代码不参与断言）。
       */
      function propShadowReport(renderer, scene, camera) {
        const group = scene.getObjectByName("propShadows");
        const solid = scene.getObjectByName("propShadowMesh");
        const canopy = scene.getObjectByName("propShadowCanopyMesh");
        const mesh = solid || canopy;
        const baseline = grab(renderer, scene, camera);
        if (group) group.visible = false;
        const without = grab(renderer, scene, camera);
        if (group) group.visible = true;
        const restored = grab(renderer, scene, camera);
        const profile = rowProfile(baseline, without, 10);
        const withLayer = diffFrames(without, baseline, 7);
        // 树冠单独藏一次：确认那一片斑驳的树影真的画上了（形状的核对在 Python 侧按簇的几何做）
        if (canopy) canopy.visible = false;
        const withoutCanopy = grab(renderer, scene, camera);
        if (canopy) canopy.visible = true;
        const canopyOnly = diffFrames(withoutCanopy, baseline, 7);
        const data = mesh && mesh.userData ? mesh.userData : {};
        return Object.assign(withLayer, {
          // 这一层合并成 1~2 个 Mesh 画（不是 InstancedMesh），实例数看 userData
          count: mesh ? (mesh.isInstancedMesh ? mesh.count : (data.count || 0)) : 0,
          declared: data.count || 0,
          candidates: data.candidates || 0,
          kinds: data.kinds || null,
          byName: data.byName || null,
          vertices: data.vertices || 0,
          area: data.area || 0,
          shadow: data.shadow || null,
          samples: data.samples || null,
          dapple: data.dapple || null,
          clumpExamples: data.clumpExamples || null,
          canopyModes: data.canopyModes || null,
          parts: { solid: data.solidCount || 0, canopy: data.canopyCount || 0,
                   solidVertices: (solid && solid.userData.partVertices) || 0,
                   canopyVertices: (canopy && canopy.userData.partVertices) || 0 },
          dropped: data.dropped || null,
          canopyOnlyRatio: canopyOnly.changedRatio,
          canopyOnlyDarker: canopyOnly.darkerRatio,
          rows: profile,
          bottomShare: shareOf(profile, 0, 5),
          topShare: shareOf(profile, 5, 10),
          restoredVsBaseline: diffFrames(baseline, restored, 7).changedRatio,
          tone: shadowToneReport(baseline, without),
          material: mesh ? {
            multiply: mesh.material.blending === THREE.MultiplyBlending,
            toneMapped: mesh.material.toneMapped,
            fog: mesh.material.fog,
            vertexColors: mesh.material.vertexColors,
            depthWrite: mesh.material.depthWrite,
          } : null,
        });
      }

      /**
       * 接地暗部（contactAO）自检：藏起来看画面变化 + 假影方向/拉长的几何单测。
       * 假影长度和偏移都是从太阳高度角推出来的（影长 = 高度 × cot(高度角)），所以这里能逐实例核对。
       */
      function contactAOReport(renderer, scene, camera) {
        const group = scene.getObjectByName("contactAO");
        const mesh = scene.getObjectByName("contactAOMesh");
        const baseline = grab(renderer, scene, camera);
        if (group) group.visible = false;
        const without = grab(renderer, scene, camera);
        if (group) group.visible = true;
        const restored = grab(renderer, scene, camera);
        const profile = rowProfile(baseline, without, 10);
        // 注意方向：baseline 是"有暗部"的那一帧，去掉它画面会变亮。
        // 想知道"加上暗部"的效果就得反过来比（without → baseline），否则会把压暗读成提亮。
        const withAO = diffFrames(without, baseline, 7);
        return Object.assign(withAO, {
          count: mesh ? mesh.count : 0,
          declared: mesh && mesh.userData ? mesh.userData.count : 0,
          candidates: mesh && mesh.userData ? mesh.userData.candidates : 0,
          grounded: mesh && mesh.userData ? mesh.userData.grounded : 0,
          xRange: mesh && mesh.userData ? mesh.userData.xRange : null,
          zRange: mesh && mesh.userData ? mesh.userData.zRange : null,
          shadow: mesh && mesh.userData ? mesh.userData.shadow : null,
          byName: mesh && mesh.userData ? mesh.userData.byName : null,
          samples: mesh && mesh.userData ? mesh.userData.samples : null,
          rows: profile,
          bottomShare: shareOf(profile, 0, 5),
          topShare: shareOf(profile, 5, 10),
          skyShare: shareOf(profile, 8, 10),
          restoredVsBaseline: diffFrames(baseline, restored, 7).changedRatio,
        });
      }

      /**
       * 天空自检：把天空穹顶藏起来前后各采一帧，差出来的像素就是**天空掩膜**（别的东西都在，
       * 只有天被换掉了）—— 比任何"猜哪儿是天"的规则都稳。
       * 在掩膜上量：云量（又亮又几乎不偏色的块）、云的细部（相邻像素梯度）、
       * 画面顶部那一带的细部（纯渐变的天空这里几乎是 0）、以及有没有过曝成白幕。
       *
       * 两个机位都要量，因为**默认机位根本看不到天**：lanes 默认是 58m 高的俯视
       * （45° 视场只覆盖水平线以下 14.9°~59.9°），展台是近景转台 —— 天空像素都是 0。
       * 所以另开一个抬高 17° 的探针机位（不动页面相机），并且**把穹顶挪过去**：
       * 天穹是按 `followSky(camera)` 挂在相机上的，不挪的话 200m 外的机位在球壳外面，天会凭空消失。
       */
      function skyReport(renderer, scene, camera) {
        let dome = null;
        scene.traverse((node) => { if (!dome && node.name === "skyDome") dome = node; });
        const lum = (buf, i) => 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];

        function maskStats(view) {
          const baseline = grab(renderer, scene, view);
          if (dome) dome.visible = false;
          const without = grab(renderer, scene, view);
          if (dome) dome.visible = true;
          const W = baseline.width;
          const H = baseline.height;
          const isSky = (i) => Math.abs(baseline.buf[i] - without.buf[i])
            + Math.abs(baseline.buf[i + 1] - without.buf[i + 1])
            + Math.abs(baseline.buf[i + 2] - without.buf[i + 2]) > 6;
          let pixels = 0;
          let sum = 0;
          let sum2 = 0;
          let cloudish = 0;
          let clipped = 0;
          let detail = 0;
          let detailN = 0;
          // 画面顶部 20% 的行。注意 readPixels 从左下角读，所以"顶部"是 y 大的那一头。
          const topRows = Math.max(1, Math.round(H * 0.2));
          let topPixels = 0;
          let topCloud = 0;
          let topSum = 0;
          let topDetail = 0;
          let topDetailN = 0;
          const rowSky = new Array(10).fill(0);
          for (let y = 0; y < H; y += 1) {
            for (let x = 0; x < W; x += 1) {
              const i = (y * W + x) * 4;
              if (!isSky(i)) continue;
              pixels += 1;
              rowSky[Math.min(9, Math.floor((y / H) * 10))] += 1;
              const l = lum(baseline.buf, i);
              sum += l;
              sum2 += l * l;
              const r = baseline.buf[i];
              const g = baseline.buf[i + 1];
              const b = baseline.buf[i + 2];
              const mx = Math.max(r, g, b);
              const mn = Math.min(r, g, b);
              const sat = mx === 0 ? 0 : (mx - mn) / mx;
              const whitish = l > 205 && sat < 0.1;
              if (whitish) cloudish += 1;
              if (l >= 253) clipped += 1;
              const inTop = y >= H - topRows;
              if (inTop) {
                topPixels += 1;
                topSum += l;
                if (whitish) topCloud += 1;
              }
              if (x + 1 < W && isSky(i + 4)) {
                const dl = Math.abs(l - lum(baseline.buf, i + 4));
                detail += dl;
                detailN += 1;
                if (inTop) { topDetail += dl; topDetailN += 1; }
              }
            }
          }
          return {
            pixels,
            share: pixels / (W * H),
            meanLum: pixels ? sum / pixels : 0,
            stdLum: pixels ? Math.sqrt(Math.max(0, sum2 / pixels - (sum / pixels) ** 2)) : 0,
            cloudish: pixels ? cloudish / pixels : 0,
            clipped: pixels ? clipped / pixels : 0,
            detail: detailN ? detail / detailN : 0,
            topShare: pixels ? topPixels / pixels : 0,
            topMean: topPixels ? topSum / topPixels : 0,
            topCloud: topPixels ? topCloud / topPixels : 0,
            topDetail: topDetailN ? topDetail / topDetailN : 0,
            rowShare: rowSky.map((n) => n / Math.max(1, pixels)),
          };
        }

        // 云的**净贡献**：用同一个生成器再画一张无云的天空贴图换上去，前后各采一帧。
        // 这是"云到底给画面加了多少东西"的直接量，比"亮且不偏色"这种代理指标靠谱。
        // 尺寸必须与原图一致，否则光是日面大小变化就会被算进差异里。
        function cloudDiff(view) {
          const material = dome && dome.material;
          const originalMap = material ? material.map : null;
          if (!material || !originalMap || !originalMap.image || !originalMap.image.width) return null;
          const withClouds = grab(renderer, scene, view);
          const cloudless = skyCanvasTexture({
            sunAzimuth: 118, sunElevation: 58, size: originalMap.image.width, clouds: false,
          });
          material.map = cloudless;
          material.needsUpdate = true;
          const withoutClouds = grab(renderer, scene, view);
          material.map = originalMap;
          material.needsUpdate = true;
          const grownBack = grab(renderer, scene, view);
          // 方向：从"无云"到"有云"，所以 brighter 是云把天照亮的那部分、darker 是云底压暗的那部分
          const result = Object.assign(diffFrames(withoutClouds, withClouds, 7), {
            restored: diffFrames(withClouds, grownBack, 7).changedRatio,
          });
          cloudless.dispose();
          return result;
        }

        const savedPosition = dome ? dome.position.clone() : null;
        const skyCamera = camera.clone();
        skyCamera.up.set(0, 1, 0);
        skyCamera.position.set(0, 4, 60);
        skyCamera.lookAt(0, 34, -60);           // 抬约 17°：低仰角那一条，画面下半留一条地平线做参照
        skyCamera.updateMatrixWorld(true);
        if (dome) dome.position.copy(skyCamera.position);
        const mid = maskStats(skyCamera);
        const cloudOnlyMid = cloudDiff(skyCamera);   // 低仰角那条：按"平云层"该比较空，量出来做对照
        // 高仰角机位：云在一个水平云层上时**可见云量随仰角增大**（低仰角那一条被地面透视压掉了），
        // 所以"云进没进画面"必须抬到 ~55° 看，17° 那条本来就该空 —— 两个机位的差别本身就是证据。
        skyCamera.position.set(0, 4, 30);
        skyCamera.lookAt(0, 90, 0);
        skyCamera.updateMatrixWorld(true);
        if (dome) dome.position.copy(skyCamera.position);
        const up = maskStats(skyCamera);
        const cloudOnly = cloudDiff(skyCamera);
        if (dome && savedPosition) dome.position.copy(savedPosition);

        const map = dome && dome.material && dome.material.map;
        return {
          found: !!dome,
          defaultView: maskStats(camera),
          mid,
          up,
          pitchDeg: Math.round(THREE.MathUtils.radToDeg(Math.atan2(86, 60))),
          cloudOnly,
          cloudOnlyMid,
          clouds: (map && map.userData && map.userData.skyClouds) || null,
        };
      }

      /**
       * 泛光管线自检。
       *  · legacyVsDirect：裸 `renderer.render()`（three 的"不渲到 RT"路径）与管线的差异。
       *    three 在没有 render target 时按 `outputColorSpace` 处理"不受光 uniform"（雾色、背景），
       *    渲到 RT 时按线性工作空间处理，所以两条路线的雾/天空本来就不同 —— 这是**已知差异**，
       *    只记录不断言；管线是正确的那一边。
       *  · pipelineOffNoMsaaVsDirect：关掉泛光的管线（软件渲染走的就是这条）应当与直接渲染一致。
       *  · pipelineOffMsaaVsPipelineOffNoMsaa：4x MSAA 只应影响边缘。
       *  · presets：参数扫描 —— 阈值是在**线性 HDR** 上比的，天空/太阳的线性值远大于 1，
       *    阈值定得太低会把整片天空都当成高光，画面整体发白。
       */
      function bloomReport(renderer, scene, camera, createBloomPipeline) {
        const gl = renderer.getContext();
        const software = createBloomPipeline(renderer, scene, camera, { enabled: false });
        const softwareFrame = grabVia(renderer, () => software.render());

        // 裸 renderer.render()：three 的旧路径，只作为"差异记录"的参照
        const direct = grab(renderer, scene, camera);

        // 同一路径连续两帧的差值，用来定"本来就是静态画面"的噪声底
        const directAgain = grab(renderer, scene, camera);
        const samePathDirect = diffFrames(direct, directAgain, 9);

        // 关掉泛光的管线：分别用「无 MSAA」和「4x MSAA」两种 render target
        const offNoMsaa = createBloomPipeline(renderer, scene, camera, { enabled: true, samples: 0 });
        offNoMsaa.setEnabled(false);
        grabVia(renderer, () => offNoMsaa.render());                       // 第一帧（可能有初始化差异）
        const offNoMsaaA = grabVia(renderer, () => offNoMsaa.render());
        const pipelineOffNoMsaa = grabVia(renderer, () => offNoMsaa.render());
        const samePathPipeline = diffFrames(offNoMsaaA, pipelineOffNoMsaa, 9);
        const offMsaa = createBloomPipeline(renderer, scene, camera, { enabled: true, samples: 4 });
        offMsaa.setEnabled(false);
        grabVia(renderer, () => offMsaa.render());
        const pipelineOffMsaa = grabVia(renderer, () => offMsaa.render());
        const msaaVsNoMsaa = diffFrames(pipelineOffNoMsaa, pipelineOffMsaa, 9);
        // 软件路径与"有 GPU 但关泛光"的路径必须一致（同一页面不能两种画风）
        const softwareVsOffNoMsaa = diffFrames(softwareFrame, pipelineOffNoMsaa, 9);

        // 只留不透明物体再比一次：如果差异消失，说明差异来自"透明混合在哪个色彩空间里做"
        // （直接渲染是往 sRGB 画布上混合，管线是往线性 half-float 缓冲里混合）
        const hidden = [];
        scene.traverse((o) => {
          if (o.isMesh && o.material && (o.material.transparent === true || o.material.blending !== THREE.NormalBlending)) {
            if (o.visible) { o.visible = false; hidden.push(o); }
          }
        });
        const opaqueDirect = grab(renderer, scene, camera);
        const opaquePipeline = grabVia(renderer, () => offNoMsaa.render());
        const opaqueDiff = diffFrames(opaqueDirect, opaquePipeline, 9);
        hidden.forEach((o) => { o.visible = true; });
        const presets = [
          { name: "★ 实际采用", strength: 0.18, radius: 0.45, threshold: 1.4 },
          { name: "A 弱", strength: 0.14, radius: 0.4, threshold: 1.6 },
          { name: "B 中", strength: 0.22, radius: 0.5, threshold: 1.25 },
          { name: "C 太强", strength: 0.34, radius: 0.45, threshold: 0.82 },
          { name: "D 极弱", strength: 0.1, radius: 0.35, threshold: 2.2 },
        ];
        const results = [];
        const presetFrames = [];
        const referenceAgain = grabVia(renderer, () => offNoMsaa.render());
        const referenceStable = diffFrames(pipelineOffNoMsaa, referenceAgain, 9);
        for (const preset of presets) {
          const pipeline = createBloomPipeline(renderer, scene, camera, {
            enabled: true, strength: preset.strength, radius: preset.radius, threshold: preset.threshold,
          });
          grabVia(renderer, () => pipeline.render());                       // 第一帧只当预热
          const bloomed = grabVia(renderer, () => pipeline.render());
          presetFrames.push(bloomed);
          const stats = imageStats(bloomed);
          const diff = diffFrames(referenceAgain, bloomed, 7);
          results.push(Object.assign({}, preset, {
            brighterRatio: diff.brighterRatio,
            brighterMean: diff.brighterMean,
            darkerRatio: diff.darkerRatio,
            darkerMean: diff.darkerMean,
            meanDelta: diff.meanDelta,
            mean: stats.mean,
            clip: stats.clip,
            topPctMean: stats.topPctMean,
          }));
          pipeline.dispose();
        }

        // 无头 + virtual-time-budget 下 Date.now() 也被虚拟化（同步代码段里不走字），
        // 毫秒数测不出来，所以改用与硬件无关的开销指标：一帧的 draw call / 三角形数。
        // 注意 info 默认每次 renderer.render 都重置，而后处理链路里每趟 pass 都会调一次，
        // 必须关掉 autoReset 才能统计整帧。
        const drawCost = (renderFn) => {
          renderer.info.autoReset = false;
          renderer.info.reset();
          renderFn();
          const info = renderer.info.render;
          const result = { calls: info.calls, triangles: info.triangles };
          renderer.info.autoReset = true;
          renderer.info.reset();
          return result;
        };
        const starPipeline = createBloomPipeline(renderer, scene, camera, {
          enabled: true, strength: 0.18, radius: 0.45, threshold: 1.4,
        });
        const cost = {
          direct: drawCost(() => renderer.render(scene, camera)),
          composerOff: drawCost(() => offNoMsaa.render()),
          composerBloom: drawCost(() => starPipeline.render()),
        };
        starPipeline.dispose();

        const report = {
          supported: true,
          msaaSamples: gl.getParameter(gl.SAMPLES),
          sizes: {
            canvas: [gl.drawingBufferWidth, gl.drawingBufferHeight],
            image: [direct.width, direct.height],
            pipeline: [pipelineOffNoMsaa.width, pipelineOffNoMsaa.height],
            composer: [offNoMsaa.composer ? offNoMsaa.composer._width : null, offNoMsaa.composer ? offNoMsaa.composer._height : null],
          },
          shiftScan: [
            diffShifted(direct, pipelineOffNoMsaa, 0, 0),
            diffShifted(direct, pipelineOffNoMsaa, 1, 0),
            diffShifted(direct, pipelineOffNoMsaa, 0, 1),
            diffShifted(direct, pipelineOffNoMsaa, -1, 0),
            diffShifted(direct, pipelineOffNoMsaa, 0, -1),
          ],
          softwarePathVsComposerOff: softwareVsOffNoMsaa,
          softwarePathPostprocessed: Boolean(software.postprocessed),
          msaaVsNoMsaa: msaaVsNoMsaa,
          samePathNoise: { direct: samePathDirect, pipeline: samePathPipeline },
          pipelineOffNoMsaaVsDirect: diffFrames(direct, pipelineOffNoMsaa, 9),
          pipelineOffMsaaVsDirect: diffFrames(direct, pipelineOffMsaa, 9),
          opaqueOnlyVsDirect: opaqueDiff,
          transparentObjects: hidden.length,
          isolation: isolateReport(renderer, scene, camera, createBloomPipeline),
          map: diffMap(direct, pipelineOffNoMsaa),
          stats: { direct: imageStats(direct), pipelineOff: imageStats(pipelineOffNoMsaa) },
          referenceStable: referenceStable,
          presetPairAB: diffFrames(presetFrames[0], presetFrames[4], 7),
          presets: results,
          costMs: cost,
          renderer: (() => {
            const info = gl.getExtension("WEBGL_debug_renderer_info");
            return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "unknown";
          })(),
        };
        offNoMsaa.dispose();
        offMsaa.dispose();
        software.dispose();
        return report;
      }
"""

# ---------------------------------------------------------------------------
# 各页面的探针主体
# ---------------------------------------------------------------------------
TEMPLATES = {
    "index": r"""
      const api = await waitForApi("__REPLAY__", (a) => a.renderer && a.scene && a.camera);
      const out = { page: "index" };
      try {
        const scene = api.scene;
        const renderer = api.renderer;
        const camera = api.camera;
        await until(() => scene.getObjectByName("vehicle")?.userData?.model, 45000);
        await sleep(1200);

        out.errors = window.__ERRORS__.slice(0, 5);
        out.gpu = { software: api.gpu.software, renderer: api.gpu.renderer || null };
        out.loop = api.stats;
        const model = scene.getObjectByName("vehicle")?.userData?.model || null;
        out.vehicleLabel = model ? (model.spec.label || model.spec.kind || "unknown") : null;
        out.brake = model ? inspectBrake(model) : null;
        out.hasContactShadow = Boolean(model && model.contactShadow);
        out.contactShadowCount = countNamed(scene, "contactShadow");

        // 空闲（没播放）时刹车灯必须是灭的
        const tail = model && model.brakeLights ? model.brakeLights.tail : null;
        const idle = [];
        for (let i = 0; i < 12; i += 1) {
          await sleep(90);
          if (tail) idle.push(round(tail.emissiveIntensity));
        }
        out.brakeIdle = {
          samples: idle.length,
          distinct: new Set(idle).size,
          min: idle.length ? Math.min(...idle) : null,
          max: idle.length ? Math.max(...idle) : null,
        };

        out.stats = imageStats(grab(renderer, scene, camera, 7));
        out.sky = skyReport(renderer, scene, camera);
        out.site = siteDetailReport(renderer, scene, camera);
        out.contactAO = contactAOReport(renderer, scene, camera);
        out.propShadows = propShadowReport(renderer, scene, camera);
        out.vehicleShadows = vehicleShadowReport(scene);        // 车辆接地阴影是否也按这颗太阳铺
        out.shadowLight = shadowLightReport(scene);             // 独立复算"影子里还剩多少光"

        // ---- 道闸：状态取自日志的「抬杆到位 / 落杆到位」，行程是动画（要看得出在动、又不许一直不动） ----
        const timeline = api.barrierTimeline || [];
        const flips = [];
        for (let i = 1; i < timeline.length; i += 1) {
          if (timeline[i] !== timeline[i - 1]) flips.push({ index: i, open: timeline[i] });
        }
        out.barrierFlips = flips.length;
        const up = flips.find((item) => item.open);
        const down = flips.find((item) => !item.open);
        if (up) {
          api.setEvent(up.index);
          out.barrierAtTrigger = api.barrier;                 // 刚触发：不许瞬间跳到位
          const lamps = [];
          for (let i = 0; i < 10; i += 1) {
            await sleep(110);
            const pose = api.barrier;
            if (pose) lamps.push(round(pose.lamp));
          }
          out.barrierTravelLamps = { samples: lamps.length, lit: lamps.filter((v) => v > 0.01).length };
          await sleep(1500);
          out.barrierUp = api.barrier;                        // 行程走完：接近竖直、端头抬高
        }
        if (down) {
          api.setEvent(down.index);
          await sleep(1800);
          out.barrierDown = api.barrier;
        }
        // 栏杆测完把时间轴放回第 0 条事件，后面的泛光/画面统计才跟前几轮可比
        api.setEvent(0);
        await sleep(400);

        out.bloom = bloomReport(renderer, scene, camera, createBloomPipeline);
        out.pageBloomEnabled = typeof api.bloom;

        // ---- 深链落点：多车道页下钻会带 ?at=HH:MM:SS.mmm，必须落在那份日志里最近的时刻 ----
        //      命中：这份日志第一条事件是 12:06:54.523，按 12:06:54.524 找应当落在最前面几条；
        //      未命中：给一个离日志很远的时刻，必须拒绝（返回 null 且不改动时间轴）。
        if (api.seekToClock) {
          const hitMs = api.seekToClock("12:06:54.524");   // 返回的是"与目标的毫秒偏差"，没跳成返回 null
          const afterHit = api.currentEvent ? api.currentEvent() : null;
          const missMs = api.seekToClock("11:00:00.000");
          const afterMiss = api.currentEvent ? api.currentEvent() : null;
          out.deepLinkSeek = { hitMs: hitMs, afterHit: afterHit, missMs: missMs, afterMiss: afterMiss };
          api.setEvent(0);
          await sleep(200);
        }

        // ---- 车辆运动学：连续播放（连续推进"日志时间播放头"，不是逐事件跳表）核对
        //      "播放头连续 / 车位置 = 该时刻的轨迹 / 速度是物理量 / 倍速档位真的生效 / 刹车低头 / 停住回正" ----
        if (api.playFrames && api.vehicleState) {
          const run = (rate, frames) => {
            api.setEvent(0);
            return (api.playFrames(frames, 33, rate) || []).map((item) => ({
              i: item.i,
              t: item.playhead === undefined ? null : item.playhead,
              z: item.z === undefined ? null : item.z,
              zWant: item.zWant === undefined ? null : item.zWant,
              passage: null,
              pitch: item.pitchDeg === undefined ? null : item.pitchDeg,
              maxPitch: item.maxPitchDeg === undefined ? null : item.maxPitchDeg,
              accel: item.accel === undefined ? null : item.accel,
              speed: item.speed === undefined ? null : item.speed,
              brake: item.brake === undefined ? null : item.brake,
            }));
          };
          out.suspension = {
            page: "index",
            playSeconds: api.logPlaySeconds,
            samples: run(1, 150),
            samplesSlow: run(0.25, 150),
          };
          api.setEvent(0);
          await sleep(160);
        }
      } catch (error) {
        out.fatal = String((error && error.stack) || error);
      }
      out.errorsAfter = window.__ERRORS__.slice(0, 5);
      await fetch(`http://127.0.0.1:__PORT__/log`, { method: "POST", body: JSON.stringify(out) });
""",
    "lanes": r"""
      const api = await waitForApi("__LANES__", (a) => a.STATE && a.STATE.scene && a.STATE.renderer);
      const out = { page: "lanes" };
      try {
        await until(() => api.STATE && api.STATE.lanes && api.STATE.lanes.length, 60000);
        await sleep(1200);
        out.errors = window.__ERRORS__.slice(0, 5);
        out.gpu = { software: api.STATE.gpu.software, renderer: api.STATE.gpu.renderer || null };
        out.lanes = api.STATE.lanes.length;
        out.passages = api.STATE.lanes.reduce((s, l) => s + l.passages.length, 0);
        out.sceneChildren = api.STATE.scene.children.length;

        const span = api.STATE.span;
        api.seek(span * 0.42);
        await sleep(900);

        const visible = [];
        for (const lane of api.STATE.lanes) {
          const model = api.model(lane.id);
          if (model && model.vehicle && model.vehicle.visible && model.vehicleModel) {
            visible.push({ laneId: lane.id, label: model.vehicleModel.spec.label, model });
          }
        }
        out.visibleVehicles = visible.map((v) => v.label);
        out.brakeMaterialsDistinct = new Set(visible.map((v) => v.model.vehicleModel.brakeLights.tail.uuid)).size;
        out.brakePerVehicle = visible.slice(0, 3).map((v) => Object.assign({ label: v.label }, inspectBrake(v.model.vehicleModel)));
        out.contactShadowCount = countNamed(api.STATE.scene, "contactShadow");

        // 播放一段，采样「位移 → 刹车灯亮度」：刹车灯应该跟着减速走
        const sample = () => {
          const rows = [];
          for (const lane of api.STATE.lanes) {
            const model = api.model(lane.id);
            const built = model && model.vehicleModel;
            if (!built || !model.vehicle.visible || !built.brakeLights) continue;
            rows.push({
              lane: lane.id.slice(-4),
              passage: model.passage,
              z: round(model.vehicle.position.z),                    // 多车道页把位移写在外层 vehicle 上
              e: round(built.brakeLights.tail.emissiveIntensity),
              controller: Boolean(model.brakeController),
            });
          }
          return rows;
        };

        const series = [];
        const last = new Map();
        // 车道页默认是暂停的：先按播放键，让车辆真的在动，才能观察"减速 → 刹车灯"的关系
        api.STATE.playing = true;
        api.LOOP.hold(9000);
        for (let i = 0; i < 44; i += 1) {
          await sleep(110);
          for (const row of sample()) {
            const key = `${row.lane}:${row.passage}`;
            const previous = last.get(key);
            row.dz = previous === undefined ? null : round(row.z - previous);
            last.set(key, row.z);
            if (row.e !== null) series.push(row);
          }
        }
        api.STATE.playing = false;
        api.LOOP.hold(600);
        await sleep(1500);
        const rows = series.filter((r) => r.e !== null && r.controller);
        const moving = rows.filter((r) => r.dz !== null && r.dz > 0.05);
        const stopped = rows.filter((r) => r.dz !== null && Math.abs(r.dz) <= 0.02);
        const share = (list, test) => (list.length ? round(list.filter(test).length / list.length) : null);
        out.brakeBehaviour = {
          samples: rows.length,
          distinctEmissive: new Set(rows.map((r) => r.e)).size,
          minEmissive: rows.length ? Math.min(...rows.map((r) => r.e)) : null,
          maxEmissive: rows.length ? Math.max(...rows.map((r) => r.e)) : null,
          movingSamples: moving.length,
          movingDarkShare: share(moving, (r) => r.e < 0.5),
          stoppedSamples: stopped.length,
          stoppedLitShare: share(stopped, (r) => r.e > 1.9),
          stoppedDarkShare: share(stopped, (r) => r.e < 0.5),
          noController: rows.filter((r) => !r.controller).length,
        };
        out.brakeRule = brakeControllerUnit(createBrakeController);

        const live = visible.length ? visible[0].model.vehicleModel : null;
        out.impactLane = visible.length ? visible[0].laneId : null;
        out.brake = live ? inspectBrake(live) : null;
        out.stats = imageStats(grab(api.STATE.renderer, api.STATE.scene, api.STATE.camera, 7));
        out.sky = skyReport(api.STATE.renderer, api.STATE.scene, api.STATE.camera);
        out.site = siteDetailReport(api.STATE.renderer, api.STATE.scene, api.STATE.camera);
        out.contactAO = contactAOReport(api.STATE.renderer, api.STATE.scene, api.STATE.camera);
        out.propShadows = propShadowReport(api.STATE.renderer, api.STATE.scene, api.STATE.camera);
        // 接地暗部要跟着「细节」开关走：岗亭/设备一关，铺在它们脚下的暗斑必须一起消失
        const aoBefore = api.STATE.contactAO ? api.STATE.contactAO.count : null;
        const aoOff = api.setDetails(false);
        const aoBack = api.setDetails(true);
        out.contactAOToggle = { on: aoBefore, off: aoOff, back: aoBack };
        out.vehicleShadows = vehicleShadowReport(api.STATE.scene);   // 车道里的车也按同一颗太阳铺影子
        out.shadowLight = shadowLightReport(api.STATE.scene);

        // ---- 道闸：角度是"跳变序列 + 时刻"的纯函数，所以可以定点取样核对 ----
        const barrierLanes = api.barrierLaneIds();
        const barrierId = barrierLanes.length ? barrierLanes[0] : null;
        out.barrierLane = barrierId;
        out.barrierLaneCount = barrierLanes.length;
        if (barrierId) {
          // 多车道页的时间轴单位是**毫秒**：这里统一换成秒再取样，读数与公式才对得上
          const transitions = (api.barrierTransitions(barrierId) || []).map((item) => ({ t: item.t / 1000, s: item.s }));
          out.barrierTransitions = transitions.map((item) => ({ t: round(item.t), s: item.s }));
          const settled = transitions.filter((item, index) => {
            const next = transitions[index + 1];
            return next && next.t - item.t > 3;          // 留得下"行程 + 稳定"的区间
          });
          const up = settled.find((item) => item.s);
          const down = settled.find((item) => !item.s);
          const probe = async (seconds) => {
            api.seek(seconds * 1000);
            await sleep(220);                             // 等一帧真的画出来，读的是场景里的对象
            const pose = api.barrierPose(barrierId);
            return pose ? { t: round(seconds), angleDeg: round(pose.angleDeg), tipY: round(pose.tipY), open: pose.open, traveling: pose.traveling, lamp: pose.lamp } : null;
          };
          out.barrierOpen = up ? await probe(up.t + 2.5) : null;
          out.barrierClosed = down ? await probe(down.t + 2.5) : null;
          if (up) {
            // 行程中：抬杆后 0.15/0.45/0.75s 三点应该单调抬起，且都还没到位
            const travel = [];
            for (const offset of [0.15, 0.45, 0.75]) travel.push(await probe(up.t + offset));
            out.barrierTravel = travel;
            // 同一个时刻拖回来，角度必须一模一样（旧实现是按帧缓动攒的，这里会不一样）
            const first = await probe(up.t + 0.45);
            const second = await probe(up.t + 0.45);
            out.barrierRepeat = { first, second };
            // 像素级外观：同一机位下「落杆 = 细长横条」而「抬杆 = 细长竖条」，且红白相间能数出来
            const model = api.model(barrierId);
            const origin = new THREE.Vector3();
            model.barrier.getWorldPosition(origin);
            const home = {
              position: api.STATE.camera.position.clone(),
              target: api.STATE.controls.target.clone(),
            };
            const frameBarrier = () => {
              api.STATE.camera.position.set(origin.x - 1.0, 1.9, origin.z + 13);
              api.STATE.camera.lookAt(origin.x, 2.4, origin.z);
              api.STATE.controls.target.set(origin.x, 2.4, origin.z);
              api.STATE.controls.update();
              api.LOOP.hold(9000);
            };
            const unframe = async () => {
              api.STATE.camera.position.copy(home.position);
              api.STATE.controls.target.copy(home.target);
              api.STATE.controls.update();
              api.seek(api.STATE.span * 0.42);            // 时间轴也放回探针前面用的那一刻
              api.LOOP.hold(1200);
              await sleep(300);
            };
            // 量臂的涂装时先把车辆藏起来：车正好停在闸口前面时会把杆挡掉一截，
            // 数出来的红白相间次数就少一次（那是遮挡，不是涂装没生效）。臂的外观与车辆无关。
            const hideVehicles = () => {
              const saved = [];
              api.STATE.models.forEach((model) => {
                if (model.vehicle) { saved.push([model.vehicle, model.vehicle.visible]); model.vehicle.visible = false; }
              });
              return saved;
            };
            const showVehicles = (saved) => saved.forEach(([vehicle, visible]) => { vehicle.visible = visible; });
            if (down) {
              await probe(down.t + 2.5);
              frameBarrier();
              await sleep(300);
              const saved = hideVehicles();
              out.barrierPixelsClosed = armPixelReport(api.STATE.renderer, api.STATE.scene, api.STATE.camera, model.barrier);
              showVehicles(saved);
            }
            await probe(up.t + 2.5); frameBarrier(); await sleep(300);
            {
              const saved = hideVehicles();
              out.barrierPixelsOpen = armPixelReport(api.STATE.renderer, api.STATE.scene, api.STATE.camera, model.barrier);
              showVehicles(saved);
            }
            // 量完外观把机位还给默认视角，后面统计 draw call / 画面均值才跟前几轮可比
            await unframe();
            const visibleAtEnd = [];
            for (const lane of api.STATE.lanes) {
              const item = api.model(lane.id);
              if (item && item.vehicle && item.vehicle.visible) visibleAtEnd.push(lane.id.slice(-4));
            }
            out.finalCursor = { t: round(api.STATE.t), visibleVehicles: visibleAtEnd.length, lanes: visibleAtEnd };
          }
        }
        out.bloom = bloomReport(api.STATE.renderer, api.STATE.scene, api.STATE.camera, createBloomPipeline);
        out.pageBloomEnabled = Boolean(api.STATE.bloom && api.STATE.bloom.enabled);
        out.loop = { fps: api.LOOP.fps, errors: api.LOOP.errorCount };

        // ---- 车辆轨迹：日志里"设备被激活的那一刻"必须对应"车正好在那个设备旁边" ----
        //      逐个锚点把时间轴拨到那一刻，读场景里真实车辆对象的 z，与设备 z 对账；
        //      再检查没有位置证据的过程不会凭空画出一辆车。
        {
          const summary = api.trajectorySummary();
          out.trajectory = summary;
          const seekAndRead = async (laneId, passageI, tPage) => {
            api.seek(tPage);
            api.LOOP.hold(1200);
            await sleep(280);                       // 等一帧真的画出来
            const rows = api.vehicleState().filter((row) => row.laneId === laneId && row.passage === passageI);
            return rows.length ? rows[0] : null;
          };
          const offsetMs = summary.offsetMs;
          const samples = [];
          let misses = 0;
          let seenAnchors = 0;
          let notSeen = 0;
          let worst = 0;
          const picked = summary.perPassage
            .filter((item) => item.hasEvidence)
            .sort((a, b) => b.anchors - a.anchors || b.maxDelayMs - a.maxDelayMs)
            .slice(0, 4);
          for (const item of picked) {
            const detail = api.trajectory(item.laneId, item.passage);
            if (!detail) continue;
            const rows = [];
            for (const anchor of detail.anchors) {
              // 前一趟还没离场时这趟车在入口等（整条轨迹顺延 queueMs）：核对时刻要加上它，
              // queueMs 本身也记在样本里如实报告
              const seen = await seekAndRead(item.laneId, item.passage, anchor.tPage + detail.queueMs);
              if (!seen) {
                notSeen += 1;
                rows.push({ key: anchor.key, z: anchor.z, seen: null, gap: null, delayMs: anchor.delayMs });
                continue;
              }
              seenAnchors += 1;
              const gap = Math.abs(seen.z - anchor.z);
              worst = Math.max(worst, gap);
              if (gap > 0.75) misses += 1;
              rows.push({ key: anchor.key, z: anchor.z, seen: round(seen.z), gap: round(gap), delayMs: anchor.delayMs, queueMs: detail.queueMs });
            }
            // 入口起步：本趟开始时（含入口等待顺延）车应该在入口（zMin+3=-32），不是停在某个设备位置
            const entrySeen = await seekAndRead(item.laneId, item.passage, detail.entry.t - offsetMs + detail.queueMs + 40);
            samples.push({
              laneId: item.laneId,
              passage: item.passage,
              anchors: rows,
              entryZ: entrySeen ? round(entrySeen.z) : null,
              entryWant: detail.entry.z,
              leadMs: detail.leadMs,
              queueMs: detail.queueMs,
            });
          }
          out.trajectoryProbe = { passages: samples.length, misses, notSeen, seenAnchors, worstGap: round(worst), samples };
          let phantom = 0;
          const blank = summary.perPassage.filter((item) => !item.hasEvidence).slice(0, 3);
          for (const item of blank) {
            const lane = api.STATE.lanes.find((row) => row.id === item.laneId);
            const entry = lane ? lane.rel.find((row) => row.passage.i === item.passage) : null;
            if (!entry) continue;
            api.seek((entry.o0 + entry.o1) / 2);
            api.LOOP.hold(1200);
            await sleep(280);
            if (api.vehicleState().some((row) => row.laneId === item.laneId && row.passage === item.passage)) phantom += 1;
          }
          out.trajectoryPhantom = { checked: blank.length, phantom };
          // 每趟车的可见区间（自检：车一律从入口起步、区间够长、走得完）
          if (api.spanSummary) out.vehicleSpans = api.spanSummary();
          // 悬挂俯仰：连续播一段（不能 seek —— seek 是跳变，会被当成急刹而 reset），
          // 核对"起步/加速抬头、刹车低头、停车回正、不过该车的满偏"。
          const playLane = picked.find((item) => item.anchors >= 2) || picked[0];
          if (playLane && api.playFrames) {
            const detail = api.trajectory(playLane.laneId, playLane.passage);
            // 车在入口等前车时整条轨迹顺延 queueMs：核对时刻也要跟着顺延，否则播的是上一趟的画面
            api.seek(detail.entry.t - offsetMs + detail.queueMs - 300);
            api.LOOP.hold(1500);
            await sleep(220);
            const frames = api.playFrames(130, 33, 1);
            out.suspension = {
              page: "lanes",
              laneId: playLane.laneId,
              passage: playLane.passage,
              entryZ: detail.entry.z,
              samples: frames.map((item) => {
                const car = (item.cars || []).find((row) => row.laneId === playLane.laneId && row.passage === playLane.passage) || {};
                return {
                  t: item.t,
                  z: car.z === undefined ? null : car.z,
                  passage: car.passage === undefined ? null : car.passage,
                  pitch: car.pitchDeg === undefined ? null : car.pitchDeg,
                  maxPitch: car.maxPitchDeg === undefined ? null : car.maxPitchDeg,
                  accel: car.accel === undefined ? null : car.accel,
                  speed: car.speed === undefined ? null : car.speed,
                  brake: car.brake === undefined ? null : car.brake,
                };
              }),
            };
          }
          api.seek(api.STATE.span * 0.42);
          api.LOOP.hold(900);
          await sleep(280);
        }

        // ---- 交互：点车道 → 中间绘图区高亮；点清单里的车 → 下钻单车道通行回放；返回多车道 ----
        // 放在最后一段：这一段会点车道、切时间轴、下钻再返回，之后不再做别的像素统计。
        {
          const incidents = api.incidents();
          const byKind = { block: 0, timeout: 0, both: 0 };
          for (const item of incidents) {
            const isBlock = item.kinds.indexOf("block") >= 0;
            const isTimeout = item.kinds.indexOf("timeout") >= 0;
            if (isBlock && isTimeout) byKind.both += 1;
            else if (isBlock) byKind.block += 1;
            else if (isTimeout) byKind.timeout += 1;
          }
          const inter = { incidentCount: incidents.length, byKind: byKind };
          // 浮层多了以后要防"面板互相压住"：把每块面板的盒子量下来两两比一遍
          const hitBox = (a, b) => Boolean(a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom);
          const boxOf = (selector) => {
            const node = document.querySelector(selector);
            if (!node || node.hidden || node.offsetParent === null) return null;
            const box = node.getBoundingClientRect();
            return { top: Math.round(box.top), bottom: Math.round(box.bottom), left: Math.round(box.left), right: Math.round(box.right) };
          };
          const layoutReport = () => {
            const hud = boxOf(".hud");
            const floatPanel = boxOf("#vehicleFloat");
            const alertPanel = boxOf("#alertPanel");
            const focusBar = boxOf("#focusBar");
            const stage = boxOf("#scene");
            const timeoutPill = boxOf("#timeoutPill");
            const body = document.querySelector("#vehicleFloatBody");
            const pairs = [["hud", hud], ["float", floatPanel], ["alert", alertPanel], ["focus", focusBar], ["timeout", timeoutPill]];
            const collisions = [];
            for (let i = 0; i < pairs.length; i += 1) {
              for (let j = i + 1; j < pairs.length; j += 1) {
                if (hitBox(pairs[i][1], pairs[j][1])) collisions.push(`${pairs[i][0]}×${pairs[j][0]}`);
              }
            }
            return {
              collisions: collisions,
              rows: body ? body.querySelectorAll(".vf-item").length : 0,
              scrolls: body ? body.scrollHeight > body.clientHeight + 1 : false,
              insideStage: Boolean(floatPanel && stage && floatPanel.top >= stage.top - 1 && floatPanel.bottom <= stage.bottom + 1),
              floatBox: floatPanel,
              hudBox: hud,
              stageBox: stage,
            };
          };
          api.setFlash(false);                     // 超时红闪会逐帧变色，量像素时要先关掉
          api.STATE.playing = false;
          api.LOOP.hold(600);
          const home = { position: api.STATE.camera.position.clone(), target: api.STATE.controls.target.clone() };
          api.STATE.camera.position.set(0, 58, 76);
          api.STATE.controls.target.set(0, 0, 2);
          api.STATE.controls.update();
          api.seek(api.STATE.span * 0.42);
          await sleep(1200);
          const beforeClick = grab(api.STATE.renderer, api.STATE.scene, api.STATE.camera);

          // 清单：默认列全部车道的拦截/超时车，带车型图
          const rowsAll = api.vehicleFloatRows();
          inter.rowsAll = rowsAll.length;
          inter.iconShapes = rowsAll.length ? rowsAll[0].iconShapes : 0;
          inter.iconWheels = rowsAll.length ? rowsAll[0].iconWheels : 0;
          inter.firstRow = rowsAll.length ? { laneId: rowsAll[0].laneId, passage: rowsAll[0].passage, plate: rowsAll[0].plate, badges: rowsAll[0].badges } : null;
          inter.filters = { block: api.setFilter("block"), timeout: api.setFilter("timeout"), all: api.setFilter("all") };
          inter.layoutIdle = layoutReport();

          // 1) 点左侧车道 → 三维高亮 + 清单收到这条车道
          const laneId = rowsAll.length ? rowsAll[0].laneId : api.STATE.lanes[0].id;
          api.click(".lane-item[data-lane=\"" + laneId + "\"]");
          await sleep(300);
          await until(() => !api.STATE.camTween, 8000);
          await sleep(400);
          const afterSelect = grab(api.STATE.renderer, api.STATE.scene, api.STATE.camera);
          // 高亮层自己值多少像素：同机位、同游标，只把这一层藏起来再抓一帧
          const highlightGroup = api.model(laneId).highlight.group;
          highlightGroup.visible = false;
          const withoutGlow = grab(api.STATE.renderer, api.STATE.scene, api.STATE.camera);
          highlightGroup.visible = true;
          const withGlow = grab(api.STATE.renderer, api.STATE.scene, api.STATE.camera);
          inter.laneClick = {
            laneId: laneId,
            incidentsInLane: incidents.filter((item) => item.laneId === laneId).length,
            selectedLane: api.selectedLane,
            highlight: api.highlightState(),
            rowsAfter: api.vehicleFloatRows().length,
            scope: (document.querySelector("#vehicleFloatScope") || {}).textContent || "",
            swimSelected: document.querySelectorAll(".swim-row.sel").length,
            laneItemSelected: document.querySelectorAll(".lane-item.sel").length,
            pixels: diffFrames(beforeClick, afterSelect),
            glowPixels: diffFrames(withoutGlow, withGlow),
          };

          // 2) 点清单里的车辆 → 下钻单车道通行回放（其它车道隐藏、游标停在本趟起点、进度条只覆盖本趟）
          const focusLane = inter.firstRow ? inter.firstRow.laneId : laneId;
          api.clearLaneFilter();
          await sleep(200);
          api.click("#vehicleFloatBody .vf-item[data-lane=\"" + focusLane + "\"]");
          await until(() => api.STATE.focus, 5000);
          await until(() => !api.STATE.camTween, 9000);
          await sleep(400);
          const afterFocus = grab(api.STATE.renderer, api.STATE.scene, api.STATE.camera);
          inter.focusPixels = diffFrames(afterSelect, afterFocus);
          inter.focus = Object.assign({}, api.focusState(), {
            rowsInFocus: api.vehicleFloatRows().length,
            playingRows: document.querySelectorAll(".swim-row.focus").length,
            hiddenPills: [...document.querySelectorAll(".hud .pill")].filter((p) => p.offsetParent === null).length,
          });
          inter.layoutFocus = layoutReport();
          // 2.1) 下钻后的默认位置必须在**入口**：车从入口驶入（可以停在入口等前车），
          //      不能"凭空出现在线圈6/闸机上"。播一小段还必须从入口往前走（或在入口等）。
          {
            const spans = api.spanSummary ? api.spanSummary() : [];
            const laneSpans = spans.filter((row) => row.laneId === inter.focus.laneId);
            const target = laneSpans.filter((row) => row.queueMs > 300)[0] || laneSpans[0] || null;
            const snapshot = (rows) => rows.filter(
              (row) => row.laneId === target.laneId && row.passage === target.passage)[0] || null;
            if (target) {
              api.enterFocus(target.laneId, target.passage);
              await until(() => !api.STATE.camTween, 9000);
              await sleep(220);
              // 从车辆区间起点+40ms 起播（边界上容一点，避免刚好落在区间外）
              api.seek(api.STATE.focus.from + 40);
              api.LOOP.hold(1400);
              await sleep(320);
              const atStart = snapshot(api.vehicleState());
              const frames = api.playFrames ? api.playFrames(75, 33, 1) : [];
              const tail = frames.length ? snapshot(frames[frames.length - 1].cars) : null;
              inter.focusEntrance = {
                focusFrom: round(api.STATE.focus.from),
                focusTo: round(api.STATE.focus.to),
                t: round(api.STATE.t),
                playing: api.STATE.playing,
                rows: api.vehicleState().length,
                laneId: target.laneId,
                passage: target.passage,
                spanCarFrom: target.carFrom,
                spanCarTo: target.carTo,
                queueMs: target.queueMs,
                entryZ: target.entryZ,
                startZ: atStart ? round(atStart.z) : null,
                visible: Boolean(atStart),
                movedZ: atStart && tail ? round(tail.z - atStart.z) : null,
                playedMs: frames.length * 33,
              };
            } else {
              inter.focusEntrance = { missing: true, laneId: inter.focus.laneId };
            }
          }
          // 本趟区间播放：从结束前 0.8s 起播，必须停在本趟终点，不许绕回窗口开头
          api.STATE.t = api.STATE.focus.to - 800;
          api.STATE.playing = true;
          api.LOOP.hold(4000);
          await sleep(800);
          inter.focusClamp = {
            t: round(api.STATE.t),
            to: round(api.STATE.focus.to),
            playing: api.STATE.playing,
            overshoot: round(api.STATE.t - api.STATE.focus.to),
          };

          // 3) 返回多车道 → 8 条车道都回来、画面回到点之前的样子
          api.click("#focusBack");
          await until(() => !api.STATE.focus, 5000);
          await until(() => !api.STATE.camTween, 9000);
          await sleep(400);
          inter.back = Object.assign({}, api.focusState(), {
            vsFocus: diffFrames(afterFocus, grab(api.STATE.renderer, api.STATE.scene, api.STATE.camera)),
          });
          // 4) 有单车日志的那一趟：聚焦条上的深链要指向 index.html?file=…&at=本趟开始时刻
          //    （窗口内只有 鲁UG6595 那一份单车日志；这几趟都不是拦截/超时，所以只能从过程详情下钻）
          const soloLane = "370164335F";
          const soloPassage = 2;
          api.enterFocus(soloLane, soloPassage);
          await until(() => !api.STATE.camTween, 9000);
          await sleep(200);
          const soloState = api.focusState();
          const detailLink = document.querySelector("#detailSolo");
          inter.soloLink = {
            laneId: soloState.laneId,
            passage: soloState.passage,
            plate: soloState.soloPlate,
            href: soloState.deepLink,
            detailHref: detailLink ? detailLink.getAttribute("href") : null,
          };
          api.click("#focusBack");
          await until(() => !api.STATE.focus, 5000);
          await until(() => !api.STATE.camTween, 9000);
          // 收尾：重置页面（清选择/过滤/游标），再核对画面回到交互之前
          api.click("#resetBtn");
          await until(() => !api.STATE.camTween, 9000);
          api.seek(api.STATE.span * 0.42);
          await sleep(1200);
          const restored = grab(api.STATE.renderer, api.STATE.scene, api.STATE.camera);
          inter.restoredVsBaseline = diffFrames(beforeClick, restored);
          inter.resetState = {
            selectedLane: api.selectedLane,
            selected: api.STATE.selected ? { laneId: api.STATE.selected.lane.id, passage: api.STATE.selected.passage.i } : null,
            laneFilter: api.STATE.laneFilter,
            rows: api.vehicleFloatRows().length,
            highlight: api.highlightState(),
            scope: (document.querySelector("#vehicleFloatScope") || {}).textContent || "",
          };
          api.setFlash(true);
          out.interaction = inter;
        }
      } catch (error) {
        out.fatal = String((error && error.stack) || error);
      }
      out.errorsAfter = window.__ERRORS__.slice(0, 5);
      await fetch(`http://127.0.0.1:__PORT__/log`, { method: "POST", body: JSON.stringify(out) });
""",
    "vehicles": r"""
      const api = await waitForApi("__GALLERY__", (a) => a.renderer && a.holders);
      const out = { page: "vehicles" };
      try {
        await until(() => api && api.holders && api.holders.length, 45000);
        await sleep(1200);

        out.errors = window.__ERRORS__.slice(0, 5);
        out.gpu = { software: api.gpu ? api.gpu.software : null };
        out.models = api.holders.length;
        out.families = api.holders.map((h) => h.built.spec.label);
        out.contactShadowCount = countNamed(api.scene, "contactShadow");
        out.brakeGlows = countNamed(api.scene, "brakeGlow");
        out.paintPhysical = api.holders.filter((h) => h.built.body && h.built.body.material.isMeshPhysicalMaterial).length;
        out.brake = inspectBrake(api.holders[0].built);
        // 车辆接地阴影：逐辆核对"影长 = cot×车高、长轴指向影子方向"，再逐辆藏起来量像素
        out.vehicleShadows = vehicleShadowReport(api.scene);
        out.propShadows = propShadowReport(api.renderer, api.scene, api.camera);   // 展台：应当空着
        out.shadowLight = shadowLightReport(api.scene);
        out.shadowPixels = api.holders.map((holder) => {
          const shadow = holder.built.contactShadow;
          const label = (holder.family && holder.family.label) || holder.built.spec.kind;
          if (!shadow || !shadow.userData.shadowPlan) return { label, changed: 0 };
          const plan = shadow.userData.shadowPlan;
          const origin = new THREE.Vector3();
          if (shadow.parent) shadow.parent.getWorldPosition(origin);
          return Object.assign(
            { label, height: plan.height },
            shadowPixelReport(api.renderer, api.scene, api.camera, shadow, plan.shadowDir, origin),
          );
        });
        // 三/四分之一机位下"车身自己挡掉一部分影子"，重心方向会被遮挡带偏；
        // 想量"影子落在背离太阳的一侧"就得像上一轮量道闸那样，临时把相机搬到正上方。
        // 挑最矮最小的那辆（轿车）：长车的车身会在影子里切掉一条斜带，重心被推到侧向去，
        // 拿它判断"影子在太阳的哪一侧"不成立；小车接近对称，露出来的那圈就是真实走向。
        const pick = api.holders
          .map((holder) => ({ holder, plan: holder.built.contactShadow ? holder.built.contactShadow.userData.shadowPlan : null }))
          .filter((item) => item.plan)
          .sort((a, b) => a.plan.height - b.plan.height)[0];
        if (pick) {
          const home = { position: api.camera.position.clone(), target: api.controls ? api.controls.target.clone() : null };
          const shadow = pick.holder.built.contactShadow;
          const origin = footprintCentre(shadow.parent, shadow);
          const height = pick.plan.height;
          api.camera.position.set(origin.x + 0.3, origin.y + Math.max(8, height * 4.2), origin.z + 0.3);
          api.camera.lookAt(origin.x, 0, origin.z);
          if (api.controls) { api.controls.target.set(origin.x, 0, origin.z); api.controls.update(); }
          api.LOOP.hold(9000);
          await sleep(300);
          out.shadowTopDown = Object.assign(
            { label: (pick.holder.family && pick.holder.family.label) || pick.holder.built.spec.kind, height },
            shadowPixelReport(api.renderer, api.scene, api.camera, shadow, pick.plan.shadowDir, origin),
          );
          api.camera.position.copy(home.position);
          if (api.controls && home.target) { api.controls.target.copy(home.target); api.controls.update(); }
          api.LOOP.hold(600);
          await sleep(200);
        }
        // 扫掠形状：挑"整块矩形比真影子多铺最多"的那辆，逐格核对贴图的 alpha 与真扫掠区域
        const widest = api.holders
          .map((holder) => ({ holder, plan: holder.built.contactShadow ? holder.built.contactShadow.userData.shadowPlan : null }))
          .filter((item) => item.plan)
          .sort((a, b) => (b.plan.areaRect / b.plan.areaTrue) - (a.plan.areaRect / a.plan.areaTrue))[0];
        if (widest) {
          const plan = widest.plan;
          out.shadowShape = Object.assign(
            { label: (widest.holder.family && widest.holder.family.label) || widest.holder.built.spec.kind,
              width: plan.width, length: plan.length, height: plan.height },
            shadowShapeReport(widest.holder.built.contactShadow, plan),
          );
        }
        out.stats = imageStats(grab(api.renderer, api.scene, api.camera, 7));
        out.sky = skyReport(api.renderer, api.scene, api.camera);
        out.bloom = bloomReport(api.renderer, api.scene, api.camera, createBloomPipeline);
        out.loop = { fps: api.LOOP.fps, errors: api.LOOP.errorCount };
      } catch (error) {
        out.fatal = String((error && error.stack) || error);
      }
      out.errorsAfter = window.__ERRORS__.slice(0, 5);
      await fetch(`http://127.0.0.1:__PORT__/log`, { method: "POST", body: JSON.stringify(out) });
""",
}

# ---------------------------------------------------------------------------
# 结果汇总
# ---------------------------------------------------------------------------
PASS, FAIL = "  [OK]", "  [!!]"


class Report:
    def __init__(self) -> None:
        self.failures: list[str] = []
        self.lines: list[str] = []

    def check(self, condition: bool, text: str, detail: str = "") -> bool:
        mark = PASS if condition else FAIL
        if not condition:
            self.failures.append(text)
        self.lines.append(f"{mark} {text}" + (f"　{detail}" if detail else ""))
        return condition

    def note(self, text: str) -> None:
        self.lines.append(f"       {text}")


def find_edge() -> str | None:
    candidates = [
        Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
        Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
        Path.home() / r"AppData\Local\Microsoft\Edge\Application\msedge.exe",
    ]
    for path in candidates:
        if path.exists():
            return str(path)
    return shutil.which("msedge")


class Sink:
    """收探针 POST 上来的 JSON。"""

    def __init__(self) -> None:
        self.payload: dict | None = None
        self.raw: list[str] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - http.server 接口
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length).decode("utf-8", "replace")
                outer.raw.append(body)
                try:
                    outer.payload = json.loads(body)
                except json.JSONDecodeError:
                    outer.payload = {"_parseError": body[:400]}
                self.send_response(204)
                self.end_headers()

            def do_GET(self) -> None:  # noqa: N802
                self.send_response(204)
                self.end_headers()

            def log_message(self, *args) -> None:  # 静音
                pass

        self.server = HTTPServer(("127.0.0.1", SINK_PORT), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def build_probe_html(page: str) -> Path:
    source = (HERE / f"{page}.html").read_text(encoding="utf-8")
    module = (
        '    <script type="module">\n      import * as THREE from "three";\n'
        '      import { createBloomPipeline, skyCanvasTexture } from "./scene-look.js";\n'
        '      import { createBrakeController } from "./vehicle-models.js";\n'
        + HELPERS
        + TEMPLATES[page].replace("__PORT__", str(SINK_PORT))
        + "    </script>\n"
    )
    lines = []
    injected = [False, False]
    for line in source.splitlines(keepends=True):
        if not injected[0] and 'type="importmap"' in line:
            lines.append(SHIM)
            injected[0] = True
        if not injected[1] and "</body>" in line:
            lines.append(module)
            injected[1] = True
        lines.append(line)
    target = HERE / f"_probe_{page}.html"
    target.write_text("".join(lines), encoding="utf-8", newline="\n")
    return target


def run_page(page: str, edge: str, budget_ms: int, size: str, wait_s: float = 150.0) -> tuple[dict | None, str]:
    target = build_probe_html(page)
    sink = Sink()
    profile = Path(tempfile.gettempdir()) / f"edge-probe-{page}-{int(time.time() * 1000)}"
    command = [
        edge,
        "--headless=new",
        "--disable-gpu",
        "--enable-unsafe-swiftshader",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        f"--user-data-dir={profile}",
        f"--window-size={size}",
        f"--virtual-time-budget={budget_ms}",
        f"{SITE}/_probe_{page}.html",
    ]
    log = ""
    process = None
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        # 探针在页面里跑完就 POST 上来；不必等浏览器自己退出（虚拟时间预算可能被快进烧完）
        deadline = time.time() + wait_s
        while sink.payload is None and time.time() < deadline:
            if process.poll() is not None and sink.payload is None:
                time.sleep(0.8)          # 进程已退出，再给接收线程一点时间
                break
            time.sleep(0.25)
    finally:
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
        if process is not None and process.stdout is not None:
            try:
                log = process.communicate(timeout=5)[0] or ""
            except Exception:  # noqa: BLE001 - 退出时读日志失败不影响结论
                log = ""
        sink.stop()
        shutil.rmtree(profile, ignore_errors=True)
        if not KEEP_PROBES:
            target.unlink(missing_ok=True)
        else:
            print(f"  （--keep：保留探针页面 {target}）")
    return sink.payload, log


def report_index(payload: dict, report: Report) -> None:
    report.check(not payload.get("errors"), "index：页面无 JS 报错", str(payload.get("errors")))
    report.check(not payload.get("fatal"), "index：探针无异常", str(payload.get("fatal") or ""))
    stats = payload.get("stats") or {}
    report.note(f"画面统计（直接渲染）mean={stats.get('mean')} median={stats.get('median')} clip={stats.get('clip')} top1%={stats.get('topPctMean')}")
    report.check(bool(payload.get("vehicleLabel")), "index：车辆模型已建立", str(payload.get("vehicleLabel")))
    brake = payload.get("brake") or {}
    report.check(brake.get("tailMeshes") == 2 and brake.get("glows") == 2, "index：尾灯 2 只 + 光晕 2 个",
                  f"tail={brake.get('tailMeshes')} glow={brake.get('glows')}")
    report.check((brake.get("on") or {}).get("emissive", 0) > 1.5 and (brake.get("off") or {}).get("emissive", 9) < 0.5,
                  "index：setBrake 双向可复现", f"on={brake.get('on')} off={brake.get('off')}")
    idle = payload.get("brakeIdle") or {}
    report.check(idle.get("distinct") == 1 and idle.get("max", 9) < 0.5, "index：空闲时刹车灯保持熄灭",
                  f"distinct={idle.get('distinct')} max={idle.get('max')}")
    report.check((payload.get("contactShadowCount") or 0) >= 1, "index：接地阴影存在",
                  f"count={payload.get('contactShadowCount')}")
    report_contact_ao(payload, report, "index")
    report_sky("index", payload, report)
    report_prop_shadows("index", payload, report)
    report_barrier_index(payload, report)
    report_vehicle_shadows(payload, report, "index")
    # 多车道页下钻带过来的 ?at= 时刻：只认这份日志里真有的时刻
    seek = payload.get("deepLinkSeek") or {}
    if seek:
        hit_ms = seek.get("hitMs")
        after = seek.get("afterHit") or {}
        report.check(hit_ms is not None and float(hit_ms) < 3000 and str(after.get("time", "")).startswith("2026-07-01 12:06:5"),
                      "index：?at= 深链落在最近的那条事件上",
                      f"偏差 {hit_ms} ms → 事件 #{after.get('index')} {after.get('time')}")
        report.check(seek.get("missMs") is None and (seek.get("afterMiss") or {}).get("index") == after.get("index"),
                      "index：?at= 给的时刻离日志太远时拒绝跳转（时间轴不动）",
                      f"偏差 {seek.get('missMs')} · 游标 {(seek.get('afterMiss') or {}).get('index')} / 命中后 {after.get('index')}")
    report_suspension(payload, report, "index")


def num(value, default: float = 9.0) -> float:
    """0 是合法测量值（"尾灯不亮"就是 0），不能用 `or` 兜底。"""
    return default if value is None else float(value)


def report_vehicle_shadows(payload: dict, report: Report, page: str, *, pixel: bool = False) -> None:
    """车辆接地阴影：方向取自太阳，影长 = cot(高度角) × 车高，与接地暗部共用一套约定。"""
    shadows = payload.get("vehicleShadows") or []
    if not shadows:
        report.check(False, f"{page}：取到车辆接地阴影", f"数量={len(shadows)}（车身在场景里但没铺影子？）")
        report.note(f"阴影诊断：{payload.get('shadowDebug')}")
        return
    ao = ((payload.get("contactAO") or {}).get("shadow")) or {}
    ao_dir = ao.get("shadowDir")
    ao_cot = ao.get("cotElevation")
    cot_ok = True
    sweep_ok = True
    along_ok = True
    axis_ok = True
    dir_ok = True
    offset_ok = True
    offset_gap = 0.0
    offset_worst = None
    offset_dir_ok = True
    plane_ok = True
    for item in shadows:
        cot = num(item.get("cot"), 0)
        height = num(item.get("height"), 0)
        if abs(cot - 0.625) > 0.02:
            cot_ok = False
        if abs(num(item.get("sweep"), 0) - cot * height) > 0.03:
            sweep_ok = False
        if abs(num(item.get("along"), 0) - (num(item.get("proj"), 0) + num(item.get("sweep"), 0))) > 0.06:
            along_ok = False
        if num(item.get("axisErrorDeg"), 99) > 3.0 or num(item.get("localAxisErrorDeg"), 99) > 0.5:
            axis_ok = False
        if ao_dir and max(abs(num(item.get("shadowDir", [0, 0])[0], 9) - num(ao_dir[0], 0)),
                          abs(num(item.get("shadowDir", [0, 0])[1], 9) - num(ao_dir[1], 0))) > 0.005:
            dir_ok = False
        if abs(num(item.get("scaleY"), 0) - num(item.get("alongPlane"), 0)) > 0.06:
            along_ok = False
        if abs(num(item.get("scaleX"), 0) - num(item.get("crossPlane"), 0)) > 0.06:
            plane_ok = False
        expected_offset = num(item.get("sweep"), 0) / 2
        anchor = item.get("anchor") or [0, 0]
        # 锚点是"车体局部"坐标，平移量也得用局部方向（世界方向另有 offsetWorldDir 那一项去核对）
        rel_rad = math.radians(num(item.get("relDeg"), 0))
        want = math.hypot(num(anchor[0], 0) + math.sin(rel_rad) * expected_offset,
                          num(anchor[1], 0) + math.cos(rel_rad) * expected_offset)
        gap = abs(num(item.get("offset"), 0) - want)
        if gap > offset_gap:
            offset_gap = gap
            offset_worst = item
        if gap > 0.05:
            offset_ok = False
        # 平移量的**世界**方向必须还是背离太阳：车头转过之后，局部平移会被一起转走
        own_dir = item.get("shadowDir") or [0, 0]
        off_dir = item.get("offsetWorldDir") or [9, 9]
        if max(abs(num(off_dir[0], 9) - num(own_dir[0], 0)), abs(num(off_dir[1], 9) - num(own_dir[1], 0))) > 0.01:
            offset_dir_ok = False
    first = shadows[0]
    report.check(cot_ok, f"{page}：车辆影子的影长系数就是 cot(高度角)≈0.625",
                  f"cot={sorted({item.get('cot') for item in shadows})}")
    report.check(sweep_ok, f"{page}：影长 = cot × 车高（逐辆核对）",
                  f"样例 车高 {first.get('height')}m → 影长 {first.get('sweep')}m")
    report.check(along_ok, f"{page}：阴影平面按「车身跨度 + 影长 + 两侧半影」铺开（缩放与它一致）",
                  f"proj {first.get('proj')} + sweep {first.get('sweep')} = along {first.get('along')}，"
                  f"加半影后 alongPlane={first.get('alongPlane')} / scaleY={first.get('scaleY')}")
    report.check(plane_ok, f"{page}：平面横向也留出半影余量（crossPlane = cross + 2×半影）",
                  f"cross {first.get('cross')} → crossPlane {first.get('crossPlane')}，scaleX={first.get('scaleX')}，"
                  f"半影 {first.get('penumbra')}m")
    report.check(axis_ok, f"{page}：阴影平面确实指向影子方向（局部量精确、世界量只差转台那点转动）",
                  f"局部角误差 ≤ {max(num(item.get('localAxisErrorDeg'), 0) for item in shadows)}°，"
                  f"世界角误差 ≤ {max(num(item.get('axisErrorDeg'), 0) for item in shadows)}°（转台在动，世界量天然差一点）")
    report.check(offset_ok, f"{page}：整片影子沿影子方向平移了半个影长（近端贴车身背光边，基准取车身占地中心）",
                  f"最大偏差 {round(offset_gap, 2)}m；最大那件 偏移 {num((offset_worst or first).get('offset'), 0)}m / "
                  f"占地中心 {(offset_worst or first).get('anchor')} + sweep/2 {round(num((offset_worst or first).get('sweep'), 0) / 2, 2)}m")
    report.check(offset_dir_ok, f"{page}：车头转过之后，平移量的世界方向依旧背离太阳（局部平移已按转角换算）",
                  f"偏移方向 {first.get('offsetWorldDir')} vs 影子方向 {first.get('shadowDir')}（当前车头 {first.get('yawDeg')}°）")

    # ---- 影子的颜色与深浅：乘法贴图（白=不变、色调=影子里剩下的天光） ----
    multiply_ok = all(item.get("multiply") for item in shadows)
    tone_off = all(item.get("toneMapped") is False for item in shadows)
    fog_off = all(item.get("materialFog") is False for item in shadows)
    white_base = all(
        max(abs(num(item.get("baseColor", [9, 9, 9])[i], 9) - 1) for i in range(3)) <= 0.01
        for item in shadows)
    report.check(multiply_ok and tone_off and fog_off and white_base,
                  f"{page}：阴影用乘法贴图盖在路面上（白=不变，且不吃雾、不被自身色调映射）",
                  f"乘法={multiply_ok} toneMapped关={tone_off} fog关={fog_off} 底色白={white_base}")
    tint = first.get("tint") or []
    if len(tint) == 3:
        report.check(num(tint[2], 0) >= num(tint[0], 0) * 1.25 and max(tint) <= 0.6,
                      f"{page}：影色是「天光剩下的那一份」：偏蓝、比直射暗得多",
                      f"影色(线性) {tint}（B/R={round(num(tint[2], 0) / max(0.01, num(tint[0], 0)), 2)}）")
    light = payload.get("shadowLight") or {}
    if light:
        bands = light.get("skyBands") or []
        if bands:
            zenith = bands[0].get("rgb") or [0, 0, 0]
            ground = bands[-1].get("rgb") or [0, 0, 0]
            blown = [b for b in bands if max(b.get("rgb") or [0]) >= 251]
            # 偏蓝不再按"天顶那一格"判：有云的时候天顶那一格本来就可能是白云，
            # 一格发白不等于整片天糊了。改成用**半球平均**（探针独立复算出的 skyAverage）
            # 判蓝不蓝，再用逐带"没有任何一带过曝/地面带够暗"守住"白幕"这个坑。
            sky_avg = [num(v, 0) for v in (light.get("skyAverage") or [0, 0, 0])]
            blue_avg = len(sky_avg) == 3 and sky_avg[2] >= sky_avg[0] * 1.5
            report.check(blue_avg and max(ground) <= 120 and not blown,
                          f"{page}：天空画布是「蓝天 + 暗地面」，没有被子午线云糊成白幕",
                          f"半球平均(线性) {sky_avg}（B/R={round(sky_avg[2] / max(0.01, sky_avg[0]), 2)}）；"
                          + "；".join(f"{b.get('name')} {b.get('rgb')}" for b in bands)
                          + (f"；过曝的 {[b.get('name') for b in blown]}" if blown else ""))
        report.note(f"影子里还剩多少光（探针独立复算）：直射 {light.get('direct')} + 天光 {light.get('ambient')} "
                    f"→ {light.get('ratio')}（太阳强度 {light.get('sunIntensity')}、半球光 {light.get('hemiIntensity')}、"
                    f"天空平均亮度 {light.get('skyAverage')}、sin高度角 {light.get('sinElev')}；"
                    f"日面/日晕占了天光的 {light.get('sunHaloShare')}）")
        halo = light.get("halo") or {}
        if halo:
            report.check(num(halo.get("angleDeg"), 180) <= 12,
                          f"{page}：天空贴图里最亮的那块（日面）就在灯的方向上",
                          f"画布（128×64 细网格）最亮格 uv {halo.get('uv')}（线性亮度和 {halo.get('luma')}）"
                          f"与灯的夹角 {halo.get('angleDeg')}°（>12° 说明天上那颗太阳与影子朝向不是同一颗）")
    if light and len(tint) == 3:
        gap = max(abs(num(tint[i], 0) - num((light.get("ratio") or [0, 0, 0])[i], 0)) for i in range(3))
        report.check(gap <= 0.03,
                      f"{page}：贴图里的影色 = 探针按场景灯光独立复算的天光/总光",
                      f"贴图 {tint} vs 复算 {light.get('ratio')}（最大差 {round(gap, 3)}）")
    texture_ok = True
    texture_detail = []
    for item in shadows:
        tex = item.get("texture") or {}
        own = item.get("tint") or [0, 0, 0]
        centre = tex.get("centre")
        if not centre:
            texture_ok = False
            continue
        diff = max(abs(num(centre[i], 0) - num(own[i], 0)) for i in range(3))
        outside = tex.get("outside") or []
        white = min(outside) if len(outside) == 3 else 0
        if diff > 0.02 or num(tex.get("spread"), 9) > 0.05 or white < 0.97:
            texture_ok = False
            texture_detail.append(
                f"{item.get('height')}m（扫掠 {item.get('sweep')} 投影 {item.get('proj')} 横 {item.get('cross')} "
                f"面 {item.get('crossPlane')}×{item.get('alongPlane')} 画布 {tex.get('canvas')}）: "
                f"影核差{diff} 起伏{tex.get('spread')} 外边{outside} 网格{tex.get('grid')}")
    report.check(texture_ok,
                  f"{page}：影核里整片是同一个乘数（不是「从车底往外越来越淡」），形状外是纯白",
                  f"9 点起伏与影色一致，形状外 ≥0.97；异常 {texture_detail[:3] or '无'}")
    if ao_dir:
        report.check(dir_ok, f"{page}：车辆影子与接地暗部朝同一侧（两层共用 scene-look 的取法）",
                      f"车 {first.get('shadowDir')} / 接地暗部 {ao_dir}（cot 车 {first.get('cot')} / 暗部 {ao_cot}）")
    elif payload.get("contactAO"):
        report.check(False, f"{page}：接地暗部报出了影子方向，可与之对数", str(ao))
    else:
        report.note(f"{page}：本页没有接地暗部（车辆展台），只核对车辆影子自己的朝向")
    if not pixel:
        return
    pixels = payload.get("shadowPixels") or []
    onscreen = []
    for item in pixels:
        frame = item.get("frame")
        origin = item.get("originScreen")
        if not frame or not origin:
            continue
        if -20 <= origin[0] <= frame[0] + 20 and -20 <= origin[1] <= frame[1] + 20:
            onscreen.append(item)
    report.check(bool(onscreen) and all(num(item.get("changed"), 0) > 0 for item in onscreen),
                  f"{page}：画面内的车，藏掉它的接地阴影就一定有像素变化（影子真的画上了）",
                  "　".join(f"{item.get('label')} {item.get('changed')}px" for item in onscreen[:4]))
    strong = [item for item in onscreen if num(item.get("changed"), 0) >= 1500]
    top = payload.get("shadowTopDown")
    if top:
        report.check(num(top.get("changed"), 0) > 0 and num(top.get("alongMeanM"), -9) > 0.15
                      and num(top.get("behindRatio"), 0) >= 0.6,
                      f"{page}：正上方机位下，影子的重心确实落在背离太阳的一侧",
                      f"{top.get('label')}（车高 {top.get('height')}m）{top.get('changed')}px，"
                      f"沿影子方向平均 {top.get('alongMeanM')}m（正=背光侧）、垂直方向平均 {top.get('perpMeanM')}m、"
                      f"背光侧像素占 {top.get('behindRatio')}（{top.get('pxPerMetre')}px/m）")
        tone = top.get("tone") or {}
        if tone.get("pixels"):
            report.note(f"影子里/太阳下（同一批像素）：{tone.get('shadow')} vs {tone.get('sunlit')}"
                        f"（屏幕值，逐通道比 {tone.get('ratio')}，亮度比 {tone.get('luminanceRatio')}）；"
                        f"蓝红比 影 {tone.get('blueRedShadow')} / 太阳下 {tone.get('blueRedSunlit')}")
            report.check(num(tone.get("luminanceRatio"), 9) <= 0.8,
                          f"{page}：影子确实把路面压暗了（不是一层看不清的灰）",
                          f"亮度比 {tone.get('luminanceRatio')}（1 = 完全没变），覆盖 {tone.get('pixels')}px")
            report.check(num(tone.get("blueRedShadow"), 0) > num(tone.get("blueRedSunlit"), 9) * 1.15,
                          f"{page}：影子里比太阳下更蓝（只剩天光照着，颜色该往冷里走）",
                          f"蓝红比 影 {tone.get('blueRedShadow')} vs 太阳下 {tone.get('blueRedSunlit')}")
    else:
        report.check(False, f"{page}：做了「正上方量影子方向」的取样", "没有结果（展台里没找到带方案的车）")
    shape = payload.get("shadowShape")
    if shape:
        ratios = [num(item.get("areaRect"), 0) / max(0.01, num(item.get("areaTrue"), 0)) for item in shadows]
        worst = max(shadows, key=lambda item: num(item.get("areaRect"), 0) / max(0.01, num(item.get("areaTrue"), 0)))
        report.note(f"扫掠形状：真影子面积 = 车身矩形 + 扫出去的那条；"
                    f"整块矩形贴图会多铺 {round(min(ratios), 2)}~{round(max(ratios), 2)} 倍"
                    f"（多铺最多那辆 {worst.get('width')}×{worst.get('length')}m 车高 {worst.get('height')}m："
                    f"那一刻真 {worst.get('areaTrue')}m² / 矩形 {worst.get('areaRect')}m²；"
                    f"转台在转，逐辆的比值随姿态变，下面那条才是同一时刻的核对）")
        # 挑"整块矩形多铺最多"的那辆，逐格比贴图 alpha 与解析扫掠区域 —— 直接问贴图自己画在哪
        grid = shape.get("grid") or {}
        tested = num(grid.get("tested"), 0)
        out_bad = num(grid.get("outsideMismatch"), 0)
        in_bad = num(grid.get("insideMiss"), 0)
        report.check(tested >= 40 and out_bad == 0,
                      f"{page}：真影子**之外**的地方贴图是白的（没有挡光的地方不压暗）",
                      f"{shape.get('label')} {shape.get('width')}×{shape.get('length')}m 车高 {shape.get('height')}m："
                      f"判了 {tested} 格（半影带 {grid.get('band')}m 内不判，texel {grid.get('texel')}m），"
                      f"越界被压暗的 {out_bad} 格 {grid.get('mismatches')}；"
                      f"画布 {grid.get('canvas')}，真面积 {shape.get('areaTrue')}m² / 整块矩形 {shape.get('areaRect')}m²")
        report.check(in_bad == 0,
                      f"{page}：真影子**之内**的地方贴图确实压暗（形状不是缩成一小块）",
                      f"该暗没暗的 {in_bad} 格，最弱的一格覆盖度 {grid.get('insideMin')}；{grid.get('mismatches')}")
        report.check(num(grid.get("insideMin"), 0) >= 0.94,
                      f"{page}：影核内部是**均匀**的（投影不该「越远越淡」）",
                      f"格点里最弱的覆盖度 {grid.get('insideMin')}（1 = 全影，0 = 完全不变）")
    elif pixel:
        report.check(False, f"{page}：有扫掠形状的测量结果", "没有 shadowShape 数据")
    if len(pixels) >= 2:
        by_area = sorted(pixels, key=lambda item: num(item.get("height"), 0))
        report.note("影子面积随车高增长：" + "　".join(
            f"{item.get('label')} {item.get('height')}m→{item.get('changed')}px" for item in by_area))
        areas = [num(item.get("changed"), 0) for item in by_area]
        report.check(max(areas) >= 5 * max(1, min(areas)),
                      f"{page}：最高的车影子面积明显大于最小的（半挂 vs 轿车的量级差，不是同一片糊上去）",
                      f"最小 {min(areas)}px / 最大 {max(areas)}px")


def report_lanes(payload: dict, report: Report) -> None:
    report.check(not payload.get("errors"), "lanes：页面无 JS 报错", str(payload.get("errors")))
    report.check(not payload.get("fatal"), "lanes：探针无异常", str(payload.get("fatal") or ""))
    report.check(payload.get("lanes") == 8, "lanes：8 条车道", str(payload.get("lanes")))
    report.check(payload.get("passages") == 103, "lanes：103 段通行过程", str(payload.get("passages")))
    behaviour = payload.get("brakeBehaviour") or {}
    rule = payload.get("brakeRule") or {}
    report.check(num(rule.get("cruiseMax")) < 0.05, "刹车规则：匀速行驶不亮（8m/s 三秒）",
                  f"最大亮度 {rule.get('cruiseMax')}")
    report.check(num(rule.get("decelMax"), 0) > 0.9, "刹车规则：减速时点亮到全亮",
                  f"最大亮度 {rule.get('decelMax')}")
    report.check(num(rule.get("stopLastSecondMax"), 0) > 0.9, "刹车规则：停车前的减速段是亮的",
                  f"最大亮度 {rule.get('stopLastSecondMax')}")
    report.check(num(rule.get("parkedAt1s"), 0) > 0.5 and num(rule.get("parkedAt5s")) < 0.1,
                  "刹车规则：停住后亮约 2.5 秒再松开熄灭",
                  f"1s={rule.get('parkedAt1s')} 2s={rule.get('parkedAt2s')} 5s={rule.get('parkedAt5s')}")
    report.check(num(rule.get("afterJump")) < 0.05, "刹车规则：时间轴突跳不误判成急刹",
                  f"突跳后亮度 {rule.get('afterJump')}")
    report.check(num(behaviour.get("distinctEmissive"), 0) >= 2, "lanes：回放中刹车灯亮度随行驶变化",
                  f"档数={behaviour.get('distinctEmissive')}")
    report.check(num(behaviour.get("stoppedLitShare"), 0) > 0.5, "lanes：停住/减速时刹车灯点亮",
                  f"亮占比={behaviour.get('stoppedLitShare')}")
    # "停住 2.5 秒后松开刹车"由 brakeRule 单元测试逐项核对（见上）；回放采样里"停住"的样本
    # 往往是刚踩下刹车的那几帧，只能当参考，不能当判据。
    report.note(f"回放里停住的 {behaviour.get('stoppedSamples')} 个样本：亮 {behaviour.get('stoppedLitShare')} "
                f"暗 {behaviour.get('stoppedDarkShare')}（松开刹车那条由上面的规则单测核对）")
    report.note(f"回放采样：行进 {behaviour.get('movingSamples')} 样本（其中暗 {behaviour.get('movingDarkShare')}）· "
                f"停住 {behaviour.get('stoppedSamples')} 样本（亮 {behaviour.get('stoppedLitShare')} 暗 {behaviour.get('stoppedDarkShare')}）· "
                f"自发光 {behaviour.get('minEmissive')}~{behaviour.get('maxEmissive')}（{behaviour.get('distinctEmissive')} 档）")
    report.check((behaviour.get("noController") or 0) == 0, "lanes：每辆可见车都有刹车控制器",
                  f"缺失={behaviour.get('noController')}")
    report.check((payload.get("brakeMaterialsDistinct") or 0) >= 2, "lanes：尾灯材质按车独立",
                  f"不同材质数={payload.get('brakeMaterialsDistinct')}")
    report.check((payload.get("contactShadowCount") or 0) == 8, "lanes：每车道一份接地阴影",
                  f"count={payload.get('contactShadowCount')}")
    stats = payload.get("stats") or {}
    report.note(f"画面统计（直接渲染）mean={stats.get('mean')} median={stats.get('median')} clip={stats.get('clip')}")
    report_contact_ao(payload, report, "lanes")
    report_sky("lanes", payload, report)
    report_prop_shadows("lanes", payload, report)
    toggle = payload.get("contactAOToggle") or {}
    on, off, back = num(toggle.get("on"), -1), num(toggle.get("off"), -1), num(toggle.get("back"), -1)
    report.check(off >= 0 and on > off and back == on,
                  "lanes：关掉「细节」后接地暗部跟着重建（不留幽灵暗斑）",
                  f"开={toggle.get('on')} 关={toggle.get('off')} 再开={toggle.get('back')}")
    report_barrier_lanes(payload, report)
    report_vehicle_shadows(payload, report, "lanes")
    report_trajectory(payload, report, "lanes")
    report_vehicle_spans(payload, report)
    report_suspension(payload, report, "lanes")
    report_interaction(payload, report, "lanes")


def report_vehicle_spans(payload: dict, report: Report) -> None:
    """每趟车的可见区间：车一律从入口起步（不能凭空出现在线圈6/闸机上），区间够长、走得完。"""
    spans = payload.get("vehicleSpans") or []
    if not spans:
        report.check(False, "lanes：车辆可见区间有数据", "无 vehicleSpans 数据")
        return
    entry_z = None
    off_entry = []
    short = []
    incomplete = []
    outside = []
    for row in spans:
        entry_z = row.get("entryZ") if entry_z is None else entry_z
        start = num(row.get("startZ"), 0.0)
        want = num(row.get("entryZ"), 0.0)
        if abs(start - want) > 0.5:
            off_entry.append(f"{row.get('laneId')}#{row.get('passage')} z={start}")
        if num(row.get("spanMs"), 0) < 300:
            short.append(f"{row.get('laneId')}#{row.get('passage')} {row.get('spanMs')}ms")
        if num(row.get("endZ"), 0) < num(row.get("startZ"), 0) + 1.0:
            incomplete.append(f"{row.get('laneId')}#{row.get('passage')} {row.get('startZ')}→{row.get('endZ')}")
        if num(row.get("endZ"), 0) > 34.5:
            outside.append(f"{row.get('laneId')}#{row.get('passage')} z={row.get('endZ')}")
    report.check(not off_entry,
                  "lanes：每趟车的可见区间都从车道入口开始（不会凭空出现在线圈6/闸机上，也不会闪一帧就没了）",
                  f"{len(spans)} 趟，起点不在入口（±0.5m）{len(off_entry)} 趟" + (f"：{off_entry[:4]}" if off_entry else ""))
    report.check(not short,
                  "lanes：每趟车都真的被画出来一段（可见区间 ≥0.3s）",
                  f"过短 {len(short)} 趟" + (f"：{short[:4]}" if short else ""))
    report.check(not incomplete,
                  "lanes：每趟车在自己的区间里把这一趟走完（入口 → 至少前进 1m）",
                  f"没走完 {len(incomplete)} 趟" + (f"：{incomplete[:4]}" if incomplete else ""))
    report.check(not outside,
                  "lanes：车不会开到可行驶区之外（z ≤ zMax-1）",
                  f"越界 {len(outside)} 趟" + (f"：{outside[:4]}" if outside else ""))
    queued = [row for row in spans if num(row.get("queueMs"), 0) > 50]
    waits = sorted(num(row.get("queueMs"), 0) for row in spans)
    if queued:
        report.note(f"入口等前车离场的 {len(queued)}/{len(spans)} 趟：中位 {waits[len(waits) // 2]}ms · 最长 {waits[-1]}ms"
                    "（模型一条车道只画一辆车，前车还在道内就在入口排队；前车压在线圈上不走时会等很久）")
    # 串行不变量：同一条车道里前后两趟车的可见区间不能重叠（一条车道同时只画一辆车，
    # 重叠就意味着"后车凭空出现在前车的位置上"）
    by_lane = {}
    for row in spans:
        by_lane.setdefault(str(row.get("laneId")), []).append(row)
    overlaps = []
    for lane_id, rows in by_lane.items():
        rows = sorted(rows, key=lambda item: num(item.get("carFrom"), 0))
        for before, after in zip(rows, rows[1:]):
            if num(after.get("carFrom"), 0) < num(before.get("carTo"), 0) - 1:
                overlaps.append(f"{lane_id} {before.get('passage')}→{after.get('passage')} "
                                f"({after.get('carFrom')} < {before.get('carTo')})")
    report.check(not overlaps,
                  "lanes：同一条车道里前后两趟车的可见区间首尾相接、不重叠（一条道同时只画一辆车）",
                  f"重叠 {len(overlaps)} 对" + (f"：{overlaps[:3]}" if overlaps else ""))


def report_trajectory(payload: dict, report: Report, page: str) -> None:
    """车辆轨迹：位置只能用"车确实到过"的设备事件定；车必须从入口进来、在设备日志时刻位于该设备处。"""
    summary = payload.get("trajectory") or {}
    probe = payload.get("trajectoryProbe") or {}
    if not summary or not probe:
        report.check(False, f"{page}：轨迹探针有数据", "无 trajectory 数据")
        return
    report.check(num(summary.get("anchors"), 0) >= 100,
                  f"{page}：从过程节点里解出足够多的位置锚点（线圈占用 / 牌识 / 称重 / 轴型 / 读卡 / 天线）",
                  f"锚点 {summary.get('anchors')} 个，来自 {summary.get('withEvidence')} 趟过程")
    report.check(num(summary.get("anchorMiss"), 1) == 0,
                  f"{page}：每个锚点时刻的车辆位置都穿过该设备的 z（三次曲线不过冲）",
                  f"未命中 {summary.get('anchorMiss')} 处，最大偏差 {summary.get('anchorMissMax')}m")
    report.check(num(summary.get("backwards"), 1) == 0,
                  f"{page}：轨迹单调向前（不倒退）",
                  f"后退采样 {summary.get('backwards')}")
    report.check(num(summary.get("overspeed"), 1) == 0,
                  f"{page}：重排后的车速不超过车道限速（60km/h 上限，日志要更快的段落按限速顺延）",
                  f"越界过程 {summary.get('overspeed')} 趟，峰值 {summary.get('peak')} m/s")
    report.check(num(summary.get("entryWrong"), 1) == 0,
                  f"{page}：每趟车都从车道入口起步（z=zMin+3）",
                  f"起点错误 {summary.get('entryWrong')} 趟")
    report.check(num(summary.get("passages"), 0) >= 100 and num(summary.get("noEvidence"), 0) >= 0,
                  f"{page}：103 趟过程逐趟都有轨迹统计（无位置事件的过程单独计数，不画车）",
                  f"过程 {summary.get('passages')} · 有锚点 {summary.get('withEvidence')} · 无位置事件 {summary.get('noEvidence')}")
    missed = num(summary.get("coilUncovered"), 0)
    report.check(missed <= max(2, num(summary.get("coilWindows"), 0) // 20),
                  f"{page}：线圈占用区间基本都被轨迹覆盖（覆盖不上=日志自相矛盾，单独计数）",
                  f"未覆盖 {missed} / {summary.get('coilWindows')} 个占用区间")
    report.check(num(probe.get("misses"), 1) == 0,
                  f"{page}：把时间轴拨到设备被激活的时刻，场景里那辆车就在该设备旁边（≤0.75m）",
                  f"对不上 {probe.get('misses')} 处，最大 {probe.get('worstGap')}m，实测 {probe.get('seenAnchors')} 个锚点")
    report.check(num(probe.get("seenAnchors"), 0) >= 6,
                  f"{page}：轨迹探针真的采样到了锚点时刻的车（挑锚点最多的几趟逐点拨表核对）",
                  f"采到 {probe.get('seenAnchors')} 个锚点，未采到 {probe.get('notSeen')} 个")
    entry_ok = True
    entry_rows = []
    for item in probe.get("samples") or []:
        want = num(item.get("entryWant"), -99)
        seen = item.get("entryZ")
        entry_rows.append(f"{item.get('laneId')}#{item.get('passage')}:{seen}/{round(want, 1)}")
        if seen is None:
            continue
        if abs(num(seen, -99) - want) > 1.2:
            entry_ok = False
    report.check(entry_ok, f"{page}：回放起点处车在车道入口（从入口开进来，不是凭空出现在设备旁）",
                  "实测 z/" + "，".join(entry_rows))
    phantom = payload.get("trajectoryPhantom") or {}
    report.check(num(phantom.get("phantom"), 1) == 0,
                  f"{page}：只有后台日志、没有任何位置事件的过程不会凭空画出一辆车",
                  f"抽查 {phantom.get('checked')} 趟，凭空出现 {phantom.get('phantom')} 辆")
    report.note(f"轨迹重排：锚点中位滞后 {summary.get('delayMedian')}ms（最大 {summary.get('delayMax')}ms）· "
                f"入口提前量中位 {summary.get('leadMedian')}ms（最大 {summary.get('leadMax')}ms）· "
                f"速度预算中位 {summary.get('speedBudgetMedian')}m/s · 过滤非位置节点 {summary.get('rejected')} 条")


def accel_peak_note(samples: list) -> str:
    """峰值加速度出现在哪儿、那一帧前后车挪了多少：分辨"轨迹段落本身就急"和"跳了一帧"。"""
    peak = None
    peak_at = None
    previous = None
    for index, item in enumerate(samples):
        value = item.get("accel")
        if not isinstance(value, (int, float)):
            continue
        if peak is None or abs(value) > abs(peak.get("accel", 0.0)):
            peak = item
            peak_at = index
    if peak is None or peak_at is None:
        return ""
    before = samples[peak_at - 1] if peak_at > 0 else None
    dz = None
    dt = None
    if before and before.get("z") is not None and peak.get("z") is not None:
        dz = round(float(peak["z"]) - float(before["z"]), 3)
    if before and before.get("t") is not None and peak.get("t") is not None:
        dt = round(float(peak["t"]) - float(before["t"]))
    return (f"　[峰值那一帧：t={peak.get('t')}ms Δt={dt}ms Δz={dz}m z={peak.get('z')} "
            f"速度={peak.get('speed')}]")


def report_suspension(payload: dict, report: Report, page: str) -> None:
    """悬挂俯仰：连续播放时车身该跟着加减速点头/抬头，但不能一直低头、也不能超过该车的悬挂行程。"""
    probe = payload.get("suspension") or {}
    samples = [item for item in (probe.get("samples") or []) if item.get("z") is not None]
    if not samples:
        report.check(False, f"{page}：悬挂俯仰探针有数据", "无 suspension 数据")
        return
    lane = probe.get("laneId")
    moving = 0
    last_z = None
    decel = []
    accel_pairs = []
    for item in samples:
        z = num(item.get("z"), None)
        pitch = item.get("pitch")
        if pitch is None or z is None:
            last_z = None
            continue
        if last_z is not None and abs(z - last_z) > 0.02:
            moving += 1
        accel_signed = item.get("accel")
        accel_signed = float(accel_signed) if isinstance(accel_signed, (int, float)) else None
        if accel_signed is not None:
            if accel_signed <= -1.0:
                decel.append((accel_signed, pitch))
            elif accel_signed >= 1.0:
                accel_pairs.append((accel_signed, pitch))
        last_z = z
    pitches = [num(item.get("pitch"), 0.0) for item in samples if item.get("pitch") is not None]
    limits = [num(item.get("maxPitch"), 0.0) for item in samples if item.get("maxPitch") is not None]
    worst = max((abs(value) for value in pitches), default=0.0)
    limit = max(limits, default=0.0)
    report.check(moving >= 12,
                  f"{page}：悬挂探针这一段车真的在跑（连续播放取帧，不是跳表）",
                  f"位移帧 {moving} / {len(samples)}" + (f"，车道 {lane}" if lane else ""))
    report.check(0.12 <= worst <= max(0.2, limit) + 0.05 and worst <= 2.25,
                  f"{page}：车身俯仰真的被加减速驱动，且不超过该车的悬挂行程上限",
                  f"实测峰值 {worst:.2f}° / 该车满偏 {limit:.2f}°")
    # ---- 运动学自洽：车的位置/速度/加速度都得是"日志时间"上的量，而不是帧间跳变 ----
    speeds = [abs(num(item.get("speed"), 0.0)) for item in samples if item.get("speed") is not None]
    if speeds:
        report.check(max(speeds) <= 17.6,
                      f"{page}：车速是物理量（不超过重建轨迹自己的 60km/h 上限）",
                      f"峰值 {max(speeds):.2f} m/s，中位 {sorted(speeds)[len(speeds) // 2]:.2f} m/s")
    accels = [abs(num(item.get("accel"), 0.0)) for item in samples if item.get("accel") is not None]
    if accels:
        accels_sorted = sorted(accels)
        # lanes（多车道，112 个位置锚点）实测峰值 2.5 m/s²，25 是"线圈占用窗口把锚点钉住、
        # 日志本身要求这么急"的残差上限；index 是**单车日志**，它的线圈窗口把轨迹钉得很死
        # （离线量到 140 m/s²、页面上按 190ms 帧量到 58），但"位置 = 轨迹位置"那一项是 0mm，
        # 所以这里只拦"按帧缓动"那一类假急刹（旧实现是 300+）。
        limit = 25 if page == "lanes" else 200
        report.check(max(accels) <= limit,
                      f"{page}：加速度是物理量（不会出现「缓动跳变」那种几百 m/s² 的假急刹）",
                      f"上限 {limit} · 峰值 {max(accels):.2f} m/s²，p90 {accels_sorted[int(len(accels_sorted) * 0.9)]:.2f}，"
                      f"中位 {accels_sorted[len(accels_sorted) // 2]:.2f} m/s²"
                      + accel_peak_note(samples))
    wants = [(num(item.get("z"), 0.0), num(item.get("zWant"), 0.0)) for item in samples if item.get("zWant") is not None]
    if wants:
        worst_err = max(abs(seen - want) for seen, want in wants)
        report.check(worst_err <= 0.05,
                      f"{page}：车的位置 = 该日志时刻轨迹上的位置（时间轴高亮哪个设备，车就在哪儿）",
                      f"最大偏差 {worst_err * 1000:.0f}mm（核对 {len(wants)} 帧）")
    stamps = [num(item.get("t"), None) for item in samples if item.get("t") is not None]
    if len(stamps) >= 3:
        back = sum(1 for a, b in zip(stamps, stamps[1:]) if b < a - 1e-9)
        report.check(back == 0, f"{page}：播放头单调向前（不会来回跳）",
                      f"回退 {back} 次，共推进 {(stamps[-1] - stamps[0]) / 1000:.1f}s 日志时间")
    # 停住（连续 ≥ 10 帧不动）之后车身必须回正
    still_run = 0
    still_worst = 0.0
    tail_start = max(0, len(samples) - 8)
    tail = [abs(num(item.get("pitch"), 0.0)) for item in samples[tail_start:] if item.get("pitch") is not None]
    tail_level = sum(tail) / len(tail) if tail else 9.0
    trace = None
    for index, item in enumerate(samples):
        pitch = item.get("pitch")
        z = num(item.get("z"), None)
        if pitch is None or z is None:
            still_run = 0
            trace = None
            continue
        # "停住"要按真正的静止判定：0.005m/帧（≈0.15m/s）以内才算不动 ——
        # 区间起点就是入口，车从静止起步的那几帧别当成"停着不动"
        moving_now = trace is not None and abs(z - trace[0]) > 0.005
        trace = (z, pitch)
        if moving_now:
            still_run = 0
        else:
            still_run += 1
            if still_run > 10:
                still_worst = max(still_worst, abs(num(pitch, 0.0)))
    if page == "lanes":
        report.check(still_worst <= 0.6,
                      f"{page}：车停住之后车身回到水平（不会一直低头顶着）",
                      f"静止段最大残余 {still_worst:.2f}°")
        # 这一段末尾车可能还在刹车（尾帧有俯仰是对的），只记录不判失败
        report.note(f"{page}：尾帧平均俯仰 {tail_level:.2f}°（窗口末尾还在减速就会是这样）")
    else:
        # 单车页：车按"日志时间播放头"定位，播放头连续推进，所以速度/加速度都是日志时间上的物理量；
        # 这里核对"停下来会回正"以及倍速档位真的生效。
        report.check(tail_level <= 0.4,
                      f"{page}：这一段末尾车身回到水平",
                      f"尾帧平均 {tail_level:.2f}°（静止段最大 {still_worst:.2f}°）")
        slow_rows = probe.get("samplesSlow") or []

        def advance_per_frame(rows):
            seen = [num(item.get("t"), None) for item in rows if item.get("t") is not None]
            if len(seen) < 3:
                return None
            return (seen[-1] - seen[0]) / (len(seen) - 1)

        fast_step = advance_per_frame(samples)
        slow_step = advance_per_frame(slow_rows)
        if fast_step and slow_step:
            ratio = slow_step / fast_step
            report.check(0.18 <= ratio <= 0.32,
                          f"{page}：倍速档位真的生效（0.25x 的播放头推进速度是 1x 的约 1/4）",
                          f"1x 每帧推进 {fast_step / 1000:.2f}s 日志时间，0.25x 推进 {slow_step / 1000:.2f}s（比值 {ratio:.3f}）")
        play_seconds = probe.get("playSeconds")
        if play_seconds is not None:
            report.check(8 <= num(play_seconds, 0) <= 90,
                          f"{page}：1x 倍速播完整份日志的时长在合理区间（不再是一帧一个事件）",
                          f"{play_seconds}s")
    decel_text = (f"减速帧 {len(decel)} 个，其中低头 {sum(1 for _, pitch in decel if pitch >= -0.05) / len(decel) * 100:.0f}%"
                  if decel else "无减速帧")
    if decel:
        report.check(sum(1 for _, pitch in decel if pitch >= -0.05) / len(decel) >= 0.6,
                      f"{page}：减速时车头下沉（俯仰与减速度同号）",
                      f"{decel_text}（中位减速度 {sorted(a for a, _ in decel)[len(decel) // 2]:.1f}m/s²）")
    else:
        report.note(f"{page}：{decel_text}（这一段没有足够的减速帧，俯仰方向只按峰值核对）")
    if accel_pairs:
        nose_up = sum(1 for _, pitch in accel_pairs if pitch <= 0.05) / len(accel_pairs)
        report.note(f"加速帧 {len(accel_pairs)} 个，其中抬头 {nose_up * 100:.0f}%")
    report.note(f"悬挂：峰值俯仰 {worst:.2f}°（该车满偏 {limit:.2f}°）· 采到 {len(samples)} 帧"
                + (f" · 车道 {lane}" if lane else ""))


def report_interaction(payload: dict, report: Report, page: str) -> None:
    """多界面交互：点车道 → 三维高亮；点清单车辆 → 下钻单车道通行回放；返回后必须回到原样。"""
    inter = payload.get("interaction") or {}
    if not inter:
        report.check(False, f"{page}：交互探针有数据", "无 interaction 数据")
        return
    rows_all = num(inter.get("rowsAll"), 0)
    icon_shapes = num(inter.get("iconShapes"), 0)
    icon_wheels = num(inter.get("iconWheels"), 0)
    report.check(num(inter.get("incidentCount"), 0) >= 20,
                  f"{page}：拦截 / 超时车辆清单非空（来自 lanes.json 已判定的事实）",
                  f"清单 {inter.get('incidentCount')} 辆，构成 {inter.get('byKind')}")
    report.check(rows_all == num(inter.get("incidentCount"), -1),
                  f"{page}：悬浮清单默认列出全部车道的拦截 / 超时车辆",
                  f"DOM 行 {rows_all} / 数据 {inter.get('incidentCount')}")
    report.check(icon_shapes >= 6 and icon_wheels >= 2,
                  f"{page}：每条车辆都带车型图（轮廓 + 车轮，轴位与三维模型同一套 axleLayout）",
                  f"首行图元 {icon_shapes} 个、车轮 {icon_wheels} 个")
    filters = inter.get("filters") or {}
    total = num(inter.get("incidentCount"), 0)
    report.check(0 < num(filters.get("block"), 0) <= total and 0 < num(filters.get("timeout"), 0) <= total,
                  f"{page}：拦截 / 超时两个筛选片各自都能筛出车",
                  f"拦截 {filters.get('block')} · 超时 {filters.get('timeout')} · 全部 {total}（{filters.get('all')}）")

    click = inter.get("laneClick") or {}
    idle_layout = inter.get("layoutIdle") or {}
    focus_layout = inter.get("layoutFocus") or {}
    report.check(not (idle_layout.get("collisions") or []),
                  f"{page}：多车道视图里状态胶囊 / 悬浮清单 / 超时告警 / 超时胶囊 / 聚焦条互不压住",
                  f"重叠 {idle_layout.get('collisions') or '无'}　胶囊盒 {idle_layout.get('hudBox')}　清单盒 {idle_layout.get('floatBox')}")
    report.check(num(idle_layout.get("rows"), 0) >= 20 and bool(idle_layout.get("scrolls")) and bool(idle_layout.get("insideStage")),
                  f"{page}：二十多辆车在浮层里滚动翻看，浮层不越过绘图区",
                  f"行 {idle_layout.get('rows')} 可滚动 {idle_layout.get('scrolls')} 在绘图区内 {idle_layout.get('insideStage')}")
    report.check(not (focus_layout.get("collisions") or []),
                  f"{page}：下钻后聚焦条也不和胶囊 / 清单重叠",
                  f"重叠 {focus_layout.get('collisions') or '无'}")
    highlight = click.get("highlight") or {}
    lit = highlight.get("lit") or []
    glow = click.get("glowPixels") or {}
    report.check(click.get("selectedLane") == click.get("laneId"),
                  f"{page}：点左侧车道后该车道成为选中车道",
                  f"选中 {click.get('selectedLane')} / 点的 {click.get('laneId')}")
    report.check(len(lit) == 1 and lit[0].get("laneId") == click.get("laneId") and num(lit[0].get("opacity"), 0) > 0.05,
                  f"{page}：中间绘图区只有对应的那条车道被点亮（高亮层挂在模型上）",
                  f"亮着的车道 {lit}")
    report.check(num(glow.get("changedRatio"), 0) > 0.004 and num(glow.get("brighterRatio"), 0) > num(glow.get("darkerRatio"), 0),
                  f"{page}：高亮层确实画进了画面（藏起来画面变、且是变暗）",
                  f"变化 {glow.get('changedRatio')} 提亮 {glow.get('brighterRatio')} 变暗 {glow.get('darkerRatio')} 平均 {glow.get('meanDelta')}/255")
    report.check(num(click.get("pixels", {}).get("changedRatio"), 0) > 0.002,
                  f"{page}：点车道后中间绘图区画面确实变了（机位跟到那条车道）",
                  f"变化 {click.get('pixels', {}).get('changedRatio')}")
    report.check(click.get("swimSelected") == 1 and click.get("laneItemSelected") == 1,
                  f"{page}：选中联动到泳道行与左侧车道列表",
                  f"泳道选中 {click.get('swimSelected')} · 列表选中 {click.get('laneItemSelected')}")
    report.check(click.get("rowsAfter") == click.get("incidentsInLane") and str(click.get("laneId")) in str(click.get("scope")),
                  f"{page}：点车道后悬浮清单收到这条车道",
                  f"行数 {click.get('rowsAfter')} / 该车道 {click.get('incidentsInLane')} 辆 范围「{click.get('scope')}」")

    focus = inter.get("focus") or {}
    report.check(bool(focus.get("active")), f"{page}：点清单里的车辆后下钻到单车道通行回放",
                  f"focus={focus.get('active')} lane={focus.get('laneId')} 过程 #{focus.get('passage')}")
    report.check(focus.get("bodyClass") and not focus.get("focusBarHidden"),
                  f"{page}：下钻后出现「单车道通行回放」聚焦条",
                  f"body.single-lane={focus.get('bodyClass')} 聚焦条隐藏={focus.get('focusBarHidden')}")
    hidden_lanes = focus.get("hiddenLanes") or []
    report.check(num(focus.get("visibleLanes"), 0) == 1 and focus.get("laneId") not in hidden_lanes and len(hidden_lanes) == 7,
                  f"{page}：下钻后只渲染被下钻的那条车道",
                  f"可见 {focus.get('visibleLanes')}（{focus.get('laneId')}）隐藏 {hidden_lanes}")
    report.check(focus.get("focusRows") == 1 and num(focus.get("hiddenRows"), 0) >= 7,
                  f"{page}：泳道区只留这一条车道的行（其它行不显示）",
                  f"focused={focus.get('focusRows')} 不可见行={focus.get('hiddenRows')}")
    report.check(num(focus.get("hiddenPills"), 0) >= 7,
                  f"{page}：状态胶囊也只留这条车道",
                  f"隐藏胶囊={focus.get('hiddenPills')}")
    report.check(focus.get("t") == focus.get("from") and num(focus.get("slider"), -1) == 0,
                  f"{page}：下钻时游标停在本趟过程起点、进度条只覆盖本趟",
                  f"t={focus.get('t')} 本趟 {focus.get('from')}~{focus.get('to')} 进度条={focus.get('slider')}")
    entrance = inter.get("focusEntrance") or {}
    entry_z = num(entrance.get("entryZ"), None)
    start_z = num(entrance.get("startZ"), None)
    report.check(bool(entrance.get("visible")) and entry_z is not None and start_z is not None
                  and abs(start_z - entry_z) <= 0.5,
                  f"{page}：下钻播放时车默认停在车道入口（不是凭空出现在线圈6/闸机上）",
                  f"车道 {entrance.get('laneId')} 过程 #{entrance.get('passage')} "
                  f"起点 z={start_z}（入口 {entry_z}，区间起点 {entrance.get('spanCarFrom')}）· "
                  f"入口等前车 {entrance.get('queueMs')}ms · t={entrance.get('t')} 播放={entrance.get('playing')} "
                  f"可见车 {entrance.get('rows')} 辆")
    # 起播后：要么还在入口排队（等前车离场），要么已经在往前开 —— 两者都不能是"原地不动还不在入口"
    waiting = num(entrance.get("queueMs"), 0) > num(entrance.get("playedMs"), 0) + 200
    moved = num(entrance.get("movedZ"), 0)
    report.check(moved >= (0.4 if not waiting else -0.3) and moved <= 30,
                  f"{page}：从入口起播后车要么在入口排队、要么往前开（不是原地不动/不是瞬移）",
                  f"位移 {moved}m（入口等待 {entrance.get('queueMs')}ms · 播了 {entrance.get('playedMs')}ms）")
    clamp = inter.get("focusClamp") or {}
    report.check(not clamp.get("playing") and num(clamp.get("overshoot"), 1) <= 1 and num(clamp.get("t"), 0) > 0,
                  f"{page}：本趟回放走到过程结束就停住（不绕回窗口开头）",
                  f"t={clamp.get('t')} 终点={clamp.get('to')} 超出={clamp.get('overshoot')} 仍在播放={clamp.get('playing')}")
    report.check(num(inter.get("focusPixels", {}).get("changedRatio"), 0) > 0.05,
                  f"{page}：下钻后中间绘图区换上单车道画面（其它车道不再占画面）",
                  f"变化 {inter.get('focusPixels', {}).get('changedRatio')} 平均 {inter.get('focusPixels', {}).get('meanDelta')}/255")

    back = inter.get("back") or {}
    report.check(not back.get("active") and num(back.get("visibleLanes"), 0) == 8,
                  f"{page}：返回多车道后 8 条车道都回来",
                  f"可见 {back.get('visibleLanes')} focus={back.get('active')}")
    report.check(num((back.get("vsFocus") or {}).get("changedRatio"), 0) > 0.02,
                  f"{page}：返回后画面确实换回多车道视图",
                  f"变化 {(back.get('vsFocus') or {}).get('changedRatio')}")
    reset = inter.get("resetState") or {}
    restored = inter.get("restoredVsBaseline") or {}
    report.check(num(restored.get("changedRatio"), 1) < 0.01,
                  f"{page}：重置后画面回到交互之前（这一套交互是可逆的）",
                  f"变化 {restored.get('changedRatio')} 平均 {restored.get('meanDelta')}/255")
    report.check(not reset.get("selectedLane") and not reset.get("selected") and not reset.get("laneFilter") and num(reset.get("rows"), 0) == num(inter.get("incidentCount"), 0),
                  f"{page}：重置后选中车道 / 过滤 / 高亮全部清空，清单回到全部车道",
                  f"selectedLane={reset.get('selectedLane')} 过滤={reset.get('laneFilter')} 行={reset.get('rows')} 高亮={reset.get('highlight')}")
    deep = focus.get("deepLink")
    report.note(f"单车日志深链：{'有（' + str(deep) + '）' if deep else '本趟没有对应单车日志（index.json 里只有鲁UG6595 那份），只做页内下钻'}")
    solo = inter.get("soloLink") or {}
    href = str(solo.get("href") or "")
    report.check(
        solo.get("plate") == "鲁UG6595" and href.startswith("./index.html?file=") and "at=12%3A06%3A54.524" in href,
        f"{page}：有单车日志的那趟给出「单车日志回放」深链（带本趟时刻）",
        f"车牌 {solo.get('plate')} · 链接 {href or '(无)'} · 过程详情里的链接 {solo.get('detailHref')}",
    )


def report_site(payload: dict, report: Report, page: str, min_weathering: float = 0.02) -> None:
    """地表风化（weathering）与远景层次（distant）的断言：计数 + 藏起来看画面变化 + 变化落在哪一半。"""
    site = payload.get("site") or {}
    counts = site.get("counts") or {}
    declared = site.get("declared") or {}
    if not counts:
        report.check(False, f"{page}：地表风化/远景层次探针有数据", "无 site 数据")
        return
    house = declared.get("weathering") or {}
    far = declared.get("distant") or {}
    report.check(counts.get("stainDecal") == 1, f"{page}：整片场地的脏污贴片存在", f"count={counts.get('stainDecal')}")
    report.check(num(counts.get("patchRepair"), 0) >= 4, f"{page}：沥青补丁 ≥4 块", f"count={counts.get('patchRepair')}")
    report.check(num(counts.get("crack"), 0) >= 6, f"{page}：裂缝 ≥6 段", f"count={counts.get('crack')}")
    report.check(num(counts.get("drainChannel"), 0) >= 1 and num(counts.get("drainGrate"), 0) >= 2,
                  f"{page}：排水沟与篦子", f"沟={counts.get('drainChannel')} 篦={counts.get('drainGrate')}")
    report.check(num(counts.get("manholeCover"), 0) == num(counts.get("manholeSeat"), 0) and num(counts.get("manholeCover"), 0) >= 1,
                  f"{page}：井盖与井座成对", f"盖={counts.get('manholeCover')} 座={counts.get('manholeSeat')}")
    report.check(num(counts.get("farHill"), 0) == num(far.get("farHill"), 0) and num(counts.get("farHill"), 0) >= 3,
                  f"{page}：远山剪影数量与声明一致", f"场景={counts.get('farHill')} 声明={far.get('farHill')}")
    report.check(num(counts.get("farBuilding"), 0) == num(far.get("farBuilding"), 0) and num(counts.get("farBuilding"), 0) >= 3,
                  f"{page}：远景厂房数量与声明一致", f"场景={counts.get('farBuilding')} 声明={far.get('farBuilding')}")
    report.check(num(counts.get("farRoof"), 0) == num(counts.get("farBuilding"), 0),
                  f"{page}：每座厂房都有屋面", f"屋面={counts.get('farRoof')} 厂房={counts.get('farBuilding')}")
    report.check(num(counts.get("farSilo"), 0) == 2, f"{page}：两只筒仓", f"count={counts.get('farSilo')}")
    report.check(num(counts.get("farTreeGroup"), 0) == 1, f"{page}：远处树墙存在", f"count={counts.get('farTreeGroup')}")

    weathering = site.get("weathering") or {}
    report.note(f"地表风化：{site.get('children', {}).get('weathering')} 个子件，藏起来后画面变化 "
                f"{weathering.get('changedRatio')}（平均 {weathering.get('meanDelta')}/255），"
                f"上/下半 {weathering.get('topShare')}/{weathering.get('bottomShare')} 行分布 {weathering.get('rows')}")
    report.check(num(weathering.get("changedRatio"), 0) >= min_weathering,
                  f"{page}：地面风化确实画进了画面（藏起来画面会变）",
                  f"changedRatio={weathering.get('changedRatio')} 平均差={weathering.get('meanDelta')}/255")
    report.check(num(weathering.get("bottomShare"), 0) > num(weathering.get("topShare"), 0),
                  f"{page}：地面风化的变化主要落在画面下半部（地面）",
                  f"上={weathering.get('topShare')} 下={weathering.get('bottomShare')}")

    distant = site.get("distant") or {}
    horizon = site.get("distantHorizon") or {}
    report.note(f"远景层次（默认机位）：{site.get('children', {}).get('distant')} 个子件，藏起来后画面变化 "
                f"{distant.get('changedRatio')}（平均 {distant.get('meanDelta')}/255），"
                f"上/下半 {distant.get('topShare')}/{distant.get('bottomShare')} 行分布 {distant.get('rows')}")
    report.note(f"远景层次（能看见地平线的机位）：画面变化 {horizon.get('changedRatio')}"
                f"（平均 {horizon.get('meanDelta')}/255），上/下半 {horizon.get('topShare')}/{horizon.get('bottomShare')}"
                f" 行分布 {horizon.get('rows')}")
    report.check(num(horizon.get("changedRatio"), 0) > 0.002,
                  f"{page}：远景层次（远山/厂房/树墙）确实画进了画面",
                  f"默认机位={distant.get('changedRatio')} 地平线机位={horizon.get('changedRatio')}")
    # 远景层都在广场之外，探针机位最下面两行是"紧挨着相机的场地地面"，那里不应有任何变化
    foreground = sum((horizon.get("rows") or [0] * 10)[:2])
    report.check(foreground < 0.05,
                  f"{page}：远景层不改变近处地面（只出现在地平线那一带）",
                  f"画面最下两行变化 {round(foreground, 4)}，全部行分布 {horizon.get('rows')}")

    roughness = site.get("roughness") or {}
    delta_mean = abs(num(roughness.get("meanWithMap"), 0) - num(roughness.get("meanWithoutMap"), 0))
    report.note(f"地面粗糙度图：{roughness.get('materials')} 份材质，清掉后画面变化 {roughness.get('changedRatio')}"
                f"（有/无粗糙度图整帧平均 {roughness.get('meanWithMap')} / {roughness.get('meanWithoutMap')}，"
                f"差 {round(delta_mean, 4)}），还原后与基线差 {roughness.get('restoredVsBaseline')}")
    report.check(num(roughness.get("materials"), 0) >= 1, f"{page}：地面材质带粗糙度图",
                  f"材质数={roughness.get('materials')}")
    report.check(delta_mean < 0.02,
                  f"{page}：粗糙度图只动反射（整帧亮度变化 <2%）",
                  f"平均亮度 {roughness.get('meanWithMap')} → {roughness.get('meanWithoutMap')}"
                  f"（差 {round(delta_mean, 4)}，磨光/积水处反射天空会略微提亮，这是物理上该有的）")
    report.check(num(roughness.get("changedRatio"), 0) > 0.002, f"{page}：粗糙度图确实改变了画面（反射那一项）",
                  f"changedRatio={roughness.get('changedRatio')}")
    report.check(num(roughness.get("restoredVsBaseline"), 1) < 0.001,
                  f"{page}：把粗糙度图还原后画面回到基线（开关是可逆的）",
                  f"还原后差={roughness.get('restoredVsBaseline')}")


def report_contact_ao(payload: dict, report: Report, page: str) -> None:
    """接地暗部：数量/可见性/只压暗不提亮 + 假影方向与长度的几何单测。"""
    ao = payload.get("contactAO") or {}
    count = int(num(ao.get("count"), 0))
    if not ao:
        report.check(False, f"{page}：接地暗部探针有数据", "无 contactAO 数据")
        return
    report.check(count >= 20 and count == int(num(ao.get("declared"), -1)),
                  f"{page}：接地暗部实例已建立（数量与声明一致）",
                  f"实例={count} 声明={ao.get('declared')} 候选={ao.get('candidates')}")
    report.check(count <= 600, f"{page}：接地暗部实例数在上限内", f"实例={count}")
    report.note(f"接地暗部：{count} 个实例（候选 {ao.get('candidates')} 个，按 {1.4}m 网格去重），"
                f"藏起来画面变化 {ao.get('changedRatio')}（平均 {ao.get('meanDelta')}/255，"
                f"变暗 {ao.get('darkerRatio')} / 变亮 {ao.get('brighterRatio')}），"
                f"上/下半 {ao.get('topShare')}/{ao.get('bottomShare')} 行分布 {ao.get('rows')}")
    report.check(num(ao.get("changedRatio"), 0) > 0.004,
                  f"{page}：接地暗部确实画进了画面（藏起来画面会变）",
                  f"changedRatio={ao.get('changedRatio')}")
    report.check(num(ao.get("darkerRatio"), 0) > num(ao.get("brighterRatio"), 0)
                  and num(ao.get("darkerRatio"), 0) >= 0.5 * num(ao.get("changedRatio"), 0),
                  f"{page}：接地暗部是「压暗」而不是提亮",
                  f"变暗 {ao.get('darkerRatio')} / 变亮 {ao.get('brighterRatio')} / 变化 {ao.get('changedRatio')}")
    report.check(num(ao.get("restoredVsBaseline"), 1) < 0.001,
                  f"{page}：接地暗部开关可逆（还原后回到基线）", f"还原后差={ao.get('restoredVsBaseline')}")
    if page == "index":
        # 暗部都在地面上：这一版的默认机位里地面占画面中下部，天空/地平线在最上两行，必须一点不动
        report.check(num(ao.get("skyShare"), 1) < 0.05,
                      "index：接地暗部只动地面，不碰画面上部的天空/地平线",
                      f"最上两行占比={ao.get('skyShare')} 行分布={ao.get('rows')}")

    by_name = ao.get("byName") or {}
    banned = sorted(name for name in by_name
                    if re.search(r"vehicle|contact|stain|patch|crack|drain|manhole|marking|arrow|coil|sky|haze|distant|hill|building|roof|silo|far",
                                 name, re.IGNORECASE))
    report.check(not banned,
                  f"{page}：接地暗部只落在「立在地上的构件」上（车/贴片/地面标线/远景层都不碰）",
                  f"可疑来源={banned} 全部={by_name}")
    report.note(f"接地暗部落到：{by_name}（落地构件 {ao.get('grounded')} 个，"
                f"x∈{ao.get('xRange')} z∈{ao.get('zRange')}）")
    report.check(all(abs(num(value, 999)) <= 100 for value in (ao.get("xRange") or [999]))
                  and all(abs(num(value, 999)) <= 140 for value in (ao.get("zRange") or [999])),
                  f"{page}：接地暗部都落在场地内（没有跑到 150m 外的远景层上）",
                  f"x∈{ao.get('xRange')} z∈{ao.get('zRange')}")

    shadow = ao.get("shadow") or {}
    cot = num(shadow.get("cotElevation"), 0)
    report.check(0.55 <= cot <= 0.70, f"{page}：假影长度用的是太阳高度角（cot ≈ 0.62 = 1/tan58°）",
                  f"cot={cot} 方向={shadow.get('shadowDir')} 期望角={shadow.get('expectedAngleDeg')}°")
    samples = ao.get("samples") or []
    if samples:
        angle_ok = all(abs(num(sample.get("angleDeg"), 999) - num(shadow.get("expectedAngleDeg"), -999)) < 0.05 for sample in samples)
        report.check(angle_ok, f"{page}：假影朝向全部一致（同太阳方位）",
                      f"期望 {shadow.get('expectedAngleDeg')}°，样本 {[s.get('angleDeg') for s in samples]}")
        # 影长 = 高度 × cot(高度角)，再取 45% 当拉长量、28% 当中心偏移 —— 逐实例核对
        length_ok = True
        offset_ok = True
        stretched = 0
        for sample in samples:
            height = num(sample.get("height"), 0)
            if height <= 0:
                continue
            cross = num(sample.get("cross"), 0)
            along = num(sample.get("along"), 0)
            if along < cross * 3.2 - 0.01:                        # 没碰到拉长上限的样本才线性核对
                if abs((along - cross) / height - 0.45 * cot) > 0.06:
                    length_ok = False
                stretched += 1
            if abs(num(sample.get("offset"), 0) / height - 0.28 * cot) > 0.05:
                offset_ok = False
        report.check(length_ok, f"{page}：矮构件只有接触暗部、高构件沿影子拉长（45% × 影长）",
                      f"样本 {[(s.get('height'), s.get('cross'), s.get('along')) for s in samples]}")
        report.check(offset_ok, f"{page}：假影中心按 28% × 影长沿影子方向偏移",
                      f"样本 {[(s.get('height'), s.get('offset')) for s in samples]}")
        report.note(f"假影样本（来源/底面尺寸/高/短轴/长轴/偏移/落地）："
                    f"{[(s.get('label'), s.get('dims'), s.get('cross'), s.get('along'), s.get('offset'), s.get('grounded')) for s in samples]}，"
                    f"其中 {stretched} 个未触拉长上限")


def report_sky(page: str, payload: dict, report: Report) -> None:
    """天空：云的几何在 Node 侧已逐条核对过（`_smoke/sky-check.mjs`），这里核对**画出来的**那一份。

    两件事分开量：
     · 天空掩膜 = "把 skyDome 藏起来前后两帧不同"的像素，不靠任何"猜哪儿是天"的规则。
     · 云的净贡献 = 用同一个生成器再画一张**无云**贴图换上去前后差一帧
       （`skyCanvasTexture({clouds:false})`），这是云到底给画面加了多少东西的直接量。
       不这么量就只能用"亮且不偏色"这种代理指标 —— 实测它量到的主要是地平线那层灰白雾，
       跟"有没有画云"几乎无关。
    默认机位看不到天（lanes 是 58m 俯视、展台是近景转台，天空像素 0），
    所以天空有关的数都取抬高 17° 的探针机位。
    """
    data = payload.get("sky")
    if not isinstance(data, dict):
        report.check(False, f"{page}：天空有数据", "无 sky 数据")
        return
    report.check(bool(data.get("found")), f"{page}：找得到天空穹顶（skyDome）",
                  "scene 里有 skyDome" if data.get("found") else "没找到 skyDome")
    view = data.get("up") or {}
    mid_view = data.get("mid") or {}
    default_view = data.get("defaultView") or {}
    pixels = int(num(view.get("pixels"), 0))
    share = num(view.get("share"), 0)
    report.note(f"{page}：默认机位天空只占 {num(default_view.get('share'), 0) * 100:.1f}%"
                f"（{int(num(default_view.get('pixels'), 0))} 像素）—— 默认是俯视/近景，天不在画面里；"
                f"抬高到 {data.get('pitchDeg')}° 后占 {share * 100:.1f}%"
                f"（抬 17° 那条只有 {num(mid_view.get('share'), 0) * 100:.1f}%）")
    if pixels < 2000:
        report.check(False, f"{page}：抬高机位能看到天（复核天空要有足够像素）",
                      f"只有 {pixels} 像素，占 {share * 100:.1f}%")
        return
    clipped = num(view.get("clipped"), 0)
    mean_lum = num(view.get("meanLum"), 0)
    cloud_only = data.get("cloudOnly") or {}
    changed = num(cloud_only.get("changedRatio"), 0)
    brighter = num(cloud_only.get("brighterRatio"), 0)
    darker = num(cloud_only.get("darkerRatio"), 0)
    report.check(changed >= 0.06,
                  f"{page}：云真的画进了画面（换掉云层整帧变化足够大）",
                  f"无云↔有云差了 {changed * 100:.1f}% 的像素，"
                  f"其中提亮 {brighter * 100:.1f}%（均 {num(cloud_only.get('brighterMean'), 0):.0f}/255）、"
                  f"压暗 {darker * 100:.1f}%（均 {num(cloud_only.get('darkerMean'), 0):.0f}/255）、"
                  f"逐像素平均差 {num(cloud_only.get('meanDelta'), 0):.1f}、最大 {num(cloud_only.get('maxDelta'), 0)}")
    report.check(brighter > 0.01 and brighter >= darker * 0.8,
                  f"{page}：云以照亮为主（白云比蓝天亮），不是一团把天压暗的灰块",
                  f"提亮 {brighter * 100:.1f}%（均 +{num(cloud_only.get('brighterMean'), 0):.0f}/255）"
                  f" vs 压暗 {darker * 100:.1f}%")
    report.check(num(cloud_only.get("restored"), 0) <= 0.02,
                  f"{page}：量完把贴图换回去了（没有把云留在画面上）",
                  f"换回后与量之前差 {num(cloud_only.get('restored'), 0) * 100:.2f}%")
    report.check(num(view.get("detail"), 0) >= 0.15,
                  f"{page}：天空不是纯渐变（有云的细部）",
                  f"相邻像素梯度均值 {num(view.get('detail'), 0):.2f}")
    report.check(clipped <= 0.02,
                  f"{page}：天空没有过曝成白幕",
                  f"≥253 的像素占 {clipped * 100:.2f}%，天空平均亮度 {mean_lum:.1f}/255")
    clouds = data.get("clouds") or {}
    if clouds:
        report.check(0.10 <= num(clouds.get("coverage"), 0) <= 0.5,
                      f"{page}：贴图自称的云量与'少云到多云'一致",
                      f"天球覆盖率 {num(clouds.get('coverage'), 0) * 100:.1f}%、"
                      f"{clouds.get('clouds')} 团积云 + {clouds.get('cirrus')} 条丝缕、"
                      f"挡日系数 {num(clouds.get('sunOpacity'), 0):.2f}")
    report.note(f"{page}：抬高机位天空平均亮度 {mean_lum:.1f}、标准差 {num(view.get('stdLum'), 0):.1f}、"
                f"行分布（0=画面底部）{[round(v, 3) for v in (view.get('rowShare') or [])]}；"
                f"同样的云在抬 17° 那条只改变 {num((data.get('cloudOnlyMid') or {}).get('changedRatio'), 0) * 100:.1f}% 的像素"
                f"（云层是平的：低仰角那一条被地面透视压得几乎没云）")


def report_prop_shadows(page: str, payload: dict, report: Report) -> None:
    """静态构件硬影层：解析投影（平行光 (x,y,z) → (x + dir·cot·y, z)）逐条核对。

    index 只报 0（那页的展台没有静态构件），不算失败。
    """
    data = payload.get("propShadows")
    if not data:
        report.check(False, f"{page}：静态构件硬影层有数据", "无 propShadows 数据")
        return
    count = int(num(data.get("declared"), 0))
    if not count:
        report.note(f"{page}：本页没有静态构件硬影层（展台只有车，没有灯杆/机柜/树）")
        return
    report.check(count > 0 and int(num(data.get("count"), 0)) == count,
                  f"{page}：静态构件硬影层已建立（实例数与声明一致）",
                  f"实例={data.get('count')} 声明={count} 候选={data.get('candidates')} 顶点={data.get('vertices')}")
    shadow = data.get("shadow") or {}
    cot = num(shadow.get("cotElevation"), 0)
    report.check(0.55 <= cot <= 0.70,
                  f"{page}：硬影用的是同一颗太阳（cot ≈ 0.62 = 1/tan58°）",
                  f"cot={cot} 影子方向={shadow.get('shadowDir')} 方位角={shadow.get('azimuthDeg')}°")
    ground = shadow.get("ground")
    report.note(f"硬影落影范围（裁到实际铺装）={ground}；影色乘数={shadow.get('tint')}；"
                f"来源 {data.get('byName')}；几何类型 {data.get('kinds')}；总面积 {data.get('area')}m²")

    samples = data.get("samples") or []
    if samples:
        # 1) 影长 = cot × 自身高度；偏移 = cot × 离地高度（吊在空中的横梁才看得出偏移这一项）
        bad_sweep = [s for s in samples if abs(num(s.get("sweep"), 9) - num(s.get("expectedSweep"), -9)) > 0.02]
        bad_lift = [s for s in samples if abs(num(s.get("lift"), 9) - num(s.get("expectedLift"), -9)) > 0.02]
        report.check(not bad_sweep and not bad_lift,
                      f"{page}：影长 = cot × 构件高度、偏移 = cot × 离地高度（吊空的横梁也算）",
                      f"影长不符 {[(s.get('label'), s.get('sweep'), s.get('expectedSweep')) for s in bad_sweep]}；"
                      f"偏移不符 {[(s.get('label'), s.get('lift'), s.get('expectedLift')) for s in bad_lift]}")
        # 2) 轮廓重心必须落在"构件位置沿影子方向偏移 (lift + sweep/2)"处 —— 投影公式的独立复算
        dir_x, dir_z = (shadow.get("shadowDir") or [0, 0])[:2]
        bad_centre = []
        for sample in samples:
            centre = sample.get("centre") or [0, 0]
            expected_x = num(sample.get("x"), 0) + dir_x * (num(sample.get("lift"), 0) + num(sample.get("sweep"), 0) / 2)
            expected_z = num(sample.get("z"), 0) + dir_z * (num(sample.get("lift"), 0) + num(sample.get("sweep"), 0) / 2)
            if abs(num(centre[0], 0) - expected_x) > 0.05 or abs(num(centre[1], 0) - expected_z) > 0.05:
                bad_centre.append((sample.get("label"), centre, [round(expected_x, 2), round(expected_z, 2)]))
        report.check(not bad_centre,
                      f"{page}：影子重心落在背光侧（重心 = 构件位置 + 影长方向 × (离地 + 自身高/2)）",
                      f"偏离 {bad_centre}" if bad_centre else
                      f"样本 {len(samples)} 个：{[ (s.get('label'), s.get('centre')) for s in samples[:3] ]}…")
        cut = [s for s in samples if s.get("clipped")]
        report.note(f"其中 {len(cut)}/{len(samples)} 个样本的影子被铺装边界裁过（重心用未裁剪轮廓核对）")
        # 候选为什么没留下：逐门、逐几何类型的记账（数目对不上时靠这条定位）
        dropped = data.get("dropped") or {}
        if dropped:
            report.note(f"{page}：硬影候选 {data.get('candidates')} → 留下 {data.get('declared')}；"
                        f"各门刷掉 blocked={dropped.get('blocked')}（在转的栏杆臂）"
                        f" plan={dropped.get('plan')}（占地太小）"
                        f" tiny={dropped.get('tiny')}（整块投影 <5dm²）"
                        f" clip={dropped.get('clip')}（几乎全在铺装外）"
                        f" dedupe={dropped.get('dedupe')}（同格/超上限）")
            report.note(f"{page}：按几何类型看刷掉的数量 {dropped.get('byKind')}")
        # 3) 半影宽度按太阳视半径算，落在 [0.05, 0.14]m
        penumbra = [num(s.get("penumbra"), 0) for s in samples]
        report.check(all(0.05 <= value <= 0.14 for value in penumbra),
                      f"{page}：半影宽度按太阳视半径与障碍高度算（0.05~0.14m）",
                      f"样本半影={sorted(set(penumbra))}")
        report.note(f"硬影样本（来源/类型/底面高/顶面高/影长/离地偏移/半影/面积）："
                    f"{[(s.get('label'), s.get('kind'), s.get('base'), s.get('top'), s.get('sweep'), s.get('lift'), s.get('penumbra'), s.get('area')) for s in samples[:6]]}…")

    # 树冠斑驳：树影不是一块实心椭圆，是一簇簇叶子投出来的小椭圆，中间留光斑
    dapple = data.get("dapple") or {}
    parts = data.get("parts") or {}
    modes = data.get("canopyModes") or []
    if int(num(dapple.get("canopyItems"), 0)) > 0:
        clustered = int(num(dapple.get("clusteredCanopies"), 0))
        solid = int(num(dapple.get("solidCanopies"), 0))
        coverage = num(dapple.get("coverage"), 0)
        report.note(f"{page}：树冠 {dapple.get('canopyItems')} 棵（拆簇 {clustered} / 整块 {solid}）"
                    f"共 {dapple.get('clumps')} 簇，拆簇的覆盖率 {coverage}")
        # 决策核对：冠幅 ≥ 3×半影 才拆簇（叶缝得宽过半影才看得见），否则整块
        wrong_mode = []
        bad_clump_count = []
        for item in modes:
            canopy_r = num(item.get("canopyR"), 0)
            penumbra = max(0.01, num(item.get("penumbra"), 0))
            should_cluster = canopy_r >= num(item.get("dappleMin"), 3) * penumbra - 1e-6
            is_clustered = item.get("mode") == "clustered"
            if should_cluster != is_clustered:
                wrong_mode.append((item.get("label"), canopy_r, penumbra, item.get("mode")))
            # 拆簇的定义就是"不止一簇"；整块的定义就是覆盖率恰好 1
            if is_clustered and int(num(item.get("rings"), 0)) < 2:
                bad_clump_count.append((item.get("label"), item.get("rings")))
            if not is_clustered and abs(num(item.get("coverage"), 0) - 1.0) > 1e-6:
                bad_clump_count.append((item.get("label"), "整块但覆盖率 != 1"))
        report.check(not wrong_mode,
                      f"{page}：树影斑驳与否按「冠幅 vs 半影」定（冠幅 <3×半影 的小灌木本来就该是一整块）",
                      f"判错 {wrong_mode[:4]}" if wrong_mode else
                      f"{len(modes)} 棵逐棵核对：{[ (m.get('label'), m.get('mode'), m.get('canopyR'), m.get('penumbra')) for m in modes[:3] ]}…")
        report.check(bool(modes) or int(num(dapple.get("canopyItems"), 0)) == 0,
                      f"{page}：树的斑驳决策数据确实传上来了（不是空列表白过）",
                      f"{len(modes)} 条" if modes else "本页没有球类构件")
        report.check(not bad_clump_count,
                      f"{page}：拆簇的每棵至少 2 簇、整块的覆盖率恰好 1",
                      f"异常 {bad_clump_count[:4]}" if bad_clump_count else "通过")
        clumps_per_tree = num(dapple.get("clumps"), 0) / max(1.0, clustered) if clustered else 0
        if clustered:
            report.check(0.15 <= coverage <= 0.85,
                          f"{page}：斑驳度是个「有光斑、主体仍是影」的数（实心=1）",
                          f"{clustered} 棵拆簇 / 共 {dapple.get('clumps')} 簇 = 每棵 {clumps_per_tree:.1f} 簇，覆盖率 {coverage}")
        canopy_area = num(dapple.get("area"), 0)
        if int(num(parts.get("canopy"), 0)) > 0:
            # 结构性核对：树冠那一半有顶点、是独立 Mesh（不是"声明了却没画"）
            report.check(int(num(parts.get("canopyVertices"), 0)) > 0,
                          f"{page}：树冠那一半是独立 Mesh 且真的提交了顶点",
                          f"树冠 {parts.get('canopy')} 片 / {parts.get('canopyVertices')} 顶点，"
                          f"实心 {parts.get('solid')} 片 / {parts.get('solidVertices')} 顶点")
            report.note(f"{page}：树冠影面积 {canopy_area}m²"
                        f"（占硬影层 {canopy_area / max(0.01, num(data.get('area'), 1)) * 100:.1f}%）；"
                        f"单独藏起来画面变化 {data.get('canopyOnlyRatio')}、变暗 {data.get('canopyOnlyDarker')}"
                        f"（面积太小时默认机位不足一个像素，属正常）")
        else:
            report.note(f"{page}：球类构件的影子都小到看不见（树冠影面积 {canopy_area}m²）")
        # 逐簇核对：影子中心 = 簇心沿影子方向偏移 cot×簇高；两两**不相交**（叠加会被压两次 → tint² ≈ 死黑）
        examples = data.get("clumpExamples") or []
        bad_centre_clump = []
        overlapping = []
        outside_canopy = []
        for tree in examples:
            clumps = tree.get("clumps") or []
            for clump in clumps:
                want_x = num(tree.get("x"), 0) + dir_x * (num(clump.get("along"), 0) + num(tree.get("cot"), 0) * num(clump.get("y"), 0))
                want_z = num(tree.get("z"), 0) + dir_z * (num(clump.get("along"), 0) + num(tree.get("cot"), 0) * num(clump.get("y"), 0))
                centre = clump.get("centre") or [0, 0]
                if abs(num(centre[0], 0) - want_x) > 0.05 or abs(num(centre[1], 0) - want_z) > 0.05:
                    bad_centre_clump.append((tree.get("label"), centre, [round(want_x, 2), round(want_z, 2)]))
                reach = math.hypot(num(clump.get("along"), 0), num(clump.get("across"), 0))
                if reach > num(tree.get("radius"), 0) + 0.05 or reach + num(clump.get("r"), 0) > num(tree.get("radius"), 0) * 1.2 + 0.05:
                    outside_canopy.append((tree.get("label"), round(reach, 2), tree.get("radius")))
            for i in range(len(clumps)):
                for j in range(i + 1, len(clumps)):
                    a, b = clumps[i], clumps[j]
                    sin_elev = max(0.05, num(tree.get("sinElev"), 1))
                    apart = (abs(num(a.get("along"), 0) - num(b.get("along"), 0)) >= (num(a.get("r"), 0) + num(b.get("r"), 0)) / sin_elev - 1e-6
                             or abs(num(a.get("across"), 0) - num(b.get("across"), 0)) >= num(a.get("r"), 0) + num(b.get("r"), 0) - 1e-6)
                    if not apart:
                        overlapping.append((tree.get("label"), i, j))
        report.check(not bad_centre_clump,
                      f"{page}：每簇影子中心 = 簇心投影（沿影子方向偏移 cot × 簇高）",
                      f"偏离 {bad_centre_clump[:4]}" if bad_centre_clump else f"共 {len(examples)} 棵逐簇核对")
        report.check(not overlapping,
                      f"{page}：簇与簇的影子两两不相交（相交处会被乘法混合压两次成死黑）",
                      f"相交 {overlapping[:4]}" if overlapping else "按影子坐标轴逐对分开")
        report.check(not outside_canopy,
                      f"{page}：每一簇都落在树冠球内",
                      f"越界 {outside_canopy[:4]}" if outside_canopy else "簇心在冠球内、簇团最多探出 20%")
        report.note(f"硬影分两半：实心 {parts.get('solid')} 片（机柜/灯杆/雨棚/横梁）+ 树冠 {parts.get('canopy')} 片"
                    f"（{clustered} 片拆簇、每片 {clumps_per_tree:.1f} 簇，覆盖率 {coverage}）")
    elif int(num(parts.get("solid"), 0)) > 0:
        report.note(f"{page}：硬影全是实心构件（本页没有树冠）")

    material = data.get("material") or {}
    report.check(bool(material.get("multiply")) and material.get("toneMapped") is False
                  and material.get("fog") is False and bool(material.get("vertexColors"))
                  and material.get("depthWrite") is False,
                  f"{page}：硬影是乘法混合的乘数（白=不变）、不吃雾不吃色调映射",
                  f"multiply={material.get('multiply')} toneMapped={material.get('toneMapped')} "
                  f"fog={material.get('fog')} vertexColors={material.get('vertexColors')} depthWrite={material.get('depthWrite')}")
    report.check(num(data.get("darkerRatio"), 0) > 0 and num(data.get("brighterRatio"), 9) == 0,
                  f"{page}：硬影是「压暗」而不是提亮（藏起来画面只会变亮）",
                  f"变暗 {data.get('darkerRatio')} / 变亮 {data.get('brighterRatio')}，"
                  f"变化 {data.get('changedRatio')}，平均 {data.get('darkerMean')}/255")
    report.check(num(data.get("restoredVsBaseline"), 9) == 0,
                  f"{page}：硬影开关可逆（还原后回到基线）", f"还原后差={data.get('restoredVsBaseline')}")
    report.check(num(data.get("bottomShare"), 1) >= 0.35,
                  f"{page}：硬影的变化主要落在画面下半部（地面）",
                  f"上/下半 {data.get('topShare')}/{data.get('bottomShare')} 行分布={data.get('rows')}")
    tone = data.get("tone") or {}
    if tone.get("pixels"):
        report.check(num(tone.get("blueRedShadow"), 0) > num(tone.get("blueRedSunlit"), 9) * 1.03,
                      f"{page}：硬影里比影外更蓝（地面只剩天光照着）",
                      f"蓝红比 影 {tone.get('blueRedShadow')} vs 无影 {tone.get('blueRedSunlit')}（{tone.get('pixels')}px）")


def report_barrier_index(payload: dict, report: Report) -> None:
    """index 页道闸：状态来自日志的到位事件，动作是动画（不瞬变、能走完、运行中亮警示灯）。"""
    flips = int(num(payload.get("barrierFlips"), 0))
    trigger = payload.get("barrierAtTrigger") or {}
    up = payload.get("barrierUp") or {}
    down = payload.get("barrierDown") or {}
    lamp = payload.get("barrierTravelLamps") or {}
    report.check(flips >= 2, "index：日志里读到栏杆状态跳变（抬杆到位/落杆到位）", f"跳变 {flips} 次")
    report.check(bool(trigger) and bool(up) and bool(down),
                  "index：抬杆/落杆事件都能定位到", f"触发={bool(trigger)} 抬={bool(up)} 落={bool(down)}")
    if not (trigger and up and down):
        return
    report.check(bool(trigger.get("traveling")) and num(trigger.get("angleDeg"), 99) > -6,
                  "index：抬杆是动画而不是瞬变（触发瞬间臂还在地上，且标记为行进中）",
                  f"触发时 {trigger.get('angleDeg')}° traveling={trigger.get('traveling')}")
    report.check(num(up.get("angleDeg"), 0) <= -80 and num(up.get("tipY"), 0) > 4,
                  "index：抬杆到位后臂接近竖直、端头抬到 4m 以上",
                  f"到位 {up.get('angleDeg')}° 端头 {up.get('tipY')}m")
    report.check(num(down.get("angleDeg"), -99) >= -4 and num(down.get("tipY"), 0) < 1.7,
                  "index：落杆到位后臂回到水平、端头落回杆座高度",
                  f"落杆 {down.get('angleDeg')}° 端头 {down.get('tipY')}m")
    report.check(num(up.get("lamp"), 1) == 0 and num(down.get("lamp"), 1) == 0,
                  "index：到位后警示灯熄灭（只在运行中闪）",
                  f"抬杆位={up.get('lamp')} 落杆位={down.get('lamp')}")
    report.check(num(lamp.get("lit"), 0) >= 1,
                  "index：抬杆行程中杆座警示灯亮过（黄闪）",
                  f"{lamp.get('samples')} 次采样里亮 {lamp.get('lit')} 次")
    report.note(f"道闸：触发 {trigger.get('angleDeg')}° → 抬杆到位 {up.get('angleDeg')}°（端头 {up.get('tipY')}m）→ "
                f"落杆到位 {down.get('angleDeg')}°（端头 {down.get('tipY')}m）")


def report_barrier_lanes(payload: dict, report: Report) -> None:
    """lanes 页道闸：角度是「跳变序列 + 时刻」的纯函数 —— 定点取样 + 重复拖回必须一模一样。"""
    lane = payload.get("barrierLane")
    open_pose = payload.get("barrierOpen") or {}
    closed_pose = payload.get("barrierClosed") or {}
    travel = payload.get("barrierTravel") or []
    repeat = payload.get("barrierRepeat") or {}
    report.check(bool(lane), "lanes：找到带栏杆状态信号的车道", f"车道={lane} 共 {payload.get('barrierLaneCount')} 条")
    if not lane:
        return
    report.check(num(open_pose.get("angleDeg"), 0) <= -80 and num(open_pose.get("tipY"), 0) > 4,
                  "lanes：抬杆时段臂接近竖直、端头抬到 4m 以上",
                  f"{open_pose.get('angleDeg')}° 端头 {open_pose.get('tipY')}m @ t={open_pose.get('t')}")
    report.check(num(closed_pose.get("angleDeg"), -99) >= -4 and num(closed_pose.get("tipY"), 0) < 1.7,
                  "lanes：落杆时段臂回到水平、端头落回杆座高度",
                  f"{closed_pose.get('angleDeg')}° 端头 {closed_pose.get('tipY')}m @ t={closed_pose.get('t')}")
    angles = [num(item.get("angleDeg"), 0) for item in travel]
    report.check(len(angles) == 3 and angles[0] > angles[1] > angles[2] and angles[0] > -8 and angles[2] < -30,
                  "lanes：抬杆行程是连续的（0.15/0.45/0.75s 三个采样单调抬起、都没到位）",
                  f"角度序列={angles} 端头={[item.get('tipY') for item in travel]}")
    report.check(all(item.get("traveling") for item in travel),
                  "lanes：行程中的三个采样都标记为行进中", f"traveling={[item.get('traveling') for item in travel]}")
    first = repeat.get("first") or {}
    second = repeat.get("second") or {}
    report.check(num(first.get("angleDeg"), 99) == num(second.get("angleDeg"), -99)
                  and num(first.get("tipY"), 99) == num(second.get("tipY"), -99),
                  "lanes：同一时刻拖回来角度完全一致（不是按帧缓动攒出来的）",
                  f"第一次 {first.get('angleDeg')}°/{first.get('tipY')}m，第二次 {second.get('angleDeg')}°/{second.get('tipY')}m")
    # 警示灯：相位由时刻决定，取样时刻的亮灭要与 2Hz 方波一致
    phase = {i: item for i, item in enumerate(travel)}
    lamp_ok = True
    for index, item in phase.items():
        t = num(item.get("t"), -1)
        expect_on = int(t * 2.0 * 2) % 2 == 0
        lit = num(item.get("lamp"), 0) > 0.01
        if t >= 0 and lit != expect_on:
            lamp_ok = False
    report.check(lamp_ok, "lanes：行程中杆座黄闪按 2Hz 相位开关（同一时刻拖回来闪到同一帧）",
                  f"采样 {[(item.get('t'), item.get('lamp')) for item in travel]}")
    # 像素级外观：臂投在屏幕上的形状随抬落翻转，红白涂装要真的数得出相间
    closed_px = payload.get("barrierPixelsClosed") or {}
    open_px = payload.get("barrierPixelsOpen") or {}
    if closed_px and open_px:
        report.check(closed_px.get("horizontal") is True
                      and num(closed_px.get("aspect"), 0) > 2.2
                      and num(closed_px.get("red"), 0) > 0 and num(closed_px.get("white"), 0) > 0,
                      "lanes：落杆时臂是一根横条，且红白涂装都在（像素级）",
                      f"{closed_px.get('boxWidth')}×{closed_px.get('boxHeight')}px 长宽比={closed_px.get('aspect')} "
                      f"红={closed_px.get('red')} 白={closed_px.get('white')} 其他={closed_px.get('other')}")
        report.check(open_px.get("horizontal") is False
                      and (num(open_px.get("boxHeight"), 0) / max(1, num(open_px.get("boxWidth"), 1))) > 2.2,
                      "lanes：抬杆后同一机位下臂变成一根竖条（像素级）",
                      f"{open_px.get('boxWidth')}×{open_px.get('boxHeight')}px 长宽比={open_px.get('aspect')}")
        report.check(num(open_px.get("top"), 0) - num(closed_px.get("top"), 0) > 0.4 * num(open_px.get("boxHeight"), 0),
                      "lanes：抬杆后臂的顶端明显抬高（同一机位比较屏幕坐标）",
                      f"落杆顶={closed_px.get('top')} 抬杆顶={open_px.get('top')} 抬杆高={open_px.get('boxHeight')}px")
        report.check(num(closed_px.get("alternations"), 0) >= 4 and num(open_px.get("alternations"), 0) >= 4,
                      "lanes：臂上红白相间的涂装数得出 ≥4 次换色（涂装贴图确实生效）",
                      f"落杆相间 {closed_px.get('alternations')} 次 / 抬杆 {open_px.get('alternations')} 次")
    else:
        report.check(False, "lanes：栏杆臂像素级外观有测量结果",
                      f"落杆={bool(closed_px)} 抬杆={bool(open_px)}")
    report.note(f"道闸：抬杆到位 {open_pose.get('angleDeg')}° / 落杆到位 {closed_pose.get('angleDeg')}°；"
                f"行程角度序列 {angles}，对应端头 {[item.get('tipY') for item in travel]}m")
    cursor = payload.get("finalCursor") or {}
    report.note(f"本页 draw call 是在时间游标 t={cursor.get('t')} 上量的（当时有 "
                f"{cursor.get('visibleVehicles')} 条车道显示车辆：{cursor.get('lanes')}）——"
                f"车辆会随游标出现/消失，比较 draw call 必须带上这个前提")


def report_vehicles(payload: dict, report: Report) -> None:
    report.check(not payload.get("errors"), "vehicles：页面无 JS 报错", str(payload.get("errors")))
    report.check(not payload.get("fatal"), "vehicles：探针无异常", str(payload.get("fatal") or ""))
    report.check(payload.get("models") == 11, "vehicles：11 个车型", str(payload.get("models")))
    report.check(payload.get("paintPhysical") == 11, "vehicles：车漆用物理材质（清漆层）", str(payload.get("paintPhysical")))
    report.check((payload.get("contactShadowCount") or 0) == 11, "vehicles：每个展台一份接地阴影",
                  f"count={payload.get('contactShadowCount')}")
    report.check((payload.get("brakeGlows") or 0) == 22, "vehicles：每辆车 2 个刹车光晕",
                  f"count={payload.get('brakeGlows')}")
    report_vehicle_shadows(payload, report, "vehicles", pixel=True)
    # 展台上没有静态构件（灯杆/机柜/树），硬影层应当**空着**——显式核对，而不是靠"探针没数据"
    report_sky("vehicles", payload, report)
    report_prop_shadows("vehicles", payload, report)


def report_bloom(payload: dict, report: Report) -> None:
    bloom = payload.get("bloom") or {}
    if not bloom:
        report.check(False, "泛光：没有拿到测量结果")
        return
    report.note(f"渲染器：{bloom.get('renderer')}　画布 MSAA 采样数={bloom.get('msaaSamples')}")
    noise = bloom.get("samePathNoise") or {}
    report.note(f"同路径连续两帧差值（噪声底）：直接 {noise.get('direct')}　管线 {noise.get('pipeline')}")
    report.note(f"缓冲尺寸：{bloom.get('sizes')}")
    for item in bloom.get("shiftScan") or []:
        report.note(f"  平移 ({item['dx']},{item['dy']}) → meanDelta={item['meanDelta']} changed={item['changedRatio']}")
    grid = bloom.get("map") or {}
    if grid:
        report.note(f"差异分布（每格平均差 /255，{grid.get('width')}x{grid.get('height')}，最上一行是画面顶部）：")
        for row in grid.get("rows") or []:
            report.note("    " + " ".join(f"{v:>5.1f}" for v in row))
        report.note("大差像素（>60/765）计数：")
        for row in grid.get("bigRows") or []:
            report.note("    " + " ".join(f"{v:>5d}" for v in row))
        for item in grid.get("worst") or []:
            report.note(f"  最大差 {item['d']}/765 @({item['x']},{item['y']}) 直接={item['direct']} 管线={item['pipeline']}")
    software_path = bloom.get("softwarePathVsComposerOff") or {}
    report.check(bloom.get("softwarePathPostprocessed") is True,
                  "泛光：软件路径也走 RT+OutputPass 管线（不再回退到裸渲染）",
                  f"postprocessed={bloom.get('softwarePathPostprocessed')}")
    report.check(software_path.get("meanDelta", 9) < 0.05 and software_path.get("changedRatio", 9) < 0.005,
                  "泛光：软件路径与「有 GPU 但关泛光」逐像素一致",
                  f"meanDelta={software_path.get('meanDelta')} changed={software_path.get('changedRatio')}")
    no_msaa = bloom.get("pipelineOffNoMsaaVsDirect") or {}
    msaa_vs = bloom.get("msaaVsNoMsaa") or {}
    opaque = bloom.get("opaqueOnlyVsDirect") or {}
    isolation = bloom.get("isolation") or {}
    report.note(f"只留不透明物体（藏起 {bloom.get('transparentObjects')} 个透明/叠加物体）后再比："
                f"meanDelta={opaque.get('meanDelta')} changed={opaque.get('changedRatio')} >60/765 {opaque.get('over60Ratio')}")
    report.note(f"· 裸 renderer.render() 与管线的差异（已知：three 对雾色/背景按 outputColorSpace 处理，"
                f"渲到 RT 时改用线性工作空间）：meanDelta={no_msaa.get('meanDelta')} changed={no_msaa.get('changedRatio')} "
                f">60/765 {no_msaa.get('over60Ratio')} —— 这是差异记录，不是断言")
    report.check(msaa_vs.get("meanDelta", 9) < 6 and msaa_vs.get("changedRatio", 9) < 0.2,
                  "泛光：同一管线的 4x MSAA 只影响边缘（与无 MSAA 相比）",
                  f"meanDelta={msaa_vs.get('meanDelta')} changed={msaa_vs.get('changedRatio')}")
    stats = bloom.get("stats") or {}
    off_stats = stats.get("pipelineOff") or {}
    report.note(f"泛光前：mean={off_stats.get('mean')} top1%={off_stats.get('topPctMean')} clip={off_stats.get('clip')}")
    print_presets(bloom.get("presets") or [], report)
    report.note(f"参考帧稳定性（同一条管线再取一帧）：{bloom.get('referenceStable')}")
    report.note(f"★（0.18/0.45/1.4）与 D（0.10/0.35/2.2）两帧之差：{bloom.get('presetPairAB')}")
    report.note("逐件隔离（藏起某件后两条路径的差异，看差异由谁贡献）：")
    for name in ("all", "skyDome", "groundHaze", "ground", "grid", "fog"):
        item = isolation.get(name)
        if item is None:
            report.note(f"  {name}：本页没有这个物体")
        else:
            report.note(f"  藏起 {name}：meanDelta={item['meanDelta']} changed={item['changedRatio']} "
                        f">60/765 {item['over60Ratio']} maxDelta={item['maxDelta']}")
    fog_effect = isolation.get("fogEffect") or {}
    for name in ("direct", "pipeline"):
        item = fog_effect.get(name) or {}
        report.note(f"  把雾关掉后（{name} 路径）自身的变化：meanDelta={item.get('meanDelta')} "
                    f"changed={item.get('changedRatio')}")
    cost = bloom.get("costMs") or {}
    for name, label in (("direct", "裸渲染"), ("composerOff", "管线关泛光"), ("composerBloom", "管线带泛光")):
        item = cost.get(name) or {}
        report.note(f"  {label}：draw call {item.get('calls')}　三角形 {item.get('triangles')}")
    report.note("（无头 + virtual-time-budget 下 Date.now() 也被虚拟化，毫秒数测不出来，所以用与硬件无关的"
                " draw call/三角形数说明后处理多出来的开销：关泛光只多 1 次全屏 pass（OutputPass，"
                "场景本身就是 RenderPass 画的），开泛光再多十几次（高光提取 + 5 级 mip 双向模糊 + 合成））")


def print_presets(presets: list[dict], report: Report) -> None:
    if not presets:
        report.check(False, "泛光：没有参数扫描结果")
        return
    report.note("泛光参数扫描（阈值在线性 HDR 空间比较；变亮占比=受影响像素比例）")
    for preset in presets:
        report.note(f"  {preset['name']}　strength={preset['strength']} radius={preset['radius']} threshold={preset['threshold']}"
                    f"　变亮 {preset['brighterRatio']}（平均 +{preset.get('brighterMean')}）"
                    f" 变暗 {preset['darkerRatio']}（平均 -{preset.get('darkerMean')}）"
                    f"　整帧 {preset.get('meanDelta')}/255　mean {preset['mean']} top1% {preset['topPctMean']} clip {preset['clip']}")


def main(argv: list[str]) -> int:
    global KEEP_PROBES
    # 逐个参数解析：`--budget/--size/--wait` 后面的值是选项参数，不能当成页面名
    args = list(argv[1:])
    value_options = {"--budget", "--size", "--wait"}
    pages: list[str] = []
    cursor = 0
    while cursor < len(args):
        item = args[cursor]
        if item in value_options:
            cursor += 2
            continue
        if not item.startswith("-"):
            pages.append(item)
        cursor += 1
    budget = 600000
    size = "1600,900"
    wait_s = 300.0        # 软件渲染下整份探针要跑几十次全屏回读，150s 会不够（页面越复杂越明显）
    KEEP_PROBES = "--keep" in argv
    if "--budget" in argv:
        budget = int(argv[argv.index("--budget") + 1])
    if "--size" in argv:
        size = argv[argv.index("--size") + 1]
    if "--wait" in argv:
        wait_s = float(argv[argv.index("--wait") + 1])
    if not pages or pages == ["all"]:
        pages = list(ALL_PAGES)
    unknown = [p for p in pages if p not in TEMPLATES]
    if unknown:
        print(f"未知页面：{unknown}，可选 {list(TEMPLATES)}")
        return 2

    edge = find_edge()
    if not edge:
        print("找不到 msedge.exe，无法做无头渲染自检")
        return 2

    report = Report()
    print(f"边缘浏览器：{edge}")
    print(f"站点：{SITE}（需要 python -m http.server 8765 在跑）")
    print()

    reports = {
        "index": report_index,
        "lanes": report_lanes,
        "vehicles": report_vehicles,
    }
    for page in pages:
        print(f"=== {page}.html ===")
        payload, log = run_page(page, edge, budget, size, wait_s)
        if payload is None:
            print(f"  [!!] 没有收到探针数据（{page}）")
            report.failures.append(f"{page}: 无探针数据")
            if log.strip():
                print("      " + log.strip().splitlines()[-1][:200])
            continue
        page_report = Report()
        reports[page](payload, page_report)
        if page in ("index", "lanes"):
            report_site(payload, page_report, page)
        report_bloom(payload, page_report)
        gpu = payload.get("gpu") or {}
        page_report.note(f"渲染器判定：software={gpu.get('software')}")
        report.failures.extend(f"{page}: {item}" for item in page_report.failures)
        for line in page_report.lines:
            print(line)
        print()

    print("=" * 68)
    if report.failures:
        print(f"自检未通过，{len(report.failures)} 项：")
        for item in report.failures:
            print(f"  - {item}")
        return 1
    print("自检全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
