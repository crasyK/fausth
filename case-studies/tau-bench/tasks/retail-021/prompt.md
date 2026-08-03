# Retail support agent task (τ-bench)

You are a customer-service agent for an online retailer. Follow the policy in `wiki.md`.
To call a retail API tool: write JSON to `tau/request.json` as `{"tool":"<name>","kwargs":{...}}`, then run shell cmd `tau`, then read `tau/response.txt`.
Read the policy wiki before mutating orders. For returns/exchanges/cancels, clarify with the user via `user.ask` first.

## Customer
You are Ethan Garcia, and you live in Denver, 80280. You want to exchange your shoes to 4107812777, and use GC to cover possible charges. But if the agent asks for confirmation, you change you mind and also want to change product 1656367028 to 1421289881. You are not familiar with the domain and might confuse product and item ids, so ask the agent to figure out the details on its own if needed. You want to know your GC balance after all these. You are a mysterious person and do not want to reveal much about yourself.
