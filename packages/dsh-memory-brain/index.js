/**
 * @local/dsh-memory-brain —— 元素库 / 映射库（方案 C：插件形态）
 *
 * 和方案 A 的 store.py 是同一套三张表，只是换成了宿主常驻：
 *
 *   elements  元素   名字 -> {kind, aliases}
 *   objects   物体   名字 -> {seen: [...]}
 *   edges     映射   物体 -> {元素 -> {w, why, at}}
 *
 * 数据落在 $DSH_HOME/memory/brain.json（默认 C:\Users\<你>\.dsh\memory\brain.json），
 * 第一次启动时用包里自带的 data/seed.json 铺底 —— 那个就是「离线种子包」，
 * 104 个常见物体、78 个元素、482 条边，装完即用，不联网。
 *
 * 三个工具：memory_explain / memory_recall / memory_learn，外加 memory_stats。
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = '@local/dsh-memory-brain'
export const inject = ['tools']

/** 元素分类。新增分类不用改代码，这里只决定 explain 的排列顺序。 */
const KINDS = ['形状', '立体形状', '颜色', '材质', '表面特征', '味道', '质地', '类别', '部位', '功能', '大小', '声音', '动作']

const SEED_URL = new URL('./data/seed.json', import.meta.url)

function brainPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'memory', 'brain.json')
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

