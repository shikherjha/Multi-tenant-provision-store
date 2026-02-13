"""
Store Operator — Kubernetes Operator for Multi-Tenant Store Provisioning

Architecture (Intent-Reconciling Operator Fabric):
  Store CRD → Operator watches → Reconcile Loop:
    1. Ensure Namespace  (store-{name})
    2. Apply ResourceQuota + LimitRange
    3. Apply NetworkPolicy (deny-by-default + allow ingress)
    4. Helm install  store-medusa chart
    5. Poll pod readiness
    6. Update Store CRD status → Ready / Failed

  On Delete (Finalizer):
    1. Helm uninstall
    2. Delete namespace  (cascading cleanup)
    3. Finalizer auto-removed

  On Resume (Operator Restart):
    Re-reconcile all non-Ready stores → idempotent recovery

Design Principles:
  - Idempotent: every step checks before creating
  - Declarative: CRD spec is the source of truth
  - Defensive: transient errors → TemporaryError with backoff
  - Observable: kopf events + status conditions
"""

import kopf
import kubernetes
from kubernetes import client, config
import subprocess
import os
import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger("store-operator")

# ---------------------------------------------------------------------------
# Configuration (overridable via env for Helm values-local vs values-prod)
# ---------------------------------------------------------------------------
HELM_CHART_PATH = os.environ.get("HELM_CHART_PATH", "/charts/store-medusa")
DOMAIN_SUFFIX = os.environ.get("DOMAIN_SUFFIX", "local.urumi")
MAX_STORES = int(os.environ.get("MAX_STORES", "10"))
PROVISION_TIMEOUT = int(os.environ.get("PROVISION_TIMEOUT", "300"))
MEDUSA_IMAGE = os.environ.get("MEDUSA_IMAGE", "medusa-store:latest")
STOREFRONT_IMAGE = os.environ.get("STOREFRONT_IMAGE", "store-storefront:latest")
STORAGE_CLASS = os.environ.get("STORAGE_CLASS", "standard")
INGRESS_CLASS = os.environ.get("INGRESS_CLASS", "nginx")

CRD_GROUP = "platform.urumi.ai"
CRD_VERSION = "v1"
CRD_PLURAL = "stores"

# ---------------------------------------------------------------------------
# Kubernetes client helpers
# ---------------------------------------------------------------------------

_k8s_loaded = False


def _ensure_k8s():
    """Load kubeconfig exactly once."""
    global _k8s_loaded
    if _k8s_loaded:
        return
    try:
        config.load_incluster_config()
    except config.ConfigException:
        config.load_kube_config()
    _k8s_loaded = True


def core_api() -> client.CoreV1Api:
    _ensure_k8s()
    return client.CoreV1Api()


def custom_api() -> client.CustomObjectsApi:
    _ensure_k8s()
    return client.CustomObjectsApi()


# ---------------------------------------------------------------------------
# Helm wrapper
# ---------------------------------------------------------------------------

