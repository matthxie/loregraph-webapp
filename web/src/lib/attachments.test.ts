import { describe, expect, it } from "vitest";
import { missingAttachmentIdsFromSync } from "./attachments";

describe("attachment sync reconciliation", () => {
  it("does not remove a file added after an older sync request started", () => {
    const missing = missingAttachmentIdsFromSync(
      ["already-requested", "newly-added"],
      new Set(["already-requested"]),
      new Set(),
    );

    expect(missing).toEqual(["already-requested"]);
  });

  it("removes a requested attachment the main process could not retain", () => {
    const missing = missingAttachmentIdsFromSync(
      ["kept", "missing"],
      new Set(["kept", "missing"]),
      new Set(["kept"]),
    );

    expect(missing).toEqual(["missing"]);
  });
});
