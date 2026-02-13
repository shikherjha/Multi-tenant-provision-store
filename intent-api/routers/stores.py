"""
Store API routes — CRUD endpoints for Store CRDs.

Features:
  - Identity layer: X-User-Id header for multi-user awareness
  - Rate limiting per-IP via slowapi
  - Prometheus metrics exposition
  - Redis Stream integration for real-time activity log
  - WebSocket endpoint for dashboard live updates
  - Audit logging (in-memory ring buffer)
"""

import logging
import json
import asyncio
from datetime import datetime, timezone
from typing import Optional
from collections import deque

from fastapi import APIRouter, HTTPException, Query, Request, WebSocket, WebSocketDisconnect, Header
from slowapi import Limiter
from slowapi.util import get_remote_address

from config import settings
from models import (
    StoreCreateRequest, StoreResponse, StoreListResponse,
    ErrorResponse, AuditLogEntry,
)
from services.kubernetes_service import (
    list_stores, get_store, create_store, delete_store, count_stores_by_phase,
)

logger = logging.getLogger("stores")

router = APIRouter(prefix="/stores", tags=["stores"])
limiter = Limiter(key_func=get_remote_address)

# --- Audit log (in-memory ring buffer) ---
_audit_log: deque[dict] = deque(maxlen=50)


def _audit(action: str, store_name: str, engine: str, owner: str,
           result: str, detail: str = "", user_id: str = "anonymous"):
    entry = {
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "action": action,
        "store_name": store_name,
        "engine": engine,
        "owner": owner,
        "user_id": user_id,
        "result": result,
        "detail": detail,
    }
    _audit_log.append(entry)
    logger.info(f"AUDIT: {action} {store_name} by {user_id} -> {result}")


# --- Redis client (optional) ---
_redis_client = None


def _get_redis():
    """Lazy-init Redis. Returns None if unavailable."""
    global _redis_client
    if _redis_client is not None:
        return _redis_client
    if not settings.REDIS_URL:
        return None
    try:
        import redis
        _redis_client = redis.Redis.from_url(settings.REDIS_URL, decode_responses=True)
        _redis_client.ping()
        logger.info(f"Redis connected: {settings.REDIS_URL}")
        return _redis_client
    except Exception as e:
        logger.warning(f"Redis unavailable (non-fatal): {e}")
        _redis_client = None
        return None


# --- Identity extraction ---
def _get_user_id(request: Request) -> str:
    """
    Extract user identity from X-User-Id header.
    Falls back to 'anonymous' if not provided.
    Used for multi-user awareness and quota scoping.
    """
    return request.headers.get("x-user-id", "anonymous")


# --- Prometheus metrics ---
_metrics_initialized = False


def _init_metrics():
    """Initialize Prometheus metrics (called once on first /metrics request)."""
    global _metrics_initialized
    if _metrics_initialized:
        return
    try:
        from prometheus_client import Counter, Gauge, Info
        global STORES_CREATED, STORES_DELETED, PROVISION_FAILURES, STORES_TOTAL
        STORES_CREATED = Counter(
            "store_platform_stores_created_total",
            "Total stores created",
            ["engine", "owner"]
        )
        STORES_DELETED = Counter(
            "store_platform_stores_deleted_total",
            "Total stores deleted",
        )
        PROVISION_FAILURES = Counter(
            "store_platform_provisioning_failures_total",
            "Total provisioning failures (observed by API)",
        )
        STORES_TOTAL = Gauge(
            "store_platform_stores_total",
            "Current total stores",
            ["phase"]
        )
        _metrics_initialized = True
    except ImportError:
        logger.warning("prometheus_client not installed — metrics disabled")


def _record_create(engine: str, owner: str):
    if _metrics_initialized:
        STORES_CREATED.labels(engine=engine, owner=owner).inc()


def _record_delete():
    if _metrics_initialized:
        STORES_DELETED.inc()


def _record_failure():
    if _metrics_initialized:
        PROVISION_FAILURES.inc()


def _update_gauges():
    if _metrics_initialized:
        counts = count_stores_by_phase()
        for phase in ["Ready", "Failed", "Provisioning", "Pending", "ComingSoon"]:
            STORES_TOTAL.labels(phase=phase).set(counts.get(phase, 0))


# =========================================================================
# REST Endpoints
# =========================================================================

@router.post("", response_model=StoreResponse, status_code=201,
             responses={429: {"model": ErrorResponse}, 500: {"model": ErrorResponse}})
