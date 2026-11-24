"""Offline integration of the real updater against a recording Docker double."""
import copy
import importlib.machinery
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader('updater', str(Path(__file__).with_name('postmill-update')))
spec = importlib.util.spec_from_loader(loader.name, loader)
u = importlib.util.module_from_spec(spec)
loader.exec_module(u)
SHA = 'a' * 40
OLD = 'ghcr.io/postmill-ai/postmill-app@sha256:' + '1' * 64
NEW = u.REPOSITORY + '@sha256:' + '2' * 64
CONFIG = {'name': 'postmill', 'services': {
    'postmill': {'image': OLD, 'environment': {'CERT': '/cert', 'OPENAI_BASE': 'http://gpt2giga:8080'},
                 'networks': {'default': None, 'giga': None}, 'volumes': [
                     {'type': 'volume', 'source': 'data', 'target': '/uploads'},
                     {'type': 'bind', 'source': '/opt/cert.pem', 'target': '/cert', 'read_only': True}]},
    'gpt2giga': {'image': 'giga:existing'}, 'postgres': {'image': 'pg:existing'},
    'redis': {'image': 'redis:existing'}, 'inngest': {'image': 'inngest:existing'}},
    'networks': {'default': {'name': 'postmill_default'}, 'giga': {'name': 'giga_external'}},
    'volumes': {'data': {'name': 'postmill_uploads'}}}

class Docker:
    def __init__(self, root):
        self.root, self.calls = root, []
        self.current = {'Id': 'container', 'Image': 'sha256:old', 'Config': {'Image': OLD,
            'Env': ['CERT=/cert', 'OPENAI_BASE=http://gpt2giga:8080'],
            'Labels': {'com.docker.compose.project': 'postmill', 'com.docker.compose.service': 'postmill'}},
            'State': {'Running': True, 'Health': {'Status': 'healthy'}},
            'NetworkSettings': {'Networks': {'postmill_default': {}, 'giga_external': {}}},
            'Mounts': [{'Destination': '/uploads', 'Name': 'postmill_uploads', 'Type': 'volume', 'RW': True},
                       {'Destination': '/cert', 'Source': '/opt/cert.pem', 'Type': 'bind', 'RW': False}]}
        self.other = {'Id': 'pg', 'Image': 'pg:unchanged', 'RestartCount': 0,
                      'State': {'StartedAt': 'unchanged'}, 'Config': {'Labels': {'com.docker.compose.service': 'postgres'}}}
        self.fail_up = False
        self.changed_schema = False
        self.extra_override = False
        self.corrupt_others = False
        self.bridge = None
        self.bridge_declared = False
        self.bridge_wrong_namespace = False
        self.bridge_fail_up = False
        self.bridge_wrong_image = False

    def enable_bridge(self):
        self.bridge_declared = True
        self.current['State']['Pid'] = 100
        self.bridge = {
            'Id': 'bridge-old', 'Name': '/' + u.BRIDGE_CONTAINER,
            'Image': 'sha256:bridge', 'RestartCount': 0,
            'Config': {'Env': ['BRIDGE_ENABLED=1'], 'Labels': {
                'com.docker.compose.project': 'postmill',
                'com.docker.compose.service': u.BRIDGE_SERVICE}},
            'State': {'Running': True, 'StartedAt': 'old', 'Pid': 200},
            'HostConfig': {'NetworkMode': 'container:' + self.current['Id']},
            'Mounts': [],
        }

    def __call__(self, *args, **kwargs):
        self.calls.append(args)
        if args[:3] == ('compose', 'version', '--short'):
            return '2.39.0'
        if args[0] == 'compose':
            if 'config' in args:
                config = copy.deepcopy(CONFIG)
                if self.bridge_declared:
                    config['services'][u.BRIDGE_SERVICE] = {'image': 'bridge:existing', 'network_mode': 'service:postmill', 'environment': {'BRIDGE_ENABLED': '1'}}
                files = [args[i+1] for i, a in enumerate(args) if a == '-f']
                if len(files) == 4:
                    value = Path(files[3]).read_text()
                    # Test output written by the real overlay renderer, no YAML dependency.
                    config['services']['postmill']['image'] = json.loads(value.split('image: ', 1)[1])
                    if self.extra_override:
                        config['services']['postmill']['environment']['CERT'] = 'lost'
                return json.dumps(config)
            if 'stop' in args and args[-1] == u.BRIDGE_SERVICE:
                if self.bridge:
                    self.bridge['State']['Running'] = False
                return ''
            if 'up' in args:
                if args[-1] == u.BRIDGE_SERVICE:
                    if self.bridge_fail_up:
                        raise u.Refused('bridge startup failed')
                    self.bridge['Id'] += '-recreated'
                    self.bridge['State']['Running'] = True
                    self.bridge['State']['StartedAt'] = 'recreated'
                    self.bridge['HostConfig']['NetworkMode'] = 'container:' + self.current['Id']
                    if self.bridge_wrong_image:
                        self.bridge['Image'] = 'sha256:foreign'
                    return ''
                if self.fail_up:
                    self.current['Image'] = 'sha256:new'
                    self.current['State']['Running'] = False
                    raise u.Refused('health failed')
                ref = json.loads((self.root / 'compose.image.yaml').read_text().split('image: ', 1)[1])
                self.current['Image'] = 'sha256:new' if ref == NEW else 'sha256:old'
                self.current['Config']['Image'] = ref
                self.current['State']['Running'] = True
                if self.bridge_declared:
                    self.current['Id'] += '-recreated'
                if self.corrupt_others:
                    self.other['RestartCount'] += 1
                return ''
        if args[:2] == ('image', 'inspect'):
            if args[2] == 'bridge:existing':
                return json.dumps([{'Id': 'sha256:bridge'}])
            old = args[2] in (OLD, 'sha256:old')
            return json.dumps([{'Id': 'sha256:old' if old else 'sha256:new', 'Os': 'linux', 'Architecture': 'amd64',
                'RepoDigests': [OLD if old else NEW], 'Config': {'Labels': {
                    'org.opencontainers.image.source': 'https://github.com/AREN-876/postmill-app',
                    'org.opencontainers.image.revision': SHA}}}])
        if args[0] == 'inspect':
            if args[1] == u.CONTAINER:
                return json.dumps([self.current])
            if args[1] == u.BRIDGE_CONTAINER:
                return json.dumps([self.bridge])
            return json.dumps([self.other] + ([self.bridge] if self.bridge else []))
        if args[0] == 'run':
            return json.dumps({'schema.prisma': 'changed' if self.changed_schema and 'sha256:new' in args else 'same', 'migrations/existing.sql': 'same'})
        if args[0] == 'ps':
            return 'pg bridge' if self.bridge else 'pg'
        if args[0] == 'exec' and args[-1] == 'http://127.0.0.1:8794/':
            return '501'
        if args[0] in ('pull', 'exec'):
            return ''
        raise AssertionError(args)

