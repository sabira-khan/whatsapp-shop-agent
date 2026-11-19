import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import Anthropic from '@anthropic-ai/sdk'
import { MODEL, runAgent, type Session } from '../src/agent'
import { runChecks, type CheckResult, type ToolCall, type TurnExpect } from './checks'
import { installFakeShopify } from './fake-shopify'
import { FIXTURE_SHOPIFY, loadFixture, useFixtureCatalog } from './fixture'
import { judge } from './judge'

interface EvalCase {
  id: string
  category: string
  turns: { user: string; expect?: TurnExpect }[]
}

interface TurnRecord {
  user: string
  reply: string
  photos: string[]
  calls: ToolCall[]
  latencyMs: number
  inputTokens: number
  outputTokens: number
  checks: CheckResult[]
}

interface RunRecord {
  id: string
  category: string
  run: number
  pass: boolean
  error?: string
  turns: TurnRecord[]
  inputTokens: number
  outputTokens: number
  costUsd: number
  toolCalls: number
}

const { values: args } = parseArgs({
  options: {
    repeat: { type: 'string', default: '1' },
    concurrency: { type: 'string', default: '4' },
    case: { type: 'string', multiple: true },
    category: { type: 'string', multiple: true },
    'no-judge': { type: 'boolean', default: false },
    'judge-model': { type: 'string' },
    model: { type: 'string' },
    'budget-ms': { type: 'string' }
  }
})

const apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey) {
  console.error('ANTHROPIC_API_KEY is not set')
  process.exit(1)
}

const repeat = Math.max(1, Number(args.repeat))
const concurrency = Math.max(1, Number(args.concurrency))
const model = args.model ?? process.env.EVAL_MODEL ?? MODEL
const judgeModel = args['judge-model'] ?? process.env.EVAL_JUDGE_MODEL ?? 'claude-sonnet-5-5'
const useJudge = !args['no-judge']
const budgetMs = args['budget-ms'] ? Number(args['budget-ms']) : undefined
const price = {
  input: Number(process.env.EVAL_INPUT_PRICE ?? 0.1),
  output: Number(process.env.EVAL_OUTPUT_PRICE ?? 0.5),
  judgeInput: Number(process.env.EVAL_JUDGE_INPUT_PRICE ?? 2),
  judgeOutput: Number(process.env.EVAL_JUDGE_OUTPUT_PRICE ?? 10)
}

const products = loadFixture()
useFixtureCatalog(products)
installFakeShopify(products)

const casesDir = new URL('./cases/', import.meta.url)
const cases: EvalCase[] = readdirSync(casesDir)
  .filter(f => f.endsWith('.json'))
  .sort()
  .flatMap(f => JSON.parse(readFileSync(new URL(f, casesDir), 'utf8')) as EvalCase[])
  .filter(c => !args.case?.length || args.case.includes(c.id))
  .filter(c => !args.category?.length || args.category.includes(c.category))

const ids = new Set<string>()
for (const c of cases) {
  if (ids.has(c.id)) throw new Error(`Duplicate case id ${c.id}`)
  ids.add(c.id)
}

const client = new Anthropic({ apiKey })
let judgeInputTokens = 0
let judgeOutputTokens = 0

function recordingClient() {
  const log = { calls: [] as ToolCall[], results: new Map<string, string>(), inputTokens: 0, outputTokens: 0 }
  const wrapped = {
    messages: {
      create: async (body: Anthropic.MessageCreateParamsNonStreaming, options?: Anthropic.RequestOptions) => {
        for (const message of body.messages) {
          if (message.role !== 'user' || typeof message.content === 'string') continue
          for (const block of message.content) {
            if (block.type === 'tool_result') log.results.set(block.tool_use_id, typeof block.content === 'string' ? block.content : JSON.stringify(block.content))
          }
        }
        const res = await client.messages.create(body, options)
        log.inputTokens += res.usage.input_tokens
        log.outputTokens += res.usage.output_tokens
        for (const block of res.content) {
          if (block.type === 'tool_use') log.calls.push({ name: block.name, input: block.input, id: block.id } as ToolCall & { id: string })
        }
        return res
      }
    }
  }
  return { client: wrapped as unknown as Anthropic, log }
}

async function runCase(c: EvalCase, run: number): Promise<RunRecord> {
  const record: RunRecord = { id: c.id, category: c.category, run, pass: true, turns: [], inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0 }
  let session: Session = { messages: [] }
  const history: { user: string; calls: ToolCall[] }[] = []
  try {
    for (const turn of c.turns) {
      const { client: recorded, log } = recordingClient()
      const started = performance.now()
      const result = await runAgent(turn.user, session, { client: recorded, shopify: FIXTURE_SHOPIFY, model, budgetMs })
      const latencyMs = Math.round(performance.now() - started)
      session = result.session
      const calls = log.calls.map(call => ({ name: call.name, input: call.input, result: log.results.get((call as any).id) }))
      const checks = runChecks({ user: turn.user, reply: result.reply, calls, history, products }, turn.expect)
      if (useJudge && turn.expect?.judge) {
        const transcript = [...record.turns.map(t => ({ user: t.user, reply: t.reply })), { user: turn.user, reply: result.reply }]
        const verdict = await judge(client, judgeModel, transcript, turn.expect.judge)
        judgeInputTokens += verdict.inputTokens
        judgeOutputTokens += verdict.outputTokens
        checks.push(verdict.pass === null
          ? { name: 'judge', pass: true, skipped: true, detail: `Skipped: ${verdict.reason}` }
          : { name: 'judge', pass: verdict.pass, detail: verdict.reason })
      }
      record.turns.push({ user: turn.user, reply: result.reply, photos: result.photos.map(p => p.url), calls, latencyMs, inputTokens: log.inputTokens, outputTokens: log.outputTokens, checks })
      record.inputTokens += log.inputTokens
      record.outputTokens += log.outputTokens
      record.toolCalls += calls.length
      history.push({ user: turn.user, calls })
    }
  } catch (err) {
    record.error = (err as Error).message
  }
  record.costUsd = (record.inputTokens * price.input + record.outputTokens * price.output) / 1e6
  record.pass = !record.error && record.turns.length === c.turns.length && record.turns.every(t => t.checks.every(ch => ch.pass))
  return record
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }))
  return out
}

