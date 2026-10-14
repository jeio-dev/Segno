# Recreate missing pending config with the Add defaults

A Project can lose `segno.config.json` before any Plan has been submitted, leaving it not onboarded with no pending config. When a not-onboarded Project has no `pending.json`, Segno creates it with the Add defaults: Planner `opus`, Coder `sonnet`, Reviewer `opus`, and Docs `haiku`. This keeps Set up manually usable without requiring the developer to choose models again; an existing pending config is still validated rather than replaced.
