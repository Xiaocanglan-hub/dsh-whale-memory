# dsh-slow-wave · 忆鲸鲸 · 潜意识

> 她睡着的时候，两件事：把记乱的东西理顺，然后做一个梦。

[English](#english) · 中文

一个包，两件东西（设置页里是同一张卡的上半和下半）：

| | 干什么 | 需要什么 |
|---|---|---|
| **睡眠整理** | 合并同义词、精简描述、压缩弱边、按类比提猜想 | 本地模型（复判同义词） |
| **潜意识梦** | 拿她经历过的旧事拼一个简短小故事，写成便条留在桌上 | 本地模型 + 她的事件流 |

梦**不进她的记忆**：只存在 `~/.dsh/dream/dreams.json`，她的插件读不到；写进她桌面的那张纸条只有一句话，并明确标注「是梦，不是发生过的事」。

配合 [`dsh-memory-brain`](https://www.npmjs.com/package/dsh-memory-brain) 使用（元素记忆库提供"道具"与"常识"两类梦的材料）。

## 运行环境：缺了哪一样，哪一半就不动

这个插件装着两件事——**睡眠整理**（整理元素记忆库）和**潜意识梦**（把她睡着时的旧经历拼成一个简短小故事）。两件事依赖的东西不一样，缺了不会一起坏：

| 依赖 | 少了会怎样 | 谁在提供 |
|---|---|---|
| **她的事件流** `~/.dsh-fish/events.jsonl` | 做不成梦（没有可重组的经历）；整理照做 | 大肥鱼插件 `@ssamurias/dsh-fish` 跑起来之后才有 |
| **元素记忆库** `~/.dsh/memory/brain.json` | 梦照做，但没有"道具/常识"这类材料，故事会单薄 | `dsh-memory-brain` |
| **本地模型** ollama（默认 `qwen3:4b-instruct-2507-q4_K_M`） | 只整理库，不做梦——没有模型的"梦"只是把碎片并排抄一遍 | ollama 自己，插件会尝试拉起 |

### 部署本地模型（只有这一半需要）

```sh
# 1. 装 ollama：https://ollama.com/download （Windows 版装完会有托盘图标）
# 2. 拉模型（约 2.3 GB）
ollama pull qwen3:4b-instruct-2507-q4_K_M
# 3. 确认服务在
curl http://127.0.0.1:11434/v1/models
```

装完不用重启 DSH：插件每 10 分钟探一次，探到就自己用上。**不想装也可以**——在设置页把模型选成「关」，它只整理库；或者选付费模型（默认 `deepseek-chat`，需要环境变量 `DEEPSEEK_API_KEY`，每晚有预算闸，默认 0.5 元）。

设置页的「潜意识梦」卡片上会把这三项标成 **在 / 缺**，不用回头翻文档。

**为什么「梦」要这些东西**：梦不是凭空编的，它把三样东西重新组合——她真经历过的事（事件流）、她认识的物件（元素记忆库）、她见过的人（事件流里出现的称呼，比如她自己给主人起的名字）。少一样，梦就少一类材料。


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

`设置 → 忆鲸鲸·深度睡眠`：最小间隔、模型三选一（本地 / 付费 / 关）、每晚预算、四个任务开关，以及「不动你亲手纠正过的内容」；下半张卡管梦：开关、**多久做一场梦**（一天一场 / 每次睡着）、醒来要不要讲。

付费模型有预算闸（默认 0.5 元/晚），超了当场停。本地模型推荐 `qwen3:4b-instruct-2507`——足够干"写法差异"这类机械活；判词义它不行，所以含糊的合并建议交给付费模型。

## 手动试一次

```
deepsleep_status        它现在什么状态
deepsleep_run dryRun   只看它打算做什么，一个字都不改
deepsleep_run          真睡一次
```

## English

**Sleep for a memory library.** While DeepSeek Harness sits idle, this plugin consolidates the element memory from `dsh-memory-brain`: merge synonyms (with a model's consent), trim descriptions, prune weak one-off edges, and propose hypotheses by analogy between similar objects.

**Requirements (each one disables only part of it):** her event stream at `~/.dsh-fish/events.jsonl` (from `@ssamurias/dsh-fish`) — without it there are no dreams, tidying still works; the element memory library (from `dsh-memory-brain`) — without it dreams are thinner but still happen; a local Ollama model — without it the plugin only tidies and never dreams. The dream settings card marks each of the three as **ok / missing**.

Safety first: **backup before every write**, **never merge if the model does not answer**, **never merge more than 15% of the library in one pass**. Hypotheses never enter the library — they become questions that wait for the user.

Idle gating is configurable (mouse/keyboard idle, minimum gap, optional time window, 10-minute probes). A local Ollama model is started automatically if it is not already running. Paid models are capped by a per-night budget.

Settings UI included under Settings → 忆鲸鲸·深度睡眠.

MIT licensed.

## 许可

MIT。
