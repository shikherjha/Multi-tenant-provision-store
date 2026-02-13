"""
Configuration module for the Intent API.
Centralizes settings from environment variables with sensible defaults.
"""

import os


class Settings:
    # --- Kubernetes ---
    KUBECONFIG = os.environ.get("KUBECONFIG", "")
    IN_CLUSTER = os.environ.get("IN_CLUSTER", "false").lower() == "true"

    # --- CRD ---
    CRD_GROUP = "platform.urumi.ai"
    CRD_VERSION = "v1"
    CRD_PLURAL = "stores"

    # --- Platform ---
    DOMAIN_SUFFIX = os.environ.get("DOMAIN_SUFFIX", "local.urumi")

    # --- Quotas ---
    MAX_STORES_PER_OWNER = int(os.environ.get("MAX_STORES_PER_OWNER", "5"))
    MAX_STORES_GLOBAL = int(os.environ.get("MAX_STORES_GLOBAL", "10"))

    # --- Rate Limiting ---
    RATE_LIMIT = os.environ.get("RATE_LIMIT", "10/minute")

    # --- Server ---
    API_HOST = os.environ.get("API_HOST", "0.0.0.0")
    API_PORT = int(os.environ.get("API_PORT", "8080"))
    CORS_ORIGINS = os.environ.get("CORS_ORIGINS", "*").split(",")

    # --- Redis (optional — graceful degradation) ---
    REDIS_URL = os.environ.get("REDIS_URL", "")


settings = Settings()
