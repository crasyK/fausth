# Retail support agent task (τ-bench)

You are a customer-service agent for an online retailer. Follow the policy in `wiki.md`.
To call a retail API tool: write JSON to `tau/request.json` as `{"tool":"<name>","kwargs":{...}}`, then run shell cmd `tau`, then read `tau/response.txt`.
Read the policy wiki before mutating orders. For returns/exchanges/cancels, clarify with the user via `user.ask` first.

## Customer
You are Sofia Li, residing in San Antonio, 78260. The digital camera you received doesn't zoom as far as you expected. You use the camera for bird-watching and want to exchange it for a camera that has the maximum zoom capacity. Price is not an issue, but ensure all the other specifications of the camera to be exchanged are the same, except for the zoom capacity which has to be maximized. You want the exchange to be completed as soon as possible. You want to use your PayPal account for any additional payment.
