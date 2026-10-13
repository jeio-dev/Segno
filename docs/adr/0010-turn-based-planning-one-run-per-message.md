# Planning is a chat thread, but each developer message is a separate Planner Run

In-app planning looks like a chat: the developer types a brief and free-form replies, and the Planner answers. Under the hood, each developer message is a `planning.reply` Command, and the Engine starts one read-only Planner Run that resumes the same agent session. Its structured reply is either a message (optionally with suggested questions) or a full Plan. The text box is disabled while a Run is live. This keeps the rule that nobody types into a running agent: every input goes through the Engine and is recorded as an Event, and the conversation replays exactly.

## Considered Options

- **Stream typed input into a live agent session** (e.g. Claude Code `--input-format stream-json`). Feels more immediate, but input would bypass the Engine and the Event log, and it would need a long-lived process with no clear end.
- **Structured question forms only.** Fully controlled, but too rigid for agreeing scope.
