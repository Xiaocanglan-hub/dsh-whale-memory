/**
 * extract.mjs —— 事件提取：把「对话」压成「事情」
 *
 * 为什么需要它：
 *   `~/.dsh-fish/events.jsonl` 里存的是她经历过的一切——但绝大部分是**对话**：
 *   「帮我测试一下」「好，那就不看了」「捕获我先停了」。
 *   这些话是真实的，可它们不是**事情**。拿它们去编故事，编出来的是三句并排的碎纸。
 *
 * 它做的事：
 *   按天分批读原始记录 → 挑出"谁做了什么" → 存成 incidents.json
 *   一份产出，两个用处：
 *     · 做梦插件拿它当「事情/变化」材料（比对话残片结实得多）
 *     · 慢波整理拿它当整理内容（它现在整理的也全是对话残片）
 *
 * 用法：
 *   node extract.mjs                       # 提取全部（增量：只处理没提过的天）
 *   node extract.mjs --fish ~/.dsh-fish --days 3
 *   node extract.mjs --rule                # 不调模型，用规则粗提（快、糙、可对照）
 *   node extract.mjs --dry                 # 只报数，不落盘
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const OLLAMA = process.env.DREAM_OLLAMA || 'http://127.0.0.1:11434/v1/chat/completions'
const MODEL = process.env.DREAM_MODEL || 'qwen3:4b-instruct-2507-q4_K_M'

const KEEP = new Set(['utterance', 'narration', 'heard', 'voice', 'revise'])

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1]
  if (process.argv.includes(`--${name}`)) return true
  return def
}
const flag = (n) => process.argv.includes(`--${n}`)

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}
export function incidentsPath() {
  return join(dshHome(), 'dream', 'incidents.json')
}
export function fishRoot(p) {
  return p || join(homedir(), '.dsh-fish')
}

export function readEvents(root) {
  const p = join(root, 'events.jsonl')
  if (!existsSync(p)) return []
  const out = []
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      out.push(JSON.parse(s))
    } catch {
      /* 单行坏了就跳，不因为一行塌掉整条鱼 */
    }
  }
  return out
}

/** 一趟记录里，哪些句子值得拿去做事件提取。 */
export function candidates(events) {
  const seen = new Set()
  const out = []
  for (const e of events) {
    if (!e || !KEEP.has(e.type)) continue
    const text = String(e.text ?? '').replace(/\s+/g, ' ').trim()
    if (text.length < 8 || text.length > 200) continue
    // 工具日志、markdown、编号清单不是经历
    if (/[*#`|<>]/.test(text)) continue
    if (/^\s*\d+[.、)）]/.test(text)) continue
    if (/^\[.*\]$/.test(text)) continue
    const body = text.replace(/[。！？…]+$/u, '')
    if (seen.has(body)) continue
    seen.add(body)
    out.push({
      id: String(e.id ?? ''),
      day: Number(e.day) || Number(String(e.ts || '').slice(0, 10)) || 0,
      ts: Number(e.ts) || 0,
      type: e.type,
      text: body,
    })
  }
  return out
}

/** 按天分组（天是她的天数计，不是自然日）。 */
export function groupByDay(items) {
  const m = new Map()
  for (const it of items) {
    const k = it.day || 0
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(it)
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0])
}

export const EXTRACT_SYSTEM = [
  '你是一个经历整理器。下面是一段时间里她的原始记录：有她说的话、别人说的话、她的想法，混在一起。',
  '请只挑出「**发生过的事情**」——谁做了什么。',
  '规则：',
  '一、只要事情，不要感想、不要评价、不要总结。想法不是事情。',
  '二、一条不超过十八个字，写成「谁 + 做了什么」，能带结果就带上结果。',
  '三、谁可以是「我」「他」「她」「有人」，看不出来就写「我」。',
  '四、原话里的对话残句（「好」「帮我测试一下」）不是事情，丢掉。',
  '五、只输出 JSON，键名 events，值是数组，每项两个键：who 和 act。没有事情就输出空数组。',
  '示范：',
  '记录：我：帮我把那个测试一下 / 他：等下我看看 / 我：算了，我自己来，把电烙铁插上了',
  '输出：{"events":[{"who":"我","act":"把电烙铁插上了"}]}',
].join('\n')

const BAD_ACT = /^(好|嗯|对|是|行|可以|谢谢|收到|明白|知道了|帮我|你说|你看|然后|所以|但是|因为)/

/** 把模型回包收拾成 [{who, act}]。 */
export function parseEvents(raw) {
  const s = String(raw || '')
  const m = s.match(/\{[\s\S]*\}/)
  let arr = null
  if (m) {
    try {
      const j = JSON.parse(m[0])
      arr = Array.isArray(j?.events) ? j.events : null
    } catch {
      arr = null
    }
  }
  if (!arr) return []
  const out = []
  for (const x of arr) {
    const who = String(x?.who ?? '').replace(/[\s。，,]/g, '').slice(0, 4) || '我'
    let act = String(x?.act ?? '')
      .replace(/[\s]+/g, '')
      .replace(/[。！？；，、]+$/u, '')
      .trim()
    if (act.length < 3 || act.length > 26) continue
    if (BAD_ACT.test(act)) continue
    if (!/[\u4e00-\u9fa5]/.test(act)) continue
    out.push({ who, act })
  }
  return out
}

