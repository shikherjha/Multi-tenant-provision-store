import React, { useState, useEffect, useCallback, useRef } from 'react';

// ============================================================
// Configuration
// ============================================================
const API_BASE = '/api/stores';
const WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/stores/ws`;
const POLL_INTERVAL = 4000;

// ============================================================
// MVP Owner
// ============================================================
const ACTIVE_USER = { id: 'you', name: 'You', email: 'you@storeos.io', avatar: 'Y', color: '#10b981' };

// ============================================================
// Pipeline Steps Definition
// ============================================================
const PIPELINE_STEPS = [
    { key: 'NamespaceReady', label: 'Namespace' },
    { key: 'HelmInstalled', label: 'Helm' },
    { key: 'DatabaseReady', label: 'Database' },
    { key: 'BackendReady', label: 'Backend' },
    { key: 'StorefrontReady', label: 'Storefront' },
];

// ============================================================
// Main App — Sidebar + Page Router
// ============================================================
export default function App() {
    const [stores, setStores] = useState([]);
    const [loading, setLoading] = useState(true);
    const [page, setPage] = useState('dashboard');
    const [selectedStore, setSelectedStore] = useState(null);
    const [showModal, setShowModal] = useState(false);
    const [toasts, setToasts] = useState([]);
    const [wsConnected, setWsConnected] = useState(false);
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const wsRef = useRef(null);
    const pollRef = useRef(null);

    // ---- Toast management ----
    const addToast = useCallback((message, type = 'info') => {
        const id = Date.now();
        setToasts(prev => [...prev, { id, message, type }]);
        setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
    }, []);

    // ---- API headers with user identity ----
    const apiHeaders = useCallback(() => ({
        'Content-Type': 'application/json',
        'X-User-Id': ACTIVE_USER.id,
    }), []);

    // ---- Fetch stores (scoped to the MVP owner via X-User-Id header) ----
    const fetchStores = useCallback(async () => {
        try {
            const res = await fetch(API_BASE, {
                headers: { 'X-User-Id': ACTIVE_USER.id },
            });
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
                    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
                };
                ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        if (data.type === 'store_list') {
                            setStores(data.stores || []);
                        } else if (data.store) {
                            fetchStores();
                        }
                    } catch (e) { console.debug('WS parse error:', e); }
                };
                ws.onclose = () => {
                    setWsConnected(false);
                    wsRef.current = null;
                    if (!pollRef.current) pollRef.current = setInterval(fetchStores, POLL_INTERVAL);
                    reconnectTimer = setTimeout(connect, 5000);
                };
                ws.onerror = () => ws.close();
            } catch (e) {
                console.debug('WS connection failed:', e);
                if (!pollRef.current) pollRef.current = setInterval(fetchStores, POLL_INTERVAL);
            }
        };

        fetchStores();
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
                headers: apiHeaders(),
                body: JSON.stringify({ name, engine, owner: ACTIVE_USER.id }),
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
            const res = await fetch(`${API_BASE}/${name}`, {
                method: 'DELETE',
                headers: { 'X-User-Id': ACTIVE_USER.id },
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.detail || `HTTP ${res.status}`);
            }
            addToast(`Store "${name}" deletion initiated`, 'info');
            if (selectedStore === name) { setSelectedStore(null); setPage('stores'); }
            fetchStores();
        } catch (err) {
            addToast(err.message, 'error');
        }
    };

    // ---- Navigate to store detail ----
    const openStoreDetail = (storeName) => {
        setSelectedStore(storeName);
        setPage('store-detail');
    };

    // ---- Computed stats ----
    const stats = {
        total: stores.length,
        ready: stores.filter(s => s.phase === 'Ready').length,
        provisioning: stores.filter(s => s.phase === 'Provisioning').length,
        failed: stores.filter(s => s.phase === 'Failed').length,
    };

    const currentStore = selectedStore ? stores.find(s => s.name === selectedStore) : null;

    // ---- Render ----
    return (
        <div className="app-layout">
            <Sidebar
                page={page}
                onNavigate={(p) => { setPage(p); setSelectedStore(null); }}
                collapsed={sidebarCollapsed}
                onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
                currentUser={ACTIVE_USER}
            />
            <div className="app-main">
                {page === 'dashboard' && (
                    <DashboardPage
                        stores={stores}
                        stats={stats}
                        loading={loading}
                        onViewAll={() => setPage('stores')}
                        onStoreClick={openStoreDetail}
                    />
                )}
                {page === 'stores' && (
                    <StoresPage
                        stores={stores}
                        loading={loading}
                        onCreateClick={() => setShowModal(true)}
                        onStoreClick={openStoreDetail}
                        onDelete={handleDelete}
                    />
                )}
                {page === 'store-detail' && currentStore && (
                    <StoreDetailPage
                        store={currentStore}
                        onBack={() => setPage('stores')}
                        onDelete={handleDelete}
                    />
                )}
                {page === 'settings' && <SettingsPage currentUser={ACTIVE_USER} />}
            </div>
            {showModal && (
                <CreateStoreModal
                    onClose={() => setShowModal(false)}
                    onCreate={handleCreate}
                    currentUser={ACTIVE_USER}
                />
            )}
            <ToastContainer toasts={toasts} />
        </div>
    );
}

// ============================================================
// Sidebar
// ============================================================
function Sidebar({ page, onNavigate, collapsed, onToggle, currentUser }) {
    const navItems = [
        { id: 'dashboard', label: 'Dashboard', icon: 'D' },
        { id: 'stores', label: 'Stores', icon: 'S' },
        { id: 'settings', label: 'Settings', icon: 'G' },
    ];

    return (
        <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
            <div className="sidebar-header">
                <div className="sidebar-brand" onClick={() => onNavigate('dashboard')}>
                    <div className="sidebar-logo">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                            <circle cx="12" cy="12" r="10" />
                            <path d="M12 6v6l4 2" />
                        </svg>
                    </div>
                    {!collapsed && <span className="sidebar-brand-text">storeOS</span>}
                </div>
            </div>
            <nav className="sidebar-nav">
                {navItems.map(item => (
                    <button
                        key={item.id}
                        className={`sidebar-nav-item ${page === item.id || (page === 'store-detail' && item.id === 'stores') ? 'active' : ''}`}
                        onClick={() => onNavigate(item.id)}
                        title={collapsed ? item.label : undefined}
                    >
                        <span className="sidebar-nav-icon">{item.icon}</span>
                        {!collapsed && <span className="sidebar-nav-label">{item.label}</span>}
                    </button>
                ))}
            </nav>
            <div className="sidebar-footer">
                <button className="sidebar-collapse-btn" onClick={onToggle}>
                    {collapsed ? '>' : '<'}
                </button>
                <div className="sidebar-user">
                    <div
                        className="sidebar-user-avatar"
                        style={{ background: currentUser.color }}
                    >
                        {currentUser.avatar}
                    </div>
                    {!collapsed && (
                        <div className="sidebar-user-info">
                            <div className="sidebar-user-name">{currentUser.name}</div>
                            <div className="sidebar-user-email">{currentUser.email}</div>
                        </div>
                    )}
                </div>
            </div>
        </aside>
    );
}

// ============================================================
// Dashboard Page
// ============================================================
function DashboardPage({ stores, stats, loading, onViewAll, onStoreClick }) {
    const recentStores = [...stores].sort((a, b) => {
        const ta = a.createdAt || '';
        const tb = b.createdAt || '';
        return tb.localeCompare(ta);
    }).slice(0, 5);

    // Build cluster activity from all stores' activity logs
    const clusterActivity = stores.flatMap(s =>
        (s.activityLog || []).map(e => ({ ...e, storeName: s.name }))
    ).sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || '')).slice(0, 8);

    return (
        <div className="page">
            <div className="page-title-section">
                <div>
                    <h1>Overview</h1>
                    <p className="page-subtitle">
                        Your store provisioning cluster
                    </p>
                </div>
            </div>

            {/* Stats Cards */}
            <div className="stats-row">
                <StatCard label="TOTAL STORES" value={stats.total} icon="⊞" />
                <StatCard label="READY" value={stats.ready} icon="□" color="green" />
                <StatCard label="PROVISIONING" value={stats.provisioning} icon="⟳" color="cyan" />
                <StatCard label="FAILED" value={stats.failed} icon="⊘" color="red" />
            </div>

            {/* Two-column: Recent Stores + Cluster Activity */}
            <div className="dashboard-grid">
                <div className="dashboard-card">
                    <div className="dashboard-card-header">
                        <h2>Recent Stores</h2>
                        <button className="link-btn" onClick={onViewAll}>View all ›</button>
                    </div>
                    <div className="dashboard-card-body">
                        {loading ? (
                            <div className="loading-inline"><div className="loading-spinner-sm" /> Loading...</div>
                        ) : recentStores.length === 0 ? (
                            <div className="empty-inline">No stores created yet</div>
                        ) : (
                            recentStores.map(store => (
                                <div key={store.name} className="recent-store-row" onClick={() => onStoreClick(store.name)}>
                                    <div className="recent-store-icon">
                                        <span className={`engine-icon ${store.engine}`}>
                                            {store.engine === 'medusa' ? '⬡' : 'W'}
                                        </span>
                                    </div>
                                    <div className="recent-store-info">
                                        <div className="recent-store-name">{store.name}</div>
                                        <div className="recent-store-meta">
                                            {store.engine} · {store.owner || 'default'}
                                        </div>
                                    </div>
                                    <PhaseBadge phase={store.phase} />
                                </div>
                            ))
                        )}
                    </div>
                </div>

                <div className="dashboard-card">
                    <div className="dashboard-card-header">
                        <h2>Cluster Activity</h2>
                    </div>
                    <div className="dashboard-card-body activity-feed">
                        {clusterActivity.length === 0 ? (
                            <div className="empty-inline">No recent activity</div>
                        ) : (
                            clusterActivity.map((entry, idx) => (
                                <div key={idx} className="activity-feed-item">
                                    <div className="activity-feed-store">{entry.storeName}</div>
                                    <div className="activity-feed-body">
                                        <EventBadge event={entry.event} />
                                        <span className="activity-feed-msg">{entry.message}</span>
                                    </div>
                                    <div className="activity-feed-time">{formatRelativeTime(entry.timestamp)}</div>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

function StatCard({ label, value, icon, color }) {
    return (
        <div className="stat-card">
            <div className="stat-card-top">
                <span className="stat-card-label">{label}</span>
                <span className={`stat-card-icon ${color || ''}`}>{icon}</span>
            </div>
            <div className={`stat-card-value ${color || ''}`}>{value}</div>
        </div>
    );
}

// ============================================================
// Stores Page — Grid of Store Cards
// ============================================================
function StoresPage({ stores, loading, onCreateClick, onStoreClick, onDelete }) {
    const [search, setSearch] = useState('');

    const filtered = stores.filter(s =>
        s.name.toLowerCase().includes(search.toLowerCase())
    );

    return (
        <div className="page">
            <div className="page-title-section">
                <div>
                    <h1>Stores</h1>
                    <p className="page-subtitle">Manage your provisioned e-commerce instances</p>
                </div>
                <button className="btn btn-primary" onClick={onCreateClick} id="create-store-btn">
                    <span className="btn-icon">+</span> New Store
                </button>
            </div>

            <div className="search-bar">
                <span className="search-icon">⌕</span>
                <input
                    type="text"
                    placeholder="Search stores..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="search-input"
                />
            </div>

            {loading ? (
                <div className="loading-container">
                    <div className="loading-spinner" />
                    <div className="loading-text">Loading stores...</div>
                </div>
            ) : filtered.length === 0 ? (
                stores.length === 0 ? (
                    <EmptyState onCreateClick={onCreateClick} />
                ) : (
                    <div className="empty-inline">No stores match "{search}"</div>
                )
            ) : (
                <div className="stores-grid">
                    {filtered.map(store => (
                        <StoreGridCard
                            key={store.name}
                            store={store}
                            onClick={() => onStoreClick(store.name)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function StoreGridCard({ store, onClick }) {
    const pipelineState = getPipelineState(store);

    return (
        <div className="store-grid-card" data-phase={store.phase} onClick={onClick} id={`store-${store.name}`}>
            <div className="store-grid-card-header">
                <div>
                    <div className="store-grid-card-name">{store.name}</div>
                    <div className="store-grid-card-ns">store-{store.name}</div>
                </div>
                <PhaseBadge phase={store.phase} />
            </div>

            {(store.phase === 'Provisioning' || store.phase === 'Ready' || store.phase === 'Failed') && store.engine !== 'woocommerce' && (
                <div className="pipeline-dots">
                    <span className="pipeline-label">PIPELINE</span>
                    <div className="pipeline-dots-row">
                        {PIPELINE_STEPS.map((step, idx) => (
                            <React.Fragment key={step.key}>
                                <div
                                    className={`pipeline-dot ${pipelineState[idx]}`}
                                    title={`${step.label}: ${pipelineState[idx]}`}
                                />
                                {idx < PIPELINE_STEPS.length - 1 && (
                                    <div className={`pipeline-dot-line ${pipelineState[idx] === 'done' && pipelineState[idx + 1] !== 'pending' ? 'done' : 'pending'}`} />
                                )}
                            </React.Fragment>
                        ))}
                    </div>
                </div>
            )}

            <div className="store-grid-card-footer">
                <span className="store-grid-card-engine">
                    <span className={`engine-dot ${store.engine}`} /> {capitalize(store.engine)}
                </span>
                <span className="store-grid-card-region">
                    ⊕ {store.owner || 'default'}
                </span>
            </div>
        </div>
    );
}

// ============================================================
// Store Detail Page
// ============================================================
function StoreDetailPage({ store, onBack, onDelete }) {
    const pipelineState = getPipelineState(store);
    const activityLog = store.activityLog || [];

    return (
        <div className="page">
            {/* Breadcrumb */}
            <div className="breadcrumb">
                <button className="breadcrumb-link" onClick={onBack}>Stores</button>
                <span className="breadcrumb-sep">›</span>
                <span className="breadcrumb-current">{store.name}</span>
            </div>

            {/* Store Header */}
            <div className="detail-header">
                <div className="detail-header-left">
                    <h1 className="detail-name">{store.name}</h1>
                    <PhaseBadge phase={store.phase} />
                </div>
                <div className="detail-header-right">
                    {store.url && (
                        <a href={store.url} target="_blank" rel="noopener noreferrer" className="btn btn-outline">
                            ⊕ Storefront
                        </a>
                    )}
                    {store.adminUrl && (
                        <a href={store.adminUrl} target="_blank" rel="noopener noreferrer" className="btn btn-outline">
                            ⚙ Admin
                        </a>
                    )}
                    <button
                        className="btn btn-danger-outline"
                        onClick={() => onDelete(store.name)}
                        id={`delete-${store.name}`}
                    >
                        ⊗ Delete
                    </button>
                </div>
            </div>

            <div className="detail-ns">store-{store.name}</div>

            {/* Provisioning Pipeline */}
            {store.engine !== 'woocommerce' && (
                <div className="detail-section">
                    <div className="detail-section-label">PROVISIONING PIPELINE</div>
                    <div className="pipeline-stepper">
                        {PIPELINE_STEPS.map((step, idx) => (
                            <React.Fragment key={step.key}>
                                {idx > 0 && (
                                    <div className={`pipeline-stepper-line ${
                                        pipelineState[idx] === 'done' || pipelineState[idx - 1] === 'done' ? 'done' :
                                        pipelineState[idx] === 'active' ? 'active' : 'pending'
                                    }`} />
                                )}
                                <div className="pipeline-stepper-step">
                                    <div className={`pipeline-stepper-circle ${pipelineState[idx]}`}>
                                        {pipelineState[idx] === 'done' ? (
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                                <polyline points="20 6 9 17 4 12" />
                                            </svg>
                                        ) : pipelineState[idx] === 'failed' ? '✕' : pipelineState[idx] === 'active' ? (
                                            <div className="stepper-spinner" />
                                        ) : ''}
                                    </div>
                                    <span className={`pipeline-stepper-label ${pipelineState[idx]}`}>{step.label}</span>
                                </div>
                            </React.Fragment>
                        ))}
                    </div>
                </div>
            )}

            {/* Two columns: Config + Events */}
            <div className="detail-grid">
                <div className="detail-card">
                    <h3 className="detail-card-title">Configuration</h3>
                    <div className="detail-table">
                        <DetailRow label="Engine" value={capitalize(store.engine)} />
                        <DetailRow label="Owner" value={store.owner || 'default'} />
                        <DetailRow label="Created" value={store.createdAt ? formatTime(store.createdAt) : '—'} />
                        <DetailRow label="Events" value={`${activityLog.length} Events`} />
                    </div>
                </div>

                <div className="detail-card">
                    <div className="detail-card-header-row">
                        <h3 className="detail-card-title">
                            <span className="detail-card-title-icon">⟩_</span> cluster-events.log
                        </h3>
                        <span className="detail-card-badge">{activityLog.length} events</span>
                    </div>
                    <div className="event-log">
                        {[...activityLog].reverse().map((entry, idx) => (
                            <div key={idx} className="event-log-entry">
                                <span className="event-log-time">{formatTimeShort(entry.timestamp)}</span>
                                <EventBadge event={entry.event} />
                                <span className="event-log-msg">{entry.message}</span>
                            </div>
                        ))}
                        {activityLog.length === 0 && (
                            <div className="empty-inline">No events yet</div>
                        )}
                    </div>
                </div>
            </div>

            {/* Error message if failed */}
            {store.phase === 'Failed' && store.message && (
                <div className="detail-error">
                    <strong>Error:</strong> {store.message}
                </div>
            )}
        </div>
    );
}

function DetailRow({ label, value }) {
    return (
        <div className="detail-row">
            <span className="detail-row-label">{label}</span>
            <span className="detail-row-value">{value}</span>
        </div>
    );
}

// ============================================================
// Settings Page
// ============================================================
function SettingsPage({ currentUser }) {
    return (
        <div className="page">
            <div className="page-title-section">
                <h1>Settings</h1>
                <p className="page-subtitle">Platform configuration</p>
            </div>
            <div className="detail-card" style={{ maxWidth: 600 }}>
                <h3 className="detail-card-title">Cluster Configuration</h3>
                <div className="detail-table">
                    <DetailRow label="Platform" value="storeOS v2.0" />
                    <DetailRow label="Backend" value="MedusaJS v2 (Full)" />
                    <DetailRow label="Operator" value="kopf (Python)" />
                    <DetailRow label="Ingress" value="Traefik (k3s)" />
                    <DetailRow label="Storage" value="Cloudflare R2" />
                    <DetailRow label="DNS" value="NIP.IO Wildcard" />
                    <DetailRow label="Current User" value={`${currentUser.name} (${currentUser.id})`} />
                </div>
            </div>
        </div>
    );
}

// ============================================================
// Create Store Modal
// ============================================================
function CreateStoreModal({ onClose, onCreate, currentUser }) {
    const [name, setName] = useState('');
    const [engine, setEngine] = useState('medusa');
    const [creating, setCreating] = useState(false);
    const nameRef = useRef(null);

    useEffect(() => { nameRef.current?.focus(); }, []);

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
                            <option value="medusa">MedusaJS v2 — Full e-commerce platform</option>
                            <option value="woocommerce">WooCommerce — Coming soon</option>
                        </select>
                    </div>
                    <div className="form-group">
                        <label className="form-label">Owner</label>
                        <input className="form-input" type="text" value={currentUser.name} disabled />
                        <div className="form-hint">Stores are scoped to the currently selected user.</div>
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
// Shared Components
// ============================================================
function PhaseBadge({ phase }) {
    const cls = {
        Ready: 'ready', Provisioning: 'provisioning', Failed: 'failed',
        Pending: 'pending', ComingSoon: 'coming-soon',
    }[phase] || 'pending';

    return (
        <span className={`phase-badge ${cls}`}>
            {phase === 'Provisioning' && <span className="spinner" />}
            {phase === 'Ready' && <span className="phase-dot ready" />}
            {phase === 'Failed' && <span className="phase-dot failed" />}
            {phase}
        </span>
    );
}

function EventBadge({ event }) {
    let cls = 'info';
    if (!event) return null;
    if (event.includes('READY') || event.includes('HEALED') || event.includes('COMPLETE')) cls = 'success';
    else if (event.includes('FAIL') || event.includes('ERROR') || event.includes('EXCEEDED')) cls = 'error';
    else if (event.includes('DRIFT') || event.includes('WARN')) cls = 'warn';
    else if (event.includes('DB_') || event.includes('HELM_') || event.includes('NAMESPACE_')) cls = 'info';

    return <span className={`event-badge ${cls}`}>{event}</span>;
}

function EmptyState({ onCreateClick }) {
    return (
        <div className="empty-state">
            <div className="empty-state-icon">⊞</div>
            <h3>No stores yet</h3>
            <p>Deploy your first e-commerce store in seconds. The operator will provision a namespace, database, backend, and storefront automatically.</p>
            <button className="btn btn-primary" onClick={onCreateClick}>
                + Create Your First Store
            </button>
        </div>
    );
}

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
// Utility Functions
// ============================================================
function getPipelineState(store) {
    const conditions = store.conditions || [];
    const isReady = store.phase === 'Ready';
    const isFailed = store.phase === 'Failed';

    const getConditionStatus = (type) => {
        const c = conditions.find(c => c.type === type);
        if (!c) return 'pending';
        return c.status === 'True' ? 'done' : 'active';
    };

    return PIPELINE_STEPS.map((step, idx) => {
        if (isReady) return 'done';
        if (isFailed) {
            const status = getConditionStatus(step.key);
            if (status === 'done') return 'done';
            const prevDone = idx === 0 || PIPELINE_STEPS.slice(0, idx).every(
                s => getConditionStatus(s.key) === 'done'
            );
            return prevDone ? 'failed' : 'pending';
        }
        return getConditionStatus(step.key);
    });
}

function capitalize(s) {
    if (!s) return '';
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatTime(isoStr) {
    try {
        const d = new Date(isoStr);
        return d.toLocaleString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
        });
    } catch { return isoStr; }
}

function formatTimeShort(isoStr) {
    try {
        const d = new Date(isoStr);
        return d.toLocaleTimeString('en-US', {
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false,
        });
    } catch { return isoStr?.slice(11, 19) || ''; }
}

function formatRelativeTime(isoStr) {
    if (!isoStr) return '';
    try {
        const d = new Date(isoStr);
        const now = new Date();
        const diff = Math.floor((now - d) / 1000);
        if (diff < 60) return `${diff}s ago`;
        if (diff < 3600) return `${Math.floor(diff / 60)} minutes ago`;
        if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
        return `${Math.floor(diff / 86400)} days ago`;
    } catch { return ''; }
}
