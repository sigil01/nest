// ─── Auth ─────────────────────────────────────────────────────

export async function login(token: string): Promise<boolean> {
    const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token }),
    });
    return res.ok;
}

export async function logout(): Promise<void> {
    await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
    });
}

export async function checkAuth(): Promise<boolean> {
    try {
        const res = await fetch('/api/ping', { credentials: 'include' });
        return res.ok;
    } catch {
        return false;
    }
}

// ─── Fetch Wrapper ────────────────────────────────────────────

async function apiFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
        const res = await fetch(path, {
            ...init,
            signal: controller.signal,
            credentials: 'include',
            headers: {
                ...init?.headers,
                ...(init?.body ? { "Content-Type": "application/json" } : {}),
            },
        });
        clearTimeout(timeout);
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new ApiError(res.status, body?.error ?? res.statusText);
        }
        return res.json();
    } catch (err) {
        clearTimeout(timeout);
        if (err instanceof DOMException && err.name === "AbortError") {
            throw new ApiError(0, "Request timed out — server may be unreachable");
        }
        throw err;
    }
}

export class ApiError extends Error {
    constructor(public status: number, message: string) {
        super(message);
        this.name = "ApiError";
    }
}

// ─── API Functions ────────────────────────────────────────────

export function fetchPing(): Promise<{ pong: boolean }> {
    return apiFetch("/api/ping");
}

export function fetchStatus(): Promise<{
    ok: boolean;
    uptime: number;
    model: string;
    contextSize: number;
    listenerCount: number;
    sessions: string[];
}> {
    return apiFetch("/api/status");
}

export interface SessionInfo {
    name: string;
    state: string;
    model?: string;
    contextSize?: number;
    lastActivity?: number;
    today?: { inputTokens: number; outputTokens: number; cost: number; messageCount: number } | null;
}

export function fetchSessions(): Promise<{ sessions: SessionInfo[] }> {
    return apiFetch("/api/sessions");
}

export function fetchCron(): Promise<{
    jobs: Array<{ name: string; schedule: string; enabled: boolean }>;
}> {
    return apiFetch("/api/cron");
}

export function fetchUsage(): Promise<{
    today: { inputTokens: number; outputTokens: number; cost: number; messageCount: number };
    week: { cost: number };
    contextSize: number;
}> {
    return apiFetch("/api/usage");
}

export function fetchActivity(): Promise<{
    entries: Array<{
        sender: string;
        platform: string;
        channel: string;
        timestamp: number;
        responseTimeMs: number;
    }>;
}> {
    return apiFetch("/api/activity");
}

export function fetchLogs(): Promise<{
    entries: Array<{ timestamp: string; level: string; message: string; [key: string]: unknown }>;
}> {
    return apiFetch("/api/logs");
}

// ─── Files API ────────────────────────────────────────────────

export interface VaultFileEntry {
    name: string;
    path: string;
    type: "file" | "dir";
    children?: VaultFileEntry[];
}

export function fetchRoots(): Promise<{ roots: string[] }> {
    return apiFetch("/api/roots");
}

export function fetchFiles(root: string, dir?: string, search?: string): Promise<{ entries: VaultFileEntry[] }> {
    const params = new URLSearchParams();
    params.set("root", root);
    if (dir) params.set("dir", dir);
    if (search) params.set("search", search);
    return apiFetch(`/api/files?${params.toString()}`);
}

export function fetchFile(root: string, path: string): Promise<{ content: string; binary?: boolean }> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return apiFetch(`/api/files/${encodeURIComponent(root)}/${encoded}`);
}

export function putFile(root: string, path: string, content: string): Promise<{ ok: boolean; path: string }> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return apiFetch(`/api/files/${encodeURIComponent(root)}/${encoded}`, {
        method: "PUT",
        body: JSON.stringify({ content }),
    });
}

export function deleteFile(root: string, path: string): Promise<{ ok: boolean; path: string }> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return apiFetch(`/api/files/${encodeURIComponent(root)}/${encoded}`, {
        method: "DELETE",
    });
}

export function moveFile(root: string, from: string, to: string): Promise<{ ok: boolean; from: string; to: string }> {
    return apiFetch("/api/files/move", {
        method: "POST",
        body: JSON.stringify({ root, from, to }),
    });
}

/** Build a URL for the raw file endpoint (for image src, etc.) */
export function rawFileUrl(root: string, path: string): string {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return `/api/files/${encodeURIComponent(root)}/${encoded}?raw=true`;
}
