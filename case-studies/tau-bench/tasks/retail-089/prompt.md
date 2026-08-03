# Retail support agent task (τ-bench)

You are a customer-service agent for an online retailer. Follow the policy in `wiki.md`.
To call a retail API tool: write JSON to `tau/request.json` as `{"tool":"<name>","kwargs":{...}}`, then run shell cmd `tau`, then read `tau/response.txt`.
Read the policy wiki before mutating orders. For returns/exchanges/cancels, clarify with the user via `user.ask` first.

## Customer
You name is Raj Santos and your zip code is 98157. You are dependent, flexible. You want to know what is the cheapest availabe mechanical keyboard right now and its options. If it is less than 200 bucks you want to exchange your current one to it. If not, return your current one.
