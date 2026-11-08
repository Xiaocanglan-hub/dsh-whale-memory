/**
 * 忆鲸鲸 · 上学 —— 只做一件事：把她**问出口、又没被回答**的话记下来。
 *
 * 为什么只收这一种：用户 m05654 之前量过一次宽口径——她每条发言都问"哪一点没落地"，
 * 24 条里会留下 21 条"悬着"，全是她的自言自语（"我到底是谁？"），没人看得过来。
 * 收窄到「以问号结尾 + 问的是你」之后，两天只剩 3 条。
 *
 * 所以这里的判据是机械的、不花模型的：
 *   ① 她那句话以 ？ 结尾
 *   ② 那句话最后一段里出现了「你」
 * 两条都过才记。真要再加判断（比如"你到底答了没有"），走 tools 里留的开关，不在这里猜。
 *
 * 不碰 dsh-fish 的任何代码，只读它的 events.jsonl。
 */

import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFile, writeFile, mkdir, rename, appendFile } from 'node:fs/promises'
import { watch, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { search, readPage, SOURCES, tavilyKey } from './search.js'
import { studyOne, refineToQuestion, isInternal } from './study.js'

export const name = 'school'
export const inject = ['tools']

const KEEP_OPEN = 400
const MAX_PER_DAY = 5

/**
 * 「她缺的那点知识」——不是她问出口的话，是她能力上的缺口。
 * 这些能查、查完立刻有用，所以直接记成「疑问」（必须学）。
 * 只在她第一次跑的时候铺一次，之后由她自己长。
 */
const GAP_SEEDS = [
  'ffmpeg 怎么把屏幕录成视频',
  'B 站视频的弹幕怎么用接口获取',
  'Windows 怎么查键盘鼠标空闲了多久',
  'ollama 怎么在不联网的情况下换模型',
  'Python 怎么读 wav 文件的采样率',
  '浏览器证书错误怎么绕过',
]

const OUTPUT = {
  schema: {
    type: 'object',
    required: ['text'],
    properties: { text: { type: 'string' } },
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
}

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')
const fishRoot = () => process.env.DSH_FISH_HOME || join(homedir(), '.dsh-fish')
const eventsPath = () => join(fishRoot(), 'events.jsonl')
const storePath = () => join(dshHome(), 'school', 'questions.json')
const notePath = () => join(fishRoot(), 'notes.json')

/**
 * 往她桌上放一张纸条。只添一张，不碰别人的条目。
 * 失败就放弃这一张，绝不让"放纸条失败"连累学习结果。
 */
async function addFishNote(text) {
  const body = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
  if (!body) return null
  try {
    let list = []
    try {
      const cur = JSON.parse(await readFile(notePath(), 'utf8'))
      list = Array.isArray(cur) ? cur : []
    } catch { list = [] }
    const now = new Date()
    const note = {
      id: `note-${now.getTime()}-d${Math.floor(Math.random() * 1296).toString(36)}`,
      text: body,
      due: '',
      created: now.toISOString(),
      status: 'open',
      reason: null,
      closedAt: null,
    }
    list.push(note)
    await mkdir(fishRoot(), { recursive: true })
    await writeFile(notePath(), `${JSON.stringify(list, null, 2)}\n`, 'utf8')
    return note
  } catch {
    return null
  }
}

let cache = null

async function load() {
  if (cache) return cache
  try {
    const raw = await readFile(storePath(), 'utf8')
    const j = JSON.parse(raw)
    cache = {
      version: 1,
      lastScanTs: j.lastScanTs || '',
      questions: Array.isArray(j.questions) ? j.questions : [],
    }
  } catch {
    cache = { version: 1, lastScanTs: '', questions: [] }
  }
  return cache
}

async function save(store) {
  cache = store
  const p = storePath()
  await mkdir(dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  await writeFile(tmp, JSON.stringify(store, null, 2), 'utf8')
  await rename(tmp, p)
}

/** 二字词集合，用来判"是不是同一个问题" */
const STOP2 = new Set(['这个', '那个', '什么', '怎么', '我们', '你们', '他们', '自己', '现在',
  '不是', '可以', '没有', '一个', '就是', '还是', '因为', '所以', '但是', '如果', '已经',
  '知道', '到底', '真的', '应该', '需要', '是不', '有没', '有没有'])

function grams(s) {
  const t = String(s || '').replace(/[^\u4e00-\u9fa5]/g, '')
  const out = new Set()
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2)
    if (!STOP2.has(g)) out.add(g)
  }
  return out
}

function overlap(a, b) {
  const A = grams(a), B = grams(b)
  if (!A.size || !B.size) return 0
  let hit = 0
  for (const g of A) if (B.has(g)) hit++
  return hit / Math.min(A.size, B.size)
}

/** 她说出口的、问到你头上的那句话 */
function isHanging(text) {
  const t = String(text || '').trim()
  if (t.length < 8 || t.length > 300) return false
  if (!/[？?]\s*$/.test(t)) return false
  const tail = t.slice(-60)
  return /你/.test(tail)
}

const dayKey = (d) => {
  const x = new Date(d)
  const p = (n) => String(n).padStart(2, '0')
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`
}

/** 把一句话压成"焦点"：**取最后那句问到你头上的话**，别拿前面的从句凑数 */
function focusOf(text) {
  const t = String(text || '').trim()
  // 按句末标点切成句子；哪句里有问号、又提到"你"，就是它
  const sentences = t.split(/(?<=[。！？!?])/).map((s) => s.trim()).filter(Boolean)
  const asked = sentences.filter((s) => /[？?]\s*$/.test(s))
  const toYou = asked.filter((s) => /你/.test(s))
  let pick = toYou.length ? toYou[toYou.length - 1] : asked.length ? asked[asked.length - 1] : ''
  if (!pick) {
    const withYou = sentences.filter((s) => /你/.test(s))
    pick = withYou.length ? withYou[withYou.length - 1] : sentences[sentences.length - 1] || t
  }
  // 再去掉引号里那些"引用他说的话"，只看她自己问的那半句
  pick = pick.replace(/「[^」]{0,40}」/g, '').replace(/“[^”]{0,40}”/g, '').trim()
  // 中文的问通常落在最后那个分句上："要不要我再想办法？" / "是不是你给我这边的头像？"
  const clauses = pick.split(/[，,；;：:——]/).map((x) => x.trim().replace(/[。]+$/, '')).filter(Boolean)
  let q = clauses[clauses.length - 1] || pick
  if (q.length < 4 && clauses.length > 1) q = clauses[clauses.length - 2]
  return q.replace(/[。？?]+$/, '').trim().slice(0, 40)
}

async function readEvents() {
  try {
    const raw = await readFile(eventsPath(), 'utf8')
    const out = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        /* 半行忽略 */
      }
    }
    return out
  } catch {
    return null
  }
}

/**
 * 扫一遍事件流，把符合口径的新发言收进来。
 * 只认 `utterance` 类型——`meta` / `heard` / `voice` 都不是她"问出口"的话。
 */
async function scan() {
  const store = await load()
  const events = await readEvents()
  if (events === null) return { ok: false, reason: 'no-events', added: 0, total: store.questions.length }

  const seen = new Set(store.questions.map((q) => q.ev))
  const perDay = {}
  for (const q of store.questions) {
    const d = q.dayKey || dayKey(q.at)
    perDay[d] = (perDay[d] || 0) + 1
  }

  let added = 0
  let merged = 0
  let skippedCap = 0
  // 她问的很多话离不开上下文（"够不够用来试你说的那个"），所以顺手记住最近一句"她听到的用户原话"
  let lastHeard = ''

  for (const ev of events) {
    if (ev.type === 'heard' && ev.text) {
      lastHeard = String(ev.text)
      continue
    }
    if (ev.type !== 'utterance') continue
    if (!ev.id || seen.has(ev.id)) continue
    if (!isHanging(ev.text)) continue

    const focus = focusOf(ev.text)
    if (!focus) continue

    // 同一个焦点不重复记，只把"最近一次"往后推
    const same = store.questions.find((q) => q.status === 'open' && overlap(q.focus, focus) >= 0.6)
    if (same) {
      same.asked = (same.asked || 1) + 1
      same.lastAt = ev.ts
      same.lastText = ev.text
      merged++
      seen.add(ev.id)
      continue
    }

    const dk = dayKey(ev.ts)
    if ((perDay[dk] || 0) >= MAX_PER_DAY) {
      skippedCap++
      seen.add(ev.id)
      continue
    }

    store.questions.push({
      id: `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      ev: ev.id,
      at: ev.ts,
      dayKey: dk,
      day: ev.day ?? null,
      stage: ev.stage ?? null,
      her: ev.text,
      focus,
      ctx: lastHeard.slice(0, 200),
      kind: 'doubt',
      status: 'open',
      asked: 1,
      lastAt: ev.ts,
      lastText: ev.text,
      verdict: null,
      closedAt: null,
    })
    perDay[dk] = (perDay[dk] || 0) + 1
    seen.add(ev.id)
    added++
  }

  // 太多就只留最近的
  store.questions.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  if (store.questions.length > KEEP_OPEN) store.questions = store.questions.slice(0, KEEP_OPEN)
  store.lastScanTs = new Date().toISOString()
  await save(store)

  return {
    ok: true,
    added,
    merged,
    skippedCap,
    open: store.questions.filter((q) => q.status === 'open').length,
    total: store.questions.length,
  }
}

