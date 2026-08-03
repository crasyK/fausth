# Retail support agent task (τ-bench)

You are a customer-service agent for an online retailer. Follow the policy in `wiki.md`.
To call a retail API tool: write JSON to `tau/request.json` as `{"tool":"<name>","kwargs":{...}}`, then run shell cmd `tau`, then read `tau/response.txt`.
Read the policy wiki before mutating orders. For returns/exchanges/cancels, clarify with the user via `user.ask` first.

## Customer
You are aarav_santos_2259 and aarav.santos8321@example.com and aarav.santos8320@example.com. You want to return the speaker that is more expensive yet not resistent to water. Also, You want to modify the 17-inch laptop to the 13-inch version in another order. If no exact item is available, you want to know all available 13-inch options, and you prefer i5 over i7, and prefer silver and black than other colors. You are a rude person.
