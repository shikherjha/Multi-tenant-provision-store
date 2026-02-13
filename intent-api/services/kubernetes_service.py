"""
Kubernetes service layer — abstracts all K8s API interactions for Store CRDs.

Design principles:
  - Idempotent: create checks if store exists before creating
  - Quota enforcement: per-owner and global limits
  - Clean error handling: translates K8s API exceptions to domain errors
"""

import logging
from typing import Optional
from datetime import datetime, timezone
from kubernetes import client, config
from kubernetes.client import ApiException

from config import settings
from models import StoreResponse, StoreCondition, ActivityLogEntry

logger = logging.getLogger("kubernetes_service")

_k8s_loaded = False


def _ensure_k8s():
    """Load Kubernetes config exactly once."""
    global _k8s_loaded
    if _k8s_loaded:
        return
    if settings.IN_CLUSTER:
        config.load_incluster_config()
    else:
        config.load_kube_config(config_file=settings.KUBECONFIG or None)
    _k8s_loaded = True


def _api() -> client.CustomObjectsApi:
    _ensure_k8s()
    return client.CustomObjectsApi()


def _parse_store(item: dict) -> StoreResponse:
    """Convert a raw K8s CRD dict into a StoreResponse model."""
    spec = item.get("spec", {})
    status = item.get("status", {})
    conditions = [
        StoreCondition(**c) for c in status.get("conditions", [])
    ]
    activity_log = [
        ActivityLogEntry(**a) for a in status.get("activityLog", [])
    ]
    return StoreResponse(
        name=item["metadata"]["name"],
        engine=spec.get("engine", "medusa"),
        owner=spec.get("owner", "default"),
        phase=status.get("phase", "Pending"),
        url=status.get("url"),
        adminUrl=status.get("adminUrl"),
        message=status.get("message", ""),
        createdAt=status.get("createdAt"),
        lastUpdated=status.get("lastUpdated"),
        retryCount=status.get("retryCount", 0),
        conditions=conditions,
        activityLog=activity_log,
    )


def list_stores(owner: Optional[str] = None) -> list[StoreResponse]:
    """List all Store CRDs, optionally filtered by owner."""
    api = _api()
    result = api.list_cluster_custom_object(
        settings.CRD_GROUP, settings.CRD_VERSION, settings.CRD_PLURAL
    )
    stores = [_parse_store(item) for item in result.get("items", [])]
    if owner:
        stores = [s for s in stores if s.owner == owner]
    return stores


def get_store(name: str) -> Optional[StoreResponse]:
    """Get a single Store CRD by name."""
    api = _api()
    try:
        item = api.get_cluster_custom_object(
            settings.CRD_GROUP, settings.CRD_VERSION, settings.CRD_PLURAL, name
        )
        return _parse_store(item)
    except ApiException as e:
        if e.status == 404:
            return None
        raise


def create_store(name: str, engine: str, owner: str) -> StoreResponse:
    """
    Create a Store CRD. Idempotent: returns existing store if already created.
    Raises ValueError for quota violations.
    """
    api = _api()

    # Idempotency check
    existing = get_store(name)
    if existing:
        logger.info(f"Store {name} already exists — returning existing (idempotent)")
        return existing

    # Quota enforcement — per-owner
    owner_stores = list_stores(owner=owner)
    if len(owner_stores) >= settings.MAX_STORES_PER_OWNER:
        raise ValueError(
            f"Quota exceeded: owner '{owner}' already has {len(owner_stores)}"
            f"/{settings.MAX_STORES_PER_OWNER} stores"
        )

    # Quota enforcement — global
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
                "store.platform.urumi.ai/owner": owner,
                "store.platform.urumi.ai/engine": engine,
            },
        },
        "spec": {
            "engine": engine,
            "owner": owner,
            "domainSuffix": settings.DOMAIN_SUFFIX,
        },
    }

    result = api.create_cluster_custom_object(
        settings.CRD_GROUP, settings.CRD_VERSION, settings.CRD_PLURAL, body
    )
    logger.info(f"Store {name} created (engine={engine}, owner={owner})")
    return _parse_store(result)


def delete_store(name: str) -> bool:
    """Delete a Store CRD. Returns True if deleted, False if not found."""
    api = _api()
    try:
        api.delete_cluster_custom_object(
            settings.CRD_GROUP, settings.CRD_VERSION, settings.CRD_PLURAL, name
        )
        logger.info(f"Store {name} deletion initiated")
        return True
    except ApiException as e:
        if e.status == 404:
            return False
        raise


def count_stores_by_phase() -> dict:
    """Count stores grouped by phase."""
    stores = list_stores()
    counts = {"total": len(stores), "Ready": 0, "Failed": 0, "Provisioning": 0, "Pending": 0, "ComingSoon": 0}
    for s in stores:
        phase = s.phase
        if phase in counts:
            counts[phase] += 1
    return counts
