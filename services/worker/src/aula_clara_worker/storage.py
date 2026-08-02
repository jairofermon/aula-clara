from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
from supabase import Client, create_client

from .errors import TransientPipelineError


class StorageGateway:
    def __init__(self, url: str, service_role_key: str, signed_url_ttl: int) -> None:
        if not service_role_key:
            raise RuntimeError("SUPABASE_SERVICE_ROLE_KEY é obrigatória para o worker")
        self.client: Client = create_client(f"{url.rstrip('/')}/", service_role_key)
        self.base_url = url.rstrip("/")
        self.signed_url_ttl = signed_url_ttl

    def download(self, bucket: str, storage_path: str, target: Path) -> None:
        try:
            result: dict[str, Any] = self.client.storage.from_(bucket).create_signed_url(storage_path, self.signed_url_ttl)
            url = result.get("signedURL") or result.get("signedUrl") or result.get("signed_url")
            if not url:
                raise RuntimeError("URL assinada ausente")
            if str(url).startswith("/"):
                url = f"{self.base_url}{url}"
            with httpx.stream("GET", str(url), timeout=120, follow_redirects=True) as response:
                response.raise_for_status()
                with target.open("wb") as output:
                    for block in response.iter_bytes(1024 * 1024):
                        output.write(block)
        except (httpx.HTTPError, OSError, RuntimeError) as exc:
            raise TransientPipelineError("falha ao baixar arquivo privado") from exc

    def upload(self, bucket: str, storage_path: str, source: Path, content_type: str) -> None:
        try:
            self.client.storage.from_(bucket).upload(
                storage_path,
                source.read_bytes(),
                file_options={"content-type": content_type, "upsert": "false"},
            )
        except Exception as exc:
            # Erros do SDK de Storage variam por versão; a fila controla as tentativas.
            if "already exists" in str(exc).lower() or "duplicate" in str(exc).lower():
                return
            raise TransientPipelineError("falha ao salvar arquivo privado") from exc
