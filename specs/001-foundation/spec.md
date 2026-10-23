# Feature Specification: Slice 0 — Foundation

**Feature Branch**: `001-foundation`

**Created**: 2026-10-23

**Status**: Draft

**Input**: User description: "Slice 0 — Foundation. Scope per the constitution's slice order:
docker compose (db, migrations, bootstrap, api, web, nginx, maintenance, Mailpit under the
local profile), config validation, structured logging and correlation ids, health and
readiness, the RFC 9457 error format and code registry, DB roles (owner/app/maintenance) and
the audit table with actor context, the Zod → OpenAPI pipeline with drift check, the frontend
shell (routing, generated client, ConfirmDialog, error/loading/empty states), the mail
adapter, the admin bootstrap and operator CLI skeleton, and CI (lint, typecheck, ID ban,
migrations from empty, contract check, compose smoke test). The very first task must add a
root .gitignore covering .env, node_modules, dist, coverage and build output, before any
.env exists. No business features (vendors, orders) in this slice. Authentication and
accounts are slice 1. Trace every requirement to docs/traceability.md rows."

## Context

This slice builds the platform that every later slice stands on. It delivers no
procurement feature. Its users are the **operator**, who runs the system; the
**developer and reviewer**, who change it and must trust the automated checks; and the
**end user**, who sees only the application shell for now.

The binding documents are the [constitution](../../.specify/memory/constitution.md), the
ADRs in [docs/adr/](../../docs/adr/README.md), and [docs/BRIEF.md](../../docs/BRIEF.md).
This spec states *what* must be true. The ADRs record *how*. Where a mechanism is already
decided, this spec points to its ADR instead of repeating it.

## Clarifications

### Session 2026-10-23

- Q: Which CI service should run the automated checks for this repository? → A: GitHub
  Actions, with workflows in `.github/workflows/`, required on pull requests to `main`.
- Q: How should the API expose its latency and error metrics, which ADR-0020 requires? → A:
  A `/metrics` endpoint in Prometheus format on an internal-only port. Docker compose
  declares that port with `expose` only (reachable inside the compose network) and never
  publishes it to the host. nginx never routes it. No metrics server is added.
- Q: Which browsers must the web app support, and which ones should the automated
  end-to-end tests run in? → A: The latest 2 versions of Chrome, Edge, Firefox and Safari.
  End-to-end tests run on Chromium for every pull request, and on Chromium, Firefox and
  WebKit nightly and on `main`.
- Q: The repository is public. What does that require of CI and secrets? → A: CI never
  uses `pull_request_target`. Secrets come only from GitHub Actions secrets, and no check
  needs one, so pull requests from forks pass using generated throwaway values.
  `.env.example` holds placeholder values only. A secret-scanning check runs on every pull
  request (its diff) and every push to `main` (full history), and is required to pass.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - One-command start for an operator (Priority: P1)

An operator copies the example environment file, runs one command, and gets the whole
system running: the database, schema migrations, the first administrator, the API, the
web app behind a single same-origin edge, the daily maintenance service and, locally, a test
mail inbox. They can ask the system whether it is alive and whether it is ready.

**Why this priority**: The brief requires it (§6). Every later slice and every test
environment depends on it.

**Independent Test**: From a clean checkout, copy the example environment, start the
stack, and confirm that the health and readiness checks pass, the web app loads, the API
answers on the same origin, and the maintenance service and test inbox are running.

**Acceptance Scenarios**:

1. **Given** a clean checkout and the example environment file copied unchanged, **When**
   the operator starts the stack, **Then** all services become healthy with no other
   manual step, and the readiness check reports the database as reachable.
2. **Given** a running stack, **When** the database is stopped, **Then** the readiness
   check fails and the liveness check still passes.
3. **Given** a configuration value that is missing or invalid, **When** any service
   starts, **Then** it exits with a non-zero status and names each invalid setting,
   without printing secret values.
4. **Given** a production environment setting, **When** demo data seeding is enabled or
   the mail host points at the local test inbox, **Then** startup is refused.
5. **Given** the API or the CLI is given any database credentials other than the
   application role's (owner, superuser or maintenance), or the maintenance service is given
   any other than its own, **When** it starts, **Then** it refuses to start and names the
   variable.
