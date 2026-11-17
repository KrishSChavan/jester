"""Network-policy tests run without installing Scrapling or connecting anywhere."""
import importlib.util
import socket
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("worker", Path(__file__).with_name("worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class PolicyTests(unittest.TestCase):
    def test_private_and_non_web_urls(self):
        for value in ("file:///etc/passwd", "ftp://example.com/", "http://localhost/", "http://127.0.0.1/", "http://[::1]/",
                      "http://169.254.169.254/", "http://10.0.0.1/", "http://[::ffff:127.0.0.1]/", "https://user:password@example.com/",
                      "https://example.com:9222/", "https://a.local/", "https://exa\\mple.com/", "https://example.com/\nfoo"):
            with self.subTest(value=value), self.assertRaises(worker.Problem):
                worker.public_url(value)

    def test_all_dns_answers_must_be_public(self):
        answers = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443)) for ip in ("1.1.1.1", "192.168.1.1")]
        with patch.object(worker.socket, "getaddrinfo", return_value=answers), self.assertRaises(worker.Problem) as error:
            worker.public_url("https://example.com/")
        self.assertEqual(error.exception.code, "private_url")

    def test_public_url_normalizes_and_removes_fragments(self):
        self.assertEqual(worker.public_url("https://Example.com/test#secret", resolve=False)[0], "https://example.com/test")
        self.assertEqual(worker.public_url("https://1.1.1.1/")[3], ["1.1.1.1"])

    def test_redirect_is_checked_and_public_address_is_pinned(self):
        calls = []

        class Session:
            def __init__(self, **options):
                calls.append({"options": options})

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return None

            def request(self, method, url, **options):
                calls[-1].update(method=method, url=url, request=options)
                options["content_callback"](b"redirect")
                return types.SimpleNamespace(status_code=302, headers={"Location": "http://127.0.0.1/private"})

        constants = types.SimpleNamespace(RESOLVE="resolve", PROXY="proxy", MAXFILESIZE_LARGE="maxsize")
        modules = {"curl_cffi": types.SimpleNamespace(CurlOpt=constants), "curl_cffi.requests": types.SimpleNamespace(Session=Session)}
        answers = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 443))]
        with patch.dict(sys.modules, modules), patch.object(worker.socket, "getaddrinfo", return_value=answers):
            with self.assertRaises(worker.Problem) as error:
                worker.Transport().fetch("https://example.com/start")
        self.assertEqual(error.exception.code, "private_url")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["options"]["curl_options"]["resolve"], ["example.com:443:1.1.1.1"])
        self.assertEqual(calls[0]["options"]["curl_options"]["proxy"], "")
        self.assertFalse(calls[0]["request"]["allow_redirects"])

    def test_transport_stops_a_large_body(self):
        class Session:
            def __init__(self, **options): pass
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def request(self, method, url, **options):
                self_result = options["content_callback"](b"x" * (worker.MAX_BODY + 1))
                if self_result == 0:
                    raise RuntimeError("transfer stopped")
        constants = types.SimpleNamespace(RESOLVE="resolve", PROXY="proxy", MAXFILESIZE_LARGE="maxsize")
        modules = {"curl_cffi": types.SimpleNamespace(CurlOpt=constants), "curl_cffi.requests": types.SimpleNamespace(Session=Session)}
        with patch.dict(sys.modules, modules), self.assertRaises(worker.Problem) as error:
            worker.Transport().fetch("https://1.1.1.1/")
        self.assertEqual(error.exception.code, "too_large")


class SearchTests(unittest.TestCase):
    def test_ads_are_dropped_and_redirects_unwrapped(self):
        try:
            import scrapling.parser  # noqa: F401
        except ImportError:
            self.skipTest("Scrapling is not set up")
        html = (
            '<div class="result results_links result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=shop.example">Shop</a>'
            '<a class="result__snippet">50% off</a></div>'
            '<div class="result results_links web-result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.example%2Fpage">Real</a>'
            '<a class="result__snippet">The real answer.</a></div>'
            '<div class="result results_links web-result"><a class="result__a" href="https://duckduckgo.com/y.js?u3=x">Hidden ad</a></div>'
        )

        class Transport:
            def fetch(self, url):
                return {"url": "https://html.duckduckgo.com/html/?q=x", "body": html.encode(), "status": 200}

        with patch.object(worker, "Transport", Transport):
            got = worker.search({"query": "x"})
        self.assertEqual([(item["url"], item["snippet"]) for item in got["results"]], [("https://real.example/page", "The real answer.")])


if __name__ == "__main__":
    unittest.main()
