/**
 * OAuth 2.1 client for the Silo control plane — the same flow the backend
 * serves to every MCP client (ChatGPT, Claude, Cursor): RFC 8414 discovery,
 * Dynamic Client Registration, authorization_code + PKCE, refresh_token.
 * MCP IS OAuth — the agent authenticates exactly like any other MCP client,
 * which is what makes it show up as a connection in the Silo dashboard.
 *
 * Headless pairing: `npm run connect` prints the authorize URL; the agent's
 * human sponsor approves once in a browser (the loopback redirect catches
 * the code), and from then on the refresh token keeps the agent alive.
 *
 * DCR metadata: client_name "Buzz Agent (@handle)" and client_uri
 * "https://buzz.xyz" identify the connection as a Buzz agent in the
 * dashboard's connections page.
 */

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export interface OAuthConfig {
  /** Control-plane origin, e.g. https://api.onesilo.com */
  serverUrl: string;
  /** Agent handle, used in client_name so the dashboard shows who this is. */
  agentHandle: string;
  /** Where tokens + client registration persist across runs. */
  tokenPath: string;
  /** Loopback port for the one-time authorization redirect. */
  callbackPort?: number;
}

interface ServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
}

interface StoredCredentials {
  client_id: string;
  client_secret?: string;
  access_token?: string;
  refresh_token?: string;
}

export const BUZZ_CLIENT_URI = "https://buzz.xyz";

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class SiloOAuthClient {
  private creds?: StoredCredentials;
  private metadata?: ServerMetadata;

  constructor(private readonly config: OAuthConfig) {
    if (existsSync(config.tokenPath)) {
      this.creds = JSON.parse(readFileSync(config.tokenPath, "utf8"));
    }
  }

  get isPaired(): boolean {
    return Boolean(this.creds?.refresh_token || this.creds?.access_token);
  }

  /**
   * False when pairing is degraded: only an access token is stored, so the
   * agent works until it expires and then needs a manual re-pair. Callers
   * should warn at startup rather than fail later.
   */
  get canRefresh(): boolean {
    return Boolean(this.creds?.refresh_token);
  }

  private persist(): void {
    mkdirSync(dirname(this.config.tokenPath), { recursive: true });
    writeFileSync(this.config.tokenPath, JSON.stringify(this.creds, null, 2), { mode: 0o600 });
  }

  private async discover(): Promise<ServerMetadata> {
    if (this.metadata) return this.metadata;
    const res = await fetch(`${this.config.serverUrl}/.well-known/oauth-authorization-server`);
    if (!res.ok) throw new Error(`OAuth discovery failed: ${res.status}`);
    this.metadata = (await res.json()) as ServerMetadata;
    return this.metadata;
  }

  private redirectUri(): string {
    return `http://127.0.0.1:${this.config.callbackPort ?? 8765}/callback`;
  }

  /** Dynamic Client Registration (RFC 7591). Idempotent server-side. */
  private async register(): Promise<StoredCredentials> {
    const meta = await this.discover();
    const res = await fetch(meta.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [this.redirectUri()],
        client_name: `Buzz Agent (@${this.config.agentHandle})`,
        client_uri: BUZZ_CLIENT_URI,
      }),
    });
    if (!res.ok) throw new Error(`DCR failed: ${res.status}`);
    const body = (await res.json()) as { client_id: string; client_secret?: string };
    this.creds = { ...this.creds, client_id: body.client_id, client_secret: body.client_secret };
    this.persist();
    return this.creds;
  }

  /**
   * One-time interactive pairing: prints the authorize URL for the human
   * sponsor and resolves once the loopback redirect delivers the code.
   */
  async pair(log: (line: string) => void = console.log): Promise<void> {
    const meta = await this.discover();
    const creds = this.creds?.client_id ? this.creds : await this.register();

    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const state = b64url(randomBytes(16));

    const authUrl = new URL(meta.authorization_endpoint);
    authUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: creds.client_id,
      redirect_uri: this.redirectUri(),
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    }).toString();

    log(`\nOpen this URL to authorize the Buzz agent (one-time):\n\n  ${authUrl}\n`);

    const code = await this.waitForCallback(state);
    await this.exchange({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: this.redirectUri(),
    });
    log("Paired. The agent now appears in the Silo dashboard under Connections.");
  }

  private waitForCallback(expectedState: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", `http://127.0.0.1`);
        if (url.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || state !== expectedState) {
          res.writeHead(400).end("Invalid callback");
          server.close();
          reject(new Error("OAuth callback missing code or state mismatch"));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h3>Buzz agent paired with Silo. You can close this tab.</h3>");
        server.close();
        resolve(code);
      });
      const port = this.config.callbackPort ?? 8765;
      server.on("error", (err) => {
        reject(
          new Error(
            `OAuth callback server failed to listen on 127.0.0.1:${port} ` +
              `(${(err as NodeJS.ErrnoException).code ?? err.message}) — ` +
              `is the port in use? Set SILO_OAUTH_CALLBACK_PORT to change it.`
          )
        );
      });
      server.listen(port, "127.0.0.1");
    });
  }

  private async exchange(params: Record<string, string>): Promise<void> {
    const meta = await this.discover();
    const creds = this.creds;
    if (!creds) throw new Error("not registered");
    const res = await fetch(meta.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...params,
        client_id: creds.client_id,
        ...(creds.client_secret ? { client_secret: creds.client_secret } : {}),
      }),
    });
    if (!res.ok) throw new Error(`token ${params.grant_type} failed: ${res.status}`);
    const body = (await res.json()) as { access_token: string; refresh_token?: string };
    this.creds = {
      ...creds,
      access_token: body.access_token,
      refresh_token: body.refresh_token ?? creds.refresh_token,
    };
    this.persist();
  }

  /** Current bearer token; call `refresh()` on 401 and retry once. */
  accessToken(): string {
    const token = this.creds?.access_token;
    if (!token) {
      throw new Error("Not paired with Silo yet — run `npm run connect` first.");
    }
    return token;
  }

  /**
   * Bearer token for a request, refreshing first when only a refresh token
   * is stored — a paired agent must be able to bootstrap without waiting
   * for a 401 it can never send.
   */
  async ensureAccessToken(): Promise<string> {
    if (!this.creds?.access_token && this.creds?.refresh_token) {
      await this.refresh();
    }
    return this.accessToken();
  }

  private refreshing?: Promise<void>;

  /**
   * Single-flight: concurrent 401s share one refresh exchange. Parallel
   * refreshes would race and can invalidate rotating refresh tokens.
   */
  refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const refreshToken = this.creds?.refresh_token;
    if (!refreshToken) {
      throw new Error("No refresh token — run `npm run connect` to re-pair.");
    }
    await this.exchange({ grant_type: "refresh_token", refresh_token: refreshToken });
  }
}