const daysSince = (iso) => {
  if (!iso) return 0
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000))
}

function renderList(list) {
  if (!list.length) return '我这里没攒着悬着的问题——她问的、你都答了。'
  const lines = list.map((q, i) => {
    const d = daysSince(q.at)
    const asked = q.asked > 1 ? `（问过 ${q.asked} 次）` : ''
    const kind = q.kind === 'question' ? '疑问·必须学' : '疑惑·还没问清'
    return [
      `${i + 1}. [${kind}] ${q.focus}${asked}`,
      `   她原话：${q.her.replace(/\s+/g, ' ').slice(0, 90)}`,
      q.answer ? `   已经查到：${String(q.answer).slice(0, 60)}` : '',
      `   悬了 ${d} 天 · ${dayKey(q.at)} · 编号 ${q.id}`,
    ].filter(Boolean).join('\n')
  })
  return `悬着 ${list.length} 条：\n\n${lines.join('\n\n')}`
}

/**
 * 盯着她的事件流：有新的话就看一眼。
 *
 * 不轮询、不常驻读文件——`fs.watch` 一响就扫，扫完就歇。
 * 两个保险：① 1.5 秒防抖（她一次醒来会连着写好几行）
 *          ② 文件不在或 watch 报错时，退成每 60 秒看一次
 */
