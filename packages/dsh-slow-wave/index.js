/**
 * DSH-忆鲸鲸-DeepSleep
 *
 * 「吃白饭睡大觉」：DSH 空闲的时候，它拿本地免费模型（或用户批准的付费模型）
 * 回头整理元素记忆库——合并同义词、精简描述、压缩库；资源够了还会自己
 * 把元素拼起来猜新东西，下次识别时当作猜想先试。
 *
 * 三条铁律（都是踩过坑才定下来的）：
 *   1. **用户纠错过的内容不动**。边或元素上带 lock:'user' 的，一律跳过，
 *      除非配置里 allowTouchLocked 明确打开。
 *   2. **改库之前先备份**，并且每次睡醒留一份报告，说清改了什么、为什么。
 *   3. **看不见的改动不写**。所有合并都记 provenance，能反查到"这两个词
 *      是哪天被谁判断成同义的"。
 */

import { readFile, writeFile, mkdir, readdir, copyFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { makeDream } from './dream/index.mjs'

/* ------------------------------------------------------------------ 路径 */

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')
const dir = () => join(dshHome(), 'deepsleep')
const configPath = () => join(dir(), 'config.json')
const usagePath = () => join(dir(), 'usage.json')
const statePath = () => join(dir(), 'state.json')
const dreamsDir = () => join(dir(), 'dreams')
const backupsDir = () => join(dir(), 'backups')
const brainPath = () => join(dshHome(), 'memory', 'brain.json')
// 潜意识梦的存档。刻意放在 `dream/` 而不是 `deepsleep/`：
// 它和「大肥鱼自带的、她自己记的梦」是两码事，路径上就分开，谁也别覆盖谁。
const dreamStorePath = () => join(dshHome(), 'dream', 'dreams.json')

/* ------------------------------------------------- 她的那一半（只读/只添） */

/** 她的事件流在哪。允许用环境变量指到别处（测试鱼就是这么用的）。 */
export const fishRoot = () => process.env.DSH_FISH_HOME || join(homedir(), '.dsh-fish')

/** 她桌面上的纸条。**只往里添**，绝不删改她自己的东西。 */
const notePath = () => join(fishRoot(), 'notes.json')

/**
 * 往她桌上放一张纸条。
 *
 * 我们只做"添一张"，不碰已有条目、不排序、不清理——那张桌子是她的，
 * 别的插件和 her_note 也在往里写。读不到就当作空表，写坏了就放弃这一张，
 * 绝不因为放纸条失败而让整场梦白做。
 */
async function addFishNote(text) {
  const body = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
  if (!body) return null
  try {
    const cur = await readJson(notePath(), [])
    const list = Array.isArray(cur) ? cur : []
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

/**
 * 这个插件跑起来依赖什么，缺了会怎样。
 *
 * 用户问过一句「标注了潜意识梦环境要求前两个插件了吗」——没标，所以补在这里：
 * 依赖不是可选项，是要在界面上说清楚"少了哪一样，哪一半功能就不动"。
 */
async function probeDeps(cfg) {
  const local = cfg?.models?.local ?? {}
  const baseUrl = String(local.baseUrl || 'http://127.0.0.1:11434/v1')
  let model = false
  try {
    model = await localReachable(baseUrl)
  } catch {
    model = false
  }
  return {
    // 她的事件流：没有它就没有可梦的素材（这不是"少点东西"，是整件事做不成）
    fish: {
      ok: existsSync(join(fishRoot(), 'events.jsonl')),
      path: join(fishRoot(), 'events.jsonl'),
      need: '大肥鱼插件（@ssamurias/dsh-fish）跑起来之后才有',
      effect: '没有它：做不成梦（没有可重组的经历）',
    },
    // 元素记忆库：没有它梦还做，只是没有"道具"，故事会单薄
    memory: {
      ok: existsSync(brainPath()),
      path: brainPath(),
      need: '元素记忆库插件（dsh-memory-brain）',
      effect: '没有它：梦照做，但少了道具与常识，故事会单薄',
    },
    // 本地模型：负责把材料写成句子；没有它只能按选材顺序硬拼，那样不成梦
    model: {
      ok: model,
      baseUrl,
      need: 'ollama 本地模型（默认 qwen3:4b-instruct-2507-q4_K_M）',
      effect: '没有它：只整理库，不做梦',
    },
  }
}

/**
 * 睡完之后做一场梦。
 *
 * 顺序是刻意的：先整理库（这是主任务），再做梦。梦是加餐，
 * 加餐失败绝不能影响主任务——所以整个函数包在 try 里。
 */
async function dreamAfterSleep(cfg, report, opts = {}) {
  const dcfg = { ...DEFAULTS.dream, ...(cfg.dream ?? {}) }
  report.dream = { attempted: false }
  if (!dcfg.enabled) {
    report.dream.skipped = '没允许做梦'
    return
  }

  const state = await readJson(statePath(), {})
  const gapDays = dcfg.minGapDays > 0 ? dcfg.minGapDays : 1
  // 手动跑一次（force）不受间隔限制——那本来就是我按了"现在就试一次"。
  if (!opts.force && typeof state.lastDreamAt === 'string') {
    const days = (Date.now() - Date.parse(state.lastDreamAt)) / 86400000
    if (Number.isFinite(days) && days < gapDays) {
      report.dream.skipped = `离上次做梦不到 ${gapDays} 天（${days.toFixed(1)} 天前）`
      return
    }
  }

  report.dream.attempted = true
  const useModel = cfg.models?.mode !== 'off'
  if (useModel && cfg.models?.mode === 'local') {
    // 起不来就不做梦：没有模型的"梦"只是把碎片并排抄一遍，那是占她寿命
    try {
      await ensureLocalModel(cfg, { waitMs: 25000 })
    } catch (e) {
      report.dream.skipped = `本地模型起不来（${e?.message ?? e}）`
      return
    }
  }

  const local = cfg.models?.local ?? {}
  const baseUrl = String(local.baseUrl || 'http://127.0.0.1:11434/v1').replace(/\/$/, '')
  const res = await makeDream({
    fishRoot: fishRoot(),
    useModel,
    endpoint: `${baseUrl}/chat/completions`,
    model: local.model || 'qwen3:4b-instruct-2507-q4_K_M',
    log: (s) => report.notes.push(`梦：${s}`),
  })

  report.dream.status = res.status
  if (res.status === 'ok') {
    report.dream.text = res.dream.text
    report.dream.chars = res.dream.chars
    report.dream.wakeLine = res.wakeLine
    report.notes.push(`做了个梦（${res.dream.chars} 字）：${res.dream.text}`)

    if (dcfg.narrate === 'always') {
      // 方案 C：纸条里给梦贴来源标注。
      // 她自己说过真正危险的是「把拼的当成发生过的」，所以这句"是梦，不是发生过的事"
      // 不是我们加的保险，是把她的判据写回给她看。
      const note = await addFishNote(`我做了个梦（是梦，不是发生过的事）：${res.wakeLine}`)
      report.dream.note = note ? '已留纸条' : '纸条没放成'
      if (note) report.notes.push(`在桌上留了张纸条：「${note.text}」`)
    } else if (dcfg.narrate === 'never') {
      report.dream.note = '只存档，不讲'
    } else {
      report.dream.note = '等她问起再说'
    }
  } else {
    report.dream.reason = res.reason
    report.notes.push(
      res.status === 'none'
        ? `今夜无梦：${res.reason}`
        : res.status === 'discarded'
          ? `这个梦写坏了，忘掉了（累计 ${res.discarded} 个）`
          : `今夜无梦：${res.reason}`,
    )
  }

  await writeJsonAtomic(statePath(), {
    ...state,
    lastDreamAt: new Date().toISOString(),
    lastDreamStatus: res.status,
    lastDreamText: res.status === 'ok' ? res.dream.text : '',
  })
}

/* ---------------------------------------------------------------- 默认配置 */

const DEFAULTS = {
  idle: {
    // 要不要让它在空闲时自己醒。关掉之后只能手动 deepsleep_run。
    enabled: true,
    // 多久探一次"现在能不能睡"。探一次只跑一条 powershell 读空闲时间，很便宜。
    checkIntervalMinutes: 10,
    // 键鼠空闲多少分钟才允许开工。这是唯一能真实判断"人离开电脑没有"的信号，
    // 光看 DSH 有没有会话判断不了——你可能开着它去干别的了。
    systemIdleMinutes: 5,
    // 两次睡眠之间至少隔多久，防止一直醒着就一直整库。
    minGapMinutes: 30,
    // 只在这个时段睡（24 小时制，左闭右开，[[1,6]] = 凌晨 1 点到 6 点）。空数组 = 不限时段。
    window: [],
  },
  models: {
    // local = 只用本地 ollama；paid = 本地整理 + 付费模型猜想；off = 不调模型，只跑规则
    mode: 'local',
    local: {
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3:4b-instruct-2507-q4_K_M',
      // 连不上就自己拉起 ollama。关掉的话，ollama 没开着这一轮就只能跳过。
      autoStart: true,
      // 留空则自动找：PATH 上的 ollama，以及几个常见安装位置。
      exePath: '',
    },
    paid: {
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      // 不把 key 写进配置文件，从环境变量取；配置文件是明文，容易被顺手发出去。
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      budgetPerNightCny: 0.5,
      pricePerMTokIn: 1,
      pricePerMTokOut: 2,
    },
  },
  tasks: {
    merge: true,       // 合并近义/同义词
    simplify: true,    // 精简描述
    compact: true,     // 剪枝 + 压缩
    hypothesize: false // 自主组合猜想（默认关，因为它的产出会参与识别）
  },
  protect: {
    // 用户亲手教过、纠错过的内容要不要让插件动。默认不动。
    allowTouchLocked: false,
    // 用户否决过的合并，记在这里，永远不再提第二次。
    rejectedPairs: [],
  },
  backup: { keep: 10 },
  // 猜想的限额：一夜最多提几个，免得醒来发现被问题淹没。
  hypothesize: { maxPerNight: 5 },
  /**
   * 潜意识梦。
   *
   * 和大肥鱼「住所 → 她做过的梦」是两件事，别混：
   *   那张卡是她醒来后**自己记**的一句（her_dream，写进她的事件流）；
   *   这里是她睡着时**被拼出来**的，她本人没有参与，也不进她的记忆。
   * 所以数据分开存（$DSH_HOME/dream/dreams.json）、开关分开、显示分开。
   */
  dream: {
    enabled: true,
    // 两次做梦至少隔几天。刻意不给 0 —— 关掉是关掉，不是每天做。
    minGapDays: 2,
    // 醒来怎么讲：always 每次留便条 · ask 只在她问的时候讲 · never 只存档
    narrate: 'always',
  },
}

/* ------------------------------------------------------------------ 小工具 */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v
  }
  return out
}

async function readJson(p, fallback) {
  try {
    return JSON.parse(await readFile(p, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJsonAtomic(p, value) {
  await mkdir(join(p, '..'), { recursive: true })
  const tmp = `${p}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rm(p, { force: true })
  const { rename } = await import('node:fs/promises')
  await rename(tmp, p)
}

async function ensureDirs() {
  for (const d of [dir(), dreamsDir(), backupsDir()]) {
    await mkdir(d, { recursive: true })
  }
}

async function loadConfig() {
  const saved = await readJson(configPath(), null)
  return saved === null ? structuredClone(DEFAULTS) : deepMerge(DEFAULTS, saved)
}

const stamp = () => {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/* -------------------------------------------------------------- 空闲判定 */

/**
 * 系统键鼠空闲了多少秒。
 * Windows 上用 GetLastInputInfo——这是唯一一个不靠猜的信号：DSH 自己有没有
 * 消息传来判断不了你在不在电脑前，但键鼠动没动可以。
 * 拿不到就返回 null，调用方当作"不空闲"处理（宁可少睡，不要偷偷跑满 CPU）。
 */
function systemIdleSeconds(timeoutMs = 8000) {
  if (process.platform !== 'win32') return Promise.resolve(null)
  const script = [
    'Add-Type -Namespace DS -Name U -MemberDefinition \'[DllImport("user32.dll")]',
    'public static extern bool GetLastInputInfo(ref LASTINPUTINFO p);',
    'public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }\'',
    '$i = New-Object DS.U+LASTINPUTINFO',
    '$i.cbSize = [uint32]8',
    'if (-not [DS.U]::GetLastInputInfo([ref]$i)) { Write-Output ""; exit 0 }',
    '$idle = ([Environment]::TickCount - $i.dwTime) / 1000',
    'Write-Output ([int]$idle)',
  ].join('\n')
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null)
        const n = Number.parseInt(String(stdout).trim(), 10)
        resolve(Number.isFinite(n) ? n : null)
      },
    )
  })
}

/* ---------------------------------------------------------------- 模型调用 */

class BudgetExceeded extends Error {}

/** 按天累计花费。付费模型每调一次都要过这道闸，预算用完当天就不再碰。 */
async function chargeUsage({ inTok = 0, outTok = 0, priceIn = 0, priceOut = 0 }) {
  const today = new Date().toISOString().slice(0, 10)
  const u = await readJson(usagePath(), { date: today, cny: 0, inTok: 0, outTok: 0, calls: 0 })
  const fresh = u.date === today ? u : { date: today, cny: 0, inTok: 0, outTok: 0, calls: 0 }
  fresh.cny += (inTok / 1e6) * priceIn + (outTok / 1e6) * priceOut
  fresh.inTok += inTok
  fresh.outTok += outTok
  fresh.calls += 1
  await writeJsonAtomic(usagePath(), fresh)
  return fresh
}

async function chat(cfg, { system, user, maxTokens = 800 }) {
  const mode = cfg.models.mode
  if (mode === 'off') throw new Error('models.mode = off，不调模型')

  const paid = mode === 'paid'
  const m = paid ? cfg.models.paid : cfg.models.local
  const key = paid ? process.env[m.apiKeyEnv] ?? '' : ''
  if (paid && key === '') throw new Error(`付费模型没找到 key：环境变量 ${m.apiKeyEnv} 是空的`)

  if (paid) {
    const today = new Date().toISOString().slice(0, 10)
    const u = await readJson(usagePath(), { date: today, cny: 0 })
    const spent = u.date === today ? u.cny : 0
    if (spent >= m.budgetPerNightCny) {
      throw new BudgetExceeded(`今天的预算 ${m.budgetPerNightCny} 元已经用掉 ${spent.toFixed(3)} 元，收工`)
    }
  }

  const res = await fetch(`${m.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key === '' ? {} : { authorization: `Bearer ${key}` }),
    },
    body: JSON.stringify({
      model: m.model,
      temperature: 0.2,
      max_tokens: maxTokens,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: user },
      ],
    }),
  })
  if (!res.ok) throw new Error(`模型返回 ${res.status}：${(await res.text()).slice(0, 300)}`)
  const json = await res.json()
  const text = json.choices?.[0]?.message?.content ?? ''
  if (paid) {
    await chargeUsage({
      inTok: json.usage?.prompt_tokens ?? 0,
      outTok: json.usage?.completion_tokens ?? 0,
      priceIn: m.pricePerMTokIn,
      priceOut: m.pricePerMTokOut,
    })
  }
  return text
}

