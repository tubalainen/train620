"""Säkerhetsfunktioner för Tågkoll: betrodd proxy, begränsning av anrop och säkerhetsrubriker.

Appen ligger normalt bakom Cloudflare och en omvänd proxy (t.ex. Nginx Proxy Manager).
Rubriker som anger besökarens IP-adress och protokoll går att förfalska, så de används bara
när anropet kommer direkt från en betrodd proxy (se TRUSTED_PROXIES).
"""
from __future__ import annotations

import ipaddress
import os
import threading
import time
from collections import deque

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

# ------------------------------------------------------------- betrodd proxy
# "private" (standard): lita på proxyrubriker när anropet kommer från loopback eller ett privat
# nät (Docker-nät, hemmanätet där proxyn står). "none": lita aldrig på dem. Annars en
# kommaseparerad lista med adresser eller nät, t.ex. "172.18.0.0/16,192.168.1.10".
_TRUSTED_SETTING = os.environ.get("TRUSTED_PROXIES", "private").strip().lower()
_TRUSTED_NETS: list[ipaddress._BaseNetwork] = []
if _TRUSTED_SETTING not in ("private", "none", ""):
    for part in _TRUSTED_SETTING.split(","):
        if part.strip():
            _TRUSTED_NETS.append(ipaddress.ip_network(part.strip(), strict=False))


def _peer(request: Request) -> str:
    return request.client.host if request.client else ""


def from_trusted_proxy(request: Request) -> bool:
    try:
        addr = ipaddress.ip_address(_peer(request))
    except ValueError:
        return False
    if _TRUSTED_SETTING == "none":
        return False
    if _TRUSTED_SETTING in ("private", ""):
        return addr.is_loopback or addr.is_private or addr.is_link_local
    return any(addr in net for net in _TRUSTED_NETS)


def _valid_ip(value: str) -> str | None:
    try:
        return str(ipaddress.ip_address(value.strip()))
    except ValueError:
        return None


def client_ip(request: Request) -> str:
    """Besökarens IP-adress. Proxyrubriker används bara från en betrodd proxy."""
    if from_trusted_proxy(request):
        cf = _valid_ip(request.headers.get("cf-connecting-ip", ""))
        if cf:
            return cf
        forwarded = request.headers.get("x-forwarded-for", "")
        if forwarded:
            first = _valid_ip(forwarded.split(",")[0])
            if first:
                return first
    return _peer(request)


def is_https(request: Request) -> bool:
    if request.url.scheme == "https":
        return True
    if from_trusted_proxy(request):
        proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
        return proto == "https" or '"scheme":"https"' in request.headers.get("cf-visitor", "").replace(" ", "")
    return False


# --------------------------------------------------------- begränsa anrop
class RateLimiter:
    """Glidande fönster per nyckel, i minnet. Räcker för en enda container."""

    def __init__(self, limit: int, window: float, max_keys: int = 50_000):
        self.limit, self.window, self.max_keys = limit, window, max_keys
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def _prune(self, now: float) -> None:
        for key in [k for k, q in self._hits.items() if not q or q[-1] <= now - self.window]:
            del self._hits[key]

    def hit(self, key: str) -> bool:
        """Registrerar ett anrop. False om gränsen redan är nådd."""
        now = time.monotonic()
        with self._lock:
            q = self._hits.get(key)
            if q is None:
                if len(self._hits) >= self.max_keys:
                    self._prune(now)
                q = self._hits[key] = deque()
            while q and q[0] <= now - self.window:
                q.popleft()
            if len(q) >= self.limit:
                return False
            q.append(now)
            return True

    def blocked(self, key: str) -> bool:
        now = time.monotonic()
        with self._lock:
            q = self._hits.get(key)
            if not q:
                return False
            while q and q[0] <= now - self.window:
                q.popleft()
            return len(q) >= self.limit

    def retry_after(self, key: str) -> int:
        with self._lock:
            q = self._hits.get(key)
            if not q:
                return 0
            return max(1, int(q[0] + self.window - time.monotonic()) + 1)

    def clear(self, key: str) -> None:
        with self._lock:
            self._hits.pop(key, None)


# -------------------------------------------------------- säkerhetsrubriker
CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
    "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; "
    "frame-ancestors 'none'"
)
SECURITY_HEADERS = {
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
}


class SecurityMiddleware:
    """Säkerhetsrubriker, storleksgräns för anrop, ursprungskontroll och anropsgräns för /api.

    Ren ASGI-middleware, så att storleksgränsen gäller även för anrop utan Content-Length.
    """

    def __init__(self, app: ASGIApp, max_body: int, api_limiter: RateLimiter):
        self.app, self.max_body, self.api_limiter = app, max_body, api_limiter

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request = Request(scope)
        path, method = scope["path"], scope["method"]
        https = is_https(request)

        async def wrapped_send(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = [(k, v) for k, v in message.get("headers", []) if k.lower() != b"server"]
                existing = {k.lower() for k, _ in headers}
                for name, value in SECURITY_HEADERS.items():
                    if name.encode() not in existing:
                        headers.append((name.encode(), value.encode()))
                if https:
                    headers.append((b"strict-transport-security", b"max-age=31536000"))
                if path.startswith("/api/") and b"cache-control" not in existing:
                    headers.append((b"cache-control", b"no-store"))
                message["headers"] = headers
            await send(message)

        async def reply(status: int, detail: str, headers: dict | None = None) -> None:
            response = JSONResponse({"detail": detail}, status_code=status, headers=headers)
            await response(scope, receive, wrapped_send)

        # Storleksgräns
        length = request.headers.get("content-length")
        if length is not None and (not length.isdigit() or int(length) > self.max_body):
            await reply(413, "Anropet är för stort.")
            return

        # Ändrande anrop måste komma från samma webbplats (skydd mot CSRF utöver SameSite-kakan).
        if method not in ("GET", "HEAD", "OPTIONS"):
            origin = request.headers.get("origin")
            host = request.headers.get("host", "")
            if origin and origin.split("://", 1)[-1].rstrip("/") != host:
                await reply(403, "Anropet kommer från en annan webbplats.")
                return

        # Anropsgräns per IP för API:t (hälsokontrollen från containern själv räknas inte).
        if path.startswith("/api/") and not (path == "/api/health" and _peer(request) in ("127.0.0.1", "::1")):
            key = client_ip(request)
            if not self.api_limiter.hit(key):
                await reply(429, "För många anrop. Vänta en stund och försök igen.",
                            {"retry-after": str(self.api_limiter.retry_after(key))})
                return

        received = 0

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_body:
                    raise _TooLarge()
            return message

        try:
            await self.app(scope, limited_receive, wrapped_send)
        except _TooLarge:
            await reply(413, "Anropet är för stort.")


class _TooLarge(Exception):
    pass
