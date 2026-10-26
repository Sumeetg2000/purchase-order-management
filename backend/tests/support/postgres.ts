// Shared test database settings. Same major and minor as compose (research R1).
export const POSTGRES_IMAGE = 'postgres:17.11';
export const TEMPLATE_DATABASE = 'po_template';

// Throwaway credentials for the test container only.
export const TEST_PASSWORDS = {
  superuser: 'test-superuser-password',
  owner: 'test-owner-password',
  app: 'test-app-password',
  maintenance: 'test-maintenance-password',
} as const;

export interface PostgresConnection {
  host: string;
  port: number;
}

declare module 'vitest' {
  export interface ProvidedContext {
    postgres: PostgresConnection;
  }
}

export function roleUrl(
  connection: PostgresConnection,
  role: 'postgres' | 'po_owner' | 'po_app' | 'po_maintenance',
  database: string,
): string {
  const password = {
    postgres: TEST_PASSWORDS.superuser,
    po_owner: TEST_PASSWORDS.owner,
    po_app: TEST_PASSWORDS.app,
    po_maintenance: TEST_PASSWORDS.maintenance,
  }[role];
  return `postgresql://${role}:${password}@${connection.host}:${String(connection.port)}/${database}`;
}
