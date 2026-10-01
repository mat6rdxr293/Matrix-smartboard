import ipaddress

from cryptography import x509
from fastapi.testclient import TestClient

import app.main as main_module
import app.server_identity as identity_module
from app.server_identity import ServerIdentity


def test_server_identity_survives_ip_change(tmp_path, monkeypatch):
    identity = ServerIdentity(tmp_path / "identity")

    monkeypatch.setattr(identity_module, "local_ipv4_addresses", lambda: ["192.168.1.20"])
    identity.ensure()
    first_pin = identity.public_key_pin()
    first_id = identity.server_id()

    first_cert = x509.load_pem_x509_certificate(identity.certificate_path.read_bytes())
    first_san = first_cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    assert ipaddress.ip_address("192.168.1.20") in first_san.get_values_for_type(x509.IPAddress)

    monkeypatch.setattr(identity_module, "local_ipv4_addresses", lambda: ["10.230.81.88"])
    identity.ensure()

    assert identity.public_key_pin() == first_pin
    assert identity.server_id() == first_id

    second_cert = x509.load_pem_x509_certificate(identity.certificate_path.read_bytes())
    second_san = second_cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    assert ipaddress.ip_address("10.230.81.88") in second_san.get_values_for_type(x509.IPAddress)


def test_status_exposes_versioned_server_identity(tmp_path, monkeypatch):
    identity = ServerIdentity(tmp_path / "identity")
    monkeypatch.setattr(main_module, "server_identity", identity)

    with TestClient(main_module.app) as client:
        payload = client.get("/api/status").json()

    assert payload["ok"] is True
    assert payload["product"] == "matrix-smartboard"
    assert payload["apiVersion"] >= payload["minClientApiVersion"] >= 1
    assert payload["serverId"]
    assert payload["publicKeyPin"].startswith("sha256/")
    assert payload["features"]["mdns"] is True
