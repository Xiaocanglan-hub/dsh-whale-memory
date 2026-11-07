/**
 * judge.js —— 梦的"轻微逻辑审查"
 *
 * 分寸是这里唯一难的地方：
 *   审得太松 → 说出一堆废句，占她本就紧张的上下文寿命；
 *   审得太严 → 梦被修剪成通顺的文章，那还不如不做梦。
 *
 * 所以判据只回答一个问题：**这段话还能不能称之为"一个梦"**——
 * 不判它合不合理（梦不该合理），只判它有没有坏掉（碎句、乱码、清单、失控）。
 *
 * 硬失败（丢掉，当作"这个梦忘了"）：
 *   句数不在 3–6、有代码/markdown 残渣、中文占比过低、出现 meta 词（「我梦到」「这是一场梦」）
 * 软失败（只降分，仍然留下）：
 *   句子过长、总字数过多、有一半以上句子与素材原封不动一致（那是摘抄，不是梦）
 */

const HARD_BAD = ['总结', '以下', '首先', '其次']
const CODEY = /[`*#|<>{}[\]\\]/
const STOP = '的了在是有我他她你它就也都很不没这那些一个么什和与及把被给要会能'
const PRONOUN = /[我他她你它]/

/** 两句之间有没有"接上"：共同的实词片段，或同一个人称代词在回指。 */
function linked(a, b, seenPronouns) {
  const units = new Set()
  for (let i = 0; i + 1 < a.length; i++) {
    const w = a.slice(i, i + 2)
    if (!STOP.includes(w[0]) && !STOP.includes(w[1])) units.add(w)
  }
  for (const u of units) if (b.includes(u)) return true
  for (const p of b.match(/[我他她你它]/g) || []) if (seenPronouns.has(p)) return true
  return false
}

/**
 * 句与句之间接不接得上。
 *
 * 第一句是起景，第二句常常直接在另一样东西上落笔，所以「1→2」不查。
 * 从第三句起要求接得住前一句——但不是每句都必须：
 * 连续的梦本来就会跳，一次松口可以，连着两次跳、或者一半以上都跳，就成了清单。
 */
export function linkedChain(lines) {
  const seen = new Set()
  let miss = 0
  let streak = 0
  for (let i = 0; i < lines.length; i++) {
    if (i >= 2) {
      // 第一句是起景，可以跟后面没关系；从第二句起，每句必须接住紧邻的上一句。
      if (!linked(lines[i - 1], lines[i], seen)) {
        miss += 1
        streak += 1
        if (streak >= 2) return { ok: false, at: i }
      } else {
        streak = 0
      }
    }
    for (const p of lines[i].match(/[我他她你它]/g) || []) seen.add(p)
  }
  // 四句以上允许错一处；三句的梦只有一对相连，错一处就是不接。
  const pairs = Math.max(1, lines.length - 2)
  if (miss / pairs > 0.5) return { ok: false, at: lines.length - 1 }
  return { ok: true }
}

export function splitLines(text) {
  return String(text ?? '')
    .split(/[。！？\n]+/u)
    .map((s) => s.replace(/^[\s\d.、·-]+/u, '').trim())
    .filter(Boolean)
}

function cnRatio(s) {
  if (!s.length) return 0
  const cn = (s.match(/[\u4e00-\u9fa5]/g) || []).length
  return cn / s.length
}

/**
 * @param {string} text  模型产出或碎片拼接的梦
 * @param {string[]} fragments 用的碎片原文
 * @returns {{ok:boolean, score:number, lines:string[], reasons:string[], hard:boolean}}
 */
export function judge(text, fragments = []) {
  const reasons = []
  let hard = false
  const lines = splitLines(text)
  const total = lines.join('').length

  if (lines.length < 3) { reasons.push(`只说了 ${lines.length} 句，撑不起一个梦`); hard = true }
  if (lines.length > 6) reasons.push(`说了 ${lines.length} 句，太长`)
  if (total < 12) { reasons.push('几乎什么都没说'); hard = true }
  if (total > 160) reasons.push(`共 ${total} 字，超出她的上下文预算`)

  for (const line of lines) {
    if (line.length > 40) { reasons.push(`「${line.slice(0, 10)}…」这句太长`); break }
  }
  if (CODEY.test(text)) { reasons.push('混进了代码/标记符号'); hard = true }
  if (cnRatio(text) < 0.55) { reasons.push('中文太少，像日志不像梦'); hard = true }
  for (const w of HARD_BAD) {
    if (text.includes(w)) { reasons.push(`出现了「${w}」，那是解释不是梦`); hard = true; break }
  }

  // 与素材原封不动一致的句子：全都一样就只是摘抄
  const verbatim = lines.filter((l) => fragments.some((f) => f.includes(l) || l.includes(f))).length
  if (lines.length && verbatim / lines.length > 0.8) reasons.push('几乎全是原句，没有拼过')
  // 比喻、抒情一律不管。用户的原话：「都做梦了当然可以自由一点」。

  // 三句并排但互不接续 —— 那是材料清单，不是故事。这种情况算"今夜无梦"，不算写坏。
  let nostory = false
  if (lines.length >= 3) {
    const chain = linkedChain(lines)
    if (!chain.ok) {
      nostory = true
      reasons.push(`第 ${chain.at + 1} 句和前面接不上，这不成故事`)
    }
  }

  const score = Math.max(0, 1 - reasons.length * 0.18 - (hard ? 0.5 : 0))
  return { ok: !hard && !nostory, score: Number(score.toFixed(2)), lines, reasons, hard, nostory }
}

/**
 * 太长就截断而不是丢掉：她做了个长梦，剪掉尾巴比整场忘掉好。
 * 默认留前 6 句、总长 ≤ 180 字（一段小故事的篇幅）。
 */
export function trim(text, { maxLines = 6, maxChars = 180 } = {}) {
  const lines = splitLines(text)
  const out = []
  let n = 0
  for (const line of lines) {
    if (out.length >= maxLines) break
    if (n + line.length > maxChars) break
    out.push(line)
    n += line.length + 1
  }
  return out.length >= 3 ? `${out.join('。')}。` : text

}

/**
 * 把"像……"这种明喻尾巴剪掉。
 *
 * 提示词里写着不许比喻，但 4B 还是会写「屏幕亮起，像在呼吸」。
 * 与其整段丢掉，不如把尾巴剪了——比喻是修辞，不是内容，剪掉不损失她记得的事。
 * 剪完如果那句已经没东西了（少于 7 字），整句去掉。
 */
export function stripSimile(text) {
  const lines = splitLines(text)
  const out = []
  for (const line of lines) {
    let s = line
      .replace(/[，,、]?\s*(?:好像|仿佛|如同|像是|像|似)\s*[^。，,；;]{1,16}$/, '')
      .replace(/[，,、]?\s*似的$/, '')
      .trim()
    if (s.length >= 7) out.push(s)
  }
  return out.length >= 3 ? `${out.join('。')}。` : text
}

/** 醒来那一句话：不是取第一句，是取"最有画面、最不像工作"的一句。 */
const META_WORDS = ['进度', '插件', '系统', '安装', '配置', '文件', '代码', '保存', '截图', '工具', '参数', '任务', '部署', '测试', '编译', '上传', '回复', '消息']

export function pickWake(text, { max = 34, things = [] } = {}) {
  const lines = splitLines(text)
  if (!lines.length) return ''
  const scored = lines.map((l) => {
    let s = 0
    if (l.length >= 10 && l.length <= max) s += 3
    else if (l.length < 6) s -= 4
    else if (l.length > max) s -= 1
    for (const t of things) {
      const name = String(t || '').split('（')[0]
      if (name && l.includes(name)) s += 3
    }
    for (const w of META_WORDS) if (l.includes(w)) s -= 4
    if (/[，,]/.test(l)) s += 1        // 有停顿，像画面而不是条目
    return { l, s }
  })
  scored.sort((a, b) => b.s - a.s)
  const pick = scored[0].l
  return pick.length > max ? `${pick.slice(0, max)}…` : pick
}

/** 醒来那一句话（便条/第一句用），只取最短的、有画面的一个分句。 */
export function oneLine(text, max = 34) {
  const lines = splitLines(text)
  const ok = lines.filter((l) => l.length >= 5 && l.length <= max)
  const pick = ok[0] ?? lines[0] ?? ''
  return pick.length > max ? `${pick.slice(0, max)}…` : pick
}
