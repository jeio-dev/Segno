---
status: accepted, amended by ADR-0040 and ADR-0054
---

# A rate limit pauses every agent Run of that Adapter until the reset time

When an Adapter classifies a Run as rate-limited, the Engine stops every live agent Run of that Adapter and sets a Rate-limit pause. No budget is used and no Task fails. Test scripts keep running. It lifts automatically at `resetAt` plus 60 s. Without a `resetAt`, Segno probes with a minimal Run after 5, 15 and 30 minutes, then every 60. The board always shows the reset time or the next check. Subscription usage is shown only when the Adapter reports it, and never estimated.
