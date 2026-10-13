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
  await page.getByText("Detected settings").waitFor();
  expect(await page.getByLabel("Package manager").inputValue()).toBe("pnpm");
  expect(await page.getByLabel("Test command").inputValue()).toBe("pnpm test");
  expect(await page.getByLabel("Setup command").inputValue()).toBe(
    "pnpm install --frozen-lockfile",
  );
  expect(await page.getByLabel("Base branch").inputValue()).toBe("main");
  expect(await page.getByLabel("coder-docs model").inputValue()).toBe("haiku");
  expect(await page.getByLabel("Coder allow").inputValue()).toBe(
    "Bash(pnpm *)",
  );
  await page.getByLabel("Reviewer model").fill("sonnet");
  await page.getByRole("button", { name: "Add", exact: true }).click();

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
