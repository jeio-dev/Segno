import type { AwaitingItem } from "@segno/core";
import { age } from "../format.js";

/** The selected Project's Awaiting-you items, oldest first. */
export function AwaitingPanel({
  items,
  onReview,
}: {
  items: AwaitingItem[] | undefined;
  onReview(item: AwaitingItem): void;
}) {
  return (
    <aside className="awaiting" aria-label="Awaiting you">
      <div className="awaiting-heading">
        <h2>Awaiting you</h2>
        <output className="badge badge-muted" aria-label="Awaiting count">
          {items?.length ?? 0}
        </output>
      </div>
      {items?.length === 0 && <p className="muted">Nothing needs you.</p>}
      <ul className="awaiting-list">
        {items?.map((item) => (
          <li key={item.id} className="awaiting-item">
            <div className="row">
              <span className="badge badge-muted">{item.kind}</span>
              <span className="mono muted" title={item.planId}>
                {item.taskId ?? item.planId.slice(0, 8)}
              </span>
            </div>
            <span className="awaiting-item-title">{item.title}</span>
            <span className="muted">{age(item.createdAt)}</span>
            {item.kind === "plan-approval" && (
              <div className="row">
                <button
                  type="button"
                  className="button"
                  onClick={() => onReview(item)}
                >
                  Review plan
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
