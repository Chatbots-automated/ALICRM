/**
 * Vercel Serverless Function – Stripe + PayPal subscriptions dashboard
 * Node 18 (CommonJS)
 *
 *  ▸ Stripe:   customer-expanded MRR  (unchanged)
 *  ▸ PayPal:   active subscriptions   (+ subscriber name  + MRR)
 */

const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16',
});

/* ---------- helpers ---------- */
const toUsd = cents => (cents / 100).toFixed(2);
const monthStartUtc = () => {
  const now = new Date();
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
};

/* ---------- PayPal helpers ---------- */
const PAYPAL_BASE = 'https://api-m.paypal.com';

async function paypalToken () {
  const creds = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString('base64');

  const r = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method : 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error('PayPal token error');
  const { access_token } = await r.json();
  return access_token;
}

function ppHeaders (token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

module.exports = async (req, res) => {
  /* CORS -------------------------------------------------------------- */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    /* =========================================================
       STRIPE  ▸ subscriptions  (unchanged)
    ========================================================= */
    let stripeMRR = 0;
    const stripeSubs = [];
    let sAfter, sPages = 0, sSeen = 0;

    do {
      const page = await stripe.subscriptions.list({
        status        : 'active',
        limit         : 1000,            // capped at 100
        starting_after: sAfter,
        expand        : ['data.customer'],
      });

      sPages += 1;  sSeen += page.data.length;

      page.data.forEach(sub => {
        const cName = (sub.customer && typeof sub.customer === 'object')
          ? (sub.customer.name || sub.customer.email || null)
          : null;

        stripeSubs.push({ ...sub, customer_name: cName });

        sub.items.data.forEach(it => {
          const { unit_amount, interval, interval_count } = it.price;
          if (!unit_amount || !interval) return;
          const monthly = interval === 'month'
            ? unit_amount
            : unit_amount / (interval_count * (interval === 'year' ? 12 : 1));
          stripeMRR += monthly * (it.quantity || 1);
        });
      });

      sAfter = page.has_more ? page.data.at(-1).id : undefined;
    } while (sAfter);

    /* =========================================================
       PAYPAL  ▸ active subscriptions
    ========================================================= */
    const ppToken = await paypalToken();

    const ppSubs   = [];
    const planCache = new Map();  // plan_id → { amount_cents, interval_unit, interval_count }
    let ppAfterPage = 1;
    let ppPages = 0, ppSeen = 0;
    let paypalMRR = 0;

    while (true) {
      const listURL = `${PAYPAL_BASE}/v1/billing/subscriptions` +
        `?status=ACTIVE&page_size=20&page=${ppAfterPage}`;
      const listRes = await fetch(listURL, { headers: ppHeaders(ppToken) });
      if (!listRes.ok) throw new Error('PayPal list error');
      const listJson = await listRes.json();

      const batch = listJson.subscriptions ?? [];
      if (batch.length === 0) break;           // no more pages

      ppPages += 1;  ppSeen += batch.length;

      for (const { id } of batch) {
        // details call
        const dRes = await fetch(
          `${PAYPAL_BASE}/v1/billing/subscriptions/${id}`,
          { headers: ppHeaders(ppToken) }
        );
        if (!dRes.ok) continue;                // skip bad ones
        const sub = await dRes.json();

        // subscriber name/email
        const nameObj = sub.subscriber?.name ?? {};
        const subscriber_name =
          nameObj.full_name ||
          [nameObj.given_name, nameObj.surname].filter(Boolean).join(' ') ||
          sub.subscriber?.email_address ||
          null;

        /* ----- plan price to monthly ----- */
        let planMeta = planCache.get(sub.plan_id);
        if (!planMeta) {
          const pRes = await fetch(
            `${PAYPAL_BASE}/v1/billing/plans/${sub.plan_id}`,
            { headers: ppHeaders(ppToken) }
          );
          if (!pRes.ok) continue;
          const plan = await pRes.json();
          const bc   = plan.billing_cycles?.[0];
          const fixed = bc?.pricing_scheme?.fixed_price;
          const freq  = bc?.frequency;
          if (!fixed || !freq) continue;

          const amountCents = Math.round(parseFloat(fixed.value) * 100);
          planMeta = {
            amount_cents  : amountCents,
            interval_unit : freq.interval_unit,   // MONTH, YEAR, etc.
            interval_count: freq.interval_count,
          };
          planCache.set(sub.plan_id, planMeta);
        }

        // monthly equivalent
        const { amount_cents, interval_unit, interval_count } = planMeta;
        const monthly = interval_unit === 'MONTH'
          ? amount_cents
          : amount_cents / (interval_count * (interval_unit === 'YEAR' ? 12 : 1));
        paypalMRR += monthly;

        ppSubs.push({ ...sub, subscriber_name });
      }

      ppAfterPage += 1;
    }

    /* =========================================================
       RESPONSE
    ========================================================= */
    const payload = {
      /* Stripe */
      stripe_mrr_usd : toUsd(stripeMRR),
      stripe_subscriptions: stripeSubs,
      stripe_stats: { pages: sPages, seen: sSeen },

      /* PayPal */
      paypal_mrr_usd : toUsd(paypalMRR),
      paypal_subscriptions: ppSubs,
      paypal_stats: { pages: ppPages, seen: ppSeen },

      /* combined */
      total_mrr_usd : toUsd(stripeMRR + paypalMRR),
    };

    console.log('Combined metrics', JSON.stringify(payload, null, 2));
    res.status(200).json(payload);
  } catch (err) {
    console.error('Metrics error', err);
    res.status(500).json({ error: err.message });
  }
};
