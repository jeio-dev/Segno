import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test } from "vitest";
import {
  examples,
  type Launched,
  launch,
  repoWithRemote,
  stubDialog,
  tempDir,
} from "./app.js";

const validConfig = {
  schemaVersion: 1,
  baseBranch: "main",
  tests: { command: "pnpm test" },
  roles: {
    coder: { adapter: "claude-code", model: "sonnet" },
    reviewer: { adapter: "claude-code", model: "opus" },
  },
};

/** Adds a repo with a committed config through the add-project flow. */
async function addProject({ app, page }: Launched) {
  const repo = repoWithRemote({
    "segno.config.json": `${JSON.stringify(validConfig)}\n`,
  });
  await stubDialog(app, "showOpenDialog", {
    canceled: false,
    filePaths: [repo],
  });
  await page.getByRole("button", { name: "Add project" }).click();
  await page.getByRole("button", { name: "Choose folder…" }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("heading", { name: "No active plan" }).waitFor();
  return repo;
}

test("submitting two-phase.yaml asks for approval, and approving makes the Plan active", async () => {
  const launched = await launch();
  const { app, page } = launched;
  const repo = await addProject(launched);
  await stubDialog(app, "showOpenDialog", {
    canceled: false,
    filePaths: [join(examples, "two-phase.yaml")],
  });
  await page.getByRole("button", { name: "Submit Plan file…" }).click();

  const panel = page.getByRole("complementary", { name: "Awaiting you" });
  await panel.getByText("plan-approval").waitFor();
  await panel.getByText("Search saved notes").waitFor();
  expect(await panel.getByLabel("Awaiting count").textContent()).toBe("1");
  await page
    .getByRole("navigation", { name: "Projects" })
    .getByRole("button", { name: `${basename(repo)} 1 awaiting you` })
    .waitFor();

  await panel.getByRole("button", { name: "Review plan" }).click();
  const review = page.getByRole("dialog", {
    name: "Review plan Search saved notes",
  });
  for (const text of [
    "index-notes",
    "query-notes",
    "show-results",
    "high risk: migration",
    "Saved notes are searchable by title and content",
  ])
    await review.getByText(text, { exact: true }).first().waitFor();
  await review.getByRole("button", { name: "Approve" }).click();

  await page.getByRole("heading", { name: "Search saved notes" }).waitFor();
  await page.getByText("active", { exact: true }).waitFor();
  await panel.getByText("Nothing needs you.").waitFor();
});

test("an invalid Plan file lists every error as line:column  code  message", async () => {
  const launched = await launch();
  const { app, page } = launched;
  await addProject(launched);
  await stubDialog(app, "showOpenDialog", {
    canceled: false,
    filePaths: [join(examples, "invalid-dependency-cycle.yaml")],
  });
  await page.getByRole("button", { name: "Submit Plan file…" }).click();
  const alert = page.getByRole("alert");
  await alert.getByText("The Plan file is invalid.").waitFor();
  expect(await alert.locator("li").first().textContent()).toMatch(
    /^\d+:\d+ {2}dependency-cycle {2}/,
  );
});

test("Export Plan saves the active Plan's YAML through a save dialog", async () => {
  const launched = await launch();
  const { app, page } = launched;
  await addProject(launched);
  await stubDialog(app, "showOpenDialog", {
    canceled: false,
    filePaths: [join(examples, "two-phase.yaml")],
  });
  await page.getByRole("button", { name: "Submit Plan file…" }).click();
  await page.getByRole("button", { name: "Review plan" }).first().click();
  await page.getByRole("button", { name: "Approve" }).click();
  const target = join(tempDir(), "exported.yaml");
  await stubDialog(app, "showSaveDialog", {
    canceled: false,
    filePath: target,
  });
  await page.getByRole("button", { name: "Export Plan…" }).click();
  await expect
    .poll(() => {
      try {
        return readFileSync(target, "utf8");
      } catch {
        return "";
      }
    })
    .toContain("generated: true");
});
