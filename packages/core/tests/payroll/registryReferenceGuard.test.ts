/**
 * Tests for Company Registry Reference Guard (#764)
 *
 * Covers:
 *  - checkRegistryReference — found+active, found+inactive, not found, lookup error
 *  - validateRegistryReferences — successful (all valid), rejected (some invalid),
 *    boundary (empty employee list)
 *  - assertRegistryReferencesValid / guardRunCreation — throwing guards
 *  - Privacy: error messages never expose full employee identifiers or salary data
 */

import {
  checkRegistryReference,
  validateRegistryReferences,
  assertRegistryReferencesValid,
  guardRunCreation,
  RegistryReferenceError,
  type RegistryEntryLookup,
} from "../../src/payroll/registryReferenceGuard";

const EMPLOYER = "GEMPLOYER0000000000000000000000000000000000000000000";
const ACTIVE_EMPLOYEE = "GACTIVEEMPLOYEE000000000000000000000000000000000000000";
const INACTIVE_EMPLOYEE = "GINACTIVEEMPLOYEE0000000000000000000000000000000000000";
const MISSING_EMPLOYEE = "GMISSINGEMPLOYEE0000000000000000000000000000000000000";
const ERRORING_EMPLOYEE = "GERRORINGEMPLOYEE0000000000000000000000000000000000000";

function makeLookup(): RegistryEntryLookup {
  return async (_employer: string, employeeId: string) => {
    if (employeeId === ACTIVE_EMPLOYEE) return { active: true };
    if (employeeId === INACTIVE_EMPLOYEE) return { active: false };
    if (employeeId === MISSING_EMPLOYEE) return undefined;
    if (employeeId === ERRORING_EMPLOYEE) throw new Error("network timeout");
    return null;
  };
}

describe("checkRegistryReference", () => {
  it("returns valid for an active registry entry (successful case)", async () => {
    const result = await checkRegistryReference(EMPLOYER, ACTIVE_EMPLOYEE, makeLookup());
    expect(result.valid).toBe(true);
    expect(result.blockReason).toBe("none");
  });

  it("returns invalid with REGISTRY_ENTRY_INACTIVE for a deactivated entry (rejected case)", async () => {
    const result = await checkRegistryReference(EMPLOYER, INACTIVE_EMPLOYEE, makeLookup());
    expect(result.valid).toBe(false);
    expect(result.blockReason).toBe("REGISTRY_ENTRY_INACTIVE");
  });

  it("returns invalid with REGISTRY_ENTRY_NOT_FOUND when no entry exists (boundary case)", async () => {
    const result = await checkRegistryReference(EMPLOYER, MISSING_EMPLOYEE, makeLookup());
    expect(result.valid).toBe(false);
    expect(result.blockReason).toBe("REGISTRY_ENTRY_NOT_FOUND");
  });

  it("returns invalid with REGISTRY_LOOKUP_FAILED when the lookup throws, instead of propagating", async () => {
    const result = await checkRegistryReference(EMPLOYER, ERRORING_EMPLOYEE, makeLookup());
    expect(result.valid).toBe(false);
    expect(result.blockReason).toBe("REGISTRY_LOOKUP_FAILED");
  });

  it("masks the employee identifier in the returned check", async () => {
    const result = await checkRegistryReference(EMPLOYER, ACTIVE_EMPLOYEE, makeLookup());
    expect(result.redactedEmployeeId).not.toBe(ACTIVE_EMPLOYEE);
    expect(result.redactedEmployeeId).toMatch(/^GACT.*0000$/);
  });
});

describe("validateRegistryReferences", () => {
  it("reports allValid=true when every employee has an active registry entry (successful case)", async () => {
    const result = await validateRegistryReferences(
      EMPLOYER,
      [ACTIVE_EMPLOYEE, ACTIVE_EMPLOYEE],
      makeLookup()
    );
    expect(result.allValid).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it("reports allValid=false and lists only the failing employees, in order (rejected case)", async () => {
    const result = await validateRegistryReferences(
      EMPLOYER,
      [ACTIVE_EMPLOYEE, INACTIVE_EMPLOYEE, MISSING_EMPLOYEE],
      makeLookup()
    );
    expect(result.allValid).toBe(false);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]?.employeeId).toBe(INACTIVE_EMPLOYEE);
    expect(result.failures[1]?.employeeId).toBe(MISSING_EMPLOYEE);
    expect(result.checks).toHaveLength(3);
  });

  it("reports allValid=true for an empty employee list (boundary case)", async () => {
    const result = await validateRegistryReferences(EMPLOYER, [], makeLookup());
    expect(result.allValid).toBe(true);
    expect(result.checks).toHaveLength(0);
  });
});

describe("assertRegistryReferencesValid / guardRunCreation", () => {
  it("does not throw when all employees are valid", async () => {
    const result = await validateRegistryReferences(EMPLOYER, [ACTIVE_EMPLOYEE], makeLookup());
    expect(() => assertRegistryReferencesValid(result)).not.toThrow();
  });

  it("throws RegistryReferenceError listing only the failures when any employee is invalid", async () => {
    const result = await validateRegistryReferences(
      EMPLOYER,
      [ACTIVE_EMPLOYEE, INACTIVE_EMPLOYEE],
      makeLookup()
    );
    expect(() => assertRegistryReferencesValid(result)).toThrow(RegistryReferenceError);
    try {
      assertRegistryReferencesValid(result);
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryReferenceError);
      expect((error as RegistryReferenceError).failures).toHaveLength(1);
    }
  });

  it("guardRunCreation resolves with the result for an all-valid run", async () => {
    const result = await guardRunCreation(EMPLOYER, [ACTIVE_EMPLOYEE], makeLookup());
    expect(result.allValid).toBe(true);
  });

  it("guardRunCreation rejects with RegistryReferenceError for an invalid run", async () => {
    await expect(
      guardRunCreation(EMPLOYER, [INACTIVE_EMPLOYEE], makeLookup())
    ).rejects.toBeInstanceOf(RegistryReferenceError);
  });

  it("never includes the full employee identifier or salary data in the thrown error message", async () => {
    const result = await validateRegistryReferences(EMPLOYER, [INACTIVE_EMPLOYEE], makeLookup());
    try {
      assertRegistryReferencesValid(result);
      fail("expected assertRegistryReferencesValid to throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(INACTIVE_EMPLOYEE);
      expect(message).not.toMatch(/salary|amount|\d{5,}/i);
    }
  });
});
