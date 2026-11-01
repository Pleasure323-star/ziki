import { describe, expect, it } from "vitest";
import { missingAwardEntry } from "@/lib/points/disputes";

// #599: a "missing reporter" dispute grant must pay the beneficiary and key
// idempotency on the same canonical sourceKey the platform award uses
// (lib/agent-api/award path), so granting can never land on a second key and
// double-pay an issue whose beneficiary and reporter differ.
// This file sits in the new tests home, since the old lib/points regression
// files were relocated upstream.

const bug = {
  id: "bug-1",
  number: 1,
  tenantId: "tenant-zedu",
  reporterId: "user-me",
  assigneeId: "user-solver",
  projectId: null as string | null,
};

describe("missingAwardEntry sourceKey parity (#599)", () => {
  it("builds the canonical solver award worth 750", () => {
    expect(missingAwardEntry(bug, "solver")).toMatchObject({
      userId: "user-solver",
      role: "solver",
      points: 750,
      sourceKey: "solver:bug-1:user-solver",
    });
  });

  it("builds the canonical reporter award worth 150 to the reporter by default", () => {
    expect(missingAwardEntry(bug, "reporter")).toMatchObject({
      userId: "user-me",
      role: "reporter",
      points: 150,
      sourceKey: "reporter:bug-1:user-me",
    });
  });

  it("pays the beneficiary and keys idempotency on them like the canonical award (#599)", () => {
    const entry = missingAwardEntry(
      { ...bug, reporterId: "other-user", beneficiaryUserId: "user-me" },
      "reporter",
    );
    expect(entry).toMatchObject({
      userId: "user-me",
      sourceKey: "reporter:bug-1:user-me",
    });
  });

  it("falls back to the reporter when no beneficiary is set (#599)", () => {
    const entry = missingAwardEntry({ ...bug, beneficiaryUserId: null }, "reporter");
    expect(entry).toMatchObject({
      userId: "user-me",
      sourceKey: "reporter:bug-1:user-me",
    });
  });

  it("returns null for a solver award when nobody is assigned", () => {
    expect(missingAwardEntry({ ...bug, assigneeId: null }, "solver")).toBeNull();
  });
});
