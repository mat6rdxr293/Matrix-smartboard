from __future__ import annotations

import time
from collections import defaultdict, deque


class RateLimiter:
    def __init__(self, limit_per_minute: int) -> None:
        self.limit = limit_per_minute
        self.window_seconds = 60
        self._events: dict[str, deque[float]] = defaultdict(deque)

    def allow(self, key: str) -> bool:
        now = time.time()
        window_start = now - self.window_seconds
        q = self._events[key]
        while q and q[0] < window_start:
            q.popleft()
        if len(q) >= self.limit:
            return False
        q.append(now)
        return True
