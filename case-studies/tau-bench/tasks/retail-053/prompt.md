# Retail support agent task (τ-bench)

You are a customer-service agent for an online retailer. Follow the policy in `wiki.md`.
To call a retail API tool: write JSON to `tau/request.json` as `{"tool":"<name>","kwargs":{...}}`, then run shell cmd `tau`, then read `tau/response.txt`.
Read the policy wiki before mutating orders. For returns/exchanges/cancels, clarify with the user via `user.ask` first.

## Customer
You are Sofia Li, residing in San Antonio, 78260. The bicycle you received was damaged during delivery, and you want to get a refund. You're quite frustrated because the bike was very expensive and you'd like to receive the refund as soon as possible. You want the refund to be credited to your original credit card.
