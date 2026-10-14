import type { Board, BoardTask, TaskStatus } from "@segno/core";
import { useLayoutEffect, useRef, useState } from "react";

/** The seven columns and the Task states each one holds [ADR-0028]. */
const columns: { name: string; states: TaskStatus[] }[] = [
  { name: "Queued", states: ["waiting", "ready"] },
  { name: "Coding", states: ["coding", "taken-over"] },
  { name: "Testing", states: ["testing"] },
  { name: "Review", states: ["reviewing"] },
  { name: "Merge", states: ["held", "merging"] },
  { name: "Blocked", states: ["blocked"] },
  { name: "Done", states: ["done"] },
];

/** Done shows its five newest cards until expanded. */
const doneShown = 5;

type Holder = "coder" | "tests" | "reviewer" | "you";
const holderLabels: Record<Holder, string> = {
  coder: "Coder",
  tests: "Tests",
  reviewer: "Reviewer",
  you: "you",
};

/** Who holds a card: a Role, or the developer as "you" [ADR-0028]. */
export function holderOf(task: BoardTask): Holder | undefined {
  switch (task.state) {
    case "coding":
      return "coder";
    case "taken-over":
    case "held":
    case "blocked":
      return "you";
    case "testing":
      return "tests";
    case "reviewing":
      return "reviewer";
    case "merging":
      // Tests hold the card during the merge re-test.
      return task.run?.kind === "tests" ? "tests" : undefined;
    default:
      return undefined;
  }
}

export function RoleDot({ holder, live }: { holder: Holder; live: boolean }) {
  return (
    <span className="role" data-role={holder} data-live={live}>
      <span className="role-dot" aria-hidden="true" />
      {holderLabels[holder]}
    </span>
  );
}

/**
 * The board's columns and cards. Cards that change column animate from where
 * they were, unless reduced motion is preferred [ADR-0032].
 */
export function TaskBoard({
  board,
  doneOrder,
  selected,
  onSelect,
}: {
  board: Board;
  /** The seq at which each Task became done, for Done's newest-first order. */
  doneOrder: ReadonlyMap<string, number>;
  selected: string | undefined;
  onSelect(taskId: string): void;
}) {
  const [doneExpanded, setDoneExpanded] = useState(false);
  const cards = useRef(new Map<string, HTMLElement>());
  const positions = useRef(new Map<string, DOMRect>());

  useLayoutEffect(() => {
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const style = getComputedStyle(document.documentElement);
    const duration = Number.parseFloat(style.getPropertyValue("--dur-move"));
    const easing = style.getPropertyValue("--ease-move").trim() || "ease";
    const next = new Map<string, DOMRect>();
    for (const [id, element] of cards.current) {
      const now = element.getBoundingClientRect();
      next.set(id, now);
      const before = positions.current.get(id);
      if (reduced || !before || !duration) continue;
      const dx = before.left - now.left;
      const dy = before.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      element.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
        { duration, easing },
      );
    }
    positions.current = next;
  });

  return (
    <div className="columns">
      {columns.map(({ name, states }) => {
        let tasks = board.tasks.filter(({ state }) => states.includes(state));
        let hidden = 0;
        if (name === "Done") {
          tasks = tasks.sort(
            (a, b) => (doneOrder.get(b.id) ?? 0) - (doneOrder.get(a.id) ?? 0),
          );
          if (!doneExpanded && tasks.length > doneShown) {
            hidden = tasks.length - doneShown;
            tasks = tasks.slice(0, doneShown);
          }
        }
        return (
          <section
            key={name}
            className="column"
            data-column={name}
            aria-labelledby={`column-${name}`}
          >
            <h2 id={`column-${name}`} className="column-heading">
              {name}
              <span className="column-count mono">
                {board.tasks.filter(({ state }) => states.includes(state))
                  .length || ""}
              </span>
            </h2>
            <ul className="card-list" aria-label={name}>
              {tasks.map((task) => (
                <li
                  key={task.id}
                  ref={(element) => {
                    if (element) cards.current.set(task.id, element);
                    else cards.current.delete(task.id);
                  }}
                >
                  <Card
                    task={task}
                    selected={selected === task.id}
                    onSelect={() => onSelect(task.id)}
                  />
                </li>
              ))}
            </ul>
            {hidden > 0 && (
              <button
                type="button"
                className="button button-quiet"
                onClick={() => setDoneExpanded(true)}
              >
                Show {hidden} more
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}

function Card({
  task,
  selected,
  onSelect,
}: {
  task: BoardTask;
  selected: boolean;
  onSelect(): void;
}) {
  const holder = holderOf(task);
  return (
    <button
      type="button"
      className="card"
      aria-label={`${task.id} ${task.title}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="task-id">{task.id}</span>
      <span className="card-title">{task.title}</span>
      {(holder || task.queuedToMerge) && (
        <span className="row">
          {holder && <RoleDot holder={holder} live={Boolean(task.run)} />}
          {task.queuedToMerge && <span className="muted">queued to merge</span>}
        </span>
      )}
    </button>
  );
}
