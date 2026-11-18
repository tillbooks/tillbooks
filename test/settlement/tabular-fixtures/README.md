# Settlement table fixtures (A43 §2)

SYNTHETIC BY CONSTRUCTION. Every row, id, order number, amount and text in these files is invented from
scratch for the tests. Nothing is derived from any real export.

- `shopify_payments_transactions.csv`: the columns of the Shopify Payments payout transactions export, as
  Shopify's help centre documents them. Check on your own export.
- `stripe_balance_change_itemized.csv`: the default columns of Stripe's itemized "Balance change from
  activity" report, as docs.stripe.com/reports/balance documents them. Check on your own export.
- `generic.csv`: an invented till export with a preamble, `;`, dates `dd.mm.yyyy` and a decimal comma, read
  by the generic profile (the guess from the headers).
