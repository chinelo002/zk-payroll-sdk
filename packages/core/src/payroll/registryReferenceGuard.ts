/**
 * Company Registry Reference Guard (#764)
 *
 * Validates that every employee referenced by a payroll run has an active
 * `PayrollRegistryClient` registry entry before the run is created.
 * `resolvePayrollRecipients` (recipientResolver.ts) already resolves an
 * employee ID to a payout destination address and rejects an unresolvable
 * or malformed address, but it never checks whether that employee's
 * registry entry is still `active` (RegistryEntry.active). A payroll run
 * built against a deactivated or stale registry reference would be
 * rejected by the on-chain contract, but only after a proof has already
 * been built and a transaction submitted — this guard catches it in the
 * SDK layer, before any of that work happens.
 *
 * ## Privacy & Security Guarantees
 * - Employer and employee addresses are masked in human-readable summaries.
 * - No salary amounts or other registry metadata appear in error messages.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** Reason codes explaining why an employee's registry reference is invalid. */
export type RegistryReferenceBlockReason =
  "REGISTRY_ENTRY_NOT_FOUND" | "REGISTRY_ENTRY_INACTIVE" | "REGISTRY_LOOKUP_FAILED" | "none";

/** Per-employee registry reference validation outcome. */
export interface RegistryReferenceCheck {
  employeeId: string;
  /** Masked employee identifier, safe for display. */
  redactedEmployeeId: string;
  /** Whether this employee's registry reference is valid for run creation. */
  valid: boolean;
  blockReason: RegistryReferenceBlockReason;
}

/** Aggregate result of validating every employee in a payroll run. */
export interface RegistryReferenceValidationResult {
  /** True only when every employee passed validation. */
  allValid: boolean;
  checks: RegistryReferenceCheck[];
  /** Convenience: the subset of `checks` that failed, in input order. */
  failures: RegistryReferenceCheck[];
}

/**
 * Looks up a single employee's registry entry. Returns `undefined` (not a
 * rejected promise) when no entry exists for the employee — matching
 * `RecipientResolver`'s own `string | null | undefined` convention in
 * recipientResolver.ts for "not found" rather than throwing. A genuine
 * lookup error (network failure, malformed response) should still reject,
 * and is reported as `REGISTRY_LOOKUP_FAILED` rather than silently treated
 * as "not found".
 */
export type RegistryEntryLookup = (
  employer: string,
  employeeId: string
) => Promise<{ active: boolean } | null | undefined>;

// ── Validation ────────────────────────────────────────────────────────────────

/** Mask an identifier for safe display (first 4 + last 4 characters). */
function maskIdentifier(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

/**
 * Validate a single employee's registry reference.
 *
 * Pure with respect to its inputs: the actual registry lookup is performed
 * by the caller-supplied `lookup` function, so this can be tested against
 * any registry source (a live contract read, a cache, or a test fixture)
 * without network access.
 */
export async function checkRegistryReference(
  employer: string,
  employeeId: string,
  lookup: RegistryEntryLookup
): Promise<RegistryReferenceCheck> {
  const redactedEmployeeId = maskIdentifier(employeeId);

  let entry: { active: boolean } | null | undefined;
  try {
    entry = await lookup(employer, employeeId);
  } catch {
    return {
      employeeId,
      redactedEmployeeId,
      valid: false,
      blockReason: "REGISTRY_LOOKUP_FAILED",
    };
  }

  if (!entry) {
    return {
      employeeId,
      redactedEmployeeId,
      valid: false,
      blockReason: "REGISTRY_ENTRY_NOT_FOUND",
    };
  }

  if (!entry.active) {
    return {
      employeeId,
      redactedEmployeeId,
      valid: false,
      blockReason: "REGISTRY_ENTRY_INACTIVE",
    };
  }

  return { employeeId, redactedEmployeeId, valid: true, blockReason: "none" };
}

/**
 * Validate every employee referenced by a payroll run before it is created.
 *
 * Checks run concurrently (registry lookups are independent reads), but
 * the returned `checks` array preserves `employeeIds`' input order so a
 * caller can correlate failures back to the run's recipient list.
 *
 * @example
 * ```ts
 * const result = await validateRegistryReferences(
 *   employer,
 *   recipients.map((r) => r.employeeId),
 *   (employer, employeeId) => registryClient.getRegistry(employer, employeeId, signer)
 * );
 * assertRegistryReferencesValid(result); // throws RegistryReferenceError if any failed
 * ```
 */
export async function validateRegistryReferences(
  employer: string,
  employeeIds: readonly string[],
  lookup: RegistryEntryLookup
): Promise<RegistryReferenceValidationResult> {
  const checks = await Promise.all(
    employeeIds.map((employeeId) => checkRegistryReference(employer, employeeId, lookup))
  );
  const failures = checks.filter((check) => !check.valid);
  return { allValid: failures.length === 0, checks, failures };
}

// ── Errors ────────────────────────────────────────────────────────────────────

/**
 * Exception thrown when one or more employees in a payroll run have an
 * invalid company registry reference. The message is privacy-safe
 * (identifiers are masked) and actionable, and never includes salary or
 * other registry metadata.
 */
export class RegistryReferenceError extends Error {
  public readonly failures: RegistryReferenceCheck[];

  constructor(result: RegistryReferenceValidationResult) {
    const summary = result.failures
      .map((failure) => `${failure.redactedEmployeeId} (${failure.blockReason})`)
      .join(", ");
    super(
      `Cannot create payroll run: ${result.failures.length} employee(s) have an invalid ` +
        `company registry reference: ${summary}. Verify each employee is registered and active ` +
        `before retrying.`
    );
    this.name = "RegistryReferenceError";
    this.failures = result.failures;
  }
}

/**
 * Assert that every employee in a validated run has a valid registry
 * reference.
 *
 * @throws {RegistryReferenceError} when one or more employees failed validation
 */
export function assertRegistryReferencesValid(result: RegistryReferenceValidationResult): void {
  if (!result.allValid) {
    throw new RegistryReferenceError(result);
  }
}

/**
 * Convenience guard: validate and assert in one call. Returns the
 * validation result when every employee has a valid registry reference.
 *
 * @throws {RegistryReferenceError} when one or more employees failed validation
 */
export async function guardRunCreation(
  employer: string,
  employeeIds: readonly string[],
  lookup: RegistryEntryLookup
): Promise<RegistryReferenceValidationResult> {
  const result = await validateRegistryReferences(employer, employeeIds, lookup);
  assertRegistryReferencesValid(result);
  return result;
}
