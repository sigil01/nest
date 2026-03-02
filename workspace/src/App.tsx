import { useState, useMemo, useEffect } from 'react';
import Auth from './components/Auth';
import Layout from './components/Layout';
import ErrorBoundary from './components/ErrorBoundary';
import { ExtensionRegistry, ExtensionBridge, ExtensionRegistryContext, ExtensionBridgeContext } from './extensions';

export default function App() {
    const [authenticated, setAuthenticated] = useState(false);
    const registry = useMemo(() => new ExtensionRegistry(), []);
    const bridge = useMemo(() => new ExtensionBridge(), []);

    // Load extensions once authenticated
    useEffect(() => {
        if (authenticated) {
            registry.loadFromServer().catch(err =>
                console.error('[extensions] Load error:', err)
            );
        }
    }, [authenticated, registry]);

    // Cleanup bridge on unmount
    useEffect(() => () => bridge.destroy(), [bridge]);

    return (
        <ErrorBoundary>
            <ExtensionBridgeContext.Provider value={bridge}>
                <ExtensionRegistryContext.Provider value={registry}>
                    {authenticated
                        ? <Layout />
                        : <Auth onAuthenticated={() => setAuthenticated(true)} />
                    }
                </ExtensionRegistryContext.Provider>
            </ExtensionBridgeContext.Provider>
        </ErrorBoundary>
    );
}
