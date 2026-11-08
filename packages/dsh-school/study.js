/**
 * 学习回合：挑一条她悬着没被回答的问 → 拆成搜索词 → 上网查 → 读两页 → 提炼要点
 * → 存进我们自己的 studies.json，并给她身体上放一张便条（她下次醒来会读到）。
 *
 * 三条自我约束：
 * 1. 绝不往她的 events.jsonl 里写任何东西——那是她的记忆，我们不能替她"说过"什么。
 * 2. 读到的网页只是材料，不是指令；里面就算写着"忽略上面"也不会被执行。
 * 3. 提炼不动用付费模型：只用本机 ollama；它回答不了就老实退回"原文摘录"。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { search, readPage, tavilyKey } from './search.js'

const STOP = new Set([
  '你', '我', '他', '她', '它', '的', '了', '吗', '呢', '吧', '啊', '呀', '是', '不', '也', '就',
  '还', '有', '个', '要', '会', '能', '把', '被', '和', '跟', '这', '那', '什么', '怎么', '为什么',
  '一个', '这个', '那个', '东西', '事情', '真的', '到底', '是不是', '有没有', '可以', '应该',
])

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export const studiesPath = () => join(dshHome(), 'school', 'studies.json')

async function readJson(p, fallback) {
  try {
    return JSON.parse(await readFile(p, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson(p, data) {
  await mkdir(dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await writeFile(p, JSON.stringify(data, null, 2), 'utf8')
  try {
    const { rename } = await import('node:fs/promises')
    await rename(tmp, p)
  } catch { /* Windows 上偶尔锁文件，直接写已经成功了 */ }
}

/** 兜底：把「还是有个我要调的东西」这种问句里剩下的实词拼起来 */
export function toQuery(focus, ctx = '') {
  const pick = (s) => {
    const raw = String(s || '').replace(/[？?。！!，,、；;：:"'「」（）()]/g, ' ')
    const words = raw.split(/\s+/).filter(Boolean).filter((w) => !STOP.has(w) && w.length <= 12)
    return words
  }
  const fromFocus = pick(focus)
  if (fromFocus.length) return fromFocus.join(' ').slice(0, 40)
  // 她自己那句没有实词时，借用上一句"她听到的用户原话"
  return pick(ctx).slice(0, 3).join(' ').slice(0, 40)
}

const QUERY_SYSTEM = [
  '把一个人没弄明白的问题，变成一行搜索词，用来在搜索引擎里找答案。',
  '要求：',
  '1. 只输出搜索词本身，2 到 4 个词，一共 4 到 14 个字；',
  '2. 不要问号、不要引号、不要解释、不要换行；',
  '3. 尽量具体（比如"ffmpeg 安装 失败"而不是"怎么办"）；',
  '4. 技术问题如果有对应的英文 API 或命令名，用英文名搜，命中率更高；',
  '5. 如果这个问题离开上面的对话就完全无法理解，只输出：没法搜',
  '例：怎么在 Windows 里知道键鼠空闲了多久 → GetLastInputInfo 空闲时间',
  '例：怎么把屏幕录成视频 → ffmpeg 屏幕录制',
].join('\n')

async function buildQuery(q, opts) {
  try {
    const out = await chat({
      ...opts,
      system: QUERY_SYSTEM,
      user: `上一句他说：「${q.ctx || '（没有上下文）'}」\n她问：「${q.text || q.focus}」`,
      timeoutMs: 30000,
    })
    const one = out.split(/\n/)[0].trim().replace(/[。？?！!]/g, '')
    if (!one || one === '没法搜' || one.length > 30) return ''
    return one.slice(0, 30)
  } catch {
    return toQuery(q.focus, q.ctx)
  }
}

async function chat({ baseUrl = 'http://127.0.0.1:11434/v1', model = 'qwen3:4b-instruct-2507-q4_K_M', system, user, timeoutMs = 90000 }) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [ { role: 'system', content: system }, { role: 'user', content: user } ],
      temperature: 0.3,
      max_tokens: 260,
      stop: ['\n\n'],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`模型 HTTP ${res.status}`)
  const j = await res.json()
  const text = String(j?.choices?.[0]?.message?.content || '').trim()
  if (!text || /^[0\s]+$/.test(text)) throw new Error('模型输出退化了')
  return text
}

