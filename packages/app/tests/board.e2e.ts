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
async function approvedPlan(planYaml = plan, projectConfig = config) {
  const launched = await launch();
  const { app, page } = launched;
  const repo = repoWithRemote({
    "segno.config.json": `${JSON.stringify(projectConfig)}\n`,
  });
  await stubDialog(app, "showOpenDialog", {
    canceled: false,
    filePaths: [repo],
  });
  await page.getByRole("button", { name: "Add project" }).click();
  await page.getByRole("button", { name: "Choose folder…" }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const file = join(tempDir(), "search.yaml");
  writeFileSync(file, planYaml);
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
  // The fake Adapter reports usage, so the board shows it.
  await board.getByText(/^Usage 37\/100 · resets \d\d:\d\d/).waitFor();
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

test("a held Task is approved from Awaiting you and reaches Done", async () => {
  const { page } = await approvedPlan(
    plan.replace(
      "        acceptance: [Notes are indexed]",
      "        acceptance: [Notes are indexed]\n        risk: { flags: [security], reason: Sensitive }",
    ),
  );
  const awaiting = page.getByRole("complementary", { name: "Awaiting you" });
  await awaiting
    .getByText("merge-hold", { exact: true })
    .waitFor({ timeout: 45_000 });
  await awaiting.getByRole("button", { name: "Approve", exact: true }).click();
  await page
    .getByRole("list", { name: "Done" })
    .getByRole("button", { name: /^a / })
    .waitFor({ timeout: 45_000 });
});

test("a Blocked card shows its Block reason, budgets and dependent wait reason", async () => {
  const { page } = await approvedPlan(plan, {
    ...config,
    tests: { command: "echo broken; exit 1" },
  });
  const card = page
    .getByRole("list", { name: "Blocked" })
    .getByRole("button", { name: /^a / });
  await card.waitFor({ timeout: 45_000 });
  await card.getByText("test-limit", { exact: true }).waitFor();
  await card.getByText("T 2/2", { exact: true }).waitFor();
  await page
    .getByRole("list", { name: "Queued" })
    .getByText("waiting on blocked a", { exact: true })
    .first()
    .waitFor();
});

test("the Review tab shows the Verdict and Send back sends a blocking developer Finding", async () => {
  const { page } = await approvedPlan(
    plan.replace(
      "        acceptance: [Notes are indexed]",
      "        acceptance: [Notes are indexed]\n        risk: { flags: [security], reason: Sensitive }",
    ),
  );
  const card = page
    .getByRole("list", { name: "Merge" })
    .getByRole("button", { name: /^a / });
  await card.waitFor({ timeout: 45_000 });
  await card.getByText("High risk: security").waitFor();
  await card.click();
  const drawer = page.getByRole("complementary", { name: "Task a" });
  await drawer.getByRole("tab", { name: "Review", exact: true }).click();
  await drawer.getByText("Meets every acceptance criterion.").waitFor();
  await drawer.getByText("Met: Notes are indexed").waitFor();
  await drawer.getByRole("button", { name: "Send back", exact: true }).click();
  await drawer.getByLabel("Send back notes").fill("Protect private notes");
  await drawer.getByRole("button", { name: "Send notes", exact: true }).click();
  await drawer.getByText("Protect private notes", { exact: true }).waitFor();
  await drawer.getByText("developer · blocking", { exact: true }).waitFor();
});