6. **Given** the stack is running, **When** a request reaches the web app or the API,
   **Then** both are served from one origin and a cross-origin request to the API is
   refused.
7. **Given** the stack is running, **When** `/metrics` is requested through the public
   edge or on any port published to the host, **Then** it isn't served: the edge returns
   `404`. **When** it's requested on the API's internal metrics port from inside the
   compose network, **Then** it returns latency and error metrics.

---

### User Story 2 - Every change is checked automatically (Priority: P1)

A developer opens a change. Automated checks confirm the code style, the types, the ban on
requirement IDs outside test names, that the database builds from empty with every
migration, that the API contract matches its single source and has no unapproved breaking
change, that every test passes against a real database, that dependencies have no known
high or critical vulnerability, and that the whole stack starts and answers.

**Why this priority**: Every later slice relies on these checks to keep the guarantees in
the constitution. Without them, the quality bar can't be enforced.

**Independent Test**: Open a change that deliberately breaks each check in turn, and
confirm that the matching check fails and the others pass.

**Acceptance Scenarios**:

1. **Given** a change that edits the API schema source without regenerating the
   committed contract, **When** the checks run, **Then** the contract drift check fails.
2. **Given** a change that removes or renames a contract field, **When** the checks run
   without the breaking-change label, **Then** the breaking-change check fails.
3. **Given** a requirement ID in production source, a comment or a commit subject,
   **When** the checks run, **Then** the ID-ban check fails. The same ID in a test name
   passes.
4. **Given** an empty database, **When** the checks apply every migration in order,
   **Then** they succeed, and the reconciliation and role checks pass.
5. **Given** a test that cites a requirement ID missing from the traceability matrix,
   **When** the checks run, **Then** the traceability check fails.
6. **Given** any change, **When** the checks run, **Then** the stack smoke test starts the
   stack, checks health and readiness, and loads the web app.

---

### User Story 3 - Consistent, traceable failures (Priority: P1)

When anything goes wrong, a client gets an error in one standard shape, with a stable
machine-readable code and a correlation id. The same correlation id appears in every log
line for that request, and in any audit entry the request writes. Logs never contain
secrets, tokens or personal data.

**Why this priority**: The constitution forbids message matching, and every later slice
adds codes to this registry. Support and audit both depend on being able to follow one
request end to end.

**Independent Test**: Send malformed, invalid and unknown-route requests, and trigger an
unexpected internal failure. Confirm each response's shape and code, that the correlation
id matches the response header and the log lines, and that no internal detail or secret
leaks.

**Acceptance Scenarios**:

1. **Given** a request with malformed JSON, **When** it reaches the API, **Then** the
   response is `400` in the standard error shape, with a stable code and a correlation id.
2. **Given** a request with an unknown field or an invalid path id, **When** it reaches
   the API, **Then** it's rejected with `400 VALIDATION_FAILED` and field-level details,
   before any business logic runs.
3. **Given** an unknown route, **When** it's requested, **Then** the response is
   `404 NOT_FOUND` in the standard shape.
4. **Given** an unexpected internal failure, **When** it occurs, **Then** the response is
   `500 INTERNAL_ERROR` with no stack trace or internal detail, and the log line carries
   the full error and the same correlation id.
5. **Given** the database pool is exhausted or a transaction times out, **When** a request
   needs the database, **Then** the response is `503 SERVICE_UNAVAILABLE`, never `500` or
   a hang.
6. **Given** a client sends its own correlation id in a valid format, **When** the request
   is handled, **Then** the same id is used throughout. An invalid or missing one is
   replaced with a generated id.
7. **Given** a request carrying a cookie, an authorization header, a password, a token or
   a phone field, **When** it's logged, **Then** those values are redacted.
8. **Given** the error code registry, **When** the contract is generated, **Then** every
   code in the registry appears in the contract with its status, and no endpoint
   documents a code that isn't in the registry.

---

### User Story 4 - The audit trail can't be bypassed (Priority: P1)

Every audited change records who made it, as a user, the system or an operator. The
database itself refuses an audited change made without that context, and nobody using
the application's database role can edit or delete an audit entry.

