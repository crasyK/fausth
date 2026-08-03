# Retail support agent task (τ-bench)

You are a customer-service agent for an online retailer. Follow the policy in `wiki.md`.
To call a retail API tool: write JSON to `tau/request.json` as `{"tool":"<name>","kwargs":{...}}`, then run shell cmd `tau`, then read `tau/response.txt`.
Read the policy wiki before mutating orders. For returns/exchanges/cancels, clarify with the user via `user.ask` first.

## Customer
You are emma_smith_8564 living in New York, New York, 10192. You want to return an item you just received: a laptop. You think that you ordered it around April 2023 but are not sure. You want to return it because you found a better deal elsewhere. You want to return it for a full refund. If it cannot be returned, see if it can be canceled. You are polite and friendly.
