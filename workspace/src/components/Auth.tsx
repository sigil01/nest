import { useState, useEffect, useCallback } from "react";
import { login, checkAuth } from "../api";

interface AuthProps {
    onAuthenticated: () => void;
}

export default function Auth({ onAuthenticated }: AuthProps) {
    const [input, setInput] = useState("");
    const [error, setError] = useState("");
    const [checking, setChecking] = useState(true);

    // On mount, check if an existing session cookie is valid
    useEffect(() => {
        let cancelled = false;
        checkAuth().then((ok) => {
            if (cancelled) return;
            if (ok) {
                onAuthenticated();
            } else {
                setChecking(false);
            }
        });
        return () => { cancelled = true; };
    }, [onAuthenticated]);

    const handleConnect = useCallback(async () => {
        const val = input.trim();
        if (!val) return;
        setChecking(true);
        setError("");
        try {
            const ok = await login(val);
            if (ok) {
                onAuthenticated();
            } else {
                setError("Authentication failed");
                setChecking(false);
            }
        } catch {
            setError("Connection failed");
            setChecking(false);
        }
    }, [input, onAuthenticated]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter") handleConnect();
    };

    if (checking) {
        return (
            <div className="auth-screen">
                <h1><span>nest</span> workspace</h1>
                <div className="auth-form">
                    <span>Connecting…</span>
                </div>
            </div>
        );
    }

    return (
        <div className="auth-screen">
            <h1><span>nest</span> workspace</h1>
            <div className="auth-form">
                <input
                    type="password"
                    placeholder="API token"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    autoFocus
                />
                <button onClick={handleConnect} disabled={checking}>
                    Connect
                </button>
            </div>
            {error && <div className="auth-error">{error}</div>}
        </div>
    );
}