**Why this priority**: Principles I and IV are database guarantees. Later slices write
their audit entries into this foundation, so it has to be right first.

**Independent Test**: As the application's database role, try to write an audit entry
without actor context, update or delete an entry, and write entries with mismatched actor
fields. Confirm each is refused, and that a valid entry rolls back with its transaction.

**Acceptance Scenarios**:

1. **Given** a transaction with no actor context, **When** it tries to make an audited
   change, **Then** the database refuses it.
2. **Given** the application's database role, **When** it tries to update or delete an
   audit entry, **Then** permission is denied.
3. **Given** an audit entry of actor type user without a user id, or of actor type
   operator without the OS user and host, **When** it's written, **Then** the database
   refuses it.
4. **Given** a transaction that writes an audit entry and then rolls back, **When** it
   ends, **Then** no entry remains.
5. **Given** the three database roles (owner, application, maintenance), **When** their
   privileges are inspected, **Then** each has exactly the privileges in ADR-0003 and
   ADR-0020. The application role owns no tables, isn't a superuser and can't disable
   triggers.

---

### User Story 5 - The first administrator exists after first start (Priority: P2)

On the very first start, the system creates one administrator from two environment
values and prints a one-time set-password link for the operator. Starting again never
creates another or prints a link again. An operator can also create more administrators
from a server command line, which is never reachable over the web.

**Why this priority**: Slice 1 needs an administrator to exist. The bootstrap's
idempotency and its single logged token are security-sensitive.

**Independent Test**: Start a fresh stack and confirm one administrator exists and one
link was printed. Restart and confirm nothing new happened. Run the create-admin command
and confirm a second administrator, a printed link and an operator audit entry.

**Acceptance Scenarios**:

1. **Given** no administrator exists and the bootstrap values are set, **When** the
   stack starts, **Then** exactly one active administrator with no password exists, and
   one set-password link is printed.
2. **Given** an administrator exists, **When** the stack starts again, **Then** nothing is
   created and no link is printed.
3. **Given** two instances start at the same moment, **When** both run the bootstrap,
   **Then** exactly one administrator is created.
4. **Given** no administrator exists and the bootstrap values are missing, or the email
   belongs to an existing non-admin user, **When** the stack starts, **Then** startup
   fails with a clear error and no user is promoted.
5. **Given** the operator runs the create-admin command with a new email, **When** it
   completes, **Then** a second administrator exists, a link is printed, and an audit
   entry records the operator's OS user and host.
6. **Given** the operator runs the create-admin command with an email already in use, or
   with invalid arguments, **When** it runs, **Then** it exits non-zero with a stable error
   code and changes nothing.
7. **Given** the route table, **When** it's inspected, **Then** no web route reaches any
   operator command.

---

### User Story 6 - Application shell for the end user (Priority: P2)

A person opening the web app sees a working shell: navigation between placeholder pages,
a not-found page, clear loading, empty and error states, and an error screen that shows a
request id to quote to support. The shared confirmation dialog and the unsaved-changes
guard are available for later slices to use. The shell meets the accessibility standard
and loads within its size budget.

**Why this priority**: Every later slice builds screens on this shell, so its patterns
must be in place and tested once.

**Independent Test**: Load the shell, navigate between pages, open an unknown address,
force an API failure, and open the confirmation dialog in a demo route. Confirm the
states and screens behave as specified and pass automated accessibility checks.

**Acceptance Scenarios**:

1. **Given** the shell is loaded, **When** the user navigates between pages, **Then** the
   address bar and the page stay in step, and an unknown address shows the not-found page.
2. **Given** a page is waiting for data, has no data, or gets an error, **When** it
   renders, **Then** it shows the loading, empty or error state. The error state shows
   the request id and offers a retry for a temporary failure.
3. **Given** a rendering failure inside a page, **When** it happens, **Then** an error
   screen replaces only that page and shows the request id. The rest of the shell keeps
   working.
4. **Given** the confirmation dialog is opened, **When** it appears, **Then** focus is on
   the safe button. Escape, the safe button and clicking outside all close it. While its
   action runs, the confirm button is disabled, so a double click sends one request. A
   server error is shown inside the dialog.
