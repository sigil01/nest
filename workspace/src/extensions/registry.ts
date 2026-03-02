import type { ExtensionManifest, ExtensionSlotConfig, RegisteredExtension } from './types';

export class ExtensionRegistry extends EventTarget {
    private extensions = new Map<string, RegisteredExtension>();

    private emit(): void {
        this.dispatchEvent(new Event('change'));
    }

    /** Register an extension from its manifest */
    register(manifest: ExtensionManifest): void {
        this.extensions.set(manifest.id, { manifest });
        this.emit();
    }

    /** Unregister an extension */
    unregister(id: string): void {
        this.extensions.delete(id);
        this.emit();
    }

    /** Get all registered extensions */
    getAll(): RegisteredExtension[] {
        return [...this.extensions.values()];
    }

    /** Get extension by ID */
    get(id: string): RegisteredExtension | undefined {
        return this.extensions.get(id);
    }

    /** Get all slots of a given type across all extensions */
    getSlots(type: ExtensionSlotConfig['type']): Array<{ extensionId: string; slot: ExtensionSlotConfig }> {
        const result: Array<{ extensionId: string; slot: ExtensionSlotConfig }> = [];
        for (const ext of this.extensions.values()) {
            for (const slot of ext.manifest.slots) {
                if (slot.type === type) {
                    result.push({ extensionId: ext.manifest.id, slot });
                }
            }
        }
        return result;
    }

    /** Load extensions from server and register them */
    async loadFromServer(): Promise<void> {
        try {
            const res = await fetch('/api/extensions', { credentials: 'include' });
            if (!res.ok) {
                console.warn('[extensions] Failed to fetch extension list:', res.status);
                return;
            }
            const data = await res.json();
            const manifests: ExtensionManifest[] = data.extensions ?? [];

            if (manifests.length === 0) {
                console.log('[extensions] No extensions found');
                return;
            }

            console.log(`[extensions] Registering ${manifests.length} extension(s)`);
            for (const manifest of manifests) {
                // Convert old single-entry manifest to slots format if needed
                if (!manifest.slots && (manifest as any).entry) {
                    manifest.slots = [{ type: 'dashboard', entry: (manifest as any).entry }];
                }
                this.register(manifest);
            }
        } catch (err) {
            console.warn('[extensions] Failed to load extensions:', err);
        }
    }
}
