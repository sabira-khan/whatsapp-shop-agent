import { test } from 'node:test'
import assert from 'node:assert/strict'
import type Anthropic from '@anthropic-ai/sdk'
import { trimHistory } from '../src/agent'
import { searchCatalog } from '../src/catalog'
import { handleWhatsApp, type KeyValue } from '../src/handler'
import { twiml, twilioSignature, validTwilioRequest } from '../src/twilio'

const URL_ = 'https://example.netlify.app/api/whatsapp'

test('twilio signature round trip and tamper detection', () => {
  const params = { From: 'whatsapp:+96550000000', Body: 'hello' }
  const sig = twilioSignature('secret', URL_, params)
  assert.ok(validTwilioRequest('secret', sig, URL_, params))
  assert.ok(!validTwilioRequest('secret', sig, URL_, { ...params, Body: 'hellO' }))
  assert.ok(!validTwilioRequest('other', sig, URL_, params))
  assert.ok(!validTwilioRequest('', sig, URL_, params))
  assert.ok(!validTwilioRequest('secret', null, URL_, params))
})

test('twiml escapes text and attaches media', () => {
  const xml = twiml([{ body: 'Tea & <cups>' }, { body: 'Bowl', media: 'https://cdn.example.com/a.jpg?x=1&y=2' }])
  assert.match(xml, /<Body>Tea &amp; &lt;cups&gt;<\/Body>/)
  assert.match(xml, /<Media>https:\/\/cdn.example.com\/a.jpg\?x=1&amp;y=2<\/Media>/)
})

test('catalog search ranks relevant products and respects max price', () => {
  const matcha = searchCatalog('matcha tea')
  assert.ok(matcha.length > 0)
  assert.match(matcha[0].title.toLowerCase(), /matcha|tea/)
  const cheap = searchCatalog('tea', 20)
  assert.ok(cheap.every(p => p.price <= 20))
  assert.deepEqual(searchCatalog('the for a'), [])
})

test('trimHistory starts at a plain user message', () => {
  const messages: Anthropic.MessageParam[] = []
  for (let i = 0; i < 10; i++) {
    messages.push({ role: 'user', content: `q${i}` })
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'view_cart', input: {} }] })
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: '{}' }] })
    messages.push({ role: 'assistant', content: `a${i}` })
  }
  const trimmed = trimHistory(messages, 10)
  assert.ok(trimmed.length <= 10)
  assert.equal(trimmed[0].role, 'user')
  assert.equal(typeof trimmed[0].content, 'string')
})

function memoryStore(): KeyValue & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, get: async k => data.get(k) ?? null, set: async (k, v) => void data.set(k, v) }
}

function signedRequest(params: Record<string, string>, token = 'tok') {
  return new Request(URL_, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilioSignature(token, URL_, params) },
    body: new URLSearchParams(params).toString()
  })
}

test('handler rejects unsigned requests', async () => {
  const req = new Request(URL_, { method: 'POST', body: 'From=x&Body=hi' })
  const res = await handleWhatsApp(req, { TWILIO_AUTH_TOKEN: 'tok' }, memoryStore())
  assert.equal(res.status, 403)
})

test('handler resets the conversation without calling the model', async () => {
  const store = memoryStore()
  const res = await handleWhatsApp(signedRequest({ From: 'whatsapp:+1', Body: 'reset' }), { TWILIO_AUTH_TOKEN: 'tok' }, store)
  assert.equal(res.status, 200)
  assert.match(await res.text(), /started a new conversation/)
})

test('handler enforces the daily message limit', async () => {
  const store = memoryStore()
  const env = { TWILIO_AUTH_TOKEN: 'tok', DAILY_MESSAGES_PER_USER: '1', ANTHROPIC_API_KEY: '' }
  const first = await handleWhatsApp(signedRequest({ From: 'whatsapp:+2', Body: 'reset' }), env, store)
  assert.equal(first.status, 200)
  const key = [...store.data.keys()][0]
  store.data.set(key, JSON.stringify({ messages: [], day: new Date().toISOString().slice(0, 10), count: 1 }))
  const res = await handleWhatsApp(signedRequest({ From: 'whatsapp:+2', Body: 'hi' }), env, store)
  assert.match(await res.text(), /message limit/)
})
