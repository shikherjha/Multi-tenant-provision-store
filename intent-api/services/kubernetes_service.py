"""
Kubernetes Service — abstracts all interactions with the K8s API.
Provides CRUD for Store CRDs with idempotency and error handling.
"""
import logging
from typing import List, Optional
from kubernetes import client, config
from kubernetes.client import ApiException
from config import settings
from models import StoreResponse, StoreCondition

logger = logging.getLogger("k8s-service")

_loaded = False


def _ensure_loaded():
    global _loaded
    if _loaded:
        return
    if settings.IN_CLUSTER:
        config.load_incluster_config()
    else:
        config.load_kube_config()
    _loaded = True


def _custom_api() -> client.CustomObjectsApi:
    _ensure_loaded()
    return client.CustomObjectsApi()


def _parse_store(item: dict) -> StoreResponse:
    """Parse a Store CRD dict into a StoreResponse model."""
    spec = item.get("spec", {})
    status = item.get("status", {})
    metadata = item.get("metadata", {})

    conditions = []
    for c in status.get("conditions", []):
        conditions.append(StoreCondition(
            type=c.get("type", ""),
            status=c.get("status", "Unknown"),
            reason=c.get("reason", ""),
            message=c.get("message", ""),
            lastTransitionTime=c.get("lastTransitionTime"),
        ))

    return StoreResponse(
        name=metadata.get("name", ""),
        engine=spec.get("engine", "medusa"),
        phase=status.get("phase", "Pending"),
        url=status.get("url"),
        adminUrl=status.get("adminUrl"),
        message=status.get("message"),
        createdAt=status.get("createdAt") or metadata.get("creationTimestamp"),
        lastUpdated=status.get("lastUpdated"),
        owner=spec.get("owner", "default"),
        conditions=conditions,
    )


def list_stores(owner: Optional[str] = None) -> List[StoreResponse]:
    """List all Store CRDs, optionally filtered by owner."""
    api = _custom_api()
    result = api.list_cluster_custom_object(
        group=settings.CRD_GROUP,
        version=settings.CRD_VERSION,
        plural=settings.CRD_PLURAL,
    )
    stores = []
    for item in result.get("items", []):
        store = _parse_store(item)
        if owner and store.owner != owner:
            continue
        stores.append(store)
    return stores


def get_store(name: str) -> Optional[StoreResponse]:
    """Get a single Store CRD by name."""
    api = _custom_api()
    try:
        item = api.get_cluster_custom_object(
            group=settings.CRD_GROUP,
            version=settings.CRD_VERSION,
            plural=settings.CRD_PLURAL,
            name=name,
        )
        return _parse_store(item)
    except ApiException as e:
        if e.status == 404:
            return None
        raise


def create_store(name: str, engine: str, owner: str = "default") -> StoreResponse:
    """
    Create a Store CRD. Idempotent: returns existing store if already present.
    Raises ValueError if quota exceeded.
    """
    api = _custom_api()

    # Idempotency check
    existing = get_store(name)
    if existing:
        logger.info(f"Store {name} already exists — returning existing")
        return existing

    # Quota check
    owner_stores = [s for s in list_stores() if s.owner == owner]
    if len(owner_stores) >= settings.MAX_STORES_PER_OWNER:
        raise ValueError(
            f"Quota exceeded: owner '{owner}' already has "
            f"{len(owner_stores)}/{settings.MAX_STORES_PER_OWNER} stores"
        )

    all_stores = list_stores()
    if len(all_stores) >= settings.MAX_STORES_GLOBAL:
        raise ValueError(
            f"Global quota exceeded: {len(all_stores)}/{settings.MAX_STORES_GLOBAL} stores"
        )

    # Create CRD
    body = {
        "apiVersion": f"{settings.CRD_GROUP}/{settings.CRD_VERSION}",
        "kind": "Store",
        "metadata": {
            "name": name,
            "labels": {
                "store.platform.urumi.ai/engine": engine,
                "store.platform.urumi.ai/owner": owner,
            },
        },
        "spec": {
            "engine": engine,
            "version": "latest",
            "domainSuffix": settings.DOMAIN_SUFFIX,
            "owner": owner,
        },
    }

    try:
        result = api.create_cluster_custom_object(
            group=settings.CRD_GROUP,
            version=settings.CRD_VERSION,
            plural=settings.CRD_PLURAL,
            body=body,
        )
        logger.info(f"Store CRD {name} created")
        return _parse_store(result)
    except ApiException as e:
        if e.status == 409:
            # Race condition: another request created it first
            logger.info(f"Store {name} already exists (409) — returning existing")
            return get_store(name)
        raise


def delete_store(name: str) -> bool:
    """
    Delete a Store CRD. The operator handles cleanup via finalizer.
    Returns True if deleted, False if not found.
    """
    api = _custom_api()
    try:
        api.delete_cluster_custom_object(
            group=settings.CRD_GROUP,
            version=settings.CRD_VERSION,
            plural=settings.CRD_PLURAL,
            name=name,
        )
        logger.info(f"Store CRD {name} deletion initiated")
        return True
    except ApiException as e:
        if e.status == 404:
            logger.info(f"Store {name} not found — already deleted")
            return False
        raise