function startWatcher(onError) {
  let timer = null
  let watcher = null
  let closed = false
  let poller = null

  const kick = () => {
    if (closed) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      scan().catch((e) => onError?.(e))
    }, 1500)
  }

  const arm = () => {
    if (closed) return
    const p = eventsPath()
    if (!existsSync(p)) {
      clearTimeout(poller)
      poller = setTimeout(arm, 60_000)
      return
    }
    try {
      watcher = watch(p, { persistent: false }, () => kick())
      watcher.on('error', () => {
        try { watcher.close() } catch { /* 已经关了 */ }
        watcher = null
        clearTimeout(poller)
        poller = setTimeout(arm, 60_000)
      })
    } catch {
      clearTimeout(poller)
      poller = setTimeout(arm, 60_000)
    }
  }

  arm()
  // 插件起来的时候先补一次，把停用期间漏掉的收进来
  kick()

  return () => {
    closed = true
    clearTimeout(timer)
    clearTimeout(poller)
    try { watcher?.close() } catch { /* 已经关了 */ }
  }
}


/* ---------- 空闲时自己去学 ---------- */

const __dir = dirname(fileURLToPath(import.meta.url))
const learnStatePath = () => join(dshHome(), 'school', 'state.json')

const LEARN_DEFAULTS = {
  enabled: true,
  checkIntervalMinutes: 30,
  minIdleMinutes: 10,
  window: ['08:00', '23:00'],
  maxPerDay: 5,
}

