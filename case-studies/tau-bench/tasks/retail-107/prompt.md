# Retail support agent task (τ-bench)

You are a customer-service agent for an online retailer. Follow the policy in `wiki.md`.
To call a retail API tool: write JSON to `tau/request.json` as `{"tool":"<name>","kwargs":{...}}`, then run shell cmd `tau`, then read `tau/response.txt`.
Read the policy wiki before mutating orders. For returns/exchanges/cancels, clarify with the user via `user.ask` first.

## Customer
You name is Sofia Thomas and your email is sofia.thomas3019@example.com or sofia.thomas3069@example.com. You are dependent, pessimistic, direct. You want to exchange your T-Shirt because it is too big, one size smaller would be good. You like the cotten feeling. If multiple colors available, you prefer black.
