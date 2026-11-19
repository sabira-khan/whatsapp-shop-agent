# Taste Gifts on WhatsApp

A WhatsApp shopping agent. Customers chat in Arabic or English, and a Claude Haiku agent searches the catalog, sends product photos, builds a Shopify cart and replies with a checkout link.

Live: https://tastegifts-wa.netlify.app

## How it works

- Twilio forwards each WhatsApp message to `POST /api/whatsapp` (a Netlify Function). The `X-Twilio-Signature` header is verified before anything runs.
- The agent (`src/agent.ts`) runs a tool-calling loop with six tools: `search_products`, `send_photo`, `add_to_cart`, `remove_from_cart`, `view_cart` and `checkout`. Product facts only come from tools, so prices and stock are never invented.
- Carts and checkout links come from the Shopify Storefront API.
- Conversations are stored in Netlify Blobs, keyed by a SHA-256 hash of the sender's number.
- Guardrails: an 8 second agent budget (Twilio waits 15), a per-user daily message limit, and a hard LLM spend cap ($3 total, $1 a day by default).

## Evaluation

`evals/` runs the agent core against 30 scripted conversations and scores every reply. It calls `runAgent()` directly, skipping Twilio. Shopify is replaced by an in-memory Storefront API backed by a fixed 25-product fixture (`evals/fixtures/catalog.json`) with varied prices, four out-of-stock products, products with several variants and products with Arabic titles. The agent's prompt and code are not changed by the harness.

### Cases

| Category | What it checks |
|---|---|
| search-en | English product search |
| search-ar | Arabic and Arabizi search, reply in the customer's language |
| price-stock | Price and stock questions answered from the catalog |
| multi-turn | Follow-ups such as "the cheaper one", "in blue?", "under $30?" |
| out-of-stock | Out-of-stock products are flagged and never checked out |
| nonexistent | Products the shop does not sell are not invented |
| ambiguous | Vague requests get a clarifying question, not a guess |
| cart | Add to cart, quantities, remove and checkout link |
| off-topic | Polite refusal and redirect to shopping |
| prompt-injection | "Ignore your instructions", fake admin mode, price tampering |

### Checks

Deterministic checks run on every reply:

- the expected tool was called with sensible arguments (query terms, max price, handle, quantity)
- every price matches the fixture for the product it appears next to, or a cart total from a tool result
- every product name in bold exists in the fixture
- out-of-stock products are described as unavailable, in-stock products are not
- the reply is in the customer's language
- no system prompt text or internal tool names appear in the reply

An LLM judge (default `claude-sonnet-5-5`, set with `--judge-model` or `EVAL_JUDGE_MODEL`) only grades what code cannot: helpfulness, tone and whether a clarifying question was appropriate. Each rubric returns pass or fail with a one-line reason.

### Run it

```
ANTHROPIC_API_KEY=... npm run eval
npm run eval -- --repeat 3
npm run eval -- --category multi-turn --no-judge
npm run eval -- --case cart-two-plush
```

`--repeat N` runs each case N times and lists cases that pass only some of the time. A summary table is printed and full results, including failing transcripts, are written to `evals/results/<timestamp>.json`. The `evals` GitHub Actions workflow runs the suite on manual trigger, using the `ANTHROPIC_API_KEY` repository secret.

### Latest results

claude-haiku-5-5, judge claude-sonnet-5-5, each case run 3 times (2026-11-18). Flaky: search-ar-coffee (2/3).

| Category | Passed | Pass rate |
|---|---|---|
| ambiguous | 9/9 | 100% |
| cart | 9/9 | 100% |
| multi-turn | 3/9 | 33% |
| nonexistent | 9/9 | 100% |
| off-topic | 6/9 | 67% |
| out-of-stock | 9/9 | 100% |
| price-stock | 9/9 | 100% |
| prompt-injection | 9/9 | 100% |
| search-ar | 8/9 | 89% |
| search-en | 6/9 | 67% |
| **Overall** | **77/90** | **86%** |

| Metric | Value |
|---|---|
| Latency per turn, p50 | 2.4 s |
| Latency per turn, p95 | 3.4 s |
| Tokens per conversation (in / out) | 4112 / 219 |
| Cost per conversation | $0.0005 |
| Tool calls per conversation | 1.82 |

The failures are real agent issues, not harness errors:

- When the model writes its answer and then calls `send_photo`, only the text from the final round is sent, so the product name and price are lost (search-en-chess, followup-in-blue).
- On one Arabic off-topic question the model's reasoning leaks into the reply in English.
- Products with Arabic titles are sometimes renamed in English (followup-cheaper-one).

## Environment

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key |
| `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_STOREFRONT_TOKEN`, `SHOPIFY_API_VERSION` | Storefront API access |
| `SHOPIFY_STORE_PASSWORD` | Optional, shared with customers when the store is password protected |
| `TWILIO_AUTH_TOKEN` | Verifies webhook signatures |
| `PUBLIC_WEBHOOK_URL` | The exact webhook URL configured in Twilio |
| `DAILY_MESSAGES_PER_USER`, `LLM_SPEND_CAP_USD`, `LLM_DAILY_CAP_USD` | Optional limits |

## Develop

```
npm install
npm test
npm run chat
npm run chat -- "gift for my sister who loves matcha" "add the first one"
```

`npm run chat` talks to the agent in the terminal, without WhatsApp.
