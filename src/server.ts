import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { ServerConfig, RouteHandler } from "./types.js";
import * as logger from "./logger.js";

const MIME_TYPES: Record<string, string> = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
};

const AUTH_RATE_WINDOW_MS = 300_000;
const AUTH_RATE_MAX = 5;
const MAX_BODY_SIZE = 1_048_576;
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const WS_RATE_WINDOW_MS = 60_000;
const WS_RATE_MAX = 120;

export type WsRpcHandler = (message: { type: string; [key: string]: unknown }, clientId: string) => Promise<any>;

export class HttpServer {
    private server: Server;
    private config: ServerConfig;
    private routes = new Map<string, Map<string, RouteHandler>>();
    private prefixRoutes: Array<{ prefix: string; method: string; handler: RouteHandler }> = [];
    private wss: WebSocketServer;
    private wsClients = new Map<string, WebSocket>();
    private wsClientCounter = 0;
    private wsRateLimits = new Map<string, number[]>();
    private wsHandler?: WsRpcHandler;
    private authRateLimits = new Map<string, number[]>();
    private sessions = new Map<string, { createdAt: number }>();

    constructor(config: ServerConfig) {
        this.config = config;
        this.server = createServer((req, res) => this.handleRequest(req, res));
        this.server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
        this.wss = new WebSocketServer({ noServer: true });

        // Built-in routes
        this.route("GET", "/health", (_req, res) => {
            this.json(res, 200, { status: "ok" });
        });

        this.route("GET", "/api/ping", (_req, res) => {
            this.json(res, 200, { pong: true });
        });

        this.route("POST", "/api/auth/login", async (req, res) => {
            const body = await this.readJsonBody(req, res);
            if (!body) return;
            if (typeof body.token !== "string") {
                this.json(res, 400, { error: "Missing field: token" });
                return;
            }
            if (!this.validateToken(body.token)) {
                this.json(res, 401, { error: "Unauthorized" });
                return;
            }
            // Clean expired sessions
            const now = Date.now();
            for (const [id, s] of this.sessions) {
                if (now - s.createdAt >= SESSION_MAX_AGE_MS) this.sessions.delete(id);
            }
            const sessionId = randomBytes(32).toString("hex");
            this.sessions.set(sessionId, { createdAt: now });
            const secure = this.config.trustProxy ? "; Secure" : "";
            res.setHeader("Set-Cookie", `nest-session=${sessionId}; HttpOnly; SameSite=Strict; Path=/${secure}`);
            this.json(res, 200, { ok: true });
        });

        this.route("POST", "/api/auth/logout", async (req, res) => {
            const sessionId = this.parseCookie(req);
            if (sessionId) this.sessions.delete(sessionId);
            const secure = this.config.trustProxy ? "; Secure" : "";
            res.setHeader("Set-Cookie", `nest-session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
            this.json(res, 200, { ok: true });
        });
    }

    get raw(): Server { return this.server; }
    get wsClientCount(): number { return this.wsClients.size; }

    // ─── Public API for plugins ──────────────────────────────

    route(method: string, path: string, handler: RouteHandler): void {
        if (!this.routes.has(path)) this.routes.set(path, new Map());
        this.routes.get(path)!.set(method, handler);
    }

    prefixRoute(method: string, prefix: string, handler: RouteHandler): void {
        this.prefixRoutes.push({ prefix, method, handler });
    }

    setWsHandler(handler: WsRpcHandler): void {
        this.wsHandler = handler;
    }

    broadcastEvent(event: any): void {
        if (this.wsClients.size === 0) return;
        const data = JSON.stringify(event);
        for (const [, client] of this.wsClients) {
            if (client.readyState === WebSocket.OPEN) client.send(data);
        }
    }

    sendToClient(clientId: string, event: any): void {
        const client = this.wsClients.get(clientId);
        if (client?.readyState === WebSocket.OPEN) client.send(JSON.stringify(event));
    }

    async start(): Promise<void> {
        const host = this.config.host ?? "127.0.0.1";
        return new Promise((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(this.config.port, host, () => {
                this.server.removeListener("error", reject);
                logger.info("HTTP server listening", { port: this.config.port, host });
                resolve();
            });
        });
    }

    async stop(): Promise<void> {
        for (const [, client] of this.wsClients) client.close(1001, "Shutting down");
        this.wsClients.clear();
        return new Promise((resolve) => {
            const timeout = setTimeout(() => this.server.closeAllConnections(), 5000);
            this.server.close(() => { clearTimeout(timeout); resolve(); });
            this.server.closeIdleConnections();
        });
    }

    // ─── Request Handling ────────────────────────────────────

    private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        this.setSecurityHeaders(res);
        const url = new URL(req.url ?? "/", "http://localhost");
        const pathname = url.pathname;

        // Health — no auth
        if (pathname === "/health" && (req.method ?? "GET") === "GET") {
            this.json(res, 200, { status: "ok" });
            return;
        }

        // CORS preflight
        if (req.method === "OPTIONS" && this.config.cors) {
            this.setCorsHeaders(res);
            res.writeHead(204);
            res.end();
            return;
        }

        // Auth for API routes (except login)
        if (pathname.startsWith("/api/") && pathname !== "/api/auth/login") {
            if (!this.authenticate(req)) {
                this.json(res, 401, { error: "Unauthorized" });
                return;
            }
        }

        if (this.config.cors) this.setCorsHeaders(res);

        // Exact routes
        const methods = this.routes.get(pathname);
        if (methods) {
            const handler = methods.get(req.method ?? "GET");
            if (handler) {
                try { await handler(req, res); } catch (err) {
                    logger.error("Route error", { path: pathname, error: String(err) });
                    if (!res.headersSent) this.json(res, 500, { error: "Internal server error" });
                }
                return;
            }
            res.writeHead(405, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Method Not Allowed" }));
            return;
        }

        // Prefix routes
        for (const route of this.prefixRoutes) {
            if (pathname.startsWith(route.prefix) && (req.method ?? "GET") === route.method) {
                try { await route.handler(req, res); } catch (err) {
                    logger.error("Route error", { path: pathname, error: String(err) });
                    if (!res.headersSent) this.json(res, 500, { error: "Internal server error" });
                }
                return;
            }
        }

        this.json(res, 404, { error: "Not Found" });
    }

    // ─── WebSocket ───────────────────────────────────────────

    private handleUpgrade(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname !== "/ws") {
            socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
            socket.destroy();
            return;
        }

        const preAuth = this.authenticate(req);
        this.wss.handleUpgrade(req, socket, head, (ws) => {
            const clientId = `ws-${++this.wsClientCounter}`;
            let authenticated = preAuth;

            const pingInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) ws.ping();
            }, 30_000);

            let authTimeout: ReturnType<typeof setTimeout> | undefined;
            if (!authenticated) {
                authTimeout = setTimeout(() => {
                    if (!authenticated) { ws.close(4001, "Auth timeout"); }
                }, 5000);
            } else {
                this.wsClients.set(clientId, ws);
                this.wsSend(ws, { type: "auth_ok" });
            }

            ws.on("message", async (rawData) => {
                let msg: any;
                try { msg = JSON.parse(rawData.toString()); } catch {
                    this.wsSend(ws, { type: "error", error: "Invalid JSON" });
                    return;
                }

                if (!authenticated) {
                    if (msg.type === "auth" && this.validateToken(msg.token)) {
                        authenticated = true;
                        if (authTimeout) clearTimeout(authTimeout);
                        this.wsClients.set(clientId, ws);
                        this.wsSend(ws, { type: "auth_ok" });
                        return;
                    }
                    if (authTimeout) clearTimeout(authTimeout);
                    ws.close(4003, "Unauthorized");
                    return;
                }

                if (this.isWsRateLimited(clientId)) {
                    ws.close(4008, "Rate limit exceeded");
                    return;
                }

                if (!this.wsHandler) {
                    this.wsSend(ws, { id: msg.id, type: "response", success: false, error: "No handler" });
                    return;
                }

                try {
                    const { id, type, ...params } = msg;
                    const result = await this.wsHandler({ type, ...params }, clientId);
                    this.wsSend(ws, { id, type: "response", success: true, data: result });
                } catch (err) {
                    this.wsSend(ws, { id: msg.id, type: "response", success: false, error: String(err) });
                }
            });

            ws.on("close", () => {
                clearInterval(pingInterval);
                if (authTimeout) clearTimeout(authTimeout);
                this.wsClients.delete(clientId);
            });

            ws.on("error", () => {
                clearInterval(pingInterval);
                if (authTimeout) clearTimeout(authTimeout);
                this.wsClients.delete(clientId);
            });
        });
    }

    // ─── Auth ────────────────────────────────────────────────

    private authenticate(req: IncomingMessage): boolean {
        const sessionId = this.parseCookie(req);
        if (sessionId) {
            const session = this.sessions.get(sessionId);
            if (session && Date.now() - session.createdAt < SESSION_MAX_AGE_MS) return true;
            if (session) this.sessions.delete(sessionId);
        }

        const auth = req.headers["authorization"];
        if (!auth) return false;
        const parts = auth.split(" ");
        if (parts.length !== 2 || parts[0] !== "Bearer") return false;
        return this.validateToken(parts[1]);
    }

    private validateToken(provided: string): boolean {
        const a = Buffer.from(provided);
        const b = Buffer.from(this.config.token);
        if (a.length !== b.length) {
            timingSafeEqual(b, Buffer.alloc(b.length));
            return false;
        }
        return timingSafeEqual(a, b);
    }

    private parseCookie(req: IncomingMessage): string | null {
        const cookie = req.headers.cookie;
        if (!cookie) return null;
        const match = cookie.match(/(?:^|;\s*)nest-session=([^\s;]+)/);
        return match ? match[1] : null;
    }

    // ─── Utilities ───────────────────────────────────────────

    private setSecurityHeaders(res: ServerResponse): void {
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    }

    private setCorsHeaders(res: ServerResponse): void {
        if (!this.config.cors) return;
        res.setHeader("Access-Control-Allow-Origin", this.config.cors.origin);
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }

    private isWsRateLimited(clientId: string): boolean {
        const now = Date.now();
        const ts = this.wsRateLimits.get(clientId) ?? [];
        const recent = ts.filter((t) => now - t < WS_RATE_WINDOW_MS);
        recent.push(now);
        this.wsRateLimits.set(clientId, recent);
        return recent.length > WS_RATE_MAX;
    }

    private wsSend(ws: WebSocket, data: any): void {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
    }

    json(res: ServerResponse, status: number, body: unknown): void {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
    }

    async readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<any | null> {
        return new Promise((resolve) => {
            let size = 0;
            let data = "";
            req.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > MAX_BODY_SIZE) {
                    this.json(res, 413, { error: "Payload Too Large" });
                    req.destroy();
                    resolve(null);
                    return;
                }
                data += chunk.toString();
            });
            req.on("end", () => {
                try { resolve(JSON.parse(data)); } catch {
                    this.json(res, 400, { error: "Invalid JSON" });
                    resolve(null);
                }
            });
            req.on("error", () => resolve(null));
        });
    }
}
