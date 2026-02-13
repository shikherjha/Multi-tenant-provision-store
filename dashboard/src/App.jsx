import { useState, useEffect, useCallback, useRef } from 'react'

const API_BASE = '/api/stores'

// ========== API Layer ==========
async function apiCall(path, opts = {}) {
    const res = await fetch(`${API_BASE}${path}`, {
        headers: { 'Content-Type': 'application/json', ...opts.headers },
        ...opts,
    })
    if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(err.detail || `API error ${res.status}`)
    }
    return res.json()
}

// ========== Toast System ==========
function ToastContainer({ toasts, onDismiss }) {
    return (
        <div className="toast-container">
            {toasts.map((t) => (
                <div key={t.id} className={`toast toast--${t.type}`} onClick={() => onDismiss(t.id)}>
                    <span>{t.type === 'success' ? '✓' : t.type === 'error' ? '✕' : 'ℹ'}</span>
                    <span>{t.message}</span>
                </div>
            ))}
        </div>
    )
}

// ========== Status Badge ==========
function StatusBadge({ phase }) {
    const key = (phase || 'pending').toLowerCase()
    return (
        <span className={`status-badge status-badge--${key}`}>
            <span className="status-badge__dot" />
            {phase || 'Pending'}
        </span>
    )
}

// ========== Store Card ==========
function StoreCard({ store, onDelete }) {
    const [deleting, setDeleting] = useState(false)

    const handleDelete = async () => {
        if (!confirm(`Delete store "${store.name}"? All resources will be cleaned up.`)) return
        setDeleting(true)
        try {
            await onDelete(store.name)
        } finally {
            setDeleting(false)
        }
    }

    const timeAgo = (dateStr) => {
        if (!dateStr) return '—'
        const diff = Date.now() - new Date(dateStr).getTime()
        const mins = Math.floor(diff / 60000)
        if (mins < 1) return 'just now'
        if (mins < 60) return `${mins}m ago`
        const hrs = Math.floor(mins / 60)
        if (hrs < 24) return `${hrs}h ago`
        return `${Math.floor(hrs / 24)}d ago`
    }

    return (
        <div className="store-card">
            <div className="store-card__header">
                <div>
                    <div className="store-card__name">{store.name}</div>
                    <span className="store-card__engine">{store.engine}</span>
                </div>
                <StatusBadge phase={store.phase} />
            </div>

            <div className="store-card__details">
                {store.url && (
                    <div className="store-card__detail">
                        <span className="store-card__detail-label">Store URL</span>
                        <span className="store-card__detail-value">
                            <a href={store.url} target="_blank" rel="noopener noreferrer">{store.url}</a>
                        </span>
                    </div>
                )}
                {store.adminUrl && (
                    <div className="store-card__detail">
                        <span className="store-card__detail-label">Admin</span>
                        <span className="store-card__detail-value">
                            <a href={store.adminUrl} target="_blank" rel="noopener noreferrer">{store.adminUrl}</a>
                        </span>
                    </div>
                )}
                <div className="store-card__detail">
                    <span className="store-card__detail-label">Created</span>
                    <span className="store-card__detail-value">{timeAgo(store.createdAt)}</span>
                </div>
                <div className="store-card__detail">
                    <span className="store-card__detail-label">Owner</span>
                    <span className="store-card__detail-value">{store.owner}</span>
                </div>
            </div>

            {store.message && (
                <div className="store-card__message">{store.message}</div>
            )}

            <div className="store-card__actions">
                {store.url && store.phase === 'Ready' && (
                    <a href={store.url} target="_blank" rel="noopener noreferrer" className="btn btn--ghost">
                        🌐 Open Store
                    </a>
                )}
                {store.adminUrl && store.phase === 'Ready' && (
                    <a href={store.adminUrl} target="_blank" rel="noopener noreferrer" className="btn btn--ghost">
                        ⚙️ Admin
                    </a>
                )}
                <button
                    className={`btn btn--danger ${deleting ? 'btn--disabled' : ''}`}
                    onClick={handleDelete}
                    disabled={deleting}
                >
                    {deleting ? '⏳ Deleting...' : '🗑 Delete'}
                </button>
            </div>
        </div>
    )
}

