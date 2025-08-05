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
  /* simple CORS */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    /* ── STEP A · Active subscriptions → MRR ───────────────── */
    let mrrCents = 0;
    let subAfter;
    const subsSample = [];

    do {
      const page = await stripe.subscriptions.list({
        status: 'active',
        limit : 100,
        starting_after: subAfter,
      });

      page.data.forEach(sub => {
        if (subsSample.length < 3) subsSample.push(sub);
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

    /* ── STEP B · PaymentIntents (filter inside loop) ───────── */
    const monthStart = monthStartUtc();
    let intentAfter;
    const piSample = [];
    let allTimeCents = 0;
    let mtdCents    = 0;

    do {
      const page = await stripe.paymentIntents.list({
        limit : 100,
        starting_after: intentAfter,
      });

      page.data.forEach(pi => {
        if (pi.status !== 'succeeded') return;           // ← filter here
        if (piSample.length < 5) piSample.push(pi);      // sample log
        allTimeCents += pi.amount_received;
        if (pi.created >= monthStart) mtdCents += pi.amount_received;
      });

      intentAfter = page.has_more ? page.data.at(-1).id : undefined;
    } while (intentAfter);

    /* ── Final payload ─────────────────────────────────────── */
    const payload = {
      mrr_usd                 : toUsd(mrrCents),
      month_to_date_revenue_usd: toUsd(mtdCents),
      all_time_revenue_usd    : toUsd(allTimeCents),
      payment_intents_sample  : piSample,
      subscriptions_sample    : subsSample,
    };

    console.log('Stripe metrics payload', JSON.stringify(payload, null, 2));
    res.status(200).json(payload);
  } catch (err) {
    console.error('Stripe metrics error', err);
    res.status(500).json({ error: err.message });
  }
};