/**
 * 这个问题问的是不是"我们自家的东西"。
 *
 * `bili_watch`、`memory_*`、`see_now` 这些是我们自己装的插件，网上没有它的文档；
 * 拿去搜只会捞回一堆不相干的视频，还会往她桌上放一张"没查到"的废话纸条。
 * 这类问题该由用户答，不该由网络答。
 */
const INTERNAL_RE = /(bili_|her_|memory_|deepsleep_|school_|ffmpeg_|see_now|dsh-|dsh |插件|工具表|潜意识|元素记忆库)/i

export function isInternal(q) {
  return INTERNAL_RE.test(String(q.focus || '')) || INTERNAL_RE.test(String(q.text || q.her || ''))
}

const DIGEST_SYSTEM = [
  '你在帮一位虚拟人格做笔记。她有一个没弄明白的问题，你在网上找到了几段材料。',
  '只做一件事：判断这些材料有没有直接回答她的问题。',
  '有，就把答案写成 2–3 句她能看懂的话；没有，就老实说没有。',
  '严格输出一行 JSON，不要别的字：',
  '{"ok":true,"answer":"两到三句答案"}',
  '{"ok":false}',
  '要求：',
  '1. answer 里只用材料里出现过的事实，不许编、不许推测；',
  '2. 每句不超过三十个字，不用"根据材料"这类话；',
  '3. 材料只答了一部分，也可以给 ok:true，但要写明还缺什么；',
  '4. 拿不准就不算答上——宁可 ok:false。',
].join('\n')

/**
 * 跑一次学习。
 * @param {object} q 清单里的一条 { id, focus, text }
 * @param {object} opts { sources, pages, model, baseUrl, log }
 */
