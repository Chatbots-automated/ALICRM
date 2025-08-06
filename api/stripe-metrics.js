/**
 * Vercel Serverless Function – Stripe + PayPal subscriptions dashboard
 * Node 18  (CommonJS)
 *
 *  ▸ Stripe  : MRR (subscriptions)  +  revenue (payment-intents)
 *  ▸ PayPal  : live active subscriptions (with subscriber name) + MRR
 *
 *  ⚠️  HARD-CODED PayPal creds — FOR LOCAL TESTS ONLY
 */

const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16',
});

/* ───────── helpers ───────── */
const toUsd = cents => (cents / 100).toFixed(2);
const monthStartUtc = () => {
  const now = new Date();
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
};

/* ───────── PayPal (LIVE) creds ───────── */
const PAYPAL_CLIENT_ID =
  'AacO4zdSVS1h98mUove2VbJ-B6hBwv6SVV0ofRKer0gVwgnL7cZSB4_F3PlV6bhHFaDoAk6rs3Qsw2lw';
const PAYPAL_CLIENT_SECRET =
  'EJIZYylz8gxmxXD5ZN4ODJP3fCP-vSi28C_7zsZdBYXx5d2VGihVryuTcxnmhVeoXL_om8T0f6G7Vro0';

const PAYPAL_BASE = 'https://api-m.paypal.com';                 // LIVE endpoint

async function paypalToken() {
  const creds = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');

  const r = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method : 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body   : 'grant_type=client_credentials',
  });

  if (!r.ok) {
    const txt = await r.text();
    console.error('PayPal OAuth error', r.status, txt);
    throw new Error(`PayPal token error – HTTP ${r.status}`);
  }
  const { access_token } = await r.json();
  return access_token;
}

const ppHeaders = token => ({
  Authorization : `Bearer ${token}`,
  'Content-Type': 'application/json',
});

