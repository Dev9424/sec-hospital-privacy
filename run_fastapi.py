"""
run_fastapi.py
==============
Launcher script for the SUPMS-Fair FastAPI ML Anonymization Service.

Usage:
    python run_fastapi.py
    python run_fastapi.py --port 8000 --reload
"""

import sys
import argparse
from pathlib import Path
import uvicorn

# Ensure the project root and current folder are in sys.path
BASE_DIR = Path(__file__).resolve().parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Start the SUPMS-Fair FastAPI Anonymization Service")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host to bind (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="Port to bind (default: 8000, matching backend ML_SERVICE_URL)")
    parser.add_argument("--reload", action="store_true", help="Enable auto-reload for development")

    args = parser.parse_args()

    print("=" * 65)
    print(f" Starting SUPMS-Fair ML Anonymization Service")
    print(f" URL: http://{args.host}:{args.port}")
    print(f" API Docs: http://{args.host}:{args.port}/docs")
    print(f" Health check: http://{args.host}:{args.port}/health")
    print("=" * 65)

    uvicorn.run(
        "app.main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        app_dir=str(BASE_DIR)
    )
