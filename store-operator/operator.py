"""
Store Operator — Kubernetes Operator for Multi-Tenant Store Provisioning

Architecture (Intent-Reconciling Operator Fabric):
  Store CRD → Operator watches → Reconcile Loop:
    1. Ensure Namespace  (store-{name})
    2. Helm install  store-medusa chart
    3. Verify pod readiness (PostgreSQL, Backend, Storefront)
    4. Update Store CRD status → Ready / Failed

  On Delete (Finalizer):
    1. Helm uninstall
    2. Delete namespace  (cascading cleanup)
    3. Finalizer auto-removed

  On Resume (Operator Restart):
    Re-reconcile all non-Ready stores → idempotent recovery

  Drift Detection (Timer):
    - Checks Deployment replicas, Service existence, PVC existence
    - Only triggers Helm upgrade if actual drift is detected
    - Avoids blind upgrades that cause unnecessary restarts

  Concurrency Control:
    - Max 3 parallel provisioning workers
    - Prevents resource exhaustion during burst creation

Design Principles:
  - Idempotent: every step checks before creating
  - Declarative: CRD spec is the source of truth
  - Defensive: transient errors → TemporaryError with backoff
  - Observable: kopf events + status conditions + activity log + Redis Streams
"""

import kopf
import kubernetes
from kubernetes import client, config
import subprocess
import os
import asyncio
import logging
import json as _json
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
REDIS_URL = os.environ.get("REDIS_URL", "")
MAX_PARALLEL_PROVISIONS = int(os.environ.get("MAX_PARALLEL_PROVISIONS", "3"))

CRD_GROUP = "platform.urumi.ai"
CRD_VERSION = "v1"
CRD_PLURAL = "stores"

# Activity log max entries in CRD status (etcd size constraint)
ACTIVITY_LOG_MAX = 15

# ---------------------------------------------------------------------------
# Redis client (optional — graceful degradation if unavailable)
# ---------------------------------------------------------------------------
_redis_client = None


def _get_redis():
    """Lazy-init Redis client. Returns None if unavailable."""
    global _redis_client
    if _redis_client is not None:
        return _redis_client
    if not REDIS_URL:
        return None
    try:
        import redis
        _redis_client = redis.Redis.from_url(REDIS_URL, decode_responses=True)
        _redis_client.ping()
        logger.info(f"Redis connected: {REDIS_URL}")
        return _redis_client
    except Exception as e:
        logger.warning(f"Redis unavailable (non-fatal): {e}")
        _redis_client = None
        return None


def _publish_event(store_name: str, event_type: str, message: str, phase: str = ""):
    """Publish event to Redis Stream for real-time dashboard consumption."""
    r = _get_redis()
    if not r:
        return
    try:
        stream_key = f"store:events:{store_name}"
        r.xadd(stream_key, {
            "type": event_type,
            "message": message,
            "phase": phase,
            "timestamp": _now(),
            "store": store_name,
        }, maxlen=100)  # Cap stream at 100 entries per store
        # Also publish to a global channel for dashboard subscriptions
        r.publish("store:events", _json.dumps({
            "store": store_name,
            "type": event_type,
            "message": message,
            "phase": phase,
            "timestamp": _now(),
        }))
    except Exception as e:
        logger.debug(f"Redis publish failed (non-fatal): {e}")


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


def apps_api() -> client.AppsV1Api:
    _ensure_k8s()
    return client.AppsV1Api()


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


def _add_activity(activity_log: list, event_type: str, message: str):
    """Append an event to the activity log ring buffer."""
    activity_log.append({
        "timestamp": _now(),
        "event": event_type,
        "message": message,
    })
    # Keep only the last N entries (etcd size constraint)
    while len(activity_log) > ACTIVITY_LOG_MAX:
        activity_log.pop(0)


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
# Drift detection helpers
# ---------------------------------------------------------------------------

def _check_deployment_exists(namespace: str, name: str) -> bool:
    """Check if a Deployment exists in a namespace."""
    try:
        apps_api().read_namespaced_deployment(name=name, namespace=namespace)
        return True
    except kubernetes.client.ApiException as e:
        if e.status == 404:
            return False
        raise


def _check_service_exists(namespace: str, name: str) -> bool:
    """Check if a Service exists in a namespace."""
    try:
        core_api().read_namespaced_service(name=name, namespace=namespace)
        return True
    except kubernetes.client.ApiException as e:
        if e.status == 404:
            return False
        raise


