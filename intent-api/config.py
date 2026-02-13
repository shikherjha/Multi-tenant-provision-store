"""
Configuration module — all settings from env vars with sensible defaults.
Follows 12-factor app methodology.
"""
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    # Kubernetes
    KUBECONFIG: str = os.environ.get("KUBECONFIG", "")
    IN_CLUSTER: bool = os.environ.get("IN_CLUSTER", "false").lower() == "true"

    # CRD
    CRD_GROUP: str = "platform.urumi.ai"
    CRD_VERSION: str = "v1"
    CRD_PLURAL: str = "stores"

    # Platform
    DOMAIN_SUFFIX: str = os.environ.get("DOMAIN_SUFFIX", "local.urumi")
    MAX_STORES_PER_OWNER: int = int(os.environ.get("MAX_STORES_PER_OWNER", "5"))
    MAX_STORES_GLOBAL: int = int(os.environ.get("MAX_STORES_GLOBAL", "10"))

    # Rate limiting
    RATE_LIMIT: str = os.environ.get("RATE_LIMIT", "10/minute")

    # API
    API_HOST: str = os.environ.get("API_HOST", "0.0.0.0")
    API_PORT: int = int(os.environ.get("API_PORT", "8080"))
    CORS_ORIGINS: str = os.environ.get("CORS_ORIGINS", "*")


settings = Settings()
