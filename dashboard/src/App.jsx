import React, { useState, useEffect, useCallback, useRef } from 'react';

// ============================================================
// Configuration
// ============================================================
const API_BASE = '/api/stores';
const WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/stores/ws`;
const POLL_INTERVAL = 4000;

// ============================================================
// Store Dashboard App
// ============================================================
export default function App() {
    const [stores, setStores] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
    const [expandedStore, setExpandedStore] = useState(null);
    const [toasts, setToasts] = useState([]);
    const [wsConnected, setWsConnected] = useState(false);
    const wsRef = useRef(null);
    const pollRef = useRef(null);

    // ---- Toast management ----
    const addToast = useCallback((message, type = 'info') => {
        const id = Date.now();
        setToasts(prev => [...prev, { id, message, type }]);
        setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
    }, []);

    // ---- Fetch stores ----
    const fetchStores = useCallback(async () => {
        try {
            const res = await fetch(API_BASE);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            setStores(data.stores || []);
        } catch (err) {
            console.error('Fetch error:', err);
        } finally {
            setLoading(false);
        }
    }, []);

    // ---- WebSocket connection ----
    useEffect(() => {
        let ws;
        let reconnectTimer;

        const connect = () => {
            try {
                ws = new WebSocket(WS_URL);
                wsRef.current = ws;

                ws.onopen = () => {
                    setWsConnected(true);
                    // Stop polling when WS connects
                    if (pollRef.current) {
                        clearInterval(pollRef.current);
                        pollRef.current = null;
                    }
                };

                ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        if (data.type === 'store_list') {
                            setStores(data.stores || []);
                        } else if (data.store) {
                            // Individual event — trigger refresh
                            fetchStores();
                        }
                    } catch (e) {
                        console.debug('WS parse error:', e);
                    }
                };

                ws.onclose = () => {
                    setWsConnected(false);
                    wsRef.current = null;
                    // Restart polling as fallback
                    if (!pollRef.current) {
                        pollRef.current = setInterval(fetchStores, POLL_INTERVAL);
                    }
                    reconnectTimer = setTimeout(connect, 5000);
                };

                ws.onerror = () => {
                    ws.close();
                };
            } catch (e) {
                console.debug('WS connection failed:', e);
                if (!pollRef.current) {
                    pollRef.current = setInterval(fetchStores, POLL_INTERVAL);
                }
            }
        };

        // Initial fetch
        fetchStores();

        // Start polling + try WebSocket
        pollRef.current = setInterval(fetchStores, POLL_INTERVAL);
        connect();

        return () => {
            if (ws) ws.close();
            if (pollRef.current) clearInterval(pollRef.current);
            if (reconnectTimer) clearTimeout(reconnectTimer);
        };
    }, [fetchStores]);

    // ---- Create store ----
    const handleCreate = async (name, engine) => {
        try {
            const res = await fetch(API_BASE, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, engine, owner: 'default' }),
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.detail || `HTTP ${res.status}`);
            }
            addToast(`Store "${name}" creation initiated`, 'success');
            setShowModal(false);
            fetchStores();
        } catch (err) {
            addToast(err.message, 'error');
        }
    };

    // ---- Delete store ----
    const handleDelete = async (name) => {
        if (!window.confirm(`Delete store "${name}"? This action cannot be undone.`)) return;
        try {
            const res = await fetch(`${API_BASE}/${name}`, { method: 'DELETE' });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.detail || `HTTP ${res.status}`);
            }
            addToast(`Store "${name}" deletion initiated`, 'info');
            fetchStores();
        } catch (err) {
            addToast(err.message, 'error');
        }
    };

    // ---- Computed stats ----
    const stats = {
        total: stores.length,
        ready: stores.filter(s => s.phase === 'Ready').length,
        provisioning: stores.filter(s => s.phase === 'Provisioning').length,
        failed: stores.filter(s => s.phase === 'Failed').length,
    };

    // ---- Render ----
    return (
        <div className="app-container">
            <TopBar wsConnected={wsConnected} />
            <main className="main-content">
                <PageHeader onCreateClick={() => setShowModal(true)} />
                <StatsBar stats={stats} />
                {loading ? (
                    <div className="loading-container">
                        <div className="loading-spinner" />
                        <div className="loading-text">Loading stores...</div>
                    </div>
                ) : stores.length === 0 ? (
                    <EmptyState onCreateClick={() => setShowModal(true)} />
                ) : (
                    <div className="stores-grid">
                        {stores.map(store => (
                            <StoreCard
                                key={store.name}
                                store={store}
                                onDelete={handleDelete}
                                expanded={expandedStore === store.name}
                                onToggleExpand={() => setExpandedStore(
                                    expandedStore === store.name ? null : store.name
                                )}
                            />
                        ))}
                    </div>
                )}
            </main>
            {showModal && (
                <CreateStoreModal
                    onClose={() => setShowModal(false)}
                    onCreate={handleCreate}
                />
            )}
            <ToastContainer toasts={toasts} />
        </div>
    );
}

// ============================================================
// Top Bar
// ============================================================
function TopBar({ wsConnected }) {
    return (
        <header className="topbar">
            <div className="topbar-brand">
                <div className="topbar-logo">U</div>
                <div className="topbar-title">
                    Urumi Platform <span>Control Plane</span>
                </div>
            </div>
            <div className="topbar-actions">
                <div className="topbar-badge">
                    <span className="dot" />
                    {wsConnected ? 'Live' : 'Polling'}
                </div>
            </div>
        </header>
    );
}

// ============================================================
// Page Header
// ============================================================
function PageHeader({ onCreateClick }) {
    return (
        <div className="page-header">
            <div className="page-header-left">
                <h1>Stores</h1>
                <p>Manage your e-commerce store instances</p>
            </div>
            <button className="btn btn-primary" onClick={onCreateClick} id="create-store-btn">
                + New Store
            </button>
        </div>
    );
}

// ============================================================
// Stats Bar
// ============================================================
function StatsBar({ stats }) {
    return (
        <div className="stats-bar">
            <div className="stat-card">
                <div className="stat-label">Total</div>
                <div className="stat-value">{stats.total}</div>
            </div>
            <div className="stat-card">
                <div className="stat-label">Ready</div>
                <div className="stat-value green">{stats.ready}</div>
            </div>
            <div className="stat-card">
                <div className="stat-label">Provisioning</div>
                <div className="stat-value yellow">{stats.provisioning}</div>
            </div>
            <div className="stat-card">
                <div className="stat-label">Failed</div>
                <div className="stat-value red">{stats.failed}</div>
            </div>
        </div>
    );
}

// ============================================================
// Store Card
// ============================================================
const PIPELINE_STEPS = [
    { key: 'NamespaceReady', label: 'Namespace' },
    { key: 'HelmInstalled', label: 'Helm' },
    { key: 'DatabaseReady', label: 'Database' },
    { key: 'BackendReady', label: 'Backend' },
    { key: 'StorefrontReady', label: 'Storefront' },
];

function StoreCard({ store, onDelete, expanded, onToggleExpand }) {
    const conditions = store.conditions || [];
    const activityLog = store.activityLog || [];
    const isProvisioning = store.phase === 'Provisioning';
    const isReady = store.phase === 'Ready';
    const isFailed = store.phase === 'Failed';

    const getConditionStatus = (type) => {
        const c = conditions.find(c => c.type === type);
        if (!c) return 'pending';
        return c.status === 'True' ? 'done' : 'active';
    };

    // Determine which pipeline steps are done/active/pending
    const pipelineState = PIPELINE_STEPS.map((step, idx) => {
        if (isReady) return 'done';
        if (isFailed) {
            const status = getConditionStatus(step.key);
            if (status === 'done') return 'done';
            // First non-done step is the failed one
            const prevDone = idx === 0 || PIPELINE_STEPS.slice(0, idx).every(
                s => getConditionStatus(s.key) === 'done'
            );
            return prevDone ? 'failed' : 'pending';
        }
        return getConditionStatus(step.key);
    });

    const phaseClass = {
        Ready: 'ready',
        Provisioning: 'provisioning',
        Failed: 'failed',
        Pending: 'pending',
        ComingSoon: 'coming-soon',
    }[store.phase] || 'pending';

    return (
        <div className="store-card" data-phase={store.phase} id={`store-${store.name}`}>
            <div className="store-card-header">
                <div className="store-card-identity">
                    <div className={`store-card-icon ${store.engine}`}>
                        {store.engine === 'medusa' ? 'M' : 'W'}
                    </div>
                    <div>
                        <div className="store-card-name">{store.name}</div>
                        <div className="store-card-meta">
                            <span>{store.engine}</span>
                            <span>·</span>
                            <span>{store.owner}</span>
                        </div>
                    </div>
                </div>
                <div className="store-card-actions">
                    <span className={`phase-badge ${phaseClass}`}>
                        {isProvisioning && <span className="spinner" />}
                        {store.phase}
                    </span>
                    <button
                        className="btn btn-danger btn-sm"
                        onClick={(e) => { e.stopPropagation(); onDelete(store.name); }}
                        id={`delete-${store.name}`}
                    >
                        ✕
                    </button>
                </div>
            </div>

            {/* Provisioning Pipeline */}
            {(isProvisioning || isReady || isFailed) && store.engine !== 'woocommerce' && (
                <div className="pipeline">
                    {PIPELINE_STEPS.map((step, idx) => (
                        <React.Fragment key={step.key}>
                            {idx > 0 && (
                                <div className={`pipeline-connector ${pipelineState[idx] === 'done' ? 'done' :
                                        pipelineState[idx] === 'active' ? 'active' : 'pending'
                                    }`} />
                            )}
                            <div className="pipeline-step">
                                <div className={`pipeline-step-icon ${pipelineState[idx]}`}>
                                    {pipelineState[idx] === 'done' ? '✓' :
                                        pipelineState[idx] === 'failed' ? '✕' :
                                            pipelineState[idx] === 'active' ? '◉' : '○'}
                                </div>
                                <span className={`pipeline-step-label ${pipelineState[idx]}`}>
                                    {step.label}
                                </span>
                            </div>
                        </React.Fragment>
                    ))}
                </div>
            )}

            {/* URLs (only when ready) */}
            {isReady && store.url && (
                <div className="store-card-urls">
                    <a href={store.url} target="_blank" rel="noopener noreferrer" className="store-card-url">
                        🌐 {store.url}
                    </a>
                    {store.adminUrl && (
                        <a href={store.adminUrl} target="_blank" rel="noopener noreferrer" className="store-card-url">
                            ⚙️ Admin
                        </a>
                    )}
                </div>
            )}

            {/* Message (failed/provisioning) */}
            {store.message && !isReady && (
                <div style={{
                    fontSize: '12px',
                    color: isFailed ? 'var(--accent-red)' : 'var(--text-muted)',
                    marginTop: '8px',
                    fontFamily: 'var(--font-mono)',
                }}>
                    {store.message}
                </div>
            )}

            {/* Activity Log Panel */}
            {activityLog.length > 0 && (
                <div className="activity-panel">
                    <div className="activity-panel-header" onClick={onToggleExpand}>
                        <h3>
                            📋 Activity Log
                            <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: '11px' }}>
                                ({activityLog.length} events)
                            </span>
                        </h3>
                        <span className={`activity-panel-toggle ${expanded ? 'open' : ''}`}>▼</span>
                    </div>
                    {expanded && (
                        <div className="activity-log">
                            {[...activityLog].reverse().map((entry, idx) => (
                                <ActivityEntry key={idx} entry={entry} />
                            ))}
                        </div>
                    )}
                </div>
            )}

            <div className="store-card-footer">
                <span className="store-card-timestamp">
                    {store.createdAt ? formatTime(store.createdAt) : '—'}
                </span>
                {store.retryCount > 0 && (
                    <span style={{ fontSize: '11px', color: 'var(--accent-yellow)' }}>
                        Retries: {store.retryCount}
                    </span>
                )}
            </div>
        </div>
    );
}

// ============================================================
// Activity Log Entry
// ============================================================
function ActivityEntry({ entry }) {
    const iconClass = getEventIconClass(entry.event);
    return (
        <div className="activity-entry">
            <span className="activity-entry-time">{formatTimeShort(entry.timestamp)}</span>
            <div className={`activity-entry-icon ${iconClass}`}>●</div>
            <div className="activity-entry-text">
                <span className="activity-entry-event">{entry.event}</span>
                {entry.message}
            </div>
        </div>
    );
}

function getEventIconClass(event) {
    if (!event) return 'info';
    if (event.includes('READY') || event.includes('HEALED') || event.includes('COMPLETE')) return 'success';
    if (event.includes('FAIL') || event.includes('ERROR') || event.includes('EXCEEDED')) return 'error';
    if (event.includes('DRIFT') || event.includes('WARN')) return 'warn';
    return 'info';
}

// ============================================================
// Create Store Modal
// ============================================================
function CreateStoreModal({ onClose, onCreate }) {
    const [name, setName] = useState('');
    const [engine, setEngine] = useState('medusa');
    const [creating, setCreating] = useState(false);
    const nameRef = useRef(null);

    useEffect(() => {
        nameRef.current?.focus();
    }, []);

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        setCreating(true);
        await onCreate(name.trim().toLowerCase(), engine);
        setCreating(false);
    };

    return (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
            <div className="modal">
                <div className="modal-header">
                    <h2>Create Store</h2>
                    <button className="modal-close" onClick={onClose}>✕</button>
                </div>
                <form className="modal-body" onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label className="form-label" htmlFor="store-name">Store Name</label>
                        <input
                            ref={nameRef}
                            id="store-name"
                            className="form-input"
                            type="text"
                            placeholder="my-store"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            pattern="^[a-z][a-z0-9-]*[a-z0-9]$"
                            minLength={2}
                            maxLength={40}
                            required
                        />
                        <div className="form-hint">Lowercase letters, numbers, and hyphens. Must start with a letter.</div>
                    </div>
                    <div className="form-group">
                        <label className="form-label" htmlFor="store-engine">Engine</label>
                        <select
                            id="store-engine"
                            className="form-select"
                            value={engine}
                            onChange={(e) => setEngine(e.target.value)}
                        >
                            <option value="medusa">MedusaJS — Full e-commerce platform</option>
                            <option value="woocommerce">WooCommerce — Coming soon</option>
                        </select>
                    </div>
                    <div className="modal-actions">
                        <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
                        <button
                            type="submit"
                            className="btn btn-primary"
                            disabled={creating || !name.trim()}
                            id="confirm-create-btn"
                        >
                            {creating ? 'Creating...' : 'Create Store'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}

// ============================================================
// Empty State
// ============================================================
function EmptyState({ onCreateClick }) {
    return (
        <div className="empty-state">
            <div className="empty-state-icon">🏪</div>
            <h3>No stores yet</h3>
            <p>Deploy your first e-commerce store in seconds. The operator will provision a namespace, database, backend, and storefront automatically.</p>
            <button className="btn btn-primary" onClick={onCreateClick}>
                + Create Your First Store
            </button>
        </div>
    );
}

// ============================================================
// Toast Container
// ============================================================
function ToastContainer({ toasts }) {
    return (
        <div className="toast-container">
            {toasts.map(t => (
                <div key={t.id} className={`toast ${t.type}`}>
                    <span className="toast-icon">
                        {t.type === 'success' ? '✓' : t.type === 'error' ? '✕' : 'ℹ'}
                    </span>
                    {t.message}
                </div>
            ))}
        </div>
    );
}

// ============================================================
// Utility
// ============================================================
function formatTime(isoStr) {
    try {
        const d = new Date(isoStr);
        return d.toLocaleString('en-US', {
            month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit',
        });
    } catch {
        return isoStr;
    }
}

function formatTimeShort(isoStr) {
    try {
        const d = new Date(isoStr);
        return d.toLocaleTimeString('en-US', {
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false,
        });
    } catch {
        return isoStr?.slice(11, 19) || '';
    }
}
