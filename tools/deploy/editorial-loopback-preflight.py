#!/usr/bin/env python3
"""Read-only local Docker network preflight for Editorial 014B.

No containers are started, no ports are probed, no SQL is executed and no
secrets or environment variables are read. Passing is NOT deployment approval.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from typing import Any

POSTMILL = "postmill-postmill-1"
RECEIVER = "postmill-editorial-bridge-1"
DOCKER = ("docker", "--host=unix:///var/run/docker.sock")
# Inspect only the required fields; never request Docker's full Config.Env.
FORMAT = "|".join([
    "{{json .Id}}",
    "{{json .State.Running}}",
    "{{json .HostConfig.NetworkMode}}",
    "{{json .NetworkSettings.Ports}}",
    "{{json .HostConfig.PortBindings}}",
    "{{json .HostConfig.Privileged}}",
    "{{json .Config.User}}",
    "{{json .HostConfig.Binds}}",
    "{{json .Mounts}}",
])


class Blocked(Exception):
    pass


def docker(command: tuple[str, ...]) -> str:
    env = os.environ.copy()
    for k in ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS",
              "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"):
        env.pop(k, None)
    try:
        result = subprocess.run(
            [*DOCKER, *command], capture_output=True, text=True,
            timeout=12, env=env, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Blocked("local Docker inspection unavailable") from exc
    if result.returncode != 0:
        # Never expose Docker error output or environment/secret values.
        raise Blocked("local Docker inspection failed")
    return result.stdout.strip()


def inspect(name: str) -> dict[str, Any]:
    values = docker(("inspect", "--format", FORMAT, name)).split("|")
    if len(values) != 9:
        raise Blocked("unexpected Docker inspection shape")
    try:
        cid, running, mode, ports, bindings, privileged, user, binds, mounts = (
            json.loads(x) for x in values
        )
    except (ValueError, TypeError) as exc:
        raise Blocked("invalid Docker inspection data") from exc
    if (not isinstance(cid, str) or len(cid) != 64
        or not all(c in "0123456789abcdef" for c in cid)
        or not isinstance(running, bool)
        or not isinstance(mode, str)
        or not isinstance(privileged, bool)
        or not isinstance(user, str)
        or ports is not None and not isinstance(ports, dict)
        or bindings is not None and not isinstance(bindings, dict)
        or binds is not None and not isinstance(binds, list)
        or mounts is not None and not isinstance(mounts, list)
        or any(not isinstance(m, dict) for m in (mounts or []))):
        raise Blocked("invalid Docker inspection fields")
    return dict(id=cid, running=running, mode=mode, ports=ports or {},
                bindings=bindings or {}, privileged=privileged,
                user=user, binds=binds or [], mounts=mounts or [])


def mapped_to_host(fields: dict[str, Any], port: str | None = None) -> bool:
    for group in ("ports", "bindings"):
        for container_port, mappings in fields[group].items():
            if port is not None and not container_port.startswith(port + "/"):
                continue
            if mappings:
                return True
    return False


def exposes_host_port(fields: dict[str, Any], host_port: str) -> bool:
    # Binding an unrelated container port to host port 8794 still exposes the
    # forbidden bridge listener. Check host bindings, not only container keys.
    for mappings in fields["bindings"].values():
        if isinstance(mappings, list):
            for item in mappings:
                if isinstance(item, dict) and item.get("HostPort") == host_port:
                    return True
    for mappings in fields["ports"].values():
        if isinstance(mappings, list):
            for item in mappings:
                if isinstance(item, dict) and item.get("HostPort") == host_port:
                    return True
    return False

def non_root_numeric_user(user: str) -> bool:
    # Image usernames and alternate zero spellings cannot establish an actual
    # non-root UID from Config.User alone. Require an explicit nonzero number.
    parts = user.split(":")
    return (
        len(parts) in (1, 2)
        and all(p.isascii() and p.isdecimal() and 1 <= len(p) <= 10 for p in parts)
        and 0 < int(parts[0]) <= 2147483647
        and (len(parts) == 1 or 0 < int(parts[1]) <= 2147483647)
    )


def collect() -> dict[str, Any]:
    # Listing names first distinguishes a genuinely absent receiver from a
    # Docker permission/daemon failure. An absent receiver is not "ready".
    names = set(docker(("ps", "-a", "--format", "{{.Names}}")).splitlines())
    if POSTMILL not in names:
        raise Blocked("expected Postmill container is missing")
    app = inspect(POSTMILL)
    if not app["running"] or app["mode"] == "host" \
       or app["mode"].startswith("container:") or app["privileged"] \
       or mapped_to_host(app, "8794") or exposes_host_port(app, "8794"):
        raise Blocked("Postmill host/network safety mismatch")

    if RECEIVER not in names:
        return {
            "mode": "read_only",
            "bridge": "NOT_INSTALLED",
            "postmill_container_present": True,
            "receiver_network_namespace_verified": False,
            "loopback_listener_verified": False,
            "test_org_and_db_credentials_verified": False,
            "approved_to_deploy": False,
        }

    peer = inspect(RECEIVER)
    expected_modes = {
        "container:" + POSTMILL,
        "container:" + app["id"],
        "container:" + app["id"][:12],
    }
    # Any other container namespace, bridge network or host mode is blocked.
    if (not peer["running"] or peer["privileged"]
        or peer["mode"] not in expected_modes
        or not non_root_numeric_user(peer["user"])
        or mapped_to_host(peer) or
        any("docker.sock" in str(item) for item in [*peer["binds"], *peer["mounts"]])):
        raise Blocked("receiver network isolation mismatch")

    return {
        "mode": "read_only",
        "bridge": "NETWORK_CONFIG_MATCHES",
        "postmill_container_present": True,
        "receiver_network_namespace_verified": True,
        # Docker inspect does not prove actual socket bind / external ACLs.
        "loopback_listener_verified": False,
        "test_org_and_db_credentials_verified": False,
        "approved_to_deploy": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", required=True)
    args = parser.parse_args()
    if not args.check:
        return 2
    try:
        result = collect()
    except Blocked as exc:
        print("EDITORIAL_NETWORK_PREFLIGHT_BLOCKED: " + str(exc), file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
