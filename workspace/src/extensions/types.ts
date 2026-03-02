// ── Message Protocol ─────────────────────────────────────────

/** Extension → Host messages */
export type NestMessage =
    | { type: 'nest'; id: string; action: 'fetch'; args: { url: string; init?: RequestInit } }
    | { type: 'nest'; id: string; action: 'readFile'; args: { root: string; path: string } }
    | { type: 'nest'; id: string; action: 'writeFile'; args: { root: string; path: string; content: string } }
    | { type: 'nest'; id: string; action: 'state.get'; args: { key: string } }
    | { type: 'nest'; id: string; action: 'state.set'; args: { key: string; value: unknown } }
    | { type: 'nest-resize'; height: number };

/** Host → Extension messages */
export type NestReply =
    | { type: 'nest-reply'; id: string; result: unknown }
    | { type: 'nest-reply'; id: string; error: string };

export type NestEvent =
    | { type: 'nest-event'; name: string; detail?: unknown };

export type NestTheme =
    | { type: 'nest-theme'; vars: Record<string, string> };

// ── Manifest (updated for iframe model) ──────────────────────

export interface ExtensionSlotConfig {
    type: 'dashboard' | 'sidebar' | 'toolbar' | 'viewer';
    entry: string;
    defaultHeight?: number;
}

export interface ExtensionManifest {
    id: string;
    name: string;
    version: number;
    slots: ExtensionSlotConfig[];
}

// ── Registry Types ───────────────────────────────────────────

export interface RegisteredExtension {
    manifest: ExtensionManifest;
}
