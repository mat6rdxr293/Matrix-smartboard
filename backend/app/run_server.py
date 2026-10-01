from __future__ import annotations

import argparse

import uvicorn

from .discovery import DiscoveryMetadata, MdnsAdvertiser
from .main import API_VERSION, SERVER_VERSION
from .server_identity import ServerIdentity
from .settings import get_server_name, settings


def main() -> None:
    parser = argparse.ArgumentParser(description="Run Matrix Smartboard local server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8443)
    parser.add_argument("--insecure-http", action="store_true")
    parser.add_argument("--no-mdns", action="store_true")
    args = parser.parse_args()

    identity = ServerIdentity(settings.server_identity_dir)
    identity.ensure()
    tls = not args.insecure_http
    advertiser = MdnsAdvertiser(
        DiscoveryMetadata(
            server_id=identity.server_id(),
            server_name=get_server_name(),
            port=args.port,
            tls=tls,
            api_version=API_VERSION,
            server_version=SERVER_VERSION,
        )
    )

    if not args.no_mdns:
        try:
            advertiser.start()
        except Exception as exc:
            print(f"WARNING: mDNS discovery unavailable: {exc}")

    try:
        uvicorn.run(
            "app.main:app",
            host=args.host,
            port=args.port,
            ssl_keyfile=None if not tls else str(identity.private_key_path),
            ssl_certfile=None if not tls else str(identity.certificate_path),
        )
    finally:
        advertiser.close()


if __name__ == "__main__":
    main()