/** 模型经常把 JSON 包在 ```json 里，或者前面加一句解释。只抓最外层那对括号。 */
function parseJsonLoose(text) {
  const s = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    return JSON.parse(s.slice(a, b + 1))
  } catch {
    return null
  }
}

/* ------------------------------------------------------------ 睡不睡得起 */

/** 现在这个钟点在不在允许的时段里。空数组 = 不限。 */
function inWindow(window, now = new Date()) {
  if (!Array.isArray(window) || window.length === 0) return true
  const hour = now.getHours() + now.getMinutes() / 60
  return window.some(([from, to]) => {
    if (!Number.isFinite(from) || !Number.isFinite(to)) return false
    // 跨零点的时段（[[22,3]]）要拆成两段比，否则永远不成立
    return from <= to ? hour >= from && hour < to : hour >= from || hour < to
  })
}

/** 本地模型通不通。只看 HTTP 能不能连上，不看模型名对不对（那个由 chat() 报错）。 */
async function localReachable(baseUrl, timeoutMs = 2000) {
  const url = `${String(baseUrl).replace(/\/$/, '')}/models`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

/** ollama 的可执行文件在哪。配置里写了就用配置的，否则按 PATH → 常见安装位置找。 */
function findOllama(exePath) {
  if (typeof exePath === 'string' && exePath !== '' && existsSync(exePath)) return exePath
  const name = process.platform === 'win32' ? 'ollama.exe' : 'ollama'
  const candidates = []
  for (const dir of String(process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (dir !== '') candidates.push(join(dir, name))
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? ''
    if (local !== '') candidates.push(join(local, 'Programs', 'Ollama', 'ollama.exe'))
    candidates.push('D:\\AI\\ollama\\ollama.exe', 'C:\\Program Files\\Ollama\\ollama.exe')
  }
  return candidates.find((p) => existsSync(p)) ?? null
}

/**
 * 保证本地模型能用。连不上就试着自己把 ollama 拉起来再等它。
 * 返回值决定这一轮要不要继续：false = 这轮别用模型（规则部分照跑）。
 */
async function ensureLocalModel(cfg, { waitMs = 25_000 } = {}) {
  const local = cfg.models.local
  if (await localReachable(local.baseUrl)) return true
  if (local.autoStart !== true) return false

  const exe = findOllama(local.exePath)
  if (exe === null) return false

  try {
    // detached + unref：ollama 要活过这次调用，不能跟着我们的进程树一起被收走
    const child = spawn(exe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
  } catch {
    return false
  }

  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000))
    if (await localReachable(local.baseUrl, 1500)) return true
  }
  return false
}

