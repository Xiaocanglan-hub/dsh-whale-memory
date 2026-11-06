# dsh-deepsleep · 忆鲸鲸 · 深度睡眠

> 你离开电脑的时候，它打个盹，把白天记乱的东西理顺。

[English](#english) · 中文

配合 [`dsh-memory-brain`](https://www.npmjs.com/package/dsh-memory-brain) 使用的整理插件。

## 它会做四件事

| 阶段 | 干了什么 | 用不用模型 |
|---|---|---|
| **合并** | 把「折叠」和「可折叠」、「圆形的」和「圆形」并成一个 | 要（含糊时必须模型点头） |
| **精简** | 并掉重复元素、削掉多余别名、把过长的说明压到 40 字内 | 不用，纯规则 |
| **压缩** | 剪掉又弱又只出现一次的边，`seen` 只留最近 20 条 | 不用，纯规则 |
| **猜想** | 从"同类相似物体"推：狗有而兔子没有的元素，猜兔子可能也有 | 不用 |

**猜想的产物不进库**，只进提问队列，等主人点头才转正。

## 三个安全阀

1. **动库之前先备份。** `~/.dsh/deepsleep/backups/brain.<时间戳>.json`，默认留 10 份。每次整理另写一份报告到 `dreams/`。
2. **模型不点头就不许合并。** 模型关着、连不上、或返回的东西解析不出来——这一觉**一条都不合并**，绝不退回"纯规则硬合"。曾经因为一条"编辑距离 ≤1"的错别字规则，把十二种颜色全吞成了「彩色」，那次事故之后加了这道闸。
3. **一次最多合并全库 15%。** 超过就整批放弃——宁可少做，也不能一觉醒来库被改烂。

## 什么时候睡

默认要同时满足：**键鼠空闲 ≥5 分钟**、**距上次整理 ≥30 分钟**、**没有正在进行的整理**、**在允许的时段内**（默认不限）。每 10 分钟探一次，你一动键鼠它就跳过。

本地模型没起来会**自己拉起**（`ollama serve`），起不来就不合并任何"长得像"的候选。

## 设置界面

`设置 → 忆鲸鲸·深度睡眠`：空闲阈值、最小间隔、模型三选一（本地 / 付费 / 关）、每晚预算、四个任务开关，以及「不动你亲手纠正过的内容」。

付费模型有预算闸（默认 0.5 元/晚），超了当场停。本地模型推荐 `qwen3:4b-instruct-2507`——足够干"写法差异"这类机械活；判词义它不行，所以含糊的合并建议交给付费模型。

## 手动试一次

```
deepsleep_status        它现在什么状态
deepsleep_run dryRun   只看它打算做什么，一个字都不改
deepsleep_run          真睡一次
```

## English

**Sleep for a memory library.** While DeepSeek Harness sits idle, this plugin consolidates the element memory from `dsh-memory-brain`: merge synonyms (with a model's consent), trim descriptions, prune weak one-off edges, and propose hypotheses by analogy between similar objects.

Safety first: **backup before every write**, **never merge if the model does not answer**, **never merge more than 15% of the library in one pass**. Hypotheses never enter the library — they become questions that wait for the user.

Idle gating is configurable (mouse/keyboard idle, minimum gap, optional time window, 10-minute probes). A local Ollama model is started automatically if it is not already running. Paid models are capped by a per-night budget.

Settings UI included under Settings → 忆鲸鲸·深度睡眠.

MIT licensed.

## 许可

MIT。
