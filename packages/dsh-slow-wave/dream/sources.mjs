/**
 * sources.mjs —— 另外两类材料的来源
 *
 * 编辑器原来只吃"她最近的经历"（五种故事材料里的处境/事情/变化都从那儿来）。
 * 但她的经历大半是对话残片，凑不出故事。所以再补两个来源：
 *
 *   常识素材  元素记忆库（$DSH_HOME/memory/brain.json）里的物体与元素 —— 当道具用
 *   潜意识    已经沉下去、她不再看见的旧经历 —— 梦本来就该翻旧账
 *
 * 关于"遗忘"：dsh-fish 的 events.jsonl 是**从不删**的（只增不减）。
 * 它忘的不是字节，是**注意力**——derive.js 按显著性排 beliefs，
 * 曾经固化但太久没被提起的会沉成 faded；经历也只在她视野里摆近期那一段。
 * 所以"在她遗忘之前截取"不等于抢救字节，而是抢救**视野**：
 * 把这些已经沉出视野的句子收进我们自己的池子，让她还能梦到。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function depthsPath() {
  return join(dshHome(), 'dream', 'subconscious.jsonl')
}

export function brainPath() {
  return join(dshHome(), 'memory', 'brain.json')
}

/**
 * 事件库（extract.mjs 的产出）：把"谁做了什么"读成材料。
 * 这是三类经历材料里最结实的一类——它不是对话残片，是事情本身。
 */
export function readIncidents() {
  const p = join(dshHome(), 'dream', 'incidents.json')
  if (!existsSync(p)) return []
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    const list = Array.isArray(j?.events) ? j.events : []
    return list
      .filter((e) => e && e.act)
      .map((e) => ({
        text: `${e.who && e.who !== '我' ? e.who : '我'}${e.act}`,
        day: Number(e.day) || 0,
        n: Number(e.n) || 1,
      }))
  } catch {
    return []
  }
}

/** 读元素记忆库。读不到就返回空数组——梦不能因为另一个插件不在就做不成。 */
export function readThings({ max = 40, minWeight = 0.7 } = {}) {
  const p = brainPath()
  if (!existsSync(p)) return []
  let brain
  try {
    brain = JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return []
  }
  const objects = brain?.objects ?? {}
  const edges = brain?.edges ?? {}
  const out = []
  for (const [name, row] of Object.entries(objects)) {
    const es = edges[name] ?? {}
    const top = Object.entries(es)
      .filter(([, v]) => Number(v?.w ?? 0) >= minWeight)
      .sort((a, b) => Number(b[1].w) - Number(a[1].w))
      .slice(0, 3)
      .map(([k]) => k)
    // 只收"有具体元素"的物体：空壳子当不了道具
    if (!top.length) continue
    out.push({
      name,
      elements: top,
      // 物体的"厚度"：全部元素条数，而不是上面那 3 个用来展示的。
      // 编辑器按它决定这个物件够不够格当梦的主角（狗 > 方块）。
      total: Object.keys(es).length,
      seen: Array.isArray(row?.seen) ? row.seen.length : 0,
      text: `${name}（${top.join('、')}）`,
    })
  }
  // 见得多、元素多的优先：那是她更熟的东西
  out.sort((a, b) => b.elements.length - a.elements.length || b.seen - a.seen)
  return out.slice(0, max)
}

/** 读已有的潜意识池。 */
export function loadDepths() {
  const p = depthsPath()
  if (!existsSync(p)) return []
  const out = []
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      out.push(JSON.parse(s))
    } catch {
      // 坏行跳过
    }
  }
  return out
}

/**
 * 把她已经沉出视野的旧经历收进潜意识池。
 *
 * @param {string[]} fragments 已过滤过的经历碎片
 * @param {object}   opts
 * @param {number}   opts.minAgeDays  多久算"沉下去"（默认 3 天）
 * @param {number}   opts.cap         池子上限（默认 4000 条）
 * @returns {{added:number,total:number,pool:object[]}}
 */
