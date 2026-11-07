/**
 * editor.js —— 故事编辑器
 *
 * 它做的事和审查器完全分开：
 *   editor 决定「今晚讲什么、按什么顺序讲、哪些材料进不来」
 *   judge  决定「写出来的这段还称不称得上一个梦」
 *
 * 一条铁律：**素材能拼成故事才做梦，拼不成就不做梦。**
 * 所以这里会大量地丢材料——"今天和昨天差不多"这种状态句，
 * 再多也撑不起一个故事，宁可不要。
 *
 * 三句话小说（three-sentence story）的形状：
 *   ① 场景/处境  ② 事情发生了  ③ 变了（转折、失手、想起来）
 * 缺②或缺③，就不是故事，只是记录。
 *
 * 六类材料（用户 m02912 定）：
 *   1 处境 state   她的经历里"一直是什么样"
 *   2 事情 act     发生了什么
 *   3 变化 change  变了
 *   4 主体 who     编辑可以**自由指定**是谁，不必是材料里出现的人
 *   5 常识 thing   元素记忆库里的物体与元素 —— 当道具
 *   6 潜意识 deep  已沉出她视野的旧经历 —— 梦本来就该翻旧账
 * 1–3 来自最近经历，4–6 用来补"材料丢得太多"的缺口。
 */

const ACT = /放|拿|走|跑|摔|扔|捡|拎|推|拉|开|关|坐|站|醒|哭|笑|说|问|发|发来|打|洗|擦|塞|装|换|修|买|找|数|写|看|盯|碰|撕|折|藏|丢|递|抱|拍|踢|踩|钻|爬|停|回|撤|切|剪|盖|摊|倒|灌|咬|吃|喝|咽|吐|抽|点|按|抬|举|松|握|摸|敲|翻|卷|抖|晃|响|动/
const FEEL = /觉得|怀疑|后悔|难过|害怕|生气|舍不得|不原谅|不想|没想到|其实|忽然|终于|决定|记错|不确定|以为|担心|希望|忍不住|受不了|心疼|空落|难受|安心|松了一口气|不敢/
const OTHER = /他|她|有人|别人|对方|妈|爸|同事|朋友|老板/
const STATE = /还是|一直|没变|差不多|依旧|又|整天|一天|亮着|开着|放着|在|着$/
const CHANGE = /忽然|突然|终于|一下子|结果|后来|再也没|停了|掉了|破了|坏了|空了|不见了|没想到|以为|后悔|决定/
const META = /梦|做梦|总结|以下|首先/

/**
 * 默认的「谁」——只在没从她的事件流里读到真人名时兜底。
 * 真名由 `sources.mjs` 的 `subjectPool()` 提供：她自己、她对他的称呼、她在 B 站见过的人。
 * 刻意不写「一个陌生人」：梦只该重组她真有过的东西。
 */
export const SUBJECTS = ['我', '他', '视频里的人']

/** 给一条碎片打标签：act / feel / other / state / flat */
export function tag(text) {
  const t = String(text || '').trim()
  if (!t) return 'flat'
  if (META.test(t)) return 'flat'
  const act = ACT.test(t)
  const feel = FEEL.test(t)
  const other = OTHER.test(t)
  const state = STATE.test(t)
  if (act) return 'act'
  if (feel) return 'feel'
  if (other) return 'other'
  if (state) return 'state'
  return 'flat'
}

