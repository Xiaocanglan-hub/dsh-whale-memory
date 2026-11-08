/**
 * 让她能自己上网查东西：360（实测最稳）、百度、必应，以及"只搜 B 站"。
 *
 * 为什么不复用别处的搜索：那要引别人插件的内部文件，改一版就崩。
 * 这里只用 Node 自带的 fetch + 正则，坏了大不了返回空，不连累别的功能。
 *
 * 实测（2026-11-08 同一句「GetLastInputInfo 空闲时间」）：
 * - so.com（360）→ 456KB / 命中 74 / 前几条正是 CSDN 与博客园的正文页 ← 唯一可靠的
 * - cn.bing.com / www.bing.com → 200 但返回的是"淘金币""黑料""PDF24"之类完全不相干的结果（反爬投毒）
 * - www.baidu.com → 1.4KB 空壳；site: 限定返回 0 条；结果全是跳转链接，跳到知乎/百科是 403
 * - sogou.com → 5.4KB 壳；贴吧搜索 403 安全验证；DuckDuckGo 国内连不上
 * 所以默认只走 360，其余留着但默认不启用，也不假装它们能用。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Tavily 的 key 存在库外（$DSH_HOME/school/config.json），不进 git。
 * 有 key 就走 Tavily——它是"给 AI 用的搜索"，直接回正文摘录，不用我们再跟反爬斗。
 */
export function tavilyKey() {
  if (process.env.TAVILY_API_KEY) return String(process.env.TAVILY_API_KEY).trim()
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    const cfg = JSON.parse(readFileSync(join(home, 'school', 'config.json'), 'utf8'))
    return String(cfg?.search?.tavilyKey || '').trim()
  } catch {
    return ''
  }
}

async function tavilySearch(query, limit, key) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: key, query, max_results: limit, search_depth: 'basic' }),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const j = await res.json()
  return (j.results || []).map((x) => ({
    title: String(x.title || '').slice(0, 120),
    url: String(x.url || ''),
    snippet: String(x.content || '').slice(0, 160),
  }))
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'
const HEADERS = {
  'user-agent': UA,
  'accept': 'text/html,application/xhtml+xml',
  'accept-language': 'zh-CN,zh;q=0.9',
}

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }

export function clean(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, (m) => ENT[m.toLowerCase()] ?? ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function get(url, timeoutMs = 12000) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
  const html = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return html
}

function bing(html, limit) {
  const out = []
  const re = /<li class="b_algo"[\s\S]*?<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<li class="b_algo"|<\/ol>)/gi
  let m
  while ((m = re.exec(html)) && out.length < limit) {
    const url = m[1]
    const title = clean(m[2])
    const body = clean(m[3]).slice(0, 160)
    if (title && /^https?:/.test(url)) out.push({ title, url, snippet: body })
  }
  return out
}

/**
 * 360 的结果链接是 so.com/link?m=… 跳转，读页前要换成真实地址：
 * 有的跳转带 302，有的直接 200——两种都兜住，解不出来就原样返回，读不动也只是记一笔。
 */
async function resolve(href) {
  if (!/so\.com\/link|baidu\.com\/link/.test(href)) return href
  try {
    const r = await fetch(href, {
      headers: { ...HEADERS, referer: 'https://www.so.com/' },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    })
    const loc = r.headers.get('location')
    if (loc && /^https?:/.test(loc) && !/so\.com\/link/.test(loc)) return loc
    const body = await r.text()
    // 360 的跳转页是一张"脚本页"：里面写着 window.location.replace("真实地址")
    const m =
      body.match(/window\.location\.replace\(\s*["']([^"']+)["']/) ||
      body.match(/http-equiv="refresh"[^>]*content="0;URL='?([^"'>]+)'?/i)
    if (m && /^https?:/.test(m[1]) && !/so\.com\/link/.test(m[1])) return m[1]
    return href
  } catch {
    return href
  }
}

function so360(html, limit) {
  const out = []
  const re = /<h3[^>]*class="res-title[^"]*"[^>]*>([\s\S]*?)<\/h3>/gi
  let m
  while ((m = re.exec(html)) && out.length < limit) {
    const block = m[1]
    const href = (block.match(/href="([^"]+)"/) || [])[1] || ''
    const title = clean(block)
    if (!title || !href) continue
    if (!/^https?:|^\/link\?/.test(href)) continue
    out.push({ title, url: /^\/link\?/.test(href) ? `https://www.so.com${href}` : href, snippet: '' })
  }
  return out
}