export function snapshotDepths(fragments, { minAgeDays = 3, cap = 4000, now = Date.now() } = {}) {
  const pool = loadDepths()
  const seen = new Set(pool.map((d) => d.text))
  const DAY = 86400000
  const fresh = []
  for (const f of fragments) {
    const text = typeof f === 'string' ? f : f?.text
    if (!text || seen.has(text)) continue
    const ts = Number(typeof f === 'object' ? f.ts : 0) || 0
    // 没有时间戳的一律收（宁可多，不要漏掉她的旧账）
    if (ts && now - ts < minAgeDays * DAY) continue
    seen.add(text)
    fresh.push({
      text,
      type: typeof f === 'object' ? String(f.type ?? '') : '',
      day: typeof f === 'object' ? Number(f.day) || 0 : 0,
      ts,
      takenAt: new Date(now).toISOString(),
      used: 0,
    })
  }

  if (!fresh.length) return { added: 0, total: pool.length, pool }

  const all = pool.concat(fresh)
  // 上限只切最旧、且只切从没用过的：用过的留着她还能再梦到
  let kept = all
  if (all.length > cap) {
    const over = all.length - cap
    const droppable = all
      .filter((d) => !Number(d.used || 0))
      .slice(0, over)
      .map((d) => d.text)
    const kill = new Set(droppable)
    kept = all.filter((d) => !kill.has(d.text))
  }

  const p = depthsPath()
  mkdirSync(dirname(p), { recursive: true })
  // 重写（要执行上限），不是追加
  writeFileSync(p, kept.map((d) => JSON.stringify(d)).join('\n') + (kept.length ? '\n' : ''), 'utf8')
  return { added: fresh.length, total: kept.length, pool: kept }
}

/** 按 seed 从潜意识池里抽几条。用得少的更容易被翻出来。 */
export function sampleDepths(pool, rand, n = 3) {
  if (!pool.length || n <= 0) return []
  const bag = pool.slice()
  const picked = []
  while (picked.length < n && bag.length) {
    const weights = bag.map((d) => 1 / (1 + Number(d.used || 0)))
    const total = weights.reduce((a, b) => a + b, 0)
    let r = rand() * total
    let i = 0
    while (i < bag.length - 1 && r > weights[i]) {
      r -= weights[i]
      i++
    }
    picked.push(bag[i])
    bag.splice(i, 1)
  }
  return picked
}

/**
 * 梦里的「谁」。
 *
 * 用户的要求：主角必须是她**认识的人**——她自己、用户、或者她在 B 站看到的人。
 * 不能是「一个陌生人」：陌生人不会出现在她的生活里，梦到陌生人是插件在替她编经历，
 * 而梦该只重组她真有过的东西。
 *
 * 人的名字从她自己的事件流里找，而不是写死：
 *   「我决定叫他「阿准」」    → 用户在她这儿有名字
 *   「UP主：xx」/「主播 xx」  → 她在 B 站见过的人
 * 一个都找不到，就退回「他」和「视频里的人」——这两个仍然指向她真的经历过的东西。
 */
export function subjectPool({ fishRoot = '' } = {}) {
  const root = fishRoot || join(homedir(), '.dsh-fish')
  let text = ''
  try {
    text = readFileSync(join(root, 'events.jsonl'), 'utf8')
  } catch {
    text = ''
  }

  const out = [{ label: '我', kind: 'self' }]
  const push = (label, kind) => {
    const s = String(label || '').trim()
    if (s.length < 1 || s.length > 8) return
    if (out.some((x) => x.label === s)) return
    out.push({ label: s, kind })
  }

  // 她给他起的称呼：叫他「阿准」/ 叫你「X」
  for (const m of text.matchAll(/叫[他她你]\s*[「『"]([^」』"]{1,8})[」』"]/g)) push(m[1], 'owner')
  // 她见过的 UP 主 / 主播
  for (const m of text.matchAll(/(?:UP主|主播|博主)\s*[：:]?\s*([\u4e00-\u9fa5A-Za-z0-9]{2,12})/g)) push(m[1], 'bili')

  if (!out.some((x) => x.kind === 'owner')) push('他', 'owner')
  if (!out.some((x) => x.kind === 'bili')) push('视频里的人', 'bili')

  return out
}

/** 把抽中的潜意识碎片记一次"用过"，下次让位给别的。 */
export function markDepthsUsed(pool, texts) {  const want = new Set(texts)
  if (!want.size) return
  let touched = false
  const next = pool.map((d) => {
    if (!want.has(d.text)) return d
    touched = true
    return { ...d, used: Number(d.used || 0) + 1 }
  })
  if (!touched) return
  const p = depthsPath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, next.map((d) => JSON.stringify(d)).join('\n') + '\n', 'utf8')
}

export const __test = { dshHome, depthsPath, brainPath }