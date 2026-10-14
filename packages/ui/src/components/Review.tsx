import type { TaskState } from "@segno/core";

/** Verdicts and malformed attempts share their Event order, newest first. */
export function Review({ task }: { task: TaskState }) {
  const reviews = [
    ...task.verdicts.map((entry) => ({ ...entry, kind: "valid" as const })),
    ...task.malformedVerdicts.map((entry) => ({
      ...entry,
      kind: "malformed" as const,
    })),
  ].sort((a, b) => b.seq - a.seq);
  const developer = task.findings.filter(
    ({ source }) => source === "developer",
  );
  return (
    <div>
      {developer.length > 0 && (
        <section aria-label="Developer Findings">
          <h3>Developer Findings</h3>
          {developer.map((finding) => (
            <div key={finding.id} className="run">
              <span className="badge badge-warn">developer · blocking</span>{" "}
              <span className="muted">{finding.open ? "open" : "closed"}</span>
              {finding.file && (
                <span className="mono">
                  {finding.file}
                  {finding.line && `:${finding.line}`}
                </span>
              )}
              <p>{finding.body}</p>
            </div>
          ))}
        </section>
      )}
      {!reviews.length && <p className="muted">No reviews yet.</p>}
      <ol className="run-list">
        {reviews.map((entry) => (
          <li key={entry.seq} className="run">
            {entry.kind === "malformed" ? (
              <>
                <span className="badge badge-bad">Malformed Verdict</span>
                <pre className="prose">
                  {entry.errors
                    .map((error) =>
                      typeof error === "string" ? error : JSON.stringify(error),
                    )
                    .join("\n")}
                </pre>
              </>
            ) : (
              <>
                <span
                  className={`badge ${entry.verdict.decision === "approve" ? "badge-ok" : "badge-bad"}`}
                >
                  {entry.verdict.decision}
                </span>
                <p>{entry.verdict.summary}</p>
                <ul>
                  {entry.verdict.acceptance.map((criterion) => (
                    <li key={criterion.index}>
                      <strong>
                        {criterion.met ? "Met" : "Unmet"}:{" "}
                        {task.definition.acceptance[criterion.index]}
                      </strong>
                      {criterion.note && <p>{criterion.note}</p>}
                    </li>
                  ))}
                </ul>
                <h3>Docs</h3>
                <p>
                  {!entry.verdict.docs.needed
                    ? "Not needed"
                    : entry.verdict.docs.satisfied
                      ? "Satisfied"
                      : "Unsatisfied"}
                  {entry.verdict.docs.note && `: ${entry.verdict.docs.note}`}
                </p>
                {(["blocking", "advisory"] as const).map((severity) => {
                  const findings = entry.verdict.findings.filter(
                    (finding) => finding.severity === severity,
                  );
                  return (
                    findings.length > 0 && (
                      <section
                        key={severity}
                        aria-label={`${severity} reviewer Findings`}
                      >
                        <h3>reviewer · {severity}</h3>
                        <ul>
                          {findings.map((finding, index) => (
                            <li
                              // biome-ignore lint/suspicious/noArrayIndexKey: Findings are immutable within this Verdict.
                              key={index}
                            >
                              {finding.file && (
                                <span className="mono">
                                  {finding.file}
                                  {finding.line && `:${finding.line}`}
                                </span>
                              )}
                              <p>{finding.body}</p>
                            </li>
                          ))}
                        </ul>
                      </section>
                    )
                  );
                })}
                {(entry.verdict.risk?.length ?? 0) > 0 && (
                  <section aria-label="Raised risk">
                    <h3>Raised risk</h3>
                    {entry.verdict.risk?.map(({ flag, reason }, index) => (
                      <p
                        // biome-ignore lint/suspicious/noArrayIndexKey: Risk entries are immutable within this Verdict.
                        key={index}
                      >
                        <span className="badge badge-warn">{flag}</span>{" "}
                        {reason}
                      </p>
                    ))}
                  </section>
                )}
              </>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
