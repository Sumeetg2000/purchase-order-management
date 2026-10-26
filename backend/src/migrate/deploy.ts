import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const API_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Step 2 of migrate: `prisma migrate deploy` as po_owner (research R7, R8). */
export async function deployMigrations(ownerUrl: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('npx', ['--no-install', 'prisma', 'migrate', 'deploy'], {
      cwd: API_ROOT,
      env: { ...process.env, OWNER_DATABASE_URL: ownerUrl },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`prisma migrate deploy exited with code ${String(code)}`));
    });
  });
}
