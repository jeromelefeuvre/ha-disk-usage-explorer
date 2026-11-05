"""Read-only filesystem scanner and scan result store (kept in memory, persisted on disk)."""

from __future__ import annotations

import asyncio
import gzip
import heapq
import json
import logging
import os
import threading
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.util import dt as dt_util

from .const import DOMAIN, SIGNAL_UPDATE

MAX_ITEMS = 100_000
LARGEST_FILES = 20  # files listed in the "largest files" panel for a directory subtree
PROGRESS_INTERVAL = 1.0  # seconds between progress updates pushed to the entity
# Last completed scan, reloaded at startup. Gzipped: a 100 000-entry tree is ~15 MB of JSON.
RESULTS_FILE = ".storage/disk_usage_explorer.last_scan.json.gz"
RESULTS_VERSION = 1
# Scanner attributes saved alongside the tree.
PERSISTED_FIELDS = (
    "path",
    "scan_id",
    "started_at",
    "finished_at",
    "items_scanned",
    "total_bytes",
    "file_count",
    "directory_count",
    "errors",
    "warning_count",
    "symlinks_skipped",
    "hardlinks_deduplicated",
    "truncated",
)

_LOGGER = logging.getLogger(__name__)


def _invalid(key: str, **placeholders: str) -> ServiceValidationError:
    """Build a translated error for a bad request from the card or an action."""
    return ServiceValidationError(
        translation_domain=DOMAIN,
        translation_key=key,
        translation_placeholders=placeholders or None,
    )


def _failed(key: str, **placeholders: str) -> HomeAssistantError:
    """Build a translated error for a request that could not be carried out."""
    return HomeAssistantError(
        translation_domain=DOMAIN,
        translation_key=key,
        translation_placeholders=placeholders or None,
    )


@contextmanager
def closing_fd(fd: int) -> Iterator[int]:
    """Close a raw file descriptor when the block ends, even on error or cancel."""
    try:
        yield fd
    finally:
        os.close(fd)


class ScanCancelled(Exception):
    """Raised inside the worker thread when a scan is stopped."""


