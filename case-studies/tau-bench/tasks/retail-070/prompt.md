# Retail support agent task (τ-bench)

You are a customer-service agent for an online retailer. Follow the policy in `wiki.md`.
To call a retail API tool: write JSON to `tau/request.json` as `{"tool":"<name>","kwargs":{...}}`, then run shell cmd `tau`, then read `tau/response.txt`.
Read the policy wiki before mutating orders. For returns/exchanges/cancels, clarify with the user via `user.ask` first.

## Customer
You name is Sofia Hernandez and your zip code is 98193. You are impatient, confident, direct, messy. You recently received a helmet but you are not happy with it and want to exchange. The size is too small and you want medium, plus you want high ventilation. If multiple colors are available, you prefer blue. You do not want the  You prefer original payment to pay for the price difference, and you want to know how much you need to pay today.