// ========== Create Store Modal ==========
function CreateStoreModal({ onClose, onCreate }) {
    const [name, setName] = useState('')
    const [engine, setEngine] = useState('medusa')
    const [owner, setOwner] = useState('default')
    const [error, setError] = useState('')
    const [creating, setCreating] = useState(false)
    const inputRef = useRef(null)

    useEffect(() => {
        inputRef.current?.focus()
    }, [])

    const validate = () => {
        if (!name || name.length < 3) return 'Name must be at least 3 characters'
        if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(name)) return 'Name must be lowercase alphanumeric with hyphens'
        if (name.length > 30) return 'Name must be 30 characters or less'
        return ''
    }

    const handleSubmit = async (e) => {
        e.preventDefault()
        const err = validate()
        if (err) { setError(err); return }
        setCreating(true)
        setError('')
        try {
            await onCreate({ name, engine, owner })
            onClose()
        } catch (e) {
            setError(e.message)
        } finally {
            setCreating(false)
        }
    }

    return (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
            <div className="modal">
                <div className="modal__header">
                    <h2 className="modal__title">Create New Store</h2>
                    <button className="modal__close" onClick={onClose}>✕</button>
                </div>
                <form onSubmit={handleSubmit}>
                    <div className="modal__body">
                        <div className="form-group">
                            <label className="form-group__label">Store Name</label>
                            <input
                                ref={inputRef}
                                className="form-group__input"
                                type="text"
                                placeholder="my-awesome-store"
                                value={name}
                                onChange={(e) => { setName(e.target.value.toLowerCase()); setError('') }}
                                disabled={creating}
                            />
                            <p className="form-group__hint">Lowercase, alphanumeric with hyphens (3-30 chars)</p>
                        </div>

                        <div className="form-group">
                            <label className="form-group__label">E-commerce Engine</label>
                            <div className="engine-select">
                                <div
                                    className={`engine-option ${engine === 'medusa' ? 'engine-option--selected' : ''}`}
                                    onClick={() => setEngine('medusa')}
                                >
                                    <div className="engine-option__icon">🟣</div>
                                    <div className="engine-option__name">MedusaJS</div>
                                </div>
                                <div className="engine-option engine-option--disabled">
                                    <div className="engine-option__badge">Coming Soon</div>
                                    <div className="engine-option__icon">🔵</div>
                                    <div className="engine-option__name">WooCommerce</div>
                                </div>
                            </div>
                        </div>

                        <div className="form-group">
                            <label className="form-group__label">Owner (for quota tracking)</label>
                            <input
                                className="form-group__input"
                                type="text"
                                value={owner}
                                onChange={(e) => setOwner(e.target.value)}
                                disabled={creating}
                            />
                        </div>

                        {error && <p className="form-group__error">⚠ {error}</p>}
                    </div>

                    <div className="modal__footer">
                        <button type="button" className="btn btn--ghost" onClick={onClose} disabled={creating}>
                            Cancel
                        </button>
                        <button type="submit" className={`btn btn--primary ${creating ? 'btn--disabled' : ''}`} disabled={creating}>
                            {creating ? '⏳ Creating...' : '🚀 Create Store'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    )
}

