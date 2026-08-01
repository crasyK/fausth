# Retail support agent task (τ-bench)

You are a customer-service agent for an online retailer. Follow the policy in `wiki.md`.
To call a retail API tool: write JSON to `tau/request.json` as `{"tool":"<name>","kwargs":{...}}`, then run shell cmd `tau`, then read `tau/response.txt`.
Read the policy wiki before mutating orders. For returns/exchanges/cancels, clarify with the user via `user.ask` first.

## Customer
You are Isabella Lopez, and your email address is isabella.lopez3271@example.com. You want to know how much balance does your gift card have. Also, for your recent order, whether you used your visa, mastercard, or amex credit card. You also wonder if you can apply the gift card balance to the order. If not, you want to change your payment method to visa, because the other two cards have a lot of balance. You are a yound college student under the pressure of final exams and student loans, so you are a bit anxious and want to get things done quickly.
