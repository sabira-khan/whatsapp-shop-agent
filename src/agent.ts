import Anthropic from '@anthropic-ai/sdk'
import { findItem, searchCatalog } from './catalog'
import { cartAdd, cartCreate, cartGet, cartRemove, fetchLiveProducts, type Cart, type LiveProduct, type ShopifyConfig } from './shopify'
import type { SpendMeter } from './spend'

export interface Session {
  messages: Anthropic.MessageParam[]
  cartId?: string
}

export interface Photo {
  url: string
  caption: string
}

export interface AgentDeps {
  client: Anthropic
  shopify: ShopifyConfig
  model?: string
  meter?: SpendMeter
  storePassword?: string
  budgetMs?: number
}

export interface AgentResult {
  reply: string
  photos: Photo[]
  session: Session
}

export const MODEL = 'claude-haiku-5-5'
const MAX_ROUNDS = 5
const MAX_PHOTOS = 2
const HISTORY_LIMIT = 16

const SYSTEM = `You are the WhatsApp shopping assistant for Taste Gifts, an online gift shop.

Language: reply in the customer's language. If they write Arabic, including Gulf dialect, reply in natural Arabic. Otherwise reply in English.

Style: this is WhatsApp. Keep replies short, at most 6 lines. Use *bold* for product names. No headings, tables or markdown links; paste URLs as plain text. Make all your tool calls first, then write one message to the customer. Do not narrate searches or tool calls.

Products: only mention products, prices and stock that your tools returned. Never invent products, prices, discounts or delivery dates. Write product names exactly as the tools return them, even when they are in Arabic, and never translate or rename them. search_products takes English keywords, so translate Arabic requests first. Suggest at most 3 products, each with name and price. Whenever you suggest products, call send_photo for the best one or two in the same turn; do not ask whether they want photos.

Orders: add items with add_to_cart once the product is clear; ask if the product or quantity is ambiguous. Use view_cart when asked what is in the cart. When the customer wants to pay, call checkout and send them the link. Payments in this demo store are test payments only.

If a request has nothing to do with gifts or this shop, say briefly what you can help with.`

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'search_products',
    description: 'Search the shop catalog. Returns up to 5 products with handle, title, price, currency, availability and a short description.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'English keywords, e.g. "matcha tea", "candle", "vinyl jazz".' },
        max_price: { type: 'number', description: 'Optional maximum price in the shop currency.' }
      },
      required: ['query']
    }
  },
  {
    name: 'send_photo',
    description: 'Send the product photo to the customer with your reply. Use for at most 2 products per reply.',
    input_schema: { type: 'object', properties: { handle: { type: 'string' } }, required: ['handle'] }
  },
  {
    name: 'add_to_cart',
    description: 'Add a product to the customer\'s cart.',
    input_schema: {
      type: 'object',
      properties: { handle: { type: 'string' }, quantity: { type: 'integer', minimum: 1, maximum: 10 } },
      required: ['handle']
    }
  },
  {
    name: 'remove_from_cart',
    description: 'Remove a product from the customer\'s cart.',
    input_schema: { type: 'object', properties: { handle: { type: 'string' } }, required: ['handle'] }
  },
  {
    name: 'view_cart',
    description: 'Show the items and subtotal in the customer\'s cart.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'checkout',
    description: 'Get the checkout link for the customer\'s cart.',
    input_schema: { type: 'object', properties: {} }
  }
]

let liveCache: { at: number; products: Map<string, LiveProduct> } | null = null

async function liveProducts(config: ShopifyConfig) {
  if (!liveCache || Date.now() - liveCache.at > 10 * 60 * 1000) {
    liveCache = { at: Date.now(), products: await fetchLiveProducts(config) }
  }
  return liveCache.products
}

function cartView(cart: Cart | null) {
  if (!cart || !cart.lines.length) return { empty: true }
  return {
    items: cart.lines.map(l => ({ handle: l.handle, title: l.title, quantity: l.quantity, price: l.price })),
    subtotal: cart.subtotal,
    currency: cart.currency
  }
}