async function readLearnConfig() {
  let raw = {}
  try {
    raw = JSON.parse(await readFile(join(dshHome(), 'school', 'config.json'), 'utf8'))
  } catch { raw = {} }
  return { ...LEARN_DEFAULTS, ...(raw.learn || {}) }
}

async function readLearnState() {
  try {
    const j = JSON.parse(await readFile(learnStatePath(), 'utf8'))
    return { days: {}, ...j }
  } catch {
    return { days: {} }
  }
}

async function writeLearnState(s) {
  const p = learnStatePath()
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, JSON.stringify(s, null, 2), 'utf8')
}

function inWindow(win, now = new Date()) {
  if (!Array.isArray(win) || win.length !== 2) return true
  const toMin = (s) => {
    const [h, m] = String(s).split(':').map(Number)
    return (h || 0) * 60 + (m || 0)
  }
  const cur = now.getHours() * 60 + now.getMinutes()
  const a = toMin(win[0])
  const b = toMin(win[1])
  return a <= b ? cur >= a && cur <= b : cur >= a || cur <= b
}

/** 键鼠安静了多少秒；拿不到返回 null（宁可不学，也不在你打字时抢电脑） */
function systemIdleSeconds() {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(__dir, 'idle.ps1')],
      { timeout: 15000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null)
        const n = Number(String(stdout).trim())
        resolve(Number.isFinite(n) ? n : null)
      },
    )
  })
}

/** 挑悬得最久的那条疑问，学一条。不跟你说话，只留纸条。 */
async function learnOnce({ force = false } = {}) {
  const cfg = await readLearnConfig()
  if (!cfg.enabled && !force) return { status: 'off' }

  const store = await load()
  const open = store.questions
    .filter((q) => q.status === 'open' && q.kind === 'question' && !isInternal(q))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
  if (!open.length) return { status: 'none' }

  const q = open[0]
  const sources = tavilyKey() ? ['tavily', 'so360'] : ['so360', 'bili']
  const logLines = []
  const r = await studyOne(q, { sources, pages: 2, log: (m) => logLines.push(m) })

  const st = await readLearnState()
  const today = dayKey(new Date())
  st.days = st.days || {}
  st.lastFocus = q.focus
  if (r.ok) {
    q.status = 'studied'
    q.studiedAt = r.study.at
    q.answer = r.study.answer
    q.answerHow = r.study.how
    await save(store)
    await addFishNote(`我查到一个没弄明白的事：「${q.focus}」——${r.study.answer}`)
    st.days[today] = (st.days[today] || 0) + 1
    st.lastLearnAt = r.study.at
    st.lastStatus = 'ok'
  } else {
    st.lastStatus = 'fail'
    st.lastReason = r.reason || ''
  }
  await writeLearnState(st)
  return { status: r.ok ? 'ok' : 'fail', q, r, logLines }
}

/**
 * 自己的定时器——不走她自己的 proactive。
 * 那条路第一道闸就是"她想不想开口"，而我们要的正好相反：不想说话，但要去学。
 */
