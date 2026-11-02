# Vendor & Purchase Order Management

A proof of concept for raising purchase orders against a shared vendor list, routing them
for approval above a threshold, recording goods receipts per line, and reporting
outstanding orders by vendor and age. Totals and outstanding quantities are derived and
can't drift on any code path. Node and TypeScript (Express, Prisma, PostgreSQL) for the
API, React for the web app, all run with Docker Compose.

## Prerequisites

- Docker with Compose v2
- For development: Node 24 and npm (see `.nvmrc`)

## Run it

```sh
cp .env.example .env
docker compose up
```

Open <http://localhost:8080>. On the first start, the `migrate` service creates the first
administrator from `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_NAME` and prints a one-time
set-password link, once, valid 30 minutes:

```sh
docker compose logs migrate | grep oneTimeLink
```

More admins: `docker compose exec api npm run admin -- admin:create --email <email> --name "<name>"`.
Troubleshooting (including snap-packaged Docker) is in the
[quickstart](specs/001-foundation/quickstart.md).

## Develop

```sh
npm ci          # installs dependencies and the git hooks
npm test        # all tests; integration tests start PostgreSQL in Docker
npm run lint
npm run typecheck
npm run dev     # API reload + Vite HMR on one origin (lands later in slice 0)
```

`npm ci` installs a [lefthook](lefthook.yml) pre-commit hook that runs gitleaks on the
staged changes (the same pinned image as CI) and Prettier and ESLint on the staged files.
A test-first commit, whose test imports code that doesn't exist yet, skips only ESLint:
`LEFTHOOK_EXCLUDE=eslint git commit ...`.

## Documents

- [The brief](docs/BRIEF.md): the requirements
- [Architecture decisions](docs/adr/README.md)
- [Current slice: foundation](specs/001-foundation/) (spec, plan, tasks)
- [Traceability](docs/traceability.md): brief clause → requirement → tests
- [Working agreement](CLAUDE.md)
