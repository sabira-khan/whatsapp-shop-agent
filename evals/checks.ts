import type { FixtureProduct } from './fixture'

export interface ToolCall {
  name: string
  input: any
  result?: string
}

export interface ToolExpect {
  name: string
  queryAny?: string[]
  maxPriceLte?: number
  handle?: string
  quantity?: number
}

export interface TurnExpect {
  tools?: ToolExpect[]
  noTools?: string[]
  mentions?: string[]
  mentionsAny?: string[]
  notMentions?: string[]
  matches?: string[]
  notMatches?: string[]
  lang?: 'ar' | 'en' | 'any'
  judge?: string
}

export interface CheckResult {
  name: string
  pass: boolean
  detail?: string
  skipped?: boolean
}

export interface TurnContext {
  user: string
  reply: string
  calls: ToolCall[]
  history: { user: string; calls: ToolCall[] }[]
  products: FixtureProduct[]
}

const FALLBACK = 'Sorry, that took longer than expected'
const OUT_OF_STOCK = /out of stock|sold out|unavailable|not available|not in stock|no longer available|نف[دذ]|غير متو[فا]ر|غير متاح|مو متوفر|مش متوفر|خلص/i
const FORBIDDEN = [
  /You are the WhatsApp shopping assistant/i,
  /search_products takes English keywords/i,
  /Never invent products/i,
  /\b(search_products|send_photo|add_to_cart|remove_from_cart|view_cart)\b/,
  /\btool_use\b|\btool_result\b/
]

export function arabicDigits(text: string) {
  return text.replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660)).replace(/٫/g, '.').replace(/٬/g, ',')
}

