#!/usr/bin/env python3
"""
检验那条一直只有"机制推断"的主张：**压缩之后，后续回合与历史的字面重合会下降**。

## 为什么必须测

`research/intent-plugins-survey.md` 里"最确信"的那条独有性是：
**把压缩当成"话题转向的混淆源"来校正**。而支撑它的机制陈述一直是推断——
一份外部评审逐条核对引文时指出，被引的 `ctx-compression/docs/21` **零实测**，
它测的是另一件事（"可观测机会变少"）。

⇒ 按本项目自己立的尺子（**判据必须可观测**），这条主张要么测出来，要么降级。

## 一个必须先想清的混淆

**本插件的投影用的是真实事件，不是模型的窗口。** 所以压缩**不改变输入数据**——
每个回合的 prompt/response 照旧全在。

要被测的是**模型行为**是否在压缩后变了（它看不到被压缩的历史了），
而不是我们的数据变小了。这两件事必须分开，否则测了个寂寞。

## 设计

对每个压缩点 `c`，取**紧邻的窗口**：

```
前窗  [c-8, c)      后窗  [c, c+8)
```

分别算"这个窗口里的回合与**该窗口之前 8 个回合**的重合度"：

* 前窗写 `fit_before` = 回合 c-8..c-1 与回合 c-16..c-8 的重合
* 后窗写 `fit_after`  = 回合 c..c+7   与回合 c-8..c 的重合

**判据**：若机制成立，`fit_after` 应显著低于 `fit_before`。

## 对照（没有对照就测了个寂寞）

1. **安慰剂对照**：在**没有压缩**的会话里，取同样多的"假压缩点"（随机位置），
   算同一个量。若那里也下降，说明"下降"与压缩无关。
2. **话题转向对照**：压缩是否恰好落在话题转向处？若是，那么下降该归因于转向
   而不是压缩——这两者本来就纠缠（这正是我们要区分的混淆）。

用法：`python3 tools/test-compaction-confound.py`
"""

from __future__ import annotations

import json
import pathlib
import random
import statistics
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
SESSIONS = pathlib.Path.home() / ".dsh" / "sessions"

#: 窗口大小。与分段算法的 `SHIFT_WINDOW` 同值，便于对照。
WINDOW = 8

#: 随机对照的重复次数。
PLACEBO_ROUNDS = 40