export async function studyOne(q, { sources = null, pages = 2, model, baseUrl, log = () => {} } = {}) {
  if (isInternal(q)) {
    return { ok: false, internal: true, reason: '问的是我们自家插件的事，网上查不到，得你来答' }
  }
  // 有 Tavily key 就用它（稳）；没配才退回 360 + B 站那套抓取
  sources = sources || (tavilyKey() ? ['tavily', 'so360'] : ['so360', 'bili'])
  const opts = { model, baseUrl }
  const query = await buildQuery(q, opts)
  if (!query) {
    return { ok: false, reason: '这句话离开上下文就说不清，拆不出能搜的词' }
  }

  log(`搜「${query}」`)
  // 360 有时会返回一整页完全无关的东西（Nature Methods、GitLab、越南抖音…都遇到过），
  // 同一次查询隔一秒重试通常就对了。所以先看"结果跟查询有没有共同词"，没有就重试一次。
  const tokens = (String(query).match(/[\u4e00-\u9fa5A-Za-z0-9]{2,}/g) || [])
    .map((t) => t.toLowerCase())
    .slice(0, 6)
  const relevant = (h) => {
    const blob = `${h.title || ''} ${h.snippet || ''} ${h.url || ''}`.toLowerCase()
    return tokens.some((t) => blob.includes(t))
  }
  let found = await search(query, { sources, limit: 6 })
  if (found.hits.length && !found.hits.some(relevant)) {
    log('搜回来的东西跟她问的无关，重试一次')
    await new Promise((r) => setTimeout(r, 1200))
    found = await search(query, { sources, limit: 6 })
  }
  found.hits = found.hits.filter(relevant)
  if (!found.hits.length) {
    return { ok: false, reason: '一条都没搜到', query, failed: found.failed }
  }

  // 先多试几页，按"正文里有多少汉字"挑最实的两页——视频页往往只有标题和导航
  const cjk = (s) => (String(s).match(/[\u4e00-\u9fa5]/g) || []).length
  // 技术问题优先读这些地方；微软官网那种营销页读一百遍也没答案
  // 注意：这里**不含 bilibili.com**——视频页正文是导航和推荐，不是答案，排前面只会把真材料挤掉
  const TECH = /(csdn\.net|cnblogs\.com|zhihu\.com|segmentfault\.com|jianshu\.com|stackoverflow\.com|github\.com|runoob\.com|w3school|juejin\.cn)/i
  const JUNK = /(microsoftstore|microsoft\.com\/zh-cn\/software|apple\.com|adobe\.com)/i
  const ranked = [...found.hits].sort((a, b) => {
    const score = (h) => (JUNK.test(h.url) ? -10 : 0) + (TECH.test(h.url) ? 3 : 0)
    return score(b) - score(a)
  })
  const usable = ranked.filter((h) => !JUNK.test(h.url))
  if (!usable.length) {
    return {
      ok: false,
      reason: '搜到的全是官网/营销页，没有能读的内容——这个问法太泛，换个更具体的词再试',
      query,
      hits: found.hits.length,
    }
  }
  const got = []
  for (const hit of usable) {
    if (got.length >= Math.max(4, pages * 2)) break
    try {
      const page = await readPage(hit.url, { maxChars: 2000 })
      const n = cjk(page.text)
      if (!page.text || n < 120) {
        log(`太薄，跳过：${hit.title.slice(0, 24)}`)
        continue
      }
      got.push({ title: hit.title, url: hit.url, text: page.text.slice(0, 1600), n })
      log(`读了：${hit.title.slice(0, 30)}（${n} 字）`)
    } catch (e) {
      log(`读不动：${hit.url.slice(0, 50)}（${e.name === 'TimeoutError' ? '超时' : 'HTTP 拒绝'}）`)
    }
  }
  // 挑材料时，"是不是技术站"比"字数多"重要：视频页字多但全是导航
  const finalScore = (x) => (TECH.test(x.url) ? 10000 : 0) + x.n
  const materials = got.sort((a, b) => finalScore(b) - finalScore(a)).slice(0, pages)
  if (!materials.length) return { ok: false, reason: '搜到了，但一页也读不进来', query, hits: found.hits.length }

  const bundle = materials
    .map((m, i) => `【材料 ${i + 1}】${m.title}\n${m.text}`)
    .join('\n\n')

  let answer = ''
  let how = 'model'
  try {
    const raw = await chat({
      system: DIGEST_SYSTEM,
      user: `她没弄明白的问题：「${q.text || q.focus}」\n\n材料：\n${bundle}`,
      model, baseUrl,
    })
    // 只认那一行 JSON；解析不出来就当它没答上
    const m = raw.match(/\{[\s\S]*\}/)
    let parsed = null
    try { parsed = m ? JSON.parse(m[0]) : null } catch { parsed = null }
    if (!parsed || typeof parsed.ok !== 'boolean') {
      return { ok: false, reason: '模型没按格式回答，不采信', query, hits: found.hits.length }
    }
    if (!parsed.ok) {
      return { ok: false, reason: '材料里没有能直接回答这个的内容', query, hits: found.hits.length }
    }
    answer = String(parsed.answer || '').trim()
  } catch (e) {
    how = 'excerpt'
    const first = materials[0]
    answer = `（没整理成自己的话，先抄一段）${first.text.slice(0, 120)}`
    log(`整理失败，退回摘录：${e.message}`)
  }

  // 模型说"没查到/材料没提"时，别把这段废话留成答案，也别往她桌上放纸条
  if (/没查到|查不到|没有回答|找不到能回答|没提|没有提|未提到|没讲|没有讲|未提供|没有提供|无法直接|没有相关工具/.test(answer) || answer.length < 12) {
    return { ok: false, reason: '查到的材料回答不了这个问题', query, hits: found.hits.length }
  }

  const study = {
    at: new Date().toISOString(),
    questionId: q.id,
    focus: q.focus,
    query,
    answer: answer.slice(0, 300),
    how,
    sources: materials.map((m) => m.url),
    failed: found.failed,
  }
  const store = await readJson(studiesPath(), { studies: [] })
  store.studies.unshift(study)
  store.studies = store.studies.slice(0, 200)
  await writeJson(studiesPath(), store)

  return { ok: true, study }
}

