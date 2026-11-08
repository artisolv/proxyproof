# Testing PayeeProof in five minutes

No account or setup is needed. Open the app and choose **Open a demo workspace**. Each judge gets a private workspace with fictional vendors, payment history, four people in different roles, an AI agent, and ten sample payment requests. Each sample was submitted through the real pipeline when the workspace was created, and the policy engine decided its outcome. Samples carry a *Sample* tag. None is paid.

## 1. Read the Overview
The dashboard answers who is trying to pay whom, what was verified, what was suspicious, why each request was allowed or stopped, and whether money moved. The five states are distinct:

| State | Meaning |
| --- | --- |
| Allowed | Policy permits it. Nothing is paid until a finance admin or owner releases it. |
| Under review | A person must approve this exact transaction, or more evidence is needed. |
| Held | A verification is missing or failed (new destination, duplicate, unknown payee, bad totals). An approval cannot lift it. |
| Denied | It breaks a rule or an agent's authorization. Final. |
| Completed | PayPal confirmed the payment. Never set by a redirect or by an API call alone. |

Every number comes from stored records. Click any transaction to see the evidence, the verification checklist, the rules that fired, and the payment path.

## 2. Test it yourself
Open **Security Testing**.
- **Upload an invoice.** Pick a test file (genuine, changed destination, wrong total, prompt injection, lookalike sender, new vendor, large bill), or drop your own. Download one, edit it, and upload it again to see the decision change.
- **Send an agent request.** The request is signed with the agent's Ed25519 key and posted through the same path a real agent uses. Presets include a legitimate request, exceeding the limit, an unapproved vendor, the wrong category, a redirected destination, a forged signature, a self-made authorization, a replay and a stale timestamp.

The result shows what was submitted, what was read, each check and whether it matched, the rules that fired, and whether the payment executor was called. For a blocked request, **Try to force the payment** calls the gate directly and shows its refusal code.

## 3. Make a real sandbox payment
For an allowed result, choose **Release in the PayPal sandbox**, or open an allowed transaction and choose **Release payment**. The state becomes *Processing*, then *Completed* only after PayPal confirms. Upload the same file again: it is caught as a duplicate, and a forced release is refused.

## 4. Run the scenario suite
At the bottom of **Security Testing**, **Run all scenarios** runs 28 scenarios, each in a fresh isolated workspace, through the same code. Blocked scenarios also try to release the payment and pass only if the gate refuses. **Run a real sandbox payment** (T18) pays through the PayPal sandbox.

## 5. Verify a changed destination
Open the held **INV-2042** sample. *Where the money would go* shows the verified destination next to the requested one. **Payees** lists every destination change waiting for independent verification. A verified business does not make a new destination trusted.

## 6. Check roles and approvals
Use the person menu in the sidebar. Open the **AL-352** sample (Under review). Priya submitted it, so Morgan (owner) can approve it. Then use **Change details** to alter the destination: the approval becomes void and the request is held. Dana (auditor) can read everything and change nothing.

## 7. Change the policy and verify the audit trail
**Policies:** raise the approval threshold, or send new vendors to review, then choose **Evaluate again** on a request. Hard stops cannot be turned off. **Settings > Audit ledger** recomputes the hash chain and lists every gate decision.

## Published test pack

| ID | Scenario | Expected |
| --- | --- | --- |
| T01 | Valid agent, matching invoice from a trusted vendor | ALLOW |
| T02 | Changed payment destination | HOLD |
| T03 | Lookalike sender domain | HOLD or DENY |
| T04 | Exact duplicate file | HOLD |
| T05 | Duplicate with new layout and reformatted number | REVIEW or HOLD |
| T06 | Agent exceeds per-payment limit | DENY |
| T07 | Agent pays a vendor outside its scope | DENY or HOLD |
| T08 | Expired authorization | DENY |
| T09 | Revoked agent | DENY |
| T10 | Prompt injection in an otherwise correct invoice | REVIEW: instruction ignored, nothing lifted |
| T11 | Total conflicts with line items | HOLD or REVIEW |
| T12 | Legitimate but unverified new vendor | REVIEW or HOLD |
| T13 | Payee changed after approval, old decision replayed | HOLD or DENY, approval void |
| T14 | Already-paid invoice submitted again | DENY |
| T15 | Invoice and email from the verified domain with passing auth | ALLOW |
| T16 | Trusted registry unavailable | HOLD |
| T17 | Forged webhook | Rejected |
| T18 | Real PayPal sandbox payment | COMPLETED |
| T19 | Copied logo, wrong destination | HOLD |
| T20 | Unusual but verified supplier | REVIEW or ALLOW |
| H01 | Hidden-text injection plus substitution | HOLD |
| H02 | Simulated compromised AI model claims all is well | HOLD |
| H03 | Forged agent signature | DENY |
| H04 | Self-made authorization token | DENY |
| H05 | Replayed signed agent message | DENY |
| H06 | Agent asks for more than the attached invoice | HOLD |
| H07 | Reply-To points to another domain | HOLD |
| H08 | Malformed PDF | HOLD |
| H09 | Eight direct executor bypass attempts | All refused |

These are synthetic scenarios written for this project, not verified real-world fraud samples. Passing them does not mean every fraud is caught.