class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for name in u.FILES[:3]:
            (self.root / name).write_text('existing settings; untouched')
        self.up = u.Updater(self.root)
        self.docker = Docker(self.root)
        self.patch = patch.object(u, 'run', self.docker)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_update_and_rollback_first_official_digest(self):
        self.up.apply(SHA)
        self.assertIn(NEW, self.up.override.read_text())
        self.assertEqual(json.loads((self.up.state/'previous.json').read_text())['old_ref'], OLD)
        self.up.apply(None, rollback=True)
        self.assertIn(OLD, self.up.override.read_text())
        for call in (c for c in self.docker.calls if c[0] == 'compose' and 'up' in c):
            self.assertEqual(call[-1], 'postmill')
            for flag in ['--no-deps', '--no-build', '--wait', '--wait-timeout']:
                self.assertIn(flag, call)
            files = [call[i+1] for i, a in enumerate(call) if a == '-f']
            self.assertEqual(files, [str(self.root/f) for f in u.FILES])
            self.assertIn('never', call)
        self.assertFalse((self.up.state/'pending.json').exists())
        for name in u.FILES[:3]:
            self.assertEqual((self.root/name).read_text(), 'existing settings; untouched')
        self.assertFalse(any(any(v in ('down', 'prune', 'build') for v in c[:2]) for c in self.docker.calls))

    def test_schema_change_blocks_before_override_or_up(self):
        self.docker.changed_schema = True
        with self.assertRaisesRegex(u.Refused, 'Schema/migrations differ'):
            self.up.apply(SHA)
        self.assertFalse(self.up.override.exists())
        self.assertFalse(any('up' in c for c in self.docker.calls))

    def test_health_failure_retains_recovery_and_rollback_works_stopped(self):
        self.docker.fail_up = True
        with self.assertRaisesRegex(u.Refused, 'Recovery state retained'):
            self.up.apply(SHA)
        with self.assertRaisesRegex(u.Refused, 'Interrupted/failed'):
            self.up.apply(SHA)
        self.docker.fail_up = False
        self.up.apply(None, rollback=True)
        self.assertIn(OLD, self.up.override.read_text())
        self.assertFalse((self.up.state/'pending.json').exists())
        self.assertFalse((self.up.state/'previous.json').exists())

    def test_interrupted_before_recreate_restores_override_even_if_old_running(self):
        (self.up.state/'pending.json').write_text(json.dumps({'old_ref': OLD, 'old_id': 'sha256:old', 'target_id': 'sha256:new'}))
        self.up.override.write_text(u.overlay(NEW))
        self.up.apply(None, rollback=True)
        self.assertIn(OLD, self.up.override.read_text())
        self.assertFalse((self.up.state/'pending.json').exists())

    def test_extra_override_fields_are_refused(self):
        self.up.override.write_text(u.overlay(OLD))
        self.docker.extra_override = True
        with self.assertRaisesRegex(u.Refused, 'more than'):
            self.up.apply(SHA)

    def test_unmanaged_network_environment_or_mount_changes_are_refused(self):
        cases = [lambda c: c['NetworkSettings']['Networks'].update({'manual': {}}),
                 lambda c: c['Config']['Env'].append('CERT=/different'),
                 lambda c: c['Mounts'].pop()]
        for mutate in cases:
            with self.subTest(mutate=mutate):
                old = copy.deepcopy(self.docker.current)
                mutate(self.docker.current)
                with self.assertRaises(u.Refused):
                    self.up.apply(SHA)
                self.docker.current = old

    def test_invalid_tags_never_pull_or_up(self):
        for tag in ['latest', 'abc123', ';touch /tmp/bad', 'ghcr.io/postmill-ai/postmill-app:latest']:
            with self.assertRaises(u.Refused):
                self.up.apply(tag)
        self.assertFalse(any(c[0] == 'pull' or 'up' in c for c in self.docker.calls))

    def test_stale_rollback_state_is_rejected(self):
        self.up.apply(SHA)
        self.docker.current['Image'] = 'sha256:foreign'
        with self.assertRaisesRegex(u.Refused, 'outside this updater'):
            self.up.apply(None, rollback=True)

    def test_nonpostmill_restart_detected(self):
        self.docker.corrupt_others = True
        with self.assertRaisesRegex(u.Refused, 'Recovery state retained'):
            self.up.apply(SHA)
        self.assertTrue((self.up.state/'pending.json').exists())

    def test_bridge_recreated_after_app_on_update_and_rollback(self):
        self.docker.enable_bridge()
        with patch.object(u.os, 'readlink', return_value='net:[42]'):
            self.up.apply(SHA)
            self.up.apply(None, rollback=True)
        operations = [(('stop' if 'stop' in c else 'up'), c[-1])
                      for c in self.docker.calls if c[0] == 'compose' and ('stop' in c or 'up' in c)]
        self.assertEqual(operations, [('stop', u.BRIDGE_SERVICE), ('up', 'postmill'),
                                      ('up', u.BRIDGE_SERVICE)] * 2)
        for call in self.docker.calls:
            if call[0] == 'compose' and 'up' in call and call[-1] == u.BRIDGE_SERVICE:
                self.assertIn('--force-recreate', call)
                self.assertIn('--no-deps', call)
                self.assertIn('--no-build', call)
                self.assertIn('never', call)
        self.assertEqual(self.docker.bridge['HostConfig']['NetworkMode'],
                         'container:' + self.docker.current['Id'])
        self.assertEqual(self.docker.bridge['Image'], 'sha256:bridge')
        self.assertFalse((self.up.state/'pending.json').exists())

    def test_undeclared_running_bridge_blocks_before_update(self):
        self.docker.enable_bridge()
        self.docker.bridge_declared = False
        with self.assertRaisesRegex(u.Refused, 'not declared'):
            self.up.apply(SHA)
        self.assertFalse(self.up.override.exists())

    def test_bridge_namespace_mismatch_preserves_recovery_state(self):
        self.docker.enable_bridge()
        with patch.object(u.os, 'readlink', side_effect=['net:[1]', 'net:[2]']):
            with self.assertRaisesRegex(u.Refused, 'Recovery state retained'):
                self.up.apply(SHA)
        self.assertTrue((self.up.state/'pending.json').exists())
        with patch.object(u.os, 'readlink', return_value='net:[1]'):
            self.up.apply(None, rollback=True)
        self.assertFalse((self.up.state/'pending.json').exists())

    def test_bridge_start_failure_is_not_success_and_rollback_recovers(self):
        self.docker.enable_bridge()
        self.docker.bridge_fail_up = True
        with self.assertRaisesRegex(u.Refused, 'Recovery state retained'):
            self.up.apply(SHA)
        self.assertTrue((self.up.state/'pending.json').exists())
        self.docker.bridge_fail_up = False
        with patch.object(u.os, 'readlink', return_value='net:[1]'):
            self.up.apply(None, rollback=True)
        self.assertFalse((self.up.state/'pending.json').exists())

    def test_review_hash_is_target_specific(self):
        old = {'schema': 'old'}
        new = {'schema': 'new'}
        with self.assertRaises(u.Refused):
            u.schema_check(old, new, 'anything')
        import hashlib
        reviewed = hashlib.sha256(json.dumps(new, sort_keys=True).encode()).hexdigest()
        u.schema_check(old, new, reviewed)


