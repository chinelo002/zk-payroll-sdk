/**
 * Tests for BatchPayloadBuilder (#768)
 *
 * Covers:
 *  - add/addMany/build preserve the exact order entries were committed in
 *  - validate() reports errors by original index, not a reordered one
 *  - Boundary: a single entry, and a batch where entries are added one at a
 *    time via add() in a specific sequence
 *
 * This repo already builds entries without any sort/grouping step
 * (confirmed by reading BatchPayloadBuilder.ts, chunking.ts, and
 * findRemovedEmployeesInPayoutBatch in full) — these tests exist to prove
 * and lock in that order preservation, since no test file previously
 * existed for this builder at all.
 */

import { BatchPayloadBuilder, BatchPaymentEntry } from "../../src/batch/BatchPayloadBuilder";

const ENTRY_C = {
  recipient: "GRECIPIENTC00000000000000000000000000000000000000000",
  amount: 300n,
  asset: "native",
};
const ENTRY_A = {
  recipient: "GRECIPIENTA00000000000000000000000000000000000000000",
  amount: 100n,
  asset: "native",
};
const ENTRY_B = {
  recipient: "GRECIPIENTB00000000000000000000000000000000000000000",
  amount: 200n,
  asset: "native",
};

describe("BatchPayloadBuilder recipient order preservation (#768)", () => {
  it("build() returns entries in the exact order they were committed via add(), not sorted by recipient", () => {
    // Deliberately added out of alphabetical/recipient order: C, then A,
    // then B. A naive implementation that sorted by recipient for
    // determinism (as computeEntriesCommitment intentionally does for its
    // own hash, a different concern) would silently reorder this to A, B, C.
    const payload = new BatchPayloadBuilder().add(ENTRY_C).add(ENTRY_A).add(ENTRY_B).build();

    expect(payload.entries.map((e) => e.recipient)).toEqual([
      ENTRY_C.recipient,
      ENTRY_A.recipient,
      ENTRY_B.recipient,
    ]);
  });

  it("addMany() preserves the input array's order exactly", () => {
    const committed: BatchPaymentEntry[] = [ENTRY_B, ENTRY_C, ENTRY_A];
    const payload = new BatchPayloadBuilder().addMany(committed).build();

    expect(payload.entries.map((e) => e.recipient)).toEqual(committed.map((e) => e.recipient));
  });

  it("mixing add() and addMany() preserves the combined commit order", () => {
    const payload = new BatchPayloadBuilder().add(ENTRY_B).addMany([ENTRY_C, ENTRY_A]).build();

    expect(payload.entries.map((e) => e.recipient)).toEqual([
      ENTRY_B.recipient,
      ENTRY_C.recipient,
      ENTRY_A.recipient,
    ]);
  });

  it("build() returns deep copies, not the same object references, without altering order", () => {
    const committed: BatchPaymentEntry[] = [ENTRY_A, ENTRY_B];
    const builder = new BatchPayloadBuilder().addMany(committed);
    const payload = builder.build();

    expect(payload.entries).not.toBe(committed);
    expect(payload.entries[0]).not.toBe(committed[0]);
    expect(payload.entries.map((e) => e.recipient)).toEqual(committed.map((e) => e.recipient));
  });

  it("validate() reports an invalid entry's index against the original commit order, not a reordered one", () => {
    const committed: BatchPaymentEntry[] = [
      ENTRY_C,
      { recipient: "", amount: 50n, asset: "native" }, // invalid, at index 1
      ENTRY_A,
    ];

    const errors = new BatchPayloadBuilder().addMany(committed).validate();

    const invalidRecipientError = errors.find((e) => e.code === "INVALID_RECIPIENT");
    expect(invalidRecipientError?.index).toBe(1);
  });

  it("duplicate-recipient detection reports indices against the original commit order", () => {
    const duplicate = { ...ENTRY_A };
    const committed: BatchPaymentEntry[] = [ENTRY_C, ENTRY_A, ENTRY_B, duplicate];

    const errors = new BatchPayloadBuilder().addMany(committed).validate();

    const duplicateError = errors.find((e) => e.code === "DUPLICATE_RECIPIENT");
    expect(duplicateError?.index).toBe(3);
    expect(duplicateError?.message).toContain("indices 1 and 3");
  });

  it("boundary: a single-entry batch builds with that one entry, unchanged", () => {
    const payload = new BatchPayloadBuilder().add(ENTRY_A).build();
    expect(payload.entries).toHaveLength(1);
    expect(payload.entries[0]?.recipient).toBe(ENTRY_A.recipient);
  });

  it("totalAmount sums entries regardless of commit order (order-independent by design, unlike recipient order)", () => {
    const inOrder = new BatchPayloadBuilder().addMany([ENTRY_A, ENTRY_B, ENTRY_C]).build();
    const reversed = new BatchPayloadBuilder().addMany([ENTRY_C, ENTRY_B, ENTRY_A]).build();

    expect(inOrder.totalAmount).toBe(reversed.totalAmount);
    expect(inOrder.entries.map((e) => e.recipient)).not.toEqual(
      reversed.entries.map((e) => e.recipient)
    );
  });
});
