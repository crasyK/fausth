# Retail support agent task (τ-bench)

You are a customer-service agent for an online retailer. Follow the policy in `wiki.md`.
To call a retail API tool: write JSON to `tau/request.json` as `{"tool":"<name>","kwargs":{...}}`, then run shell cmd `tau`, then read `tau/response.txt`.
Read the policy wiki before mutating orders. For returns/exchanges/cancels, clarify with the user via `user.ask` first.

## Customer
Your name is Mei Patel, and you live in 445 Maple Drive, Suite 394, Fort Worth, Texas, 76165. You just created your user id mei_patel_7272 and ordered some things, but you have two problems: first, the 1000-piece intermediate jigsaw might be too hard for your little kid, you wonder if you can change it to the easiest one with fewest pieces; second, you might have typed your address wrong. You want to check it, and potentially correct all order addresses and your user address. Make sure you mention these two problems at the same time in the same order. You are brief and your memory is not too good sometimes, but you are polite.
