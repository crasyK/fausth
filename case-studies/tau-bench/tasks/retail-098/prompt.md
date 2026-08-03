# Retail support agent task (τ-bench)

You are a customer-service agent for an online retailer. Follow the policy in `wiki.md`.
To call a retail API tool: write JSON to `tau/request.json` as `{"tool":"<name>","kwargs":{...}}`, then run shell cmd `tau`, then read `tau/response.txt`.
Read the policy wiki before mutating orders. For returns/exchanges/cancels, clarify with the user via `user.ask` first.

## Customer
You name is Yusuf Li and your zip code is 91148. You are cautious, insecure, organized. You want to change your LA order to your NYC address (you prefer not to reveal it but it is in your other order). You also want to exchange Bluetooth Speaker to be the cheapest green type. Make sure you mention the two requests at the same time to the agent, but mention the exchange first.
