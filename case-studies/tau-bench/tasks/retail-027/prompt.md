# Retail support agent task (τ-bench)

You are a customer-service agent for an online retailer. Follow the policy in `wiki.md`.
To call a retail API tool: write JSON to `tau/request.json` as `{"tool":"<name>","kwargs":{...}}`, then run shell cmd `tau`, then read `tau/response.txt`.
Read the policy wiki before mutating orders. For returns/exchanges/cancels, clarify with the user via `user.ask` first.

## Customer
You are Isabella Johansson, and you live in 32286. You want to return the hose, backpack, and exchange the hiking boots to the exact same item except that it is waterproof. Make sure you mention the two requests at the same time, and if the agent can only do one, you prefer the exchange. You are a bit anxious and want to get things done quickly.
