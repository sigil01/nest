import type { ExtensionRegistry } from "./registry";
import type { ExtensionManifest } from "./types";
import { createNestAPI } from "./api";

export async function loadExtensions(registry: ExtensionRegistry): Promise<void> {
    let manifests: ExtensionManifest[];
    try {
        const res = await fetch("/api/extensions", {
            credentials: 'include',
        });
        if (!res.ok) {
            console.warn("[extensions] Failed to fetch extension list:", res.status);
            return;
        }
        const data = await res.json();
        manifests = data.extensions ?? [];
    } catch (err) {
        console.warn("[extensions] Failed to fetch extension list:", err);
        return;
    }

    if (manifests.length === 0) {
        console.log("[extensions] No extensions found");
        registry.emitEvent("extensionsLoaded");
        return;
    }

    console.log(`[extensions] Loading ${manifests.length} extension(s):`, manifests.map((m) => m.id));

    for (const manifest of manifests) {
        try {
            // Inject CSS if present
            if (manifest.styles) {
                const link = document.createElement("link");
                link.rel = "stylesheet";
                link.href = `/api/extensions/${manifest.id}/${manifest.styles}`;
                link.dataset.extensionId = manifest.id;
                document.head.appendChild(link);
            }

            // Dynamic import of the extension's entry module
            const moduleUrl = `/api/extensions/${manifest.id}/${manifest.entry}`;
            const mod = await import(/* @vite-ignore */ moduleUrl);

            if (typeof mod.activate === "function") {
                const api = createNestAPI(registry, manifest.id);
                await mod.activate(api);
                console.log(`[extensions] Loaded: ${manifest.id} (${manifest.name} v${manifest.version})`);
            } else {
                console.warn(`[extensions] ${manifest.id}: no activate() export`);
            }
        } catch (err) {
            console.error(`[extensions] Failed to load ${manifest.id}:`, err);
        }
    }

    registry.emitEvent("extensionsLoaded");
}
