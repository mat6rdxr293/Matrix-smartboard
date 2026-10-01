from __future__ import annotations

import socket
import threading
import time
from dataclasses import dataclass

from zeroconf import IPVersion, ServiceInfo, Zeroconf

from .server_identity import local_ipv4_addresses


SERVICE_TYPE = "_matrixboard._tcp.local."


@dataclass(frozen=True)
class DiscoveryMetadata:
    server_id: str
    port: int
    tls: bool
    api_version: int
    server_version: str


class MdnsAdvertiser:
    def __init__(self, metadata: DiscoveryMetadata):
        self.metadata = metadata
        self._zeroconf: Zeroconf | None = None
        self._info: ServiceInfo | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_addresses: tuple[str, ...] = ()

    def start(self) -> None:
        if self._zeroconf is not None:
            return
        self._zeroconf = Zeroconf(ip_version=IPVersion.V4Only)
        self._publish(force=True)
        self._thread = threading.Thread(target=self._watch_addresses, name="matrix-mdns", daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
        if self._zeroconf is not None:
            if self._info is not None:
                try:
                    self._zeroconf.unregister_service(self._info)
                except Exception:
                    pass
            self._zeroconf.close()
        self._zeroconf = None
        self._info = None

    def _watch_addresses(self) -> None:
        while not self._stop.wait(5):
            self._publish(force=False)

    def _publish(self, *, force: bool) -> None:
        if self._zeroconf is None:
            return
        addresses = tuple(local_ipv4_addresses())
        if not force and addresses == self._last_addresses:
            return
        self._last_addresses = addresses
        packed = [socket.inet_aton(address) for address in addresses]
        hostname = socket.gethostname().split(".", 1)[0] or "matrix-smartboard"
        properties = {
            b"product": b"matrix-smartboard",
            b"serverId": self.metadata.server_id.encode(),
            b"apiVersion": str(self.metadata.api_version).encode(),
            b"serverVersion": self.metadata.server_version.encode(),
            b"tls": b"1" if self.metadata.tls else b"0",
        }
        next_info = ServiceInfo(
            SERVICE_TYPE,
            f"Matrix Smartboard {self.metadata.server_id[:6]}.{SERVICE_TYPE}",
            addresses=packed,
            port=self.metadata.port,
            properties=properties,
            server=f"{hostname}.local.",
        )
        if self._info is None:
            self._zeroconf.register_service(next_info, allow_name_change=True)
        else:
            try:
                self._zeroconf.update_service(next_info)
            except Exception:
                try:
                    self._zeroconf.unregister_service(self._info)
                except Exception:
                    pass
                self._zeroconf.register_service(next_info, allow_name_change=True)
        self._info = next_info
