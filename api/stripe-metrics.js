/**
 * Vercel Serverless Function – Stripe revenue + MRR
 * CommonJS (Node 18 runtime)
 */

const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16',
});

const toUsd = cents => (cents / 100).toFixed(2);
const monthStartUtc = () => {
  const now = new Date();
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
};

module.exports = async (req, res) => {
  /* CORS */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    /* ── STEP A · Subscriptions → MRR  (manual pagination) ────────────── */
    let mrrCents   = 0;
    let subAfter;
    let subsPages  = 0;
    let subsSeen   = 0;
    const subsSample = [];

    console.log('STEP A: fetching Subscriptions with limit=1000 (Stripe caps at 100)');
    do {
      const page = await stripe.subscriptions.list({
        status        : 'active',      // change to 'all' if you need every status
        limit         : 1000,          // Stripe clips to 100
        starting_after: subAfter,
      });

      subsPages += 1;
      subsSeen  += page.data.length;

      page.data.forEach(sub => {
        if (subsSample.length < 5) subsSample.push(sub); // keep first 5
        sub.items.data.forEach(it => {
          const { unit_amount, interval, interval_count } = it.price;
          if (!unit_amount || !interval) return;
          const monthly =
            interval === 'month'
              ? unit_amount
              : unit_amount / (interval_count * (interval === 'year' ? 12 : 1));
          mrrCents += monthly * (it.quantity || 1);
        });
      });

      subAfter = page.has_more ? page.data.at(-1).id : undefined;
    } while (subAfter);

    console.log(`  → subscription pages walked : ${subsPages}`);
    console.log(`  → subscriptions seen        : ${subsSeen}`);

    /* ── STEP B · PaymentIntents pagination (unchanged) ──────────────── */
    const monthStart  = monthStartUtc();
    const piSample    = [];
    let allTimeCents  = 0;
    let mtdCents      = 0;
    let piAfter;
    let piPages = 0;
    let piSeen  = 0;

    console.log('STEP B: fetching PaymentIntents with limit=1000 (capped at 100)');
    do {
      const page = await stripe.paymentIntents.list({
        limit         : 1000,          // Stripe clips to 100
        starting_after: piAfter,
      });

      piPages += 1;
      piSeen  += page.data.length;

      page.data.forEach(pi => {
        if (pi.status !== 'succeeded' && pi.amount_received === 0) return;
        if (piSample.length < 5) piSample.push(pi);
        allTimeCents += pi.amount_received;
        if (pi.created >= monthStart) mtdCents += pi.amount_received;
      });

      piAfter = page.has_more ? page.data.at(-1).id : undefined;
    } while (piAfter);

    console.log(`  → payment-intent pages walked : ${piPages}`);
    console.log(`  → payment-intents seen        : ${piSeen}`);

    /* ── Final payload ──────────────────────────────────────────────── */
    const payload = {
      /* revenue */
      mrr_usd                  : toUsd(mrrCents),
      month_to_date_revenue_usd: toUsd(mtdCents),
      all_time_revenue_usd     : toUsd(allTimeCents),

      /* samples */
      payment_intents_sample   : piSample,
      subscriptions_sample     : subsSample,

      /* diagnostics */
      subs_pages_walked        : subsPages,
      subs_seen                : subsSeen,
      pi_pages_walked          : piPages,
      pi_seen                  : piSeen,
    };

    console.log('Stripe metrics payload', JSON.stringify(payload, null, 2));
    res.status(200).json(payload);
  } catch (err) {
    console.error('Stripe metrics error', err);
    res.status(500).json({ error: err.message });
  }
};