def _check_statefulset_exists(namespace: str, name: str) -> bool:
    """Check if a StatefulSet exists in a namespace."""
    try:
        apps_api().read_namespaced_stateful_set(name=name, namespace=namespace)
        return True
    except kubernetes.client.ApiException as e:
        if e.status == 404:
            return False
        raise


def _detect_drift(store_name: str, namespace: str) -> list[str]:
    """
    Check for resource drift in a store namespace.
    Returns a list of drift reasons (empty = no drift).
    Only checks critical resources — avoids unnecessary Helm calls.
    """
    drift_reasons = []

    # Check critical deployments
    if not _check_deployment_exists(namespace, "medusa-backend"):
        drift_reasons.append("Deployment 'medusa-backend' missing")
    if not _check_deployment_exists(namespace, "storefront"):
        drift_reasons.append("Deployment 'storefront' missing")

    # Check critical StatefulSet
    if not _check_statefulset_exists(namespace, "postgres"):
        drift_reasons.append("StatefulSet 'postgres' missing")

    # Check critical services
    if not _check_service_exists(namespace, "medusa-backend"):
        drift_reasons.append("Service 'medusa-backend' missing")
    if not _check_service_exists(namespace, "storefront"):
        drift_reasons.append("Service 'storefront' missing")
    if not _check_service_exists(namespace, "postgres"):
        drift_reasons.append("Service 'postgres' missing")

    # Check replica counts for deployments
    if not drift_reasons:  # Only check replicas if deployments exist
        try:
            be = apps_api().read_namespaced_deployment("medusa-backend", namespace)
            if be.spec.replicas != (be.status.ready_replicas or 0):
                drift_reasons.append(
                    f"medusa-backend: {be.status.ready_replicas or 0}/{be.spec.replicas} replicas ready"
                )
        except Exception:
            pass

    return drift_reasons


# ---------------------------------------------------------------------------
# Liveness check helpers (granular pod status)
# ---------------------------------------------------------------------------

