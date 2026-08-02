from fastapi import FastAPI

from . import __version__
from .config import Settings

app = FastAPI(title="Aula Clara Worker", version=__version__, docs_url="/docs")


@app.get("/health")
def health() -> dict[str, str]:
    settings = Settings.from_env()
    return {"status": "ok", "version": __version__, "provider_mode": settings.provider_mode, "worker_id": settings.worker_id}
