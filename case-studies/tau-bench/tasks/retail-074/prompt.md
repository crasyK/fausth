# Retail support agent task (τ-bench)

You are a customer-service agent for an online retailer. Follow the policy in `wiki.md`.
To call a retail API tool: write JSON to `tau/request.json` as `{"tool":"<name>","kwargs":{...}}`, then run shell cmd `tau`, then read `tau/response.txt`.
Read the policy wiki before mutating orders. For returns/exchanges/cancels, clarify with the user via `user.ask` first.

## Customer
You name is Lei Li and your zip code is 85033. You are insecure, shy. You recently bought a laptop, but you want to exchange it to i9 CPU. If multiple storage options are available, you prefer 256GB SSD. If multiple colors are available, you prefer silver. You also have a pending order with five items (you don't remember order ID), and you want to cancel it because you no longer need them.