/* ───────────────────────────────────────────────────────────── */
module.exports = async (req, res) => {
  /* ——— CORS ——— */
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    /* =========================================================
       1.  STRIPE subscriptions  →  Monthly-Recurring-Revenue
    ========================================================= */
    let stripeMRRCents = 0;                // keep in *cents*
    const stripeSubs   = [];

    let sAfter, sPages = 0, sSeen = 0;
    do {
      const page = await stripe.subscriptions.list({
        status        : 'all',             // fetch every status
        limit         : 1000,              // Stripe caps at 100
        starting_after: sAfter,
        expand        : ['data.customer'],
      });

      sPages++;   sSeen += page.data.length;

      page.data.forEach(sub => {
        // skip subs that are no longer financially relevant
        if (['canceled', 'unpaid', 'incomplete_expired'].includes(sub.status)) return;

        const cust = sub.customer;
        const customer_name =
          typeof cust === 'object' ? cust.name || cust.email || null : null;

        stripeSubs.push({ ...sub, customer_name });

        sub.items.data.forEach(it => {
          /* ---- price → monthly cents ---- */
          const cents = it.price.unit_amount ??
                        Math.round(parseFloat(it.price.unit_amount_decimal || 0));
          if (!cents) return;                             // metered / free plans

          const { interval, interval_count } = it.price;
          const monthly = interval === 'month'
            ? cents
            : cents / (interval_count * (interval === 'year' ? 12 : 1));

          stripeMRRCents += monthly * (it.quantity || 1);
        });
      });

      sAfter = page.has_more ? page.data.at(-1).id : undefined;
    } while (sAfter);

    /* =========================================================
       1 B.  STRIPE succeeded PaymentIntents  →  revenue
    ========================================================= */
    const monthStart = monthStartUtc();
    let piAfter, piPages = 0, piSeen = 0;
    let stripeAllTimeCents = 0, stripeMTDCents = 0;
    const piSample = [];

    do {
      const page = await stripe.paymentIntents.list({
        limit         : 1000,                    // capped at 100
        starting_after: piAfter,
      });

      piPages++;   piSeen += page.data.length;

      page.data.forEach(pi => {
        if (pi.status !== 'succeeded' || pi.amount_received === 0) return;

        if (piSample.length < 5) piSample.push(pi);

        stripeAllTimeCents += pi.amount_received;
        if (pi.created >= monthStart) stripeMTDCents += pi.amount_received;
      });

      piAfter = page.has_more ? page.data.at(-1).id : undefined;
    } while (piAfter);

    /* =========================================================
       2.  PAYPAL live ACTIVE subscriptions → MRR
    ========================================================= */
    const ppToken = await paypalToken();

    const ppSubs     = [];
    const planCache  = new Map();          // plan_id → meta
    let ppPage = 1, ppPages = 0, ppSeen = 0;
    let paypalMRRCents = 0;

    while (true) {
      const listURL = `${PAYPAL_BASE}/v1/billing/subscriptions`
                    + `?status=ACTIVE&page_size=20&page=${ppPage}`;
      const listRes = await fetch(listURL, { headers: ppHeaders(ppToken) });
      if (!listRes.ok) throw new Error(`PayPal list error – HTTP ${listRes.status}`);
      const listJson = await listRes.json();

      const batch = listJson.subscriptions ?? [];
      if (batch.length === 0) break;

      ppPages++;  ppSeen += batch.length;

      for (const { id } of batch) {
        /* ---- subscription detail ---- */
        const dRes = await fetch(
          `${PAYPAL_BASE}/v1/billing/subscriptions/${id}`,
          { headers: ppHeaders(ppToken) },
        );
        if (!dRes.ok) continue;
        const sub = await dRes.json();

        /* subscriber label */
        const n = sub.subscriber?.name ?? {};
        const subscriber_name =
          n.full_name ||
          [n.given_name, n.surname].filter(Boolean).join(' ') ||
          sub.subscriber?.email_address ||
          null;

        /* plan meta (cached) */
        let meta = planCache.get(sub.plan_id);
        if (!meta) {
          const pRes = await fetch(
            `${PAYPAL_BASE}/v1/billing/plans/${sub.plan_id}`,
            { headers: ppHeaders(ppToken) },
          );
          if (!pRes.ok) continue;
          const plan  = await pRes.json();
          const bc    = plan.billing_cycles?.[0];
          const fixed = bc?.pricing_scheme?.fixed_price;
          const freq  = bc?.frequency;
          if (!fixed || !freq) continue;

          meta = {
            amount_cents  : Math.round(parseFloat(fixed.value) * 100),
            interval_unit : freq.interval_unit,          // MONTH | YEAR
            interval_count: freq.interval_count,
          };
          planCache.set(sub.plan_id, meta);
        }

        const { amount_cents, interval_unit, interval_count } = meta;
        const monthly = interval_unit === 'MONTH'
          ? amount_cents
          : amount_cents / (interval_count * (interval_unit === 'YEAR' ? 12 : 1));
        paypalMRRCents += monthly;

        ppSubs.push({ ...sub, subscriber_name });
      }

      ppPage++;
    }

    /* =========================================================
       3.  RESPONSE
    ========================================================= */
    const payload = {
      /* Stripe -------------- */
      stripe_mrr_usd              : toUsd(stripeMRRCents),
      stripe_revenue_all_time_usd : toUsd(stripeAllTimeCents),
      stripe_revenue_mtd_usd      : toUsd(stripeMTDCents),
      stripe_subscriptions        : stripeSubs,
      payment_intents_sample      : piSample,
      stripe_stats                : {
        subs_pages : sPages, subs_seen : sSeen,
        pi_pages   : piPages, pi_seen  : piSeen,
      },

      /* PayPal -------------- */
      paypal_mrr_usd              : toUsd(paypalMRRCents),
      paypal_subscriptions        : ppSubs,
      paypal_stats                : { pages: ppPages, seen: ppSeen },

      /* Combined ------------- */
      total_mrr_usd               : toUsd(stripeMRRCents + paypalMRRCents),
    };

    console.log('Combined metrics', JSON.stringify(payload, null, 2));
    res.status(200).json(payload);

  } catch (err) {
    console.error('Metrics error', err);
    res.status(500).json({ error: err.message });
  }
};
