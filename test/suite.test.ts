import { test } from "node:test";
import assert from "node:assert/strict";

import { checkSingleUse } from "../src/index.ts";
import { CHECKS } from "../src/checks.ts";
import {
    alwaysNullStore,
    correctStore,
    correctStoreWithoutAttempts,
    expiresEarlyStore,
    failsOpenStore,
    globallyLockedStore,
    ignoresBudgetStore,
    ignoresExpiryStore,
    losesAttemptsStore,
    neverMarksStore,
    overBroadGuardStore,
    readThenWriteStore,
} from "./stores.ts";

/** Runs the suite and returns the names of the checks that failed. */
async function failures(createStore: () => unknown, rounds = 5): Promise<string[]> {
    const report = await checkSingleUse({
        createStore: createStore as never,
        rounds,
        concurrency: 12,
    });
    return report.results.filter((r) => !r.passed).map((r) => r.name);
}

test("a correct store passes every check", async () => {
    const report = await checkSingleUse({ createStore: correctStore });
    assert.ok(report.passed, report.summary);
    assert.match(report.summary, /^All \d+ single-use checks passed/);
    assert.equal(
        report.results.filter((r) => r.skipped).length,
        0,
        "the correct store implements spendAttempt, so nothing should be skipped",
    );
});

test("the read-then-write race is caught", async () => {
    // The defect the package exists for: every sequential test passes, and the
    // credential is still not single use.
    const failed = await failures(readThenWriteStore);
    assert.ok(
        failed.includes("concurrent claims elect exactly one winner"),
        `expected the race to be caught, got: ${JSON.stringify(failed)}`,
    );

    const report = await checkSingleUse({ createStore: readThenWriteStore, rounds: 5 });
    const race = report.results.find((r) => r.name.includes("elect exactly one winner"));
    assert.match(race?.detail ?? "", /NOT SINGLE USE/);
    // The message has to teach, not just fail: whoever hits this is often
    // meeting the bug for the first time.
    assert.match(race?.detail ?? "", /guarded statement/);
});

test("a store that never marks anything fails without needing concurrency", async () => {
    const failed = await failures(neverMarksStore);
    assert.ok(failed.includes("a credential cannot be claimed twice in sequence"));
});

test("ignoring expiry is caught", async () => {
    const failed = await failures(ignoresExpiryStore);
    assert.ok(failed.includes("an expired credential is never claimed"));
});

test("ignoring the attempt budget is caught", async () => {
    const failed = await failures(ignoresBudgetStore);
    assert.ok(failed.includes("exhausting the attempt budget retires the credential"));
});

test("losing concurrent decrements is caught", async () => {
    // A lost decrement is a free brute-force guess.
    const failed = await failures(losesAttemptsStore);
    assert.ok(failed.includes("concurrent failed attempts each spend one try"));
});

test("failing open on an unknown id is caught", async () => {
    const failed = await failures(failsOpenStore);
    assert.ok(failed.includes("an unknown credential is never claimed"));
});

test("an over-broad guard that invalidates other credentials is caught", async () => {
    const failed = await failures(overBroadGuardStore);
    assert.ok(failed.includes("claiming one credential does not affect another"));
});

test("a global lock is caught, though it is perfectly safe", async () => {
    // Correctness and throughput are both part of the contract. A store that
    // serializes every claim passes every safety check while turning sign-in
    // into a queue, and nothing else here would notice.
    const failed = await failures(globallyLockedStore);
    assert.ok(failed.includes("concurrent claims on distinct credentials all succeed"));
});

test("every check is demonstrably capable of failing", async () => {
    // The standard this suite asks of others, applied to itself. A check that
    // no store in the corpus can fail is decoration, and would silently become
    // decoration the moment someone refactored it wrong.
    const corpus = [
        readThenWriteStore,
        neverMarksStore,
        ignoresExpiryStore,
        ignoresBudgetStore,
        losesAttemptsStore,
        failsOpenStore,
        overBroadGuardStore,
        globallyLockedStore,
        // Broken restrictively rather than permissively. Without these two the
        // positive checks would never be shown to fail.
        alwaysNullStore,
        expiresEarlyStore,
    ];

    const everFailed = new Set<string>();
    for (const store of corpus) {
        for (const name of await failures(store)) everFailed.add(name);
    }

    const never = CHECKS.map((c) => c.name).filter((name) => !everFailed.has(name));
    assert.deepEqual(
        never,
        [],
        `these checks never failed against any broken store, so they prove nothing:\n  ${never.join("\n  ")}`,
    );
});

test("a violation is reported, never thrown", async () => {
    // The report is data so it can be asserted on, printed, or used to gate a
    // release. Only a throw from the adapter itself is exceptional.
    const report = await checkSingleUse({ createStore: readThenWriteStore, rounds: 3 });
    assert.equal(report.passed, false);
    assert.match(report.summary, /single-use checks failed/);
    assert.ok(report.results.every((r) => typeof r.detail === "string"));
});

test("an adapter that throws is reported as a failure, with its message", async () => {
    const report = await checkSingleUse({
        createStore: () => ({
            issue: async () => {},
            claim: async () => {
                throw new Error("connection reset");
            },
        }),
        rounds: 1,
    });
    assert.equal(report.passed, false);
    assert.match(report.summary, /connection reset/);
});

test("the optional attempt checks are skipped, not failed, when unimplemented", async () => {
    const report = await checkSingleUse({ createStore: correctStoreWithoutAttempts, rounds: 2 });
    assert.ok(report.passed, report.summary);
    const skipped = report.results.filter((r) => r.skipped);
    assert.equal(skipped.length, 2, "both attempt-budget checks should skip");
    assert.ok(skipped.every((r) => r.passed), "a skipped check must not count as a failure");
    assert.match(report.summary, /skipped/);
});

test("repetition is what makes the race check trustworthy", async () => {
    // A single trial can be won cleanly by luck. This asserts the knob exists
    // and is honoured, because the whole argument for this over a hand-written
    // race test is that it does not rely on one lucky scheduling.
    const once = await checkSingleUse({
        createStore: readThenWriteStore,
        rounds: 1,
        concurrency: 24,
    });
    const many = await checkSingleUse({
        createStore: readThenWriteStore,
        rounds: 25,
        concurrency: 24,
    });
    assert.equal(once.passed, false);
    assert.equal(many.passed, false);

    const detail = many.results.find((r) => r.name.includes("one winner"))?.detail ?? "";
    assert.match(detail, /round \d+/, "the failure names the round, so it is reproducible");
});
