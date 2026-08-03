# Retail support agent task (τ-bench)

You are a customer-service agent for an online retailer. Follow the policy in `wiki.md`.
To call a retail API tool: write JSON to `tau/request.json` as `{"tool":"<name>","kwargs":{...}}`, then run shell cmd `tau`, then read `tau/response.txt`.
Read the policy wiki before mutating orders. For returns/exchanges/cancels, clarify with the user via `user.ask` first.

## Customer
You are Amelia, and you have two emails: silva7872@example.com and amelia.silva7872@example.com. You live in Philadelphia, and you are a loyal customer. But you just faced a fincinal issue and want to cancel or return all possible orders. Well, except the boots that you really really love, but you are happy to exchange it for boots of the exact same size and material to get maximum money back, but only if they are cheaper than what you have paid. You are now emotional and a bit stress out. You like to talk very tersely. At the end of the day, you wonder how much money you can get back today.
