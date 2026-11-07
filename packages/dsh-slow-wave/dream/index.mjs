/**
 * dream/index.mjs —— 做一场梦（库版本）
 *
 * 和 `dreamer.mjs` 是同一件事，区别只在"谁叫它"：
 *   dreamer.mjs  是命令行，自己读参数、自己 exit，给开发和测试用；
 *   这里          是函数，返回结构，给慢波整理在睡下之后调用。
 *
 * 三个角色仍然分开，谁也不替谁做决定：
 *   editor.js   挑材料、丢材料（凑不成故事就宣布"今夜无梦"）
 *   模型        只把选中的材料写成 3–6 句，不许解释、不许抒情、不许比喻
 *   judge.js    只判断"这还称不称得上一个梦"，不判断合不合理
 *
 * 因为"能不能成故事"本身就把关，所以**不需要做梦频率**：
 * 素材凑不成故事，今夜就没有梦。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fragments } from './weave.js'
import { cast, parseStory, renderMaterials, STORY_SYSTEM } from './editor.js'
import { judge, trim, oneLine, pickWake, joinLines } from './judge.js'
import { loadDepths, markDepthsUsed, readIncidents, readThings, sampleDepths, snapshotDepths, subjectPool } from './sources.mjs'

const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434/v1/chat/completions'
const DEFAULT_MODEL = 'qwen3:4b-instruct-2507-q4_K_M'

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function storePath() {
  return join(dshHome(), 'dream', 'dreams.json')
}

export function loadStore() {
  const p = storePath()
  if (!existsSync(p)) return { dreams: [], discarded: 0 }
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    return Array.isArray(j?.dreams) ? j : { dreams: [], discarded: Number(j?.discarded || 0) }
  } catch {
    return { dreams: [], discarded: 0 }
  }
}

function saveStore(store) {
  const p = storePath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  return p
}

function readEvents(root) {
  const file = join(root, 'events.jsonl')
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      out.push(JSON.parse(s))
    } catch {
      // 坏行跳过：不因为一条脏数据放弃整场梦
    }
  }
  return out
}

async function writeStory(materials, { endpoint, model, timeoutMs = 90000, hint = '' } = {}) {
  const block = String(materials || '')
  const user = hint
    ? `材料：\n${block}\n\n上一次写成这样，没通过：${hint}\n请重写：只讲一件事，后面几句必须接着前面那件事往下走。`
    : `材料：\n${block}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(endpoint || DEFAULT_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        temperature: 0.7,
        max_tokens: 300,
        options: { num_predict: 300 },
        stop: ['\n\n'],
        messages: [
          { role: 'system', content: STORY_SYSTEM },
          { role: 'user', content: user },
        ],
      }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = await res.json()
    const text = String(j?.choices?.[0]?.message?.content ?? '').trim()
    // 本地 4B 偶尔退化成一片 0（提示词里出现省略号时尤其容易），当成没写出来
    if (!text || /^[0\s]+$/.test(text)) throw new Error('模型输出退化了')
    return text
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 做一场梦。
 *
 * @param {object} opts
 * @param {string} opts.fishRoot   她的事件流目录（默认 ~/.dsh-fish）
 * @param {number} [opts.seed]
 * @param {boolean} [opts.useModel] 不调模型时只按选材顺序拼（会很难看，仅作兜底）
 * @param {string} [opts.endpoint] OpenAI 兼容地址（默认本地 ollama）
 * @param {string} [opts.model]
 * @param {string} [opts.who]      指定主角
 * @param {(s:string)=>void} [opts.log]
 * @returns {Promise<{status:'ok'|'none'|'discarded'|'empty', ...}>}
 */