5. **Given** a form with unsaved edits, **When** the user tries to leave the page or close
   the tab, **Then** they're asked to confirm discarding the changes.
6. **Given** any shell page or the dialog, **When** automated accessibility checks run,
   **Then** they report no violations. The pages are served with a strict content
   security policy and no inline scripts.
7. **Given** the production build, **When** its size is measured, **Then** it's within the
   budget in ADR-0012.

---

### User Story 7 - Mail can be sent safely (Priority: P3)

The system can send email through one interface. Mail settings are checked at startup.
Mail is sent only after the change that caused it has been committed, so a rolled-back
change never sends anything. Locally, all mail goes to a test inbox the developer can
open.

**Why this priority**: Slice 1 sends verification and reset emails. The rules have to
hold before any email exists.

**Independent Test**: With a test mail adapter, send mail from inside a change that
commits and from one that rolls back. Confirm only the committed one is sent. Start
locally and confirm a test message reaches the local inbox.

**Acceptance Scenarios**:

1. **Given** invalid mail settings, **When** the API starts, **Then** it refuses to start.
2. **Given** a change that requests an email and commits, **When** it ends, **Then** the
   email is sent once.
3. **Given** a change that requests an email and rolls back, **When** it ends, **Then**
   nothing is sent.
4. **Given** the mail server fails, **When** an email is sent after commit, **Then** the
   failure is logged and the original request still succeeds.

---

### User Story 8 - Old data is purged on schedule (Priority: P3)

The maintenance service runs once a day with its own restricted database
credentials. It removes data that has passed its retention period, never runs twice at
the same time, and logs how much it removed.

**Why this priority**: The retention rules are legal obligations (ADR-0020). This slice
creates the job and covers the data that exists so far. Later slices add their own data
to it.

**Independent Test**: Seed audit entries and one-time tokens on both sides of their
retention limits, run the purge directly, and confirm only expired rows are removed.
Start a second run during the first and confirm it does nothing.

**Acceptance Scenarios**:

1. **Given** audit entries older and newer than 8 years, **When** the purge runs,
   **Then** only the older ones are removed.
2. **Given** one-time tokens used or expired more than 7 days ago, and newer ones,
   **When** the purge runs, **Then** only the older ones are removed.
3. **Given** a purge is running, **When** a second one starts, **Then** the second logs
   that one is already running and does nothing.
4. **Given** the application's database role, **When** it tries the purge's deletes,
   **Then** permission is denied.
5. **Given** the stack is started, **When** the smoke test checks, **Then** the
   maintenance service is running and has logged its first run.

---

### Edge Cases

- The example environment file is used as is: it must start a working local stack, with
  the test inbox and demo-seed flags set for local use only.
- A secret appears in a configuration error: the error names the setting but never
  prints its value.
- A client sends an over-long or malformed correlation id: it's replaced, never echoed.
- A request body is larger than the size limit: it's refused with a standard error
  before parsing.
- Migrations run while the API is already up (restart order): the API waits until
  migrations finish, and readiness fails until then.
- The maintenance service crashes mid-run: its run lock is released, and the next daily
  run proceeds.
- Two bootstrap runs race: the run lock lets exactly one create the administrator.
- The mail server is unreachable at startup: settings are validated for shape, but
  reachability doesn't block startup. A send failure is logged at send time.
- An unknown error code is thrown in code: it fails a registry test, so no code exists
  outside the registry.
- The repository ignore rules exist before any environment file is created, so a real
  `.env` can never be committed.

## Requirements *(mandatory)*

Each requirement traces to a row in [docs/traceability.md](../../docs/traceability.md).
"Part" means this slice delivers part of that row, and the rest lands in the slice noted.

### Functional Requirements

**Repository and startup**
- **FR-001**: The repository MUST ignore environment files (other than the example),
  dependency folders, build output and coverage output. The ignore rules MUST be in place
  before any environment file exists. *(NFR-OPS-02)*
- **FR-002**: Starting the stack with one command, using only a copy of the documented
  example environment file, MUST bring up the database, apply migrations, run the admin
  bootstrap, and start the API, the web app, the same-origin edge and the maintenance
  service. Locally, it MUST also start the test mail inbox. *(NFR-OPS-01 part — login lands in slice
  1, and the order flow in slice 6; NFR-OPS-03)*
