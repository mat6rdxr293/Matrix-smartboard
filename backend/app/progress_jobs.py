from __future__ import annotations

import threading
import time
import uuid
from typing import Any


class ProgressJobStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._jobs: dict[str, dict[str, Any]] = {}

    def create(self, kind: str) -> str:
        job_id = uuid.uuid4().hex
        with self._lock:
            self._jobs[job_id] = {
                "jobId": job_id,
                "kind": kind,
                "status": "queued",
                "progress": 0,
                "stage": "queued",
                "completed": None,
                "total": None,
                "result": None,
                "error": None,
                "partial": None,
                "partialSteps": None,
                "updatedAt": int(time.time() * 1000),
            }
        return job_id

    def update(self, job_id: str, *, progress: int, stage: str, completed: int | None = None, total: int | None = None) -> None:
        with self._lock:
            job = self._jobs[job_id]
            job.update({
                "status": "running",
                "progress": max(0, min(99, int(progress))),
                "stage": stage,
                "completed": completed,
                "total": total,
                "updatedAt": int(time.time() * 1000),
            })

    def set_partial(self, job_id: str, text: str, steps: list | None = None) -> None:
        """The answer as far as it is written, for a client that shows it while it is written:
        the readable text and the steps already finished."""
        with self._lock:
            job = self._jobs[job_id]
            if job.get("partial") == text and job.get("partialSteps") == steps:
                return
            job.update({
                "status": "running",
                "stage": "writing",
                "partial": text,
                "partialSteps": steps,
                "updatedAt": int(time.time() * 1000),
            })

    def complete(self, job_id: str, result: Any) -> None:
        with self._lock:
            job = self._jobs[job_id]
            job.update({
                "status": "done",
                "progress": 100,
                "stage": "done",
                "result": result,
                "updatedAt": int(time.time() * 1000),
            })

    def fail(self, job_id: str, error: str) -> None:
        with self._lock:
            job = self._jobs[job_id]
            job.update({
                "status": "error",
                "stage": "error",
                "error": error,
                "updatedAt": int(time.time() * 1000),
            })

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return dict(job) if job else None


progress_jobs = ProgressJobStore()
