window.__ModuleLoader__.load({
  id: 'dsh-slow-wave',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const API = '/deepsleep-api'

    // 界面上的文字集中放这里，省得散落。按浏览器语言挑一份。
    //
    // 命名说明（用户 m03898 要求）：大肥鱼自己有一张卡叫「她做过的梦」
    // （设置 → 大肥鱼 → 住所），那是**她醒来后自己记的一句**。
    // 本插件产出的东西不是那个：它在她睡着时被拼出来，她本人没有参与。
    // 所以这里一律叫「潜意识梦」，并在卡片上写明区别，避免两处混淆。
    const DREAM_STRINGS = {
      zh: {
        title: '潜意识梦',
        desc: '她睡着时，本插件把她的旧经历重新拼成一个简短小故事，模拟人类做梦，不进她的记忆。',
        diff: '和大肥鱼「住所 → 她做过的梦」不是一回事：那条是她醒来后自己记的，这句是她睡着时被拼出来的。两处互不覆盖。',
        on: '允许它做梦',
        gap: '两次做梦之间至少隔',
        gapHint: '天。不能设成 0——会变成每个晚上都做，那不是作息，是熬夜。',
        narrate: '醒来要不要讲',
        narrateAlways: '每次做完都留一张便条给她看',
        narrateAsk: '只在她问起的时候讲',
        narrateNever: '只存档，不讲',
        list: '她做过的潜意识梦',
        none: '还没做过梦。素材攒够、能拼成故事的那天，它自己会做。',
        discarded: '太离谱被忘掉的',
        stats: '存档里的梦',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        failed: '保存失败',
        deps: '做梦需要这几样东西都在',
        depFish: '她的事件流（大肥鱼插件）',
        depMemory: '元素记忆库（道具与常识）',
        depModel: '本地模型',
        depOk: '在',
        depMissing: '缺',
        depWarn: '标「缺」的那项不影响另一半功能：少了事件流就做不成梦；少了元素记忆库，梦照做但会单薄；少了本地模型，只整理库不做梦。',
      },
      en: {
        title: 'Subconscious dreams',
        desc: 'While she sleeps, this plugin stitches her old experiences into a short story, the way a person dreams. It never enters her memory.',
        diff: 'Not the same as "Dreams she has had" under 大肥鱼 → Home: that one she writes herself after waking; this one is assembled while she sleeps. The two never overwrite each other.',
        on: 'Allow dreaming',
        gap: 'At least',
        gapHint: 'days between dreams. Cannot be 0 — that is not a rhythm, that is staying up all night.',
        narrate: 'Say it when she wakes',
        narrateAlways: 'Leave a note every time',
        narrateAsk: 'Only when she asks',
        narrateNever: 'Archive only, do not tell',
        list: 'Subconscious dreams so far',
        none: 'No dreams yet. One night the material will be enough.',
        discarded: 'Discarded as too strange',
        stats: 'Archived',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        failed: 'Save failed',
        deps: 'Dreaming needs all three of these',
        depFish: 'Her event stream (dsh-fish)',
        depMemory: 'Element memory (props and common sense)',
        depModel: 'Local model',
        depOk: 'ok',
        depMissing: 'missing',
        depWarn: 'A missing item only disables part of it: no event stream means no dreams at all; no element memory means thinner dreams; no local model means tidy only.',
      },
    }

    function dreamStrings() {
      const lang = String((navigator && navigator.language) || 'zh').toLowerCase()
      return lang.startsWith('zh') ? DREAM_STRINGS.zh : DREAM_STRINGS.en
    }

    const STRINGS = {
      zh: {
        title: '忆鲸鲸 · 潜意识',
        desc: '它睡着时干两件事：把元素记忆库理顺（合并重复的说法、剪掉站不住的边、抽查要不要猜点新东西），再做一个梦。改了立刻生效，不用重启。',
        idle: '键鼠安静多久算它睡着了',
        idleHint: '分钟。少于这个数它不会动手——你正用着电脑的时候，它不去抢 CPU。',
        gap: '两次整理之间至少隔',
        gapHint: '分钟。防止它一闲下来就反复折腾同一个库。',
        model: '用哪个脑子判断',
        modelLocal: '本地免费（qwen3 4B，不花钱，但是非判断容易出错）',
        modelPaid: 'DeepSeek（要花钱，判断更准，受下面的预算限制）',
        modelOff: '不用模型，只按规则（最保守：只合并写法完全一样的）',
        budget: '每晚上限',
        budgetHint: '元。超过就停手，第二天再说。',
        tasks: '允许它做这些事',
        taskMerge: '合并重复的说法（折叠 / 可折叠）',
        taskSimplify: '把描述精简短一点（还没做）',
        taskCompact: '剪掉很弱的边（只见过一次、权重又低的）',
        taskHypo: '自己组合元素，猜点新东西（还没做）',
        protect: '不动你亲手纠正过的内容',
        protectHint: '你在对话里明确纠正过的元素和边，它不会碰。',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        failed: '保存失败',
        reload: '重新读一遍',
        today: '今天已花',
        idleNow: '现在键鼠空闲',
        lastDream: '上次整理',
        never: '还没整理过',
        none: '（读不到）',
        yuan: '元',
        minutes: '分钟',
      },
      en: {
        title: 'YiJingJing · Subconscious',
        desc: 'While it sleeps it does two things: tidies the element memory library (merges duplicate wording, prunes weak edges, occasionally guesses new combinations), then dreams. Changes apply immediately.',
        idle: 'Count it asleep after keyboard and mouse are quiet for',
        idleHint: 'minutes. Below this it stays out of the way.',
        gap: 'At least this long between two tidies',
        gapHint: 'minutes, so it does not grind the same library repeatedly.',
        model: 'Which judgement to use',
        modelLocal: 'Local and free (qwen3 4B; no cost, but weak at judging word meaning)',
        modelPaid: 'DeepSeek (costs money, judges better, limited by the budget below)',
        modelOff: 'No model, rules only (safest: merges only identical wording)',
        budget: 'Nightly cap',
        budgetHint: 'CNY. It stops once spent.',
        tasks: 'Allowed to do',
        taskMerge: 'Merge duplicate wording (折叠 / 可折叠)',
        taskSimplify: 'Shorten descriptions (not implemented yet)',
        taskCompact: 'Prune very weak edges (seen once, low weight)',
        taskHypo: 'Combine elements to guess new links (not implemented yet)',
        protect: 'Never touch what you corrected by hand',
        protectHint: 'Elements and edges you explicitly corrected stay untouched.',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        failed: 'Save failed',
        reload: 'Reload',
        today: 'Spent today',
        idleNow: 'Idle now',
        lastDream: 'Last tidy',
        never: 'never',
        none: '(unavailable)',
        yuan: 'CNY',
        minutes: 'min',
      },
    }
    const pickStrings = () => (String(navigator.language || '').toLowerCase().startsWith('zh') ? STRINGS.zh : STRINGS.en)

    const box = {
      display: 'grid',
      gap: 6,
      padding: '14px 16px',
      borderRadius: 12,
      border: '1px solid rgba(127,127,127,.28)',
      background: 'rgba(127,127,127,.05)',
    }
    const rowLabel = { fontWeight: 600, fontSize: 14 }
    const hint = { opacity: 0.66, fontSize: 12, lineHeight: 1.5 }
    const input = {
      font: 'inherit',
      color: 'inherit',
      background: 'rgba(127,127,127,.10)',
      border: '1px solid rgba(127,127,127,.35)',
      borderRadius: 8,
      padding: '6px 10px',
      width: 120,
    }
    const wideInput = { ...input, width: '100%', maxWidth: 560 }
    const button = {
      font: 'inherit',
      color: 'inherit',
      cursor: 'pointer',
      background: 'rgba(127,127,127,.16)',
      border: '1px solid rgba(127,127,127,.4)',
      borderRadius: 8,
      padding: '6px 16px',
    }
    const chip = { fontSize: 12, opacity: 0.8 }

    function numberField(value, onChange, min, max) {
      return h('input', {
        type: 'number',
        style: input,
        min,
        max,
        value: Number.isFinite(value) ? value : '',
        onChange: (e) => {
          const n = Number(e.target.value)
          onChange(Number.isFinite(n) ? n : 0)
        },
      })
    }

    function check(label, checked, onChange) {
      return h('label', { style: { display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, lineHeight: 1.5 } },
        h('input', { type: 'checkbox', checked, onChange: (e) => onChange(e.target.checked), style: { marginTop: 3 } }),
        h('span', null, label))
    }

    function Settings() {
      const t = pickStrings()
      const [data, setData] = useState(null)
      const [draft, setDraft] = useState(null)
      const [msg, setMsg] = useState('')
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        try {
          const res = await fetch(`${API}/config`, { cache: 'no-store' })
          const body = await res.json()
          if (body.ok === true) {
            setData(body)
            setDraft(body.config)
            setMsg('')
          } else {
            setMsg(`${t.failed}: ${body.error ?? ''}`)
          }
        } catch (err) {
          setMsg(`${t.none} ${String(err && err.message ? err.message : err)}`)
        }
      }, [t])

      useEffect(() => { load() }, [load])

      const patch = useCallback((fn) => {
        setDraft((cur) => {
          if (cur === null) return cur
          const next = JSON.parse(JSON.stringify(cur))
          fn(next)
          return next
        })
        setMsg('')
      }, [])

      const save = useCallback(async () => {
        if (draft === null) return
        setBusy(true)
        setMsg(t.saving)
        try {
          const res = await fetch(`${API}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ patch: draft }),
          })
          const body = await res.json()
          if (body.ok === true) {
            setData((cur) => (cur === null ? cur : { ...cur, config: body.config }))
            setDraft(body.config)
            setMsg(t.saved)
          } else {
            setMsg(`${t.failed}: ${body.error ?? ''}`)
          }
        } catch (err) {
          setMsg(`${t.failed}: ${String(err && err.message ? err.message : err)}`)
        } finally {
          setBusy(false)
        }
      }, [draft, t])

      if (draft === null) {
        return h('div', { style: { padding: 24, fontSize: 14 } }, msg || '…')
      }

      const usage = (data && data.usage) || {}
      const state = (data && data.state) || {}
      const idleMin = data && typeof data.idleSec === 'number' ? Math.round(data.idleSec / 60) : null

      return h('div', { style: { display: 'grid', gap: 14, padding: '4px 2px 28px', maxWidth: 720 } },
        h('div', null,
          h('div', { style: { fontSize: 18, fontWeight: 700 } }, t.title),
          h('div', { style: { ...hint, marginTop: 6 } }, t.desc)),

        h('div', { style: { ...box, gap: 4, fontSize: 12 } },
          h('div', null, `${t.today}: ${typeof usage.cny === 'number' ? usage.cny.toFixed(2) : '0.00'} ${t.yuan}`),
          h('div', null, `${t.idleNow}: ${idleMin === null ? t.none : `${idleMin} ${t.minutes}`}`),
          h('div', null, `${t.lastDream}: ${state.lastRunAt ? String(state.lastRunAt).slice(0, 16).replace('T', ' ') : t.never}`)),

        h('div', { style: box },
          h('div', { style: rowLabel }, t.idle),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            numberField(draft.idle.systemIdleMinutes, (n) => patch((d) => { d.idle.systemIdleMinutes = n }), 1, 240),
            h('span', { style: chip }, t.minutes)),
          h('div', { style: hint }, t.idleHint)),

        h('div', { style: box },
          h('div', { style: rowLabel }, t.gap),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            numberField(draft.idle.minGapMinutes, (n) => patch((d) => { d.idle.minGapMinutes = n }), 0, 1440),
            h('span', { style: chip }, t.minutes)),
          h('div', { style: hint }, t.gapHint)),

        h('div', { style: box },
          h('div', { style: rowLabel }, t.model),
          h('select', {
            style: wideInput,
            value: draft.models.mode,
            onChange: (e) => patch((d) => { d.models.mode = e.target.value }),
          },
            h('option', { value: 'local' }, t.modelLocal),
            h('option', { value: 'paid' }, t.modelPaid),
            h('option', { value: 'off' }, t.modelOff))),

        h('div', { style: box },
          h('div', { style: rowLabel }, t.budget),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            numberField(draft.models.paid.budgetPerNightCny, (n) => patch((d) => { d.models.paid.budgetPerNightCny = n }), 0, 100),
            h('span', { style: chip }, t.yuan)),
          h('div', { style: hint }, t.budgetHint)),

        h('div', { style: box },
          h('div', { style: rowLabel }, t.tasks),
          check(t.taskMerge, draft.tasks.merge, (v) => patch((d) => { d.tasks.merge = v })),
          check(t.taskSimplify, draft.tasks.simplify, (v) => patch((d) => { d.tasks.simplify = v })),
          check(t.taskCompact, draft.tasks.compact, (v) => patch((d) => { d.tasks.compact = v })),
          check(t.taskHypo, draft.tasks.hypothesize, (v) => patch((d) => { d.tasks.hypothesize = v }))),

        h('div', { style: box },
          check(t.protect, draft.protect.allowTouchLocked !== true, (v) => patch((d) => { d.protect.allowTouchLocked = !v })),
          h('div', { style: hint }, t.protectHint)),

        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
          h('button', { style: button, disabled: busy, onClick: save }, busy ? t.saving : t.save),
          h('button', { style: button, disabled: busy, onClick: load }, t.reload),
          h('span', { style: chip }, msg)))
    }

    const CSS = `
.dsh-slow-wave-settings input[type="number"] { -moz-appearance: textfield; }
.dsh-slow-wave-settings input[type="number"]::-webkit-outer-spin-button,
.dsh-slow-wave-settings input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.dsh-slow-wave-settings select option { color: #111; }
`

    /**
     * 潜意识梦面板。
     *
     * 刻意和「大肥鱼 → 住所 → 她做过的梦」分开：
     *   · 那张卡是她醒来后自己记的一句（她的工具 her_dream）
     *   · 这张卡是本插件在她睡着时拼出来的（她没参与）
     * 两块数据各存各的，互不覆盖，也不共用同一个开关。
     */
    function DreamPanel() {
      const t = dreamStrings()
      const [draft, setDraft] = useState(null)
      const [list, setList] = useState([])
      const [stats, setStats] = useState({})
      const [deps, setDeps] = useState(null)
      const [msg, setMsg] = useState('')
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        try {
          const res = await fetch(`${API}/dreams`)
          const body = await res.json()
          if (body && body.ok) {
            setDraft(body.dream || { enabled: true, minGapDays: 2, narrate: 'always' })
            setList(Array.isArray(body.list) ? body.list : [])
            setStats(body.stats || {})
            setDeps(body.deps || null)
          } else {
            setMsg(`${t.failed}: ${(body && body.error) || ''}`)
          }
        } catch (err) {
          setMsg(`${t.failed}: ${String(err && err.message ? err.message : err)}`)
        }
      }, [t])

      useEffect(() => { load() }, [load])

      const patch = (fn) =>
        setDraft((cur) => {
          if (cur === null) return cur
          const next = JSON.parse(JSON.stringify(cur))
          fn(next)
          return next
        })

      const save = useCallback(async () => {
        if (draft === null) return
        setBusy(true)
        setMsg(t.saving)
        try {
          const res = await fetch(`${API}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ patch: { dream: draft } }),
          })
          const body = await res.json()
          setMsg(body && body.ok ? t.saved : `${t.failed}: ${(body && body.error) || ''}`)
        } catch (err) {
          setMsg(`${t.failed}: ${String(err && err.message ? err.message : err)}`)
        } finally {
          setBusy(false)
        }
      }, [draft, t])

      if (draft === null) return h('div', { style: { padding: 24, fontSize: 14 } }, msg || '…')

      return h('div', { style: { display: 'grid', gap: 14, padding: '4px 2px 28px', maxWidth: 720 } },
        h('div', null,
          h('div', { style: { fontSize: 18, fontWeight: 700 } }, t.title),
          h('div', { style: { ...hint, marginTop: 6 } }, t.desc),
          h('div', { style: { ...hint, marginTop: 6, opacity: 0.55 } }, t.diff)),

        // 依赖一栏：缺哪样、缺了会怎样，直接写在面板上，
        // 不让人去 README 里翻——装完发现不灵，绝大多数是这里。
        deps
          ? h('div', { style: box },
            h('div', { style: rowLabel }, t.deps),
            h('div', { style: { marginTop: 8, display: 'grid', gap: 6 } },
              [
                [t.depFish, deps.fish],
                [t.depMemory, deps.memory],
                [t.depModel, deps.model],
              ].map(([label, d]) =>
                h('div', { key: label, style: { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 13 } },
                  h('span', { style: { ...chip, background: d && d.ok ? '#1f6f43' : '#7a2c2c' } },
                    d && d.ok ? t.depOk : t.depMissing),
                  h('span', null, label),
                  d && d.effect
                    ? h('span', { style: { ...hint, opacity: 0.6 } }, d.ok ? '' : d.effect)
                    : null))),
            h('div', { style: { ...hint, marginTop: 8, opacity: 0.55 } }, t.depWarn))
          : null,

        h('div', { style: box },
          h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 } },
            h('input', {
              type: 'checkbox',
              checked: draft.enabled !== false,
              onChange: (e) => patch((d) => { d.enabled = e.target.checked }),
            }),
            h('span', null, t.on))),

        h('div', { style: box },
          h('div', { style: rowLabel }, t.gap),
          h('div', { style: { marginTop: 6 } },
            numberField(draft.minGapDays, (n) => patch((d) => { d.minGapDays = Math.max(1, n) }), 1, 30)),
          h('div', { style: { ...hint, marginTop: 4 } }, t.gapHint)),

        h('div', { style: box },
          h('div', { style: rowLabel }, t.narrate),
          h('select', {
            style: { ...input, width: '100%', maxWidth: 420, marginTop: 6 },
            value: draft.narrate || 'always',
            onChange: (e) => patch((d) => { d.narrate = e.target.value }),
          },
            h('option', { value: 'always' }, t.narrateAlways),
            h('option', { value: 'ask' }, t.narrateAsk),
            h('option', { value: 'never' }, t.narrateNever))),

        h('div', { style: box },
          h('div', { style: rowLabel }, `${t.list}（${stats.total ?? list.length}）`),
          list.length
            ? h('div', { style: { marginTop: 8, display: 'grid', gap: 8 } },
              list.map((d, i) => h('div', { key: `${d.date || ''}-${i}`, style: { fontSize: 13, lineHeight: 1.6 } },
                h('span', { style: { ...chip, marginRight: 8 } }, d.date || ''),
                h('span', null, d.text || ''),
                d.score != null ? h('span', { style: { ...chip, marginLeft: 8 } }, `${d.score}`) : null)))
            : h('div', { style: { ...hint, marginTop: 6 } }, t.none),
          stats.discarded
            ? h('div', { style: { ...hint, marginTop: 8 } }, `${t.discarded}：${stats.discarded}`)
            : null),

        h('div', { style: { display: 'flex', gap: 10, alignItems: 'center' } },
          h('button', { style: button, disabled: busy, onClick: save }, t.save),
          h('span', { style: chip }, msg)))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 一张卡，两件事：上面是睡眠整理，下面是潜意识梦。
        // 2026-11-07 用户定名「忆鲸鲸 · 潜意识」——合并成一张，不再分两个侧栏条目，
        // 因为对外它们是同一个能力：睡着的时候它在想什么。
        ctx.slots.inject('settings.section', function* () {
          yield ctx.slots.register({
            name: 'settings.section',
            id: 'deepsleep-config',
            order: 45,
            label: () => pickStrings().title,
          }, function Wrapper() {
            return h('div', { className: 'dsh-slow-wave-settings' },
              h('style', null, CSS),
              h(Settings, null),
              h('hr', { style: { margin: '22px 0', border: 0, borderTop: '1px solid rgba(255,255,255,0.12)' } }),
              h(DreamPanel, null))
          })
        })
      },
    }
  },
})
