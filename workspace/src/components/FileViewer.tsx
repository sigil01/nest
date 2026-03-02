import { useState, useEffect, useMemo, useCallback, useRef, lazy, Suspense } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { fetchFile, putFile, fetchFiles, rawFileUrl } from "../api";

const Editor = lazy(() => import("./Editor"));

const escapeHtml = (str: string) =>
    str.replace(/[&<>"']/g, (m) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[m]!));

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const CODE_EXTENSIONS = new Set([".ts", ".js", ".json", ".yaml", ".yml", ".toml", ".sh", ".css", ".html", ".tsx", ".jsx", ".xml", ".rs", ".py", ".go"]);

function getExtension(path: string): string {
    const dot = path.lastIndexOf(".");
    return dot >= 0 ? path.slice(dot).toLowerCase() : "";
}

function isImageFile(path: string): boolean {
    return IMAGE_EXTENSIONS.has(getExtension(path));
}

function isCodeFile(path: string): boolean {
    return CODE_EXTENSIONS.has(getExtension(path));
}

function isTextFile(path: string): boolean {
    const ext = getExtension(path);
    return ext === ".md" || ext === ".excalidraw" || ext === ".txt" || ext === "" || isCodeFile(path);
}

/** Fetch a raw file as a blob URL, with cookie auth */
function useAuthBlobUrl(root: string, path: string, enabled: boolean): string | null {
    const [blobUrl, setBlobUrl] = useState<string | null>(null);

    useEffect(() => {
        if (!enabled) { setBlobUrl(null); return; }
        let revoked = false;
        fetch(rawFileUrl(root, path), {
            credentials: 'include',
        })
            .then((res) => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.blob();
            })
            .then((blob) => {
                if (revoked) return;
                setBlobUrl(URL.createObjectURL(blob));
            })
            .catch(() => {
                if (!revoked) setBlobUrl(null);
            });
        return () => {
            revoked = true;
            setBlobUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
        };
    }, [root, path, enabled]);

    return blobUrl;
}

interface FileViewerProps {
    path: string;
    root: string;
    onBack: () => void;
    onWikiLink: (target: string) => void;
    onDirtyChange?: (dirty: boolean) => void;
}

type SaveStatus = "clean" | "dirty" | "saving" | "saved" | "error";

export default function FileViewer({ path, root, onBack, onWikiLink, onDirtyChange }: FileViewerProps) {
    const [content, setContent] = useState<string | null>(null);
    const [editedContent, setEditedContent] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [editMode, setEditMode] = useState(false);
    const [saveStatus, setSaveStatus] = useState<SaveStatus>("clean");
    const [fileList, setFileList] = useState<string[]>([]);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const editModeRef = useRef(editMode);
    const saveStatusRef = useRef(saveStatus);
    const handleSaveRef = useRef<() => void>(() => {});

    const isImage = isImageFile(path);
    const imageBlobUrl = useAuthBlobUrl(root, path, isImage);

    // Load file content (skip for images — they use the raw endpoint)
    useEffect(() => {
        if (isImage) {
            setContent(null);
            setEditedContent(null);
            setLoading(false);
            setError(null);
            return;
        }

        let cancelled = false;
        setLoading(true);
        setError(null);
        setEditMode(false);
        setSaveStatus("clean");
        setEditedContent(null);

        fetchFile(root, path)
            .then((res) => {
                if (!cancelled) {
                    setContent(res.content);
                    setEditedContent(res.content);
                    setLoading(false);
                }
            })
            .catch((err) => {
                if (!cancelled) {
                    setError(err.message || "Failed to load file");
                    setLoading(false);
                }
            });

        return () => { cancelled = true; };
    }, [path, isImage]);

    // Load file list for wiki-link autocomplete
    useEffect(() => {
        let cancelled = false;
        fetchFiles(root)
            .then((res) => {
                if (!cancelled) {
                    const paths: string[] = [];
                    const collect = (entries: typeof res.entries) => {
                        for (const e of entries) {
                            if (e.type === "file") paths.push(e.path);
                            if (e.children) collect(e.children);
                        }
                    };
                    collect(res.entries || []);
                    setFileList(paths);
                }
            })
            .catch(() => {});
        return () => { cancelled = true; };
    }, []);

    // Notify parent of dirty state
    useEffect(() => {
        onDirtyChange?.(saveStatus === "dirty");
    }, [saveStatus, onDirtyChange]);

    const isDirty = saveStatus === "dirty";

    const handleEditorChange = useCallback((newContent: string) => {
        setEditedContent(newContent);
        setSaveStatus("dirty");
    }, []);

    const handleSave = useCallback(async () => {
        if (editedContent === null) return;
        if (saveStatus === "saving") return;
        setSaveStatus("saving");
        try {
            await putFile(root, path, editedContent);
            setContent(editedContent);
            setSaveStatus("saved");
            // Reset "Saved" indicator after 2s
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
            saveTimerRef.current = setTimeout(() => setSaveStatus("clean"), 2000);
        } catch {
            setSaveStatus("error");
        }
    }, [editedContent, path, saveStatus]);

    // Keep refs in sync for stable event handlers
    useEffect(() => { editModeRef.current = editMode; }, [editMode]);
    useEffect(() => { saveStatusRef.current = saveStatus; }, [saveStatus]);
    useEffect(() => { handleSaveRef.current = handleSave; }, [handleSave]);

    // beforeunload guard for unsaved changes (registered once)
    useEffect(() => {
        const handler = (e: BeforeUnloadEvent) => {
            if (saveStatusRef.current === "dirty") {
                e.preventDefault();
            }
        };
        window.addEventListener("beforeunload", handler);
        return () => window.removeEventListener("beforeunload", handler);
    }, []);

    // Ctrl+S prevention at document level (registered once, reads refs)
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                e.preventDefault();
                if (editModeRef.current && saveStatusRef.current === "dirty") {
                    handleSaveRef.current();
                }
            }
        };
        document.addEventListener("keydown", handler);
        return () => document.removeEventListener("keydown", handler);
    }, []);

    const handleToggleEdit = useCallback(() => {
        if (editMode && isDirty) {
            if (!window.confirm("You have unsaved changes. Discard?")) return;
            // Revert to last saved content
            setEditedContent(content);
            setSaveStatus("clean");
        }
        setEditMode((prev) => !prev);
    }, [editMode, isDirty, content]);

    const isMarkdown = path.endsWith(".md");

    const renderedHtml = useMemo(() => {
        const source = editMode ? editedContent : content;
        if (!source || !isMarkdown) return "";

        // Strip YAML frontmatter before rendering
        const stripped = source.replace(/^---\n[\s\S]*?\n---\n/, "");

        // Replace wiki-links with clickable spans before markdown parsing
        const withWikiLinks = stripped.replace(
            /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
            (_match, target, display) => {
                const label = display || target;
                return `<a class="wiki-link" data-wiki-target="${encodeURIComponent(target)}">${escapeHtml(label)}</a>`;
            }
        );

        const rawHtml = marked.parse(withWikiLinks) as string;
        return DOMPurify.sanitize(rawHtml);
    }, [content, editedContent, isMarkdown, editMode]);

    const handleClick = (e: React.MouseEvent) => {
        const target = (e.target as HTMLElement).closest(".wiki-link") as HTMLElement | null;
        if (target) {
            e.preventDefault();
            const wikiTarget = decodeURIComponent(target.getAttribute("data-wiki-target") || "");
            if (wikiTarget) {
                onWikiLink(wikiTarget);
            }
        }
    };

    const saveIndicator = () => {
        switch (saveStatus) {
            case "dirty": return <span className="save-indicator dirty">● Unsaved</span>;
            case "saving": return <span className="save-indicator saving">Saving…</span>;
            case "saved": return <span className="save-indicator saved">✓ Saved</span>;
            case "error": return <span className="save-indicator error">Save failed</span>;
            default: return null;
        }
    };

    if (loading) {
        return (
            <div className="file-viewer">
                <div className="file-breadcrumb">
                    <button className="back-btn" onClick={onBack}>← Back</button>
                    <span className="file-path">{path}</span>
                </div>
                <div className="empty-state">Loading…</div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="file-viewer">
                <div className="file-breadcrumb">
                    <button className="back-btn" onClick={onBack}>← Back</button>
                    <span className="file-path">{path}</span>
                </div>
                <div className="empty-state">Error: {error}</div>
            </div>
        );
    }

    return (
        <div className={`file-viewer ${editMode ? "edit-mode" : ""}`}>
            <div className="file-breadcrumb">
                <button className="back-btn" onClick={onBack}>← Back</button>
                <span className="file-path">{path}</span>
                <div className="file-actions">
                    {saveIndicator()}
                    {editMode && (isDirty || saveStatus === "saving") && (
                        <button className="save-btn" onClick={handleSave} disabled={saveStatus === "saving"}>
                            Save
                        </button>
                    )}
                    {isMarkdown && (
                        <button
                            className={`toggle-btn ${editMode ? "active" : ""}`}
                            onClick={handleToggleEdit}
                        >
                            {editMode ? "View" : "Edit"}
                        </button>
                    )}
                </div>
            </div>
            {editMode && isMarkdown ? (
                <div className="editor-container">
                    <Suspense fallback={<div className="empty-state">Loading editor…</div>}>
                        <Editor
                            content={editedContent ?? ""}
                            onChange={handleEditorChange}
                            filePath={path}
                            onSave={handleSave}
                            fileList={fileList}
                        />
                    </Suspense>
                </div>
            ) : isMarkdown ? (
                <div
                    className="markdown-body"
                    dangerouslySetInnerHTML={{ __html: renderedHtml }}
                    onClick={handleClick}
                />
            ) : isImage ? (
                <div className="file-viewer-image">
                    {imageBlobUrl ? (
                        <img
                            src={imageBlobUrl}
                            alt={path.split("/").pop() ?? path}
                            className="file-viewer-image-img"
                        />
                    ) : (
                        <div className="empty-state">Loading image…</div>
                    )}
                </div>
            ) : isCodeFile(path) ? (
                <pre className="file-content-pre file-content-code">{content}</pre>
            ) : isTextFile(path) ? (
                <pre className="file-content-pre">{content}</pre>
            ) : (
                <div className="empty-state">Binary file — cannot preview</div>
            )}
        </div>
    );
}

/** Check if the FileViewer currently has unsaved changes — exposed for Layout */
export function useUnsavedGuard(): {
    hasUnsaved: boolean;
    setHasUnsaved: (v: boolean) => void;
    confirmDiscard: () => boolean;
} {
    const [hasUnsaved, setHasUnsaved] = useState(false);

    const confirmDiscard = useCallback(() => {
        if (!hasUnsaved) return true;
        return window.confirm("You have unsaved changes. Discard?");
    }, [hasUnsaved]);

    return { hasUnsaved, setHasUnsaved, confirmDiscard };
}
