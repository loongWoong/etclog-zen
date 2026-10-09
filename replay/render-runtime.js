// 共享渲染运行时：GPU 优先 + 按需渲染。
//
// 背景：两个回放页面原来都是「无条件 requestAnimationFrame + 每帧 render」——
// 空闲时也按显示器刷新率持续重绘整个场景。在没有可用 GPU、浏览器退回软件渲染
// （SwiftShader / llvmpipe / Microsoft Basic Render）的机器上，每帧都是 CPU 光栅化，
// 结果就是一个核心 100% 占用。这里做三件事：
//
//   1. 创建上下文时显式要求高性能 GPU（powerPreference: "high-performance"），
//      并检测实际用的是哪块 GPU；如果落到软件渲染就自动降级（关 MSAA、像素比 1）。
//   2. 渲染改成「有事才画」：只在播放、相机交互、缓动收尾或显式唤醒时出帧，
//      空闲时完全停止 requestAnimationFrame，CPU 降到 0。
//   3. 帧率设上限（普通 60fps，软件渲染 30fps），避免 120/144Hz 屏白烧 CPU。

import * as THREE from "three";

const SOFTWARE_PATTERN = /swiftshader|llvmpipe|softpipe|software|microsoft basic|basic render|mesa offscreen|virtualbox|vmware svga/i;

// 先用一个探针上下文问清楚真实的 GPU，再决定怎么建正式渲染器
export function detectGpu() {
  const result = { name: "unknown", vendor: "", software: false, webgl: true };
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    if (!gl) {
      result.webgl = false;
      result.software = true;
      result.name = "no-webgl";
      return result;
    }
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    result.name = String((debug && gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || "unknown");
    result.vendor = String((debug && gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) || gl.getParameter(gl.VENDOR) || "");
    result.software = SOFTWARE_PATTERN.test(result.name) || SOFTWARE_PATTERN.test(result.vendor);
    const lose = gl.getExtension("WEBGL_lose_context");
    if (lose) lose.loseContext();
  } catch (error) {
    result.name = `probe-failed: ${error && error.message ? error.message : error}`;
  }
  return result;
}

// 按 GPU 实际情况建渲染器：软件渲染时关掉抗锯齿、像素比压到 1
export function createRenderer(canvas, gpu = detectGpu()) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: !gpu.software,
    powerPreference: "high-performance",
    alpha: false,
    stencil: false,
    depth: true,
    preserveDrawingBuffer: false,
    failIfMajorPerformanceCaveat: false,
  });
  applyPixelRatio(renderer, gpu);
  return renderer;
}

export function applyPixelRatio(renderer, gpu) {
  const dpr = window.devicePixelRatio || 1;
  const cap = gpu.software ? 1 : 1.5;
  renderer.setPixelRatio(Math.min(dpr, cap));
}

// 帧率上限：留 2ms 容差，否则 60Hz 屏上时间戳抖动会把一半的帧误判成"来早了"而丢掉
export function frameInterval(software) {
  return 1000 / (software ? 34 : 64);
}

// 按需渲染循环：
//   onFrame(dt, now) 每帧更新（只在需要出帧时调用）
//   keepAlive()      额外条件（播放中、相机补间中等）
//   minInterval      两帧最小间隔（帧率上限）
export function createRenderLoop({ onFrame, keepAlive = () => false, minInterval = 1000 / 60 }) {
  let raf = 0;
  let last = 0;
  let lastFrame = 0;
  let holdUntil = 0;
  let carry = 0; // 被帧率上限挡掉的帧，时间要结转到下一次真正出帧，否则动画会变慢
  let frames = 0;
  let windowStart = 0;
  let fps = 0;
  let errors = 0;

  function schedule() {
    if (raf || document.hidden) return;
    raf = requestAnimationFrame(tick);
  }

  function tick(now) {
    raf = 0;
    const dt = last ? Math.min((now - last) / 1000, 0.25) : 0;
    last = now;

    if (now - lastFrame < minInterval) {
      carry += dt;
      schedule();
      return;
    }
    lastFrame = now;

    const frameDt = carry + dt;
    carry = 0;
    // 单帧异常不能让整个循环永久停摆（否则页面看着像卡死，只能刷新）
    try {
      onFrame(frameDt, now);
      frames += 1;
    } catch (error) {
      errors += 1;
      if (errors === 1) console.error("[render-runtime] onFrame 抛异常，已跳过该帧继续渲染", error);
    }

    if (!windowStart) windowStart = now;
    if (now - windowStart >= 1000) {
      fps = Math.round((frames * 1000) / (now - windowStart));
      frames = 0;
      windowStart = now;
    }

    if (now < holdUntil || keepAlive()) {
      schedule();
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    } else {
      hold(200);
    }
  });

  function hold(ms = 400) {
    holdUntil = Math.max(holdUntil, performance.now() + ms);
    schedule();
  }

  return {
    hold,
    // 立刻出一帧（状态变化后调用）
    wake(ms = 400) {
      hold(ms);
    },
    stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
    get fps() {
      return fps;
    },
    get spinning() {
      return Boolean(raf);
    },
    get errorCount() {
      return errors;
    },
  };
}

// 右上角小角标：显示实际使用的 GPU、是否软件渲染、当前 fps（每秒更新一次）
export function mountGpuBadge(parent, gpu, corner = "inline") {
  const el = document.createElement("div");
  const warn = gpu.software || !gpu.webgl;
  const place = corner === "top-left"
    ? ["position:absolute", "top:12px", "left:14px", "z-index:5"]
    : corner === "bottom-right"
      ? ["position:absolute", "bottom:10px", "right:14px", "z-index:5"]
      : ["display:inline-block", "margin-top:6px"]; // inline：挂在侧栏里，不压画布上的任何浮层
  el.setAttribute(
    "style",
    [
      ...place,
      "font:11px/1.5 Consolas,monospace",
      "padding:4px 8px",
      "border-radius:5px",
      "pointer-events:none",
      "max-width:100%",
      warn
        ? "background:rgba(120,30,25,0.92);border:1px solid #d1483f;color:#ffd9d5"
        : "background:rgba(16,21,28,0.86);border:1px solid #26303b;color:#8b98a8",
    ].join(";")
  );
  const short = String(gpu.name || "unknown").replace(/ANGLE \(([^)]*)\)/, "$1").slice(0, 58);
  el.innerHTML = warn
    ? `⚠ 软件渲染（${short}）· 请在浏览器设置里开启“使用硬件加速”，或检查显卡驱动<br><span data-fps style="color:#ffb3ad">-- fps</span>`
    : `GPU：${short} · <span data-fps>-- fps</span>`;
  parent.appendChild(el);
  const fpsEl = el.querySelector("[data-fps]");
  return {
    update(value) {
      if (fpsEl) fpsEl.textContent = `${value} fps`;
    },
  };
}
