# dsh-memory-brain · 忆鲸鲸 · 元素记忆库

> 把看见的东西拆成最小的元素存起来，下次凭元素把它想起来。

[English](#english) · 中文

一个 DeepSeek Harness（dsh）插件：给只认字的模型一间**元素库**——它不存"苹果"这张图，它存「圆形、红色、甜、脆、水果、果皮、果核」这七个元素，以及"苹果 = 这七个元素"这条映射。之后你只给它「圆形 + 红色」，它能反查回来是苹果。

不是向量检索，不是知识图谱，是**积木**：元素是积木，物体是搭法，认出新东西就是找形状相似的搭法。

---

## 它做什么

| 工具 | 用途 |
|---|---|
| `memory_learn` | 教它一个物体由哪些元素组成；不认识的词**不会丢**，先收进来 |
| `memory_explain` | 按类别列出某个物体被拆成了什么，每条带 0~1 的权重 |
| `memory_recall` | 只给元素，反查最像的几个物体（附带"我还在瞎猜"的另一段） |
| `memory_stats` | 库的规模与位置 |
| `memory_pending` | 它攒着要问你的问题（未分类的词、睡醒时的猜想） |
| `memory_classify` | 你回答"这个词属于哪一类"，它归位并**记住这是你定的** |
| `memory_answer` | 你回答"这个猜想靠不靠谱"，点头记进库，摇头以后不再提 |

类别一共十二种：**形状 / 立体形状 / 颜色 / 材质 / 表面特征 / 味道 / 质地 / 类别 / 部位 / 功能 / 大小 / 声音 / 动作**。

## 三个刻意的设计

**1. 观察和推断分开记。**
「灰色」「铰链」是看见了；「坚硬」「能剪指甲」是**推**出来的。两条都进库，但推断的打四折、标 `推断`。不然 `recall` 时会把猜想当证据用，越用越歪。

**2. 认不出来的词不丢，变成问题。**
新词先当「未分类」收着，同时排进问题队列 `$DSH_HOME/memory/questions.json`——**这个文件别的插件也能读**，人格类插件可以直接拿到"它现在有什么想问主人"。

**3. 猜测永远单独列一段。**
`memory_recall` 的结尾是「另外，我还在瞎猜（别当真）」。「见过的」和「猜的」混在一起，用户就看不出区别，也就不会去纠正了。

## 安装

```sh
dsh plugin --profile web add dsh-memory-brain
```

装完刷新页面，`memory_*` 七个工具就在了。库落在 `$DSH_HOME/memory/brain.json`（默认 `~/.dsh/memory/brain.json`），是**人能直接打开改的 JSON**。

首次运行如果还没有库，会用自带的离线种子铺底：**104 个物体 / 78 个元素 / 482 条边**。不出网，不联机，不收集任何东西。

## 一个真实的例子

三张照片、三个角度教它认指甲刀（正面、侧面、端头）：

```
memory_learn 指甲刀 [长条形,灰色,光滑,金属,反光,铰链,可折叠,开口,压杆] inferred=[]
```

它自己算出的权重是这样的——

| 特征 | 几个角度看得见 | 权重 |
|---|---|---|
| 灰色 / 金属 / 光滑 | 3/3 | 0.89 ~ 0.93 |
| 开口 / 压杆 | 2/3 | 0.60 |
| 有刻字 | 1/3 | 0.60（没加强） |

**一个角度看到的不算数，两个角度以上才长成结论**——多角度不是礼仪，是这间库的判重规则。

## 边界（写清楚，免得误会）

- 解构靠**别名匹配**，不靠语义理解。它不知道"番茄"和"西红柿"是同一个东西，除非你把别名给它。
- 没有层级关系，没有"是一种"的推理链。
- 元素的类别、物体由哪些元素组成，**目前都是人教的**。它自己不会凭空长出新元素——猜想要你点头。
- 中文别名一律 ≥2 字，单字别名会和别的词撞（"圆"会命中"椭圆形"）。

## English

**Element memory for DeepSeek Harness.** The agent does not store a picture of an apple; it stores `round, red, sweet, crisp, fruit, peel, core` plus the mapping *apple = those seven*. Give it only `round + red` and it finds its way back to the apple.

Seven tools: `memory_learn`, `memory_explain`, `memory_recall`, `memory_stats`, `memory_pending`, `memory_classify`, `memory_answer`. Thirteen element kinds. Everything lives in a human-editable `~/.dsh/memory/brain.json`, seeded with 104 objects / 78 elements / 482 edges on first run — offline, no telemetry.

Two things it refuses to blur: **observed** vs **inferred** (inferred edges are discounted to 0.45× and tagged), and **known** vs **guessed** (`memory_recall` prints guesses in a separate section, never mixed into results). Words it cannot classify are never dropped — they become questions in `~/.dsh/memory/questions.json`, a file other plugins can read.

Install:

```sh
dsh plugin --profile web add dsh-memory-brain
```

MIT licensed.

## 许可

MIT。图标是作者自绘。