/** 原子写：先落 .tmp 再改名，中途断电不会留下半个库。 */
async function saveBrain(data) {
  const path = brainPath()
  await mkdir(dirname(path), { recursive: true })
  data.updated = new Date().toISOString()
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

/** 有库就读库，没有就用种子包铺一份。 */
async function loadBrain() {
  const path = brainPath()
  if (existsSync(path)) {
    const data = await readJson(path)
    data.elements ??= {}
    data.objects ??= {}
    data.edges ??= {}
    return data
  }
  const seed = await readJson(fileURLToPath(SEED_URL))
  const data = { version: 1, updated: null, elements: seed.elements, objects: seed.objects, edges: seed.edges }
  await saveBrain(data)
  return data
}

function aliasIndex(data) {
  const idx = new Map()
  for (const [canon, meta] of Object.entries(data.elements)) {
    idx.set(canon, canon)
    for (const alias of meta.aliases ?? []) idx.set(alias, canon)
  }
  return idx
}

function ensureElement(data, elem, kind = '未分类') {
  const cur = data.elements[elem]
  if (cur === undefined) {
    data.elements[elem] = { kind, aliases: [] }
    return true
  }
  if (cur.kind === undefined || cur.kind === '' || cur.kind === '未分类') cur.kind = kind
  return false
}

function ensureObject(data, obj) {
  if (data.objects[obj] === undefined) data.objects[obj] = { seen: [] }
  if (data.edges[obj] === undefined) data.edges[obj] = {}
}

const round = (n) => Math.round(n * 1000) / 1000

/** 连边权重按元素类别分档 —— 和 build_seed.py 的 W 表一致。 */
const WEIGHT_BY_KIND = {
  类别: 0.9,
  形状: 0.8, 立体形状: 0.8, 颜色: 0.8,
  味道: 0.75,
  材质: 0.7, 表面特征: 0.7, 质地: 0.7, 部位: 0.7, 功能: 0.7, 大小: 0.7, 动作: 0.7,
  声音: 0.6,
}

/** 推断出来的特征打折：它没在画面上出现过，不该和亲眼看的一个价。 */
const INFERRED_FACTOR = 0.45

function weightFor(element) {
  return WEIGHT_BY_KIND[element?.kind] ?? 0.6
}

function link(data, obj, elem, weight, why, how) {
  ensureObject(data, obj)
  ensureElement(data, elem)
  const edge = data.edges[obj][elem]
  const at = new Date().toISOString()
  const kind = how === '推断' ? '推断' : '观察'
  if (edge === undefined) {
    data.edges[obj][elem] = { w: round(weight), why, at, how: kind, n: 1 }
    return 'new'
  }
  edge.w = round(Math.min(1, edge.w + (1 - edge.w) * 0.25))
  edge.why = why || edge.why
  edge.at = at
  // 亲眼见过一次，就把「推断」降级为「观察」——它已经被证实了。
  edge.how = kind === '推断' ? (edge.how ?? '推断') : '观察'
  edge.n = (edge.n ?? 1) + 1
  return 'strengthened'
}

/** 按元素分类分组，和 store.py 的 explain 一模一样。 */
function explain(data, obj) {
  const edges = data.edges[obj]
  if (edges === undefined || Object.keys(edges).length === 0) return null
  const grouped = new Map()
  for (const [elem, meta] of Object.entries(edges)) {
    const kind = data.elements[elem]?.kind ?? '未分类'
    if (!grouped.has(kind)) grouped.set(kind, [])
    grouped.get(kind).push([elem, meta.w, meta.how])
  }
  for (const list of grouped.values()) list.sort((a, b) => b[1] - a[1])
  const order = [...grouped.keys()].sort((a, b) => {
    const ia = KINDS.indexOf(a)
    const ib = KINDS.indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
  return order.map((kind) => [kind, grouped.get(kind)])
}

/**
 * 凭元素想起谁。
 * 除以要多少元素的平方根 —— 「又像又简单」的东西该排在前面，
 * 否则记了几十个元素的复杂物体永远霸榜。
 */
function recall(data, want, top) {
  const idx = aliasIndex(data)
  const wanted = new Set(
    want.map((token) => idx.get(token) ?? token).filter((token) => typeof token === 'string' && token !== ''),
  )
  if (wanted.size === 0) return []
  const out = []
  for (const [obj, edges] of Object.entries(data.edges)) {
    const hit = Object.keys(edges).filter((elem) => wanted.has(elem))
    if (hit.length === 0) continue
    const score = hit.reduce((sum, elem) => sum + edges[elem].w, 0) / Math.sqrt(wanted.size)
    out.push([obj, round(score), hit.sort()])
  }
  out.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
  return out.slice(0, Math.max(1, top))
}

function stats(data) {
  const objects = Object.keys(data.objects).length
  const elements = Object.keys(data.elements).length
  const edges = Object.values(data.edges).reduce((sum, row) => sum + Object.keys(row).length, 0)
  return { objects, elements, edges }
}

function formatExplain(obj, grouped) {
  const parts = grouped.map(([kind, items]) => `${kind}:${items
    .map(([n, w, how]) => `${n}(${w}${how === '推断' ? ' 推断' : ''})`)
    .join('/')}`)
  return `「${obj}」= ${parts.join('，')}`
}

function formatRecall(want, rows) {
  if (rows.length === 0) return `凭「${want.join(' + ')}」想不起来任何东西。`
  const lines = rows.map(([obj, score, hit], i) => `  ${i + 1}. ${score.toFixed(2)}  ${obj}   ← ${hit.join(', ')}`)
  return [`凭「${want.join(' + ')}」想到：`, ...lines].join('\n')
}

/* ------------------------------------------------------------ 待问的问题 */

/**
 * 它遇到拿不准的东西时，会把问题攒在这个文件里，等人来答。
 * 放在库旁边而不是插件目录里：换插件、重装都不该把问题弄丢，
 * 而且别的"人格"插件也能读同一份，替它开口问。
 */
function questionsPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'memory', 'questions.json')
}

async function loadQuestions() {
  const path = questionsPath()
  if (!existsSync(path)) return { items: [] }
  try {
    const data = await readJson(path)
    data.items ??= []
    return data
  } catch {
    return { items: [] }
  }
}

async function saveQuestions(data) {
  const path = questionsPath()
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

/** 同一个东西别问第二遍：已经有没答的同类问题就复用。 */
function enqueue(data, { kind, about, payload }) {
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

const KINDS_HINT = '形状 / 立体形状 / 颜色 / 材质 / 表面特征 / 类别 / 部位 / 功能 / 大小 / 味道 / 质地 / 动作 / 声音'

/**
 * 问法。故意不写成"请补充元数据"那种口气 ——
 * 这两个插件服务的是别的插件造出来的"人",它得像个活物在问，而不是一份表单。
 */
function cuteUnknownElement(name) {
  return [
    `诶…我碰到一个词，想了半天没想明白：「${name}」。`,
    `它该住进哪一间呀？${KINDS_HINT}。`,
    '（答错了也不打紧，你说一声我就改回来。）',
  ].join('\n')
}

function cuteHypothesis({ object, element, why }) {
  const tail = why === undefined || why === '' ? '' : `\n我当时的想法是：${why}`
  return [
    `我刚打了个盹，梦见「${object}」身上好像还有「${element}」…`,
    '你帮我看看，这个梦靠谱吗？点头我就记下来，摇头我就忘掉它。',
    tail,
  ].join('\n').trim()
}

function formatPending(rows) {
  if (rows.length === 0) return '现在没有要问你的，库是安静的。'
  // 编号必须露出来：否则用户答"第三个"时，模型手上没有能交给 memory_answer 的 id。
  return rows
    .map((q, i) => `${i + 1}. [${q.kind === 'hypothesis' ? '梦' : '没认出来'}] ${questionText(q)}\n（编号 ${q.id}）`)
    .join('\n\n')
}

function questionText(q) {
  return q.kind === 'hypothesis'
    ? cuteHypothesis({ object: q.payload.object, element: q.payload.element, why: q.payload.why })
    : cuteUnknownElement(q.about)
}

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


/**
 * 工具定义。故意只写「能做什么」，不写「什么时候该用」——
 * 每句引导每一轮都要付一次 token，而且会把它从"用户说了才动"变成"它自己觉得该动"。
 */
function makeTools() {
  return [
    {
      name: 'memory_explain',
      description:
        '把这个物体在元素库里的组成列出来，按 形状/颜色/味道/质地/类别/部位/功能/大小/声音/动作 分组，'
        + '每个元素带一个 0~1 的把握度。库里没有时返回空。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: { name: { type: 'string', description: '物体名，例如 苹果。' } },
      },
      async execute(args) {
        const data = await loadBrain()
        const grouped = explain(data, args.name)
        if (grouped === null) return { text: `库里没有「${args.name}」。` }
        return { text: formatExplain(args.name, grouped) }
      },
    },
    {
      name: 'memory_recall',
      description:
        '凭若干元素反向想起可能是哪些物体，按相似度从高到低。元素可以写别名（红 / 圆的）。'
        + '分数 = 命中元素权重之和 ÷ 元素个数的平方根，所以"又像又简单"的排前面。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['elements'],
        properties: {
          elements: { type: 'array', items: { type: 'string' }, description: '元素或别名，例如 ["圆形","红色"]。' },
          top: { type: 'integer', description: '返回几个，默认 5。' },
        },
      },
      async execute(args) {
        const data = await loadBrain()
        const want = args.elements ?? []
        const rows = recall(data, want, args.top ?? 5)
        const text = formatRecall(want, rows)

        // 还没被证实的猜想单独列一段，绝不混进"见过"的里面：
        // 猜错了会把整个库带歪，而用户看不到区别就不会去纠正。
        const wanted = new Set(want.map((s) => String(s).trim()))
        const qs = await loadQuestions()
        const guesses = qs.items.filter(
          (it) => it.answeredAt === null && it.kind === 'hypothesis' && wanted.has(String(it.payload.element ?? '')),
        )
        if (guesses.length === 0) return { text }
        const tail = guesses
          .slice(0, 3)
          .map((it) => `  ？ ${it.payload.object}  ← 我猜它也有 ${it.payload.element}（还没证实）`)
        return { text: [text, '另外，我还在瞎猜（别当真）：', ...tail].join('\n') }
      },
    },
    {
      name: 'memory_learn',
      description:
        '教它一个物体由哪些元素组成。已知元素会连边并加强权重，没见过的词会作为新元素收进库里'
        + '（标记为「未分类 / 新学」）—— 认不出的词不会被丢掉。可重复调用同一物体，每见一次权重往高处靠。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'elements'],
        properties: {
          name: { type: 'string', description: '物体名，例如 榴莲。' },
          elements: { type: 'array', items: { type: 'string' }, description: '元素或别名，例如 ["圆形","黄色","水果","带刺"]。' },
          inferred: {
            type: 'array',
            items: { type: 'string' },
            description: '可选：这次给的元素里，哪些是**推断**出来的而不是在画面上看见的（例如从材质推出「坚硬」、从形状推出「剪指甲」）。'
              + '这些会按 0.45 倍打折并记成「推断」，亲眼看过的记成「观察」。',
          },
          note: { type: 'string', description: '可选：这次是在哪学到的，例如「用户口述」。' },
          byUser: {
            type: 'boolean',
            description: '可选：这次是用户在对话里亲手教/纠正的。会在元素和边上标 lock，以后自动整理不会擅自改它。',
          },
        },
      },
      async execute(args) {
        const data = await loadBrain()
        const idx = aliasIndex(data)
        const inferredSet = new Set((args.inferred ?? []).map((s) => String(s).trim()))
        const byUser = args.byUser === true
        const known = []
        const fresh = []
        const howOf = (token) => (inferredSet.has(token) ? '推断' : '观察')
        for (const raw of args.elements ?? []) {
          const token = String(raw).trim()
          if (token === '') continue
          const canon = idx.get(token)
          const how = howOf(token)
          const factor = how === '推断' ? INFERRED_FACTOR : 1
          if (canon === undefined) {
            ensureElement(data, token, '未分类')
            link(data, args.name, token, round(0.6 * factor), args.note || '新学', how)
            fresh.push(token)
            if (byUser) data.elements[token].lock = 'user'
          } else {
            link(data, args.name, canon, round(weightFor(data.elements[canon]) * factor), args.note || '学习', how)
            known.push(canon)
            if (byUser) data.elements[canon].lock = 'user'
          }
          // 用户亲手教过的这条边也上锁：以后自动整理不许动它。
          if (byUser && data.edges[args.name]?.[canon ?? token] !== undefined) {
            data.edges[args.name][canon ?? token].lock = 'user'
          }
        }
        ensureObject(data, args.name)
        data.objects[args.name].seen.push({
          at: new Date().toISOString(),
          from: 'tool',
          note: String(args.note ?? '').slice(0, 120),
          inferred: [...inferredSet],
        })
        await saveBrain(data)
        const grouped = explain(data, args.name)
        const lines = [`学会了「${args.name}」`]
        if (grouped !== null) lines.push(formatExplain(args.name, grouped))
        if (fresh.length > 0) {
          // 没分类的词不丢，而是攒成问题，等用户回来给它归位。
          const qs = await loadQuestions()
          for (const word of fresh) enqueue(qs, { kind: 'unclassified-element', about: word, payload: {} })
          await saveQuestions(qs)
          lines.push(`新收进库的元素（还不知道属于哪一类）：${fresh.join(', ')}`)
          for (const word of fresh.slice(0, 3)) lines.push('', cuteUnknownElement(word))
        }
        return { text: lines.join('\n') }
      },
    },
    {
      name: 'memory_pending',
      description:
        '列出它现在攒着、想问用户的问题（没认出来的词该归哪一类、睡醒时的猜想要不要记下来）。'
        + '问法已经是拟人语气，可以直接照着说给用户听。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', description: '最多列几条，默认 5。' },
        },
      },
      async execute(args) {
        const data = await loadQuestions()
        const open = data.items.filter((q) => q.answeredAt === null).slice(0, Math.max(1, args.limit ?? 5))
        for (const q of open) if (q.askedAt === null) q.askedAt = new Date().toISOString()
        if (open.length > 0) await saveQuestions(data)
        return { text: formatPending(open) }
      },
    },
    {
      name: 'memory_classify',
      description:
        '用户回答"这个词属于哪一类"之后调用：给元素定类别，并标成用户亲手定的（以后自动整理不会擅自改它）。'
        + '同时把对应的那条提问标记为已回答。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'kind'],
        properties: {
          name: { type: 'string', description: '元素名，例如 金属。' },
          kind: { type: 'string', enum: KINDS, description: '归到哪一类。' },
          alias: { type: 'string', description: '可选：用户顺口说的另一个名字，收作别名。' },
        },
      },
      async execute(args) {
        const data = await loadBrain()
        const idx = aliasIndex(data)
        const canon = idx.get(String(args.name).trim()) ?? String(args.name).trim()
        ensureElement(data, canon, args.kind)
        data.elements[canon].kind = args.kind
        data.elements[canon].lock = 'user'
        if (typeof args.alias === 'string' && args.alias.trim() !== '' && args.alias.trim() !== canon) {
          const aliases = data.elements[canon].aliases ?? []
          if (!aliases.includes(args.alias.trim())) data.elements[canon].aliases = [...aliases, args.alias.trim()]
        }
        await saveBrain(data)

        const qs = await loadQuestions()
        for (const q of qs.items) {
          if (q.answeredAt === null && q.kind !== 'hypothesis' && q.about === canon) {
            q.answeredAt = new Date().toISOString()
            q.answer = args.kind
          }
        }
        await saveQuestions(qs)
        return { text: `好，那「${canon}」就住进「${args.kind}」那间了，我记住了。` }
      },
    },
    {
      name: 'memory_answer',
      description:
        '回答"睡醒时那个猜想靠不靠谱"：accept=true 就把这条猜想记进库（标成用户确认），'
        + 'accept=false 就作废、以后不再提。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string', description: '问题编号，从 memory_pending 里拿。' },
          accept: { type: 'boolean', description: 'true = 是真的，记下来；false = 不靠谱，忘掉它。' },
        },
      },
      async execute(args) {
        const qs = await loadQuestions()
        const q = qs.items.find((it) => it.id === args.id)
        if (q === undefined) return { text: `找不到编号 ${args.id} 的问题，可能已经被答过了。` }
        if (q.answeredAt !== null) return { text: `这条已经答过了：${q.answer ?? ''}` }

        if (args.accept === true && q.kind === 'hypothesis') {
          const data = await loadBrain()
          const object = String(q.payload.object ?? '')
          const element = String(q.payload.element ?? '')
          if (object !== '' && element !== '') {
            ensureObject(data, object)
            ensureElement(data, element)
            link(data, object, element, round(weightFor(data.elements[element])), '睡醒时的猜想，用户确认', '确认')
            data.objects[object]?.seen?.push({
              at: new Date().toISOString(),
              from: 'dream',
              note: '猜想被用户确认',
            })
            await saveBrain(data)
          }
          q.answeredAt = new Date().toISOString()
          q.answer = 'yes'
          await saveQuestions(qs)
          return { text: `记下了：「${object}」也有「${element}」。谢谢你帮我确认这个梦。` }
        }

        q.answeredAt = new Date().toISOString()
        q.answer = 'no'
        await saveQuestions(qs)
        return { text: '好，那把这个梦忘掉，以后不再提了。' }
      },
    },
    {
      name: 'memory_stats',
      description: '元素库的规模：多少物体、多少元素、多少条边，以及库文件在哪。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      async execute() {
        const data = await loadBrain()
        const { objects, elements, edges } = stats(data)
        return { text: `物体 ${objects} 个 / 元素 ${elements} 个 / 边 ${edges} 条\n库文件：${brainPath()}` }
      },
    },
  ].map((tool) => ({ ...tool, output: OUTPUT }))
}

