/**
 * weave.js —— 把一段段经历打碎、错接，拼成"梦"
 *
 * 为什么"乱"必须写在这里、不能交给模型：
 *   模型天生会讲通顺。你让它写梦，它写出来的是散文诗——有因果、有伏笔、有升华。
 *   真正的梦没有这些：它把不相干的东西按形状和情绪接在一起，醒来你还会觉得
 *   "确实发生过"。所以随机性由代码保证，模型只负责把碎片顺成人话。
 *
 * 三个算子（每个都能单独关掉）：
 *   swap   换主体   「我对他说」→「他对我说」
 *   splice 拆句重组 取 A 的主语 + B 的谓宾
 *   drift  挪场景   把 C 里的一个地名/感官词塞进 D 的句子
 *
 * 纯函数，无 IO、无网络。CLI 只用于调试。
 */

const KEEP = new Set(['utterance', 'heard', 'voice', 'narration', 'diary', 'dream'])

/** 事件流 → 可当记忆碎片的句子。按类型过滤，丢掉空句与纯符号，并按文本去重。 */
export function fragments(events) {
  const out = []
  const seen = new Set()
  for (const e of events) {
    if (!e || !KEEP.has(e.type)) continue
    const text = String(e.text ?? '').replace(/\s+/g, ' ').trim()
    if (text.length < 6) continue
    if (!/[\u4e00-\u9fa5A-Za-z]/.test(text)) continue
    const body = text.replace(/[。！？…]+$/u, '')
    // 真鱼的事件流里混着大量"工作日志"（markdown、编号列表、长报告）。
    // 那些不是经历，是会议纪要——入梦的话，梦会变成任务清单。
    if (text.length > 90) continue
    if (/[*#`|<>]/.test(text)) continue
    if (/^\s*\d+[.、)）]/.test(text)) continue
    if (seen.has(body)) continue
    // 半句话、转述句、指代开头的残句：单独拿出来不成立，缝进梦里只会变成碎纸
    if (/[「」：；]/.test(text)) continue
    if (/^(不|的|它|这|那|所以|但是|不过|而且|就是|可是|因为|如果|然后|还有|并且|或者|而我)/.test(body)) continue
    // 问句、对话里的反问、破折号插话：那是聊天，不是事情
    if (/[？?]|是不是|要不要|——|…/.test(text)) continue
    const picked = bestClause(body) ?? body
    if (seen.has(picked)) continue
    seen.add(picked)
    seen.add(body)
    out.push({
      id: String(e.id ?? ''),
      type: e.type,
      day: Number(e.day) || 0,
      ts: Number(e.ts) || 0,
      text: clip(picked, 60),
      // heard / voice 是"别人说的"：方向不对，不能和她的句子缝在一起，
      // 只能作为背景声音放在梦的末尾。
      other: e.type === 'heard' || e.type === 'voice',
    })
  }
  return out
}


function clip(s, n) {
  const t = s.replace(/[。！？…]+$/u, '')
  return t.length <= n ? t : `${t.slice(0, n)}…`
}

/**
 * 从一段话里挑一个"有画面"的短分句。
 * 真鱼的经历常是长段落（「我去看了首页，推了四条内容，其中一条是…」），
 * 整段入梦会变成纪事；梦要的是其中一个能被看见的碎片。
 */
export function bestClause(text) {
  const parts = String(text)
    .split(/[。，；、!?！？\n]+/u)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6 && s.length <= 30)
  if (!parts.length) return null
  const latin = (s) => (s.match(/[A-Za-z0-9]/g) || []).length / Math.max(1, s.length)
  const scored = parts
    .map((s) => ({ s, bad: latin(s) + (/\d/.test(s) ? 0.3 : 0) }))
    .sort((a, b) => a.bad - b.bad)
  return scored[0].bad > 0.45 ? null : scored[0].s
}


/** 可注入的随机源，方便测试复现。 */
export function rng(seed = Date.now()) {
  let x = seed >>> 0 || 1
  return () => {
    x ^= x << 13
    x >>>= 0
    x ^= x >> 17
    x ^= x << 5
    x >>>= 0
    return x / 4294967296
  }
}

/**
 * 加权抽样：越久没被提起的事，越容易入梦。
 * 这不是"重要的先来"——梦不按重要性挑，它挑的是没被消化完的。
 */
export function sample(pool, n, rand, { now = Date.now(), halfLifeDays = 20 } = {}) {
  const weights = pool.map((f) => {
    const ageDays = f.ts ? Math.max(0, (now - f.ts) / 86400000) : 30
    const decay = Math.pow(0.5, ageDays / halfLifeDays)
    // 久远的事权重反而高一点：底数 0.35 保证新事也会梦见
    return 0.35 + decay
  })
  const picked = []
  const idx = pool.map((_, i) => i)
  const w = [...weights]
  for (let k = 0; k < n && idx.length; k++) {
    const total = w.reduce((a, b) => a + b, 0)
    if (total <= 0) break
    let r = rand() * total
    let j = 0
    while (j < idx.length - 1 && r > w[j]) {
      r -= w[j]
      j++
    }
    picked.push(pool[idx[j]])
    idx.splice(j, 1)
    w.splice(j, 1)
  }
  return picked
}

