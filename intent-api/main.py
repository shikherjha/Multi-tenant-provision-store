"""
Intent API — FastAPI application for the Store Provisioning Platform.

This API serves as the "Intent Layer" between the Dashboard and Kubernetes.
It translates user intent (create/delete store) into Store CRDs, which the
Operator then reconciles into actual Kubernetes resources.

Architecture:
  Dashboard → Intent API → Store CRD → Operator → Kubernetes Resources
"""
import logging
import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

from config import settings
from routers.stores import router as stores_router

# --- Logging ---
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("intent-api")

# --- App ---
app = FastAPI(
    title="Store Provisioning Platform API",
    description="Intent API for Kubernetes-native multi-tenant store provisioning",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

# --- Rate Limiter ---
limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# --- CORS ---
origins = settings.CORS_ORIGINS.split(",") if settings.CORS_ORIGINS != "*" else ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Routes ---
app.include_router(stores_router)


@app.get("/health", tags=["system"])
async def health_check():
    return {"status": "healthy", "service": "intent-api"}


@app.get("/", tags=["system"])
async def root():
    return {
        "service": "Store Provisioning Platform — Intent API",
        "version": "1.0.0",
        "docs": "/docs",
        "endpoints": {
            "stores": "/api/stores",
            "health": "/health",
            "websocket": "/api/stores/ws",
        },
    }


# --- Global exception handler ---
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled exception: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error", "code": "INTERNAL_ERROR"},
    )


if __name__ == "__main__":
    logger.info(f"Starting Intent API on {settings.API_HOST}:{settings.API_PORT}")
    uvicorn.run(
        "main:app",
        host=settings.API_HOST,
        port=settings.API_PORT,
        reload=True,
        log_level="info",
    )
