import { describe, expect, test } from "bun:test";
import { parseReadReceipts } from "./read-receipts";

describe("parseReadReceipts", () => {
  test("off when unset or blank", () => {
    expect(parseReadReceipts(undefined)).toBe(false);
    expect(parseReadReceipts("")).toBe(false);
    expect(parseReadReceipts("  ")).toBe(false);
  });

  test("on for 1, true, on and yes, in any case, around whitespace", () => {
    for (const v of ["1", "true", "TRUE", " on ", "Yes"])
      expect(parseReadReceipts(v)).toBe(true);
  });

  test("off for 0, false and anything unrecognised", () => {
    for (const v of ["0", "false", "off", "no", "2", "enabled"])
      expect(parseReadReceipts(v)).toBe(false);
  });
});
