"""
Pydantic models for API request/response validation.
"""
from pydantic import BaseModel, Field
from typing import Optional, List
from enum import Enum
from datetime import datetime


class EngineType(str, Enum):
    MEDUSA = "medusa"
    WOOCOMMERCE = "woocommerce"


class StoreCreateRequest(BaseModel):
    """Request to create a new store."""
    name: str = Field(
        ...,
        min_length=3,
        max_length=30,
        pattern=r"^[a-z][a-z0-9-]*[a-z0-9]$",
        description="Store name (lowercase, alphanumeric with hyphens, 3-30 chars)",
        examples=["my-store", "demo-shop"],
    )
    engine: EngineType = Field(
        default=EngineType.MEDUSA,
        description="E-commerce engine (medusa or woocommerce)",
    )
    owner: str = Field(
        default="default",
        max_length=50,
        description="Owner identifier for quota tracking",
    )


class StoreCondition(BaseModel):
    type: str
    status: str
    reason: str = ""
    message: str = ""
    lastTransitionTime: Optional[str] = None


class StoreResponse(BaseModel):
    """Store details returned to the dashboard."""
    name: str
    engine: str
    phase: str = "Pending"
    url: Optional[str] = None
    adminUrl: Optional[str] = None
    message: Optional[str] = None
    createdAt: Optional[str] = None
    lastUpdated: Optional[str] = None
    owner: str = "default"
    conditions: List[StoreCondition] = []


class StoreListResponse(BaseModel):
    stores: List[StoreResponse]
    total: int


class ErrorResponse(BaseModel):
    detail: str
    code: str = "UNKNOWN_ERROR"


class AuditLogEntry(BaseModel):
    timestamp: str
    action: str  # CREATE, DELETE
    store_name: str
    engine: str
    owner: str
    result: str  # SUCCESS, FAILED
    detail: str = ""