/* -------------------------------------------------------------- 空闲轮询 */

// 同一时刻只允许睡一次。轮询和手动调用可能撞在一起。
let dreaming = false

/**
 * 定时探一次"现在能不能睡"。用户一动键鼠，下一跳就会跳过——
 * 这也是为什么这里只做轻量判断，真正干活在 runDream 里。
 */
function startIdleLoop(getConfig, onError) {
  let timer = null
  let stopped = false

  const tick = async () => {
    if (stopped) return
    try {
      const cfg = await getConfig()
      if (cfg.idle.enabled !== true) return
      if (dreaming) return
      const idleSec = await systemIdleSeconds()
      if (idleSec === null) return
      if (idleSec < cfg.idle.systemIdleMinutes * 60) return
      if (!inWindow(cfg.idle.window)) return

      const state = await readJson(statePath(), {})
      if (typeof state.lastRunAt === 'string') {
        const gap = (Date.now() - Date.parse(state.lastRunAt)) / 60000
        if (Number.isFinite(gap) && gap < cfg.idle.minGapMinutes) return
      }

      dreaming = true
      try {
        await runDream(cfg, { dryRun: false, force: true })
      } finally {
        dreaming = false
      }
    } catch (err) {
      if (typeof onError === 'function') onError(err)
    }
  }

  const schedule = async () => {
    if (stopped) return
    let minutes = 10
    try {
      const cfg = await getConfig()
      const n = Number(cfg.idle.checkIntervalMinutes)
      if (Number.isFinite(n) && n >= 1) minutes = Math.min(n, 240)
    } catch {
      /* 读不到配置就用默认间隔继续探 */
    }
    timer = setTimeout(async () => {
      timer = null
      await tick()
      await schedule()
    }, minutes * 60_000)
    if (typeof timer.unref === 'function') timer.unref()
  }

  schedule()

  return () => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
  }
}

/* ------------------------------------------------------------ 库的整理 */

/**
 * 精简：把「同一件事的两种写法」收干净，顺手削掉过长的说明。
 * 这里只做**不用判断**的机械活——删重复、去同名字、按名字收敛别名。
 * 需要语义判断的合并永远走 merge + 模型复判那条路，不在这里偷偷做。
 */
