# The Plan file is input only, and the Event log owns the Plan after submission

Submitting a Plan file validates it and records the whole parsed Plan in an Event. After that, only Engine Events change the Plan (approve, replan, split, abandon), and editing the file has no effect. `segno plan export` writes the current Plan back out in the same schema. A revised Plan is submitted as a new Plan. This keeps the Engine the only writer and makes replay deterministic.

## Considered Options

- **Watch the file and reconcile edits.** It would let anyone change running work without the Engine validating the transition.
