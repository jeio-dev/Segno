import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { launch, repoWithRemote, stubDialog, tempDir } from "./app.js";

// The S3 exit Plan: b depends on a, and Segno adds the Docs task.
const plan = `schemaVersion: 1
title: Search notes
summary: Find saved notes.
phases:
  - id: index
    title: Search index
    tasks:
      - id: a
        title: Index notes
        description: Build the index.
        acceptance: [Notes are indexed]
      - id: b
        title: Query notes
        description: Query the index.
        acceptance: [Notes are found]
        dependsOn: [a]
`;

const config = {
  schemaVersion: 1,
  baseBranch: "main",
  tests: { command: "true" },
  roles: {
    coder: { adapter: "claude-code", model: "sonnet" },
    reviewer: { adapter: "claude-code", model: "opus" },
  },
};

/** Adds a configured repo, then submits and approves the Plan. */
async function approvedPlan() {
  const launched = await launch();
  const { app, page } = launched;
  const repo = repoWithRemote({
    "segno.config.json": `${JSON.stringify(config)}\n`,
  });
  await stubDialog(app, "showOpenDialog", {
    canceled: false,
    filePaths: [repo],
  });
  await page.getByRole("button", { name: "Add project" }).click();
  await page.getByRole("button", { name: "Choose folder…" }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const file = join(tempDir(), "search.yaml");
  writeFileSync(file, plan);
  await stubDialog(app, "showOpenDialog", {
    canceled: false,
    filePaths: [file],
  });
  await page.getByRole("button", { name: "Submit Plan file…" }).click();
  await page.getByRole("button", { name: "Review plan" }).first().click();
  await page.getByRole("button", { name: "Approve" }).click();
  return launched;
}

test("the Plan's cards move through the board to Done", async () => {
  const { page } = await approvedPlan();
  const board = page.getByRole("region", { name: "Board" });
  await board.getByText("segno/search-notes/index").waitFor();
  const done = board.getByRole("list", { name: "Done" });
  for (const id of ["a", "b", "index-docs"])
    await done
      .getByRole("button", { name: new RegExp(`^${id} `) })
      .waitFor({ timeout: 45_000 });
  await board.getByText("Sessions 0/1 · 6 this phase").waitFor();
});

test("the drawer's Transcript tab streams a live Run", async () => {
  const { page } = await approvedPlan();
  const coding = page.getByRole("list", { name: "Coding" });
  await coding.getByRole("button", { name: /^a / }).click();

  const drawer = page.getByRole("complementary", { name: "Task a" });
  await drawer.getByRole("tab", { name: "Transcript" }).click();
  const panel = drawer.getByRole("tabpanel", { name: "Transcript" });
  // The Coder's output arrives while its Run is live, then the Run completes.
  await panel.getByText("live", { exact: true }).first().waitFor();
  await panel.getByText("Writing a.txt").first().waitFor();
  await panel.getByText("completed", { exact: true }).first().waitFor();
});
