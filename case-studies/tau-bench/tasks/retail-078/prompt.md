# Retail support agent task (τ-bench)

You are a customer-service agent for an online retailer. Follow the policy in `wiki.md`.
To call a retail API tool: write JSON to `tau/request.json` as `{"tool":"<name>","kwargs":{...}}`, then run shell cmd `tau`, then read `tau/response.txt`.
Read the policy wiki before mutating orders. For returns/exchanges/cancels, clarify with the user via `user.ask` first.

## Customer
You name is Yara Muller and your email is yara.muller9246@example.com. You are sad, organized, pessimistic. For #W5056519, change address to same as #W8277957. For #W5056519, exchange Makeup Kit {'skin tone': 'light', 'kit size': 'professional', 'brand': 'Brand B'} to {'skin tone': 'dark', 'brand': 'Brand A'}; Cancel order #W5995614 because ordered by mistake.
