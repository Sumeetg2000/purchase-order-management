import { createApp } from './http/app.js';

// Configuration validation (T027), health routes (T028) and graceful shutdown (T029)
// replace the direct environment read below.
const app = createApp({ routes: [] });
const port = Number(process.env['HTTP_PORT'] ?? 3000);

app.listen(port, () => {
  process.stdout.write(`api listening on ${String(port)}\n`);
});
