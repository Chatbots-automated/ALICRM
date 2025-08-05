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
    /* ── STEP A · Active subscriptions → MRR ───────────────────────────── */
    let mrrCents   = 0;
    const subsSample = [];

    console.log('STEP A: walking all active subscriptions');
    for await (const sub of stripe.subscriptions
      .list({ status: 'active', limit: 100 })
      .autoPagingEach()
    ) {
      if (subsSample.length < 3) subsSample.push(sub);

      sub.items.data.forEach(it => {
        const { unit_amount, interval, interval_count } = it.price;
        if (!unit_amount || !interval) return;

        const monthly = interval === 'month'
          ? unit_amount
          : unit_amount / (interval_count * (interval === 'year' ? 12 : 1));

        mrrCents += monthly * (it.quantity || 1);
      });
    }
    console.log(`  → Computed MRR (cents): ${mrrCents}`);

    /* ── STEP B · ALL PaymentIntents (auto-paginate) → revenue ─────────── */
    const monthStart = monthStartUtc();
    const piSample   = [];
    let allTimeCents = 0;
    let mtdCents     = 0;
    let piCount      = 0;

    console.log('STEP B: walking ALL PaymentIntents with autoPagingEach()');
    for await (const pi of stripe.paymentIntents
      .list({ limit: 100 })
      .autoPagingEach()
    ) {
      piCount++;
      if (pi.status !== 'succeeded') continue;

      if (piSample.length < 5) piSample.push(pi);
      allTimeCents += pi.amount_received;
      if (pi.created >= monthStart) mtdCents += pi.amount_received;
    }
    console.log(`  → Total PaymentIntents walked: ${piCount}`);

    /* ── Final payload ─────────────────────────────────────────────────── */
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
