import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { git, launch, repoWithRemote, stubDialog } from "./app.js";

// S9: onboarding with the fake Adapter, which proposes `npm test` when the
// repo has a test script and the no-checks placeholder otherwise [ADR-0049].

/** Adds a repo without a config, with the default models. */
async function notOnboarded(files: Record<string, string>) {
  const launched = await launch();
  const { app, page } = launched;
  const repo = repoWithRemote(files);
  await stubDialog(app, "showOpenDialog", {
    canceled: false,
    filePaths: [repo],
  });
  await page.getByRole("button", { name: "Add project" }).click();
  await page.getByRole("button", { name: "Choose folder…" }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("heading", { name: "Not onboarded" }).waitFor();
  return { ...launched, repo };
}

test("Onboard project streams the Run, shows the review with its evidence, and Confirm makes the Project running", async () => {
  const { page, repo } = await notOnboarded({
    "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
    "package-lock.json": "{}",
  });
  await page.getByRole("button", { name: "Onboard project" }).click();

  const live = page.getByRole("region", { name: "Onboarding" });
  await live.getByText("Looking for the repo's checks.").waitFor();
  await live.getByRole("button", { name: "Stop onboarding" }).waitFor();

  const review = page.getByRole("region", { name: "Onboarding proposal" });
  await review.waitFor({ timeout: 15_000 });
  await review.getByText("origin/main").waitFor();
  const values = review.getByRole("table", { name: "Proposed values" });
  await values
    .getByRole("row", {
      name: /Test command npm test package\.json defines a test script\./,
    })
    .waitFor();
  await values
    .getByRole("row", { name: /Coder allow Bash\(npm \*\)/ })
    .waitFor();
  const commands = review.getByRole("table", { name: "Commands run" });
  await commands.getByRole("row", { name: "npm test tests 0 2 s" }).waitFor();
  expect(await review.getByText("No checks found").count()).toBe(0);

  const awaiting = page.getByRole("complementary", { name: "Awaiting you" });
  await awaiting.getByText("onboarding-review").waitFor();
  await awaiting.getByRole("button", { name: "Review proposal" }).click();

  await review.getByRole("button", { name: "Confirm" }).click();
  await page.getByRole("heading", { name: "No active plan" }).waitFor();
  await page.getByText("segno.config.json isn't on origin/main yet").waitFor();
  expect(await awaiting.getByText("Nothing needs you.").count()).toBe(1);
  const written = JSON.parse(
    readFileSync(join(repo, "segno.config.json"), "utf8"),
  );
  expect(written.tests).toEqual({ command: "npm test", timeoutMin: 5 });
  expect(written.roles.coder.allow).toEqual(["Bash(npm *)"]);
  expect(git(repo, "status", "--porcelain")).toBe("?? segno.config.json");
});

test("a no-checks proposal is confirmed only after the developer acknowledges it", async () => {
  const { page, repo } = await notOnboarded({});
  await page.getByRole("button", { name: "Onboard project" }).click();
  const review = page.getByRole("region", { name: "Onboarding proposal" });
  await review.waitFor({ timeout: 15_000 });
  await review.getByText("No checks found").waitFor();
  await review.getByRole("cell", { name: "No commands were run." }).waitFor();

  const confirm = review.getByRole("button", { name: "Confirm" });
  expect(await confirm.isDisabled()).toBe(true);
  await review
    .getByRole("checkbox", { name: "Every Task will pass tests unchecked" })
    .check();
  await confirm.click();
  await page.getByRole("heading", { name: "No active plan" }).waitFor();
  expect(
    JSON.parse(readFileSync(join(repo, "segno.config.json"), "utf8")).tests,
  ).toEqual({ command: "true", timeoutMin: 5 });
});

test("Stop onboarding returns to the call to action, and Edit prefills the manual form with the proposal", async () => {
  const { page, repo } = await notOnboarded({
    "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
  });
  await page.getByRole("button", { name: "Onboard project" }).click();
  await page.getByRole("button", { name: "Stop onboarding" }).click();
  await page.getByRole("heading", { name: "Not onboarded" }).waitFor();

  await page.getByRole("button", { name: "Onboard project" }).click();
  const review = page.getByRole("region", { name: "Onboarding proposal" });
  await review.waitFor({ timeout: 15_000 });
  await review.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Test command").waitFor();
  expect(await page.getByLabel("Test command").inputValue()).toBe("npm test");
  expect(await page.getByLabel("Coder allow").inputValue()).toBe("Bash(npm *)");
  await page.getByLabel("Test command").fill("npm run check");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("heading", { name: "No active plan" }).waitFor();
  expect(
    JSON.parse(readFileSync(join(repo, "segno.config.json"), "utf8")).tests,
  ).toEqual({ command: "npm run check", timeoutMin: 5 });
  expect(existsSync(join(repo, "segno.config.json"))).toBe(true);
});
