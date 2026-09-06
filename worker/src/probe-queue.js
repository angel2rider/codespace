import { DurableObject } from "cloudflare:workers";

// Durable Object: strongly consistent probe job queue + result store.
//
// This replaced Workers KV because KV's eventual consistency (up to ~60s of
// stale reads across colos) made the VPS agent miss jobs entirely and made
// result reads arbitrarily slow. DO SQLite storage is read-your-writes
// consistent everywhere, so job handoff is instant and race-free.
//
// The agent holds a WebSocket to this DO; new jobs are PUSHED over it
// immediately. The REST claim endpoint exists as a polling fallback for
// when the socket is down. (Long-polling inside the DO itself is not
// possible: input gates would block the whole object while waiting.)
export class ProbeQueue extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    ctx.blockConcurrencyWhile(() => {
      ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, url TEXT, created_at INTEGER, claimed INTEGER DEFAULT 0)"
      );
      ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS results (nonce TEXT PRIMARY KEY, payload TEXT, created_at INTEGER, id TEXT)"
      );
      try {
        ctx.storage.sql.exec("ALTER TABLE results ADD COLUMN id TEXT");
      } catch {
        // Column already exists.
      }
    });
  }

  // Agent WebSocket upgrade. Auth via ?secret= (headers aren't settable from
  // the browser-free native WebSocket client).
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Not found", { status: 404 });
    }
    const url = new URL(request.url);
    if (url.searchParams.get("secret") !== this.env.WORKER_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // Queue a probe job and push it to any connected agent. Returns the nonce
  // the UI/result endpoint keys on.
  async enqueue(url) {
    const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    this.ctx.storage.sql.exec(
      "INSERT INTO jobs (id, url, created_at) VALUES (?, ?, ?)",
      nonce,
      url,
      Date.now()
    );
    const job = JSON.stringify({ type: "job", url, nonce });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(job);
      } catch {
        // Socket died between accept and send; the claim fallback covers it.
      }
    }
    this.#cleanup();
    return { nonce };
  }

  // REST fallback: hand out the oldest unclaimed job (or null). Claiming
  // marks it so no other consumer can take it.
  async claim() {
    const rows = [...this.ctx.storage.sql.exec(
      "SELECT id, url FROM jobs WHERE claimed = 0 ORDER BY created_at LIMIT 1"
    )];
    if (!rows.length) return null;
    this.ctx.storage.sql.exec("UPDATE jobs SET claimed = 1 WHERE id = ?", rows[0].id);
    return { url: rows[0].url, nonce: rows[0].id };
  }

  // Agent posts the finished probe here. Also used for error payloads.
  // Successful results are cached by video id, so re-probing the same video
  // within the retention window returns instantly.
  async submit(nonce, payload) {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO results (nonce, payload, created_at, id) VALUES (?, ?, ?, ?)",
      nonce,
      JSON.stringify(payload),
      Date.now(),
      payload.id || null
    );
    this.ctx.storage.sql.exec("DELETE FROM jobs WHERE id = ?", nonce);
  }

  // Return the cached nonce for a video id (or null).
  async cachedNonce(id) {
    if (!id) return null;
    const rows = [...this.ctx.storage.sql.exec(
      "SELECT nonce FROM results WHERE id = ? ORDER BY created_at DESC LIMIT 1",
      id
    )];
    return rows.length ? rows[0].nonce : null;
  }

  // UI polls this until the result shows up.
  async read(nonce) {
    const rows = [...this.ctx.storage.sql.exec(
      "SELECT payload FROM results WHERE nonce = ?",
      nonce
    )];
    if (!rows.length) return { ready: false };
    return { ready: true, ...JSON.parse(rows[0].payload) };
  }

  #cleanup() {
    // Jobs are ephemeral (10 min); results live 1 h for late UI polls.
    this.ctx.storage.sql.exec(
      "DELETE FROM jobs WHERE created_at < ?",
      Date.now() - 600_000
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM results WHERE created_at < ?",
      Date.now() - 3_600_000
    );
  }
}