- **FR-003**: Every service MUST validate its configuration at startup, and exit non-zero
  naming each invalid setting without printing secret values. *(NFR-OPS-02)*
- **FR-004**: In the production environment, startup MUST be refused when demo seeding is
  enabled or the mail host is the local test inbox. Each process MUST accept only its own
  database credentials and refuse to start otherwise (contracts/config.md):
  - API and CLI: only the application role's connection.
  - Maintenance: only the maintenance role's connection.
  - Migrate: the only process given the superuser and owner credentials.

  *(NFR-OPS-02, NFR-OPS-05)*
- **FR-005**: The system MUST expose a liveness check and a readiness check. Readiness
  fails when the database is unreachable or migrations are incomplete. *(NFR-OPS-02)*
- **FR-006**: Every service MUST shut down gracefully, finishing in-flight requests and
  closing database connections. *(NFR-OPS-02)*
- **FR-007**: Every variable MUST be documented in the example environment file.
  *(NFR-OPS-01)*
- **FR-040**: The API MUST expose request latency and error-rate metrics in Prometheus
  format at `/metrics`, on a separate internal-only port.
  - The compose file declares that port as reachable inside the compose network only,
    never published to the host.
  - The public edge never routes `/metrics`, and returns `404` for it.
  - Tests check that the edge returns `404` for `/metrics`, that no published port serves
    it, and that the internal port does.

  *(NFR-OPS-02)*

**Errors, logging and correlation**
- **FR-008**: Every error response MUST use the standard problem format, with a stable
  code from a single registry, a correlation id and optional field details. No `422` is
  ever returned. *(NFR-API-01, NFR-API-02)*
- **FR-009**: Input MUST be validated strictly before any business logic: malformed
  bodies, unknown fields and invalid path ids are rejected with field-level details.
  *(NFR-VAL-01 part; field rules for business entities land in their slices)*
- **FR-010**: Database and data-layer errors MUST be translated to registry codes in one
  place. Code and tests MUST branch on codes, never on message text. *(NFR-API-02)*
- **FR-011**: Pool exhaustion and transaction timeouts MUST return `503`, never `500` or
  a hang. *(NFR-CON-02)*
- **FR-012**: Every request MUST carry a correlation id: the client's if it's valid,
  otherwise a generated one. The id MUST be returned in a response header and in error
  bodies, written on every log line, and stored in audit entries. *(NFR-OPS-02)*
- **FR-013**: Logs MUST be structured, and MUST redact cookies, authorization headers,
  passwords, tokens and phone numbers. The only exception is the one-time set-password
  link printed by the bootstrap and by the create-admin command. *(NFR-OPS-02,
  NFR-PRIV-01 part)*
- **FR-014**: Security headers and a request body size limit MUST apply to every
  response. Cross-origin requests to the API MUST be refused. *(NFR-OPS-02, NFR-OPS-03)*
- **FR-015**: Every route MUST declare who may call it. A route without a declaration
  MUST fail startup and the automated checks. In this slice, only the public health and
  readiness routes exist. *(NFR-AUTH-01 part; enforcement of authentication lands in
  slice 1)*

**Database roles and audit**
- **FR-016**: The database MUST have three roles: owner (migrations), application
  (runtime) and maintenance (purges), with the privileges recorded in ADR-0003 and
  ADR-0020. *(NFR-AUD-02, NFR-OPS-05)*
- **FR-017**: The audit table MUST record the fields in ADR-0016: actor type (user,
  system or operator), actor id and snapshot, acting role, action, entity, details and
  correlation id. A database check MUST tie the actor fields to the actor type.
  *(NFR-AUD-02)*
- **FR-018**: Audited changes MUST be refused by the database when the transaction has no
  actor context. *(NFR-AUD-02)*
- **FR-019**: The application role MUST be able to insert and read audit entries, but
  never update or delete them. An entry MUST be written in the same transaction as its
  change. *(NFR-AUD-02)*

**Contract**
- **FR-020**: The API's request, response and error shapes MUST come from one schema
  source, from which the contract document is generated and committed. The automated
  checks MUST fail when the committed contract differs from the generated one.
  *(NFR-API-01)*
