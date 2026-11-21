"""Offline tests: no Docker daemon, VPS, secret, HTTP or SQL access."""
import json
import unittest
from unittest.mock import patch

from importlib.util import spec_from_file_location, module_from_spec
from pathlib import Path

PATH = Path(__file__).with_name("editorial-loopback-preflight.py")
spec = spec_from_file_location("editorial_loopback_preflight", PATH)
check = module_from_spec(spec)
spec.loader.exec_module(check)

APP_ID = "a" * 64
PEER_ID = "b" * 64


def inspect_result(cid=APP_ID, mode="postmill_default", running=True,
                   ports=None, bindings=None, privileged=False, user="",
                   binds=None, mounts=None):
    return "|".join(json.dumps(x) for x in (
        cid, running, mode, ports, bindings, privileged, user, binds, mounts
    ))


class NetworkPreflightTests(unittest.TestCase):
    def run_with(self, app=None, peer=None, names=None):
        app = app or inspect_result()
        default_peer = inspect_result(
            cid=PEER_ID, mode="container:" + APP_ID, user="10001:10001",
        )
        commands = []

        def fake_docker(command):
            commands.append(command)
            if command == ("ps", "-a", "--format", "{{.Names}}"):
                if names is not None:
                    return "\n".join(names)
                return check.POSTMILL + "\n" + (check.RECEIVER if peer is not False else "")
            if command[0:3] == ("inspect", "--format", check.FORMAT):
                if command[3] == check.POSTMILL:
                    return app
                if command[3] == check.RECEIVER:
                    return default_peer if peer is None else peer
            self.fail("unexpected Docker inspection command")

        with patch.object(check, "docker", side_effect=fake_docker):
            result = check.collect()
        self.assertTrue(all(command[0] in ("ps", "inspect") for command in commands))
        return result

    def test_no_receiver_is_not_activation_or_deployment_authority(self):
        result = self.run_with(peer=False)
        self.assertEqual(result["bridge"], "NOT_INSTALLED")
        self.assertFalse(result["receiver_network_namespace_verified"])
        self.assertFalse(result["approved_to_deploy"])
        self.assertFalse(result["loopback_listener_verified"])

    def test_shares_postmill_network_namespace_without_host_ports(self):
        result = self.run_with()
        self.assertEqual(result["bridge"], "NETWORK_CONFIG_MATCHES")
        self.assertTrue(result["receiver_network_namespace_verified"])
        self.assertFalse(result["loopback_listener_verified"])
        self.assertFalse(result["test_org_and_db_credentials_verified"])
        self.assertFalse(result["approved_to_deploy"])

    def test_absent_postmill_or_wrong_host_mode_fail_closed(self):
        with self.assertRaisesRegex(check.Blocked, "missing"):
            self.run_with(names=[check.RECEIVER])
        with self.assertRaisesRegex(check.Blocked, "Postmill host/network"):
            self.run_with(app=inspect_result(mode="host"))
        with self.assertRaisesRegex(check.Blocked, "Postmill host/network"):
            self.run_with(app=inspect_result(privileged=True))
        with self.assertRaisesRegex(check.Blocked, "Postmill host/network"):
            self.run_with(app=inspect_result(mode="container:" + PEER_ID))

    def test_any_host_exposure_of_8794_fails(self):
        exposed = {"8794/tcp": [{"HostIp": "0.0.0.0", "HostPort": "8794"}]}
        with self.assertRaisesRegex(check.Blocked, "Postmill host/network"):
            self.run_with(app=inspect_result(ports=exposed))
        with self.assertRaisesRegex(check.Blocked, "Postmill host/network"):
            self.run_with(app=inspect_result(bindings=exposed))
        alias = {"3000/tcp": [{"HostIp": "0.0.0.0", "HostPort": "8794"}]}
        with self.assertRaisesRegex(check.Blocked, "Postmill host/network"):
            self.run_with(app=inspect_result(bindings=alias))

    def test_wrong_receiver_namespace_root_privilege_or_any_port_fails(self):
        peers = (
            inspect_result(cid=PEER_ID, mode="postmill_default", user="10001"),
            inspect_result(cid=PEER_ID, mode="host", user="10001"),
            inspect_result(cid=PEER_ID, mode="container:" + APP_ID, user="root"),
            inspect_result(cid=PEER_ID, mode="container:" + APP_ID, user="0"),
            inspect_result(cid=PEER_ID, mode="container:" + APP_ID, user="0:10001"),
            inspect_result(cid=PEER_ID, mode="container:" + APP_ID, user="00:10001"),
            inspect_result(cid=PEER_ID, mode="container:" + APP_ID, user="root:10001"),
            inspect_result(cid=PEER_ID, mode="container:" + APP_ID, user="app"),
            inspect_result(cid=PEER_ID, mode="container:" + APP_ID, user="10001", privileged=True),
            inspect_result(cid=PEER_ID, mode="container:" + APP_ID,
                           user="10001", bindings={"80/tcp": [{"HostPort": "80"}]}),
            inspect_result(cid=PEER_ID, mode="container:" + APP_ID,
                           user="10001", binds=["/var/run/docker.sock:/var/run/docker.sock"]),
            # docker --mount can leave HostConfig.Binds empty; inspect .Mounts.
            inspect_result(cid=PEER_ID, mode="container:" + APP_ID,
                           user="10001", mounts=[{
                               "Type": "bind",
                               "Source": "/var/run/docker.sock",
                               "Destination": "/var/run/docker.sock",
                           }]),
        )
        for peer in peers:
            with self.subTest(peer=peer[:80]):
                with self.assertRaisesRegex(check.Blocked, "receiver network isolation"):
                    self.run_with(peer=peer)

    def test_explicit_numeric_nonroot_user_only(self):
        self.assertTrue(check.non_root_numeric_user("10001:10001"))
        self.assertTrue(check.non_root_numeric_user("10001"))
        for user in ("0", "00", "000:10001", "root", "app", "", " 10001",
                     "10001:root", "10001:0", "-1", "4294967295",
                     "1" * 5000, "10001:"):
            self.assertFalse(check.non_root_numeric_user(user))

    def test_unparseable_docker_data_never_becomes_approved(self):
        with self.assertRaisesRegex(check.Blocked, "unexpected Docker inspection shape"):
            self.run_with(app="unexpected")

    def test_docker_error_is_not_interpreted_as_receiver_absent(self):
        with patch.object(check, "docker", side_effect=check.Blocked("permission denied")):
            with self.assertRaisesRegex(check.Blocked, "permission denied"):
                check.collect()


if __name__ == "__main__":
    unittest.main()