/** 不调模型的规则版：挑带人称 + 动作词的短句。糙，但可以用来对照模型漏了什么。 */
const ACT_VERB =
  /放|拿|走|跑|摔|扔|捡|拎|推|拉|开|关|坐|站|醒|哭|说|问|发|打|洗|擦|塞|装|换|修|买|找|数|写|看|盯|碰|撕|折|藏|丢|递|抱|拍|踢|踩|钻|爬|停|回|撤|切|剪|盖|摊|倒|灌|咬|吃|喝|抽|点|按|抬|举|松|握|摸|敲|翻|卷|抖|晃|插|拔|接|拆|拼|启|装/

export function extractByRule(items) {
  const out = []
  for (const it of items) {
    for (const clause of it.text.split(/[。！？；\n]+/u)) {
      const s = clause.trim()
      if (s.length < 6 || s.length > 26) continue
      const who = (s.match(/^(我|他|她|有人|我们)/) || [])[1] || '我'
      const body = s.replace(/^(我|他|她|有人|我们)/, '')
      if (!ACT_VERB.test(body)) continue
      out.push({ who, act: body.replace(/[，,]/g, '').slice(0, 26) })
    }
  }
  return out
}

async function askModel(lines, { timeoutMs = 90000 } = {}) {
  const body = JSON.stringify({
    model: MODEL,
    temperature: 0.3,
    stream: false,
    options: { num_predict: 400 },
    messages: [
      { role: 'system', content: EXTRACT_SYSTEM },
      { role: 'user', content: `记录：\n${lines.map((x) => `- ${x.who || ''}${x.text}`).join('\n')}` },
    ],
  })
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(OLLAMA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
      body,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = await res.json()
    const text = String(j?.choices?.[0]?.message?.content ?? '').trim()
    if (!text || /^[0\s]+$/.test(text)) throw new Error('模型输出退化了')
    return text
  } finally {
    clearTimeout(timer)
  }
}

export function loadIncidents() {
  const p = incidentsPath()
  if (!existsSync(p)) return { events: [] }
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    return Array.isArray(j?.events) ? j : { events: [] }
  } catch {
    return { events: [] }
  }
}

export function saveIncidents(store) {
  const p = incidentsPath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  return p
}

/** 两件事是不是同一件（模型爱把同一件事换一个字再说一遍）。 */
export function similar(a, b) {
  const grams = (s) => {
    const t = new Set()
    const x = String(s).replace(/[^\u4e00-\u9fa5]/g, '')
    for (let i = 0; i + 2 <= x.length; i += 1) t.add(x.slice(i, i + 2))
    return t
  }
  const A = grams(a)
  const B = grams(b)
  if (!A.size || !B.size) return false
  let hit = 0
  for (const g of A) if (B.has(g)) hit += 1
  return hit / Math.min(A.size, B.size) >= 0.6
}

/** 去重：同一个"谁+做了什么"只留一条，但累加它被提到过几次。 */
export function mergeIncidents(store, fresh, { day = 0, cap = 4000 } = {}) {
  const list = store.events.map((e) => ({ ...e }))
  let added = 0
  for (const e of fresh) {
    const old = list.find((x) => x.who === e.who && (x.act === e.act || similar(x.act, e.act)))
    if (old) {
      old.n = Number(old.n || 1) + 1
      old.last = Date.now()
      continue
    }
    list.push({ ...e, day, n: 1, at: Date.now(), last: Date.now() })
    added += 1
  }
  const events = list.sort((a, b) => b.day - a.day).slice(0, cap)
  return { store: { ...store, events }, added }
}

async function main() {
  const root = fishRoot(arg('fish'))
  const limitDays = Number(arg('days', 0)) || 0
  const rule = flag('--rule')
  const dry = flag('--dry')

  const events = readEvents(root)
  const items = candidates(events)
  let days = groupByDay(items)
  if (limitDays > 0) days = days.slice(-limitDays)

  console.log(`原始记录 ${events.length} 条 → 候选 ${items.length} 条 · ${days.length} 天`)
  if (!days.length) {
    console.log('没有可提取的内容。')
    return
  }

  const store = loadIncidents()
  const done = new Set(store.events.map((e) => e.day))
  let totalAdded = 0
  let failed = 0

  for (const [day, batch] of days) {
    // 增量：这一天已经提过、而且记录条数没变多，就跳过
    const fresh = batch.filter((x) => !store.events.some((e) => e.day === day && e.srcId === x.id))
    if (!fresh.length) continue

    let got = []
    if (rule) {
      got = extractByRule(fresh)
    } else {
      try {
        const raw = await askModel(fresh.map((x) => ({ who: x.type === 'heard' || x.type === 'voice' ? '别人：' : '我：', text: x.text })))
        got = parseEvents(raw)
      } catch (e) {
        console.error(`  第 ${day} 天：模型没用上（${e.message}），改用规则`)
        got = extractByRule(fresh)
        failed += 1
      }
    }

    for (const g of got) g.srcId = fresh.find((x) => x.text.includes(g.act.slice(0, 4)))?.id ?? ''
    const r = mergeIncidents(store, got, { day })
    store.events = r.store.events
    totalAdded += r.added
    console.log(`  第 ${day} 天：${fresh.length} 条记录 → ${got.length} 件事（新增 ${r.added}）`)
  }

  if (dry) {
    console.log(`\n[dry] 想加 ${totalAdded} 件，没落盘。`)
    return
  }
  const p = saveIncidents(store)
  console.log(`\n事件库：${store.events.length} 件 · 本次新增 ${totalAdded} 件${failed ? ` · 模型失败 ${failed} 天（已用规则兜底）` : ''}`)
  console.log(`存档：${p}`)
  const show = store.events.slice(0, 8)
  if (show.length) {
    console.log('\n最近提取到的：')
    for (const e of show) console.log(`  · 第 ${e.day} 天　${e.who}${e.act}`)
  }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('extract.mjs')) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}