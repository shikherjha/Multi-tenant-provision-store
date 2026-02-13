"""
Pydantic models for the Intent API request/response schemas.
"""

from pydantic import BaseModel, Field
from typing import Optional, List
from enum import Enum
from datetime import datetime


class EngineType(str, Enum):
    medusa = "medusa"
    woocommerce = "woocommerce"


class StoreCreateRequest(BaseModel):
    name: str = Field(..., min_length=2, max_length=40, pattern=r"^[a-z][a-z0-9-]*[a-z0-9]$",
                      description="Store name (lowercase, alphanumeric, hyphens)")
    engine: EngineType = Field(default=EngineType.medusa, description="E-commerce engine")
    owner: str = Field(default="default", min_length=1, max_length=60,
                       description="Owner identifier")


class StoreCondition(BaseModel):
    type: str
    status: str  # "True", "False", "Unknown"
    reason: str = ""
    message: str = ""
    lastTransitionTime: Optional[str] = None


class ActivityLogEntry(BaseModel):
    timestamp: str
    event: str
    message: str


class StoreResponse(BaseModel):
    name: str
    engine: str
    owner: str
    phase: str = "Pending"
    url: Optional[str] = None
    adminUrl: Optional[str] = None
    message: str = ""
    createdAt: Optional[str] = None
    lastUpdated: Optional[str] = None
    retryCount: int = 0
    conditions: List[StoreCondition] = []
    activityLog: List[ActivityLogEntry] = []


class StoreListResponse(BaseModel):
    stores: List[StoreResponse]
    total: int


class ErrorResponse(BaseModel):
    detail: str


class AuditLogEntry(BaseModel):
    timestamp: str
    action: str
    store_name: str
    engine: str
    owner: str
    result: str
    detail: str = ""


class HealthResponse(BaseModel):
    status: str
    timestamp: str
    redis: str = "disabled"
    stores_total: int = 0


class MetricsInfo(BaseModel):
    stores_total: int
    stores_ready: int
    stores_failed: int
    stores_provisioning: int
