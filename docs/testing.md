# Testing

## Unit & integration tests (Vitest)

Tests use **Vitest** with Testing Library for React components.

**Run them from `apps/leaderboard-client`:**

```bash
cd apps/leaderboard-client && npx vitest run
```

That package has the only Vitest config that maps the `@/…` alias (`apps/leaderboard-client/vitest.config.ts`). The root `npm test` picks up the same files without that alias, so every suite whose route imports an unmocked `@/…` module fails to load there — a known gap in the root runner, not a broken test. Use the app-level runner as the gate.

The core, the content and the modules (`packages/`, `content/`, `modules/`) run from the repo root, in the `packages` project of the root `vitest.config.ts`:

```bash
npx vitest run --dir . packages/ content/ modules/
```

Useful variants:

```bash
npm run test:watch      # watch mode (re-runs on file changes)
npm run test:coverage   # generate coverage report
```

Test files live alongside the code they test, typically as `*.test.ts` or `*.spec.ts`.

## Integration tests on Postgres

Files named `*.integration.test.ts` (under `packages/` and `content/`) run against the real database of `DATABASE_URL`, one file at a time, and are ignored by the runs above:

```bash
npm run test:integration      # vitest.integration.config.ts
```

They cover what an in-memory double cannot: the `resources` capability's concurrent invariants (`k` never exceeded, TTL, uniqueness, scoped claims), blobs, the data-annotation and endpoint-check equivalence campaigns against their hand-written flows, and templates in the database (immutability trigger, version order, composite FK, catch-up, unservable versions).

**They never erase what they did not create.** The database is a real development database. Each test builds an `integrationScope()` (`packages/database-service/testing/integration.ts`): it creates its own users, project and challenges, and `cleanup()` deletes them — resources, claims, contributions, ledger rows and blobs follow by cascade. A template key taken with `scope.templateKey()` is deleted too, published versions included: `cleanup` disables the `template_versions_guard` trigger inside one transaction to do it — a gesture reserved to tests. A job that walks every challenge of a flow (an audit) is restricted to the test's own challenges. Apply the schema first (`npm run db:apply-schema`).

## Templates

```bash
npm run templates:check       # validate the conformance corpus and content/templates/*/template.yaml,
                              # and fail when a template.source.ts is stale
npm run templates:build       # regenerate the template.source.ts modules
```

---

## What to test when contributing

When adding a new feature or fixing a bug:

1. **Add a Vitest test** for any logic that can be tested in isolation (utilities, transformations, validators).
2. **Run `npx vitest run` from `apps/leaderboard-client`** before opening a PR, and `npx tsc --noEmit` there too — there is no working ESLint config in the repo, so those two are the gate.
3. **Touching the database, claims, templates or a flow's data?** Run `npm run test:integration` as well, and `npm run templates:check` when a template changed.