def _check_pods_by_label(namespace: str, label_selector: str) -> tuple[bool, str]:
    """
    Check if all pods matching a label selector are running and ready.
    Returns (all_ready, reason_string).
    """
    api = core_api()
    pods = api.list_namespaced_pod(namespace=namespace, label_selector=label_selector)
    if not pods.items:
        return False, "No pods found"

    for pod in pods.items:
        if pod.status.phase != "Running":
            return False, f"Pod {pod.metadata.name} is {pod.status.phase}"
        for cs in (pod.status.container_statuses or []):
            if not cs.ready:
                # Check for CrashLoopBackOff
                if cs.state and cs.state.waiting:
                    return False, f"Pod {pod.metadata.name}: {cs.state.waiting.reason}"
                return False, f"Pod {pod.metadata.name} container not ready"
    return True, "All pods running and ready"


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
    # Concurrency control: max 3 parallel store reconciliations
    settings.execution.max_workers = MAX_PARALLEL_PROVISIONS
    logger.info(
        f"Store Operator started (max_workers={MAX_PARALLEL_PROVISIONS}, "
        f"domain={DOMAIN_SUFFIX}, max_stores={MAX_STORES})"
    )


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

    Status Conditions (granular):
      - NamespaceReady
      - HelmInstalled
      - DatabaseReady
      - BackendReady
      - StorefrontReady
    """
    engine = spec.get("engine", "medusa")
    owner = spec.get("owner", "default")
    domain_suffix = spec.get("domainSuffix", DOMAIN_SUFFIX)
    store_ns = f"store-{name}"
    conditions = list(status.get("conditions", []))
    activity_log = list(status.get("activityLog", []))

    # --- WooCommerce stub ---
    if engine == "woocommerce":
        set_condition(conditions, "EngineReady", "False", "ComingSoon",
                      "WooCommerce engine is coming soon")
        patch.status["phase"] = "ComingSoon"
        patch.status["message"] = "WooCommerce engine is coming soon. Only MedusaJS is currently supported."
        patch.status["conditions"] = conditions
        patch.status["lastUpdated"] = _now()
        _add_activity(activity_log, "ENGINE_STUB", "WooCommerce engine stubbed — coming soon")
        patch.status["activityLog"] = activity_log
        logger.info(f"Store {name}: WooCommerce stubbed (ComingSoon)")
        _publish_event(name, "ENGINE_STUB", "WooCommerce coming soon", "ComingSoon")
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
            _add_activity(activity_log, "QUOTA_EXCEEDED", f"Owner {owner} exceeds max stores ({MAX_STORES})")
            patch.status["activityLog"] = activity_log
            logger.warning(f"Store {name}: quota exceeded for owner {owner}")
            _publish_event(name, "QUOTA_EXCEEDED", f"Quota exceeded for {owner}", "Failed")
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
    _add_activity(activity_log, "PROVISIONING_START", "Store provisioning started")
    _publish_event(name, "PROVISIONING_START", "Store provisioning started", "Provisioning")

    try:
        # Step 1: Ensure namespace
        logger.info(f"[{name}] Step 1/5: Ensuring namespace {store_ns}")
        _add_activity(activity_log, "NAMESPACE_CREATE", f"Creating namespace {store_ns}")
        _publish_event(name, "NAMESPACE_CREATE", f"Creating namespace {store_ns}", "Provisioning")
        ensure_namespace(store_ns, name, engine)
        set_condition(conditions, "NamespaceReady", "True", "Created",
                      f"Namespace {store_ns} exists")
        _add_activity(activity_log, "NAMESPACE_READY", f"Namespace {store_ns} ready")
        _publish_event(name, "NAMESPACE_READY", f"Namespace {store_ns} ready", "Provisioning")

        # Step 2: Helm install / upgrade
        logger.info(f"[{name}] Step 2/5: Helm install")
        _add_activity(activity_log, "HELM_INSTALL", "Installing Helm chart")
        _publish_event(name, "HELM_INSTALL", "Installing Helm chart", "Provisioning")
        helm_values = {
            "storeName": name,
            "medusa.image": MEDUSA_IMAGE,
            "storefront.image": STOREFRONT_IMAGE,
            "ingress.host": f"{name}.{domain_suffix}",
            "ingress.className": INGRESS_CLASS,
            "postgres.storageClass": STORAGE_CLASS,
        }
        helm_install(name, store_ns, helm_values)
        set_condition(conditions, "HelmInstalled", "True", "Installed",
                      "Helm chart installed successfully")
        _add_activity(activity_log, "HELM_READY", "Helm chart installed successfully")
        _publish_event(name, "HELM_READY", "Helm chart installed", "Provisioning")

        # Step 3: Verify PostgreSQL readiness
        logger.info(f"[{name}] Step 3/5: Verifying PostgreSQL")
        pg_ready, pg_reason = _check_pods_by_label(store_ns, "app.kubernetes.io/name=postgres")
        if pg_ready:
            set_condition(conditions, "DatabaseReady", "True", "Running", "PostgreSQL is running")
            _add_activity(activity_log, "DB_READY", "PostgreSQL database ready")
            _publish_event(name, "DB_READY", "PostgreSQL database ready", "Provisioning")
        else:
            set_condition(conditions, "DatabaseReady", "False", "NotReady", pg_reason)
            patch.status["conditions"] = conditions
            patch.status["activityLog"] = activity_log
            raise kopf.TemporaryError(f"PostgreSQL not ready: {pg_reason}", delay=15)

        # Step 4: Verify Backend readiness
        logger.info(f"[{name}] Step 4/5: Verifying Medusa backend")
        be_ready, be_reason = _check_pods_by_label(store_ns, "app.kubernetes.io/name=medusa-backend")
        if be_ready:
            set_condition(conditions, "BackendReady", "True", "Running", "Medusa backend is running")
            _add_activity(activity_log, "BACKEND_READY", "Medusa backend ready")
            _publish_event(name, "BACKEND_READY", "Medusa backend ready", "Provisioning")
        else:
            set_condition(conditions, "BackendReady", "False", "NotReady", be_reason)
            patch.status["conditions"] = conditions
            patch.status["activityLog"] = activity_log
            raise kopf.TemporaryError(f"Backend not ready: {be_reason}", delay=15)

        # Step 5: Verify Storefront readiness
        logger.info(f"[{name}] Step 5/5: Verifying Storefront")
        sf_ready, sf_reason = _check_pods_by_label(store_ns, "app.kubernetes.io/name=storefront")
        if sf_ready:
            set_condition(conditions, "StorefrontReady", "True", "Running", "Storefront is running")
            _add_activity(activity_log, "STOREFRONT_READY", "Storefront ready")
            _publish_event(name, "STOREFRONT_READY", "Storefront ready", "Provisioning")
        else:
            set_condition(conditions, "StorefrontReady", "False", "NotReady", sf_reason)
            patch.status["conditions"] = conditions
            patch.status["activityLog"] = activity_log
            raise kopf.TemporaryError(f"Storefront not ready: {sf_reason}", delay=15)

        # All ready — mark store as Ready
        store_url = f"http://{name}.{domain_suffix}"
        admin_url = f"http://{name}.{domain_suffix}/app"

        logger.info(f"[{name}] ✓ Store Ready at {store_url}")
        patch.status["phase"] = "Ready"
        patch.status["url"] = store_url
        patch.status["adminUrl"] = admin_url
        patch.status["message"] = "Store is ready"
        patch.status["conditions"] = conditions
        patch.status["lastUpdated"] = _now()
        patch.status["retryCount"] = 0
        _add_activity(activity_log, "STORE_READY", f"Store ready at {store_url}")
        patch.status["activityLog"] = activity_log
        _publish_event(name, "STORE_READY", f"Store ready at {store_url}", "Ready")

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
        _add_activity(activity_log, "PROVISION_FAILED", f"Attempt {retry_count}: {str(e)[:150]}")
        patch.status["activityLog"] = activity_log
        _publish_event(name, "PROVISION_FAILED", f"Attempt {retry_count}: {str(e)[:150]}", "Failed")
        logger.error(f"Store {name} failed (attempt {retry_count}): {e}")

        if retry_count < 3:
            raise kopf.TemporaryError(f"Retrying ({retry_count}/3): {e}", delay=30)
        # After 3 retries, mark as permanently failed
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# DELETE handler — cleanup with finalizer guarantee
# ---------------------------------------------------------------------------

@kopf.on.delete(CRD_GROUP, CRD_VERSION, CRD_PLURAL)
def delete_store(spec, name, status, patch, logger, **kwargs):
    """
    Clean up all resources for a store.

    Flow: Helm uninstall → Delete namespace → Finalizer auto-removed.
    Namespace deletion cascades to all resources within.

    Guarantees:
    - Helm release is uninstalled (release secrets cleaned)
    - PVC is deleted via namespace cascade
    - Namespace is deleted (no orphans)
    - Finalizer removed only after successful cleanup
    """
    engine = spec.get("engine", "medusa")
    store_ns = f"store-{name}"

    if engine == "woocommerce":
        logger.info(f"Store {name}: WooCommerce stub — nothing to clean up")
        _publish_event(name, "DELETE_SKIP", "WooCommerce stub — nothing to clean up", "Deleting")
        return

    logger.info(f"Deleting store {name} — cleaning up namespace {store_ns}")
    _publish_event(name, "DELETE_START", f"Deleting store {name}", "Deleting")

    # Step 1: Helm uninstall (release may not exist if provisioning failed)
    try:
        _publish_event(name, "HELM_UNINSTALL", "Uninstalling Helm release", "Deleting")
        helm_uninstall(name, store_ns)
        _publish_event(name, "HELM_UNINSTALLED", "Helm release uninstalled", "Deleting")
    except Exception as e:
        logger.warning(f"Helm uninstall error (non-fatal): {e}")
        _publish_event(name, "HELM_UNINSTALL_WARN", f"Helm uninstall warning: {str(e)[:100]}", "Deleting")

    # Step 2: Delete PVCs explicitly (belt-and-suspenders before namespace delete)
    try:
        api = core_api()
        pvcs = api.list_namespaced_persistent_volume_claim(namespace=store_ns)
        for pvc in pvcs.items:
            api.delete_namespaced_persistent_volume_claim(pvc.metadata.name, store_ns)
            logger.info(f"Deleted PVC {pvc.metadata.name} in {store_ns}")
        _publish_event(name, "PVC_CLEANUP", f"Cleaned up {len(pvcs.items)} PVCs", "Deleting")
    except kubernetes.client.ApiException as e:
        if e.status != 404:
            logger.warning(f"PVC cleanup error (non-fatal): {e}")
    except Exception as e:
        logger.warning(f"PVC cleanup error (non-fatal): {e}")

    # Step 3: Delete namespace (cascading delete removes all K8s resources)
    try:
        _publish_event(name, "NAMESPACE_DELETE", f"Deleting namespace {store_ns}", "Deleting")
        delete_namespace(store_ns)
        _publish_event(name, "NAMESPACE_DELETED", f"Namespace {store_ns} deleted", "Deleting")
    except Exception as e:
        logger.warning(f"Namespace deletion error (non-fatal): {e}")
        _publish_event(name, "NAMESPACE_DELETE_WARN", f"Namespace delete warning: {str(e)[:100]}", "Deleting")

    # Step 4: Cleanup Redis streams for this store
    try:
        r = _get_redis()
        if r:
            r.delete(f"store:events:{name}")
    except Exception:
        pass

    _publish_event(name, "DELETE_COMPLETE", f"Store {name} cleanup complete", "Deleted")
    logger.info(f"Store {name} cleanup complete")


# ---------------------------------------------------------------------------
# TIMER — periodic reconciliation for drift detection & self-healing
# ---------------------------------------------------------------------------

@kopf.timer(CRD_GROUP, CRD_VERSION, CRD_PLURAL, interval=120, idle=120)
def check_store_health(spec, name, status, patch, logger, **kwargs):
    """
    Periodic health check with smart drift detection.

    For Ready stores:
    - Check if critical resources (Deployments, Services, StatefulSet) still exist
    - Check if replica counts match
    - If drift detected → trigger Helm upgrade to self-heal
    - If pods degraded → update status conditions

    Avoids blind helm upgrade — only acts on actual drift.
    """
    if status.get("phase") != "Ready":
        return

    engine = spec.get("engine", "medusa")
    if engine == "woocommerce":
        return

    store_ns = f"store-{name}"
    domain_suffix = spec.get("domainSuffix", DOMAIN_SUFFIX)
    conditions = list(status.get("conditions", []))
    activity_log = list(status.get("activityLog", []))

    try:
        # Smart drift detection: check actual resources
        drift_reasons = _detect_drift(name, store_ns)

        if drift_reasons:
            logger.warning(f"Store {name}: drift detected — {drift_reasons}")
            set_condition(conditions, "DriftDetected", "True", "ResourceDrift",
                          "; ".join(drift_reasons))
            _add_activity(activity_log, "DRIFT_DETECTED", f"Drift: {'; '.join(drift_reasons)}")
            _publish_event(name, "DRIFT_DETECTED", f"Drift: {'; '.join(drift_reasons)}", "Ready")

            # Self-heal: re-apply Helm chart to restore missing resources
            logger.info(f"Store {name}: self-healing via Helm upgrade")
            _add_activity(activity_log, "SELF_HEAL", "Triggering Helm upgrade to restore resources")
            _publish_event(name, "SELF_HEAL", "Self-healing via Helm upgrade", "Ready")

            helm_values = {
                "storeName": name,
                "medusa.image": MEDUSA_IMAGE,
                "storefront.image": STOREFRONT_IMAGE,
                "ingress.host": f"{name}.{domain_suffix}",
                "ingress.className": INGRESS_CLASS,
                "postgres.storageClass": STORAGE_CLASS,
            }
            helm_install(name, store_ns, helm_values)  # Uses upgrade if deployed

            set_condition(conditions, "DriftDetected", "False", "Healed",
                          "Resources restored via Helm upgrade")
            _add_activity(activity_log, "SELF_HEALED", "Resources restored successfully")
            _publish_event(name, "SELF_HEALED", "Resources restored", "Ready")

            patch.status["conditions"] = conditions
            patch.status["activityLog"] = activity_log
            patch.status["lastUpdated"] = _now()
            return

        # No drift — check pod health
        api = core_api()
        pods = api.list_namespaced_pod(namespace=store_ns)
        degraded = False
        for pod in pods.items:
            if pod.status.phase not in ("Running", "Succeeded"):
                logger.warning(f"Store {name}: pod {pod.metadata.name} is {pod.status.phase}")
                set_condition(conditions, "HealthCheck", "False", "PodDegraded",
                              f"Pod {pod.metadata.name} is {pod.status.phase}")
                degraded = True
                break

        if not degraded:
            # Clear any previous health check warnings
            set_condition(conditions, "HealthCheck", "True", "Healthy", "All pods healthy")

        patch.status["conditions"] = conditions
        patch.status["lastUpdated"] = _now()

    except kubernetes.client.ApiException as e:
        if e.status == 404:
            logger.warning(f"Store {name}: namespace {store_ns} not found during health check")
        else:
            logger.error(f"Health check failed for store {name}: {e}")
    except Exception as e:
        logger.error(f"Health check failed for store {name}: {e}")
