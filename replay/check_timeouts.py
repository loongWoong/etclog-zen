"""数据侧超时自检：用与 lanes.js 完全相同的规则，独立核对 lanes.json 里的超时区间。

lane（`buildStateTrack`）与这里的口径必须一致：
  - 只保留状态跳变（连续同状态折叠）；
  - 区间持续到下一次跳变，最后一次跳变延伸到窗口结束；
  - 区间内状态为"有效状态"（线圈=压上、栏杆=抬杆）且时长超过阈值 → 超时。

用法：cd replay && python check_timeouts.py [data/lanes.json]
"""
import json
import sys

# Windows 控制台默认 GBK，输出里带中文/箭头会直接崩，这里显式切 UTF-8
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

COIL_MS = 20000
BARRIER_MS = 30000
PASSAGE_MS = 90000


def build_track(series, span, offset, threshold):
    transitions = []
    last = None
    for item in series:
        moment = max(0, min(span, item["o"] - offset))
        state = item["s"] is True or item["s"] == "up"  # 线圈是布尔，栏杆是 "up"/"down"
        if last is state:
            continue
        last = state
        transitions.append({"t": moment, "s": state, "at": item["t"]})
    intervals = []
    for index, item in enumerate(transitions):
        end = transitions[index + 1]["t"] if index + 1 < len(transitions) else span
        duration = max(0, end - item["t"])
        intervals.append({"t0": item["t"], "t1": end, "s": item["s"], "ms": duration,
                          "at": item["at"], "timedOut": item["s"] and duration > threshold})
    return transitions, intervals


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "data/lanes.json"
    data = json.load(open(path, encoding="utf-8"))
    span = data["window"]["minutes"] * 60000
    offset = data["window"]["offsetMs"]

    coil_total = barrier_total = passage_total = 0
    for lane in data["lanes"]:
        signals = lane["signals"]
        coil_jumps = 0
        coil_bad = 0
        details = []
        for coil_id in sorted(signals["coils"]):
            transitions, intervals = build_track(signals["coils"][coil_id], span, offset, COIL_MS)
            coil_jumps += len(transitions)
            bad = [x for x in intervals if x["timedOut"]]
            coil_bad += len(bad)
            for item in bad:
                details.append(f"线圈{coil_id} 压上 {item['at']} 持续 {round(item['ms'] / 1000)}s")
        coil_total += coil_bad

        barrier_transitions, barrier_intervals = build_track(signals["barrier"], span, offset, BARRIER_MS)
        barrier_bad = [x for x in barrier_intervals if x["timedOut"]]
        barrier_total += len(barrier_bad)
        for item in barrier_bad:
            details.append(f"抬杆 {item['at']} 持续 {round(item['ms'] / 1000)}s")

        passage_bad = [item for item in lane["passages"] if item["durationMs"] > PASSAGE_MS]
        passage_total += len(passage_bad)

        print(f"{lane['id']}  线圈跳变 {coil_jumps:3d} · 栏杆跳变 {len(barrier_transitions):3d}"
              f" · 超时 {coil_bad} 线圈 / {len(barrier_bad)} 栏杆 / {len(passage_bad)} 过程")
        for item in details:
            print(f"           -> {item}")

    print(f"\n窗口 {data['window']['from']} ~ {data['window']['to']}（{data['window']['minutes']} 分钟）")
    print(f"阈值：线圈压上 > {COIL_MS / 1000}s · 抬杆 > {BARRIER_MS / 1000}s · 过程 > {PASSAGE_MS / 1000}s")
    print(f"超时合计：线圈 {coil_total} 次 · 栏杆 {barrier_total} 次 · 过程 {passage_total} 次")


if __name__ == "__main__":
    main()