function startLearnLoop(onError) {
  let timer = null
  let closed = false

  const dbg = async (m) => { try { await mkdir(join(dshHome(), 'school'), { recursive: true }); await appendFile(join(dshHome(), 'school', 'learn.log'), new Date().toISOString() + ' ' + m + '\n') } catch {} }

  const tick = async () => {
    if (closed) return
    await dbg('tick')
    let waitMinutes = 30
    try {
      const cfg = await readLearnConfig()
      waitMinutes = Math.max(1, Math.min(240, Number(cfg.checkIntervalMinutes) || 30))
      await dbg('cfg enabled=' + cfg.enabled + ' interval=' + cfg.checkIntervalMinutes + ' minIdle=' + cfg.minIdleMinutes + ' max=' + cfg.maxPerDay)
      if (cfg.enabled) {
        const now = new Date()
        const st = await readLearnState()
        const used = (st.days && st.days[dayKey(now)]) || 0
        await dbg('used=' + used + ' inWindow=' + inWindow(cfg.window, now))
        if (used < cfg.maxPerDay && inWindow(cfg.window, now)) {
          const idle = await systemIdleSeconds()
          await dbg('idle=' + idle + ' used=' + used)
          if (idle !== null && idle >= cfg.minIdleMinutes * 60) {
            await dbg('going to learn')
            const res = await learnOnce()
            await dbg('learn status=' + res.status)
          }
        }
      }
    } catch (e) {
      await dbg('ERR ' + (e && e.stack ? e.stack.split('\\n').slice(0, 4).join(' | ') : e))
      onError?.(e)
    }
    if (closed) return
    timer = setTimeout(tick, waitMinutes * 60_000)
    timer.unref?.()
  }

  timer = setTimeout(tick, (Number(process.env.SCHOOL_FIRST_TICK_MS) || 2 * 60_000))
  timer.unref?.()

  return () => {
    closed = true
    clearTimeout(timer)
  }
}

