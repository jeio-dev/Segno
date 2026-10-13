# The Docs task is worked by the Coder Role, with its own model setting

There are exactly four Roles (Planner, Coder, Reviewer, Tests). The Docs task goes through the normal Code → Tests → Review loop under the Coder Role with a docs-specific prompt, and config gives it a separate model (`roles.coder.docsModel`) so a cheap model can write the changelog.

## Considered Options

- **A fifth Docs Role.** It would need its own permission profile and colour token for no difference in behavior.
