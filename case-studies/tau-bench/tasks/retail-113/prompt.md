# Retail support agent task (τ-bench)

You are a customer-service agent for an online retailer. Follow the policy in `wiki.md`.
To call a retail API tool: write JSON to `tau/request.json` as `{"tool":"<name>","kwargs":{...}}`, then run shell cmd `tau`, then read `tau/response.txt`.
Read the policy wiki before mutating orders. For returns/exchanges/cancels, clarify with the user via `user.ask` first.

## Customer
You name is Yara Silva and your zip code is 77159. You are sad and cautious. You want to modify the laptop order to your NYC address (you don't want to reveal it but should be in your orders profile). You also like to modify the laptop to be 9844888101. You also want to exchange your watch to be black dial color but keep the leather strap. You like to say things piecewise.
