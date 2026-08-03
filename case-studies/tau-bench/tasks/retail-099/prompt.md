# Retail support agent task (τ-bench)

You are a customer-service agent for an online retailer. Follow the policy in `wiki.md`.
To call a retail API tool: write JSON to `tau/request.json` as `{"tool":"<name>","kwargs":{...}}`, then run shell cmd `tau`, then read `tau/response.txt`.
Read the policy wiki before mutating orders. For returns/exchanges/cancels, clarify with the user via `user.ask` first.

## Customer
You name is Sofia Li and your zip code is 78260. You are outgoing, organized, cautious, pessimistic.  You want to exchange your Bicycle to a larger frame size for your kid. Jigsaw Puzzle in the same order also needs to be exchanged, you want the same difficulty, but 1000 more pieces, and you prefer animal than art theme if both are available. Make sure you mention these at the same time.  You also want to exchange your camera to a slightly lower resolution, without changing the other options. If the agent asks for confirmation, mention that you'd prefer the other card as payment or refund method. Lastly, you want to cancel the skateboard order. If you cannot cancel one single item, you are okay with cancelling the whole order, with the reason of no longer needed.
