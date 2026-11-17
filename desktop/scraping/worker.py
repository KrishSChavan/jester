"""One read-only web request over stdin/stdout; no HTTP server or browser profile.

Scrapling parses and renders pages. Its curl_cffi transport is used directly so
every DNS answer can be checked and pinned before connecting, including redirects
and requests made by JavaScript. Model input never becomes code or a shell command.
"""

import contextlib
import datetime
import ipaddress
import json
import re
import socket
import sys
import time
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit, urlunsplit

MAX_INPUT = 12000
MAX_BODY = 3 * 1024 * 1024
MAX_TOTAL = 16 * 1024 * 1024
MAX_TEXT = 16000
MAX_LINKS = 30
MAX_OUTPUT = 125000
REDIRECTS = {301, 302, 303, 307, 308}


class Problem(Exception):
    def __init__(self, code, detail):
        super().__init__(detail)
        self.code = code
        self.detail = detail


def public_url(value, resolve=True):
    if not isinstance(value, str) or not value or len(value) > 4096 or re.search(r"[\x00-\x20\x7f\\]", value):
        raise Problem("invalid_url", "Use a complete public http:// or https:// URL.")
    try:
        parts = urlsplit(value)
        host = (parts.hostname or "").rstrip(".").encode("idna").decode("ascii").lower()
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except (ValueError, UnicodeError):
        raise Problem("invalid_url", "The URL could not be read.")
    if parts.scheme not in ("http", "https") or not host or parts.username is not None or parts.password is not None:
        raise Problem("invalid_url", "Use a public HTTP or HTTPS URL without embedded credentials.")
    if port not in (80, 443) or host == "localhost" or host.endswith((".localhost", ".local", ".internal", ".home", ".lan", ".onion")):
        raise Problem("private_url", "Background research reads public websites only.")
    addresses = []
    try:
        addresses = [str(ipaddress.ip_address(host))]
    except ValueError:
        if resolve:
            try:
                addresses = list(dict.fromkeys(info[4][0] for info in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)))
            except OSError:
                raise Problem("unreachable", "The website's address could not be resolved.")
    if any(not ipaddress.ip_address(address).is_global for address in addresses):
        raise Problem("private_url", "Background research cannot read local or private network addresses.")
    if resolve and not addresses:
        raise Problem("unreachable", "The website has no public network address.")
    # Keep brackets on IPv6 literals; normalize away fragments and credentials.
    netloc = f"[{host}]" if ":" in host else host
    if parts.port:
        netloc += f":{port}"
    return urlunsplit((parts.scheme, netloc, parts.path or "/", parts.query, "")), host, port, addresses


class Transport:
    def __init__(self, deadline=None):
        self.deadline = deadline or time.monotonic() + 36
        self.total = 0
        self.requests = 0

    def fetch(self, url, method="GET", headers=None):
        from curl_cffi import CurlOpt
        from curl_cffi.requests import Session

        for _ in range(6):
            remaining = self.deadline - time.monotonic()
            if remaining <= 0 or self.requests >= 80:
                raise Problem("timeout", "The website took too long to read.")
            url, host, port, addresses = public_url(url)
            self.requests += 1
            body = bytearray()
            oversized = False

            def receive(chunk):
                nonlocal oversized
                if len(body) + len(chunk) > MAX_BODY or self.total + len(chunk) > MAX_TOTAL:
                    oversized = True
                    return 0  # libcurl stops the transfer rather than allocating more.
                body.extend(chunk)
                self.total += len(chunk)
                return len(chunk)

            address = addresses[0]
            pinned = f"[{address}]" if ":" in address else address
            # Disallow environment proxies and pin the checked DNS answer. Cookies
            # live only for this single hop and never come from the user's browser.
            options = {CurlOpt.PROXY: "", CurlOpt.MAXFILESIZE_LARGE: MAX_BODY}
            try:
                ipaddress.ip_address(host)
            except ValueError:
                options[CurlOpt.RESOLVE] = [f"{host}:{port}:{pinned}"]
            try:
                with Session(curl_options=options, trust_env=False) as session:
                    response = session.request(method, url, headers=headers or {}, timeout=min(12, max(1, remaining)),
                                               allow_redirects=False, impersonate="chrome", content_callback=receive)
            except Exception:
                if oversized:
                    raise Problem("too_large", "The website returned more content than background research can read.")
                raise Problem("unreachable", "The website could not be read. It may require the browser or be temporarily unavailable.")
            status = int(response.status_code)
            response_headers = {str(k).lower(): str(v) for k, v in response.headers.items()}
            if status in REDIRECTS and response_headers.get("location"):
                url = urljoin(url, response_headers["location"])
                continue
            return {"url": url, "status": status, "headers": response_headers, "body": bytes(body)}
        raise Problem("redirects", "The website redirected too many times.")


