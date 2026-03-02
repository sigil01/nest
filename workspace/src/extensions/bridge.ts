import { createContext, useContext } from 'react';
import type { NestMessage, NestReply } from './types';

/**
 * ExtensionBridge handles postMessage from extension iframes.
 * It proxies API calls (with cookies) so extensions never see the auth token.
 *
 * Security:
 * - Only responds to messages from registered extension iframes (frame registry)
 * - State is scoped per extension ID to prevent cross-extension leakage
 * - Fetch is restricted to same-origin /api/ paths to prevent open-proxy abuse
 */
export class ExtensionBridge {
    private frameRegistry = new Map<WindowProxy, string>(); // contentWindow -> extensionId

    constructor() {
        window.addEventListener('message', this.handleMessage);
    }

    destroy(): void {
        window.removeEventListener('message', this.handleMessage);
        this.frameRegistry.clear();
    }

    registerFrame(extensionId: string, contentWindow: WindowProxy): void {
        this.frameRegistry.set(contentWindow, extensionId);
    }

    unregisterFrame(contentWindow: WindowProxy): void {
        this.frameRegistry.delete(contentWindow);
    }

    private handleMessage = async (e: MessageEvent): Promise<void> => {
        const msg = e.data;
        if (!msg || msg.type !== 'nest' || !msg.id || !msg.action) return;

        const source = e.source as WindowProxy | null;
        if (!source) return;

        // Only process messages from registered extension iframes
        const extensionId = this.frameRegistry.get(source);
        if (!extensionId) return;

        try {
            const result = await this.dispatch(msg as NestMessage, extensionId);
            const reply: NestReply = { type: 'nest-reply', id: msg.id, result };
            source.postMessage(reply, '*');
        } catch (err) {
            const reply: NestReply = { type: 'nest-reply', id: msg.id, error: String(err) };
            source.postMessage(reply, '*');
        }
    };

    private async dispatch(msg: NestMessage, extensionId: string): Promise<unknown> {
        if (msg.type === 'nest-resize') return; // handled by ExtensionFrame directly

        switch (msg.action) {
            case 'fetch': {
                const url = msg.args.url;
                // Only allow same-origin API calls
                if (!url.startsWith('/api/')) {
                    throw new Error('Extensions can only fetch /api/ paths');
                }
                const res = await fetch(url, {
                    ...msg.args.init,
                    credentials: 'include',
                });
                const contentType = res.headers.get('content-type') ?? '';
                const body = contentType.includes('json') ? await res.json() : await res.text();
                return { status: res.status, ok: res.ok, body };
            }
            case 'readFile': {
                const { root, path } = msg.args;
                const encoded = path.split('/').map(encodeURIComponent).join('/');
                const res = await fetch(`/api/files/${encodeURIComponent(root)}/${encoded}`, {
                    credentials: 'include',
                });
                if (!res.ok) throw new Error(`Failed to read file: ${res.status}`);
                return res.json();
            }
            case 'writeFile': {
                const { root, path, content } = msg.args;
                const encoded = path.split('/').map(encodeURIComponent).join('/');
                const res = await fetch(`/api/files/${encodeURIComponent(root)}/${encoded}`, {
                    method: 'PUT',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content }),
                });
                if (!res.ok) throw new Error(`Failed to write file: ${res.status}`);
                return res.json();
            }
            case 'state.get': {
                const key = `nest-ext-state:${extensionId}:${msg.args.key}`;
                const raw = localStorage.getItem(key);
                return raw ? JSON.parse(raw) : null;
            }
            case 'state.set': {
                const key = `nest-ext-state:${extensionId}:${msg.args.key}`;
                localStorage.setItem(key, JSON.stringify(msg.args.value));
                return null;
            }
            default:
                throw new Error(`Unknown action: ${(msg as any).action}`);
        }
    }
}

// React context for bridge access from components (e.g. ExtensionFrame)
export const ExtensionBridgeContext = createContext<ExtensionBridge | null>(null);
export function useExtensionBridge(): ExtensionBridge | null {
    return useContext(ExtensionBridgeContext);
}
