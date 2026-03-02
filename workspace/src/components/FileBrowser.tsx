import { useState, useEffect, useCallback, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { fetchFiles, fetchRoots, putFile, deleteFile, moveFile } from "../api";
import type { VaultFileEntry } from "../api";

interface FileBrowserProps {
    selectedFile: string | null;
    onFileSelect: (path: string, root: string) => void;
    onFileCreated?: (path: string, root: string) => void;
    onFileDeleted?: (path: string, root: string) => void;
}

function validateFileName(name: string): string | null {
    if (!name || name.trim() === "") return "File name cannot be empty";
    if (name.includes("/") || name.includes("\\")) return "File name cannot contain path separators";
    if (name.startsWith(".")) return "File name cannot start with a dot";
    if (name.length > 255) return "File name too long (max 255 characters)";
    if (name.includes("..")) return "File name cannot contain '..'";
    return null;
}

export default function FileBrowser({ selectedFile, onFileSelect, onFileCreated, onFileDeleted }: FileBrowserProps) {
    const [roots, setRoots] = useState<string[]>([]);
    const [activeRoot, setActiveRoot] = useState<string>("");
    const [entries, setEntries] = useState<VaultFileEntry[]>([]);
    const [search, setSearch] = useState("");
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [loading, setLoading] = useState(false);
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: VaultFileEntry } | null>(null);
    const [createMenu, setCreateMenu] = useState<{ x: number; y: number } | null>(null);
    const contextMenuRef = useRef<HTMLDivElement>(null);
    const createMenuRef = useRef<HTMLDivElement>(null);
    // Load available roots on mount
    useEffect(() => {
        fetchRoots()
            .then((res) => {
                setRoots(res.roots || []);
                if (res.roots?.length > 0 && !activeRoot) {
                    setActiveRoot(res.roots[0]);
                }
            })
            .catch(() => {});
    }, []);

    const loadFiles = useCallback(async (searchQuery?: string) => {
        if (!activeRoot) return;
        setLoading(true);
        try {
            const res = await fetchFiles(activeRoot, undefined, searchQuery || undefined);
            setEntries(res.entries || []);
        } catch {
            // ignore
        } finally {
            setLoading(false);
        }
    }, [activeRoot]);

    useEffect(() => {
        loadFiles();
    }, [loadFiles]);

    useEffect(() => {
        const timeout = setTimeout(() => {
            loadFiles(search);
        }, 300);
        return () => clearTimeout(timeout);
    }, [search, loadFiles]);

    // Close menus on click outside
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (contextMenu && contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
                setContextMenu(null);
            }
            if (createMenu && createMenuRef.current && !createMenuRef.current.contains(e.target as Node)) {
                setCreateMenu(null);
            }
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [contextMenu, createMenu]);

    // Close menus on Escape
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                setContextMenu(null);
                setCreateMenu(null);
            }
        };
        document.addEventListener("keydown", handler);
        return () => document.removeEventListener("keydown", handler);
    }, []);

    const toggleDir = (path: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(path)) {
                next.delete(path);
            } else {
                next.add(path);
            }
            return next;
        });
    };

    const handleCreateFile = async (type: "md" | "excalidraw" = "md") => {
        const defaultName = type === "excalidraw" ? "untitled.excalidraw" : "untitled.md";
        const name = window.prompt("New file name:", defaultName);
        if (!name) return;

        const validationError = validateFileName(name);
        if (validationError) {
            alert(validationError);
            return;
        }

        let filePath: string;
        if (name.includes(".")) {
            filePath = name;
        } else {
            filePath = type === "excalidraw" ? `${name}.excalidraw` : `${name}.md`;
        }

        const content = filePath.endsWith(".excalidraw")
            ? JSON.stringify({
                type: "excalidraw",
                version: 2,
                source: "nest",
                elements: [],
                appState: {
                    viewBackgroundColor: "#0d1117",
                    gridSize: null
                },
                files: {}
            }, null, 4)
            : "";

        try {
            await putFile(activeRoot, filePath, content);
            await loadFiles(search || undefined);
            onFileCreated?.(filePath, activeRoot);
        } catch (err) {
            alert(`Failed to create file: ${err instanceof Error ? err.message : "Unknown error"}`);
        }
    };

    const handleDeleteFile = async (entry: VaultFileEntry) => {
        setContextMenu(null);
        if (!window.confirm(`Delete "${entry.path}"? This cannot be undone.`)) return;

        try {
            await deleteFile(activeRoot, entry.path);
            await loadFiles(search || undefined);
            onFileDeleted?.(entry.path, activeRoot);
        } catch (err) {
            alert(`Failed to delete: ${err instanceof Error ? err.message : "Unknown error"}`);
        }
    };

    const handleRenameFile = async (entry: VaultFileEntry) => {
        setContextMenu(null);
        const newName = window.prompt("New name:", entry.name);
        if (!newName || newName === entry.name) return;

        const validationError = validateFileName(newName);
        if (validationError) {
            alert(validationError);
            return;
        }

        const parts = entry.path.split("/");
        parts[parts.length - 1] = newName;
        const newPath = parts.join("/");

        try {
            await moveFile(activeRoot, entry.path, newPath);
            await loadFiles(search || undefined);

            if (selectedFile === entry.path) {
                onFileCreated?.(newPath, activeRoot);
            }
            onFileDeleted?.(entry.path, activeRoot);
        } catch (err) {
            alert(`Failed to rename: ${err instanceof Error ? err.message : "Unknown error"}`);
        }
    };

    const handleMoveFile = async (entry: VaultFileEntry) => {
        setContextMenu(null);
        const dest = window.prompt("Move to (full path):", entry.path);
        if (!dest || dest === entry.path) return;

        try {
            await moveFile(activeRoot, entry.path, dest);
            await loadFiles(search || undefined);

            if (selectedFile === entry.path) {
                onFileCreated?.(dest, activeRoot);
            }
            onFileDeleted?.(entry.path, activeRoot);
        } catch (err) {
            alert(`Failed to move: ${err instanceof Error ? err.message : "Unknown error"}`);
        }
    };

    const handleContextMenu = (e: React.MouseEvent, entry: VaultFileEntry) => {
        if (entry.type === "dir") return;
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY, entry });
    };

    const renderEntry = (entry: VaultFileEntry, depth: number): React.ReactNode => {
        const isDir = entry.type === "dir";
        const isExpanded = expanded.has(entry.path);

        return (
            <div key={entry.path}>
                <div
                    className={`tree-item ${selectedFile === entry.path ? "selected" : ""}`}
                    style={{ "--depth": depth } as React.CSSProperties}
                    onClick={() => {
                        if (isDir) {
                            toggleDir(entry.path);
                        } else {
                            onFileSelect(entry.path, activeRoot);
                        }
                    }}
                    onContextMenu={(e) => handleContextMenu(e, entry)}
                >
                    <span className={`tree-icon ${isDir ? "dir" : ""}`}>
                        {isDir ? (isExpanded ? "▼" : "▶") : "📄"}
                    </span>
                    <span className="tree-name">{entry.name}</span>
                </div>
                {isDir && isExpanded && entry.children && (
                    entry.children.map((child) => renderEntry(child, depth + 1))
                )}
            </div>
        );
    };

    return (
        <>
            <div className="sidebar-header">
                {roots.length > 1 && (
                    <div className="root-selector">
                        {roots.map((root) => (
                            <button
                                key={root}
                                className={`root-tab ${activeRoot === root ? "active" : ""}`}
                                onClick={() => {
                                    setActiveRoot(root);
                                    setExpanded(new Set());
                                    setSearch("");
                                }}
                            >
                                {root}
                            </button>
                        ))}
                    </div>
                )}
                <div className="sidebar-header-row">
                    <input
                        className="sidebar-search"
                        type="text"
                        placeholder="Search files…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                    />
                    <button
                        className="new-file-btn"
                        onClick={(e: ReactMouseEvent) => {
                            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            setCreateMenu(createMenu ? null : { x: rect.left, y: rect.bottom + 4 });
                        }}
                        title="New file"
                    >
                        +
                    </button>
                </div>
            </div>
            <div className="file-tree">
                {loading && entries.length === 0 ? (
                    <div className="empty-state">Loading…</div>
                ) : entries.length === 0 ? (
                    <div className="empty-state">No files found</div>
                ) : (
                    entries.map((entry) => renderEntry(entry, 0))
                )}
            </div>

            {/* Create menu */}
            {createMenu && (
                <div
                    ref={createMenuRef}
                    className="context-menu"
                    style={{ left: createMenu.x, top: createMenu.y }}
                >
                    <button onClick={() => { setCreateMenu(null); handleCreateFile("md"); }}>
                        📄 Markdown
                    </button>
                    <button onClick={() => { setCreateMenu(null); handleCreateFile("excalidraw"); }}>
                        🎨 Drawing
                    </button>
                    <button onClick={() => {
                        setCreateMenu(null);
                        const name = window.prompt("Folder name:");
                        if (!name) return;
                        const validationError = validateFileName(name);
                        if (validationError) { alert(validationError); return; }
                        putFile(activeRoot, name + "/.gitkeep", "")
                            .then(() => loadFiles(search || undefined))
                            .catch((err) => alert(`Failed to create folder: ${err instanceof Error ? err.message : "Unknown error"}`));
                    }}>
                        📁 Folder
                    </button>
                </div>
            )}

            {/* Context menu */}
            {contextMenu && (
                <div
                    ref={contextMenuRef}
                    className="context-menu"
                    style={{ left: contextMenu.x, top: contextMenu.y }}
                >
                    <button onClick={() => handleRenameFile(contextMenu.entry)}>
                        Rename
                    </button>
                    <button onClick={() => handleMoveFile(contextMenu.entry)}>
                        Move to…
                    </button>
                    <button className="danger" onClick={() => handleDeleteFile(contextMenu.entry)}>
                        Delete
                    </button>
                </div>
            )}
        </>
    );
}