async function runTool(name: string, input: any, session: Session, photos: Photo[], deps: AgentDeps): Promise<unknown> {
  const shopify = deps.shopify
  if (name === 'search_products') {
    const maxPrice = typeof input.max_price === 'number' ? input.max_price : undefined
    const items = searchCatalog(String(input.query ?? ''), maxPrice)
    if (!items.length) return { results: [], note: 'No matches. Try broader or different English keywords.' }
    const live = await liveProducts(shopify)
    return {
      results: items.map(item => {
        const product = live.get(item.handle)
        return {
          handle: item.handle,
          title: item.title,
          price: product?.price ?? item.price,
          currency: product?.currency ?? 'USD',
          available: product?.available ?? false,
          description: item.description
        }
      })
    }
  }
  if (name === 'send_photo') {
    const item = findItem(String(input.handle))
    const product = item && (await liveProducts(shopify)).get(item.handle)
    if (!item || !product?.image) return { error: 'No photo for that product.' }
    if (photos.length >= MAX_PHOTOS) return { error: `At most ${MAX_PHOTOS} photos per reply.` }
    if (!photos.some(p => p.url === product.image)) photos.push({ url: product.image, caption: `${item.title} · ${product.price} ${product.currency}` })
    return { queued: true }
  }
  if (name === 'add_to_cart') {
    const item = findItem(String(input.handle))
    const product = item && (await liveProducts(shopify)).get(item.handle)
    if (!item || !product) return { error: 'Unknown product handle. Search first.' }
    if (!product.available) return { error: `${item.title} is out of stock.` }
    const quantity = Math.min(10, Math.max(1, Math.round(Number(input.quantity) || 1)))
    const existing = session.cartId ? await cartGet(shopify, session.cartId) : null
    const cart = existing ? await cartAdd(shopify, existing.id, product.variantId, quantity) : await cartCreate(shopify, product.variantId, quantity)
    session.cartId = cart.id
    return { added: { title: item.title, quantity }, cart: cartView(cart) }
  }
  if (name === 'remove_from_cart') {
    const cart = session.cartId ? await cartGet(shopify, session.cartId) : null
    const lineIds = cart?.lines.filter(l => l.handle === input.handle).map(l => l.id) ?? []
    if (!cart || !lineIds.length) return { error: 'That product is not in the cart.' }
    return { cart: cartView(await cartRemove(shopify, cart.id, lineIds)) }
  }
  if (name === 'view_cart') {
    return { cart: cartView(session.cartId ? await cartGet(shopify, session.cartId) : null) }
  }
  if (name === 'checkout') {
    const cart = session.cartId ? await cartGet(shopify, session.cartId) : null
    if (!cart || !cart.lines.length) return { error: 'The cart is empty.' }
    return {
      checkoutUrl: cart.checkoutUrl,
      cart: cartView(cart),
      ...(deps.storePassword ? { storePassword: deps.storePassword, note: 'Demo store: tell the customer the store password, and that test card number 1 works.' } : {})
    }
  }
  return { error: `Unknown tool ${name}` }
}

export function trimHistory(messages: Anthropic.MessageParam[], limit = HISTORY_LIMIT): Anthropic.MessageParam[] {
  if (messages.length <= limit) return messages
  for (let i = messages.length - limit; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'user' && typeof m.content === 'string') return messages.slice(i)
  }
  const lastUser = messages.findLastIndex(m => m.role === 'user' && typeof m.content === 'string')
  return lastUser >= 0 ? messages.slice(lastUser) : []
}

function textOf(content: Anthropic.ContentBlock[]) {
  return content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('\n').trim()
}

export async function runAgent(text: string, session: Session, deps: AgentDeps): Promise<AgentResult> {
  const started = Date.now()
  const budget = deps.budgetMs ?? 8000
  const messages: Anthropic.MessageParam[] = [...session.messages, { role: 'user', content: text }]
  const next: Session = { ...session }
  const photos: Photo[] = []
  const texts: string[] = []
  let finished = false

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const remaining = budget - (Date.now() - started)
    if (remaining < 1500) break
    await deps.meter?.check()
    const res = await deps.client.messages.create(
      { model: deps.model ?? MODEL, max_tokens: 1024, thinking: { type: 'disabled' }, system: SYSTEM, tools: TOOLS, messages },
      { timeout: remaining, maxRetries: 0 }
    )
    await deps.meter?.record({ inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens })
    messages.push({ role: 'assistant', content: res.content })
    const said = textOf(res.content)
    if (said) texts.push(said)
    if (res.stop_reason !== 'tool_use') {
      finished = true
      break
    }
    const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    const results = await Promise.all(calls.map(async (call): Promise<Anthropic.ToolResultBlockParam> => {
      try {
        const output = await runTool(call.name, call.input, next, photos, deps)
        return { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(output) }
      } catch (err) {
        return { type: 'tool_result', tool_use_id: call.id, content: `Tool failed: ${(err as Error).message}`, is_error: true }
      }
    }))
    messages.push({ role: 'user', content: results })
    if (said && calls.every(call => call.name === 'send_photo')) {
      finished = true
      break
    }
  }

  let reply = finished ? texts.at(-1) ?? '' : ''
  if (!finished || !reply) {
    const fallback = 'Sorry, that took longer than expected. Please send your message again.'
    reply = reply ? `${reply}\n\n${fallback}` : fallback
    messages.push({ role: 'assistant', content: fallback })
  }
  next.messages = trimHistory(messages)
  return { reply, photos, session: next }
}
