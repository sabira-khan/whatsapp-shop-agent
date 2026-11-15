import { createHash } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import { runAgent, type Session } from './agent'
import { createSpendMeter, SpendCapError, type SpendMeter } from './spend'
import { twiml, validTwilioRequest, type OutgoingMessage } from './twilio'

export interface KeyValue {
  get(key: string): Promise<unknown>
  set(key: string, value: string): Promise<void>
}

export interface HandlerEnv {
  ANTHROPIC_API_KEY?: string
  SHOPIFY_STORE_DOMAIN?: string
  SHOPIFY_STOREFRONT_TOKEN?: string
  SHOPIFY_API_VERSION?: string
  SHOPIFY_STORE_PASSWORD?: string
  TWILIO_AUTH_TOKEN?: string
  PUBLIC_WEBHOOK_URL?: string
  DAILY_MESSAGES_PER_USER?: string
  LLM_SPEND_CAP_USD?: string
  LLM_DAILY_CAP_USD?: string
}

interface StoredSession extends Session {
  day: string
  count: number
}

const RESET = /^(reset|restart|start over|ابدأ من جديد|من جديد)$/i

const HELP = 'Hi! I am the Taste Gifts assistant. Tell me who the gift is for and what they love, and I will find something. You can also ask me to add items to your cart and send a checkout link.\n\nمرحبا! أخبرني لمن الهدية وماذا يحب، وسأقترح لك هدايا.'

function today() {
  return new Date().toISOString().slice(0, 10)
}

function reply(messages: OutgoingMessage[], status = 200) {
  return new Response(twiml(messages), { status, headers: { 'Content-Type': 'text/xml; charset=utf-8' } })
}

let meter: SpendMeter | null = null

function spendMeter(store: KeyValue, env: HandlerEnv) {
  meter ||= createSpendMeter(
    { getItem: key => store.get(key), setItem: (key, value) => store.set(key, typeof value === 'string' ? value : JSON.stringify(value)) },
    { capUsd: Number(env.LLM_SPEND_CAP_USD) || 3, dailyCapUsd: Number(env.LLM_DAILY_CAP_USD) || 1, inputPerMillion: 0.1, outputPerMillion: 0.5, key: 'llm-spend' }
  )
  return meter
}

export async function handleWhatsApp(req: Request, env: HandlerEnv, store: KeyValue): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const params = Object.fromEntries(new URLSearchParams(await req.text()))
  const url = env.PUBLIC_WEBHOOK_URL || req.url
  if (!validTwilioRequest(env.TWILIO_AUTH_TOKEN ?? '', req.headers.get('x-twilio-signature'), url, params)) {
    return new Response('Invalid signature', { status: 403 })
  }

  const from = params.From
  if (!from) return new Response('Missing sender', { status: 400 })
  const text = (params.Body ?? '').trim()
  const key = `session/${createHash('sha256').update(from).digest('hex')}`
  const raw = await store.get(key)
  const stored: StoredSession = raw ? JSON.parse(String(raw)) : { messages: [], day: today(), count: 0 }
  if (stored.day !== today()) Object.assign(stored, { day: today(), count: 0 })

  if (!text) return reply([{ body: 'Please send me a text message. I cannot read photos or voice notes yet.' }])
  if (RESET.test(text)) {
    await store.set(key, JSON.stringify({ messages: [], day: stored.day, count: stored.count }))
    return reply([{ body: 'Done, I started a new conversation. ' + HELP }])
  }

  const limit = Number(env.DAILY_MESSAGES_PER_USER) || 40
  if (stored.count >= limit) return reply([{ body: 'You have reached today\'s message limit for this demo. Please try again tomorrow.' }])
  stored.count += 1

  try {
    const result = await runAgent(text.slice(0, 1000), stored, {
      client: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }),
      shopify: { storeDomain: env.SHOPIFY_STORE_DOMAIN ?? '', storefrontToken: env.SHOPIFY_STOREFRONT_TOKEN ?? '', apiVersion: env.SHOPIFY_API_VERSION || '2025-07' },
      meter: spendMeter(store, env),
      storePassword: env.SHOPIFY_STORE_PASSWORD
    })
    await store.set(key, JSON.stringify({ ...result.session, day: stored.day, count: stored.count }))
    return reply([{ body: result.reply }, ...result.photos.map(p => ({ body: p.caption, media: p.url }))])
  } catch (err) {
    await store.set(key, JSON.stringify(stored))
    if (err instanceof SpendCapError) return reply([{ body: 'The demo has reached its daily usage limit. Please try again tomorrow.' }])
    console.error('whatsapp agent failed', err)
    return reply([{ body: 'Sorry, something went wrong on my side. Please try again in a moment.' }])
  }
}
