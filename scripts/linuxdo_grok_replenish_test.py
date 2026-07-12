import importlib.util
import json
import tempfile
import unittest
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread


SCRIPT = Path(__file__).with_name("linuxdo_grok_replenish.py")
SPEC = importlib.util.spec_from_file_location("linuxdo_grok_replenish", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class LinuxDoGrokReplenishTest(unittest.TestCase):
    def test_discovers_grok_cpa_attachment_metadata_without_downloading(self):
        topic = {
            "topic": {"id": 2571014, "title": "新鲜 GROK CPA 直接导入"},
            "posts": [{
                "cooked": '<p>分享</p><a class="attachment" href="/uploads/short-url/example.7z">grok_cpa.7z</a>',
            }],
        }
        candidates = MODULE.discover_candidates(topic, "https://linux.do")
        self.assertEqual(candidates, [{
            "topic_id": 2571014,
            "topic_title": "新鲜 GROK CPA 直接导入",
            "filename": "grok_cpa.7z",
            "url": "https://linux.do/uploads/short-url/example.7z",
            "state": "awaiting_authorized_local_copy",
        }])

    def test_rejects_import_without_explicit_authorization(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            target = Path(directory) / "target"
            source.mkdir()
            (source / "xai.json").write_text(json.dumps(valid_credential("a@example.com")))
            with self.assertRaisesRegex(PermissionError, "authorization"):
                MODULE.import_authorized_directory(source, target, authorized=False)

    def test_validates_deduplicates_and_atomically_imports_authorized_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            target = Path(directory) / "target"
            source.mkdir()
            target.mkdir()
            credential = valid_credential("a@example.com")
            (source / "first.json").write_text(json.dumps(credential))
            (source / "duplicate.json").write_text(json.dumps(credential))
            (source / "invalid.json").write_text("{}")

            result = MODULE.import_authorized_directory(source, target, authorized=True)

            self.assertEqual(result, {"imported": 1, "duplicates": 1, "invalid": 1})
            imported = list(target.glob("*.json"))
            self.assertEqual(len(imported), 1)
            self.assertEqual(json.loads(imported[0].read_text())["email"], "a@example.com")

    def test_replenishes_an_exact_authorized_source_via_staging_idempotently(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = make_zip(root / "authorized.zip", {"credential.json": json.dumps(valid_credential("a@example.com"))})
            with serve_file(archive) as url:
                manifest = write_manifest(root, url)
                first = MODULE.replenish(manifest, "registered-source")
                second = MODULE.replenish(manifest, "registered-source")

            self.assertEqual(first, {"imported": 1, "duplicates": 0, "invalid": 0})
            self.assertEqual(second, {"imported": 0, "duplicates": 1, "invalid": 0})
            self.assertEqual(len(list((root / "target").glob("*.json"))), 1)
            self.assertEqual(list((root / "staging").iterdir()), [])

    def test_rejects_unregistered_or_non_exact_attachment_urls(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = write_manifest(root, "http://127.0.0.1:9/exact.zip")
            with self.assertRaisesRegex(PermissionError, "not registered"):
                MODULE.replenish(manifest, "unknown")
            payload = json.loads(manifest.read_text())
            payload["sources"][0]["attachment_url"] = "http://127.0.0.1:9/changed.zip"
            manifest.write_text(json.dumps(payload))
            with self.assertRaisesRegex(PermissionError, "authorized attachment URL"):
                MODULE.replenish(manifest, "registered-source", attachment_url="http://127.0.0.1:9/exact.zip")

    def test_rejects_html_wrong_magic_invalid_json_and_oversized_archives_without_changing_target(self):
        fixtures = [
            (b"<html>challenge</html>", "archive magic"),
            (make_zip_bytes({"credential.json": "not-json"}), "credential JSON"),
            (make_zip_bytes({"credential.json": json.dumps(valid_credential("a@example.com"))}), "compressed archive exceeds"),
        ]
        for content, message in fixtures:
            with self.subTest(message=message), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                existing = root / "target" / "existing.json"
                existing.parent.mkdir()
                existing.write_text(json.dumps(valid_credential("existing@example.com")))
                fixture = root / "fixture.bin"
                fixture.write_bytes(content)
                with serve_file(fixture) as url:
                    manifest = write_manifest(root, url, max_archive_bytes=8 if message.startswith("compressed") else 1_000_000)
                    with self.assertRaisesRegex((ValueError, OSError), message):
                        MODULE.replenish(manifest, "registered-source")
                self.assertEqual(list((root / "target").glob("*.json")), [existing])

    def test_rejects_path_traversal_and_file_count_or_extracted_size_limits(self):
        cases = [
            ({"../escape.json": "{}"}, {}, "unsafe archive path"),
            ({"one.json": "{}", "two.json": "{}"}, {"max_files": 1}, "too many files"),
            ({"large.json": "x" * 100}, {"max_extracted_bytes": 10}, "extracted data exceeds"),
        ]
        for files, limits, message in cases:
            with self.subTest(message=message), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archive = make_zip(root / "fixture.zip", files)
                with serve_file(archive) as url:
                    manifest = write_manifest(root, url, **limits)
                    with self.assertRaisesRegex(ValueError, message):
                        MODULE.replenish(manifest, "registered-source")
                self.assertFalse((root / "escape.json").exists())
                self.assertFalse((root / "target").exists())

    def test_poll_registered_topics_discovers_downloads_imports_and_rebuilds_pool_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = make_zip_bytes({"credential.json": json.dumps(valid_credential("new@example.com"))})
            routes = {
                "/t/topic/authorized.json": ("application/json", json.dumps({
                    "topic": {"id": 42, "title": "Grok CPA authorized"},
                    "posts": [{"cooked": '<a class="attachment" href="/uploads/authorized/new.zip">new.zip</a>'}],
                }).encode()),
                "/uploads/authorized/new.zip": ("application/zip", archive),
            }
            with serve_routes(routes) as origin:
                manifest = write_poll_manifest(root, origin)
                result = MODULE.poll_registered_topics(manifest)

            self.assertEqual(result["sources_checked"], 1)
            self.assertEqual(result["attachments_seen"], 1)
            self.assertEqual(result["imported"], 1)
            pool = json.loads((root / "pool.json").read_text())
            self.assertEqual(len(pool), 1)
            self.assertEqual(pool[0]["id"], MODULE.credential_id(valid_credential("new@example.com"))[:16])
            self.assertEqual(pool[0]["token"], "access-test-value")

    def test_poll_is_idempotent_and_rejects_attachments_outside_the_registered_prefix(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = make_zip_bytes({"credential.json": json.dumps(valid_credential("new@example.com"))})
            routes = {
                "/t/topic/authorized.json": ("application/json", json.dumps({
                    "topic": {"id": 42, "title": "Grok CPA authorized"},
                    "posts": [{
                        "cooked": (
                            '<a class="attachment" href="/uploads/authorized/new.zip">new.zip</a>'
                            '<a class="attachment" href="/uploads/untrusted/bad.zip">bad.zip</a>'
                        ),
                    }],
                }).encode()),
                "/uploads/authorized/new.zip": ("application/zip", archive),
                "/uploads/untrusted/bad.zip": ("application/zip", archive),
            }
            with serve_routes(routes) as origin:
                manifest = write_poll_manifest(root, origin)
                first = MODULE.poll_registered_topics(manifest)
                second = MODULE.poll_registered_topics(manifest)

            self.assertEqual(first["attachments_seen"], 1)
            self.assertEqual(first["rejected_attachments"], 1)
            self.assertEqual(first["imported"], 1)
            self.assertEqual(second["imported"], 0)
            self.assertEqual(second["duplicates"], 1)
            self.assertEqual(len(json.loads((root / "pool.json").read_text())), 1)

    def test_pool_file_is_not_replaced_when_topic_or_import_is_invalid(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pool_file = root / "pool.json"
            pool_file.write_text(json.dumps([{"id": "existing", "token": "existing-token"}]))
            routes = {
                "/t/topic/authorized.json": ("text/html", b"<html>login challenge</html>"),
            }
            with serve_routes(routes) as origin:
                manifest = write_poll_manifest(root, origin)
                with self.assertRaisesRegex(ValueError, "topic JSON"):
                    MODULE.poll_registered_topics(manifest)
            self.assertEqual(json.loads(pool_file.read_text()), [{"id": "existing", "token": "existing-token"}])

    def test_watch_repeats_polling_with_injected_sleep_and_local_auth_headers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = make_zip_bytes({"credential.json": json.dumps(valid_credential("new@example.com"))})
            requests = []
            routes = {
                "/t/topic/authorized.json": ("application/json", json.dumps({
                    "topic": {"id": 42, "title": "Grok CPA authorized"},
                    "posts": [{"cooked": '<a class="attachment" href="/uploads/authorized/new.zip">new.zip</a>'}],
                }).encode()),
                "/uploads/authorized/new.zip": ("application/zip", archive),
            }
            with serve_routes(routes, requests=requests) as origin:
                manifest = write_poll_manifest(root, origin, headers={"Cookie": "fake-session-cookie"})
                sleeps = []
                results = MODULE.watch_registered_topics(manifest, 7, max_cycles=2, sleep=sleeps.append)

            self.assertEqual(len(results), 2)
            self.assertEqual(sleeps, [7])
            self.assertEqual(results[0]["imported"], 1)
            self.assertEqual(results[1]["duplicates"], 1)
            self.assertTrue(all(request[1] == "fake-session-cookie" for request in requests))


def valid_credential(email: str):
    return {
        "type": "xai",
        "provider": "xai",
        "email": email,
        "access_token": "access-test-value",
        "refresh_token": "refresh-test-value",
        "expires_at": 2_000_000_000,
    }


def make_zip(path: Path, files: dict[str, str]) -> Path:
    with zipfile.ZipFile(path, "w") as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return path


def make_zip_bytes(files: dict[str, str]) -> bytes:
    with tempfile.NamedTemporaryFile(suffix=".zip") as handle:
        make_zip(Path(handle.name), files)
        return Path(handle.name).read_bytes()


def write_manifest(root: Path, attachment_url: str, **limits: int) -> Path:
    manifest = root / "authorized-sources.json"
    manifest.write_text(json.dumps({
        "staging_dir": str(root / "staging"),
        "target_dir": str(root / "target"),
        "limits": {
            "max_archive_bytes": limits.get("max_archive_bytes", 1_000_000),
            "max_extracted_bytes": limits.get("max_extracted_bytes", 1_000_000),
            "max_files": limits.get("max_files", 20),
        },
        "sources": [{
            "id": "registered-source",
            "topic_url": "https://linux.do/t/topic/authorized",
            "attachment_url": attachment_url,
        }],
    }))
    return manifest


def write_poll_manifest(root: Path, origin: str, headers: dict | None = None) -> Path:
    headers_file = root / "headers.json"
    if headers is not None:
        headers_file.write_text(json.dumps(headers))
    manifest = root / "authorized-sources.json"
    manifest.write_text(json.dumps({
        "staging_dir": str(root / "staging"),
        "target_dir": str(root / "target"),
        "pool_file": str(root / "pool.json"),
        **({"http_headers_file": str(headers_file)} if headers is not None else {}),
        "limits": {
            "max_archive_bytes": 1_000_000,
            "max_extracted_bytes": 1_000_000,
            "max_files": 20,
        },
        "sources": [{
            "id": "registered-source",
            "topic_url": f"{origin}/t/topic/authorized",
            "attachment_url_prefix": f"{origin}/uploads/authorized/",
        }],
    }))
    return manifest


class serve_file:
    def __init__(self, path: Path):
        self.path = path

    def __enter__(self):
        content = self.path.read_bytes()

        class Handler(BaseHTTPRequestHandler):
            def do_GET(inner_self):
                inner_self.send_response(200)
                inner_self.send_header("Content-Length", str(len(content)))
                inner_self.end_headers()
                inner_self.wfile.write(content)

            def log_message(self, *_args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}/{self.path.name}"

    def __exit__(self, *_args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class serve_routes:
    def __init__(self, routes, requests=None):
        self.routes = routes
        self.requests = requests

    def __enter__(self):
        routes = self.routes
        requests = self.requests

        class Handler(BaseHTTPRequestHandler):
            def do_GET(inner_self):
                if requests is not None:
                    requests.append((inner_self.path, inner_self.headers.get("Cookie")))
                route = routes.get(inner_self.path)
                if route is None:
                    inner_self.send_response(404)
                    inner_self.end_headers()
                    return
                content_type, content = route
                inner_self.send_response(200)
                inner_self.send_header("Content-Type", content_type)
                inner_self.send_header("Content-Length", str(len(content)))
                inner_self.end_headers()
                inner_self.wfile.write(content)

            def log_message(self, *_args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}"

    def __exit__(self, *_args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


if __name__ == "__main__":
    unittest.main()