function baidu(html, limit) {
  const out = []
  const re = /<div class="result[^"]*"[\s\S]*?<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<div class="result|<div id="page")/gi
  let m
  while ((m = re.exec(html)) && out.length < limit) {
    const title = clean(m[2])
    const body = clean(m[3]).slice(0, 160)
    const url = m[1]
    if (title) out.push({ title, url: /^https?:/.test(url) ? url : `https://www.baidu.com${url}`, snippet: body })
  }
  return out
}

function bili(items, limit) {
  const out = []
  for (const v of items) {
    if (out.length >= limit) break
    const title = clean(String(v.title || '').replace(/<\/?em[^>]*>/gi, ''))
    if (!title || !v.bvid) continue
    const meta = [v.author, v.play ? `${v.play} 播放` : ''].filter(Boolean).join(' · ')
    const snippet = [meta, clean(String(v.description || ''))].filter(Boolean).join(' — ').slice(0, 160)
    out.push({ title, url: `https://www.bilibili.com/video/${v.bvid}`, snippet })
  }
  return out
}

export const SOURCES = {
  tavily: {
    label: 'Tavily',
    run: async (q, limit) => {
      const key = tavilyKey()
      if (!key) throw new Error('没配 Tavily key')
      return tavilySearch(q, limit, key)
    },
  },
  so360: {
    label: '360',
    run: async (q, limit) => {
      const hits = so360(await get(`https://www.so.com/s?q=${encodeURIComponent(q)}`), limit)
      for (const h of hits) h.url = await resolve(h.url)
      return hits
    },
  },
  bing: {
    label: '必应',
    // 2026-11-08 实测：cn.bing.com 对技术词返回一堆"Windows 官网/下载中心"，
    // 换成国际站同一次查询能命中 22 处，所以固定走 www.bing.com。
    run: async (q, limit) => bing(await get(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en&cc=US`), limit),
  },
  baidu: {
    label: '百度',
    run: async (q, limit) => baidu(await get(`https://www.baidu.com/s?wd=${encodeURIComponent(q)}`), limit),
  },
  bili: {
    label: 'B 站',
    run: async (q, limit) => {
      // B 站自己的搜索接口，不需要 wbi 签名（2026-11-08 实测 code 0）
      const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(q)}`
      const res = await fetch(url, {
        headers: { ...HEADERS, accept: 'application/json', referer: 'https://search.bilibili.com/' },
        signal: AbortSignal.timeout(12000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json()
      if (j.code !== 0) throw new Error(j.message || `B 站返回 ${j.code}`)
      return bili(j?.data?.result || [], limit)
    },
  },
}

/**
 * 查一次。哪个源挂了就记下来，其他源照常返回——永远不抛。
 * @returns {Promise<{hits: Array<{source,title,url,snippet}>, failed: Array<{source,error}>}>}
 */
export async function search(query, { sources = ['bing', 'bili'], limit = 5 } = {}) {
  const hits = []
  const failed = []
  for (const key of sources) {
    const src = SOURCES[key]
    if (!src) {
      failed.push({ source: key, error: '没有这个源' })
      continue
    }
    try {
      const list = await src.run(query, limit)
      for (const h of list) hits.push({ source: src.label, ...h })
    } catch (e) {
      failed.push({ source: src.label, error: e.name === 'TimeoutError' ? '超时' : String(e.message || e).slice(0, 60) })
    }
  }
  return { hits, failed }
}

/** 打开一个网页，把标签剥掉，只留前 maxChars 个字 */
export async function readPage(url, { maxChars = 3000, timeoutMs = 15000 } = {}) {
  const html = await get(url, timeoutMs)
  const title = clean((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '')
  return { title, text: clean(html).slice(0, maxChars) }
}