class ComposeContractTests(unittest.TestCase):
    def test_real_compose_four_file_merge_preserves_giga_env_mounts_networks(self):
        import shutil
        import subprocess
        if not shutil.which('docker'):
            self.skipTest('Docker Compose CLI unavailable')
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root/'cert.pem').write_text('synthetic certificate fixture')
            (root/'compose.yaml').write_text('''services:
  postmill:
    image: old:fixture
    environment:
      JWT_SECRET: synthetic-fixture
    volumes:
      - uploads:/uploads
  postgres:
    image: postgres:17-alpine
  redis:
    image: redis:7-alpine
  inngest:
    image: inngest/inngest:latest
volumes:
  uploads:
''')
            (root/'compose.override.yaml').write_text('''services:
  postmill:
    volumes:
      - ./cert.pem:/cert:ro
    environment:
      NODE_EXTRA_CA_CERTS: /cert
''')
            (root/'compose.giga.yaml').write_text('''services:
  postmill:
    environment:
      OPENAI_BASE: http://gpt2giga:8080
    networks: [default, giga]
  gpt2giga:
    image: giga:fixture
    networks: [giga]
networks:
  giga:
    external: true
    name: giga_external
''')
            (root/'compose.image.yaml').write_text(u.overlay(NEW))
            command = ['docker', '--host=unix:///var/run/docker.sock', 'compose', '-p', 'postmill', '--project-directory', temp]
            for f in u.FILES[:3]:
                command += ['-f', str(root/f)]
            def config(cmd):
                return json.loads(subprocess.run(cmd+['config', '--format', 'json'], check=True, capture_output=True, text=True).stdout)
            base = config(command)
            merged = config(command+['-f', str(root/u.FILES[-1])])
            u.assert_overlay_only(base, merged)
            self.assertEqual(merged['services']['postmill']['image'], NEW)
            self.assertEqual(merged['services']['postmill']['environment']['OPENAI_BASE'], 'http://gpt2giga:8080')
            self.assertEqual(merged['networks']['giga']['name'], 'giga_external')
            cert = next(v for v in merged['services']['postmill']['volumes'] if v['target'] == '/cert')
            self.assertTrue(cert['read_only'])
            self.assertEqual(merged['volumes']['uploads']['name'], 'postmill_uploads')

    def test_local_socket_is_pinned_and_command_errors_do_not_log_secrets(self):
        from types import SimpleNamespace
        with patch.object(u.subprocess, 'run', return_value=SimpleNamespace(returncode=1, stdout='secret', stderr='secret')) as call:
            with patch.dict(u.os.environ, {'DOCKER_HOST': 'tcp://unexpected-vps', 'DOCKER_CONTEXT': 'remote'}):
                with self.assertRaises(u.Refused) as error:
                    u.run('compose', 'config')
            self.assertNotIn('secret', str(error.exception).replace('no secrets logged', ''))
            self.assertEqual(call.call_args.args[0][:2], ['docker', '--host=unix:///var/run/docker.sock'])
            self.assertNotIn('DOCKER_HOST', call.call_args.kwargs['env'])

    def test_concurrent_cli_is_refused_before_docker(self):
        import fcntl
        import sys
        with tempfile.TemporaryDirectory() as temp:
            updater = u.Updater(temp)
            with (updater.state/'lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with patch.dict(u.os.environ, {'POSTMILL_DIR': temp}), patch.object(sys, 'argv', ['postmill-update', SHA]), patch.object(u, 'run') as docker:
                    with self.assertRaisesRegex(u.Refused, 'Another updater'):
                        u.main()
                    docker.assert_not_called()

if __name__ == '__main__':
    unittest.main()
