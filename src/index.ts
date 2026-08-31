/**
 * single-use — prove your one-time credentials are actually one-time.
 *
 * ```ts
 * import { checkSingleUse } from "single-use";
 *
 * const report = await checkSingleUse({
 *     createStore: () => ({
 *         issue: ({ id, expiresAt }) => db.codes.insert({ id, expiresAt }),
 *         claim: ({ id, now }) => db.codes.claim(id, now),   // your real function
 *     }),
 * });
 *
 * assert.ok(report.passed, report.summary);
 * ```
 *
 * Runner-agnostic on purpose: it returns a report rather than calling
 * `expect`, so it works under node:test, Vitest, Jest, Deno, Bun, or a plain
 * script, and adds no dependency to your test tree.
 *
 * @packageDocumentation
 */

import { CHECKS, resolve, type Context } from "./checks.ts";
import type { CheckResult, ClaimStore, Harness, Report } from "./types.ts";

export type { Credential, ClaimStore, Harness, CheckResult, Report } from "./types.ts";

/**
 * Runs the suite and reports what held.
 *
 * Never throws for a failed check — a violation is data, not an exception, so
 * you can assert on it, print it, or gate a release on it however you like. It
 * does propagate an error thrown by your own adapter, because that is a bug in
 * the harness rather than a finding.
 */
export async function checkSingleUse<T>(harness: Harness<T>): Promise<Report> {
    const { concurrency, rounds, epoch } = resolve(harness);
    const results: CheckResult[] = [];

    let counter = 0;
    const nextId = (): string => `su_${(counter++).toString(36)}_${Date.now().toString(36)}`;

    for (const check of CHECKS) {
        const store = (await harness.createStore()) as ClaimStore;

        if (check.needs === "spendAttempt" && typeof store.spendAttempt !== "function") {
            results.push({
                name: check.name,
                passed: true,
                skipped: true,
                detail: "skipped: the adapter does not implement spendAttempt",
            });
            await harness.teardown?.(store as ClaimStore<T>);
            continue;
        }

        const context: Context = { store, now: epoch, concurrency, rounds, id: nextId };

        try {
            const violation = await check.run(context);
            results.push({
                name: check.name,
                passed: violation === null,
                skipped: false,
                detail: violation ?? "ok",
            });
        } catch (error) {
            // A throw from the adapter is reported rather than swallowed: a
            // store that crashes under concurrency has still failed, and
            // hiding the message would make it undebuggable.
            results.push({
                name: check.name,
                passed: false,
                skipped: false,
                detail: `threw: ${error instanceof Error ? error.message : String(error)}`,
            });
        } finally {
            await harness.teardown?.(store as ClaimStore<T>);
        }
    }

    const failures = results.filter((result) => !result.passed);
    const skipped = results.filter((result) => result.skipped).length;

    const summary =
        failures.length === 0
            ? `All ${results.length - skipped} single-use checks passed` +
              (skipped > 0 ? ` (${skipped} skipped).` : ".")
            : [
                  `${failures.length} of ${results.length - skipped} single-use checks failed:`,
                  ...failures.map((failure) => `  ✗ ${failure.name}\n      ${failure.detail}`),
              ].join("\n");

    return { passed: failures.length === 0, results, summary };
}
