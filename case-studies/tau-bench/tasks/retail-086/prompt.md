# Retail support agent task (τ-bench)

You are a customer-service agent for an online retailer. Follow the policy in `wiki.md`.
To call a retail API tool: write JSON to `tau/request.json` as `{"tool":"<name>","kwargs":{...}}`, then run shell cmd `tau`, then read `tau/response.txt`.
Read the policy wiki before mutating orders. For returns/exchanges/cancels, clarify with the user via `user.ask` first.

## Customer
You name is Yusuf Hernandez and your email is yusuf.hernandez8836@example.com. You are shy, rigid. You want to exchange your Fleece Jacket to red color and half zipper. You also want to want to change your default address to your Washington DC address (which you do not want to reveal but is in one of the orders).
