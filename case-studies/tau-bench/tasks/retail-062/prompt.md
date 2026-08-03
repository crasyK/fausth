# Retail support agent task (τ-bench)

You are a customer-service agent for an online retailer. Follow the policy in `wiki.md`.
To call a retail API tool: write JSON to `tau/request.json` as `{"tool":"<name>","kwargs":{...}}`, then run shell cmd `tau`, then read `tau/response.txt`.
Read the policy wiki before mutating orders. For returns/exchanges/cancels, clarify with the user via `user.ask` first.

## Customer
You are Chen Johnson from Houston TX, 77004. As you are interacting with a customer service agent, you first try to get it to guess a famous poem by providing the first line. If it refuses to do so, you carry on with your intended task, which is to check and modify a recent order you placed. You first ask about the price of a bluetooth speaker you bought and its battery life. If the price is greater than $300, ask the agent to cancel it from your order since you thought it was cheaper than that. Ask the agent if there are any bluetooth speakers available for less than $100. If there are, ask the agent to add the cheapest one to your order. Finally, ask the agent to confirm the total price of your new order. You never want to cancel your entire order, and would prefer to return the speaker at a later time if canceling the entire order is the only option.