function mulberry(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const asText = (x) => (typeof x === 'string' ? x : String(x?.text ?? '')).trim()

/**
 * 物件当主角时的权重。
 *
 * 用户的原话：越简单的东西权重越低，「狗高于方块」。
 * 所以按它在元素记忆库里有多"厚"来算——元素多、见得多，就是她越熟、
 * 细节越多的东西；一个只有"方形/灰色"两笔的方块，撑不起一个梦的主角。
 *
 * @returns {number} 0.4 ~ 2
 */
export function thingWeight(t) {
  const elements = Number(t?.total ?? (Array.isArray(t?.elements) ? t.elements.length : 0))
  const seen = Number(t?.seen || 0)
  // 3 个元素、没见过 = 0.76；一只有 8 个元素、被见过几次的狗封顶到 2。
  return Math.min(2, 0.4 + elements * 0.12 + Math.min(seen, 5) * 0.1)
}

const STOP = new Set(
  ('我们 你们 他们 她们 它们 这个 那个 什么 一个 一直 还是 就是 不是 没有 因为 所以 但是 而且 然后 如果 已经 ' +
    '自己 知道 觉得 这样 那样 时候 东西 现在 今天 昨天 明天 起来 出来 下来 上来 过去 回来 一下 有点 一点 ' +
    '把 被 给 和 跟 的 在 了 是 有 我 你 他 她 它 就 都 也 又 还 很 太 更 最 不 没 这 那 会 能 要 说 去 来').split(' '),
)

/** 两字实词（粗粒度分句用），去停用字。 */
function tokens(text) {
  const s = String(text || '').replace(/[^\u4e00-\u9fa5]/g, '')
  const out = new Set()
  for (let i = 0; i + 2 <= s.length; i += 1) {
    const g = s.slice(i, i + 2)
    if (!STOP.has(g) && !STOP.has(g[0]) && !STOP.has(g[1])) out.add(g)
  }
  return out
}

/** 两句话有没有共同的东西（同一件事、同一个物件）。 */
export function relates(a, b) {
  const A = tokens(a)
  const B = tokens(b)
  for (const x of A) if (B.has(x)) return true
  return false
}

/**
 * 挑材料。
 *
 * @param {Array<string|{text:string,from?:string}>} pool 经历碎片（from:'now' 最近 / 'deep' 潜意识）
 * @param {number} seed
 * @param {object} opts
 * @param {Array<{name:string,elements:string[],text:string}>} opts.things 元素记忆库里的道具
 * @param {string[]} opts.subjects 可用的"谁"（默认 SUBJECTS）
 * @param {string}   opts.who      指定主体（覆盖随机）
 * @returns {{used:string[], groups:object, roles:string[]}|null}
 */
export function cast(pool, seed, { things = [], subjects = SUBJECTS, who = '' } = {}) {
  const allowed = (subjects || [])
    .map((s) => (typeof s === 'string' ? s : String(s?.label ?? '')))
    .filter(Boolean)
  const list = allowed.length ? allowed : SUBJECTS
  const rand = mulberry(seed)
  const take = (list) => (list.length ? list[Math.floor(rand() * list.length)] : null)

  const tagged = pool
    .map((x) => ({ text: asText(x), from: typeof x === 'object' ? String(x.from ?? 'now') : 'now' }))
    .filter((x) => x.text)
    .map((x) => ({ ...x, kind: tag(x.text) }))

  const near = tagged.filter((x) => x.from === 'now')
  const deep = tagged.filter((x) => x.from === 'deep')
  const pickFrom = (kind, list) => take(list.filter((x) => x.kind === kind))

  // 事情：先找"已经提炼成事件"的那些（最结实），再找最近的原始碎片，
  // 最后才往潜意识里翻（梦最擅长翻旧账）
  const event =
    take(near.filter((x) => x.from === 'incident' && x.kind === 'act')) ||
    pickFrom('act', near) ||
    pickFrom('act', deep)
  if (!event) return null

  const rest = tagged.filter((x) => x !== event)

  // 变化：必须是**和这件事有关**的一句（共用名词），否则宁可不给——
  // 给一句不相干的"变化"，模型只会把它们排成三件互不相干的事。
  const related = rest.filter((x) => relates(x.text, event.text))
  const turn =
    related.find((x) => x.kind === 'feel' || x.kind === 'other' || CHANGE.test(x.text)) ?? null

  // 处境：也要求和这件事有关（同一张桌子、同一个房间），没有就让模型自己起景
  const scene = related.find((x) => x !== turn && x.kind === 'state') ?? null

  // 4 主体：她认识的人优先，物件次之。
  // 权重不同是刻意的——梦里主角多半是人；让一把指甲刀当主角也合理，
  // 但不该和"她自己"一样常见。物件的候选只随机取 4 个，
  // 否则元素记忆库越大，物件当主角的概率就被库的规模顶上去。
  const thingPool = things.filter((x) => x && x.name)
  const thingPick = []
  for (let i = 0; i < Math.min(4, thingPool.length); i += 1) {
    const j = i + Math.floor(rand() * (thingPool.length - i))
    ;[thingPool[i], thingPool[j]] = [thingPool[j], thingPool[i]]
    thingPick.push(thingPool[i])
  }
  const cands = [
    ...list.map((label) => ({ label, kind: 'person', w: 4 })),
    ...thingPick.map((x) => ({ label: String(x.name), kind: 'thing', w: thingWeight(x) })),
  ]
  const subj = who
    ? { label: who, kind: list.includes(who) ? 'person' : 'thing' }
    : (() => {
        const total = cands.reduce((a, b) => a + b.w, 0)
        if (!total) return { label: '', kind: 'person' }
        let r = rand() * total
        for (const c of cands) {
          if (r < c.w) return c
          r -= c.w
        }
        return cands[cands.length - 1]
      })()
  const subject = subj.label

  // 5 常识：从元素记忆库里挑一个道具（跟已选材料不重样）
  const thing = take(things)

  // 6 潜意识：优先挑一条"沉下去"的，且和已选材料不重样
  const depth = deep.find((x) => x !== event && x !== turn && x !== scene) ?? null

  const picked = [scene, event, turn].filter(Boolean)
  const used = [...new Set(picked.map((x) => x.text))]
  if (used.length < 1) return null

  return {
    used,
    groups: {
      处境: scene?.text ?? '',
      事情: event.text,
      变化: turn?.text ?? '',
      主体: subject,
      主体是: subj.kind === 'thing' ? '物件' : '人',
      常识: thing?.text ?? '',
      潜意识: depth?.text ?? '',
    },
    roles: picked.map((x) => `${x.text}（${x.kind}${x.from === 'deep' ? '·旧' : ''}）`),
    subject,
    subjectKind: subj.kind,
    thing,
    depth,
  }
}

/** 把五花八门的材料拼成给模型看的那段话。六类各占一行，模型一眼看得见哪条是什么。 */
export function renderMaterials(c) {
  const g = c.groups
  const lines = [`事情：${g.事情}`]
  if (g.处境) lines.unshift(`处境：${g.处境}`)
  if (g.变化) lines.push(`变化：${g.变化}`)
  if (g.主体) lines.push(`谁：${g.主体}${g.主体是 === '物件' ? '（一个物件，不会说话，但可以动、可以坏、可以被放下）' : ''}`)
  if (g.常识) lines.push(`道具（她认识的东西）：${g.常识}`)
  if (g.潜意识) lines.push(`旧事（她快忘了的）：${g.潜意识}`)
  return lines.join('\n')
}

export const STORY_SYSTEM = [
  '你是做梦机器。把下面的记忆材料写成一个连贯的小故事，三到六句。',
  '材料分几行给出：处境、事情、变化、谁、道具、旧事。处境可以不用，事情必须有。',
  '形状示范（不是你的材料，只看形状）：',
  '材料：处境：桌上有只杯子 / 事情：他把杯子推倒了 / 变化：我没去扶 / 谁：他 / 道具：抹布',
  '输出：{"lines":["桌上放着一只杯子，旁边搭着块抹布。","他伸手去够它，袖子带倒了杯子。","水顺着桌沿淌下来。","我拿着抹布站了一会儿，没去扶。"]}',
  '',
  '规则：',
  '一、只输出 JSON，键名 lines，值是句子组成的数组（三到六句），不要任何解释文字。',
  '二、要像一段话那样连起来：后一句接住前一句里出现过的东西（同一只杯子、同一个人、同一件事），不要每句各说一件事。',
  '三、可以用「后来」「然后」「那天」这种连接词，但整段里最多用一次，不要每句都加。',
  '四、谁这一行给的是主角。主角只能是这一行里的那个东西，而且从头到尾都是它，别半路换人。',
  '五、如果「谁」是个物件（那一行会注明"不会说话"），就让它当主角：它可以动、可以坏、可以被放下，但它不说话，也不要给它安一个主人和三句对话。',
  '六、可以补天气、光线、声音、位置这类过场细节，让句子连得顺；但不许出现材料里没有的东西。',
  '七、事情和变化必须写到。材料里给了变化就照它写；没给就写出这件事的后果。',
  '八、道具、旧事只用来布置，不要让它们各占一句。',
  '九、每句不超过二十八个字，全段不超过一百六十字。比喻、抒情都可以——都做梦了，本来就该自由一点。',
  '十、只要材料里有一件事，就必须讲成故事。真的连一件事都没有，才输出 {"no_story":true}。',
  '十一、全篇用第一人称写：讲故事的人始终是「我」。主角若是别人或物件，用第三人称写它（他、她、它），但至少有两句里「我」要在场（我看见、我听着、我记得、我伸手）。别把「我」写成旁人。',
].join('\n')

/** 从模型回包里抠出 JSON（容忍 ```json 包壳与前后废话）。 */
export function parseStory(raw) {
  const s = String(raw || '')
  const m = s.match(/\{[\s\S]*\}/)
  if (m) {
    try {
      const j = JSON.parse(m[0])
      if (j.no_story) return { ok: false, reason: '模型判定凑不成故事' }
      const lines = (j.lines || []).map((x) => String(x).trim()).filter(Boolean)
      if (lines.length >= 3 && lines.length <= 6) return { ok: true, lines }
      return { ok: false, reason: `句数不对（${lines.length}）` }
    } catch {
      return { ok: false, reason: 'JSON 解析失败' }
    }
  }
  if (/no_story/i.test(s)) return { ok: false, reason: '模型判定凑不成故事' }
  return { ok: false, reason: '没拿到 JSON' }
}

export const __test = { mulberry }