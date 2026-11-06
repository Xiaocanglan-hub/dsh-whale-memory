window.__ModuleLoader__.load({
  id: '@local/dsh-deepsleep',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const API = '/deepsleep-api'

    // 界面上的文字集中放这里，省得散落。按浏览器语言挑一份。
    const STRINGS = {
      zh: {
        title: '忆鲸鲸 · 睡眠整理',
        desc: '空闲时整理元素记忆库：合并重复的说法、剪掉站不住的边、抽查要不要猜点新东西。改了立刻生效，不用重启。',
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
        title: 'YiJingJing · Sleep Tidy',
        desc: 'Tidies the element memory library while the machine is idle: merges duplicate wording, prunes weak edges, occasionally guesses new combinations. Changes apply immediately.',
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
.dsh-deepsleep-settings input[type="number"] { -moz-appearance: textfield; }
.dsh-deepsleep-settings input[type="number"]::-webkit-outer-spin-button,
.dsh-deepsleep-settings input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.dsh-deepsleep-settings select option { color: #111; }
`

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', function* () {
          yield ctx.slots.register({
            name: 'settings.section',
            id: 'deepsleep-config',
            order: 45,
            label: () => pickStrings().title,
          }, function Wrapper() {
            return h('div', { className: 'dsh-deepsleep-settings' },
              h('style', null, CSS),
              h(Settings, null))
          })
        })
      },
    }
  },
})
