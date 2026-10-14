---
status: accepted, amended by ADR-0060
---

# Run timeouts and a whole-life infra budget of 3

Every Run has a wall-clock timeout per Role, configurable, with defaults of Coder 45, Reviewer 15, Planner 20 and test script 15 minutes. Agent Runs also have an idle timeout (10 min by default) with no Adapter event. A timed-out or hung agent Run is an infra failure: it is stopped, uses 1 of the Task's 3 infra budget (counted over the Task's whole life, not per step), and the step reruns after a backoff of 30 s, 2 min, then 5 min. Exhausting it blocks the Task with `infra-limit`. A timed-out test script is a test failure, because hangs are almost always the code's fault. The review (2) and test (2) caps are fixed and not configurable.