@limiter.limit(settings.RATE_LIMIT)
async def create_store_endpoint(req: StoreCreateRequest, request: Request):
    """Create a new store. Idempotent — returns existing store if name matches."""
    user_id = _get_user_id(request)
    # Scope owner to user_id for multi-user isolation
    owner = req.owner if req.owner != "default" else user_id
    try:
        store = create_store(
            name=req.name,
            engine=req.engine.value,
            owner=owner,
        )
        _audit("CREATE", req.name, req.engine.value, owner, "SUCCESS", user_id=user_id)
        _record_create(req.engine.value, owner)
        return store
    except ValueError as e:
        _audit("CREATE", req.name, req.engine.value, owner, "QUOTA_EXCEEDED", str(e), user_id)
        raise HTTPException(status_code=429, detail=str(e))
    except Exception as e:
        _audit("CREATE", req.name, req.engine.value, owner, "FAILED", str(e), user_id)
        _record_failure()
        logger.error(f"Failed to create store {req.name}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to create store: {str(e)}")


@router.get("", response_model=StoreListResponse)
@limiter.limit(settings.RATE_LIMIT)
async def list_stores_endpoint(
    request: Request,
    owner: Optional[str] = Query(None, description="Filter by owner"),
):
    """List all stores, optionally filtered by owner."""
    user_id = _get_user_id(request)
    # If user is identified, scope to their stores by default
    effective_owner = owner if owner else (user_id if user_id != "anonymous" else None)
    stores = list_stores(owner=effective_owner)
    return StoreListResponse(stores=stores, total=len(stores))


@router.get("/{store_name}", response_model=StoreResponse,
             responses={404: {"model": ErrorResponse}})
@limiter.limit(settings.RATE_LIMIT)
async def get_store_endpoint(store_name: str, request: Request):
    """Get a specific store by name."""
    store = get_store(store_name)
    if not store:
        raise HTTPException(status_code=404, detail=f"Store '{store_name}' not found")
    return store


@router.delete("/{store_name}", status_code=202,
                responses={404: {"model": ErrorResponse}})
@limiter.limit(settings.RATE_LIMIT)
async def delete_store_endpoint(store_name: str, request: Request):
    """Delete a store. Returns 202 Accepted (async deletion)."""
    user_id = _get_user_id(request)
    deleted = delete_store(store_name)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Store '{store_name}' not found")
    _audit("DELETE", store_name, "", "", "ACCEPTED", user_id=user_id)
    _record_delete()
    return {"message": f"Store '{store_name}' deletion initiated", "status": "accepted"}


@router.get("/{store_name}/logs")
@limiter.limit(settings.RATE_LIMIT)
async def get_store_logs(store_name: str, request: Request):
    """
    Get activity log for a store.
    Sources: CRD status (always available) + Redis Stream (if connected).
    """
    store = get_store(store_name)
    if not store:
        raise HTTPException(status_code=404, detail=f"Store '{store_name}' not found")

    logs = [a.model_dump() for a in store.activityLog]

    # Try to supplement from Redis Stream
    r = _get_redis()
    if r:
        try:
            stream_key = f"store:events:{store_name}"
            entries = r.xrange(stream_key, count=50)
            for entry_id, entry_data in entries:
                logs.append({
                    "timestamp": entry_data.get("timestamp", ""),
                    "event": entry_data.get("type", ""),
                    "message": entry_data.get("message", ""),
                    "source": "redis",
                })
        except Exception as e:
            logger.debug(f"Redis stream read failed: {e}")

    return {"store": store_name, "logs": logs}


# --- Audit endpoint ---
@router.get("/audit/log")
@limiter.limit(settings.RATE_LIMIT)
async def get_audit_log(request: Request):
    """Get the platform audit log (last 50 entries)."""
    return {"entries": list(_audit_log), "count": len(_audit_log)}


# =========================================================================
# WebSocket — real-time store events
# =========================================================================

@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """
    WebSocket for real-time store events.

    Priority: Redis PubSub > Polling fallback
    Client receives JSON events: { store, type, message, phase, timestamp }
    """
    await websocket.accept()
    logger.info("WebSocket client connected")

    r = _get_redis()

    if r:
        # Redis-backed real-time events
        try:
            import redis as redis_lib
            pubsub = r.pubsub()
            pubsub.subscribe("store:events")

            while True:
                message = pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if message and message["type"] == "message":
                    await websocket.send_text(message["data"])
                else:
                    # Heartbeat to detect disconnected clients
                    try:
                        await asyncio.wait_for(
                            websocket.receive_text(), timeout=0.1
                        )
                    except asyncio.TimeoutError:
                        pass  # No message from client — keep running
                await asyncio.sleep(0.5)
        except WebSocketDisconnect:
            logger.info("WebSocket client disconnected (Redis mode)")
        except Exception as e:
            logger.error(f"WebSocket error: {e}")
        finally:
            try:
                pubsub.unsubscribe()
            except Exception:
                pass
    else:
        # Polling fallback (sends full store list every 3s)
        try:
            while True:
                try:
                    stores = list_stores()
                    data = {
                        "type": "store_list",
                        "stores": [s.model_dump() for s in stores],
                        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    }
                    await websocket.send_text(json.dumps(data))
                except Exception as e:
                    logger.warning(f"WebSocket poll error: {e}")
                await asyncio.sleep(3)
        except WebSocketDisconnect:
            logger.info("WebSocket client disconnected (polling mode)")
