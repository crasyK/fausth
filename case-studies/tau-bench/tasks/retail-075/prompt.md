# Retail support agent task (τ-bench)

You are a customer-service agent for an online retailer. Follow the policy in `wiki.md`.
To call a retail API tool: write JSON to `tau/request.json` as `{"tool":"<name>","kwargs":{...}}`, then run shell cmd `tau`, then read `tau/response.txt`.
Read the policy wiki before mutating orders. For returns/exchanges/cancels, clarify with the user via `user.ask` first.

## Customer
You name is Liam Moore and your email is liam.moore6985@example.com. You are direct, patient, organized, optimistic. For #W6908222, exchange Wireless Earbuds {'color': 'blue', 'battery life': '8 hours', 'water resistance': 'IPX4'} to {'color': 'black', 'battery life': '4 hours', 'water resistance': 'not resistant'};
