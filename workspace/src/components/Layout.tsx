import { useState, useEffect, useCallback, useRef, useReducer, lazy, Suspense } from "react";
import FileBrowser from "./FileBrowser";
import Dashboard from "./Dashboard";
import FileViewer from "./FileViewer";
import Chat from "./Chat";
import { fetchFile } from "../api";
import { useExtensionRegistry, ExtensionFrame } from "../extensions";
import type { ExtensionRegistry } from "../extensions";

const Canvas = lazy(() => import("./Canvas"));

/** Re-render when registry emits 'change' */
function useRegistryChange(registry: ExtensionRegistry | null): void {
    const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
    useEffect(() => {
        if (!registry) return;
        const handler = () => forceUpdate();
        registry.addEventListener('change', handler);
        return () => registry.removeEventListener('change', handler);
    }, [registry]);
}

export default function Layout() {
    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const [activeRoot, setActiveRoot] = useState<string>("");
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [chatOpen, setChatOpen] = useState(true);
    const [mobileOverlay, setMobileOverlay] = useState<"sidebar" | "chat" | null>(null);
    const [isMobile, setIsMobile] = useState(
        typeof window !== "undefined" && window.matchMedia("(max-width: 768px)").matches
    );

    // Canvas state for .excalidraw files
    const [canvasData, setCanvasData] = useState<string | null>(null);
    const [canvasLoading, setCanvasLoading] = useState(false);
    const [canvasError, setCanvasError] = useState<string | null>(null);

    const isExcalidraw = selectedFile?.toLowerCase().endsWith(".excalidraw") ?? false;

    // Track dirty state from FileViewer / Canvas
    const dirtyRef = useRef(false);

    // Extension registry
    const registry = useExtensionRegistry();
    useRegistryChange(registry);

    const toolbarSlots = registry?.getSlots('toolbar') ?? [];
    const sidebarSlots = registry?.getSlots('sidebar') ?? [];

    useEffect(() => {
        const mediaQuery = window.matchMedia("(max-width: 768px)");
        const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
        mediaQuery.addEventListener("change", handler);
        return () => mediaQuery.removeEventListener("change", handler);
    }, []);

    // Load .excalidraw file content when selected
    useEffect(() => {
        if (!selectedFile || !selectedFile.toLowerCase().endsWith(".excalidraw") || !activeRoot) {
            setCanvasData(null);
            setCanvasError(null);
            return;
        }

        let cancelled = false;
        setCanvasLoading(true);
        setCanvasError(null);

        fetchFile(activeRoot, selectedFile)
            .then((res) => {
                if (!cancelled) {
                    setCanvasData(res.content);
                    setCanvasLoading(false);
                }
            })
            .catch((err) => {
                if (!cancelled) {
                    setCanvasError(err.message || "Failed to load drawing");
                    setCanvasLoading(false);
                }
            });

        return () => { cancelled = true; };
    }, [selectedFile, activeRoot]);

    const confirmIfDirty = useCallback((): boolean => {
        if (!dirtyRef.current) return true;
        return window.confirm("You have unsaved changes. Discard?");
    }, []);

    const handleFileSelect = useCallback((path: string, root: string) => {
        if (path === selectedFile && root === activeRoot) return;
        if (!confirmIfDirty()) return;
        dirtyRef.current = false;
        setSelectedFile(path);
        setActiveRoot(root);
        if (isMobile) setMobileOverlay(null);
    }, [selectedFile, activeRoot, confirmIfDirty, isMobile]);

    const handleBack = useCallback(() => {
        if (!confirmIfDirty()) return;
        dirtyRef.current = false;
        setSelectedFile(null);
    }, [confirmIfDirty]);

    const handleWikiLink = useCallback((target: string) => {
        if (!confirmIfDirty()) return;
        dirtyRef.current = false;
        const path = target.endsWith(".md") ? target : `${target}.md`;
        setSelectedFile(path);
    }, [confirmIfDirty]);

    const handleDirtyChange = useCallback((dirty: boolean) => {
        dirtyRef.current = dirty;
    }, []);

    const handleFileCreated = useCallback((path: string, root: string) => {
        if (!confirmIfDirty()) return;
        dirtyRef.current = false;
        setSelectedFile(path);
        setActiveRoot(root);
    }, [confirmIfDirty]);

    const handleFileDeleted = useCallback((path: string) => {
        if (selectedFile === path) {
            dirtyRef.current = false;
            setSelectedFile(null);
        }
    }, [selectedFile]);

    const handleHomeClick = useCallback(() => {
        if (confirmIfDirty()) {
            dirtyRef.current = false;
            setSelectedFile(null);
        }
    }, [confirmIfDirty]);

    const toggleSidebar = () => {
        if (isMobile) {
            setMobileOverlay(mobileOverlay === "sidebar" ? null : "sidebar");
        } else {
            setSidebarOpen(!sidebarOpen);
        }
    };

    const toggleChat = () => {
        if (isMobile) {
            setMobileOverlay(mobileOverlay === "chat" ? null : "chat");
        } else {
            setChatOpen(!chatOpen);
        }
    };

    // Determine content to render
    const renderContent = () => {
        // Excalidraw canvas
        if (isExcalidraw && selectedFile) {
            if (canvasLoading) {
                return (
                    <div className="content-inner">
                        <div className="empty-state">Loading drawing…</div>
                    </div>
                );
            }
            if (canvasError) {
                return (
                    <div className="content-inner">
                        <div className="empty-state">Error: {canvasError}</div>
                    </div>
                );
            }
            if (canvasData !== null) {
                return (
                    <Suspense fallback={
                        <div className="content-inner">
                            <div className="empty-state">Loading canvas…</div>
                        </div>
                    }>
                        <Canvas
                            key={selectedFile}
                            initialData={canvasData}
                            filePath={selectedFile}
                            fileRoot={activeRoot}
                            onDirtyChange={handleDirtyChange}
                        />
                    </Suspense>
                );
            }
            return null;
        }

        // Normal content: file viewer or dashboard
        return (
            <div className="content-inner">
                {selectedFile ? (
                    <FileViewer
                        path={selectedFile}
                        root={activeRoot}
                        onBack={handleBack}
                        onWikiLink={handleWikiLink}
                        onDirtyChange={handleDirtyChange}
                    />
                ) : (
                    <Dashboard />
                )}
            </div>
        );
    };

    return (
        <div className="workspace">
            <div className="top-bar">
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <button
                        className={`toggle-btn ${sidebarOpen || mobileOverlay === "sidebar" ? "active" : ""}`}
                        onClick={toggleSidebar}
                        title="Toggle file browser"
                    >
                        ☰ Files
                    </button>
                    <h1
                        className="home-link"
                        onClick={handleHomeClick}
                        title="Back to dashboard"
                    ><span>nest</span></h1>
                </div>
                <div className="top-bar-right">
                    {toolbarSlots.map(({ extensionId, slot }) => (
                        <div key={`${extensionId}-${slot.entry}`} className="ext-toolbar-btn">
                            <ExtensionFrame
                                extensionId={extensionId}
                                entry={slot.entry}
                                defaultHeight={slot.defaultHeight ?? 32}
                            />
                        </div>
                    ))}
                    <button
                        className={`toggle-btn ${chatOpen || mobileOverlay === "chat" ? "active" : ""}`}
                        onClick={toggleChat}
                        title="Toggle chat"
                    >
                        💬 Chat
                    </button>
                </div>
            </div>

            <div className="main-area">
                {/* Sidebar */}
                {(sidebarOpen || mobileOverlay === "sidebar") && (
                    <div className={`sidebar ${mobileOverlay === "sidebar" ? "open" : ""}`}>
                        <FileBrowser
                            selectedFile={selectedFile}
                            onFileSelect={handleFileSelect}
                            onFileCreated={handleFileCreated}
                            onFileDeleted={handleFileDeleted}
                        />
                        {sidebarSlots.length > 0 && (
                            <div className="ext-sidebar-sections">
                                {sidebarSlots.map(({ extensionId, slot }) => (
                                    <div key={`${extensionId}-${slot.entry}`} className="ext-sidebar-section">
                                        <ExtensionFrame
                                            extensionId={extensionId}
                                            entry={slot.entry}
                                            defaultHeight={slot.defaultHeight ?? 200}
                                        />
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* Main content */}
                <div className={`content ${isExcalidraw && selectedFile ? "content-canvas" : ""}`}>
                    {renderContent()}
                </div>

                {/* Chat */}
                {(chatOpen || mobileOverlay === "chat") && (
                    <div className={`chat-panel ${mobileOverlay === "chat" ? "open" : ""}`}>
                        <Chat />
                    </div>
                )}

                {/* Mobile overlay backdrop */}
                {mobileOverlay && (
                    <div className="overlay" onClick={() => setMobileOverlay(null)} />
                )}
            </div>
        </div>
    );
}