export async function makeDream({
  fishRoot = join(homedir(), '.dsh-fish'),
  seed = Date.now() % 2147483647,
  useModel = true,
  endpoint = DEFAULT_ENDPOINT,
  model = DEFAULT_MODEL,
  who = '',
  log = () => {},
} = {}) {
  const events = readEvents(fishRoot)
  const near = fragments(events)
  const seed0 = Number(seed) || Date.now() % 2147483647

  // 第 6 类材料：先把"已经沉出她视野"的旧经历收进潜意识池（她遗忘之前截下来）
  const snap = snapshotDepths(near)
  const depths = loadDepths()
  const things = readThings()
  const subjects = subjectPool({ fishRoot }).map((s) => s.label)

  // 抽几条潜意识碎片掺进候选池（标 from:'deep'，编辑器认得）
  let a = (seed0 >>> 0) || 1
  const rand0 = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const deepPick = sampleDepths(depths, rand0, 4)
  const incidents = readIncidents()
  const pool = [
    ...incidents.map((x) => ({ text: x.text, from: 'incident', ts: 0 })),
    ...near.map((f) => ({ text: typeof f === 'string' ? f : f.text, from: 'now', ts: f?.ts })),
    ...deepPick.map((d) => ({ text: d.text, from: 'deep', ts: d.ts })),
  ].filter((x) => x.text)

  const stats = { incidents: incidents.length, near: near.length, depths: snap.total, things: things.length }

  if (pool.length < 3) return { status: 'empty', reason: `素材太少（${pool.length} 条）`, stats }

  let body = null
  let verdict = null
  let picked = null
  let pickedThings = []
  let noStory = null
  let lastReject = ''

  for (let attempt = 1; attempt <= 2 && !body; attempt += 1) {
    const s = seed0 + attempt * 104729
    const c = cast(pool, s, { things, who, subjects: subjects.length ? subjects : undefined })
    if (!c) {
      noStory = '能动的、会变的材料不够'
      continue
    }

    let raw = ''
    if (useModel) {
      try {
        raw = await writeStory(renderMaterials(c), { endpoint, model, hint: noStory ? lastReject : '' })
      } catch (e) {
        log(`本地模型没用上（${e.message}）`)
      }
    }

    const story = raw ? parseStory(raw) : { ok: true, lines: c.used.slice(0, 3) }
    if (!story.ok) {
      noStory = noStory || story.reason
      continue
    }

    // 不修剪比喻：用户定过「梦里可以比喻、也能抒情，都做梦了当然可以自由一点」。
    const trimmed = trim(joinLines(story.lines), { maxLines: 6, maxChars: 180 })
    const v = judge(trimmed, c.used)
    log(`第 ${attempt} 次：${v.ok ? '过审' : v.nostory ? '不成故事' : '不过审'}（${v.score}）${v.reasons.length ? ' · ' + v.reasons.join('；') : ''}`)

    if (v.ok) {
      body = { text: trimmed }
      verdict = v
      picked = c
      pickedThings = Array.isArray(story.things) ? story.things : []
    } else if (v.nostory) {
      noStory = v.reasons[v.reasons.length - 1]
      lastReject = `${joinLines(story.lines)}（${v.reasons[v.reasons.length - 1]}）`
    } else {
      verdict = v
    }
  }

  if (!body) {
    if (noStory || !verdict) {
      // 没有能编成故事的材料——不是失败，只是今夜没有梦。不计数、不存档。
      return { status: 'none', reason: noStory || '素材凑不成一个故事', stats }
    }
    // 有材料但写坏了：忘掉，只记个数，一个字都不留（留着才占她的寿命）
    const store0 = loadStore()
    store0.discarded = Number(store0.discarded || 0) + 1
    saveStore(store0)
    return { status: 'discarded', reason: verdict.reasons.join('；') || '不合格', discarded: store0.discarded, stats }
  }

  const today = new Date().toISOString().slice(0, 10)
  const dream = {
    date: today,
    at: new Date().toISOString(),
    seed: seed0,
    materials: picked.used.length,
    lines: verdict.lines.length,
    chars: body.text.length,
    score: verdict.score,
    text: body.text,
    model: useModel ? model : 'none',
  }

  const store = loadStore()
  store.dreams = store.dreams.filter((d) => d.date !== today)
  store.dreams.unshift(dream)
  store.dreams = store.dreams.slice(0, 120)
  const saved = saveStore(store)

  // 用过的潜意识碎片记一笔，下次让位给别的旧账
  markDepthsUsed(depths, [picked.depth?.text].filter(Boolean))

  const wakeLine = pickWake(dream.text, { things: pickedThings }) || oneLine(dream.text)

  return {
    status: 'ok',
    dream,
    wakeLine,
    groups: picked.groups,
    stats,
    path: saved,
  }
}

export { oneLine }
