/**
 * Cross-currency payout rounding safeguards for ZK Payroll.
 *
 * Provides precision checks, drift monitoring, and batch-level rounding safeguards
 * to prevent underfunding and unexpected precision loss across currency conversions.
 */

export type SettlementRoundingMode = "floor" | "ceil" | "round" | "truncate";

/**
 * Parses a decimal amount (string, bigint, or number) into an exact
 * `value * 10^-scale` fixed-point pair, where `value` is a bigint and
 * `scale` is the number of fractional digits actually present (#767).
 *
 * `Number(sourceAmount)` for a bigint source amount silently loses
 * precision beyond `Number.MAX_SAFE_INTEGER` (2^53 - 1): for example
 * `Number(9007199254740993n) === 9007199254740992`, an off-by-one that
 * `computeTargetPayoutAmount`'s own `precisionLoss` flag never catches,
 * since that flag only compares the float-computed result against its own
 * rounded value, after the float conversion has already lost precision. A
 * payroll amount denominated in 7-decimal Stellar base units crosses this
 * threshold above roughly 900 million whole-token units — a realistic
 * aggregate batch total, not an edge case. This parser keeps the amount as
 * an exact bigint through the whole conversion instead.
 */
function parseExactDecimal(value: string | bigint | number): { digits: bigint; scale: number } {
  if (typeof value === "bigint") {
    return { digits: value, scale: 0 };
  }

  const text = typeof value === "number" ? value.toString() : value.trim();
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;

  // Normalize exponential notation (e.g. "1.5e3") by expanding it, since the
  // fractional-digit count below assumes plain decimal notation.
  const expMatch = /^(\d+)(?:\.(\d+))?e([+-]?\d+)$/i.exec(unsigned);
  if (expMatch) {
    const [, intPart, fracPart = "", expPart] = expMatch;
    const exponent = Number(expPart);
    const combinedDigits = intPart + fracPart;
    const pointIndex = intPart.length + exponent;
    if (pointIndex >= combinedDigits.length) {
      const padded = combinedDigits.padEnd(pointIndex, "0");
      return { digits: BigInt((negative ? "-" : "") + padded), scale: 0 };
    }
    if (pointIndex <= 0) {
      const padded = "0".repeat(-pointIndex) + combinedDigits;
      return {
        digits: BigInt((negative ? "-" : "") + padded),
        scale: padded.length,
      };
    }
    return {
      digits: BigInt((negative ? "-" : "") + combinedDigits),
      scale: combinedDigits.length - pointIndex,
    };
  }

  const dotIndex = unsigned.indexOf(".");
  if (dotIndex === -1) {
    if (!/^\d+$/.test(unsigned)) {
      throw new Error(`Invalid decimal amount: ${value}`);
    }
    return { digits: BigInt((negative ? "-" : "") + unsigned), scale: 0 };
  }

  const intPart = unsigned.slice(0, dotIndex);
  const fracPart = unsigned.slice(dotIndex + 1);
  if (!/^\d*$/.test(intPart) || !/^\d+$/.test(fracPart)) {
    throw new Error(`Invalid decimal amount: ${value}`);
  }
  const combined = (intPart || "0") + fracPart;
  return { digits: BigInt((negative ? "-" : "") + combined), scale: fracPart.length };
}

export type RoundingSafeguardErrorCode =
  | "INVALID_AMOUNT"
  | "INVALID_DECIMALS"
  | "INVALID_EXCHANGE_RATE"
  | "EXCESSIVE_DRIFT"
  | "CUMULATIVE_DRIFT_EXCEEDED"
  | "MISMATCHED_TARGET_AMOUNT";

export interface PayoutRoundingItem {
  id?: string;
  recipientId?: string;
  sourceAmount: string | bigint | number;
  sourceDecimals: number;
  targetDecimals: number;
  exchangeRate: number | string;
  expectedTargetAmount?: string | bigint | number;
}

export interface RoundingItemValidationResult {
  index: number;
  id?: string;
  recipientId?: string;
  valid: boolean;
  computedTargetAmount: string;
  expectedTargetAmount?: string;
  driftBps: number;
  deltaAmount: string;
  precisionLoss: boolean;
  error?: {
    code: RoundingSafeguardErrorCode;
    message: string;
  };
}

export interface RoundingSafeguardOptions {
  /** Maximum acceptable drift per item in basis points (1 bps = 0.01%). Default: 5 bps */
  maxItemDriftBps?: number;
  /** Maximum cumulative batch drift in basis points. Default: 10 bps */
  maxBatchDriftBps?: number;
  /** Rounding mode to apply when converting to integer stroops/units. Default: 'round' */
  roundingMode?: SettlementRoundingMode;
  /** Allow zero amounts. Default: false */
  allowZero?: boolean;
}

export interface RoundingSafeguardReport {
  valid: boolean;
  totalItems: number;
  passedItems: number;
  failedItems: number;
  totalSourceAmount: string;
  totalComputedTargetAmount: string;
  totalExpectedTargetAmount: string;
  cumulativeDriftBps: number;
  maxObservedDriftBps: number;
  items: RoundingItemValidationResult[];
  errors: Array<{
    index?: number;
    code: RoundingSafeguardErrorCode;
    message: string;
  }>;
}

