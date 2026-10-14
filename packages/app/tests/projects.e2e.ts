import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, test } from "vitest";
import { git, launch, repoWithRemote, stubDialog, tempDir } from "./app.js";

test("adding a repo without a config writes the reviewed settings uncommitted and shows the commit hint", async () => {
  const { app, page } = await launch();
  const repo = repoWithRemote({
    "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  });
  await stubDialog(app, "showOpenDialog", {
    canceled: false,
    filePaths: [repo],
  });
  await page.getByRole("button", { name: "Add project" }).click();
  await page.getByRole("button", { name: "Choose folder…" }).click();
  await page.getByLabel("Planner model").waitFor();
  expect(await page.getByLabel("Planner model").inputValue()).toBe("opus");
  expect(
    await page.getByLabel("Coder model", { exact: true }).inputValue(),
  ).toBe("sonnet");
  expect(await page.getByLabel("Reviewer model").inputValue()).toBe("opus");
  expect(await page.locator("main input").count()).toBe(3);
  expect(await page.getByLabel("Test command").count()).toBe(0);
  const add = page.getByRole("button", { name: "Add", exact: true });
  for (const required of ["Planner model", "Coder model", "Reviewer model"]) {
    const field = page.getByLabel(required, { exact: true });
    const value = await field.inputValue();
    await field.fill(" ");
    expect(await add.isDisabled()).toBe(true);
    await field.fill(value);
  }
  await page.getByLabel("Reviewer model").fill("sonnet");
  await add.click();
  await page.getByRole("heading", { name: "Not onboarded" }).waitFor();
  expect(
    await page
      .getByRole("button", { name: "Onboard project", exact: true })
      .count(),
  ).toBe(0);
  expect(
    await page.getByRole("button", { name: "Submit Plan file…" }).count(),
  ).toBe(0);
  expect(existsSync(join(repo, "segno.config.json"))).toBe(false);
  expect(git(repo, "status", "--porcelain")).toBe("");
  await page.getByRole("button", { name: "Set up manually" }).click();
  await page.getByLabel("Test command").waitFor();
  expect(await page.getByLabel("Package manager").inputValue()).toBe("pnpm");
  expect(await page.getByLabel("Test command").inputValue()).toBe("pnpm test");
  expect(await page.getByLabel("Setup command").inputValue()).toBe(
    "pnpm install --frozen-lockfile",
  );
  expect(await page.getByLabel("Base branch").inputValue()).toBe("main");
  expect(await page.getByLabel("Coder allow").inputValue()).toBe(
    "Bash(pnpm *)",
  );
  const save = page.getByRole("button", { name: "Save", exact: true });
  await page.getByLabel("Test command").fill("");
  expect(await save.isDisabled()).toBe(true);
  await page.getByLabel("Test command").fill("pnpm test");
  await save.click();

  await page
    .getByRole("navigation", { name: "Projects" })
    .getByRole("button", { name: basename(repo) })
    .waitFor();
  await page.getByText("segno.config.json isn't on origin/main yet").waitFor();
  const written = JSON.parse(
    readFileSync(join(repo, "segno.config.json"), "utf8"),
  );
  expect(written.roles.reviewer.model).toBe("sonnet");
  expect(git(repo, "status", "--porcelain")).toBe("?? segno.config.json");
});

test("a folder that isn't a git repo is refused with not-a-repo", async () => {
  const { app, page } = await launch();
  const folder = tempDir();
  await stubDialog(app, "showOpenDialog", {
    canceled: false,
    filePaths: [folder],
  });
  await page.getByRole("button", { name: "Add project" }).click();
  await page.getByRole("button", { name: "Choose folder…" }).click();
  await page.getByText("not-a-repo").waitFor();
  expect(existsSync(join(folder, "segno.config.json"))).toBe(false);
});

test("a repo with no test command can be added and manual validation stays on the form", async () => {
  const { app, page } = await launch();
  const repo = repoWithRemote();
  await stubDialog(app, "showOpenDialog", {
    canceled: false,
    filePaths: [repo],
  });
  await page.getByRole("button", { name: "Add project" }).click();
  await page.getByRole("button", { name: "Choose folder…" }).click();
  await page.getByLabel("Planner model").waitFor();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Set up manually" }).click();
  const command = page.getByLabel("Test command");
  await command.waitFor();
  expect(await command.inputValue()).toBe("");
  const save = page.getByRole("button", { name: "Save", exact: true });
  expect(await save.isDisabled()).toBe(true);
  await command.fill("node --test");
  await page.getByLabel("Base branch").fill("missing-branch");
  await save.click();
  await page
    .getByRole("alert")
    .getByText("unknown-branch", { exact: false })
    .waitFor();
  expect(existsSync(join(repo, "segno.config.json"))).toBe(false);
  await page.getByLabel("Base branch").fill("main");
  await save.click();
  await page.getByRole("button", { name: "Submit Plan file…" }).waitFor();
});