export function apply(ctx) {
  cache = null

  // 她一说新话就自动收；插件卸掉时把这个 watcher 一起关掉
  ctx.effect(() => startWatcher((e) => {
    try {
      console.warn('[school] 自动扫描失败：' + (e?.message || e))
    } catch { /* 日志失败不影响主流程 */ }
  }))


  // 空闲时自己去学：自己的定时器，不看她的 proactive
  ctx.effect(() => startLearnLoop((e) => {
    try {
      console.warn('[school] 自动学习失败：' + (e?.message || e))
    } catch { /* 日志失败不影响主流程 */ }
  }))

  ctx.tools.register(
    {
      name: 'school_scan',
      description: '扫一遍她的经历，把她**问出口又没被回答**的话收进清单。机械判据：以问号结尾、且问的是「你」。不花模型。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: OUTPUT,
      execute: async () => {
        const r = await scan()
        if (!r.ok) return { text: `扫不了：读不到她的经历文件（${eventsPath()}）。` }
        return {
          text: [
            `扫完了：新收 ${r.added} 条 · 合并进已有 ${r.merged} 条` + (r.skippedCap ? ` · 当天满了跳过 ${r.skippedCap} 条` : ''),
            `现在悬着 ${r.open} 条，一共记过 ${r.total} 条。`,
          ].join('\n'),
        }
      },
    },
    { name: 'school_scan' },
  )

  ctx.tools.register(
    {
      name: 'school_pending',
      description: '列出她悬着的问题——她问过你、你还没答的那些。按悬得最久排前面。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', description: '最多列几条，默认 10' } },
        additionalProperties: false,
      },
      output: OUTPUT,
      execute: async (args) => {
        const store = await load()
        const limit = Math.max(1, Math.min(50, Number(args?.limit ?? 10)))
        const open = store.questions
          .filter((q) => q.status === 'open')
          .sort((a, b) => String(a.at).localeCompare(String(b.at)))
          .slice(0, limit)
        return { text: renderList(open) }
      },
    },
    { name: 'school_pending' },
  )

  ctx.tools.register(
    {
      name: 'school_answer',
      description: '关掉一条悬着的问题。answered=你答过了 · not-question=她那是自语不算问 · stop=别再提这条。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '问题编号，从 school_pending 里拿' },
          verdict: {
            type: 'string',
            enum: ['answered', 'not-question', 'stop'],
            description: '为什么关掉它',
          },
        },
        required: ['id', 'verdict'],
        additionalProperties: false,
      },
      output: OUTPUT,
      execute: async (args) => {
        const store = await load()
        const q = store.questions.find((x) => x.id === String(args?.id || ''))
        if (!q) return { text: `没有这个编号：${args?.id}。用 school_pending 看看现在有哪些。` }
        if (q.status !== 'open') return { text: `这条已经关过了（${q.verdict}）。` }
        q.status = 'closed'
        q.verdict = String(args?.verdict || 'answered')
        q.closedAt = new Date().toISOString()
        await save(store)
        const word = { answered: '答过了', 'not-question': '是她自语', stop: '不再提了' }[q.verdict] || '关掉了'
        return { text: `关了：「${q.focus}」—— ${word}。` }
      },
    },
    { name: 'school_answer' },
  )

  ctx.tools.register(
    {
      name: 'school_stats',
      description: '上学清单的规模：悬着几条、关过几条、最近一次扫描时间。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: OUTPUT,
      execute: async () => {
        const store = await load()
        const open = store.questions.filter((q) => q.status === 'open').length
        const closed = store.questions.length - open
        return {
          text: [
            `悬着 ${open} 条 · 关过 ${closed} 条 · 一共记过 ${store.questions.length} 条`,
            `经历文件：${eventsPath()}`,
            `清单文件：${storePath()}`,
            `上次扫描：${store.lastScanTs || '还没扫过'}`,
          ].join('\n'),
        }
      },
    },
    { name: 'school_stats' },
  )

  ctx.tools.register(
    {
      name: 'school_search',
      description: '上网查点东西（必应 / 百度 / B 站站内）。返回标题、网址和一句摘要；某个源挂了会如实说哪个挂了。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜什么，用几个词就够' },
          sources: {
            type: 'array',
            items: { type: 'string', enum: ['tavily', 'so360', 'bing', 'baidu', 'bili'] },
            description: '从哪搜，默认 ["bing","bili"]。baidu 返回慢一点但中文多。',
          },
          limit: { type: 'integer', description: '每个源最多几条，默认 4' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: OUTPUT,
      execute: async (args) => {
        const query = String(args?.query || '').trim()
        if (!query) return { text: '要搜什么？给我一个词。' }
        const sources = Array.isArray(args?.sources) && args.sources.length ? args.sources : (tavilyKey() ? ['tavily', 'so360'] : ['so360', 'bili'])
        const limit = Math.max(1, Math.min(8, Number(args?.limit ?? 4)))
        const r = await search(query, { sources, limit })
        const lines = [`搜「${query}」：拿到 ${r.hits.length} 条`]
        for (const h of r.hits) {
          lines.push(`- [${h.source}] ${h.title}`)
          lines.push(`  ${h.url}`)
          if (h.snippet) lines.push(`  ${h.snippet}`)
        }
        if (r.failed.length) lines.push(`没通的源：${r.failed.map((f) => `${f.source}（${f.error}）`).join('、')}`)
        if (!r.hits.length && !r.failed.length) lines.push('一条都没搜到，换个说法试试。')
        return { text: lines.join('\n') }
      },
    },
    { name: 'school_search' },
  )

  ctx.tools.register(
    {
      name: 'school_read',
      description: '打开一个网页，把正文剥出来（最多 3000 字）。search 给了网址之后用它看内容。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'http 或 https 开头' },
          maxChars: { type: 'integer', description: '最多读多少字，默认 3000' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      output: OUTPUT,
      execute: async (args) => {
        const url = String(args?.url || '').trim()
        if (!/^https?:\/\//i.test(url)) return { text: '给一个 http / https 开头的网址。' }
        const maxChars = Math.max(500, Math.min(6000, Number(args?.maxChars ?? 3000)))
        try {
          const page = await readPage(url, { maxChars })
          if (!page.text) return { text: `打开了但没读出正文：${url}` }
          return { text: [`${page.title || '（没有标题）'}`, url, '', page.text].join('\n') }
        } catch (e) {
          return { text: `打不开：${url} —— ${e?.name === 'TimeoutError' ? '超时' : String(e?.message || e).slice(0, 80)}` }
        }
      },
    },
    { name: 'school_read' },
  )

  ctx.tools.register(
    {
      name: 'school_study',
      description: '学一条：挑她悬着没被回答的问，上网查、读两页、写两三句答案，并在她桌上留一张纸条。不起模型会话，不打扰你。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '指定学哪一条；不给就挑悬得最久的那条' },
          sources: {
            type: 'array',
            items: { type: 'string', enum: ['tavily', 'so360', 'bing', 'baidu', 'bili'] },
            description: '从哪搜，默认 ["bing","bili"]',
          },
        },
        additionalProperties: false,
      },
      output: OUTPUT,
      execute: async (args) => {
        const store = await load()
        const open = store.questions
          .filter((q) => q.status === 'open' && q.kind === 'question')
          .sort((a, b) => String(a.at).localeCompare(String(b.at)))
        if (!open.length) {
          const doubts = store.questions.filter((q) => q.status === 'open' && q.kind !== 'question').length
          return {
            text: doubts
              ? `现在没有「疑问」可学——有 ${doubts} 条「疑惑」还没问清。先用 school_refine 把它们问成能查的问题，或者你直接回答掉。`
              : '现在没有悬着的疑问。先 school_scan 扫一遍，或者 school_gaps 铺一批缺口。',
          }
        }
        const q = args?.id ? open.find((x) => x.id === String(args.id)) : open[0]
        if (!q) return { text: `这条不是可学的疑问：${args?.id}（疑惑要先 school_refine）` }

        const sources = Array.isArray(args?.sources) && args.sources.length ? args.sources : (tavilyKey() ? ['tavily', 'so360'] : ['so360', 'bili'])
        const logLines = []
        const r = await studyOne(q, { sources, pages: 2, log: (m) => logLines.push(m) })

        if (!r.ok) {
          return {
            text: [
              `没学成：「${q.focus}」—— ${r.reason}`,
              r.query ? `搜的词：${r.query}` : '',
              logLines.length ? `过程：${logLines.join('；')}` : '',
              '',
              r.internal
                ? '这条问的是我们自家插件，只有你知道答案：直接回她一句，然后用 school_answer 关掉它。'
                : '这条还悬着。',
            ].filter(Boolean).join('\n'),
          }
        }

        q.studiedAt = r.study.at
        q.answer = r.study.answer
        q.answerHow = r.study.how
        await save(store)

        const note = await addFishNote(`我查到一个没弄明白的事：「${q.focus}」——${r.study.answer}`)

        return {
          text: [
            `学了一条：「${q.focus}」`,
            `搜的词：${r.study.query}`,
            `答案（${r.study.how === 'model' ? '自己整理的' : '原文摘录'}）：`,
            r.study.answer,
            '',
            `读了 ${r.study.sources.length} 页：${r.study.sources.map((u) => u.slice(0, 60)).join(' / ')}`,
            r.study.failed?.length ? `没通的源：${r.study.failed.map((f) => f.source).join('、')}` : '',
            note ? '已经在她桌上放了一张纸条，她下次醒来会看到。' : '纸条没放成（不影响这条学习）。',
            '',
            '这条还开着——你看过、觉得答对了，用 school_answer 关掉它。',
          ].filter(Boolean).join('\n'),
        }
      },
    },
    { name: 'school_study' },
  )

  ctx.tools.register(
    {
      name: 'school_refine',
      description: '把一条「疑惑」问成「疑问」：改写成一句查得到的问题。改不动就如实说改不动——那说明这句话不该拿去搜。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '哪条疑惑；不给就挑悬得最久的' },
        },
        additionalProperties: false,
      },
      output: OUTPUT,
      execute: async (args) => {
        const store = await load()
        const doubts = store.questions
          .filter((q) => q.status === 'open' && q.kind !== 'question')
          .sort((a, b) => String(a.at).localeCompare(String(b.at)))
        if (!doubts.length) return { text: '没有悬着的疑惑——都问清了，或者都被关掉了。' }
        const q = args?.id ? doubts.find((x) => x.id === String(args.id)) : doubts[0]
        if (!q) return { text: `没有这条悬着的疑惑：${args?.id}` }

        const r = await refineToQuestion({ ctx: q.ctx, text: q.her || q.focus, focus: q.focus })
        if (!r.ok) {
          return {
            text: [
              `问不清：「${q.focus}」—— ${r.reason}`,
              '',
              '这条还留在「疑惑」里。这类话通常不是在要知识，是在跟你说话；你直接回它、用 school_answer 关掉也行。',
            ].join('\n'),
          }
        }

        q.kind = 'question'
        q.focus = r.question
        q.refinedAt = new Date().toISOString()
        await save(store)
        return {
          text: [
            `问成疑问了：「${r.question}」`,
            `（原来那句：${q.her.replace(/\s+/g, ' ').slice(0, 60)}）`,
            '',
            '疑问是要学掉的——school_study 会挑它。',
          ].join('\n'),
        }
      },
    },
    { name: 'school_refine' },
  )

  ctx.tools.register(
    {
      name: 'school_gaps',
      description: '铺一批「知识缺口」当疑问：她能力上缺的那点东西（怎么录屏、怎么抓弹幕…）。铺过一次就不会重复。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: OUTPUT,
      execute: async () => {
        const store = await load()
        let added = 0
        for (const g of GAP_SEEDS) {
          const dup = store.questions.find((q) => q.status === 'open' && overlap(q.focus, g) >= 0.5)
          if (dup) continue
          store.questions.push({
            id: `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            ev: null,
            at: new Date().toISOString(),
            dayKey: dayKey(new Date().toISOString()),
            day: null,
            stage: null,
            her: `（缺口：${g}）`,
            focus: g,
            ctx: '',
            kind: 'question',
            source: 'gap',
            status: 'open',
            asked: 0,
            verdict: null,
          })
          added++
        }
        await save(store)
        const open = store.questions.filter((q) => q.status === 'open').length
        return {
          text: added
            ? `铺了 ${added} 条缺口当疑问，现在悬着 ${open} 条。`
            : `缺口都已经在清单里了，现在悬着 ${open} 条。`,
        }
      },
    },
    { name: 'school_gaps' },
  )


  ctx.tools.register(
    {
      name: 'school_auto',
      description: '看她「空闲时自己去学」的开关和最近一次结果；传 enabled 可以打开或关掉。',
      parameters: {
        type: 'object',
        properties: { enabled: { type: 'boolean', description: 'true 打开，false 关掉；不传只查看' } },
        additionalProperties: false,
      },
      output: OUTPUT,
      execute: async (args) => {
        const cfgPath = join(dshHome(), 'school', 'config.json')
        let raw = {}
        try {
          raw = JSON.parse(await readFile(cfgPath, 'utf8'))
        } catch {
          raw = {}
        }
        if (typeof args?.enabled === 'boolean') {
          raw.learn = { ...(raw.learn || {}), enabled: args.enabled }
          await mkdir(dirname(cfgPath), { recursive: true })
          await writeFile(cfgPath, JSON.stringify(raw, null, 2), 'utf8')
        }
        const cfg = await readLearnConfig()
        const st = await readLearnState()
        const used = (st.days && st.days[dayKey(new Date())]) || 0
        const idle = await systemIdleSeconds()
        return {
          text: [
            `自动学习：${cfg.enabled ? '开着' : '关着'}`,
            `节奏：每 ${cfg.checkIntervalMinutes} 分钟看一次；只在 ${cfg.window.join('–')} 之间、你键鼠安静 ${cfg.minIdleMinutes} 分钟后才动手，一天最多 ${cfg.maxPerDay} 条`,
            `今天已学 ${used} 条`,
            `现在键鼠空闲：${idle === null ? '读不到' : Math.round(idle / 60) + ' 分钟'}`,
            st.lastLearnAt
              ? `上次：${st.lastFocus} → ${st.lastStatus === 'ok' ? '学到了' : '没学成（' + (st.lastReason || '') + '）'}`
              : '还没自动学过',
          ].join('\n'),
        }
      },
    },
    { name: 'school_auto' },
  )
}
