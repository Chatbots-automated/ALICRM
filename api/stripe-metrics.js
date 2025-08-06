/**
 * Vercel Serverless Function – Stripe + PayPal subscriptions dashboard
 * Node 18 (CommonJS)
 *
 * ▸ Stripe  : MRR (subscriptions) + revenue (payment-intents)
 * ▸ PayPal  : LIVE active subscriptions (+ subscriber name) + MRR + revenue
 *
 * ⚠️  HARD-CODED PayPal creds — FOR LOCAL TESTS ONLY
 */
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });

/* ───────── helpers ───────── */
const toUsd        = c => (c / 100).toFixed(2);
const monthStartUtc= () => Math.floor(Date.UTC(new Date().getUTCFullYear(),
                                               new Date().getUTCMonth(), 1) / 1000);
const todayIso     = () => new Date().toISOString().slice(0, 10);

/* ───────── PayPal creds (LIVE) ───────── */
const PAYPAL_CLIENT_ID =
  'AacO4zdSVS1h98mUove2VbJ-B6hBwv6SVV0ofRKer0gVwgnL7cZSB4_F3PlV6bhHFaDoAk6rs3Qsw2lw';
const PAYPAL_CLIENT_SECRET =
  'EJIZYylz8gxmxXD5ZN4ODJP3fCP-vSi28C_7zsZdBYXx5d2VGihVryuTcxnmhVeoXL_om8T0f6G7Vro0';
const PAYPAL_BASE = 'https://api-m.paypal.com';

/* ---------- OAuth token ---------- */
async function paypalToken () {
  const creds = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method : 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body   : 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`PayPal token error - HTTP ${r.status}`);
  return (await r.json()).access_token;
}
const ppHeaders = t => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

/* ---------- PayPal revenue helper (every positive transaction) ---------- */
async function paypalRevenueCents(token, fromIso, toIso) {
  let total = 0;
  let cursor = new Date(`${fromIso}T00:00:00Z`);
  const end  = new Date(`${toIso}T23:59:59Z`);

  while (cursor <= end) {
    const startIso = cursor.toISOString();
    const monthEnd = new Date(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0, 23, 59, 59);
    const stopIso  = (monthEnd > end ? end : monthEnd).toISOString();

    const url = `${PAYPAL_BASE}/v1/reporting/transactions`
              + `?start_date=${encodeURIComponent(startIso)}`
              + `&end_date=${encodeURIComponent(stopIso)}`
              + `&fields=all&page_size=500`;

    const resp = await fetch(url, { headers: ppHeaders(token) });
    if (!resp.ok) { console.warn('PayPal reporting error', resp.status); break; }

    const { transaction_details = [] } = await resp.json();
    for (const t of transaction_details) {
      const val = Number(t.transaction_info?.transaction_amount?.value);
      if (Number.isFinite(val) && val > 0) total += Math.round(val * 100);   // only positive inflow
    }

    cursor = new Date(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1); // next month
  }
  return total;
}