function percentile(values: number[], p: number) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(0)}%` : '-')
const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0)

const jobs = cases.flatMap(c => Array.from({ length: repeat }, (_, run) => ({ c, run: run + 1 })))
console.log(`Running ${cases.length} cases x ${repeat} on ${model}${useJudge ? `, judge ${judgeModel}` : ', judge off'}`)
const startedAt = new Date()
let done = 0
const runs = await pool(jobs, concurrency, async ({ c, run }) => {
  const r = await runCase(c, run)
  done++
  process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.id}${repeat > 1 ? ` #${run}` : ''} (${done}/${jobs.length})\n`)
  return r
})

const categories = [...new Set(cases.map(c => c.category))]
const byCategory = categories.map(category => {
  const rs = runs.filter(r => r.category === category)
  return { category, passed: rs.filter(r => r.pass).length, total: rs.length }
})
const latencies = runs.flatMap(r => r.turns.map(t => t.latencyMs))
const flaky = cases
  .map(c => ({ id: c.id, passes: runs.filter(r => r.id === c.id && r.pass).length }))
  .filter(x => x.passes > 0 && x.passes < repeat)
const summary = {
  model,
  judgeModel: useJudge ? judgeModel : null,
  repeat,
  cases: cases.length,
  runs: runs.length,
  passed: runs.filter(r => r.pass).length,
  passRate: runs.length ? runs.filter(r => r.pass).length / runs.length : 0,
  byCategory,
  latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
  perConversation: {
    inputTokens: Math.round(mean(runs.map(r => r.inputTokens))),
    outputTokens: Math.round(mean(runs.map(r => r.outputTokens))),
    costUsd: Number(mean(runs.map(r => r.costUsd)).toFixed(6)),
    toolCalls: Number(mean(runs.map(r => r.toolCalls)).toFixed(2))
  },
  judgeSkipped: runs.reduce((n, r) => n + r.turns.reduce((m, t) => m + t.checks.filter(ch => ch.skipped).length, 0), 0),
  totalCostUsd: Number((runs.reduce((s, r) => s + r.costUsd, 0) + (judgeInputTokens * price.judgeInput + judgeOutputTokens * price.judgeOutput) / 1e6).toFixed(4)),
  flaky
}

const lines = [
  '| Category | Passed | Pass rate |',
  '|---|---|---|',
  ...byCategory.map(b => `| ${b.category} | ${b.passed}/${b.total} | ${pct(b.passed, b.total)} |`),
  `| **Overall** | **${summary.passed}/${summary.runs}** | **${pct(summary.passed, summary.runs)}** |`,
  '',
  '| Metric | Value |',
  '|---|---|',
  `| Latency per turn, p50 | ${(summary.latencyMs.p50 / 1000).toFixed(1)} s |`,
  `| Latency per turn, p95 | ${(summary.latencyMs.p95 / 1000).toFixed(1)} s |`,
  `| Tokens per conversation (in / out) | ${summary.perConversation.inputTokens} / ${summary.perConversation.outputTokens} |`,
  `| Cost per conversation | $${summary.perConversation.costUsd.toFixed(4)} |`,
  `| Tool calls per conversation | ${summary.perConversation.toolCalls} |`,
  ...(summary.judgeSkipped ? [`| Judge verdicts skipped | ${summary.judgeSkipped} |`] : [])
]
console.log(`\n${lines.join('\n')}`)
if (repeat > 1) console.log(flaky.length ? `\nFlaky (passed only some runs): ${flaky.map(f => `${f.id} ${f.passes}/${repeat}`).join(', ')}` : '\nNo flaky cases')

const failures = runs.filter(r => !r.pass)
for (const f of failures) {
  const failed = f.turns.flatMap((t, i) => t.checks.filter(ch => !ch.pass).map(ch => `turn ${i + 1} ${ch.name}: ${ch.detail ?? ''}`))
  console.log(`\nFAIL ${f.id}${repeat > 1 ? ` #${f.run}` : ''}\n  ${(f.error ? [`error: ${f.error}`] : failed).join('\n  ')}`)
}

const resultsDir = new URL('./results/', import.meta.url)
mkdirSync(resultsDir, { recursive: true })
const stamp = startedAt.toISOString().replace(/[:.]/g, '-')
const file = new URL(`${stamp}.json`, resultsDir)
writeFileSync(file, JSON.stringify({
  startedAt: startedAt.toISOString(),
  summary,
  summaryMarkdown: lines.join('\n'),
  runs: runs.map(r => (r.pass ? { ...r, turns: r.turns.map(t => ({ user: t.user, latencyMs: t.latencyMs, checks: t.checks })) } : r))
}, null, 2))
console.log(`\nTotal cost including judge: $${summary.totalCostUsd}\nResults: ${file.pathname}`)
process.exit(0)