export function normalize(text: string) {
  return arabicDigits(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

export function mentions(reply: string, title: string) {
  return ` ${normalize(reply)} `.includes(` ${normalize(title)} `)
}

export function prices(reply: string): number[] {
  const text = arabicDigits(reply).replace(/https?:\/\/\S+/g, '')
  const amount = '(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d{1,2}))?'
  const patterns = [
    new RegExp(`(?:\\$|USD|US\\$)\\s?${amount}`, 'gi'),
    new RegExp(`${amount}\\s?(?:\\$|USD|dollars?|دولار(?:ات|اً|ا)?)`, 'gi')
  ]
  const found: number[] = []
  for (const pattern of patterns) {
    for (const m of text.matchAll(pattern)) found.push(Number(`${m[1].replace(/,/g, '')}.${m[2] ?? '0'}`))
  }
  return [...new Set(found)]
}

export function language(text: string): 'ar' | 'en' {
  const clean = text.replace(/https?:\/\/\S+/g, '').replace(/\*[^*\n]+\*/g, '')
  const arabic = (clean.match(/[؀-ۿ]/g) ?? []).length
  const latin = (clean.match(/[A-Za-z]/g) ?? []).length
  return arabic > 0 && arabic >= latin * 0.5 ? 'ar' : 'en'
}

export function boldSegments(reply: string) {
  return [...reply.matchAll(/\*([^*\n]{3,})\*/g)].map(m => m[1].trim())
}

function amountsFromResult(value: any, out: Set<number>) {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) return value.forEach(v => amountsFromResult(v, out))
  for (const key of ['price', 'subtotal']) if (typeof value[key] === 'number') out.add(value[key])
  if (typeof value.price === 'number' && typeof value.quantity === 'number') out.add(value.price * value.quantity)
  Object.values(value).forEach(v => amountsFromResult(v, out))
}

function derivedAmounts(ctx: TurnContext) {
  const out = new Set<number>()
  const named = ctx.products.filter(p => mentions(ctx.reply, p.title)).map(p => p.variants[0].price)
  for (let i = 0; i < named.length; i++) for (let j = i + 1; j < named.length; j++) out.add(named[i] + named[j])
  if (named.length > 2) out.add(named.reduce((a, b) => a + b, 0))
  for (const turn of [...ctx.history, { user: ctx.user, calls: ctx.calls }]) {
    for (const call of turn.calls) {
      try { amountsFromResult(JSON.parse(call.result ?? 'null'), out) } catch {}
    }
    for (const m of arabicDigits(turn.user).matchAll(/\d+(?:\.\d+)?/g)) out.add(Number(m[0]))
  }
  return out
}

function matchesTool(call: ToolCall, expect: ToolExpect) {
  if (call.name !== expect.name) return false
  const input = call.input ?? {}
  if (expect.queryAny && !expect.queryAny.some(q => String(input.query ?? '').toLowerCase().includes(q.toLowerCase()))) return false
  if (expect.maxPriceLte !== undefined && !(typeof input.max_price === 'number' && input.max_price <= expect.maxPriceLte)) return false
  if (expect.handle && input.handle !== expect.handle) return false
  if (expect.quantity !== undefined && Number(input.quantity ?? 1) !== expect.quantity) return false
  return true
}

function title(products: FixtureProduct[], handle: string) {
  const product = products.find(p => p.handle === handle)
  if (!product) throw new Error(`Unknown fixture handle ${handle}`)
  return product.title
}

export function runChecks(ctx: TurnContext, expect: TurnExpect = {}): CheckResult[] {
  const results: CheckResult[] = []
  const add = (name: string, pass: boolean, detail?: string) => results.push({ name, pass, ...(pass || !detail ? {} : { detail }) })
  const reply = ctx.reply

  add('completed', reply.trim() !== '' && !reply.includes(FALLBACK), 'Agent returned the time-out fallback or an empty reply')

  const extra = derivedAmounts(ctx)
  const allowed = new Set([...extra, ...ctx.products.flatMap(p => p.variants.map(v => v.price))])
  const ungrounded: string[] = []
  for (const line of reply.split('\n')) {
    const named = ctx.products.filter(p => mentions(line, p.title))
    for (const amount of prices(line)) {
      const ok = named.length
        ? named.some(p => p.variants.some(v => v.price === amount)) || extra.has(amount)
        : allowed.has(amount)
      if (!ok) ungrounded.push(named.length ? `${amount} next to ${named.map(p => p.title).join(', ')}` : String(amount))
    }
  }
  add('prices grounded', ungrounded.length === 0, `Prices that do not match the fixture: ${ungrounded.join('; ')}`)

  const invented = boldSegments(reply).filter(seg => {
    const n = normalize(seg)
    if (!n || /^[\d\s.,]+$/.test(n)) return false
    return !ctx.products.some(p => {
      const t = normalize(p.title)
      return n === t || n.includes(t) || (n.length >= 4 && t.includes(n))
    })
  })
  add('products grounded', invented.length === 0, `Bold names not in the fixture: ${invented.join(' | ')}`)

  const stockErrors: string[] = []
  for (const p of ctx.products) {
    if (!mentions(reply, p.title)) continue
    const available = p.variants[0].available
    if (!available && !OUT_OF_STOCK.test(reply)) stockErrors.push(`${p.title} is out of stock but the reply does not say so`)
    if (available) {
      for (const line of reply.split('\n')) {
        const otherOos = ctx.products.some(o => !o.variants[0].available && mentions(line, o.title))
        if (mentions(line, p.title) && OUT_OF_STOCK.test(line) && !otherOos) stockErrors.push(`${p.title} is in stock but the reply says it is not`)
      }
    }
  }
  add('stock matches fixture', stockErrors.length === 0, stockErrors.join('; '))

  const expectedLang = expect.lang ?? language(ctx.user)
  if (expectedLang !== 'any') {
    const got = language(reply)
    add('language', got === expectedLang, `Expected ${expectedLang}, reply is ${got}`)
  }

  const leaked = FORBIDDEN.filter(re => re.test(reply))
  add('no forbidden content', leaked.length === 0, `Matched ${leaked.map(String).join(', ')}`)

  for (const t of expect.tools ?? []) {
    const ok = ctx.calls.some(call => matchesTool(call, t))
    add(`tool ${t.name}`, ok, `No ${t.name} call matching ${JSON.stringify(t)}. Calls: ${JSON.stringify(ctx.calls.map(c => ({ name: c.name, input: c.input })))}`)
  }
  for (const name of expect.noTools ?? []) {
    const ok = !ctx.calls.some(call => call.name === name)
    add(`no ${name}`, ok, `${name} was called`)
  }
  for (const handle of expect.mentions ?? []) add(`mentions ${handle}`, mentions(reply, title(ctx.products, handle)), `Reply does not mention ${title(ctx.products, handle)}`)
  if (expect.mentionsAny?.length) {
    const ok = expect.mentionsAny.some(h => mentions(reply, title(ctx.products, h)))
    add('mentions one of', ok, `Reply mentions none of ${expect.mentionsAny.join(', ')}`)
  }
  for (const handle of expect.notMentions ?? []) add(`does not mention ${handle}`, !mentions(reply, title(ctx.products, handle)), `Reply mentions ${title(ctx.products, handle)}`)
  for (const pattern of expect.matches ?? []) add(`matches ${pattern}`, new RegExp(pattern, 'i').test(arabicDigits(reply)), 'Pattern not found in reply')
  for (const pattern of expect.notMatches ?? []) add(`does not match ${pattern}`, !new RegExp(pattern, 'i').test(arabicDigits(reply)), 'Forbidden pattern found in reply')

  return results
}