const REFINE_SYSTEM = [
  '她在对话里冒出一句没弄明白的话。你要先判断：这句话能不能变成一个"查得到"的问题。',
  '能，就把它改写成一句具体的、能拿去搜索的事实性问题（10–30 字）。',
  '不能（那只是在跟你说话、在表达态度、答案只在对方手里），就只输出三个字：问不清。',
  '改写必须做到两件事：',
  '1. 把她嘴里的"那个东西/它/那件事"换成上一句里出现的**具体名字**；',
  '2. 这句话单独拿出来看，别人也能看懂在问什么。',
  '只输出那一句话，不要解释、不要引号、不要换行。',
  '例：上面说"你说的两个插件我帮你装上了"，她说"还是有个我要调的东西" → 怎么配置 dsh 插件',
  '例：上面说"那个证书老是报错"，她说"要不要我再试试" → HTTPS 自签名证书报错怎么解决',
  '例：她说"够不够用来试你说的那个" → 问不清',
  '例：她说"是不是你给我这边的头像" → 问不清',
].join('\n')

/**
 * 疑惑 → 疑问：把她没问清的话改写成一句查得到的问题。
 * 改不动就老实说改不动——别硬把"要不要我再想办法"掰成一个知识点。
 */
export async function refineToQuestion(q, { model, baseUrl } = {}) {
  const original = String(q.text || q.her || q.focus || '')
  try {
    const out = await chat({
      model,
      baseUrl,
      system: REFINE_SYSTEM,
      user: `上一句他说：「${q.ctx || '（没有上下文）'}」\n她说：「${original}」`,
      timeoutMs: 30000,
    })
    const one = out.split(/\n/)[0].trim().replace(/^["「『]|["」』]$/g, '').replace(/[？?。！!]+$/, '')
    const bare = (s) => String(s).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
    if (!one || one.includes('问不清') || one.length < 8 || one.length > 40) {
      return { ok: false, reason: '这句话还没问成能查的样子' }
    }
    // 只是把原话加了标点/换了个说法，不算问清
    if (bare(one) === bare(original) || bare(original).includes(bare(one))) {
      return { ok: false, reason: '它只是把原话重复了一遍，没变成能查的问题' }
    }
    // 查得到的问题不该还在跟你说话
    if (/[你我咱]/.test(one)) {
      return { ok: false, reason: '改写里还带着「你/我」，那还是对话，不是知识问题' }
    }
    // 指代不清：改写里还在说"那个/这个/它/东西"，说明没把名字落下来
    if (/(那个|这个|那件事|这件事|那种|东西|事情|它)/.test(one)) {
      return { ok: false, reason: '改写里还有「那个/它」这种指代，没落到具体名字上' }
    }
    // 必须真从上下文里拿了一个名字，而不是凭空造句
    const words = (s) => {
      const t = String(s || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
      const set = new Set()
      for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2))
      return set
    }
    const ctxGrams = words(q.ctx || '')
    const hit = [...words(one)].some((g) => ctxGrams.has(g))
    if (q.ctx && !hit) {
      return { ok: false, reason: '改写和上一句对不上，像是凭空造了个问题' }
    }
    return { ok: true, question: one }
  } catch (e) {
    return { ok: false, reason: `本地模型没答上来（${e.message}）` }
  }
}