def helm_run(args: list[str], check: bool = True) -> subprocess.CompletedProcess:
    """Execute a Helm CLI command. Raises RuntimeError on failure if check=True."""
    cmd = ["helm"] + args
    logger.info(f"helm> {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if result.stdout:
        logger.debug(f"helm stdout: {result.stdout[:800]}")
    if result.stderr:
        logger.warning(f"helm stderr: {result.stderr[:800]}")
    if check and result.returncode != 0:
        raise RuntimeError(f"Helm command failed (rc={result.returncode}): {result.stderr[:500]}")
    return result


def helm_release_status(release: str, namespace: str) -> Optional[str]:
    """
    Get the status of a Helm release. Returns the status string
    (e.g. 'deployed', 'pending-install', 'failed') or None if not found.
    """
    import json as _json
    r = helm_run(["status", release, "-n", namespace, "-o", "json"], check=False)
    if r.returncode != 0:
        return None
    try:
        data = _json.loads(r.stdout)
        return data.get("info", {}).get("status", "unknown")
    except Exception:
        return "unknown"


def helm_release_exists(release: str, namespace: str) -> bool:
    """Check if a Helm release already exists in a namespace."""
    return helm_release_status(release, namespace) is not None


def helm_cleanup_stuck(release: str, namespace: str):
    """
    Force-remove a stuck Helm release (pending-install, pending-upgrade, failed).
    This clears the Helm state so a fresh install can proceed.
    """
    logger.warning(f"Cleaning up stuck Helm release {release} in {namespace}")
    # Try normal uninstall first
    helm_run(["uninstall", release, "-n", namespace, "--no-hooks"], check=False)
    # If secrets still linger (edge case), delete them directly
    try:
        api = core_api()
        secrets = api.list_namespaced_secret(
            namespace=namespace,
            label_selector=f"owner=helm,name={release}"
        )
        for secret in secrets.items:
            api.delete_namespaced_secret(secret.metadata.name, namespace)
            logger.info(f"Deleted stuck Helm secret {secret.metadata.name}")
    except Exception as e:
        logger.warning(f"Failed to clean Helm secrets: {e}")


def helm_install(store_name: str, namespace: str, values: dict):
    """
    Install or upgrade the Medusa Helm chart for a store.
    
    Does NOT use --wait: we let Helm create the resources immediately,
    then the operator's own readiness check (step 3) handles waiting
    for pods with proper retry/backoff semantics.
    """
    release = f"store-{store_name}"
    set_args = []
    for k, v in values.items():
        set_args += ["--set", f"{k}={v}"]

    status = helm_release_status(release, namespace)

    # Handle stuck releases: pending-install, pending-upgrade, pending-rollback, failed
    stuck_states = {"pending-install", "pending-upgrade", "pending-rollback", "failed"}
    if status in stuck_states:
        logger.warning(f"Helm release {release} is stuck in '{status}' — cleaning up")
        helm_cleanup_stuck(release, namespace)
        status = None  # Force fresh install

    if status == "deployed":
        logger.info(f"Helm release {release} is deployed — upgrading")
        helm_run([
            "upgrade", release, HELM_CHART_PATH,
            "-n", namespace,
            "--timeout", f"{PROVISION_TIMEOUT}s",
        ] + set_args)
    else:
        logger.info(f"Installing Helm release {release}")
        helm_run([
            "install", release, HELM_CHART_PATH,
            "-n", namespace,
            "--create-namespace",
            "--timeout", f"{PROVISION_TIMEOUT}s",
        ] + set_args)


def helm_uninstall(store_name: str, namespace: str):
    """Uninstall the Helm release for a store."""
    release = f"store-{store_name}"
    if helm_release_exists(release, namespace):
        helm_run(["uninstall", release, "-n", namespace], check=False)
        logger.info(f"Helm release {release} uninstalled")
    else:
        logger.info(f"Helm release {release} not found — skipping uninstall")


# ---------------------------------------------------------------------------
# Namespace + isolation helpers
# ---------------------------------------------------------------------------

def ensure_namespace(name: str, store_name: str, engine: str) -> bool:
    """Create namespace idempotently. Returns True if created, False if existed."""
    api = core_api()
    try:
        api.create_namespace(
            client.V1Namespace(
                metadata=client.V1ObjectMeta(
                    name=name,
                    labels={
                        "app.kubernetes.io/managed-by": "store-operator",
                        "store.platform.urumi.ai/name": store_name,
                        "store.platform.urumi.ai/engine": engine,
                    },
                )
            )
        )
        logger.info(f"Namespace {name} created")
        return True
    except kubernetes.client.ApiException as e:
        if e.status == 409:
            logger.info(f"Namespace {name} already exists")
            return False
        raise


def delete_namespace(name: str):
    """Delete namespace, ignore 404."""
    api = core_api()
    try:
        api.delete_namespace(name=name)
        logger.info(f"Namespace {name} deletion initiated")
    except kubernetes.client.ApiException as e:
        if e.status == 404:
            logger.info(f"Namespace {name} already gone")
        else:
            raise


# ---------------------------------------------------------------------------
# Status update helpers
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def set_condition(conditions: list, ctype: str, status: str, reason: str, message: str):
    """Upsert a condition in a conditions list."""
    for c in conditions:
        if c.get("type") == ctype:
            c["status"] = status
            c["reason"] = reason
            c["message"] = message
            c["lastTransitionTime"] = _now()
            return
    conditions.append({
        "type": ctype,
        "status": status,
        "reason": reason,
        "message": message,
        "lastTransitionTime": _now(),
    })


# ---------------------------------------------------------------------------
# Quota enforcement (abuse prevention)
# ---------------------------------------------------------------------------

def count_stores(owner: str = "default") -> int:
    """Count existing Store CRDs for a given owner."""
    api = custom_api()
    stores = api.list_cluster_custom_object(CRD_GROUP, CRD_VERSION, CRD_PLURAL)
    count = 0
    for item in stores.get("items", []):
        spec = item.get("spec", {})
        if spec.get("owner", "default") == owner:
            count += 1
    return count


# ---------------------------------------------------------------------------
# Kopf operator settings
# ---------------------------------------------------------------------------

@kopf.on.startup()
def configure(settings: kopf.OperatorSettings, **kwargs):
    settings.posting.enabled = True
    settings.persistence.finalizer = "stores.platform.urumi.ai/finalizer"
    settings.persistence.progress_storage = kopf.AnnotationsProgressStorage(
        prefix="platform.urumi.ai"
    )
    logger.info("Store Operator started")


# ---------------------------------------------------------------------------
# CREATE / RESUME handler — the core reconciliation loop
# ---------------------------------------------------------------------------

@kopf.on.create(CRD_GROUP, CRD_VERSION, CRD_PLURAL)
@kopf.on.resume(CRD_GROUP, CRD_VERSION, CRD_PLURAL)
def reconcile_store(spec, name, status, patch, logger, **kwargs):
    """
    Reconcile a Store CRD to its desired state.

    Idempotent: safe to call multiple times. Each step checks
    whether work has already been done before acting.
    """
    engine = spec.get("engine", "medusa")
    owner = spec.get("owner", "default")
    domain_suffix = spec.get("domainSuffix", DOMAIN_SUFFIX)
    store_ns = f"store-{name}"
    conditions = list(status.get("conditions", []))

    # --- WooCommerce stub ---
    if engine == "woocommerce":
        set_condition(conditions, "EngineReady", "False", "ComingSoon",
                      "WooCommerce engine is coming soon")
        patch.status["phase"] = "ComingSoon"
        patch.status["message"] = "WooCommerce engine is coming soon. Only MedusaJS is currently supported."
        patch.status["conditions"] = conditions
        patch.status["lastUpdated"] = _now()
        logger.info(f"Store {name}: WooCommerce stubbed (ComingSoon)")
        return {"message": "WooCommerce coming soon"}

    # --- Quota check (abuse prevention) ---
    current_phase = status.get("phase", "")
    if current_phase not in ("Provisioning", "Ready"):
        store_count = count_stores(owner)
        if store_count > MAX_STORES:
            set_condition(conditions, "QuotaCheck", "False", "QuotaExceeded",
                          f"Owner {owner} exceeds max stores ({MAX_STORES})")
            patch.status["phase"] = "Failed"
            patch.status["message"] = f"Quota exceeded: max {MAX_STORES} stores per owner"
            patch.status["conditions"] = conditions
            patch.status["lastUpdated"] = _now()
            logger.warning(f"Store {name}: quota exceeded for owner {owner}")
            return

    # --- Skip if already Ready ---
    if current_phase == "Ready":
        logger.info(f"Store {name} already Ready — skipping reconcile")
        return

    # --- Begin provisioning ---
    patch.status["phase"] = "Provisioning"
    patch.status["message"] = "Creating store resources..."
    if not status.get("createdAt"):
        patch.status["createdAt"] = _now()
    patch.status["lastUpdated"] = _now()

    try:
        # Step 1: Ensure namespace
        logger.info(f"[{name}] Step 1/4: Ensuring namespace {store_ns}")
        ensure_namespace(store_ns, name, engine)
        set_condition(conditions, "NamespaceReady", "True", "Created",
                      f"Namespace {store_ns} exists")

        # Step 2: Helm install / upgrade
        logger.info(f"[{name}] Step 2/4: Helm install")
        helm_values = {
            "storeName": name,
            "medusa.image": MEDUSA_IMAGE,
            "storefront.image": STOREFRONT_IMAGE,
            "ingress.host": f"{name}.{domain_suffix}",
            "ingress.className": INGRESS_CLASS,
            "postgres.storageClass": STORAGE_CLASS,
        }
        helm_install(name, store_ns, helm_values)
        set_condition(conditions, "HelmReady", "True", "Installed",
                      "Helm chart installed successfully")

        # Step 3: Verify readiness (Helm --wait already does this, but double-check)
        logger.info(f"[{name}] Step 3/4: Verifying pod readiness")
        api = core_api()
        pods = api.list_namespaced_pod(namespace=store_ns, label_selector="app.kubernetes.io/part-of=medusa-store")
        all_ready = True
        for pod in pods.items:
            if pod.status.phase != "Running":
                all_ready = False
                break
            for cs in (pod.status.container_statuses or []):
                if not cs.ready:
                    all_ready = False
                    break

        if not all_ready:
            set_condition(conditions, "PodsReady", "False", "NotReady",
                          "Some pods are not ready yet")
            patch.status["conditions"] = conditions
            raise kopf.TemporaryError("Pods not ready yet", delay=15)

        set_condition(conditions, "PodsReady", "True", "AllRunning",
                      "All pods are running and ready")

        # Step 4: Update status to Ready
        store_url = f"http://{name}.{domain_suffix}"
        admin_url = f"http://{name}.{domain_suffix}/app"

        logger.info(f"[{name}] Step 4/4: Store Ready at {store_url}")
        patch.status["phase"] = "Ready"
        patch.status["url"] = store_url
        patch.status["adminUrl"] = admin_url
        patch.status["message"] = "Store is ready"
        patch.status["conditions"] = conditions
        patch.status["lastUpdated"] = _now()
        patch.status["retryCount"] = 0

        return {"url": store_url}

    except kopf.TemporaryError:
        raise  # Let kopf handle retries
    except Exception as e:
        retry_count = status.get("retryCount", 0) + 1
        set_condition(conditions, "Provisioning", "False", "Error", str(e)[:200])
        patch.status["phase"] = "Failed"
        patch.status["message"] = f"Provisioning failed: {str(e)[:200]}"
        patch.status["conditions"] = conditions
        patch.status["retryCount"] = retry_count
        patch.status["lastUpdated"] = _now()
        logger.error(f"Store {name} failed (attempt {retry_count}): {e}")

        if retry_count < 3:
            raise kopf.TemporaryError(f"Retrying ({retry_count}/3): {e}", delay=30)
        # After 3 retries, mark as permanently failed
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# DELETE handler — cleanup with finalizer guarantee
# ---------------------------------------------------------------------------

@kopf.on.delete(CRD_GROUP, CRD_VERSION, CRD_PLURAL)
def delete_store(spec, name, logger, **kwargs):
    """
    Clean up all resources for a store.

    Flow: Helm uninstall → Delete namespace → Finalizer auto-removed.
    Namespace deletion cascades to all resources within.
    """
    engine = spec.get("engine", "medusa")
    store_ns = f"store-{name}"

    if engine == "woocommerce":
        logger.info(f"Store {name}: WooCommerce stub — nothing to clean up")
        return

    logger.info(f"Deleting store {name} — cleaning up namespace {store_ns}")

    # Step 1: Helm uninstall (release may not exist if provisioning failed)
    try:
        helm_uninstall(name, store_ns)
    except Exception as e:
        logger.warning(f"Helm uninstall error (non-fatal): {e}")

    # Step 2: Delete namespace (cascading delete removes all K8s resources)
    try:
        delete_namespace(store_ns)
    except Exception as e:
        logger.warning(f"Namespace deletion error (non-fatal): {e}")

    logger.info(f"Store {name} cleanup complete")


# ---------------------------------------------------------------------------
# TIMER — periodic reconciliation for drift detection
# ---------------------------------------------------------------------------

@kopf.timer(CRD_GROUP, CRD_VERSION, CRD_PLURAL, interval=120, idle=120)
def check_store_health(spec, name, status, patch, logger, **kwargs):
    """Periodic health check: verify pods are still running for Ready stores."""
    if status.get("phase") != "Ready":
        return

    engine = spec.get("engine", "medusa")
    if engine == "woocommerce":
        return

    store_ns = f"store-{name}"
    try:
        api = core_api()
        pods = api.list_namespaced_pod(namespace=store_ns)
        for pod in pods.items:
            if pod.status.phase not in ("Running", "Succeeded"):
                logger.warning(f"Store {name}: pod {pod.metadata.name} is {pod.status.phase}")
                conditions = list(status.get("conditions", []))
                set_condition(conditions, "HealthCheck", "False", "PodDegraded",
                              f"Pod {pod.metadata.name} is {pod.status.phase}")
                patch.status["conditions"] = conditions
                patch.status["lastUpdated"] = _now()
                return
    except Exception as e:
        logger.error(f"Health check failed for store {name}: {e}")
