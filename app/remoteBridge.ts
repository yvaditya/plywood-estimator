import { networkInterfaces } from 'node:os';
import multicastDns from 'multicast-dns';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';

/**
 * Shop remote: the desktop app publishes its current job here and phones on
 * the same network read it and send edits back. The desktop stays the single
 * source of truth for parts and plans; the bridge only relays. Build progress
 * (cut / assembled ticks) lives here so it survives a desktop reload.
 */
type Role = 'desk' | 'phone';
interface Client { res: ServerResponse; role: Role }

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const MAX_BODY = 256 * 1024 * 1024;
/** Friendly LAN name answered over mDNS (phones resolve *.local natively). */
export const REMOTE_HOSTNAME = 'woodworking.local';

/** Real LAN adapters first; virtual switches (WSL, Hyper-V, VPNs) last. */
export function lanAddresses(): string[] {
  const found: { address: string; rank: number }[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      const virtual = /vethernet|wsl|virtual|vmware|vbox|hyper-v|docker|tailscale|zerotier|loopback/i.test(name);
      const privateRange = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address);
      found.push({ address: a.address, rank: (virtual ? 2 : 0) + (privateRange ? 0 : 1) });
    }
  }
  return found.sort((x, y) => x.rank - y.rank).map(f => f.address);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

export function remoteBridge(): Plugin {
  let job: string | null = null;
  let jobRev = 0;
  let models: string | null = null;
  let modelsRev = '';
  let progress: Record<string, { cut?: boolean; assembled?: boolean }> = {};
  const clients = new Set<Client>();

  const send = (role: Role | 'all', event: string, data: unknown) => {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) if (role === 'all' || c.role === role) c.res.write(line);
  };
  const presence = () => {
    const phones = [...clients].filter(c => c.role === 'phone').length;
    const desk = [...clients].some(c => c.role === 'desk');
    send('all', 'presence', { phones, desk });
  };

  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!url.pathname.startsWith('/__remote/')) return next();
    const route = url.pathname.slice('/__remote/'.length);
    const local = LOOPBACK.has(req.socket.remoteAddress ?? '');
    void (async () => {
      try {
        if (req.method === 'GET' && route === 'info') {
          return json(res, 200, { addresses: lanAddresses(), hostname: REMOTE_HOSTNAME, port: req.socket.localPort, local });
        }
        if (req.method === 'GET' && route === 'events') {
          // Only the machine running the app may act as the desktop.
          const role: Role = url.searchParams.get('role') === 'desk' && local ? 'desk' : 'phone';
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
          res.write(`event: hello\ndata: ${JSON.stringify({ rev: jobRev, modelsRev, progress })}\n\n`);
          const client = { res, role };
          clients.add(client);
          const ping = setInterval(() => res.write(': ping\n\n'), 20000);
          req.on('close', () => { clearInterval(ping); clients.delete(client); presence(); });
          presence();
          return;
        }
        if (req.method === 'GET' && route === 'job') {
          if (!job) return json(res, 404, { error: 'No job published yet. Open the app on the computer.' });
          return json(res, 200, `{"rev":${jobRev},"job":${job}}`);
        }
        if (req.method === 'GET' && route === 'models') {
          if (!models) return json(res, 404, { error: 'No 3D models published yet.' });
          return json(res, 200, `{"rev":${JSON.stringify(modelsRev)},"models":${models}}`);
        }
        if (req.method === 'POST' && route === 'job') {
          if (!local) return json(res, 403, { error: 'Only the desktop app can publish.' });
          const text = await readBody(req);
          JSON.parse(text);
          job = text; jobRev++;
          send('all', 'job', { rev: jobRev });
          return json(res, 200, { rev: jobRev });
        }
        if (req.method === 'POST' && route === 'models') {
          if (!local) return json(res, 403, { error: 'Only the desktop app can publish.' });
          const rev = url.searchParams.get('rev') ?? '';
          const text = await readBody(req);
          JSON.parse(text);
          models = text; modelsRev = rev;
          send('all', 'models', { rev: modelsRev });
          return json(res, 200, { rev: modelsRev });
        }
        if (req.method === 'POST' && route === 'progress') {
          const body = JSON.parse(await readBody(req)) as { key?: unknown; field?: unknown; value?: unknown };
          if (typeof body.key !== 'string' || (body.field !== 'cut' && body.field !== 'assembled')) return json(res, 400, { error: 'Bad progress update.' });
          progress[body.key] = { ...progress[body.key], [body.field]: body.value === true };
          send('all', 'progress', progress);
          return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && route === 'progress-reset') {
          progress = {};
          send('all', 'progress', progress);
          return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && route === 'command') {
          if (![...clients].some(c => c.role === 'desk')) return json(res, 409, { error: 'The computer is not connected. Open the app on the computer.' });
          const command = JSON.parse(await readBody(req));
          send('desk', 'command', command);
          return json(res, 200, { ok: true });
        }
        json(res, 404, { error: 'Unknown remote route.' });
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  };

  /** Answer A queries for REMOTE_HOSTNAME with this machine's LAN address. */
  let mdns: ReturnType<typeof multicastDns> | null = null;
  const advertise = (httpServer: { once(event: 'close', cb: () => void): unknown } | null) => {
    if (mdns) return;
    try {
      mdns = multicastDns();
      mdns.on('query', query => {
        if (!query.questions.some(q => q.name.toLowerCase() === REMOTE_HOSTNAME && (q.type === 'A' || q.type === 'ANY'))) return;
        const answers = lanAddresses().map(data => ({ name: REMOTE_HOSTNAME, type: 'A' as const, ttl: 120, data }));
        if (answers.length) mdns?.respond({ answers });
      });
      mdns.on('error', err => console.warn(`[shop remote] mDNS unavailable: ${err.message}`));
      httpServer?.once('close', () => { mdns?.destroy(); mdns = null; });
    } catch (err) {
      console.warn(`[shop remote] mDNS unavailable: ${err instanceof Error ? err.message : err}`);
    }
  };

  return {
    name: 'shop-remote-bridge',
    configureServer(server) { server.middlewares.use(middleware); advertise(server.httpServer); },
    configurePreviewServer(server) { server.middlewares.use(middleware); advertise(server.httpServer); },
  };
}
