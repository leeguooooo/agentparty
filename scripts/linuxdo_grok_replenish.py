#!/usr/bin/env python3
"""Discover Grok CPA leads and import an explicitly authorized local credential copy."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
import shutil
import zipfile
import time
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen


REQUIRED_FIELDS = {"type", "provider", "email", "access_token", "refresh_token", "expires_at"}


class AttachmentParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.attachments: list[tuple[str, str]] = []
        self._href: str | None = None
        self._text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        classes = set((values.get("class") or "").split())
        if tag == "a" and "attachment" in classes and values.get("href"):
            self._href = values["href"]
            self._text = []

    def handle_data(self, data: str) -> None:
        if self._href is not None:
            self._text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._href is not None:
            self.attachments.append((self._href, "".join(self._text).strip()))
            self._href = None
            self._text = []


def discover_candidates(topic_payload: dict, origin: str = "https://linux.do") -> list[dict]:
    topic = topic_payload.get("topic", {})
    title = str(topic.get("title", ""))
    topic_id = topic.get("id")
    if "grok" not in title.lower() or "cpa" not in title.lower():
        return []
    candidates: list[dict] = []
    for post in topic_payload.get("posts", []):
        parser = AttachmentParser()
        parser.feed(str(post.get("cooked", "")))
        for href, filename in parser.attachments:
            if not filename.lower().endswith((".7z", ".zip", ".tar.gz")):
                continue
            candidates.append({
                "topic_id": topic_id,
                "topic_title": title,
                "filename": filename,
                "url": urljoin(origin, href),
                "state": "awaiting_authorized_local_copy",
            })
    return candidates


def valid_credential(payload: object) -> bool:
    if not isinstance(payload, dict) or not REQUIRED_FIELDS.issubset(payload):
        return False
    return (
        payload.get("type") == "xai"
        and payload.get("provider") == "xai"
        and all(isinstance(payload.get(field), str) and payload[field] for field in ("email", "access_token", "refresh_token"))
        and isinstance(payload.get("expires_at"), (int, float))
    )


def credential_id(payload: dict) -> str:
    material = f'{payload["provider"]}\0{payload["email"]}\0{payload["refresh_token"]}'.encode()
    return hashlib.sha256(material).hexdigest()


def existing_ids(target: Path) -> set[str]:
    result: set[str] = set()
    for path in target.glob("*.json"):
        try:
            payload = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if valid_credential(payload):
            result.add(credential_id(payload))
    return result


def import_authorized_directory(source: Path, target: Path, *, authorized: bool) -> dict[str, int]:
    if not authorized:
        raise PermissionError("explicit authorization is required before importing credentials")
    if not source.is_dir():
        raise FileNotFoundError(source)
    target.mkdir(parents=True, exist_ok=True)
    known = existing_ids(target)
    counts = {"imported": 0, "duplicates": 0, "invalid": 0}
    for path in sorted(source.glob("*.json")):
        try:
            payload = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            counts["invalid"] += 1
            continue
        if not valid_credential(payload):
            counts["invalid"] += 1
            continue
        identity = credential_id(payload)
        if identity in known:
            counts["duplicates"] += 1
            continue
        destination = target / f"xai-{identity[:16]}.json"
        fd, temporary = tempfile.mkstemp(prefix=".grok-import-", suffix=".json", dir=target)
        try:
            with os.fdopen(fd, "w") as handle:
                json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
                handle.write("\n")
            os.chmod(temporary, 0o600)
            os.replace(temporary, destination)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        known.add(identity)
        counts["imported"] += 1
    return counts


def _positive_limit(value: object, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return value


def load_authorized_manifest(path: Path) -> dict:
    payload = json.loads(path.read_text())
    if not isinstance(payload, dict):
        raise ValueError("authorized source manifest must be an object")
    sources = payload.get("sources")
    if not isinstance(sources, list) or not sources:
        raise ValueError("authorized source manifest requires sources")
    staging_dir = Path(str(payload.get("staging_dir", ""))).expanduser()
    target_dir = Path(str(payload.get("target_dir", ""))).expanduser()
    pool_file_value = payload.get("pool_file")
    pool_file = Path(str(pool_file_value)).expanduser() if pool_file_value else None
    headers_file_value = payload.get("http_headers_file")
    headers_file = Path(str(headers_file_value)).expanduser() if headers_file_value else None
    if not str(staging_dir) or not str(target_dir):
        raise ValueError("staging_dir and target_dir are required")
    limits = payload.get("limits", {})
    if not isinstance(limits, dict):
        raise ValueError("limits must be an object")
    normalized_sources: list[dict[str, str]] = []
    seen: set[str] = set()
    for index, source in enumerate(sources):
        if not isinstance(source, dict):
            raise ValueError(f"source {index} must be an object")
        source_id = source.get("id")
        topic_url = source.get("topic_url")
        attachment_url = source.get("attachment_url")
        attachment_url_prefix = source.get("attachment_url_prefix")
        if not all(isinstance(value, str) and value for value in (source_id, topic_url)):
            raise ValueError(f"source {index} requires id and topic_url")
        if bool(attachment_url) == bool(attachment_url_prefix):
            raise ValueError(f"source {source_id} requires exactly one attachment_url or attachment_url_prefix")
        if source_id in seen:
            raise ValueError(f"duplicate source id: {source_id}")
        attachment_rule = attachment_url or attachment_url_prefix
        if urlparse(topic_url).scheme not in {"http", "https"} or urlparse(attachment_rule).scheme not in {"http", "https"}:
            raise ValueError(f"source {source_id} URLs must use http or https")
        seen.add(source_id)
        normalized = {"id": source_id, "topic_url": topic_url}
        if attachment_url:
            normalized["attachment_url"] = attachment_url
        else:
            normalized["attachment_url_prefix"] = attachment_url_prefix
        normalized_sources.append(normalized)
    return {
        "staging_dir": staging_dir,
        "target_dir": target_dir,
        "pool_file": pool_file,
        "http_headers_file": headers_file,
        "limits": {
            "max_archive_bytes": _positive_limit(limits.get("max_archive_bytes", 25_000_000), "max_archive_bytes"),
            "max_extracted_bytes": _positive_limit(limits.get("max_extracted_bytes", 100_000_000), "max_extracted_bytes"),
            "max_files": _positive_limit(limits.get("max_files", 1000), "max_files"),
        },
        "sources": normalized_sources,
    }


def _download_exact(url: str, destination: Path, max_bytes: int, *, headers: dict[str, str] | None = None) -> None:
    request_headers = {"User-Agent": "AgentParty authorized Grok replenish/1", **(headers or {})}
    request = Request(url, headers=request_headers)
    with urlopen(request, timeout=30) as response, destination.open("wb") as output:
        content_type = (response.headers.get("Content-Type") or "").lower()
        if "text/html" in content_type:
            raise ValueError("archive magic mismatch: received HTML")
        total = 0
        while chunk := response.read(64 * 1024):
            total += len(chunk)
            if total > max_bytes:
                raise ValueError("compressed archive exceeds configured limit")
            output.write(chunk)


def _safe_extract_zip(archive_path: Path, destination: Path, *, max_files: int, max_extracted_bytes: int) -> None:
    if archive_path.read_bytes()[:4] != b"PK\x03\x04":
        raise ValueError("archive magic mismatch: only ZIP archives are accepted in v1")
    try:
        archive = zipfile.ZipFile(archive_path)
    except zipfile.BadZipFile as error:
        raise ValueError("archive magic mismatch: invalid ZIP") from error
    with archive:
        files = [entry for entry in archive.infolist() if not entry.is_dir()]
        if len(files) > max_files:
            raise ValueError("archive contains too many files")
        total = sum(entry.file_size for entry in files)
        if total > max_extracted_bytes:
            raise ValueError("extracted data exceeds configured limit")
        destination_root = destination.resolve()
        for entry in files:
            target = (destination / entry.filename).resolve()
            if destination_root not in target.parents:
                raise ValueError("unsafe archive path")
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(entry) as source, target.open("wb") as output:
                shutil.copyfileobj(source, output)


def _validated_credentials(source: Path) -> list[dict]:
    credentials: list[dict] = []
    json_paths = sorted(source.rglob("*.json"))
    if not json_paths:
        raise ValueError("archive contains no credential JSON")
    for path in json_paths:
        try:
            payload = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError("invalid credential JSON") from error
        if not valid_credential(payload):
            raise ValueError("invalid credential JSON schema")
        credentials.append(payload)
    return credentials


def _atomic_import(credentials: list[dict], target: Path) -> dict[str, int]:
    target.parent.mkdir(parents=True, exist_ok=True)
    known = existing_ids(target) if target.is_dir() else set()
    unique: list[tuple[str, dict]] = []
    duplicates = 0
    for payload in credentials:
        identity = credential_id(payload)
        if identity in known:
            duplicates += 1
            continue
        known.add(identity)
        unique.append((identity, payload))
    if not unique:
        return {"imported": 0, "duplicates": duplicates, "invalid": 0}
    transaction = Path(tempfile.mkdtemp(prefix=".grok-target-", dir=target.parent))
    try:
        if target.is_dir():
            for existing in target.iterdir():
                if existing.is_file():
                    shutil.copy2(existing, transaction / existing.name)
        for identity, payload in unique:
            destination = transaction / f"xai-{identity[:16]}.json"
            destination.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
            destination.chmod(0o600)
        backup = target.parent / f".{target.name}.backup"
        if backup.exists():
            shutil.rmtree(backup)
        if target.exists():
            os.replace(target, backup)
        try:
            os.replace(transaction, target)
        except Exception:
            if backup.exists():
                os.replace(backup, target)
            raise
        if backup.exists():
            shutil.rmtree(backup)
    finally:
        if transaction.exists():
            shutil.rmtree(transaction)
    return {"imported": len(unique), "duplicates": duplicates, "invalid": 0}


def replenish(manifest_path: Path, source_id: str, *, attachment_url: str | None = None) -> dict[str, int]:
    manifest = load_authorized_manifest(manifest_path)
    source = next((item for item in manifest["sources"] if item["id"] == source_id), None)
    if source is None:
        raise PermissionError(f"source is not registered: {source_id}")
    registered_url = source.get("attachment_url")
    requested_url = attachment_url or registered_url
    if not requested_url or requested_url != registered_url:
        raise PermissionError("requested URL does not match the authorized attachment URL")
    staging_dir: Path = manifest["staging_dir"]
    staging_dir.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix=f"{source_id}-", dir=staging_dir))
    try:
        archive_path = work / "download.zip"
        _download_exact(requested_url, archive_path, manifest["limits"]["max_archive_bytes"])
        extracted = work / "extracted"
        extracted.mkdir()
        _safe_extract_zip(
            archive_path,
            extracted,
            max_files=manifest["limits"]["max_files"],
            max_extracted_bytes=manifest["limits"]["max_extracted_bytes"],
        )
        credentials = _validated_credentials(extracted)
        return _atomic_import(credentials, manifest["target_dir"])
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _topic_json_url(topic_url: str) -> str:
    parsed = urlparse(topic_url)
    path = parsed.path.rstrip("/")
    if not path.startswith("/t/"):
        raise ValueError("registered topic URL must be an exact /t/ URL")
    if not path.endswith(".json"):
        path += ".json"
    return parsed._replace(path=path, query="", fragment="").geturl()


def _local_http_headers(manifest: dict) -> dict[str, str]:
    headers_file = manifest.get("http_headers_file")
    if headers_file is None:
        return {}
    try:
        payload = json.loads(headers_file.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("http_headers_file must contain valid JSON") from error
    if not isinstance(payload, dict) or not all(isinstance(key, str) and isinstance(value, str) for key, value in payload.items()):
        raise ValueError("http_headers_file must contain a string map")
    return payload


def _fetch_topic_json(topic_url: str, headers: dict[str, str]) -> dict:
    request = Request(_topic_json_url(topic_url), headers={
        "Accept": "application/json",
        "User-Agent": "AgentParty authorized Grok replenish/1",
        **headers,
    })
    with urlopen(request, timeout=30) as response:
        content_type = (response.headers.get("Content-Type") or "").lower()
        body = response.read(5_000_001)
    if "json" not in content_type or len(body) > 5_000_000:
        raise ValueError("topic JSON response is invalid")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as error:
        raise ValueError("topic JSON response is invalid") from error
    if not isinstance(payload, dict):
        raise ValueError("topic JSON response is invalid")
    return payload


def _attachment_allowed(source: dict, url: str) -> bool:
    exact = source.get("attachment_url")
    if exact:
        return url == exact
    prefix = source["attachment_url_prefix"]
    parsed_prefix = urlparse(prefix)
    parsed_url = urlparse(url)
    return (
        parsed_url.scheme == parsed_prefix.scheme
        and parsed_url.netloc == parsed_prefix.netloc
        and parsed_url.path.startswith(parsed_prefix.path)
        and parsed_url.query == ""
        and parsed_url.fragment == ""
    )


def rebuild_pool_file(target: Path, pool_file: Path) -> int:
    credentials: list[dict[str, str]] = []
    seen: set[str] = set()
    for path in sorted(target.glob("*.json")):
        try:
            payload = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError("target contains invalid credential JSON") from error
        if not valid_credential(payload):
            raise ValueError("target contains invalid credential JSON schema")
        identity = credential_id(payload)
        if identity in seen:
            continue
        seen.add(identity)
        credentials.append({"id": identity[:16], "token": payload["access_token"]})
    if not credentials:
        raise ValueError("cannot rebuild an empty credential pool")
    pool_file.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{pool_file.name}.", suffix=".tmp", dir=pool_file.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(credentials, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
        os.chmod(temporary, 0o600)
        os.replace(temporary, pool_file)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return len(credentials)


def poll_registered_topics(manifest_path: Path) -> dict[str, int]:
    manifest = load_authorized_manifest(manifest_path)
    pool_file = manifest.get("pool_file")
    if pool_file is None:
        raise ValueError("pool_file is required for topic polling")
    totals = {
        "sources_checked": 0,
        "attachments_seen": 0,
        "rejected_attachments": 0,
        "imported": 0,
        "duplicates": 0,
        "invalid": 0,
        "pool_credentials": 0,
    }
    headers = _local_http_headers(manifest)
    for source in manifest["sources"]:
        topic = _fetch_topic_json(source["topic_url"], headers)
        totals["sources_checked"] += 1
        origin = f'{urlparse(source["topic_url"]).scheme}://{urlparse(source["topic_url"]).netloc}'
        for candidate in discover_candidates(topic, origin):
            url = candidate["url"]
            if not url.lower().endswith(".zip") or not _attachment_allowed(source, url):
                totals["rejected_attachments"] += 1
                continue
            totals["attachments_seen"] += 1
            staging_dir: Path = manifest["staging_dir"]
            staging_dir.mkdir(parents=True, exist_ok=True)
            work = Path(tempfile.mkdtemp(prefix=f'{source["id"]}-', dir=staging_dir))
            try:
                archive_path = work / "download.zip"
                _download_exact(url, archive_path, manifest["limits"]["max_archive_bytes"], headers=headers)
                extracted = work / "extracted"
                extracted.mkdir()
                _safe_extract_zip(
                    archive_path,
                    extracted,
                    max_files=manifest["limits"]["max_files"],
                    max_extracted_bytes=manifest["limits"]["max_extracted_bytes"],
                )
                result = _atomic_import(_validated_credentials(extracted), manifest["target_dir"])
                for key in ("imported", "duplicates", "invalid"):
                    totals[key] += result[key]
                totals["pool_credentials"] = rebuild_pool_file(manifest["target_dir"], pool_file)
            finally:
                shutil.rmtree(work, ignore_errors=True)
    return totals


def watch_registered_topics(
    manifest_path: Path,
    interval_seconds: int,
    *,
    max_cycles: int | None = None,
    sleep=time.sleep,
) -> list[dict[str, int]]:
    if interval_seconds <= 0:
        raise ValueError("interval_seconds must be positive")
    results: list[dict[str, int]] = []
    cycles = 0
    while max_cycles is None or cycles < max_cycles:
        results.append(poll_registered_topics(manifest_path))
        cycles += 1
        if max_cycles is not None and cycles >= max_cycles:
            break
        sleep(interval_seconds)
    return results


def load_json(path: str) -> dict:
    if path == "-":
        return json.load(sys.stdin)
    return json.loads(Path(path).read_text())


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="Grok CPA replenishment staging tool")
    commands = root.add_subparsers(dest="command", required=True)
    discover = commands.add_parser("discover", help="extract attachment metadata from a Linux.do topic JSON")
    discover.add_argument("topic_json", help="topic JSON path, or - for stdin")
    discover.add_argument("--origin", default="https://linux.do")
    import_cmd = commands.add_parser("import-local", help="import a local copy you are authorized to use")
    import_cmd.add_argument("source", type=Path)
    import_cmd.add_argument("target", type=Path)
    import_cmd.add_argument("--authorized", action="store_true", help="confirm the local credentials are owned or authorized")
    replenish_cmd = commands.add_parser("replenish", help="download and import one registered authorized source")
    replenish_cmd.add_argument("manifest", type=Path)
    replenish_cmd.add_argument("source_id")
    replenish_cmd.add_argument("--attachment-url", help="must exactly match the registered attachment URL")
    poll_cmd = commands.add_parser("poll", help="check registered topics and import authorized new ZIP attachments")
    poll_cmd.add_argument("manifest", type=Path)
    watch_cmd = commands.add_parser("watch", help="continuously poll registered topics")
    watch_cmd.add_argument("manifest", type=Path)
    watch_cmd.add_argument("--interval-seconds", type=int, default=300)
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        if args.command == "discover":
            print(json.dumps(discover_candidates(load_json(args.topic_json), args.origin), ensure_ascii=False, indent=2))
            return 0
        if args.command == "watch":
            for result in watch_registered_topics(args.manifest, args.interval_seconds):
                print(json.dumps(result, ensure_ascii=False), flush=True)
            return 0
        if args.command == "poll":
            result = poll_registered_topics(args.manifest)
        elif args.command == "replenish":
            result = replenish(args.manifest, args.source_id, attachment_url=args.attachment_url)
        else:
            result = import_authorized_directory(args.source, args.target, authorized=args.authorized)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
