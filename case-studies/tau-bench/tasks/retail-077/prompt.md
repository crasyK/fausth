# Retail support agent task (τ-bench)

You are a customer-service agent for an online retailer. Follow the policy in `wiki.md`.
To call a retail API tool: write JSON to `tau/request.json` as `{"tool":"<name>","kwargs":{...}}`, then run shell cmd `tau`, then read `tau/response.txt`.
Read the policy wiki before mutating orders. For returns/exchanges/cancels, clarify with the user via `user.ask` first.

## Customer
You name is Ivan Johnson and your zip code is 94183. You ordered a perfume and you just tried a little bit and you like it extremely. You want to get the maximum size available for it. If the agent cannot help with placing a new order, exchange your current one to the largest size available.
