/**
 * Vercel Serverless Function – Stripe revenue + MRR
 * CommonJS (Node 18 runtime)
 *
 * NOTE: Stripe’s API silently caps `limit` at 100.  
 * Setting 1000 below won’t hurt—Stripe will just return 100 per call—
 * but you asked to set it to “1 k”, so the parameter is now 1000.
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
    /* ── STEP A · Active subscriptions → MRR ─────────────────────────── */
    let mrrCents = 0;
    let subAfter;
    const subsSample = [];

    do {
      const page = await stripe.subscriptions.list({
        status        : 'active',
        limit         : 1000,             // will be clipped to 100 by Stripe
        starting_after: subAfter,
      });

      page.data.forEach(sub => {
        if (subsSample.length < 3) subsSample.push(sub);
        sub.items.data.forEach(it => {
          const { unit_amount, interval, interval_count } = it.price;
          if (!unit_amount || !interval) return;

          const monthly = interval === 'month'
            ? unit_amount
            : unit_amount / (interval_count * (interval === 'year' ? 12 : 1));

          mrrCents += monthly * (it.quantity || 1);
        });
      });

      subAfter = page.has_more ? page.data.at(-1).id : undefined;
    } while (subAfter);

    /* ── STEP B · PaymentIntents (manual pagination) ─────────────────── */
    const monthStart  = monthStartUtc();
    const piSample    = [];
    let allTimeCents  = 0;
    let mtdCents      = 0;
    let piAfter;
    let totalPI       = 0;

    console.log('STEP B: fetching PaymentIntents 1000 at a time (Stripe caps at 100)');
    do {
      const page = await stripe.paymentIntents.list({
        limit         : 1000,            // will be clipped to 100
        starting_after: piAfter,
      });

      totalPI += page.data.length;
      page.data.forEach(pi => {
        if (pi.status !== 'succeeded') return;
        if (piSample.length < 5) piSample.push(pi);
        allTimeCents += pi.amount_received;
        if (pi.created >= monthStart) mtdCents += pi.amount_received;
      });

      piAfter = page.has_more ? page.data.at(-1).id : undefined;
    } while (piAfter);
    console.log(`  → Total PaymentIntents walked: ${totalPI}`);

    /* ── Final payload ──────────────────────────────────────────────── */
    const payload = {
      mrr_usd                  : toUsd(mrrCents),
      month_to_date_revenue_usd: toUsd(mtdCents),
      all_time_revenue_usd     : toUsd(allTimeCents),
      payment_intents_sample   : piSample,
      subscriptions_sample     : subsSample,
    };

    console.log('Stripe metrics payload', JSON.stringify(payload, null, 2));
    res.status(200).json(payload);
  } catch (err) {
    console.error('Stripe metrics error', err);
    res.status(500).json({ error: err.message });
  }
};
