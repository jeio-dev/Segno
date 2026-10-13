import { validationCodes } from "@segno/plan-format";
import { expect, test } from "vitest";
import { validationErrorSchema } from "../src/index.js";

test("validation errors accept exactly the Plan format's validation codes", () => {
  expect(validationErrorSchema.shape.code.options).toEqual(validationCodes);
});