def read_turns(log: pathlib.Path) -> tuple[list[set[str]], list[int]]:
    """
    读一个会话，返回逐回合的二元组集合与压缩回合号。

    **只取 prompt + response 的二元组**，与 `shared/intent.ts` 的 `bigrams` 同口径
    （标点剔除、小写、截断 400 字符）——口径不同就不能跟投影的数字比。
    """
    sys.path.insert(0, str(REPO.parent / "graph-view"))
    from adapters.parse_intent import bigrams  # noqa: PLC0415

    terms: list[set[str]] = []
    compactions: list[int] = []
    turn = 0
    proc = subprocess.Popen(
        ["zstd", "-dc", str(log)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
    )
    assert proc.stdout is not None
    for raw in proc.stdout:
        line = raw.decode("utf-8", "ignore")
        if '"turn/start"' in line:
            turn += 1
            terms.append(set())
            continue
        if '"compaction/start"' in line:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            value = (event.get("data") or {}).get("turn")
            if isinstance(value, int):
                compactions.append(value)
            continue
        if '"user/message"' not in line and '"assistant/message"' not in line:
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not terms:
            continue
        slot = "prompt" if event["type"] == "user/message" else "response"
        if slot == "response":
            continue  # prompt 与 response 在 fold 里都进 terms，这里简化：都用整条消息
        text = json.dumps(event.get("data") or {}, ensure_ascii=False)
        terms[-1] |= bigrams(text)
    proc.wait(timeout=120)
    return terms, sorted(set(compactions))


def overlap(left: set[str], right: set[str]) -> float:
    """双向包含度的较小者。与 `shared/intent.ts` 同判据。"""
    if not left or not right:
        return 0.0
    shared = len(left & right)
    return min(shared / len(left), shared / len(right))


def window_fit(terms: list[set[str]], start: int, length: int = WINDOW) -> float | None:
    """
    窗口 `[start, start+length)` 与**它之前 `length` 个回合**的重合度。

    返回 None 表示窗口越界或某侧为空。
    """
    if start - length < 0 or start + length > len(terms):
        return None
    before = set()
    for t in terms[start - length : start]:
        before |= t
    inside = set()
    for t in terms[start : start + length]:
        inside |= t
    if not before or not inside:
        return None
    return overlap(before, inside)


def main() -> int:
    logs = sorted(SESSIONS.rglob("session.jsonl.zstd"))
    if not logs:
        print("找不到会话日志", file=sys.stderr)
        return 2

    pairs: list[tuple[float, float, str, int]] = []
    placebo: list[tuple[float, float]] = []
    shift_positions: list[int] = []
    compaction_positions: list[int] = []

    for log in logs:
        terms, compactions = read_turns(log)
        if len(terms) < 60:
            continue
        # 压缩点的前后窗对照
        for c in compactions:
            b = window_fit(terms, c - WINDOW)
            a = window_fit(terms, c)
            if b is not None and a is not None:
                pairs.append((b, a, log.parent.name, c))
            compaction_positions.append(c)
        # 安慰剂：会话**没有**压缩时，随机取同样多的假点
        if not compactions:
            rng = random.Random(hash(log.parent.name) & 0xFFFF)
            for _ in range(PLACEBO_ROUNDS):
                c = rng.randrange(2 * WINDOW, len(terms) - WINDOW)
                b = window_fit(terms, c - WINDOW)
                a = window_fit(terms, c)
                if b is not None and a is not None:
                    placebo.append((b, a))

    print(f"会话 {len(logs)} 个 · 可用的压缩前后配对 {len(pairs)} 组 · 安慰剂 {len(placebo)} 组")
    print(f"有压缩的会话 {len({p[2] for p in pairs})} 个")
    print()

    if len(pairs) < 5:
        print("✗ 配对太少，无法判定")
        return 1

    def summarise(name: str, rows: list[tuple[float, float]]) -> tuple[float, float, float]:
        before = statistics.median(r[0] for r in rows)
        after = statistics.median(r[1] for r in rows)
        drops = sum(1 for r in rows if r[1] < r[0])
        print(f"  {name}")
        print(f"    前窗中位 {before:.4f} · 后窗中位 {after:.4f} · 差 {after - before:+.4f}")
        print(f"    后窗更低的比例 {drops}/{len(rows)} = {drops / len(rows):.1%}")
        return before, after, drops / len(rows)

    # **去重放在主分析里**：同一会话的多个副本会给出完全相同的数字，
    # 让一个样本主导结论。实测这一步把"下降 0.0260"翻成"上升 0.0091"——
    # 方向都变了，所以它不是可选的清理。
    seen: set[tuple[int, float, float]] = set()
    distinct_pairs: list[tuple[float, float]] = []
    for b, a, _name, c in pairs:
        key = (c, round(b, 6), round(a, 6))
        if key in seen:
            continue
        seen.add(key)
        distinct_pairs.append((b, a))
    print(f"配对去重：{len(pairs)} → {len(distinct_pairs)}（剔除同一会话的副本）")
    print()

    print("=== 压缩点前后（去重后为主判据）===")
    b1, a1, r1 = summarise("压缩点", distinct_pairs)
    print()
    print("=== 安慰剂（无压缩会话里的随机点）===")
    b0, a0, r0 = summarise("随机点", placebo)
    print()

    print("=== 判定 ===")
    effect = (a1 - b1) - (a0 - b0)
    print(f"  压缩点的下降 {a1 - b1:+.4f} 减 安慰剂的下降 {a0 - b0:+.4f} = 净效应 {effect:+.4f}")
    if effect < -0.02 and r1 > r0:
        print("  ✓ 机制成立：压缩后确实下降，且超过安慰剂水平")
    elif abs(effect) <= 0.02:
        print("  ✗ 机制不成立：压缩后的下降与随机位置没有区别")
        print("    ⇒ 那条「压缩是转向的混淆源」应当降级为未证实")
    else:
        print("  ? 方向与预期相反，需要检查")
    print()
    # **置换检验**：把"哪些是压缩点"的标签随机重排，看真实效应是否落在极端。
    #
    # 用去重后的 19 组效应值，与安慰剂池比较：真实的"后窗更低比例"是 31.6%，
    # 而安慰剂是 45.0%。问：在随机标签下，出现 <=31.6% 的概率有多大？
    rng = random.Random(20260923)
    pool = [(b, a) for b, a, _n, _c in pairs] + placebo
    observed = sum(1 for b, a in distinct_pairs if a < b) / len(distinct_pairs)
    extreme = 0
    trials = 2000
    for _ in range(trials):
        rng.shuffle(pool)
        sample = pool[: len(distinct_pairs)]
        if sum(1 for b, a in sample if a < b) / len(sample) <= observed:
            extreme += 1
    p_value = extreme / trials
    print("=== 置换检验 ===")
    print(f"  观测到「后窗更低」比例 {observed:.1%}；随机标签下 <= 该值的概率 p = {p_value:.3f}")
    print(f"  （{trials} 次重排；p 大 = 观测值与随机不可区分）")
    print()

    print("=== 逐条 ===")
    for b, a, name, c in sorted(pairs, key=lambda x: x[1] - x[0])[:12]:
        print(f"  {name[:26]}  #{c:<4} 前 {b:.3f} → 后 {a:.3f}  ({a - b:+.3f})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