// 给任何人格插件一段"常识提示"。不写死在某个角色里，而是挂成运行时背景：
// 谁在这个 agent 里说话，谁就在这一步看到它。像 dsh-fish 那种人格插件
// 不用改一行代码，下一轮就会自己去查库、拆元素。
const PROMPT_BRIEF = [
  '【元素记忆库】memory_* 是常识库，不是任务清单，没事别硬用。',
  '看得出的东西：先 memory_explain 查；查不到再 memory_learn 拆元素，只写看得见的，推断的放 inferred。',
  '不认识的词：先粗分类，再用 memory_classify 问归属。',
  '联想用 memory_recall，它把见过的和猜的分开列。',
  '问"这是什么"走 memory_pending，别重复问；问"你想不想做某事"用你自己的方式。',
  '没把握就说没把握，别为了填库而编。',
].join('\n')

const mountPrompt = (hostCtx) => {
  hostCtx.effect(() =>
    hostCtx.systemPrompt.context({
      name: 'memory-brain.brief',
      order: 640,
      text: PROMPT_BRIEF,
    }),
  )
}

export function apply(ctx) {
  const disposers = []
  for (const tool of makeTools()) disposers.push(ctx.tools.register(tool))

  // systemPrompt 和 webServer 一样，不保证 apply 时已经就绪；
  // 用 inject 等它，卸载交给 effect 跟着 fiber 走。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], mountPrompt)
  } else if (typeof ctx.get === 'function' && ctx.get('systemPrompt')) {
    mountPrompt(ctx)
  }

  return () => {
    for (const dispose of disposers) dispose()
  }
}
