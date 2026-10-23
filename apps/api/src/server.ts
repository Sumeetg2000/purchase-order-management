import express from 'express';

// Placeholder entry point. Configuration validation (T027), routes and graceful
// shutdown (T029) replace the direct environment read below.
const app = express();
const port = Number(process.env['HTTP_PORT'] ?? 3000);

app.listen(port, () => {
  process.stdout.write(`api listening on ${String(port)}\n`);
});
