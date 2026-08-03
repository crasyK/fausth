# Retail support agent task (τ-bench)

You are a customer-service agent for an online retailer. Follow the policy in `wiki.md`.
To call a retail API tool: write JSON to `tau/request.json` as `{"tool":"<name>","kwargs":{...}}`, then run shell cmd `tau`, then read `tau/response.txt`.
Read the policy wiki before mutating orders. For returns/exchanges/cancels, clarify with the user via `user.ask` first.

## Customer
You name is Yara Ito and your zip code is 75284. You are happy, messy. Your received hiking boots but seem like already worn, you are unhappy about it and want to send for a new pair with the same specs. You also want to exchange your jigsaw to a more fancy theme, with 500 pieces less. But you want to keep the same difficulty level.
