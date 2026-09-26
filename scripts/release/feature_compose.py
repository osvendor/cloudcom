#!/usr/bin/env python3
"""Prepare an API-only, no-new-image CloudCom feature release Compose file.

This does not restart services. The caller must verify the signed artifact first,
validate the resulting Compose, retain the old file, and health-check promotion.
"""
import argparse
import json
import os
import re
from pathlib import Path

TARGETS = {
    "/app/apps/api/dist": "dist",
    "/app/packages/ext-cloud-command/dist/web": "packages/ext-cloud-command/dist/web",
}
WORKER_TARGETS = {
    "/app/exchange-worker.py": "worker/exchange-worker.py",
    "/app/exchange-persistent.ps1": "worker/exchange-persistent.ps1",
}


def prepare(source: dict, release_dir: Path, expected_image: str, expected_worker_image: str | None = None,
            allowed_root: Path = Path("/opt/cloudcom/features"),
            migration_files: tuple[str, ...] = ()) -> dict:
    if not release_dir.is_absolute() or release_dir.resolve(strict=True) != release_dir:
        raise ValueError("release directory must be an existing absolute path without symlinks")
    if not release_dir.is_relative_to(allowed_root):
        raise ValueError("release directory is outside the CloudCom feature area")
    api = source.get("services", {}).get("api")
    if not isinstance(api, dict) or api.get("image") != expected_image:
        raise ValueError("configured API image differs from signed artifact base")
    volumes = api.get("volumes", [])
    if not isinstance(volumes, list) or any(not isinstance(mount, dict) for mount in volumes):
        raise ValueError("API volumes must use long form")
    retained = []
    previous_migrations = set()
    for mount in volumes:
        target = mount.get("target")
        if target in TARGETS or target == "/app/packages/ext-cloud-command/manifest.json" or (
            isinstance(target, str) and target.startswith("/app/packages/ext-cloud-command/migrations/")
        ):
            old_source = mount.get("source")
            if mount.get("type") != "bind" or not isinstance(old_source, str) or not Path(old_source).is_relative_to(allowed_root):
                raise ValueError(f"unexpected existing mount at {target}")
            if target not in TARGETS:
                previous_migrations.add(target)
            continue
        retained.append(mount)
    migration_targets = {}
    if migration_files:
        migration_targets["/app/packages/ext-cloud-command/manifest.json"] = (
            "packages/ext-cloud-command/manifest.json"
        )
        if len(migration_files) > 16 or len(set(migration_files)) != len(migration_files):
            raise ValueError("invalid migration set")
        for name in migration_files:
            if not re.fullmatch(r"20[0-9]{2}-[a-z0-9][a-z0-9._-]*\.sql", name):
                raise ValueError("invalid migration name")
            migration_targets[f"/app/packages/ext-cloud-command/migrations/{name}"] = (
                f"packages/ext-cloud-command/migrations/{name}"
            )
    if not previous_migrations.issubset(migration_targets):
        raise ValueError("feature release would remove a previously mounted extension migration")
    for target, member in TARGETS.items():
        path = release_dir / member
        if not path.is_dir() or path.is_symlink():
            raise ValueError(f"artifact directory missing: {member}")
        retained.append({"type": "bind", "source": str(path), "target": target, "read_only": True})
    for target, member in migration_targets.items():
        path = release_dir / member
        if not path.is_file() or path.is_symlink():
            raise ValueError(f"artifact file missing: {member}")
        retained.append({"type": "bind", "source": str(path), "target": target, "read_only": True})
    api["volumes"] = retained
    if expected_worker_image:
        worker = source.get("services", {}).get("cloudcom-exchange-worker")
        if not isinstance(worker, dict) or worker.get("image") != expected_worker_image:
            raise ValueError("configured Exchange worker image differs from signed artifact base")
        worker_volumes = worker.get("volumes", [])
        if not isinstance(worker_volumes, list) or any(not isinstance(mount, dict) for mount in worker_volumes):
            raise ValueError("Exchange worker volumes must use long form")
        kept = []
        for mount in worker_volumes:
            target = mount.get("target")
            if target in WORKER_TARGETS:
                old_source = mount.get("source")
                if mount.get("type") != "bind" or not isinstance(old_source, str) or not Path(old_source).is_relative_to(allowed_root):
                    raise ValueError(f"unexpected existing mount at {target}")
                continue
            kept.append(mount)
        for target, member in WORKER_TARGETS.items():
            path = release_dir / member
            if not path.is_file() or path.is_symlink():
                raise ValueError(f"artifact file missing: {member}")
            kept.append({"type": "bind", "source": str(path), "target": target, "read_only": True})
        worker["volumes"] = kept
    return source


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--compose", required=True, type=Path)
    parser.add_argument("--release-dir", required=True, type=Path)
    parser.add_argument("--expected-image", required=True)
    parser.add_argument("--expected-worker-image")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--test-root", type=Path)
    parser.add_argument("--migration-file", action="append", default=[])
    args = parser.parse_args()
    if args.test_root and os.geteuid() == 0:
        raise ValueError("test root is forbidden when running as root")
    if args.output.exists():
        raise ValueError("output already exists")
    document = json.loads(args.compose.read_text())
    result = prepare(document, args.release_dir, args.expected_image, args.expected_worker_image,
                     args.test_root if args.test_root else Path("/opt/cloudcom/features"),
                     tuple(args.migration_file))
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(result, stream, indent=2)
        stream.write("\n")


if __name__ == "__main__":
    main()
