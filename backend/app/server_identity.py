from __future__ import annotations

import hashlib
import ipaddress
import socket
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psutil
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID


def local_ipv4_addresses() -> list[str]:
    virtual_markers = (
        "docker", "veth", "virbr", "virtualbox", "vmware", "tailscale",
        "zerotier", "utun", "hyper-v", "vethernet", "wireguard", "wg",
    )
    preferred: set[str] = set()
    fallback: set[str] = set()
    stats = psutil.net_if_stats()
    for interface, items in psutil.net_if_addrs().items():
        if interface in stats and not stats[interface].isup:
            continue
        is_virtual = any(marker in interface.lower() for marker in virtual_markers)
        for item in items:
            if item.family != socket.AF_INET:
                continue
            try:
                value = ipaddress.ip_address(item.address)
            except ValueError:
                continue
            if value.is_loopback or value.is_link_local or value.is_unspecified:
                continue
            fallback.add(str(value))
            if not is_virtual:
                preferred.add(str(value))
    return sorted(preferred or fallback)


class ServerIdentity:
    def __init__(self, directory: Path):
        self.directory = Path(directory)
        self.private_key_path = self.directory / "server-key.pem"
        self.certificate_path = self.directory / "server-cert.pem"

    def ensure(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        key = self._load_or_create_key()
        if self._certificate_needs_refresh(key):
            self._write_certificate(key)

    def _load_or_create_key(self):
        if self.private_key_path.exists():
            return serialization.load_pem_private_key(self.private_key_path.read_bytes(), password=None)
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.private_key_path.write_bytes(
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        try:
            self.private_key_path.chmod(0o600)
        except OSError:
            pass
        return key

    def public_key_pin(self) -> str:
        key = self._load_or_create_key()
        spki = key.public_key().public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        return "sha256/" + hashlib.sha256(spki).hexdigest()

    def server_id(self) -> str:
        digest = self.public_key_pin().split("/", 1)[1]
        return digest[:24]

    def _certificate_needs_refresh(self, key) -> bool:
        if not self.certificate_path.exists():
            return True
        try:
            cert = x509.load_pem_x509_certificate(self.certificate_path.read_bytes())
            cert_spki = cert.public_key().public_bytes(
                serialization.Encoding.DER,
                serialization.PublicFormat.SubjectPublicKeyInfo,
            )
            key_spki = key.public_key().public_bytes(
                serialization.Encoding.DER,
                serialization.PublicFormat.SubjectPublicKeyInfo,
            )
            if cert_spki != key_spki:
                return True
            if cert.not_valid_after_utc < datetime.now(timezone.utc) + timedelta(days=30):
                return True
            expected = {ipaddress.ip_address("127.0.0.1"), *(ipaddress.ip_address(v) for v in local_ipv4_addresses())}
            san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
            actual = set(san.get_values_for_type(x509.IPAddress))
            return not expected.issubset(actual)
        except Exception:
            return True

    def _write_certificate(self, key) -> None:
        now = datetime.now(timezone.utc)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Matrix Smartboard Local Server")])
        ip_values = [x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]
        ip_values.extend(x509.IPAddress(ipaddress.ip_address(value)) for value in local_ipv4_addresses())
        san_values = [x509.DNSName("matrix-smartboard.local"), x509.DNSName("localhost"), *ip_values]
        cert = (
            x509.CertificateBuilder()
            .subject_name(name)
            .issuer_name(name)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=5))
            .not_valid_after(now + timedelta(days=1825))
            .add_extension(x509.SubjectAlternativeName(san_values), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .sign(key, hashes.SHA256())
        )
        self.certificate_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        try:
            self.certificate_path.chmod(0o644)
        except OSError:
            pass
