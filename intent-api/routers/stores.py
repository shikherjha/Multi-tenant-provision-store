"""
Store router — REST endpoints for Store CRD lifecycle.
Provides validation, rate limiting, audit logging, and WebSocket status streaming.
"""
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect, Request
from slowapi import Limiter
from slowapi.util import get_remote_address

from models import (
    StoreCreateRequest,
    StoreResponse,
    StoreListResponse,
    AuditLogEntry,
)
from services.kubernetes_service import (
    create_store,
    list_stores,
    get_store,
    delete_store,
)
from config import settings

logger = logging.getLogger("stores-router")
router = APIRouter(prefix="/api/stores", tags=["stores"])

# In-memory audit log (would be Redis/DB in production)
audit_log: list[AuditLogEntry] = []

limiter = Limiter(key_func=get_remote_address)


def _audit(action: str, store_name: str, engine: str, owner: str, result: str, detail: str = ""):
    entry = AuditLogEntry(
        timestamp=datetime.now(timezone.utc).isoformat(),
        action=action,
        store_name=store_name,
        engine=engine,
        owner=owner,
        result=result,
        detail=detail,
    )
    audit_log.append(entry)
    if len(audit_log) > 1000:  # Ring buffer
        audit_log.pop(0)
    logger.info(f"AUDIT: {action} {store_name} ({engine}) by {owner} → {result}")


@router.post("", response_model=StoreResponse, status_code=201)
@limiter.limit(settings.RATE_LIMIT)
async def create_store_endpoint(req: StoreCreateRequest, request: Request):
    """
    Create a new store. Idempotent: if store already exists, returns it.
    Rate limited and quota-enforced.
    """
    try:
        store = create_store(
            name=req.name,
            engine=req.engine.value,
            owner=req.owner,
        )
        _audit("CREATE", req.name, req.engine.value, req.owner, "SUCCESS")
        return store
    except ValueError as e:
        _audit("CREATE", req.name, req.engine.value, req.owner, "FAILED", str(e))
        raise HTTPException(status_code=429, detail=str(e))
    except Exception as e:
        _audit("CREATE", req.name, req.engine.value, req.owner, "FAILED", str(e))
        logger.error(f"Failed to create store {req.name}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to create store: {str(e)}")


@router.get("", response_model=StoreListResponse)
async def list_stores_endpoint(owner: Optional[str] = None):
    """List all stores, optionally filtered by owner."""
    try:
        stores = list_stores(owner=owner)
        return StoreListResponse(stores=stores, total=len(stores))
    except Exception as e:
        logger.error(f"Failed to list stores: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to list stores: {str(e)}")


@router.get("/{name}", response_model=StoreResponse)
async def get_store_endpoint(name: str):
    """Get details of a specific store."""
    store = get_store(name)
    if not store:
        raise HTTPException(status_code=404, detail=f"Store '{name}' not found")
    return store


@router.delete("/{name}", status_code=200)
@limiter.limit(settings.RATE_LIMIT)
async def delete_store_endpoint(name: str, request: Request):
    """
    Delete a store. The operator handles cleanup via finalizer.
    """
    try:
        existing = get_store(name)
        if not existing:
            raise HTTPException(status_code=404, detail=f"Store '{name}' not found")

        deleted = delete_store(name)
        _audit("DELETE", name, existing.engine, existing.owner,
               "SUCCESS" if deleted else "NOT_FOUND")
        return {"message": f"Store '{name}' deletion initiated", "deleted": deleted}
    except HTTPException:
        raise
    except Exception as e:
        _audit("DELETE", name, "unknown", "unknown", "FAILED", str(e))
        logger.error(f"Failed to delete store {name}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to delete store: {str(e)}")


@router.get("/audit/log")
async def get_audit_log(limit: int = 50):
    """Get recent audit log entries."""
    return {"entries": audit_log[-limit:], "total": len(audit_log)}


# --- WebSocket for real-time status ---
connected_clients: set[WebSocket] = set()


@router.websocket("/ws")
async def store_status_ws(websocket: WebSocket):
    """
    WebSocket endpoint for real-time store status updates.
    Clients connect here and receive periodic store list updates.
    """
    await websocket.accept()
    connected_clients.add(websocket)
    logger.info(f"WebSocket client connected (total: {len(connected_clients)})")
    try:
        while True:
            # Send current store list every 3 seconds
            try:
                stores = list_stores()
                await websocket.send_json({
                    "type": "store_list",
                    "stores": [s.model_dump() for s in stores],
                    "total": len(stores),
                })
            except Exception as e:
                logger.error(f"Error sending WS update: {e}")

            # Wait for 3 seconds or a client message
            import asyncio
            try:
                await asyncio.wait_for(websocket.receive_text(), timeout=3.0)
            except asyncio.TimeoutError:
                pass  # Normal — just send next update
    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected")
    finally:
        connected_clients.discard(websocket)