/**
 * Computes target payout amount with precision tracking and drift measurement.
 */
export function computeTargetPayoutAmount(
  sourceAmount: string | bigint | number,
  sourceDecimals: number,
  targetDecimals: number,
  exchangeRate: number | string,
  roundingMode: SettlementRoundingMode = "round"
): { targetAmount: string; precisionLoss: boolean } {
  // Validate finiteness/sign using Number() only for the check itself; the
  // actual conversion math below never routes the bigint source amount
  // through Number() (#767 — see parseExactDecimal's doc comment for why).
  const sourceFiniteCheck =
    typeof sourceAmount === "bigint" ? Number(sourceAmount) : Number(sourceAmount);
  const rateNum = Number(exchangeRate);

  if (!Number.isFinite(sourceFiniteCheck) || sourceFiniteCheck < 0) {
    throw new Error(`Invalid source amount: ${sourceAmount}`);
  }
  if (!Number.isFinite(rateNum) || rateNum <= 0) {
    throw new Error(`Invalid exchange rate: ${exchangeRate}`);
  }
  if (sourceDecimals < 0 || sourceDecimals > 18 || !Number.isInteger(sourceDecimals)) {
    throw new Error(`Invalid source decimals: ${sourceDecimals}`);
  }
  if (targetDecimals < 0 || targetDecimals > 18 || !Number.isInteger(targetDecimals)) {
    throw new Error(`Invalid target decimals: ${targetDecimals}`);
  }

  // Exact fixed-point conversion:
  //   targetUnits = (sourceDigits * 10^-sourceScale / 10^sourceDec)
  //               * (rateDigits * 10^-rateScale)
  //               * 10^targetDec
  // Expressed as one bigint numerator over one bigint power-of-ten
  // denominator, so the only place any rounding happens is the single
  // final division below, not anywhere in the sourceAmount or rate
  // representation itself.
  const source = parseExactDecimal(sourceAmount);
  const rate = parseExactDecimal(exchangeRate);

  const numerator = source.digits * rate.digits;
  const decimalAdjustment = targetDecimals - sourceDecimals;
  const netExponent = decimalAdjustment - source.scale - rate.scale;

  let scaledNumerator: bigint;
  let denominator: bigint;
  if (netExponent >= 0) {
    scaledNumerator = numerator * 10n ** BigInt(netExponent);
    denominator = 1n;
  } else {
    scaledNumerator = numerator;
    denominator = 10n ** BigInt(-netExponent);
  }

  const quotient = scaledNumerator / denominator;
  const remainder = scaledNumerator % denominator;

  let targetRounded: bigint;
  if (remainder === 0n) {
    targetRounded = quotient;
  } else if (roundingMode === "floor" || roundingMode === "truncate") {
    targetRounded = quotient;
  } else if (roundingMode === "ceil") {
    targetRounded = quotient + 1n;
  } else {
    // Standard half-up rounding: compare the remainder against half the
    // denominator using exact bigint comparison (2 * remainder vs
    // denominator), never a float division.
    targetRounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  }

  return {
    targetAmount: targetRounded.toString(),
    precisionLoss: remainder !== 0n,
  };
}

/**
 * Validates a batch of cross-currency payout items against rounding safeguards.
 */