- **FR-021**: The automated checks MUST fail on a breaking contract change, unless the
  change is labelled breaking and explains why (ADR-0008). *(NFR-API-01)*
- **FR-022**: The web app's API client and types MUST be generated from the committed
  contract. Contract tests MUST check every response and error against it.
  *(NFR-API-01, NFR-FE-01)*

**Frontend shell**
- **FR-023**: The web app MUST provide page routing, a not-found page, and a per-page
  error boundary whose error screen shows the request id. *(NFR-FE-01 part — the
  `VERSION_CONFLICT` prompt lands in slice 3)*
- **FR-024**: Every page pattern MUST provide loading, empty and error states. Temporary
  failures (`503`) offer a retry, and errors are mapped by code to user messages.
  *(NFR-FE-01, NFR-FE-04 part)*
- **FR-025**: The web app MUST provide one shared confirmation dialog that meets ADR-0018:
  named action, stated consequence, safe-button focus, Escape and outside-click close,
  disabled while pending, an optional required reason, and errors shown inside.
  *(NFR-FE-09 part; each dialog's content lands with its slice)*
- **FR-026**: The web app MUST provide an unsaved-changes guard for in-app navigation and
  tab close. *(NFR-FE-09 part)*
- **FR-027**: Every shell page and the dialog MUST pass automated accessibility checks
  (WCAG 2.1 AA). The app MUST be served with a strict content security policy and render
  no raw HTML. *(NFR-FE-05)*
- **FR-028**: The production build MUST stay within the bundle budget in ADR-0012, and
  the automated checks MUST fail when it doesn't. *(NFR-FE-06 part)*
- **FR-041**: The web app MUST support the latest 2 versions of Chrome, Edge, Firefox and
  Safari, and the build MUST target them.
  - End-to-end tests run on Chromium for every pull request.
  - They run on Chromium, Firefox and WebKit nightly and on every push to `main`. A
    nightly failure is treated like a failed check on `main`.

  *(NFR-FE-07, NFR-FE-05)*

**Mail**
- **FR-029**: The system MUST send mail through one interface, with mail settings
  validated at startup and a test capture adapter. *(NFR-OPS-04)*
- **FR-030**: Mail MUST be sent only after the causing transaction commits. A rollback
  sends nothing, and a send failure is logged without failing the request. *(NFR-OPS-04)*
- **FR-031**: Locally, the test mail inbox MUST run only under the local profile.
  *(NFR-OPS-04)*

**Bootstrap and operator CLI**
- **FR-032**: On startup, if no administrator exists, the bootstrap MUST create exactly
  one active administrator with no password from the two bootstrap settings, and print
  one set-password link. Only one run can proceed at a time, and it is idempotent. It MUST fail
  startup, promoting nobody, when the settings are missing or the email belongs to a
  non-admin user. *(FR-ADM-04)*
- **FR-033**: The operator command line MUST run on the server only, never over HTTP.
  It MUST use the same one-run-at-a-time lock, stable error codes and exit-code rules as ADR-0016,
  and audit with actor type operator, including OS user and host. *(FR-ADM-05 part)*
- **FR-034**: The command line MUST provide `admin:create`, with the rules in ADR-0016.
  *(FR-ADM-05 part; `admin:deactivate` and `admin:reactivate` land in slice 1 with
  sessions, and `policy:set` and `policy:show` in slice 4 with the policy)*
- **FR-035**: Set-password links MUST use one-time tokens stored only as hashes, single
  use, valid 30 minutes. *(FR-ACC-03 part; verification tokens land in slice 1)*

**Maintenance**
- **FR-036**: The maintenance service MUST run the purge once at start and then daily,
  with the maintenance credentials, with only one run at a time, logging counts per table.
  *(NFR-OPS-05 part)*
- **FR-037**: The purge MUST remove audit entries older than 8 years and one-time tokens
  used or expired more than 7 days ago. *(NFR-OPS-05 part; sessions and phones land in
  slice 1, idempotency keys in slice 3)*

**Automated checks**
- **FR-038**: The automated checks MUST run on GitHub Actions for every pull request to
  `main` and every push to `main`, and MUST be required to pass before a merge:
  - lint, typecheck and the requirement-ID ban
  - unit and integration tests against a real database
  - migrations applied from empty
  - contract drift and breaking-change checks
  - the traceability check
  - the dependency audit
  - the frontend checks (accessibility, bundle budget)
  - the stack smoke test
  - secret scanning: the pull request's diff, and the full history on `main`

  Because the repository is public:
  - CI MUST never use `pull_request_target`.
  - Secrets come only from GitHub Actions secrets, and no check may need one. Pull requests
    from forks pass using generated throwaway values.
  - `.env.example` MUST hold placeholder values only.

  *(NFR-DEV-01, NFR-OPS-01, NFR-OPS-02)*
- **FR-039**: The traceability check MUST fail when:
  - a test cites an ID that isn't in the matrix
  - a `docs/BRIEF.md` section has no row
  - a row marked `Tested` has no test carrying its ID
  - a row marked `Done` has no passing test

  *(NFR-DEV-01)*

### Key Entities

- **Audit entry**: one immutable record of a change. It holds when it happened, who acted
  (a user with a name and email snapshot, the system, or an operator with OS user and
  host), in what capacity, what happened to which entity, the details, and the request's
  correlation id.
- **User** (minimal in this slice): name, email, role set, status, and no password. It
  exists so the bootstrap can create the administrator. Slice 1 completes it.
- **One-time token**: a single-use, hashed token with a purpose and an expiry. In this
  slice it is used only for set-password links.
- **Error code**: a registry entry with a stable code, its HTTP status and its meaning,
  shared by the API, the contract and the web app.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From a clean checkout, a new developer reaches a fully running, healthy
  system in under 10 minutes, using one command after copying the example environment
  file.
- **SC-002**: 100% of error responses produced by the test suite use the standard shape
  and carry a registered code and a correlation id that matches the logs.
- **SC-003**: Across the whole test suite, zero log lines contain a secret, token, password
  or phone number. The only exceptions are the bootstrap and create-admin links.
- **SC-004**: Each deliberately broken check (style, types, ID ban, migration, contract
  drift, breaking change, traceability, accessibility, bundle budget, smoke test, and a
  committed fake secret) fails its automated check every time.
- **SC-005**: Every attempt to bypass the audit trail through the application's database
  role (no actor context, update, delete, mismatched actor fields) is refused.
- **SC-006**: Restarting the stack 10 times creates exactly one administrator and prints
  exactly one set-password link.
- **SC-007**: Every shell page and the confirmation dialog have zero automated
  accessibility violations.
- **SC-008**: The full set of automated checks finishes in under 15 minutes, so a
  developer gets feedback on every change the same working session.

## Assumptions

- **Scope of the operator CLI skeleton**: the framework plus `admin:create`, which shares
  the bootstrap's logic. `admin:deactivate` and `admin:reactivate` need sessions, so they
  land in slice 1. `policy:set` and `policy:show` need the policy table, so they land in
  slice 4.
- **Minimal user record**: slice 0 creates only what the bootstrap needs. Signup,
  verification, roles management and login are slice 1. The test that a password-less
  administrator can't log in therefore runs in slice 1.
- **Traceability check during early slices**: rows marked `Todo` or `Spec` aren't checked
  for tests. `Tested` (written, failing) needs at least one test with the ID, and `Done`
  needs a passing one. A row this slice delivers only in part stays below `Done` until its
  last part lands. Recorded in ADR-0013.
- **No business seed data**: the approval policy seed belongs to slice 4, and demo users
  to slice 1. The demo-seed flag exists and is validated from this slice on.
- **Demo shell route**: the confirmation dialog and the page states are exercised through
  a development-only demo route, not in production builds.
- **Mail reachability**: the mail server's reachability is not checked at startup, only
  the settings' shape (see Edge Cases).

## Dependencies

- The binding decisions in ADR-0003, ADR-0007, ADR-0008, ADR-0013, ADR-0016, ADR-0017
  (mail section), ADR-0018 and ADR-0020.
- No earlier slice. Slice 1 depends on this slice's users table, one-time tokens, mail
  adapter, error registry and shell.