function simplifyBrain(brain) {
  const el = brain.elements ?? {}
  const canonSet = new Set(Object.keys(el))
  const idx = new Map()
  for (const [canon, meta] of Object.entries(el)) {
    for (const alias of meta.aliases ?? []) idx.set(alias, canon)
  }

  let merged = 0
  let trimmedAliases = 0
  let shortenedWhy = 0

  // 1) 一个元素的名字正好是另一个元素的别名 → 它是同一个东西，并掉。
  for (const name of [...Object.keys(el)]) {
    if (el[name] === undefined) continue
    if (el[name].lock === 'user') continue
    const target = idx.get(name)
    if (target === undefined || target === name) continue
    if (el[target] === undefined) continue
    for (const [obj, edges] of Object.entries(brain.edges ?? {})) {
      const meta = edges[name]
      if (meta === undefined) continue
      if (edges[target] === undefined) edges[target] = { ...meta }
      else if (edges[target].w < meta.w) edges[target] = { ...meta }
      delete edges[name]
      if (obj === '') continue
    }
    const aliases = new Set(el[target].aliases ?? [])
    aliases.add(name)
    el[target].aliases = [...aliases]
    delete el[name]
    merged += 1
  }

  // 2) 别名里去掉同名、去重、去掉其实是另一个正名的词。
  for (const [name, meta] of Object.entries(el)) {
    const before = meta.aliases ?? []
    const after = [...new Set(before)].filter(
      (a) => a !== name && typeof a === 'string' && a.trim() !== '' && !(canonSet.has(a) && a !== name),
    )
    if (after.length !== before.length) {
      trimmedAliases += before.length - after.length
      meta.aliases = after
    }
  }

  // 3) 每一条边的说明压在 40 字以内，报告里读起来才不费劲。
  for (const edges of Object.values(brain.edges ?? {})) {
    for (const meta of Object.values(edges)) {
      if (typeof meta.why === 'string' && meta.why.length > 40) {
        meta.why = `${meta.why.slice(0, 40)}…`
        shortenedWhy += 1
      }
    }
  }

  return { merged, trimmedAliases, shortenedWhy }
}

/**
 * 猜想：靠"同类相似物体"推出来——A 和 B 大部分元素一样，而 B 有某元素 A 没有，
 * 就猜 A 可能也有。**这一步不花模型**，而且产物不进库，只进问题队列，
 * 等用户点头才转正。猜错的代价必须被关在"一条待确认的问题"里。
 */
function proposeHypotheses(brain, { limit = 5, minShared = 4, minRatio = 0.5 } = {}) {
  const edges = brain.edges ?? {}
  const objects = Object.keys(edges)
  const out = []
  for (let i = 0; i < objects.length; i += 1) {
    for (let j = i + 1; j < objects.length; j += 1) {
      const a = objects[i]
      const b = objects[j]
      const ea = edges[a] ?? {}
      const eb = edges[b] ?? {}
      const ka = Object.keys(ea)
      const kb = Object.keys(eb)
      if (ka.length < 3 || kb.length < 3) continue
      const shared = ka.filter((k) => eb[k] !== undefined)
      if (shared.length < minShared) continue
      const ratio = shared.length / Math.min(ka.length, kb.length)
      if (ratio < minRatio) continue

      // 只从"稳"的元素里挑：类别/形状/颜色这种，猜错也不至于污染强判断。
      const missingA = kb.filter((k) => ea[k] === undefined && eb[k].w >= 0.7)
      const missingB = ka.filter((k) => eb[k] === undefined && ea[k].w >= 0.7)
      for (const [from, to, elem] of [...missingA.map((e) => [b, a, e]), ...missingB.map((e) => [a, b, e])]) {
        out.push({
          object: to,
          element: elem,
          why: `「${from}」和它是同类（${shared.length} 个共同元素），「${from}」有「${elem}」而它没有`,
        })
      }
      if (out.length >= limit * 4) break
    }
    if (out.length >= limit * 4) break
  }
  return out.slice(0, limit)
}

/* ------------------------------------------------------------ 待问的问题 */

function questionsPath() {
  return join(dshHome(), 'memory', 'questions.json')
}

async function loadQuestions() {
  const data = await readJson(questionsPath(), null)
  if (data === null || typeof data !== 'object') return { items: [] }
  data.items ??= []
  return data
}

