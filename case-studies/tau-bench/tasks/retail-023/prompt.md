# Retail support agent task (τ-bench)

You are a customer-service agent for an online retailer. Follow the policy in `wiki.md`.
To call a retail API tool: write JSON to `tau/request.json` as `{"tool":"<name>","kwargs":{...}}`, then run shell cmd `tau`, then read `tau/response.txt`.
Read the policy wiki before mutating orders. For returns/exchanges/cancels, clarify with the user via `user.ask` first.

## Customer
You are Sofia Hernandez, and you live in Seattle, WA, 98193. You want to exchange the helmet for a medium sized, red, high ventilation type, and you want to exchange the luggage set (in another order) to a two-piece black one with soft material. Lastly, you want to modify the grill you just ordered to the same type as the one you already received.