// ========== Main App ==========
export default function App() {
    const [stores, setStores] = useState([])
    const [loading, setLoading] = useState(true)
    const [showCreateModal, setShowCreateModal] = useState(false)
    const [toasts, setToasts] = useState([])
    const [wsConnected, setWsConnected] = useState(false)
    const wsRef = useRef(null)
    const toastIdRef = useRef(0)

    // Toast helper
    const addToast = useCallback((type, message) => {
        const id = ++toastIdRef.current
        setToasts((prev) => [...prev, { id, type, message }])
        setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000)
    }, [])

    const dismissToast = useCallback((id) => {
        setToasts((prev) => prev.filter((t) => t.id !== id))
    }, [])

    // Fetch stores (fallback polling)
    const fetchStores = useCallback(async () => {
        try {
            const data = await apiCall('')
            setStores(data.stores || [])
        } catch (e) {
            console.error('Failed to fetch stores:', e)
        } finally {
            setLoading(false)
        }
    }, [])

    // WebSocket connection
    useEffect(() => {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const wsUrl = `${protocol}//${window.location.host}/api/stores/ws`

        function connect() {
            const ws = new WebSocket(wsUrl)
            wsRef.current = ws

            ws.onopen = () => {
                setWsConnected(true)
                console.log('WebSocket connected')
            }

            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data)
                    if (data.type === 'store_list') {
                        setStores(data.stores || [])
                        setLoading(false)
                    }
                } catch (e) {
                    console.error('WS message parse error:', e)
                }
            }

            ws.onclose = () => {
                setWsConnected(false)
                // Reconnect after 5 seconds
                setTimeout(connect, 5000)
            }

            ws.onerror = () => {
                ws.close()
            }
        }

        connect()
        // Fallback: poll every 5 seconds if WS fails
        fetchStores()
        const interval = setInterval(fetchStores, 5000)

        return () => {
            clearInterval(interval)
            wsRef.current?.close()
        }
    }, [fetchStores])

    // Create store
    const handleCreate = async ({ name, engine, owner }) => {
        const data = await apiCall('', {
            method: 'POST',
            body: JSON.stringify({ name, engine, owner }),
        })
        addToast('success', `Store "${name}" creation initiated!`)
        fetchStores()
        return data
    }

    // Delete store
    const handleDelete = async (name) => {
        try {
            await apiCall(`/${name}`, { method: 'DELETE' })
            addToast('info', `Store "${name}" deletion initiated`)
            fetchStores()
        } catch (e) {
            addToast('error', `Failed to delete "${name}": ${e.message}`)
        }
    }

    // Stats
    const totalStores = stores.length
    const readyStores = stores.filter((s) => s.phase === 'Ready').length
    const provisioningStores = stores.filter((s) => s.phase === 'Provisioning').length
    const failedStores = stores.filter((s) => s.phase === 'Failed').length

    return (
        <>
            {/* Header */}
            <header className="header">
                <div className="header__brand">
                    <div className="header__logo">S</div>
                    <div>
                        <div className="header__title">Store Platform</div>
                        <div className="header__subtitle">Kubernetes-Native Provisioning</div>
                    </div>
                </div>
                <div className="header__actions">
                    <div className="header__status">
                        <span className={`header__dot`} style={{ background: wsConnected ? '#06d6a0' : '#f59e0b' }} />
                        <span>{wsConnected ? 'Live' : 'Polling'}</span>
                    </div>
                    <button className="btn btn--primary" onClick={() => setShowCreateModal(true)}>
                        ✦ Create Store
                    </button>
                </div>
            </header>

            {/* Main */}
            <main className="main">
                <div className="main__header">
                    <div>
                        <h1 className="main__title">Your Stores</h1>
                        <p className="main__desc">Manage your provisioned e-commerce stores</p>
                    </div>
                </div>

                {/* Stats */}
                <div className="stats">
                    <div className="stat-card">
                        <div className="stat-card__value">{totalStores}</div>
                        <div className="stat-card__label">Total Stores</div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-card__value" style={{ background: 'linear-gradient(135deg, #06d6a0, #3b82f6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>{readyStores}</div>
                        <div className="stat-card__label">Ready</div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-card__value" style={{ background: 'linear-gradient(135deg, #3b82f6, #7c3aed)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>{provisioningStores}</div>
                        <div className="stat-card__label">Provisioning</div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-card__value" style={{ background: 'linear-gradient(135deg, #ef4444, #f59e0b)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>{failedStores}</div>
                        <div className="stat-card__label">Failed</div>
                    </div>
                </div>

                {/* Store List */}
                {loading ? (
                    <div className="loading-spinner">
                        <div className="spinner" />
                        <span>Loading stores...</span>
                    </div>
                ) : stores.length === 0 ? (
                    <div className="empty-state">
                        <div className="empty-state__icon">🏪</div>
                        <div className="empty-state__title">No stores yet</div>
                        <p className="empty-state__desc">
                            Create your first store to get started. Each store gets its own isolated Kubernetes namespace
                            with PostgreSQL, Medusa backend, and a storefront.
                        </p>
                        <button className="btn btn--primary" onClick={() => setShowCreateModal(true)}>
                            ✦ Create Your First Store
                        </button>
                    </div>
                ) : (
                    <div className="store-grid">
                        {stores.map((store) => (
                            <StoreCard key={store.name} store={store} onDelete={handleDelete} />
                        ))}
                    </div>
                )}
            </main>

            {/* Create Modal */}
            {showCreateModal && (
                <CreateStoreModal
                    onClose={() => setShowCreateModal(false)}
                    onCreate={handleCreate}
                />
            )}

            {/* Toasts */}
            <ToastContainer toasts={toasts} onDismiss={dismissToast} />
        </>
    )
}
