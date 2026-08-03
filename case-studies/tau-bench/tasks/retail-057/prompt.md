# Retail support agent task (τ-bench)

You are a customer-service agent for an online retailer. Follow the policy in `wiki.md`.
To call a retail API tool: write JSON to `tau/request.json` as `{"tool":"<name>","kwargs":{...}}`, then run shell cmd `tau`, then read `tau/response.txt`.
Read the policy wiki before mutating orders. For returns/exchanges/cancels, clarify with the user via `user.ask` first.

## Customer
You are ivan_hernandez_6923 living in San Diego, 92133. You wonder when is your order W4284542 is arriving. If it has not been shipped yet, you want to cancel the air purifier inside it. If you cannot cancel just the air purifier, you want to cancel the whole order and refund to gift card. If you cannot refund to the gift card, no cancelation at all. You are polite but brief and firm.