/** 和元素记忆库共用同一个问题队列：谁开口问不重要，"问了没答"得只记一份。 */
function enqueueQuestion(data, { kind, about, payload }) {
  const dup = data.items.find((q) => q.answeredAt === null && q.kind === kind && q.about === about)
  if (dup !== undefined) return dup
  const item = {
    id: `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    kind,
    about,
    payload: payload ?? {},
    createdAt: new Date().toISOString(),
    askedAt: null,
    answeredAt: null,
    answer: null,
  }
  data.items.push(item)
  return item
}

/* -------------------------------------------------------------- 候选发现 */

function levenshtein(a, b) {
  if (a === b) return 0
  const m = a.length
  const n = b.length
  if (m === 0 || n === 0) return Math.max(m, n)
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i += 1) {
    const cur = [i]
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

/**
 * 纯规则先筛一遍候选同义词对——不花模型。
 * 两条规则都只在**同一类别**里比，因为跨类别的词基本不可能是同义词
 * （「红色」和「圆形的」长得不像，也不该合并）。
 */
function stripSuffix(s) { return String(s).replace(/[的地]\s*$/, '') }

function mergeCandidates(brain, rejected = []) {
  const elems = Object.keys(brain.elements ?? {})
  const kindOf = (n) => brain.elements[n]?.kind ?? '未分类'
  const rejectedSet = new Set(rejected.map(([a, b]) => [a, b].sort().join('\u0000')))
  const out = []
  for (let i = 0; i < elems.length; i += 1) {
    for (let j = i + 1; j < elems.length; j += 1) {
      const a = elems[i]
      const b = elems[j]
      if (kindOf(a) !== kindOf(b)) continue
      // 用户亲手定过名字的词不进候选：「红色」和「橙红色」是两种颜色，
      // 长得像不代表是一回事，这种判断权本来就该在人手里。
      if (brain.elements[a]?.lock === 'user' || brain.elements[b]?.lock === 'user') continue
      const key = [a, b].sort().join('\u0000')
      if (rejectedSet.has(key)) continue
      let reason = null
      // 汉字两个字里换一个字就是另一个词：红色/蓝色、动物/植物、圆形/弧形 编辑距离都是 1。
      // 曾经用 levenshtein<=1 抓错别字，结果 88 组候选里 66 组是把所有颜色两两配对——
      // 这种误合并会把「红色」直接吞进「蓝色」，代价远大于漏掉一个错别字，所以不用了。
      // 只保留确定的：去后缀后完全一样，或一个包含另一个（后者交模型复判）。
      if (stripSuffix(a) === stripSuffix(b)) reason = 'equal'
      else if (a.includes(b) || b.includes(a)) reason = 'substring'
      if (reason !== null) {
        out.push({ group: [a, b], canonical: pickCanonical(a, b), reason, kind: kindOf(a) })
      }
    }
  }
  return out
}

/**
 * 合并后保留哪个词。
 * 「可折叠」比「折叠」信息多，所以默认留长的；但「圆形的」只是「圆形」的口语形，
 * 留"…的"很难看，所以先去掉后缀比一次，一样就留不带后缀的那个。
 */
function pickCanonical(a, b) {
  const sa = stripSuffix(a)
  const sb = stripSuffix(b)
  if (sa === sb) return sa.length <= a.length ? sa : a
  return a.length >= b.length ? a : b
}


const locked = (meta, cfg) => meta?.lock === 'user' && !cfg.protect.allowTouchLocked

/* ---------------------------------------------------------------- 合并应用 */

/**
 * 把一个同义词组并进规范名。
 * 返回 {moved, skipped}：moved 是搬动的边数，skipped 是因为锁定没动的。
 */
function applyMerge(brain, { group, canonical, reason }) {
  const elems = brain.elements
  const edges = brain.edges ?? {}
  let moved = 0
  let skipped = 0

  for (const name of group) {
    if (name === canonical) continue
    const meta = elems[name]
    if (meta?.lock === 'user') {
      skipped += 1
      continue
    }
    for (const [, bucket] of Object.entries(edges)) {
      const e = bucket[name]
      if (e === undefined) continue
      if (e.lock === 'user') {
        skipped += 1
        continue
      }
      const cur = bucket[canonical]
      if (cur === undefined || cur.w < e.w) {
        bucket[canonical] = { ...e, why: e.why ?? `并入 ${canonical}（${reason}）` }
      }
      delete bucket[name]
      moved += 1
    }
    // 真名收成别名，以后用户再说旧词也能对上
    const target = elems[canonical] ?? (elems[canonical] = { kind: elems[name]?.kind ?? '未分类', aliases: [] })
    target.aliases = [...new Set([...(target.aliases ?? []), name, ...(elems[name]?.aliases ?? [])])]
    delete elems[name]
  }
  elems[canonical]?.aliases && (elems[canonical].aliases = elems[canonical].aliases.filter((x) => x !== canonical))
  return { moved, skipped }
}

/** 剪枝 + 压缩：删弱边、砍 seen 历史。锁定的一律不碰。 */
function compactBrain(brain, cfg) {
  const removed = []
  const edges = brain.edges ?? {}
  for (const [obj, bucket] of Object.entries(edges)) {
    for (const [elem, e] of Object.entries(bucket)) {
      if (locked(e, cfg)) continue
      const weak = (e.w ?? 0) < 0.35 && (e.n ?? 1) <= 1 && e.how !== '观察'
      if (weak) {
        removed.push(`${obj}→${elem}(w=${e.w ?? '?'})`)
        delete bucket[elem]
      }
    }
  }
  let trimmed = 0
  for (const rec of Object.values(brain.objects ?? {})) {
    if (Array.isArray(rec.seen) && rec.seen.length > 20) {
      trimmed += rec.seen.length - 20
      rec.seen = rec.seen.slice(-20)
    }
  }
  return { removed, trimmed }
}

/* -------------------------------------------------------------- 一次睡眠 */

async function runDream(cfg, { dryRun = false, force = false } = {}) {
  await ensureDirs()
  const report = { at: new Date().toISOString(), dryRun, idle: null, before: null, after: null, merges: [], pruned: [], notes: [] }

  if (!force) {
    const idleSec = await systemIdleSeconds()
    report.idle = idleSec
    if (idleSec === null) {
      report.notes.push('读不到系统空闲时间，按"不空闲"处理（宁可少睡，也不偷偷跑满 CPU）')
      return report
    }
    if (idleSec < cfg.idle.systemIdleMinutes * 60) {
      report.notes.push(`键鼠才空闲 ${Math.round(idleSec / 60)} 分钟，没到 ${cfg.idle.systemIdleMinutes} 分钟，先不睡`)
      return report
    }
    if (!inWindow(cfg.idle.window)) {
      report.notes.push('现在不在允许的时段里，先不睡')
      return report
    }
    const state = await readJson(statePath(), {})
    if (typeof state.lastRunAt === 'string') {
      const gap = (Date.now() - Date.parse(state.lastRunAt)) / 60000
      if (Number.isFinite(gap) && gap < cfg.idle.minGapMinutes) {
        report.notes.push(`距上次整理才 ${Math.round(gap)} 分钟（最小间隔 ${cfg.idle.minGapMinutes}），先不睡`)
        return report
      }
    }
  }

  if (!existsSync(brainPath())) {
    report.notes.push(`没有脑库：${brainPath()}`)
    return report
  }

  const brain = await readJson(brainPath(), null)
  if (brain === null) {
    report.notes.push('脑库读不出来（不是合法 JSON）')
    return report
  }

  report.before = {
    objects: Object.keys(brain.objects ?? {}).length,
    elements: Object.keys(brain.elements ?? {}).length,
    edges: Object.values(brain.edges ?? {}).reduce((s, b) => s + Object.keys(b).length, 0),
  }

  let candidateGroups = mergeCandidates(brain, cfg.protect.rejectedPairs)
  const elementsBefore = report.before.elements

  // 候选分两类，命运不一样：
  //   equal    —— 去掉「的/地」后完全一样（圆形的 / 圆形），这是写法差异，规则说了算；
  //   substring —— 一个包含另一个（工具 / 交通工具），必须模型确认。
  // 汉字两个字里换一个字就是另一个词，规则看不出「红色」和「蓝色」根本不是一回事；
  // 曾经在一次模型输出解析失败时退回"纯规则合并"，一口气把 12 种颜色吞成 1 个，靠备份才救回来。
  // 所以现在的铁律是：**模型没点头，就不许合并"长得像"的候选**，宁可这次白睡一觉。
  const exact = candidateGroups.filter((g) => g.reason === 'equal')
  let needJudgement = candidateGroups.filter((g) => g.reason !== 'equal')

  if (needJudgement.length > 0 && cfg.tasks.merge) {
    let confirmed = []
    if (cfg.models.mode === 'off') {
      report.notes.push(`有 ${needJudgement.length} 组"长得像"的候选，但模型关着 → 一条都不合并`)
    } else if (cfg.models.mode === 'local' && (await ensureLocalModel(cfg)) !== true) {
      // ollama 没开着，自动拉起也没成功。这时候最糟的做法是退回纯规则合并。
      report.notes.push(`本地模型连不上（${cfg.models.local.baseUrl}），自动拉起也没起来 → 这次不合并任何"长得像"的候选`)
    } else {
      const sys = '你是汉语词汇整理助手。只输出 JSON，不要解释。'
      const user = [
        '下面是从一个物体元素库里找出来的「可能同义」的元素对，都来自同一类别。',
        '请判断每一对是不是**真的同一个概念**（可以合并）。',
        '只有确实同义才合并。反例：',
        '  「红色」和「橙红色」是两种颜色 → 不合并',
        '  「工具」和「交通工具」是两类东西 → 不合并',
        '  「圆形」和「椭圆形」是两种形状 → 不合并',
        '  「折叠」和「可折叠」说的是同一件事 → 合并',
        '拿不准的时候一律不要合并。',
        '',
        ...needJudgement.map((g, i) => `${i + 1}. [${g.kind}] ${g.group.join(' / ')}`),
        '',
        '输出 JSON：{"same": [{"index": 1, "canonical": "合并后保留哪个词"}]}',
        '要求：index 用上面的编号；canonical **必须是这一对里的原词**，从两个词里挑一个，不许自创别处的词。',
      ].join('\n')
      try {
        const text = await chat(cfg, { system: sys, user, maxTokens: 600 })
        const parsed = parseJsonLoose(text)
        if (parsed && Array.isArray(parsed.same)) {
          const keep = new Map(parsed.same.map((s) => [Number(s.index) - 1, String(s.canonical ?? '')]))
          let rejectedByCheck = 0
          confirmed = needJudgement
            .map((g, i) => {
              if (!keep.has(i)) return null
              const said = keep.get(i)
              // 模型必须从这一对里挑一个词当规范名。它要是回了个别的词
              // （实测 4B 把「交通工具/工具」判成「圆形」），那不是判断，是幻觉，直接丢掉。
              if (!g.group.includes(said)) {
                rejectedByCheck += 1
                return null
              }
              return { ...g, canonical: said, by: 'model' }
            })
            .filter(Boolean)
          report.notes.push(`模型复判：${needJudgement.length} 组候选里确认 ${confirmed.length} 组`)
          if (rejectedByCheck > 0) report.notes.push(`其中 ${rejectedByCheck} 组模型给的规范名不在这对词里（幻觉），已丢弃`)
        } else {
          report.notes.push('模型输出不是合法 JSON → 这次不合并任何"长得像"的候选（安全优先）')
        }
      } catch (err) {
        report.notes.push(`模型调用失败（${err.message}）→ 这次不合并任何"长得像"的候选`)
      }
    }
    needJudgement = confirmed
  }

  candidateGroups = [...exact, ...needJudgement]

  // 硬闸：一次睡醒最多合并全库 15% 的元素。越过这条线说明规则跑飞了，
  // 与其"合并成功"，不如停下来说一声。
  const cap = Math.max(3, Math.floor(elementsBefore * 0.15))
  if (candidateGroups.length > cap) {
    report.notes.push(`候选 ${candidateGroups.length} 组超过安全上限 ${cap} 组（全库 ${elementsBefore} 元素的 15%）→ 这次一组都不合并`)
    candidateGroups = []
  }

  for (const g of candidateGroups) {
    const before = Object.values(brain.edges ?? {}).reduce((s, b) => s + (b[g.group[0]] !== undefined ? 1 : 0) + (b[g.group[1]] !== undefined ? 1 : 0), 0)
    if (!dryRun) {
      const r = applyMerge(brain, g)
      report.merges.push({ ...g, moved: r.moved, skipped: r.skipped })
    } else {
      report.merges.push({ ...g, moved: before, skipped: 0, planned: true })
    }
  }

  if (cfg.tasks.compact) {
    if (dryRun) {
      const probe = structuredClone(brain)
      report.pruned = compactBrain(probe, cfg).removed
    } else {
      const r = compactBrain(brain, cfg)
      report.pruned = r.removed
      report.trimmedSeen = r.trimmed
    }
  } else {
    report.pruned = []
  }

  if (cfg.tasks.simplify) {
    // 精简只做机械活：并掉"名字正好是别人别名"的重复元素、削别名、压长说明。
    const target = dryRun ? structuredClone(brain) : brain
    report.simplified = simplifyBrain(target)
  } else {
    report.simplified = { merged: 0, trimmedAliases: 0, shortenedWhy: 0, skipped: true }
  }

  if (cfg.tasks.hypothesize) {
    // 猜想的产物**不进库**，只进提问队列，等用户点头才转正。
    const limit = Math.max(1, Math.min(20, cfg.hypothesize?.maxPerNight ?? 5))
    const proposals = proposeHypotheses(brain, { limit })
    report.hypotheses = proposals.map((p) => p.object + ' ← ' + p.element)
    if (dryRun) {
      report.queued = 0
    } else {
      const qs = await loadQuestions()
      let queued = 0
      for (const p of proposals) {
        if (enqueueQuestion(qs, { kind: 'hypothesis', about: `${p.object}←${p.element}`, payload: p }).answeredAt === null) queued += 1
      }
      await writeJsonAtomic(questionsPath(), qs)
      report.queued = queued
    }
  } else {
    report.hypotheses = []
  }

  report.after = {
    objects: Object.keys(brain.objects ?? {}).length,
    elements: Object.keys(brain.elements ?? {}).length,
    edges: Object.values(brain.edges ?? {}).reduce((s, b) => s + Object.keys(b).length, 0),
  }


  if (!dryRun) {
    // 备份在最前面做不了（要知道库是什么样），所以放在"确认真的要写"这一步
    const bak = join(backupsDir(), `brain.${stamp()}.json`)
    await copyFile(brainPath(), bak)
    report.backup = bak
    await writeJsonAtomic(brainPath(), brain)
    const pruned = (await readdir(backupsDir())).sort()
    for (const old of pruned.slice(0, Math.max(0, pruned.length - cfg.backup.keep))) {
      await rm(join(backupsDir(), old), { force: true })
    }
  }

  const reportName = `dream-${stamp()}.json`
  await writeJsonAtomic(join(dreamsDir(), reportName), report)

  // 只有真睡过才记账。试跑不算一次，否则调一次 dryRun 就把最小间隔也重置了。
  if (!dryRun) {
    const prev = await readJson(statePath(), {})
    await writeJsonAtomic(statePath(), {
      ...prev,
      lastRunAt: report.at,
      lastReport: reportName,
      lastNotes: report.notes.slice(-8),
      lastMerges: report.merges.length,
      lastPruned: report.pruned.length,
      lastSimplified: report.simplified,
      lastQueued: report.queued ?? 0,
    })
  }

  // 整理完了才做梦：梦是加餐，主机任务失败时不该跑到这儿来
  if (!dryRun) {
    try {
      await dreamAfterSleep(cfg, report, { force })
      // 没做成的理由也写进报告——不然用户只会看到"这次没有梦"，不知道为什么
      if (report.dream?.skipped) report.notes.push(`没做梦：${report.dream.skipped}`)
      // 梦的结果也算这次睡醒的一部分，报告要重新落一次
      await writeJsonAtomic(join(dreamsDir(), reportName), report)
      const st = await readJson(statePath(), {})
      await writeJsonAtomic(statePath(), {
        ...st,
        lastDream: report.dream?.status ?? '',
        lastDreamText: report.dream?.text ?? '',
      })
    } catch (e) {
      report.dream = { attempted: true, status: 'error', reason: String(e?.message ?? e) }
      report.notes.push(`做梦这步出错（不影响整理）：${e?.message ?? e}`)
    }
  }

  return report
}

/* ---------------------------------------------------------------- 编排 */

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: { text: { type: 'string' } },
  },
  render(_args, value) {
    return [{ type: 'text', text: value.text }]
  },
}

export const inject = ['tools']

/**
 * 设置页用的小接口。浏览器那半边碰不到宿主文件，所以给它开两条路由：
 * GET 读当前配置，POST 存回去。挂在 /deepsleep-api 前缀下，只回 JSON。
 *
 * 为什么用 handler 而不是 resource：webServer 的 resource 路由是**只读**的，
 * 非 GET/HEAD 一律在匹配之前就被拒成 405（"Allow: GET, HEAD"）。要收 POST
 * 就必须自己接管 IncomingMessage / ServerResponse。
 */
function apiRoutes(ctx, disposers) {
  const web = ctx.get('webServer')
  if (web === undefined) return

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 1 << 20) {
          reject(new Error('请求体太大（超过 1 MB）'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })

  disposers.push(web.register({
    kind: 'prefix',
    path: '/deepsleep-api',
    async handler(req, res) {
      const send = (status, value) => {
        const body = JSON.stringify(value)
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(body),
          'allow': 'GET, POST',
        })
        res.end(body)
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      try {
        if (url.pathname === '/deepsleep-api/config' && (req.method === 'GET' || req.method === 'HEAD')) {
          await ensureDirs()
          const config = await loadConfig()
          const usage = await readJson(usagePath(), {})
          const state = await readJson(statePath(), {})
          let idleSec = null
          try {
            idleSec = await systemIdleSeconds(3000)
          } catch {
            idleSec = null
          }
          send(200, { ok: true, config, defaults: DEFAULTS, usage, state, idleSec, deps: await probeDeps(config), brain: brainPath() })
          return
        }
        if (url.pathname === '/deepsleep-api/dreams' && (req.method === 'GET' || req.method === 'HEAD')) {
          await ensureDirs()
          const config = await loadConfig()
          // 梦的存档在另一处（由做梦脚本写），读不到就当还没做过梦——
          // 设置页不该因为另一个东西没跑过就整页报错。
          const store = await readJson(dreamStorePath(), { dreams: [], discarded: 0 })
          const list = Array.isArray(store?.dreams) ? store.dreams.slice(0, 8) : []
          send(200, {
            ok: true,
            dream: config.dream ?? DEFAULTS.dream,
            list: list.map((d) => ({
              date: String(d?.date ?? ''),
              text: String(d?.text ?? ''),
              chars: Number(d?.chars ?? 0),
              score: d?.score ?? null,
            })),
            stats: {
              total: Array.isArray(store?.dreams) ? store.dreams.length : 0,
              discarded: Number(store?.discarded ?? 0),
            },
            deps: await probeDeps(config),
            path: dreamStorePath(),
          })
          return
        }
        if (url.pathname === '/deepsleep-api/config' && req.method === 'POST') {
          const raw = await readBody(req)
          let body = null
          try {
            body = JSON.parse(raw)
          } catch {
            send(400, { ok: false, error: '请求体不是合法 JSON' })
            return
          }
          if (!isPlainObject(body)) {
            send(400, { ok: false, error: '请求体要是 JSON 对象' })
            return
          }
          await ensureDirs()
          const cur = await loadConfig()
          const next = body.reset === true ? structuredClone(DEFAULTS) : deepMerge(cur, body.patch ?? {})
          await writeJsonAtomic(configPath(), next)
          send(200, { ok: true, config: next })
          return
        }
        send(404, { ok: false, error: '没有这个接口' })
      } catch (err) {
        send(500, { ok: false, error: String(err?.message ?? err) })
      }
    },
  }))
}

export function apply(ctx) {
  const disposers = []

  // webServer 不是 apply 一上来就有的：宿主先起 webServer，插件才轮到加载，
  // 而这个先后顺序并不保证。直接 ctx.get('webServer') 会拿到 undefined，
  // 路由就静默地没挂上（浏览器那边表现为接口 404、设置页显示"读不到"）。
  // 所以用 ctx.inject 等服务就绪后再挂，并把卸载交给 effect 跟着 fiber 走。
  const mountApi = (hostCtx) => {
    hostCtx.effect(() => {
      const local = []
      try {
        apiRoutes(hostCtx, local)
      } catch (err) {
        console.warn(`[deepsleep] 设置接口没挂上：${err?.message ?? err}`)
      }
      return () => {
        for (const dispose of local.splice(0)) {
          try {
            dispose()
          } catch {
            /* 卸载失败不该影响别的插件 */
          }
        }
      }
    })
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], mountApi)
  } else {
    mountApi(ctx)
  }

  // 空闲轮询：这才是"DSH 空闲时它自己整理"的那根线。没有它，插件只能被手动叫醒。
  // 用 ctx.effect 收尾，插件被卸载/重载时定时器跟着停，不会留一个野定时器继续跑。
  ctx.effect(() => {
    const stop = startIdleLoop(
      () => loadConfig(),
      (err) => console.warn(`[deepsleep] 空闲轮询出错：${err?.message ?? err}`),
    )
    return stop
  })

  const asText = (text) => ({ text })

  disposers.push(ctx.tools.register({
    name: 'deepsleep_config',
    output: OUTPUT,
    description: '查看或修改 DeepSleep 的设置（空闲阈值、用哪个模型、付费预算、允许它动哪些内容）。不传 patch 就是查看。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        patch: { type: 'object', description: '要改的部分，会深合并进去，例如 {"idle":{"systemIdleMinutes":10}}' },
        reset: { type: 'boolean', description: 'true = 恢复默认设置' },
      },
    },
    async execute(args) {
      await ensureDirs()
      if (args.reset === true) {
        await writeJsonAtomic(configPath(), DEFAULTS)
        return asText(`设置已恢复默认。\n${configPath()}`)
      }
      if (isPlainObject(args.patch)) {
        const cur = await loadConfig()
        const next = deepMerge(cur, args.patch)
        await writeJsonAtomic(configPath(), next)
        return asText(`设置已更新：\n${JSON.stringify(next, null, 2)}`)
      }
      const cur = await loadConfig()
      return asText(`当前设置（${configPath()}）：\n${JSON.stringify(cur, null, 2)}`)
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'deepsleep_status',
    output: OUTPUT,
    description: '它现在什么状态：键鼠空闲多久、模型通不通、今天花了多少、上一次睡得怎么样。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute() {
      await ensureDirs()
      const cfg = await loadConfig()
      const idle = await systemIdleSeconds()
      const brain = await readJson(brainPath(), null)
      const usage = await readJson(usagePath(), null)
      const dreams = existsSync(dreamsDir()) ? (await readdir(dreamsDir())).sort() : []

      const lines = []
      const st = await readJson(statePath(), {})
      lines.push(
        `自动睡：${cfg.idle.enabled === true ? `开着，每 ${cfg.idle.checkIntervalMinutes} 分钟探一次` : '关着（只能手动叫醒）'}`,
      )
      lines.push(`空闲：${idle === null ? '读不到' : `${Math.round(idle / 60)} 分钟`}（阈值 ${cfg.idle.systemIdleMinutes} 分钟）`)
      if (typeof st.lastRunAt === 'string') {
        const gap = (Date.now() - Date.parse(st.lastRunAt)) / 60000
        const ok = Number.isFinite(gap) && gap >= cfg.idle.minGapMinutes
        lines.push(`距上次整理：${Number.isFinite(gap) ? Math.round(gap) : '?'} 分钟${ok ? '（已过最小间隔）' : `（最小间隔 ${cfg.idle.minGapMinutes}）`}`)
      } else {
        lines.push('还没自动整理过')
      }
      if (!inWindow(cfg.idle.window)) lines.push('当前不在允许的时段里')
      lines.push(`模型：${cfg.models.mode === 'local' ? `本地 ${cfg.models.local.model}` : cfg.models.mode === 'paid' ? `付费 ${cfg.models.paid.model}（预算 ${cfg.models.paid.budgetPerNightCny} 元/天）` : '关闭'}`)
      if (cfg.models.mode === 'local') {
        const up = await localReachable(cfg.models.local.baseUrl)
        lines.push(`本地服务：${up ? '通' : `连不上（${cfg.models.local.baseUrl}）${cfg.models.local.autoStart === true ? '，下次会自己试着拉起' : ''}`}`)
      }
      if (usage !== null) lines.push(`今日花费：¥${(usage.cny ?? 0).toFixed(4)}，调模型 ${usage.calls ?? 0} 次`)

      if (brain !== null) {
        const edges = Object.values(brain.edges ?? {}).reduce((s, b) => s + Object.keys(b).length, 0)
        lines.push(`脑库：${Object.keys(brain.objects ?? {}).length} 物体 / ${Object.keys(brain.elements ?? {}).length} 元素 / ${edges} 边`)
      }
      lines.push(`睡过 ${dreams.length} 次${dreams.length > 0 ? `，最近一次 ${dreams.at(-1)}` : ''}`)
      const cands = brain === null ? [] : mergeCandidates(brain, cfg.protect.rejectedPairs)
      lines.push(`规则找到 ${cands.length} 组候选同义词`)
      return asText(lines.join('\n'))
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'deepsleep_run',
    output: OUTPUT,
    description: '现在就叫它睡一次（整理记忆库）。dryRun=true 只出报告不改库。默认会先检查键鼠有没有空闲，force=true 跳过检查。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dryRun: { type: 'boolean', description: 'true = 只看它打算做什么，一个字都不改' },
        force: { type: 'boolean', description: 'true = 不管键鼠闲不闲，现在就干' },
      },
    },
    async execute(args) {
      const cfg = await loadConfig()
      const report = await runDream(cfg, { dryRun: args.dryRun === true, force: args.force === true })
      const lines = [`${report.dryRun ? '【试跑】' : '【已执行】'} ${report.at}`]
      if (report.notes.length > 0) lines.push(...report.notes.map((n) => `· ${n}`))
      if (report.before) {
        const b = report.before
        const a = report.after ?? b
        lines.push(`库：${b.objects}物体/${b.elements}元素/${b.edges}边 → ${a.objects}物体/${a.elements}元素/${a.edges}边`)
      }
      if (report.merges.length > 0) {
        lines.push(`合并 ${report.merges.length} 组：`)
        for (const m of report.merges) {
          lines.push(`  ${m.group.join(' + ')} → ${m.canonical}（${m.reason}${m.by === 'model' ? '，模型确认' : ''}${m.skipped > 0 ? `，跳过 ${m.skipped} 条锁定的` : ''}）`)
        }
      } else {
        lines.push('没有可合并的同义词')
      }
      if (report.pruned.length > 0) lines.push(`剪掉 ${report.pruned.length} 条弱边：${report.pruned.slice(0, 8).join('，')}${report.pruned.length > 8 ? '…' : ''}`)

      const s = report.simplified
      if (s !== undefined && s.skipped !== true) {
        const parts = []
        if (s.merged > 0) parts.push(`并掉 ${s.merged} 个重复元素`)
        if (s.trimmedAliases > 0) parts.push(`削掉 ${s.trimmedAliases} 个多余别名`)
        if (s.shortenedWhy > 0) parts.push(`压短 ${s.shortenedWhy} 条说明`)
        lines.push(parts.length > 0 ? `精简：${parts.join('，')}` : '精简：没有需要收拾的')
      }

      if (report.hypotheses !== undefined) {
        if (report.hypotheses.length === 0) {
          lines.push('猜想：这一觉没做出新的猜测')
        } else {
          lines.push(`猜想 ${report.hypotheses.length} 条（${report.dryRun ? '试跑，没写进提问队列' : '已写进提问队列等你确认'}）：`)
          for (const h of report.hypotheses) lines.push(`  ？ ${h}`)
        }
      }

      if (report.backup) lines.push(`备份：${report.backup}`)
      return asText(lines.join('\n'))
    },
  }))

  return () => {
    for (const d of disposers) d?.()
  }
}

/* 给离线测试用 */
export const __test = {
  mergeCandidates,
  applyMerge,
  compactBrain,
  simplifyBrain,
  proposeHypotheses,
  runDream,
  deepMerge,
  DEFAULTS,
}

