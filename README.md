# Kanakku

**A PayPal back office for small online sellers, with AI built into every screen.** See what needs attention today, understand your sales, chase invoices, answer disputes and fix duplicate charges, in your own language. Anything that moves money or contacts a customer waits for your approval.

*Kanakku* (கணக்கு) is Tamil for "accounts", after the cloth-bound notebook small shops keep their books in.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/).

![Overview: the morning brief, key numbers, sales chart, items that need attention and AI insights](docs/overview.png)

## The problem

Small online sellers and freelancers get paid through PayPal, but their account shows long lists, not answers. Questions like "which product gets refunded most?" or "who still owes me money?" mean exporting a CSV and working it out in a spreadsheet, so most sellers don't. Things slip through: duplicate charges annoy customers, overdue invoices go unchased, and dispute deadlines pass, which usually means losing the money. Many of these sellers (in India and elsewhere) are also more comfortable in their own language than in English dashboards.

## What it does

| Screen | What you can do | Where AI helps |
| --- | --- | --- |
| **Overview** | Morning brief, sales vs the same days last month, money kept after fees and refunds, refund rate, money owed, dispute deadlines, 60-day sales chart, products table | Claude writes the brief in English, Tamil or Hindi from exact numbers. Insights (a product with an unusual refund rate, fastest-growing product, best repeat customer, fees, busiest day) each have an **Ask why** button. **Needs attention** turns problems into one-click fixes. |
| **Sales** | Every payment, refund and bank transfer in AG Grid, with period and type filters, search, totals and a by-product chart. Tick payments and **Refund selected**. | **Find duplicate charges**, **Top customers** |
| **Invoices** | What's owed and overdue. Tick invoices and **Send reminders**, or remind all overdue at once. | **New invoice → paste a WhatsApp message or email** (any language) and Claude fills in the customer, items, prices and terms for you to check. |
| **Disputes** | Each open case with its deadline, the order and the buyer's messages | **Draft a reply with AI**, edit it, then send it to the buyer through PayPal |
| **Activity** | A history of everything Kanakku prepared, what you approved or declined, and the result | |
| **Ask Kanakku** (Ctrl/⌘ K, every screen) | Ask anything in any language. Answers come back as a sortable table and chart. | Claude can also prepare refunds, reminders, invoices and dispute replies for you to approve. |

![Invoice filled in from a pasted WhatsApp message](docs/invoice-from-message.png)

![A dispute with a reply drafted by AI](docs/dispute-reply.png)

![Ask Kanakku answering with a chart and table](docs/assistant.png)

## How it works

```
React + AG Grid + AG Charts  ──►  Express API  ──►  Claude (tool use)
                                        │                 │
                                        │        tools: search_transactions, summarize_transactions,
                                        │        find_duplicate_charges, list_invoices, list_disputes,
                                        │        propose_refunds, propose_invoice_reminders,
                                        │        propose_new_invoice, propose_dispute_reply, present_answer
                                        ▼
                               PayPal REST APIs (sandbox)
            Transaction Search · Invoicing v2 · Disputes · Payments v2 refunds · Orders v2
```

Three design choices keep it trustworthy:

1. **The numbers never come from the model.** Every figure on the Overview, Sales and Invoices screens is computed in code. In the assistant, read tools save their results as datasets on the server. Claude answers by pointing at a dataset id (`present_answer`), and the server sends the real rows to the grid. Totals and refund rates come from `summarize_transactions`, not from model arithmetic.
2. **Nothing moves money without you.** Buttons and the assistant both go through the same `propose_*` tools, which only create a pending action, after checking that the payment or invoice really exists and hasn't already been refunded or paid. The refund, reminder or invoice runs only when the seller presses Approve, and an action can't be approved twice.
3. **Invented ids are rejected.** If Claude names a transaction it hasn't looked up, the tool returns an error instead of creating an action.

### PayPal APIs used

| What | Endpoint |
| --- | --- |
| Sales, refunds, fees, payouts | `GET /v1/reporting/transactions` (Transaction Search) |
| Invoices | `GET /v2/invoicing/invoices` |
| Payment reminders | `POST /v2/invoicing/invoices/{id}/remind` |
| New invoices | `POST /v2/invoicing/invoices` and `.../{id}/send` |
| Disputes | `GET /v1/customer/disputes` |
| Refunds | `POST /v2/payments/captures/{id}/refund` |
| Dispute replies | `POST /v1/customer/disputes/{id}/send-message` |
| Seed payments | `POST /v2/checkout/orders` (card, sandbox only) |

### AI used

[Claude](https://docs.claude.com) through the Anthropic Messages API with tool use (default model `claude-sonnet-5-5`, configurable). Claude decides which PayPal tools to call, combines the results, chooses the table columns and chart, writes the brief, fills in invoices from pasted messages, drafts dispute replies, and replies in the seller's language.

## Run it

Requires Node.js 20 or newer.

```bash
git clone <this repo>
cd kanakku
npm install
cp .env.example .env      # then add your keys (see below)
npm run build             # builds the web app
npm start                 # serves app + API at http://localhost:8787
```

For development with hot reload, run `npm run dev` and open http://localhost:5173.

### Keys

| Variable | Where to get it |
| --- | --- |
| `ANTHROPIC_API_KEY` | https://console.anthropic.com/ |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | https://developer.paypal.com → Apps & Credentials → Sandbox |

### Data modes

- **No PayPal keys:** Kanakku runs on a built-in demo store, *Meena Prints*, a hand-block-printing studio in Coimbatore selling to customers abroad. It has four months of realistic sales, an Indigo cushion cover set with a refund problem, two duplicate charges, overdue boutique invoices and disputes with buyer messages. Refunds, reminders and invoices you approve really change the demo store, and **Reset demo store** on the Activity screen restores it.
- **With PayPal sandbox keys:** Kanakku reads and acts on your sandbox account. Run `npm run seed` once to create boutique invoices and, if you set `SEED_TEST_CARD_NUMBER` to a [sandbox test card](https://developer.paypal.com/tools/sandbox/card-testing/), captured payments including a duplicate charge. New sandbox payments can take a few hours to appear in Transaction Search; invoices appear right away.
- Force either with `DATA_MODE=demo` or `DATA_MODE=live`.

**PayPal permissions.** New sandbox apps don't have every API turned on. In developer.paypal.com → Apps & Credentials → your sandbox app → **Features**, turn on **Transaction search**, **Invoicing** and **Disputes**, save, then restart the server so it gets a fresh token. If one is missing, Kanakku still loads what it can and names the missing feature on screen.

### Tests

```bash
npm test
```

The tests use a scripted stand-in for Claude to check the important guarantees: answers show real dataset rows, refunds wait for approval and run exactly once, already-refunded payments and invented ids are refused, declined actions never run, buttons go through the same checks as the assistant, and the app keeps working when one PayPal permission is missing.

## Project layout

```
server/
  src/agent/      Claude loop and tools, AI drafts, analytics and insights, approval store
  src/data/       PayPal source, demo store, shared types
  src/paypal/     OAuth + REST client
  scripts/        sandbox seed script
  test/
web/
  src/pages/      Overview, Sales, Invoices, Disputes, Activity
  src/            app shell, Ask Kanakku panel, approval dialog, AG Grid + AG Charts helpers
```

## License

[MIT](LICENSE)
