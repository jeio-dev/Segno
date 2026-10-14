# Infra retries wait twice, then the third failure blocks immediately

The whole-life Infra budget is exhausted on the third failure. The first failure retries after 30 seconds and the second after 2 minutes; the third blocks immediately, with no further retry or 5-minute delay. This amends ADR-0019 and resolves its unreachable third backoff while preserving the fixed budget cap.