export function validateCrossCurrencyPayoutRounding(
  items: PayoutRoundingItem[],
  options: RoundingSafeguardOptions = {}
): RoundingSafeguardReport {
  const maxItemDriftBps = options.maxItemDriftBps ?? 5;
  const maxBatchDriftBps = options.maxBatchDriftBps ?? 10;
  const roundingMode = options.roundingMode ?? "round";
  const allowZero = options.allowZero ?? false;

  const itemResults: RoundingItemValidationResult[] = [];
  const reportErrors: Array<{ index?: number; code: RoundingSafeguardErrorCode; message: string }> =
    [];

  let sumSource = 0n;
  let sumComputedTarget = 0n;
  let sumExpectedTarget = 0n;
  let maxObservedDriftBps = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const sourceNum =
      typeof item.sourceAmount === "bigint" ? Number(item.sourceAmount) : Number(item.sourceAmount);
    const rateNum = Number(item.exchangeRate);

    // Validate parameters
    if (
      !Number.isFinite(sourceNum) ||
      (!allowZero && sourceNum <= 0) ||
      (allowZero && sourceNum < 0)
    ) {
      itemResults.push({
        index: i,
        id: item.id,
        recipientId: item.recipientId,
        valid: false,
        computedTargetAmount: "0",
        expectedTargetAmount: item.expectedTargetAmount?.toString(),
        driftBps: 0,
        deltaAmount: "0",
        precisionLoss: false,
        error: {
          code: "INVALID_AMOUNT",
          message: `Item at index ${i} has invalid source amount: ${item.sourceAmount}`,
        },
      });
      reportErrors.push({
        index: i,
        code: "INVALID_AMOUNT",
        message: `Item at index ${i} has invalid source amount: ${item.sourceAmount}`,
      });
      continue;
    }

    if (
      item.sourceDecimals < 0 ||
      item.sourceDecimals > 18 ||
      item.targetDecimals < 0 ||
      item.targetDecimals > 18
    ) {
      itemResults.push({
        index: i,
        id: item.id,
        recipientId: item.recipientId,
        valid: false,
        computedTargetAmount: "0",
        expectedTargetAmount: item.expectedTargetAmount?.toString(),
        driftBps: 0,
        deltaAmount: "0",
        precisionLoss: false,
        error: {
          code: "INVALID_DECIMALS",
          message: `Item at index ${i} has invalid decimal configuration. Decimals must be between 0 and 18.`,
        },
      });
      reportErrors.push({
        index: i,
        code: "INVALID_DECIMALS",
        message: `Item at index ${i} has invalid decimal configuration.`,
      });
      continue;
    }

    if (!Number.isFinite(rateNum) || rateNum <= 0) {
      itemResults.push({
        index: i,
        id: item.id,
        recipientId: item.recipientId,
        valid: false,
        computedTargetAmount: "0",
        expectedTargetAmount: item.expectedTargetAmount?.toString(),
        driftBps: 0,
        deltaAmount: "0",
        precisionLoss: false,
        error: {
          code: "INVALID_EXCHANGE_RATE",
          message: `Item at index ${i} has invalid exchange rate: ${item.exchangeRate}`,
        },
      });
      reportErrors.push({
        index: i,
        code: "INVALID_EXCHANGE_RATE",
        message: `Item at index ${i} has invalid exchange rate: ${item.exchangeRate}`,
      });
      continue;
    }

    // Compute target amount
    const computed = computeTargetPayoutAmount(
      item.sourceAmount,
      item.sourceDecimals,
      item.targetDecimals,
      item.exchangeRate,
      roundingMode
    );

    const computedVal = BigInt(computed.targetAmount);
    // Aggregate the exact source digits, not the already-lossy sourceNum
    // float used only for the finiteness/sign check above (#767).
    sumSource += parseExactDecimal(item.sourceAmount).digits;
    sumComputedTarget += computedVal;

    let itemValid = true;
    let itemError: { code: RoundingSafeguardErrorCode; message: string } | undefined;
    let driftBps = 0;
    let deltaAmount = "0";

    if (item.expectedTargetAmount !== undefined) {
      const expectedVal = BigInt(item.expectedTargetAmount.toString());
      sumExpectedTarget += expectedVal;

      const diff =
        computedVal > expectedVal ? computedVal - expectedVal : expectedVal - computedVal;
      deltaAmount = diff.toString();

      if (expectedVal > 0n) {
        driftBps = Number((diff * 10000n) / expectedVal);
      } else if (computedVal > 0n) {
        driftBps = 10000;
      }

      if (driftBps > maxObservedDriftBps) {
        maxObservedDriftBps = driftBps;
      }

      if (driftBps > maxItemDriftBps) {
        itemValid = false;
        itemError = {
          code: "EXCESSIVE_DRIFT",
          message: `Item at index ${i} exceeds maximum drift threshold: observed ${driftBps} bps, limit is ${maxItemDriftBps} bps.`,
        };
        reportErrors.push({
          index: i,
          code: "EXCESSIVE_DRIFT",
          message: itemError.message,
        });
      }
    } else {
      sumExpectedTarget += computedVal;
    }

    itemResults.push({
      index: i,
      id: item.id,
      recipientId: item.recipientId,
      valid: itemValid,
      computedTargetAmount: computed.targetAmount,
      expectedTargetAmount: item.expectedTargetAmount?.toString(),
      driftBps,
      deltaAmount,
      precisionLoss: computed.precisionLoss,
      error: itemError,
    });
  }

  // Check cumulative batch drift if expected amounts were provided
  let cumulativeDriftBps = 0;
  if (sumExpectedTarget > 0n) {
    const totalDiff =
      sumComputedTarget > sumExpectedTarget
        ? sumComputedTarget - sumExpectedTarget
        : sumExpectedTarget - sumComputedTarget;
    cumulativeDriftBps = Number((totalDiff * 10000n) / sumExpectedTarget);

    if (cumulativeDriftBps > maxBatchDriftBps) {
      reportErrors.push({
        code: "CUMULATIVE_DRIFT_EXCEEDED",
        message: `Batch cumulative drift of ${cumulativeDriftBps} bps exceeds maximum allowed limit of ${maxBatchDriftBps} bps.`,
      });
    }
  }

  const passedCount = itemResults.filter((r) => r.valid).length;
  const overallValid = reportErrors.length === 0 && passedCount === items.length;

  return {
    valid: overallValid,
    totalItems: items.length,
    passedItems: passedCount,
    failedItems: items.length - passedCount,
    totalSourceAmount: sumSource.toString(),
    totalComputedTargetAmount: sumComputedTarget.toString(),
    totalExpectedTargetAmount: sumExpectedTarget.toString(),
    cumulativeDriftBps,
    maxObservedDriftBps,
    items: itemResults,
    errors: reportErrors,
  };
}
