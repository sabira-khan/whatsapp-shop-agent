import type Anthropic from '@anthropic-ai/sdk'

export interface Verdict {
  pass: boolean | null
  reason: string
  inputTokens: number
  outputTokens: number
}

const SYSTEM = `You grade replies from a WhatsApp shopping assistant for an online gift shop.
You see the conversation so far and the assistant's latest reply, plus one rubric.
Judge only what the rubric asks. Product facts are checked elsewhere, so do not fail a reply for prices or stock.
The customer's gender is unknown, so do not fail a reply for the gendered forms it uses to address them.
Return pass true only if the latest reply clearly meets the rubric. Give a one-line reason.`

const SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    reason: { type: 'string' }
  },
  required: ['pass', 'reason'],
  additionalProperties: false
}

export async function judge(client: Anthropic, model: string, transcript: { user: string; reply: string }[], rubric: string, attempts = 3): Promise<Verdict> {
  let inputTokens = 0
  let outputTokens = 0
  let last = ''
  for (let i = 0; i < attempts; i++) {
    const v = await judgeOnce(client, model, transcript, rubric)
    inputTokens += v.inputTokens
    outputTokens += v.outputTokens
    if (v.pass !== null) return { ...v, inputTokens, outputTokens }
    last = v.reason
  }
  return { pass: null, reason: last, inputTokens, outputTokens }
}

async function judgeOnce(client: Anthropic, model: string, transcript: { user: string; reply: string }[], rubric: string): Promise<Verdict> {
  const conversation = transcript
    .map((t, i) => `Customer: ${t.user}\n${i === transcript.length - 1 ? 'Assistant (latest reply)' : 'Assistant'}: ${t.reply}`)
    .join('\n\n')
  const res = await client.messages.create({
    model,
    max_tokens: 1024,
    system: SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: `<conversation>\n${conversation}\n</conversation>\n\n<rubric>\n${rubric}\n</rubric>` }]
  })
  const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('')
  let parsed: { pass?: unknown; reason?: unknown } = {}
  try { parsed = JSON.parse(text) } catch {}
  return {
    pass: typeof parsed.pass === 'boolean' ? parsed.pass : null,
    reason: typeof parsed.reason === 'string' ? parsed.reason : `Judge gave no verdict (stop_reason ${res.stop_reason})`,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens
  }
}