class DiskScanner:
    """Scan configured roots without following symbolic links."""

    def __init__(self, hass: HomeAssistant, roots: list[str]) -> None:
        self.hass = hass
        self.roots = [Path(root).resolve() for root in roots]
        self.status = "idle"
        self.path: str | None = None
        self.scan_id: str | None = None
        self.started_at: str | None = None
        self.finished_at: str | None = None
        self.items_scanned = 0
        self.error: str | None = None
        self.errors: list[str] = []
        self.warning_count = 0
        self.symlinks_skipped = 0
        self.hardlinks_deduplicated = 0
        self.truncated = False
        self.total_bytes = 0
        self.file_count = 0
        self.directory_count = 0
        self._tree: dict[str, list[dict[str, Any]]] = {}
        self._task: asyncio.Task | None = None
        # Set synchronously before any await so concurrent calls are rejected.
        self._busy = False
        self._stop_event: threading.Event | None = None

    @property
    def attributes(self) -> dict[str, Any]:
        """Return compact status attributes for the status entity.

        Every user can read entity states, admin or not: nothing here may name a
        file or folder. Paths and warnings are returned by the admin-only browse.
        """
        return {
            "scan_id": self.scan_id,
            "items_scanned": self.items_scanned,
            "total_bytes": self.total_bytes,
            "file_count": self.file_count,
            "directory_count": self.directory_count,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "error": self.error,
            "warning_count": self.warning_count,
            "symlinks_skipped": self.symlinks_skipped,
            "hardlinks_deduplicated": self.hardlinks_deduplicated,
            "truncated": self.truncated,
            "max_items": MAX_ITEMS,
        }

    def _notify(self) -> None:
        async_dispatcher_send(self.hass, SIGNAL_UPDATE)

    def _resolve_scan_path(self, raw_path: str) -> Path:
        """Ensure the requested path stays inside a configured root."""
        if not raw_path or "\x00" in raw_path:
            raise _invalid("path_required")
        candidate = Path(raw_path)
        if not candidate.is_absolute():
            raise _invalid("path_not_absolute")
        try:
            resolved = candidate.resolve(strict=True)
        except (OSError, RuntimeError) as err:
            raise _invalid("path_unreachable", path=raw_path) from err
        if not resolved.is_dir():
            raise _invalid("path_not_directory", path=raw_path)
        if not any(resolved == root or root in resolved.parents for root in self.roots):
            raise _invalid(
                "path_outside_roots",
                path=raw_path,
                roots=", ".join(str(root) for root in self.roots),
            )
        return resolved

    async def async_start_scan(self, raw_path: str) -> None:
        """Validate a path and start a background scan."""
        if self._busy:
            raise _invalid("scan_in_progress")
        self._busy = True
        try:
            root = await self.hass.async_add_executor_job(self._resolve_scan_path, raw_path)
        except BaseException:
            self._busy = False
            raise
        self.path = str(root)
        self.scan_id = uuid.uuid4().hex
        self.status = "scanning"
        self.started_at = dt_util.utcnow().isoformat()
        self.finished_at = None
        self.items_scanned = 0
        self.error = None
        self.errors = []
        self.warning_count = 0
        self.symlinks_skipped = 0
        self.hardlinks_deduplicated = 0
        self.truncated = False
        self.total_bytes = 0
        self.file_count = 0
        self.directory_count = 0
        self._tree = {}
        self._stop_event = threading.Event()
        self._notify()
        self._task = self.hass.async_create_task(self._async_scan(root, self._stop_event))

    def cancel(self) -> None:
        """Ask the worker thread to stop; the scan ends with the "cancelled" status."""
        if not self._busy or not self._stop_event:
            raise _invalid("no_scan_running")
        self._stop_event.set()

    async def async_stop(self) -> None:
        """Stop a running scan, including its worker thread."""
        if self._stop_event:
            self._stop_event.set()
        task = self._task
        if task and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    async def _async_scan(self, root: Path, stop_event: threading.Event) -> None:
        """Run the blocking directory traversal in Home Assistant's executor."""
        try:
            result = await self.hass.async_add_executor_job(self._scan_sync, root, stop_event)
        except asyncio.CancelledError:
            stop_event.set()
            self.status = "idle"
            raise
        except ScanCancelled:
            self.status = "cancelled"
        except Exception as err:  # Filesystem errors are reflected in the entity.
            self.status = "error"
            # The full message may contain paths: log it, expose only the cause.
            _LOGGER.error("Scan of %s failed: %s", root, err)
            self.error = err.strerror if isinstance(err, OSError) and err.strerror else type(err).__name__
        else:
            self._tree = result["tree"]
            self.total_bytes = result["total_bytes"]
            self.file_count = result["file_count"]
            self.directory_count = result["directory_count"]
            self.items_scanned = result["items_scanned"]
            self.errors = result["errors"]
            self.warning_count = result["warning_count"]
            self.symlinks_skipped = result["symlinks_skipped"]
            self.hardlinks_deduplicated = result["hardlinks_deduplicated"]
            self.truncated = result["truncated"]
            self.status = "completed"
        finally:
            self._busy = False
            self.finished_at = dt_util.utcnow().isoformat()
            self._notify()
        if self.status == "completed":
            await self._async_save()

    async def _async_save(self) -> None:
        """Persist the completed scan so it survives a restart."""
        payload = {"version": RESULTS_VERSION, "tree": self._tree}
        payload.update({field: getattr(self, field) for field in PERSISTED_FIELDS})
        try:
            await self.hass.async_add_executor_job(self._save_sync, payload)
        except (OSError, TypeError, ValueError) as err:
            _LOGGER.warning("Could not save the scan results: %s", err)

    def _save_sync(self, payload: dict[str, Any]) -> None:
        path = Path(self.hass.config.path(RESULTS_FILE))
        tmp = path.with_name(f"{path.name}.tmp")
        with gzip.open(tmp, "wt", encoding="utf-8", compresslevel=5) as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, path)

    async def async_load(self) -> None:
        """Restore the last completed scan saved on disk, if still valid."""
        data = await self.hass.async_add_executor_job(self._load_sync)
        if not data:
            return
        for field in PERSISTED_FIELDS:
            setattr(self, field, data.get(field))
        self.errors = self.errors or []
        self._tree = data["tree"]
        self.status = "completed"
        self._notify()

    def _load_sync(self) -> dict[str, Any] | None:
        path = Path(self.hass.config.path(RESULTS_FILE))
        try:
            with gzip.open(path, "rt", encoding="utf-8") as handle:
                data = json.load(handle)
        except FileNotFoundError:
            return None
        except (OSError, ValueError) as err:
            _LOGGER.warning("Ignoring unreadable saved scan results: %s", err)
            return None
        if (
            not isinstance(data, dict)
            or data.get("version") != RESULTS_VERSION
            or not isinstance(data.get("tree"), dict)
            or "" not in data["tree"]
            or not isinstance(data.get("path"), str)
        ):
            return None
        # Roots may have changed since the scan: drop results that are no longer allowed.
        scanned = Path(data["path"])
        if not any(scanned == root or root in scanned.parents for root in self.roots):
            return None
        return data

    def _scan_sync(self, root: Path, stop_event: threading.Event) -> dict[str, Any]:
        """Walk the directory tree, skipping symlinks and recording partial errors."""
        tree: dict[str, list[dict[str, Any]]] = {"": []}
        directories = [""]
        # Each directory carries the (st_dev, st_ino) seen when it was listed, so a
        # directory replaced by a symlink (or moved) before it is visited is skipped.
        root_stat = os.stat(root, follow_symlinks=False)
        stack: list[tuple[Path, str, tuple[int, int]]] = [
            (root, "", (root_stat.st_dev, root_stat.st_ino))
        ]
        errors: list[str] = []
        warning_count = 0
        scanned = files = directory_count = symlinks_skipped = hardlinks = 0
        truncated = False
        # (st_dev, st_ino) of multiply-linked files already counted once.
        seen_inodes: set[tuple[int, int]] = set()
        loop = self.hass.loop
        last_report = time.monotonic()

        def report(count: int) -> None:
            if not stop_event.is_set():
                loop.call_soon_threadsafe(self._async_progress, count, stop_event)

        while stack and not truncated:
            if stop_event.is_set():
                raise ScanCancelled
            directory, relative_dir, identity = stack.pop()
            try:
                # O_NOFOLLOW refuses a symlink as last component; the identity check
                # catches a symlink swapped in higher up the path.
                fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            except OSError as err:
                warning_count += 1
                if len(errors) < 20:
                    errors.append(f"{relative_dir or '/'}: {err.strerror or err}")
                continue
            try:
                opened = os.fstat(fd)
                if (opened.st_dev, opened.st_ino) != identity:
                    warning_count += 1
                    if len(errors) < 20:
                        errors.append(f"{relative_dir or '/'}: changed during the scan, skipped")
                    os.close(fd)
                    continue
                entries = os.scandir(fd)
            except OSError as err:
                os.close(fd)
                warning_count += 1
                if len(errors) < 20:
                    errors.append(f"{relative_dir or '/'}: {err.strerror or err}")
                continue

            children = tree.setdefault(relative_dir, [])
            # Entries stat() relative to fd: it must stay open until the listing is done.
            with closing_fd(fd), entries:
                for entry in entries:
                    if stop_event.is_set():
                        raise ScanCancelled
                    if scanned >= MAX_ITEMS:
                        # Keep what was collected; the rest of the tree is left out.
                        truncated = True
                        break
                    scanned += 1
                    relative = f"{relative_dir}/{entry.name}" if relative_dir else entry.name
                    try:
                        if entry.is_symlink():
                            symlinks_skipped += 1
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            listed = entry.stat(follow_symlinks=False)
                            children.append(
                                {"name": entry.name, "path": relative, "kind": "directory", "size": 0}
                            )
                            tree[relative] = []
                            directories.append(relative)
                            # Entries of an fd-based scandir carry only their name.
                            stack.append(
                                (directory / entry.name, relative, (listed.st_dev, listed.st_ino))
                            )
                            directory_count += 1
                        elif entry.is_file(follow_symlinks=False):
                            stat = entry.stat(follow_symlinks=False)
                            size = stat.st_size
                            item = {"name": entry.name, "path": relative, "kind": "file", "size": size}
                            if stat.st_nlink > 1:
                                inode = (stat.st_dev, stat.st_ino)
                                if inode in seen_inodes:
                                    # Another hard link to data already counted in this scan.
                                    item["size"] = 0
                                    item["hardlink"] = True
                                    hardlinks += 1
                                else:
                                    seen_inodes.add(inode)
                            children.append(item)
                            files += 1
                    except OSError as err:
                        warning_count += 1
                        if len(errors) < 20:
                            errors.append(f"{relative}: {err.strerror or err}")
                    now = time.monotonic()
                    if now - last_report >= PROGRESS_INTERVAL:
                        last_report = now
                        report(scanned)

        for directory in reversed(directories):
            children = tree[directory]
            for child in children:
                if child["kind"] == "directory":
                    child["size"] = sum(item["size"] for item in tree[child["path"]])
            children.sort(key=lambda item: item["size"], reverse=True)

        report(scanned)
        return {
            "tree": tree,
            "total_bytes": sum(item["size"] for item in tree[""]),
            "file_count": files,
            "directory_count": directory_count,
            "errors": errors,
            "warning_count": warning_count,
            "items_scanned": scanned,
            "symlinks_skipped": symlinks_skipped,
            "hardlinks_deduplicated": hardlinks,
            "truncated": truncated,
        }

    def _async_progress(self, count: int, stop_event: threading.Event) -> None:
        """Update progress from the event loop after a worker thread callback."""
        if self.status != "scanning" or stop_event is not self._stop_event or stop_event.is_set():
            return
        self.items_scanned = count
        self._notify()


    async def async_suggest_directories(self, raw_path: str) -> dict[str, list[str]]:
        """Return safe directory completions under the configured roots."""
        paths = await self.hass.async_add_executor_job(self._suggest_directories_sync, raw_path)
        return {"paths": paths}

    def _suggest_directories_sync(self, raw_path: str) -> list[str]:
        """List matching child directories without following symbolic links."""
        raw_path = raw_path.strip()
        if not raw_path or raw_path == os.sep:
            return [f"{root}{os.sep}" for root in self.roots]
        if not Path(raw_path).is_absolute():
            return []

        typed = raw_path.rstrip(os.sep)
        if not typed:
            return [f"{root}{os.sep}" for root in self.roots]
        typed_path = Path(typed)
        inside_root = any(
            typed_path == root or root in typed_path.parents for root in self.roots
        )
        if not inside_root:
            # Still typing a root name: complete roots only.
            return [
                f"{root}{os.sep}" for root in self.roots if str(root).startswith(typed)
            ]
        # e.g. "/media" with roots /media and /media2: offer the sibling root too.
        sibling_roots = (
            []
            if raw_path.endswith(os.sep)
            else [
                f"{root}{os.sep}"
                for root in self.roots
                if str(root).startswith(typed) and str(root) != typed
            ]
        )

        candidate = Path(raw_path)
        if candidate.is_dir():
            parent = candidate
            prefix = ""
        elif raw_path.endswith(os.sep):
            parent = candidate
            prefix = ""
        else:
            parent = candidate.parent
            prefix = candidate.name

        try:
            resolved_parent = self._resolve_scan_path(str(parent))
        except HomeAssistantError:
            return []

        try:
            with os.scandir(resolved_parent) as entries:
                names = sorted(
                    (entry.name for entry in entries
                     if entry.name.startswith(prefix) and entry.is_dir(follow_symlinks=False)),
                    key=str.casefold,
                )
        except OSError as err:
            raise _failed("directory_unreadable", path=str(resolved_parent)) from err

        return sibling_roots + [f"{resolved_parent / name}{os.sep}" for name in names[:100]]

    def _largest_files(self, key: str) -> list[dict[str, Any]]:
        """Return the biggest files anywhere below one scanned directory."""

        def walk():
            stack = [key]
            while stack:
                for item in self._tree.get(stack.pop(), []):
                    if item["kind"] == "directory":
                        stack.append(item["path"])
                    elif item["size"] > 0:
                        yield item

        return heapq.nlargest(LARGEST_FILES, walk(), key=lambda item: item["size"])

    def browse(self, relative_path: str = "") -> dict[str, Any]:
        """Return one directory's contents for the card."""
        if self.status != "completed":
            raise _invalid("no_results")
        # Backslashes are legal in Linux file names; only "/" separates parts.
        if "\x00" in relative_path:
            raise _invalid("relative_path_invalid")
        requested = PurePosixPath(relative_path)
        if requested.is_absolute() or ".." in requested.parts:
            raise _invalid("relative_path_invalid")
        key = str(requested)
        if key == ".":
            key = ""
        if key not in self._tree:
            raise _invalid("not_in_results", path=relative_path)
        items = self._tree[key]
        return {
            "path": key,
            "scan_path": self.path,
            "warnings": self.errors[:20],
            "items": items,
            "largest_files": self._largest_files(key),
            "total_bytes": sum(item["size"] for item in items),
            "file_count": sum(item["kind"] == "file" for item in items),
            "directory_count": sum(item["kind"] == "directory" for item in items),
        }
