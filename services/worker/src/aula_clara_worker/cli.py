from __future__ import annotations

import argparse
import time

from .config import Settings
from .logging import configure_logging, get_logger
from .processor import JobProcessor
from .worker import Worker


def main() -> None:
    parser = argparse.ArgumentParser(description="Worker persistente do Aula Clara")
    parser.add_argument("--once", action="store_true", help="processa no máximo um job e encerra")
    args = parser.parse_args()
    settings = Settings.from_env()
    configure_logging(settings.log_level)
    worker = Worker(JobProcessor.build(settings))
    log = get_logger()
    log.info("worker_ready", worker_id=settings.worker_id, provider_mode=settings.provider_mode)
    if args.once:
        worker.run_once()
        return
    try:
        while True:
            processed = worker.run_once()
            if not processed:
                time.sleep(settings.poll_seconds)
    except KeyboardInterrupt:
        log.info("worker_stopped", worker_id=settings.worker_id)


if __name__ == "__main__":
    main()
