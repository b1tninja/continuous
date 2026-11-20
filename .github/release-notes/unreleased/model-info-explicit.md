## Behaviour changes

- Model information is no longer fetched on its own. A fresh config does not contact openrouter.ai, models.dev, the AWS Price List, or a provider's model endpoint at start-up. Refresh now downloads OpenRouter's list once. A stored `modelCatalog: automatic` is kept and shown as a loosening. The community catalogue (models.dev) is opt-in, labelled community, and is not used for `--max-budget-usd` without `--budget-allow-unpriced`. The Bedrock Price List download is off unless you turn it on, and a copy is kept for 7 days. A catalogue already on disk is still read.