/** 换主体：把"我"和"他/你"对调。heard 类原样返回（别人说的话不能变成我说的）。 */
export function swap(text) {
  if (!/我/.test(text)) return null
  if (!/他|她|你/.test(text)) return null
  return text
    .replace(/我/g, '\u0000')
    .replace(/他|她|你/g, '我')
    .replace(/\u0000/g, '他')
}

/**
 * 切点只选结构词。早先也切"在/了/着/是"，缝出来是「我盯在下雨」这种——
 * 那不是梦，那是坏掉的句子。梦的错法应该是"意思接错了"，不是"语法碎了"。
 */
const CUT = /(把|给|和|跟|的)/


/** 拆句：A 的前半句 + B 的后半句。找不到切点就返回 null。 */
export function splice(a, b) {
  const cutA = a.search(CUT)
  const cutB = b.search(CUT)
  if (cutA < 2 || cutB < 2) return null
  const head = a.slice(0, cutA)
  const tail = b.slice(cutB)
  if (head.length < 2 || tail.length < 2) return null
  // 主语必须是人称代词：名词主语一接别人的谓宾就会散架（"车被推过楼下"）
  if (!/^(我|你|他|她|它|我们|你们|他们)/.test(head)) return null
  return head + tail
}

const PLACE_TAIL = '(?:里|上|边|前|后|下|外|中间|旁边)'
/** 只认 2~5 字、以方位词结尾的短地名，别把整句动词短语抓进来。 */
const PLACE_RE = new RegExp(`[\\u4e00-\\u9fa5]{1,4}${PLACE_TAIL}`, 'g')
const NOT_PLACE = /(了|着|过|说|想|把|就|也|都|没|不|会|要|在)/

/** 挪场景：从 b 里挑一个短地名，缀到 a 后面。挑不到就返回 null。 */
export function drift(a, b) {
  const cands = (b.match(PLACE_RE) || []).filter(
    (w) => w.length >= 2 && w.length <= 6 && !NOT_PLACE.test(w) && !a.includes(w),
  )
  if (!cands.length) return null
  const w = cands[0]
  // 光缀一个地名太干（「噪音特别多，桌上」），加个"在"才像句子里嵌进去的一个场景
  return `${a}，在${w}`
}


/**
 * 拼一个梦。
 * @returns {{lines: string[], used: string[], ops: string[]}}
 */
export function weave(events, {
  seed = Date.now(),
  size = 4,
  useSwap = true,
  useSplice = true,
  useDrift = true,
  now = Date.now(),
} = {}) {
  const rand = rng(seed)
  const all = fragments(events)
  const mine = all.filter((f) => !f.other)
  const others = all.filter((f) => f.other)
  if (mine.length < 3) return { lines: [], used: [], ops: [] }

  const picked = sample(mine, Math.min(size, mine.length), rand, { now })
  const lines = []
  const used = []
  const ops = []
  const consumed = new Set()

  for (let i = 0; i < picked.length; i++) {
    if (consumed.has(i)) continue
    const f = picked[i]
    let line = f.text
    // 每个碎片最多做一种变形；四分之一保持原样——梦里有相当一部分就是原句
    const roll = rand()
    if (useSwap && roll < 0.28) {
      const s = swap(line)
      if (s) { line = s; ops.push('swap') }
    } else if (useSplice && roll < 0.52 && i + 1 < picked.length) {
      const s = splice(line, picked[i + 1].text)
      if (s) {
        line = s
        ops.push('splice')
        // 后半句已经被缝进来了，别再单独出现一次
        consumed.add(i + 1)
        used.push(picked[i + 1].id)
      }
    } else if (useDrift && roll < 0.74) {
      const other = picked[Math.floor(rand() * picked.length)]
      const s = drift(line, other.text)
      if (s) { line = s; ops.push('drift') }
    }
    const cut = clip(line, 26)
    if (lines.includes(cut)) continue
    lines.push(cut)
    used.push(f.id)
  }

  // 一个变形都没有就不是梦，是摘抄——随便挑一句挪个场景
  if (!ops.length && lines.length >= 2) {
    const i = Math.floor(rand() * lines.length)
    const j = (i + 1) % lines.length
    const s = drift(lines[i], lines[j])
    if (s) { lines[i] = clip(s, 26); ops.push('drift') }
  }

  // 梦里会飘过一句"别人的声音"，但只有一句，且一定在最后——
  // 混进正文会让整段读起来像剪辑错，而梦的错法是"背景音浮上来"。
  if (others.length && rand() < 0.5) {
    const v = others[Math.floor(rand() * others.length)]
    lines.push(clip(v.text, 24))
    used.push(v.id)
  }

  // 梦不按时间顺序展开
  for (let i = lines.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[lines[i], lines[j]] = [lines[j], lines[i]]
  }
  return { lines, used, ops }
}


export function render(result, sep = '。') {
  if (!result.lines.length) return ''
  return `${result.lines.join(sep)}。`
}
