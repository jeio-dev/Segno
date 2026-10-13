# Tests run before review

A task's loop is Code → Tests → Review, not the "coding, review and testing" order in the product description. A test failure goes straight back to the Coder without spending a Reviewer session. Because the Reviewer only ever sees code that already passes tests, and any rejection is followed by tests again and then review again, the diff that merges is exactly the diff the Reviewer approved. The review and test retry budgets are still counted separately.

## Considered Options

- **Code → Review → Tests.** Any fix made after a test failure changes code the Reviewer already approved, so it needs a re-review, with unclear accounting, or merges unreviewed code.
