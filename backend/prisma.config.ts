import { defineConfig } from 'prisma/config';

// The datasource is configured only when OWNER_DATABASE_URL is present, which is true
// only in the migrate step. `prisma generate` at build time needs no database.
const url = process.env['OWNER_DATABASE_URL'];

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  ...(url ? { datasource: { url } } : {}),
});