def selector_for(response):
    from scrapling.parser import Selector
    return Selector(content=response["body"], url=response["url"])


def useful_text(page, selector=None):
    if selector:
        try:
            elements = page.css(selector)
        except Exception:
            raise Problem("invalid_selector", "The CSS selector could not be read.")
        return "\n\n".join(str(element.get_all_text(strip=True, ignore_tags=("script", "style", "noscript", "template"))) for element in elements[:100])
    elements = page.css("main, article, [role='main']")
    element = elements[0] if elements else page
    return str(element.get_all_text(strip=True, ignore_tags=("script", "style", "noscript", "template", "svg")))


def extract(response, mode, selector=None):
    content_type = response["headers"].get("content-type", "").lower()
    if content_type and not any(kind in content_type for kind in ("html", "text/", "json", "xml")):
        raise Problem("unsupported_content", "This address returns a download rather than a readable web page.")
    page = selector_for(response)
    if "json" in content_type:
        text = response["body"].decode("utf-8", errors="replace")
    else:
        text = useful_text(page, selector)
    text = re.sub(r"\n[ \t]*\n(?:[ \t]*\n)+", "\n\n", text).strip()
    links = []
    seen = set()
    for element in page.css("a[href]"):
        try:
            target = public_url(urljoin(response["url"], str(element.attrib.get("href", ""))), resolve=False)[0]
        except Problem:
            continue
        if target in seen or len(target) > 2048:
            continue
        seen.add(target)
        links.append({"url": target, "text": str(element.get_all_text(separator=" ", strip=True))[:160]})
        if len(links) >= MAX_LINKS:
            break
    status = response["status"]
    return {"ok": 200 <= status < 400, "url": response["url"], "title": str(page.css("title::text").get() or "")[:300],
            "text": text[:MAX_TEXT], "links": links, "fetchedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "status": status, "mode": mode, "truncated": len(text) > MAX_TEXT,
            **({"code": "blocked" if status in (401, 403, 429) else "http_error", "detail": f"The website returned HTTP {status}. It may need the browser."} if not 200 <= status < 400 else {})}


def browser_fetch(url, transport):
    from scrapling.fetchers import StealthyFetcher
    # Resolve redirects before rendering so the document's relative links use
    # its actual final URL. The page itself still uses the guarded transport.
    checked = transport.fetch(public_url(url)[0])["url"]
    installed = False
    main_failure = None

    def setup(page):
        nonlocal installed

        def route_request(route):
            nonlocal main_failure
            request = route.request
            try:
                if request.method not in ("GET", "HEAD") or request.resource_type in ("image", "media", "font", "websocket"):
                    route.abort()
                    return
                result = transport.fetch(request.url, method=request.method, headers={"accept": request.headers.get("accept", "*/*")})
                headers = {k: v for k, v in result["headers"].items() if k not in ("content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie", "location")}
                route.fulfill(status=result["status"], headers=headers, body=result["body"])
            except Exception as error:
                if request.is_navigation_request() and request.frame == page.main_frame:
                    main_failure = error
                with contextlib.suppress(Exception):
                    route.abort()

        try:
            # Context routes cover popup requests as well. All network traffic is
            # fulfilled by Transport, so redirect hops also get public-IP checks.
            page.context.route("**/*", route_request)
            page.context.route_web_socket("**/*", lambda connection: connection.close())
            page.context.on("page", lambda popup: popup.close() if popup != page else None)
            installed = True
        except Exception:
            # Scrapling logs page_setup errors, so close before raising.
            page.close()
            raise Problem("browser_unavailable", "The isolated research browser could not be prepared.")

    try:
        page = StealthyFetcher.fetch(checked, headless=True, timeout=18000, retries=1, google_search=False,
                                    page_setup=setup, additional_args={"service_workers": "block", "accept_downloads": False},
                                    network_idle=False, wait=700, solve_cloudflare=False, block_webrtc=True,
                                    extra_flags=["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"])
    except Exception:
        if main_failure:
            raise main_failure
        raise Problem("browser_unavailable", "Background rendering is unavailable. Run npm --prefix desktop run scraping:setup -- --browser, or use the browser.")
    if not installed:
        raise Problem("browser_unavailable", "The isolated research browser could not be prepared.")
    public_url(str(page.url))
    return {"url": str(page.url), "status": int(page.status), "headers": {str(k).lower(): str(v) for k, v in page.headers.items()}, "body": page.body}


