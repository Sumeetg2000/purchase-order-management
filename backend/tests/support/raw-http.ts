import http from 'node:http';
import net from 'node:net';
import type { Express } from 'express';

// A raw HTTP client for body-limit tests (slice 3 research R8): it declares a large body,
// writes only part of it (or streams it chunked), and reports what came back and whether
// the server closed the connection, so a test can prove a refusal arrived without the
// server reading the body. The server side counts the bytes each socket read.

export interface RawServer {
  port: number;
  /** Bytes read by the server on the connection most recently opened. */
  lastBytesRead: () => number;
  close: () => Promise<void>;
}

export async function listen(app: Express): Promise<RawServer> {
  const server = http.createServer(app);
  const sockets: net.Socket[] = [];
  server.on('connection', (socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    lastBytesRead: () => sockets.at(-1)?.bytesRead ?? 0,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** The server closed the connection (FIN or reset) after answering. */
  closed: boolean;
  /** Bytes the client managed to write before the answer and the close. */
  written: number;
}

interface RawRequest {
  method: 'POST' | 'PATCH';
  path: string;
  headers: Record<string, string>;
  /** Declared with Content-Length, of which only `sendBytes` are written. */
  contentLength?: number;
  sendBytes?: number;
  /** Instead: a chunked body of this many bytes, written in 64 KiB chunks. */
  chunkedBytes?: number;
}

function parse(raw: string): Pick<RawResponse, 'status' | 'headers' | 'body'> | undefined {
  const end = raw.indexOf('\r\n\r\n');
  if (end < 0) return undefined;
  const [statusLine = '', ...lines] = raw.slice(0, end).split('\r\n');
  const status = Number(statusLine.split(' ')[1]);
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status, headers, body: raw.slice(end + 4) };
}

/** Sends `request` over a fresh connection and waits for the answer and the close. */
export function rawRequest(port: number, request: RawRequest): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let received = '';
    let written = 0;
    let closed = false;
    let answered = false;
    const timer = setTimeout(() => {
      socket.destroy();
      finish();
    }, 5_000);

    function finish() {
      clearTimeout(timer);
      const parsed = parse(received);
      if (!parsed) {
        reject(
          new Error(`no response (closed: ${String(closed)}, wrote ${String(written)} bytes)`),
        );
        return;
      }
      resolve({ ...parsed, closed, written });
    }

    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
      if (parse(received)) answered = true;
    });
    // A reset after the answer is how a server refuses an unread body; keep the answer.
    socket.on('error', () => undefined);
    socket.on('close', () => {
      closed = true;
      finish();
    });

    const head = [
      `${request.method} ${request.path} HTTP/1.1`,
      'Host: 127.0.0.1',
      'Content-Type: application/json',
      ...Object.entries(request.headers).map(([k, v]) => `${k}: ${v}`),
      request.chunkedBytes === undefined
        ? `Content-Length: ${String(request.contentLength ?? 0)}`
        : 'Transfer-Encoding: chunked',
      '',
      '',
    ].join('\r\n');

    socket.on('connect', () => {
      socket.write(head);
      if (request.chunkedBytes === undefined) {
        const part = Buffer.alloc(request.sendBytes ?? 0, 0x20);
        written += part.length;
        socket.write(part);
        return;
      }
      // A valid JSON object, padded with spaces, streamed until the server answers.
      const total = request.chunkedBytes;
      const opening = Buffer.from('{"name":"x"');
      let sent = 0;
      const chunkSize = 64 * 1024;
      const writeNext = () => {
        if (answered || closed || socket.destroyed) return;
        if (sent >= total) {
          socket.write('1\r\n}\r\n0\r\n\r\n');
          return;
        }
        const size = Math.min(chunkSize, total - sent);
        const data =
          sent === 0
            ? Buffer.concat([opening, Buffer.alloc(size - opening.length, 0x20)])
            : Buffer.alloc(size, 0x20);
        sent += size;
        written += size;
        const ok =
          socket.write(`${size.toString(16)}\r\n`) && socket.write(data) && socket.write('\r\n');
        if (ok) setImmediate(writeNext);
        else socket.once('drain', writeNext);
      };
      writeNext();
    });
  });
}
