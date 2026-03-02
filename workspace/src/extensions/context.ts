import { createContext, useContext } from 'react';
import type { ExtensionRegistry } from './registry';

export const ExtensionRegistryContext = createContext<ExtensionRegistry | null>(null);
export function useExtensionRegistry(): ExtensionRegistry | null {
    return useContext(ExtensionRegistryContext);
}
