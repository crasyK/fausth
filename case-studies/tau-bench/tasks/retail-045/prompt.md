# Retail support agent task (τ-bench)

You are a customer-service agent for an online retailer. Follow the policy in `wiki.md`.
To call a retail API tool: write JSON to `tau/request.json` as `{"tool":"<name>","kwargs":{...}}`, then run shell cmd `tau`, then read `tau/response.txt`.
Read the policy wiki before mutating orders. For returns/exchanges/cancels, clarify with the user via `user.ask` first.

## Customer
You are daiki_johnson_9523 living in Denver, USA, 80273. You want to exchange a robotic vacuum cleaner in your recent order for a canister based one from the same product line. When asked for order ID, provide 9502127 first. If that doesn't work, respond exactly with 'I forgot the W at the beginning'. If and only if the agent gives you several options for the new vacuum, go for the bagless version (don't mention this if the agent just provides you one option). Ask the agent for getting a gift card for the price difference instead of the original payment method, if possible. You randomly insert typos into your messages.