def scrape(request):
    url = public_url(request.get("url"))[0]
    mode = request.get("mode", "auto")
    selector = request.get("selector") or None
    if mode not in ("auto", "http", "browser"):
        raise Problem("invalid_request", "Choose auto, http, or browser mode.")
    if selector is not None and (not isinstance(selector, str) or len(selector) > 500):
        raise Problem("invalid_selector", "Use a CSS selector shorter than 500 characters.")
    transport = Transport()
    if mode == "browser":
        return extract(browser_fetch(url, transport), "browser", selector)
    result = extract(transport.fetch(url), "http", selector)
    shell = len(result["text"]) < 140 or bool(re.search(r"enable javascript|javascript is required|just a moment|checking your browser", result["text"][:1500], re.I))
    if mode == "auto" and (shell or result["status"] in (403, 429, 503)):
        try:
            rendered = extract(browser_fetch(result["url"], transport), "browser", selector)
            if rendered["ok"] and (len(rendered["text"]) > len(result["text"]) or not result["ok"]):
                return rendered
        except Problem as error:
            result["renderingCode"] = error.code
            result["renderingDetail"] = error.detail
        if shell:
            result["ok"] = False
            result["code"] = "needs_browser"
            result["detail"] = "The page did not expose enough readable content. Use the connected browser for this page."
    return result


def search(request):
    query = request.get("query")
    if not isinstance(query, str) or not query.strip() or len(query) > 500:
        raise Problem("invalid_request", "Use a search query between 1 and 500 characters.")
    response = Transport().fetch("https://html.duckduckgo.com/html/?" + urlencode({"q": query.strip()}))
    page = selector_for(response)
    results = []
    for item in page.css(".result"):
        # An ad (result--ad, a y.js link with no uddg): reading it would count as a click on it.
        if "result--ad" in str(item.attrib.get("class", "")):
            continue
        anchors = item.css(".result__a")
        if not anchors:
            continue
        anchor = anchors[0]
        target = urljoin(response["url"], str(anchor.attrib.get("href", "")))
        if "duckduckgo.com" in (urlsplit(target).hostname or ""):
            target = parse_qs(urlsplit(target).query).get("uddg", [""])[0]
            if not target or "duckduckgo.com" in (urlsplit(target).hostname or ""):
                continue
        try:
            target = public_url(target, resolve=False)[0]
        except Problem:
            continue
        snippets = item.css(".result__snippet")
        results.append({"url": target[:2048], "title": str(anchor.get_all_text(separator=" ", strip=True))[:300],
                        "snippet": str(snippets[0].get_all_text(separator=" ", strip=True))[:700] if snippets else ""})
        if len(results) >= 6:
            break
    if not results:
        raise Problem("search_unavailable", "Public search returned no readable results. Try a specific source URL or use the browser.")
    return {"ok": True, "query": query.strip(), "url": response["url"], "results": results,
            "fetchedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "mode": "http", "status": response["status"]}


def run(request):
    if not isinstance(request, dict):
        raise Problem("invalid_request", "Send one search or scrape request.")
    operation = request.get("op")
    if operation not in ("search", "scrape"):
        raise Problem("invalid_request", "Choose the search or scrape operation.")
    try:
        import scrapling  # noqa: F401
        import curl_cffi  # noqa: F401
    except ImportError:
        raise Problem("setup_required", "Install local scraping with npm --prefix desktop run scraping:setup.")
    return search(request) if operation == "search" else scrape(request)


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT:
            raise Problem("invalid_request", "The web request was too large.")
        try:
            request = json.loads(raw)
        except (ValueError, UnicodeError):
            raise Problem("invalid_request", "Send a valid JSON web request.")
        # Keep library logs and incidental output off the protocol channel.
        with contextlib.redirect_stdout(sys.stderr):
            result = run(request)
    except Problem as error:
        result = {"ok": False, "code": error.code, "detail": error.detail}
    except Exception:
        result = {"ok": False, "code": "scrape_failed", "detail": "The website could not be read in the background. Try the connected browser."}
    encoded = json.dumps(result, ensure_ascii=False)
    if len(encoded.encode("utf-8")) > MAX_OUTPUT:
        result["links"] = result.get("links", [])[:10]
        result["text"] = result.get("text", "")[:8000]
        result["truncated"] = True
        encoded = json.dumps(result, ensure_ascii=False)
    print(encoded, flush=True)


if __name__ == "__main__":
    main()
