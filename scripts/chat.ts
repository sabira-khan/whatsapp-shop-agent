import { createInterface } from 'node:readline/promises'
import Anthropic from '@anthropic-ai/sdk'
import { runAgent, type Session } from '../src/agent'

const shopify = {
  storeDomain: process.env.SHOPIFY_STORE_DOMAIN ?? '',
  storefrontToken: process.env.SHOPIFY_STOREFRONT_TOKEN ?? '',
  apiVersion: process.env.SHOPIFY_API_VERSION || '2025-07'
}
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const scripted = process.argv.slice(2)
let session: Session = { messages: [] }

async function turn(text: string) {
  const started = Date.now()
  const result = await runAgent(text, session, { client, shopify, storePassword: process.env.SHOPIFY_STORE_PASSWORD })
  session = result.session
  console.log(`\n> ${text}\n${result.reply}`)
  for (const photo of result.photos) console.log(`[photo] ${photo.caption} ${photo.url}`)
  console.log(`(${Date.now() - started} ms)`)
}

if (scripted.length) {
  for (const text of scripted) await turn(text)
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  while (true) {
    const text = (await rl.question('\nyou: ')).trim()
    if (!text || text === 'exit') break
    await turn(text)
  }
  rl.close()
}
