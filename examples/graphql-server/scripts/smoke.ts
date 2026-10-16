// End-to-end smoke test: starts `bun src/main.ts` as a child process and talks to it over the
// real network with fetch, a graphql-transport-ws WebSocket and a raw TCP upgrade request.
// Usage: bun scripts/smoke.ts (set REDIS_URL to exercise RedisPubSub).
import { createConnection, createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const RATE_LIMIT = 40;
const FRONTEND = 'http://localhost:5173';
const root = fileURLToPath(new URL('..', import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no port')),
      );
    });
  });
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const output: string[] = [];
const child = Bun.spawn(['bun', 'src/main.ts'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'development',
    RATE_LIMIT: String(RATE_LIMIT),
    CORS_ORIGINS: FRONTEND,
  },
  stdout: 'pipe',
  stderr: 'pipe',
});
for (const stream of [child.stdout, child.stderr]) {
  void (async () => {
    for await (const chunk of stream) output.push(new TextDecoder().decode(chunk));
  })();
}
const stop = () => child.kill('SIGTERM');
process.on('SIGINT', () => {
  stop();
  process.exit(130);
});

let failures = 0;
/** Runs one check; a string result is printed as detail. */
async function check(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const detail = await fn();
    console.log(`PASS  ${name}${typeof detail === 'string' ? `  (${detail})` : ''}`);
  } catch (error) {
    failures++;
    console.log(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface GqlBody {
  data?: any;
  errors?: { message: string; extensions?: { code?: string } }[];
}

async function gql(query: string, variables?: object, token?: string) {
  const res = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  return { res, body: (await res.json()) as GqlBody };
}

async function waitForReady(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await Bun.sleep(100);
  }
  throw new Error('server did not become ready');
}

/** Opens a graphql-transport-ws socket, authenticates with connectionParams and subscribes. */
function subscribe(query: string, variables: object, token: string) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/graphql`, 'graphql-transport-ws');
  const events: GqlBody[] = [];
  const ready = new Promise<void>((resolve, reject) => {
    ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init', payload: { token } }));
    ws.onerror = () => reject(new Error('WebSocket error'));
    ws.onclose = (e) => reject(new Error(`WebSocket closed: ${e.code} ${e.reason}`));
    ws.onmessage = (message) => {
      const msg = JSON.parse(String(message.data)) as { type: string; payload?: GqlBody };
      if (msg.type === 'connection_ack') {
        ws.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query, variables } }));
        resolve();
      } else if (msg.type === 'next' && msg.payload) events.push(msg.payload);
      else if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    };
  });
  return { ws, events, ready };
}

/** Sends a WebSocket upgrade over raw TCP and returns the HTTP status line. */
function rawUpgrade(origin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(
        [
          'GET /graphql HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Protocol: graphql-transport-ws',
          `Origin: ${origin}`,
          '',
          '',
        ].join('\r\n'),
      );
    });
    socket.setTimeout(5000, () => socket.destroy(new Error('timeout')));
    socket.once('data', (data) => {
      resolve(data.toString().split('\r\n')[0] ?? '');
      socket.destroy();
    });
    socket.once('error', reject);
  });
}

try {
  await waitForReady();
  let pubsub = 'unknown';

  await check('GET /health', async () => {
    const res = await fetch(`${base}/health`);
    const body = (await res.json()) as { status: string; pubsub: string };
    assert(res.status === 200 && body.status === 'ok', `got ${res.status} ${JSON.stringify(body)}`);
    pubsub = body.pubsub;
    const expected = process.env.REDIS_URL ? 'redis' : 'memory';
    assert(pubsub === expected, `pubsub is ${pubsub}, expected ${expected}`);
    return `pubsub=${pubsub}`;
  });

  await check('query with batched nested authors', async () => {
    const { body } = await gql('{ posts(status: PUBLISHED) { title author { name } } }');
    assert(!body.errors, JSON.stringify(body.errors));
    assert(body.data.posts.length === 3, `got ${body.data.posts.length} posts`);
    assert(body.data.posts[1].author.name === 'Grace Hopper', 'wrong author');
    return `${body.data.posts.length} posts`;
  });

  await check('mutation without a token is UNAUTHENTICATED', async () => {
    const { body } = await gql('mutation { publishPost(id: "p4") { id } }');
    const code = body.errors?.[0]?.extensions?.code;
    assert(code === 'UNAUTHENTICATED', `got ${code}`);
  });

  await check('authenticated mutation', async () => {
    const { body } = await gql(
      'mutation($i: CreatePostInput!) { createPost(input: $i) { id title body author { id } } }',
      { i: { title: ' Smoke ', body: '<p>ok</p><script>x</script>' } },
      'grace-token',
    );
    assert(!body.errors, JSON.stringify(body.errors));
    const post = body.data.createPost;
    assert(post.title === 'Smoke' && post.body === '<p>ok</p>', JSON.stringify(post));
    assert(post.author.id === 'a2', 'wrong author');
    return `created ${post.id}`;
  });

  await check('playground HTML with its own CSP (development)', async () => {
    const res = await fetch(`${base}/graphql`, { headers: { accept: 'text/html' } });
    const html = await res.text();
    const csp = res.headers.get('content-security-policy') ?? '';
    assert(res.status === 200, `status ${res.status}`);
    assert(res.headers.get('content-type')?.startsWith('text/html'), 'not HTML');
    assert(/<html/i.test(html), 'no <html> in body');
    assert(csp.includes("script-src 'self'") && csp.includes('cdn.jsdelivr.net'), csp);
    assert(csp.includes("'sha256-"), 'no inline script hash in CSP');
  });

  await check('introspection is on in development', async () => {
    const { body } = await gql('{ __type(name: "PostStatus") { enumValues { name } } }');
    const names = body.data?.__type?.enumValues?.map((v: { name: string }) => v.name);
    assert(names?.join() === 'DRAFT,PUBLISHED', JSON.stringify(body));
  });

  await check('security headers on /graphql', async () => {
    const { res } = await gql('{ __typename }');
    const expected: Record<string, string> = {
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    };
    for (const [name, value] of Object.entries(expected)) {
      assert(res.headers.get(name) === value, `${name}: ${res.headers.get(name)}`);
    }
    const csp = res.headers.get('content-security-policy') ?? '';
    assert(csp.includes("default-src 'self'"), `csp: ${csp}`);
  });

  await check('CORS preflight on /graphql', async () => {
    const res = await fetch(`${base}/graphql`, {
      method: 'OPTIONS',
      headers: {
        origin: FRONTEND,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, authorization',
      },
    });
    assert(res.status === 204, `status ${res.status}`);
    assert(res.headers.get('access-control-allow-origin') === FRONTEND, 'allow-origin');
    assert(res.headers.get('access-control-allow-credentials') === 'true', 'allow-credentials');
    const methods = res.headers.get('access-control-allow-methods') ?? '';
    assert(methods.includes('POST'), `allow-methods: ${methods}`);
    assert(res.headers.get('x-frame-options') === 'DENY', 'no security headers on preflight');
  });

  await check('subscription receives an event triggered over HTTP', async () => {
    const sub = subscribe(
      'subscription($a: ID) { postPublished(authorId: $a) { title author { name } } }',
      { a: 'a2' },
      'ada-token',
    );
    try {
      await sub.ready;
      // The subscription registers just after connection_ack (and a Redis SUBSCRIBE takes a
      // round trip), so publish until the first event arrives. Ada's posts must be filtered out.
      for (let i = 1; i <= 10 && sub.events.length === 0; i++) {
        await gql(
          'mutation($i: CreatePostInput!) { createPost(input: $i) { id } }',
          { i: { title: `By Ada ${i}`, body: 'x', publish: true } },
          'ada-token',
        );
        await gql(
          'mutation($i: CreatePostInput!) { createPost(input: $i) { id } }',
          { i: { title: `By Grace ${i}`, body: 'x', publish: true } },
          'grace-token',
        );
        await Bun.sleep(50);
      }
      const event = sub.events[0];
      assert(event, 'no event received');
      assert(!event.errors, JSON.stringify(event.errors));
      const post = event.data.postPublished;
      assert(post.author.name === 'Grace Hopper', `filter failed: ${JSON.stringify(post)}`);
      return `got "${post.title}" via ${pubsub}`;
    } finally {
      sub.ws.close();
    }
  });

  await check('subscription without a token is closed with 4403', async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/graphql`, 'graphql-transport-ws');
    const code = await new Promise<number>((resolve, reject) => {
      ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init', payload: {} }));
      ws.onclose = (e) => resolve(e.code);
      ws.onerror = () => reject(new Error('WebSocket error'));
    });
    assert(code === 4403, `close code ${code}`);
  });

  await check('cross-origin WebSocket upgrade is rejected with 403', async () => {
    const evil = await rawUpgrade('https://evil.example');
    assert(evil.includes(' 403 '), `evil origin: ${evil}`);
    const allowed = await rawUpgrade(FRONTEND);
    assert(allowed.includes(' 101 '), `allowed origin: ${allowed}`);
    return `${evil.trim()}; allowed origin: ${allowed.trim()}`;
  });

  await check(`rate limit answers 429 after ${RATE_LIMIT} requests per minute`, async () => {
    for (let i = 0; i <= RATE_LIMIT; i++) {
      const res = await fetch(`${base}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ __typename }' }),
      });
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after'));
        assert(retryAfter > 0, 'no Retry-After');
        assert(res.headers.get('x-frame-options') === 'DENY', 'no security headers on 429');
        return `429 after ${i} more requests, Retry-After ${retryAfter}s`;
      }
      assert(res.status === 200, `unexpected status ${res.status}`);
    }
    throw new Error('never rate limited');
  });

  await check('/health is not rate limited', async () => {
    const res = await fetch(`${base}/health`);
    assert(res.status === 200, `status ${res.status}`);
  });
} catch (error) {
  failures++;
  console.log(`FAIL  smoke setup: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  stop();
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  const code = await child.exited;
  clearTimeout(timer);
  if (failures > 0) {
    console.log('\n--- server output ---');
    console.log(output.join(''));
  }
  console.log(
    failures === 0
      ? `\nsmoke: all checks passed (server exited ${code})`
      : `\nsmoke: ${failures} check(s) failed`,
  );
}
process.exit(failures === 0 ? 0 : 1);
