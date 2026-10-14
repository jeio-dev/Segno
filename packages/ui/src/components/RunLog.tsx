import type { HostClient, RunState } from "@segno/core";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../format.js";

/**
 * One Run's output in a terminal panel: streamed from `runOutput` while the
 * Run is live, otherwise its stored transcript or output.log [api.md].
 */
export function RunLog({
  client,
  projectId,
  run,
}: {
  client: HostClient;
  projectId: string;
  run: RunState;
}) {
  const [text, setText] = useState("");
  const [note, setNote] = useState<string>();
  // A Run watched live keeps the output it streamed.
  const streamed = useRef(false);
  const finished = run.outcome !== undefined;

  useEffect(() => {
    let current = true;
    let stream: { close(): void } | undefined;
    setNote(undefined);
    if (!finished) {
      setText("");
      void client
        .runOutput(projectId, run.id, (item) => {
          if (!current || item.kind !== "output") return;
          streamed.current = true;
          setText((before) => before + item.text);
        })
        .then((opened) => {
          if (current) stream = opened;
          else opened.close();
        })
        .catch((error) => current && setNote(errorMessage(error)));
    } else if (!streamed.current) {
      client
        .query(projectId, "runTranscript", { runId: run.id })
        .then((stored) => current && setText(stored))
        .catch((error) => {
          if (!current) return;
          const pruned =
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "pruned";
          setNote(pruned ? "transcript pruned" : errorMessage(error));
        });
    }
    return () => {
      current = false;
      stream?.close();
    };
  }, [client, projectId, run.id, finished]);

  return (
    <pre className="terminal">
      {note ? <span className="terminal-dim">{note}</span> : text}
      {!note && !text && (
        <span className="terminal-dim">
          {finished ? "No output." : "Waiting for output…"}
        </span>
      )}
    </pre>
  );
}
