/**
 * Vercel Serverless Function – Stripe + PayPal subscriptions dashboard
 * Node 18 (CommonJS)
 *
 *  ▸ Stripe  : MRR (subscriptions) + revenue (payment-intents)
 *  ▸ PayPal  : LIVE active subscriptions (+ subscriber name) + MRR
 *
 * ⚠️  HARD-CODED PayPal creds — FOR LOCAL TESTS ONLY
 */

const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16',
});

/* ───────── helpers ───────── */
const toUsd = cents => (cents / 100).toFixed(2);
const monthStartUtc = () => {
  const d = new Date();
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
};

/* ───────── PayPal creds (LIVE) ───────── */
const PAYPAL_CLIENT_ID =
  'AacO4zdSVS1h98mUove2VbJ-B6hBwv6SVV0ofRKer0gVwgnL7cZSB4_F3PlV6bhHFaDoAk6rs3Qsw2lw';
const PAYPAL_CLIENT_SECRET =
  'EJIZYylz8gxmxXD5ZN4ODJP3fCP-vSi28C_7zsZdBYXx5d2VGihVryuTcxnmhVeoXL_om8T0f6G7Vro0';

const PAYPAL_BASE = 'https://api-m.paypal.com'; // LIVE endpoint

async function paypalToken() {
  const creds = Buffer.from(
    ${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}
  ).toString('base64');

  const r = await fetch(${PAYPAL_BASE}/v1/oauth2/token, {
    method : 'POST',
    headers: {
      Authorization : Basic ${creds},
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!r.ok) {
    console.error('PayPal OAuth error', r.status, await r.text());
    throw new Error(PayPal token error — HTTP ${r.status});
  }
  const { access_token } = await r.json();
  return access_token;
}

const ppHeaders = t => ({ Authorization: Bearer ${t}, 'Content-Type': 'application/json' });

/* ───────────────────────────────────────────────────────────── */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    /* ========== 1. STRIPE  MRR (subscriptions) ========== */
    let stripeMRRCents = 0;
    const stripeSubs   = [];
    let sAfter, sPages = 0, sSeen = 0;

    do {
      const page = await stripe.subscriptions.list({
        status        : 'all',
        limit         : 1000,           // Stripe clips to 100
        starting_after: sAfter,
        expand        : ['data.customer'],
      });

      sPages++;  sSeen += page.data.length;

      page.data.forEach(sub => {
        if (['canceled','unpaid','incomplete_expired'].includes(sub.status)) return;

        const cx = sub.customer;
        const customer_name =
          typeof cx === 'object' ? cx.name || cx.email || null : null;

        stripeSubs.push({ ...sub, customer_name });

        sub.items.data.forEach(it => {
          /* — sanitize amount — */
          let cents = it.price.unit_amount;
          if (cents == null) cents = Number(it.price.unit_amount_decimal);
          if (!Number.isFinite(cents) || cents === 0) return;       // skip free / bad

          const { interval, interval_count } = it.price;
          if (!interval) return;                                     // defensive

          const ic = Number(interval_count) || 1;                    // guard divide-by-0
          const monthly = interval === 'month'
            ? cents
            : cents / (ic * (interval === 'year' ? 12 : 1));

          stripeMRRCents += monthly * (it.quantity || 1);
        });
      });

      sAfter = page.has_more ? page.data.at(-1).id : undefined;
    } while (sAfter);

    /* ========== 1B. STRIPE  revenue (PaymentIntents) ========== */
    const monthStart = monthStartUtc();
    let piAfter, piPages = 0, piSeen = 0;
    let stripeAllTimeC = 0, stripeMTDC = 0;
    const piSample = [];

    do {
      const page = await stripe.paymentIntents.list({
        limit         : 1000,
        starting_after: piAfter,
      });

      piPages++; piSeen += page.data.length;

      page.data.forEach(pi => {
        if (pi.status !== 'succeeded' || pi.amount_received === 0) return;
        if (piSample.length < 5) piSample.push(pi);
        stripeAllTimeC += pi.amount_received;
        if (pi.created >= monthStart) stripeMTDC += pi.amount_received;
      });

      piAfter = page.has_more ? page.data.at(-1).id : undefined;
    } while (piAfter);

    /* ========== 2. PAYPAL  active subscriptions → MRR ========== */
    const ppToken        = await paypalToken();
    const planCache      = new Map();
    const ppSubs         = [];
    let ppPage = 1, ppPages = 0, ppSeen = 0;
    let paypalMRRCents = 0;

    while (true) {
      const listURL = ${PAYPAL_BASE}/v1/billing/subscriptions
                    + ?status=ACTIVE&page_size=20&page=${ppPage};
      const listRes = await fetch(listURL, { headers: ppHeaders(ppToken) });
      if (!listRes.ok) throw new Error(PayPal list error — HTTP ${listRes.status});
      const { subscriptions: batch = [] } = await listRes.json();
      if (batch.length === 0) break;

      ppPages++; ppSeen += batch.length;

      for (const { id } of batch) {
        const dRes = await fetch(
          ${PAYPAL_BASE}/v1/billing/subscriptions/${id},
          { headers: ppHeaders(ppToken) }
        );
        if (!dRes.ok) continue;
        const sub = await dRes.json();

        const n = sub.subscriber?.name ?? {};
        const subscriber_name =
          n.full_name ||
          [n.given_name, n.surname].filter(Boolean).join(' ') ||
          sub.subscriber?.email_address ||
          null;

        let meta = planCache.get(sub.plan_id);
        if (!meta) {
          const pRes = await fetch(
            ${PAYPAL_BASE}/v1/billing/plans/${sub.plan_id},
            { headers: ppHeaders(ppToken) }
          );
          if (!pRes.ok) continue;
          const plan = await pRes.json();
          const bc   = plan.billing_cycles?.[0];
          const fix  = bc?.pricing_scheme?.fixed_price;
          const freq = bc?.frequency;
          if (!fix || !freq) continue;

          meta = {
            amount_cents  : Math.round(parseFloat(fix.value) * 100),
            interval_unit : freq.interval_unit,   // MONTH | YEAR
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

    /* ========== 3. RESPONSE ========== */
    const payload = {
      /* Stripe */
      stripe_mrr_usd             : toUsd(stripeMRRCents),
      stripe_revenue_all_time_usd: toUsd(stripeAllTimeC),
      stripe_revenue_mtd_usd     : toUsd(stripeMTDC),
      stripe_subscriptions       : stripeSubs,
      payment_intents_sample     : piSample,
      stripe_stats               : {
        subs_pages: sPages, subs_seen: sSeen,
        pi_pages  : piPages, pi_seen : piSeen,
      },

      /* PayPal */
      paypal_mrr_usd      : toUsd(paypalMRRCents),
      paypal_subscriptions: ppSubs,
      paypal_stats        : { pages: ppPages, seen: ppSeen },

      /* Combined */
      total_mrr_usd       : toUsd(stripeMRRCents + paypalMRRCents),
    };

    console.log('Combined metrics', JSON.stringify(payload, null, 2));
    res.status(200).json(payload);

  } catch (err) {
    console.error('Metrics error', err);
    res.status(500).json({ error: err.message });
  }
};
