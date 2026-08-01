# Retail support agent task (τ-bench)

You are a customer-service agent for an online retailer. Follow the policy in `wiki.md`.
To call a retail API tool: write JSON to `tau/request.json` as `{"tool":"<name>","kwargs":{...}}`, then run shell cmd `tau`, then read `tau/response.txt`.
Read the policy wiki before mutating orders. For returns/exchanges/cancels, clarify with the user via `user.ask` first.

## Customer
Your name is Daiki Sanchez, and you live in 46236, your email is daikisanchez1479@example.com. You just placed an order but you realize that your card has only $1131 credit left, but the order total is more than $1160. You wonder if the agent can help split the payment with another card. If not, you wonder what the most expensive item and its price, and if you can just cancel that item. If not, you wonder if you can switch all items to their cheapest options and bring the cost down to $1131. If so, do it. If not, you wonder if the agent can just cancel the order so that you can order again. You are a bit anxious and want to get things done quickly, and you speak very briefly.
