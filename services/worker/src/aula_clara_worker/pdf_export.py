from __future__ import annotations

import html
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright

from .errors import PdfGenerationError


def _timestamp(milliseconds: int) -> str:
    total = max(0, milliseconds) // 1000
    hours, remainder = divmod(total, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}" if hours else f"{minutes:02d}:{seconds:02d}"


def build_notes_html(class_context: dict[str, Any], transcript: list[dict[str, Any]], version: int) -> str:
    title = html.escape(str(class_context.get("title", "Aula")))
    subject = html.escape(str(class_context.get("subject_name", "Disciplina")))
    date = html.escape(str(class_context.get("class_date", "")))
    rows = "".join(
        f'<section class="segment"><span class="time">{_timestamp(int(item["start_ms"]))}</span>'
        f'<p>{html.escape(str(item["text"]))}</p></section>' for item in transcript
    )
    index = "".join(
        f'<li>{_timestamp(int(item["start_ms"]))} — {html.escape(str(item["text"])[:90])}</li>'
        for item in transcript[:: max(1, len(transcript) // 12 or 1)]
    )
    return f"""<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><style>
      @page {{ size: A4; margin: 22mm 18mm 20mm; @bottom-center {{ content: "Aula Clara · versão {version} · " counter(page) "/" counter(pages); font-size: 9px; color: #61736f; }} }}
      * {{ box-sizing: border-box }} body {{ color:#18342f; font: 11.5pt/1.62 Arial,sans-serif }}
      .cover {{ min-height: 240mm; display:flex; flex-direction:column; justify-content:center; page-break-after:always }}
      .brand {{ color:#176b58; font-weight:700; letter-spacing:.08em; text-transform:uppercase }}
      h1 {{ font-size:34pt; line-height:1.05; margin:18px 0 }} h2 {{ color:#176b58; margin-top:30px }}
      .meta {{ color:#61736f }} .index {{ page-break-after:always }} .index li {{ margin:6px 0 }}
      .segment {{ break-inside:avoid; border-top:1px solid #dbe4df; padding:12px 0; display:grid; grid-template-columns:62px 1fr; gap:12px }}
      .time {{ color:#176b58; font:700 9pt monospace }} .segment p {{ margin:0 }}
    </style></head><body><section class="cover"><div class="brand">Aula Clara</div><h1>{title}</h1><p class="meta">{subject}<br>{date}<br>Transcrição validada · versão {version}</p></section>
    <section class="index"><h2>Índice cronológico</h2><ol>{index}</ol></section>
    <h2>Transcrição integral</h2>{rows}</body></html>"""


def render_pdf(document_html: str, destination: Path) -> None:
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page()
            page.set_content(document_html, wait_until="networkidle")
            page.pdf(path=str(destination), format="A4", print_background=True, display_header_footer=False)
            browser.close()
    except Exception as exc:
        raise PdfGenerationError("chromium não conseguiu renderizar a apostila") from exc