/* ───────────────────────────────────────────────────────────── */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    /* ===== 1. STRIPE  MRR (subscriptions) ===== */
    let stripeMRR = 0, sAfter, sPages = 0, sSeen = 0;
    const stripeSubs = [];

    do {
      const pg = await stripe.subscriptions.list({
        status: 'all', limit: 1000, starting_after: sAfter, expand: ['data.customer'],
      });
      sPages++; sSeen += pg.data.length;

      pg.data.forEach(sub => {
        if (['canceled','unpaid','incomplete_expired'].includes(sub.status)) return;

        const cx = sub.customer;
        const name = typeof cx === 'object' ? cx.name || cx.email || null : null;
        stripeSubs.push({ ...sub, customer_name: name });

        sub.items.data.forEach(it => {
          let cents = it.price.unit_amount;
          if (cents == null) cents = Number(it.price.unit_amount_decimal);
          if (!cents) return;

          const { interval, interval_count } = it.price;
          const ic = Number(interval_count) || 1;
          const monthly = interval === 'month' ? cents : cents / (ic * (interval === 'year' ? 12 : 1));
          stripeMRR += monthly * (it.quantity || 1);
        });
      });

      sAfter = pg.has_more ? pg.data.at(-1).id : undefined;
    } while (sAfter);

    /* ===== 1B. STRIPE  revenue (PaymentIntents) ===== */
    const monthStart = monthStartUtc();
    let piAfter, piPages = 0, piSeen = 0, stripeAll = 0, stripeMTD = 0;
    const piSample = [];

    do {
      const pg = await stripe.paymentIntents.list({ limit: 1000, starting_after: piAfter });
      piPages++; piSeen += pg.data.length;

      pg.data.forEach(pi => {
        if (pi.status !== 'succeeded' || !pi.amount_received) return;
        if (piSample.length < 5) piSample.push(pi);
        stripeAll += pi.amount_received;
        if (pi.created >= monthStart) stripeMTD += pi.amount_received;
      });

      piAfter = pg.has_more ? pg.data.at(-1).id : undefined;
    } while (piAfter);

    /* ===== 2. PAYPAL  MRR (active subscriptions) ===== */
    const ppToken   = await paypalToken();
    const planCache = new Map();
    let ppPage = 1, ppPages = 0, ppSeen = 0, paypalMRR = 0;
    const ppSubs = [];

    while (true) {
      const listURL = `${PAYPAL_BASE}/v1/billing/subscriptions`
                    + `?status=ACTIVE&page_size=20&page=${ppPage}`;
      const listRes = await fetch(listURL, { headers: ppHeaders(ppToken) });
      if (!listRes.ok) throw new Error(`PayPal list ${listRes.status}`);
      const { subscriptions: batch = [] } = await listRes.json();
      if (!batch.length) break;

      ppPages++; ppSeen += batch.length;
      for (const { id } of batch) {
        const subRes = await fetch(`${PAYPAL_BASE}/v1/billing/subscriptions/${id}`,
                                   { headers: ppHeaders(ppToken) });
        if (!subRes.ok) continue;
        const sub = await subRes.json();

        const n = sub.subscriber?.name ?? {};
        const subscriber_name = n.full_name || [n.given_name, n.surname].filter(Boolean).join(' ')
                                || sub.subscriber?.email_address || null;

        let meta = planCache.get(sub.plan_id);
        if (!meta) {
          const pRes = await fetch(`${PAYPAL_BASE}/v1/billing/plans/${sub.plan_id}`,
                                   { headers: ppHeaders(ppToken) });
          if (!pRes.ok) continue;
          const plan = await pRes.json();
          const bc   = plan.billing_cycles?.[0];
          const fix  = bc?.pricing_scheme?.fixed_price;
          const freq = bc?.frequency;
          if (!fix || !freq) continue;

          meta = {
            amount_cents  : Math.round(parseFloat(fix.value) * 100),
            interval_unit : freq.interval_unit,
            interval_count: freq.interval_count,
          };
          planCache.set(sub.plan_id, meta);
        }

        const { amount_cents, interval_unit, interval_count } = meta;
        const monthly = interval_unit === 'MONTH'
          ? amount_cents
          : amount_cents / (interval_count * (interval_unit === 'YEAR' ? 12 : 1));

        paypalMRR += monthly;
        ppSubs.push({ ...sub, subscriber_name });
      }
      ppPage++;
    }

    /* ===== 2B. PAYPAL  revenue ===== */
    const today = todayIso();
    const paypalAll = await paypalRevenueCents(ppToken, '2010-01-01', today);
    const paypalMTD = await paypalRevenueCents(
      ppToken,
      today.slice(0, 8) + '01',   // first of current month
      today
    );

    /* ===== RESPONSE ===== */
    res.status(200).json({
      /* Stripe */
      stripe_mrr_usd             : toUsd(stripeMRR),
      stripe_revenue_all_time_usd: toUsd(stripeAll),
      stripe_revenue_mtd_usd     : toUsd(stripeMTD),

      /* PayPal */
      paypal_mrr_usd             : toUsd(paypalMRR),
      paypal_revenue_all_time_usd: toUsd(paypalAll),
      paypal_revenue_mtd_usd     : toUsd(paypalMTD),

      /* Combined */
      total_mrr_usd              : toUsd(stripeMRR + paypalMRR),
    });

  } catch (err) {
    console.error('Metrics error', err);
    res.status(500).json({ error: err.message });
  }
};
