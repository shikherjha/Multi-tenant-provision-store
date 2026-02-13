"""
Store Provisioning Platform — Intent API

Main entrypoint. Sets up FastAPI with:
  - CORS for dashboard access
  - Rate limiting (slowapi)
  - Prometheus metrics (/metrics)
  - Health check (/health) with Redis status
  - Store CRUD routes (/stores)
  - WebSocket for real-time updates (/stores/ws)
"""

import logging
import uvicorn
from datetime import datetime, timezone
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

from config import settings
from routers.stores import router as stores_router, _get_redis, _init_metrics, _update_gauges

# --- Logging ---
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(name)s | %(levelname)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("intent-api")


# --- Lifespan ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Store Platform Intent API starting...")
    _init_metrics()
    yield
    logger.info("Store Platform Intent API shutting down...")


# --- FastAPI app ---
app = FastAPI(
    title="Store Provisioning Platform API",
    description="Intent API for Kubernetes-native multi-tenant store provisioning",
    version="2.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)

# --- CORS ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)

# --- Rate Limiting ---
limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# --- Include stores router ---
# --- Include stores router ---
app.include_router(stores_router, prefix="/api")


# --- Health check ---
@app.get("/health")
async def health():
    """Health check with Redis connectivity status."""
    redis_status = "disabled"
    r = _get_redis()
    if r:
        try:
            r.ping()
            redis_status = "connected"
        except Exception:
            redis_status = "disconnected"

    return {
        "status": "healthy",
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "redis": redis_status,
        "version": "2.0.0",
    }


# --- Prometheus metrics endpoint ---
@app.get("/metrics", response_class=PlainTextResponse)
async def metrics():
    """Expose Prometheus metrics."""
    try:
        from prometheus_client import generate_latest, CONTENT_TYPE_LATEST
        _update_gauges()
        return PlainTextResponse(
            content=generate_latest().decode("utf-8"),
            media_type=CONTENT_TYPE_LATEST,
        )
    except ImportError:
        return PlainTextResponse(
            content="# prometheus_client not installed\n",
            status_code=200,
        )


# --- Global exception handler ---
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled exception: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
    )


# --- Entry point ---
if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=settings.API_HOST,
        port=settings.API_PORT,
        log_level="info",
        reload=False,
    )
