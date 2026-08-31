import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { checkSingleUse } from "../src/index.ts";
import type { ClaimStore } from "../src/types.ts";

/**
 * The suite against a real database.
 *
 * The in-memory stores prove the checks fire. They cannot prove the suite is
 * meaningful against actual storage, because a JavaScript object's
 * "atomicity" is really the single-threaded event loop — the property is
 * true by accident rather than by construction. Here the winner is elected by
 * SQLite's own row lock, which is the mechanism the contract actually
 * describes.
 *
 * `node:sqlite` is a Node builtin, so this costs no dependency.
 */

const SCHEMA = `
CREATE TABLE credential (
  id          TEXT PRIMARY KEY,
  expires_at  INTEGER,
  max_attempts INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0,
  claimed_at  INTEGER
);`;

function database(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    db.exec(SCHEMA);
    return db;
}

/**
 * The correct shape: one guarded `UPDATE`, then read back what it claimed.
 *
 * The `WHERE` is the compare and the `SET` is the swap. SQLite performs both
 * under one lock, so exactly one concurrent caller sees `changes === 1`.
 */
function guardedStore(db: DatabaseSync): ClaimStore<unknown> {
    return {
        async issue({ id, expiresAt, maxAttempts }) {
            db.prepare(
                "INSERT INTO credential (id, expires_at, max_attempts) VALUES (?, ?, ?)",
            ).run(id, expiresAt ?? null, maxAttempts ?? null);
        },
        async claim({ id, now }) {
            const result = db
                .prepare(
                    `UPDATE credential SET claimed_at = ?
                      WHERE id = ?
                        AND claimed_at IS NULL
                        AND (expires_at IS NULL OR expires_at > ?)
                        AND (max_attempts IS NULL OR attempts < max_attempts)`,
                )
                .run(now, id, now);

            if (Number(result.changes) !== 1) return null;
            return db.prepare("SELECT * FROM credential WHERE id = ?").get(id) ?? null;
        },
        async spendAttempt({ id, now }) {
            db.prepare(
                `UPDATE credential SET attempts = attempts + 1
                  WHERE id = ?
                    AND claimed_at IS NULL
                    AND (expires_at IS NULL OR expires_at > ?)
                    AND (max_attempts IS NULL OR attempts < max_attempts)`,
            ).run(id, now);
        },
    };
}

/**
 * The same table, redeemed the way it is usually written: SELECT, decide in
 * application code, then UPDATE. Every statement is valid SQL and the logic
 * reads correctly.
 */
function naiveStore(db: DatabaseSync): ClaimStore<unknown> {
    return {
        async issue({ id, expiresAt, maxAttempts }) {
            db.prepare(
                "INSERT INTO credential (id, expires_at, max_attempts) VALUES (?, ?, ?)",
            ).run(id, expiresAt ?? null, maxAttempts ?? null);
        },
        async claim({ id, now }) {
            const row = db.prepare("SELECT * FROM credential WHERE id = ?").get(id) as
                | { claimed_at: number | null; expires_at: number | null }
                | undefined;

            if (!row) return null;
            if (row.claimed_at !== null) return null;
            if (row.expires_at !== null && row.expires_at <= now) return null;

            // Any await here — a pool checkout, a round trip, a hook — is the
            // window. In a real deployment this is where the second request's
            // SELECT lands.
            await new Promise((resolve) => setTimeout(resolve, 0));

            db.prepare("UPDATE credential SET claimed_at = ? WHERE id = ?").run(now, id);
            return row;
        },
    };
}

test("a guarded UPDATE passes the suite on real SQLite", async () => {
    const open: DatabaseSync[] = [];
    const report = await checkSingleUse({
        createStore: () => {
            const db = database();
            open.push(db);
            return guardedStore(db);
        },
        teardown: () => {},
    });
    for (const db of open) db.close();

    assert.ok(report.passed, report.summary);
});

test("the same table redeemed with SELECT-then-UPDATE fails on real SQLite", async () => {
    // The point of the package, demonstrated end to end against a database
    // rather than a double: same schema, same data, one difference in how the
    // claim is written, and the credential stops being single use.
    const open: DatabaseSync[] = [];
    const report = await checkSingleUse({
        createStore: () => {
            const db = database();
            open.push(db);
            return naiveStore(db);
        },
        rounds: 5,
        concurrency: 12,
    });
    for (const db of open) db.close();

    assert.equal(report.passed, false);

    const race = report.results.find((r) => r.name.includes("elect exactly one winner"));
    assert.equal(race?.passed, false, "the race must be caught against a real database");
    assert.match(race?.detail ?? "", /NOT SINGLE USE/);
});

test("the guarded claim really is the database electing the winner", async () => {
    // Guards against the suite passing for the wrong reason. If the winner
    // were elected by JavaScript rather than by SQLite, `changes` would not be
    // the discriminator — so assert on it directly.
    const db = database();
    try {
        const store = guardedStore(db);
        await store.issue({ id: "c1" });

        const first = db
            .prepare("UPDATE credential SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL")
            .run(1, "c1");
        const second = db
            .prepare("UPDATE credential SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL")
            .run(2, "c1");

        assert.equal(Number(first.changes), 1, "the first guarded update claims the row");
        assert.equal(Number(second.changes), 0, "the second matches nothing — the guard held");
    } finally {
        db.close();
    }
});
