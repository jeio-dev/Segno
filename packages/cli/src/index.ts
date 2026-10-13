import { readFileSync } from "node:fs";
import { parsePlan } from "@segno/plan-format";

const [command, subcommand, file, ...extra] = process.argv.slice(2);

if (
  command !== "plan" ||
  subcommand !== "validate" ||
  !file ||
  !/\.ya?ml$/.test(file) ||
  extra.length
) {
  process.stderr.write(
    "Invalid arguments.\nUsage: segno plan validate <file>\n",
  );
  process.exitCode = 2;
} else {
  let source: string | undefined;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      readFileSync(file),
    );
  } catch (error) {
    process.stderr.write(
      `Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
  if (source !== undefined) {
    const result = parsePlan(source);
    if (!result.valid) {
      process.exitCode = 2;
      for (const error of result.errors) {
        process.stderr.write(
          `${file}:${error.line ?? "?"}:${error.column ?? "?"}  ${error.code}  ${error.message.replace(/[\r\n]+/g, " ")}\n`,
        );
      }
    }
  }
}
