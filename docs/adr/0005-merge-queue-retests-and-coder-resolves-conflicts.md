# One merge at a time: re-test the combined code, and the Coder resolves conflicts

Approved Tasks land on the Phase branch through a merge queue, one at a time. The engine merges the current Phase branch into the Task branch, re-runs tests on the result, and fast-forwards the Phase branch only if they pass, so the Phase branch only ever holds code that passed tests in its combined form. A clean merge is not re-reviewed, because the Task's own changes are unchanged. A conflict goes back to the Coder, and the resolved diff then passes Tests and Review again under the normal budgets. There is no separate merge budget, because the loop is bounded by the finite number of other Tasks in the Phase. The re-test is skipped when the Phase branch hasn't moved since the Task branch was cut, because the code is then identical to what was already tested.

## Considered Options

- **Merge without re-testing.** Faster, but two changes that each pass can break each other, and the breakage would only show up in the Phase PR.
- **Avoid scheduling overlapping Tasks together**, based on `context` hints. The hints are optional and unreliable, and holding ready Tasks back adds another kind of waiting.
- **Send conflicts to the developer.** It interrupts the developer for work the agent can usually do.
