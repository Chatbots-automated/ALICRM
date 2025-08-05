//--------------------------------------------------------------
// stripe-metrics.ts   (Supabase Edge Function / Deno / logging)
//--------------------------------------------------------------
import { corsHeaders } from '../_shared/cors.ts'

/* ---------- 0.  ENV & Stripe init ---------- */
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY')
if (!STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY env var is required')

/* Supabase’s Deno runtime bundles 16.12.0 — we stick with that. */
const Stripe = (await import('npm:stripe@16.12.0')).default
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' })

/* ---------- 1.  Helpers ---------- */
const toUsd = (cents: number) => (cents / 100).toFixed(2)
const now = new Date()
const monthStart = Math.floor(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000
)

/* ---------- 2.  Edge-function handler ---------- */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    /* ───────────────────────────────────────────────────────
       STEP A · ACTIVE SUBSCRIPTIONS → MRR
    ─────────────────────────────────────────────────────── */
    let mrrCents = 0
    let subAfter: string | undefined
    let subsFetched = 0
    const subsSample: any[] = []

    console.log('STEP A: fetching active subscriptions')
    do {
      const page = await stripe.subscriptions.list({
        status: 'active',
        limit: 100,
        starting_after: subAfter
      })
      console.log(`  • page : ${page.data.length} subs`)
      subsFetched += page.data.length

      page.data.forEach((sub, idx) => {
        /* Take first 3 objects for sample only */
        if (subsSample.length < 3) subsSample.push(sub)

        sub.items?.data.forEach((it) => {
          const { unit_amount, interval, interval_count } = it.price
          if (!unit_amount || !interval) return
          const monthly =
            interval === 'month'
              ? unit_amount
              : unit_amount / (interval_count * (interval === 'year' ? 12 : 1))
          mrrCents += monthly * (it.quantity || 1)
        })
      })

      subAfter = page.has_more ? page.data.at(-1)!.id : undefined
    } while (subAfter)
    console.log(`  → TOTAL active subs fetched: ${subsFetched}`)
    console.log(`  → MRR (cents): ${mrrCents}`)

    /* ───────────────────────────────────────────────────────
       STEP B · PAYMENT INTENTS (succeeded) → revenue
    ─────────────────────────────────────────────────────── */
    const succeededIntents: any[] = []
    let piAfter: string | undefined
    let piFetched = 0

    console.log('STEP B: fetching succeeded PaymentIntents')
    do {
      const page = await stripe.paymentIntents.list({
        status: 'succeeded',
        limit: 100,
        starting_after: piAfter
      })
      console.log(`  • page : ${page.data.length} intents`)
      piFetched += page.data.length
      succeededIntents.push(...page.data)
      piAfter = page.has_more ? page.data.at(-1)!.id : undefined
    } while (piAfter)
    console.log(`  → TOTAL succeeded intents fetched: ${piFetched}`)

    /* ✶ revenue calculations ✶ */
    let allTimeCents = 0
    let mtdCents = 0
    succeededIntents.forEach((pi) => {
      allTimeCents += pi.amount_received
      if (pi.created >= monthStart) mtdCents += pi.amount_received
    })
    console.log(`  → All-time revenue (cents): ${allTimeCents}`)
    console.log(`  → Month-to-date revenue (cents): ${mtdCents}`)

    /* sample */
    const piSample = succeededIntents.slice(0, 5) // first 5 full objects

    /* ───────────────────────────────────────────────────────
       FINAL payload
    ─────────────────────────────────────────────────────── */
    const payload = {
      mrr_usd: toUsd(mrrCents),
      total_payment_intents: piFetched,
      month_to_date_revenue_usd: toUsd(mtdCents),
      all_time_revenue_usd: toUsd(allTimeCents),
      payment_intents_sample: piSample,
      subscriptions_sample: subsSample
    }

    console.log('--- FINAL PAYLOAD ---')
    console.log(JSON.stringify(payload, null, 2))
    console.log('----------------------')

    return new Response(JSON.stringify(payload), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  } catch (err: any) {
    console.error('Stripe metrics error:', err)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
