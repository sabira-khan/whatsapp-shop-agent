# Taste Gifts on WhatsApp

A WhatsApp shopping agent. Customers chat in Arabic or English, and a Claude Haiku agent searches the catalog, sends product photos, builds a Shopify cart and replies with a checkout link.

Live: https://tastegifts-wa.netlify.app

## How it works

- Twilio forwards each WhatsApp message to `POST /api/whatsapp` (a Netlify Function). The `X-Twilio-Signature` header is verified before anything runs.
- The agent (`src/agent.ts`) runs a tool-calling loop with six tools: `search_products`, `send_photo`, `add_to_cart`, `remove_from_cart`, `view_cart` and `checkout`. Product facts only come from tools, so prices and stock are never invented.
- Carts and checkout links come from the Shopify Storefront API.
- Conversations are stored in Netlify Blobs, keyed by a SHA-256 hash of the sender's number.
- Guardrails: an 8 second agent budget (Twilio waits 15), a per-user daily message limit, and a hard LLM spend cap ($3 total, $1 a day by default).

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
