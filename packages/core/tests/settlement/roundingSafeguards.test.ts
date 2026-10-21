import {
  computeTargetPayoutAmount,
  validateCrossCurrencyPayoutRounding,
  PayoutRoundingItem,
} from "../../src/settlement/roundingSafeguards";

describe("Cross-Currency Payout Rounding Safeguards (#694)", () => {
  describe("computeTargetPayoutAmount", () => {
    it("accurately converts currency with matching decimals", () => {
      // 100.0000000 USDC (7 dec) at rate 1.5 -> 150.0000000 target units (7 dec)
      const res = computeTargetPayoutAmount("1000000000", 7, 7, 1.5, "round");
      expect(res.targetAmount).toBe("1500000000");
      expect(res.precisionLoss).toBe(false);
    });

    it("handles decimal scale adjustment (6 decimals to 7 decimals)", () => {
      // 100.000000 (6 dec) -> 100.0000000 (7 dec) at rate 1.0
      const res = computeTargetPayoutAmount("100000000", 6, 7, 1.0, "round");
      expect(res.targetAmount).toBe("1000000000");
      expect(res.precisionLoss).toBe(false);
    });

    it("correctly rounds with precision loss flag when fraction exists", () => {
      // 10.0000000 units at rate 0.3333333333333333
      const res = computeTargetPayoutAmount("10000000", 7, 7, 0.33333333, "floor");
      expect(res.targetAmount).toBe("3333333");
      expect(res.precisionLoss).toBe(true);
    });

    it("throws on invalid source amount, rate, or decimals", () => {
      expect(() => computeTargetPayoutAmount("-100", 7, 7, 1.0)).toThrow("Invalid source amount");
      expect(() => computeTargetPayoutAmount("100", 7, 7, 0)).toThrow("Invalid exchange rate");
      expect(() => computeTargetPayoutAmount("100", -1, 7, 1.0)).toThrow("Invalid source decimals");
      expect(() => computeTargetPayoutAmount("100", 7, 25, 1.0)).toThrow("Invalid target decimals");
    });
  });

  describe("validateCrossCurrencyPayoutRounding", () => {
    it("passes for a valid batch with expected amounts within drift tolerance", () => {
      const items: PayoutRoundingItem[] = [
        {
          id: "item-1",
          recipientId: "GAAA1",
          sourceAmount: "1000000000", // 100 USDC (7 decimals)
          sourceDecimals: 7,
          targetDecimals: 7,
          exchangeRate: 1.25,
          expectedTargetAmount: "1250000000",
        },
        {
          id: "item-2",
          recipientId: "GAAA2",
          sourceAmount: "2000000000",
          sourceDecimals: 7,
          targetDecimals: 7,
          exchangeRate: 1.25,
          expectedTargetAmount: "2500000000",
        },
      ];

      const report = validateCrossCurrencyPayoutRounding(items, { maxItemDriftBps: 5 });
      expect(report.valid).toBe(true);
      expect(report.totalItems).toBe(2);
      expect(report.passedItems).toBe(2);
      expect(report.failedItems).toBe(0);
      expect(report.cumulativeDriftBps).toBe(0);
      expect(report.errors).toHaveLength(0);
    });

    it("fails when an item exceeds maximum allowable drift", () => {
      const items: PayoutRoundingItem[] = [
        {
          id: "item-drift",
          sourceAmount: "1000000000",
          sourceDecimals: 7,
          targetDecimals: 7,
          exchangeRate: 1.0,
          expectedTargetAmount: "1020000000", // ~200 bps discrepancy
        },
      ];

      const report = validateCrossCurrencyPayoutRounding(items, { maxItemDriftBps: 5 });
      expect(report.valid).toBe(false);
      expect(report.failedItems).toBe(1);
      expect(report.errors[0].code).toBe("EXCESSIVE_DRIFT");
    });

    it("catches invalid amounts and negative rates", () => {
      const items: PayoutRoundingItem[] = [
        {
          id: "bad-amount",
          sourceAmount: "-500",
          sourceDecimals: 7,
          targetDecimals: 7,
          exchangeRate: 1.0,
        },
        {
          id: "bad-rate",
          sourceAmount: "500",
          sourceDecimals: 7,
          targetDecimals: 7,
          exchangeRate: -1.0,
        },
      ];

      const report = validateCrossCurrencyPayoutRounding(items);
      expect(report.valid).toBe(false);
      expect(report.errors.some((e) => e.code === "INVALID_AMOUNT")).toBe(true);
      expect(report.errors.some((e) => e.code === "INVALID_EXCHANGE_RATE")).toBe(true);
    });

    it("edge case: handles empty items array cleanly", () => {
      const report = validateCrossCurrencyPayoutRounding([]);
      expect(report.valid).toBe(true);
      expect(report.totalItems).toBe(0);
      expect(report.cumulativeDriftBps).toBe(0);
    });
  });

  describe("computeTargetPayoutAmount precision beyond Number.MAX_SAFE_INTEGER (#767)", () => {
    it("never silently flips an odd bigint source amount to an even one via a float round-trip", () => {
      // Number(9007199254740993n) === 9007199254740992 (an off-by-one, even
      // number) — this is the exact bug this fix guards against. At rate
      // 1.0 with matching decimals, the target amount must equal the
      // source amount exactly, preserving its odd value.
      const source = 9007199254740993n;
      const res = computeTargetPayoutAmount(source, 7, 7, 1.0, "round");
      expect(res.targetAmount).toBe(source.toString());
      expect(res.precisionLoss).toBe(false);
    });

    it("computes an exact result for a large aggregate payroll amount with a non-trivial rate", () => {
      // A realistic large aggregate: ~901M whole units at 7 decimals,
      // comfortably past Number.MAX_SAFE_INTEGER, converted at a
      // non-round exchange rate. Verified against exact bigint math
      // computed independently of the function under test.
      const source = 9007199254740993n; // 7 decimals -> ~900.72M whole units
      const sourceDecimals = 7;
      const targetDecimals = 7;
      const rate = "1.0734";

      const res = computeTargetPayoutAmount(source, sourceDecimals, targetDecimals, rate, "floor");

      // Independent exact computation: source * 10734 / 10000, floored.
      const expected = (source * 10734n) / 10000n;
      expect(res.targetAmount).toBe(expected.toString());
    });

    it("still correctly flags genuine precision loss from the rounding mode itself, not the parsing", () => {
      const res = computeTargetPayoutAmount("10000000", 7, 7, 0.33333333, "floor");
      expect(res.targetAmount).toBe("3333333");
      expect(res.precisionLoss).toBe(true);
    });

    it("produces identical results whether the source amount is passed as a bigint or an equal-value string", () => {
      const asBigint = computeTargetPayoutAmount(9007199254740993n, 7, 7, "1.0734", "round");
      const asString = computeTargetPayoutAmount("9007199254740993", 7, 7, "1.0734", "round");
      expect(asBigint.targetAmount).toBe(asString.targetAmount);
    });

    it("aggregates totalSourceAmount and totalComputedTargetAmount exactly for a batch containing an amount beyond Number.MAX_SAFE_INTEGER", () => {
      const items: PayoutRoundingItem[] = [
        {
          id: "large-item",
          sourceAmount: "9007199254740993",
          sourceDecimals: 7,
          targetDecimals: 7,
          exchangeRate: 1.0,
        },
        {
          id: "small-item",
          sourceAmount: "1000000000",
          sourceDecimals: 7,
          targetDecimals: 7,
          exchangeRate: 1.0,
        },
      ];

      const report = validateCrossCurrencyPayoutRounding(items, { maxItemDriftBps: 5 });

      expect(report.totalSourceAmount).toBe("9007200254740993");
      expect(report.totalComputedTargetAmount).toBe("9007200254740993");
    });
  });
});
