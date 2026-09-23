import importlib.util
import io
import json
import hashlib
import pathlib
import tarfile
import tempfile
import unittest


script = pathlib.Path(__file__).with_name('verify-exchange-worker-oci.py')
spec = importlib.util.spec_from_file_location('exchange_worker_oci', script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
COMMIT = 'a' * 40


def blob(value):
    data = json.dumps(value, separators=(',', ':')).encode() if isinstance(value, dict) else value
    return data, 'sha256:' + hashlib.sha256(data).hexdigest()


def archive(path, *, revision=COMMIT, platform='amd64', extra_name=None, nested=False):
    layer, layer_digest = blob(b'layer')
    config, config_digest = blob({
        'os': 'linux', 'architecture': platform,
        'config': {'Labels': {'org.opencontainers.image.revision': revision}},
        'rootfs': {'diff_ids': [layer_digest]},
    })
    manifest, manifest_digest = blob({
        'schemaVersion': 2,
        'config': {'mediaType': 'application/vnd.oci.image.config.v1+json', 'digest': config_digest, 'size': len(config)},
        'layers': [{'mediaType': 'application/vnd.oci.image.layer.v1.tar', 'digest': layer_digest, 'size': len(layer)}],
    })
    selected = {
        'mediaType': 'application/vnd.oci.image.manifest.v1+json', 'digest': manifest_digest,
        'size': len(manifest), 'platform': {'os': 'linux', 'architecture': platform},
    }
    entries = {}
    if nested:
        attestation, attestation_digest = blob({'schemaVersion': 2, 'config': {}, 'layers': []})
        nested_bytes, nested_digest = blob({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.index.v1+json', 'manifests': [
            selected,
            {'mediaType': 'application/vnd.oci.image.manifest.v1+json', 'digest': attestation_digest,
             'size': len(attestation), 'platform': {'os': 'unknown', 'architecture': 'unknown'},
             'annotations': {'vnd.docker.reference.type': 'attestation-manifest',
                             'vnd.docker.reference.digest': manifest_digest}},
        ]})
        entries['blobs/sha256/' + nested_digest[7:]] = nested_bytes
        entries['blobs/sha256/' + attestation_digest[7:]] = attestation
        selected = {'mediaType': 'application/vnd.oci.image.index.v1+json', 'digest': nested_digest,
                    'size': len(nested_bytes)}
    index = json.dumps({'schemaVersion': 2, 'manifests': [selected]}).encode()
    entries.update({
        'oci-layout': b'{"imageLayoutVersion":"1.0.0"}',
        'index.json': index,
        'blobs/sha256/' + manifest_digest[7:]: manifest,
        'blobs/sha256/' + config_digest[7:]: config,
        'blobs/sha256/' + layer_digest[7:]: layer,
    })
    if extra_name:
        entries[extra_name] = b'bad'
    with tarfile.open(path, 'w:gz') as stream:
        for name, data in entries.items():
            item = tarfile.TarInfo(name)
            item.size = len(data)
            stream.addfile(item, io.BytesIO(data))
    return (nested_digest if nested else manifest_digest), manifest_digest


class VerifyExchangeWorkerOciTests(unittest.TestCase):
    def test_exact_revision_platform_and_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'worker.tar.gz'
            expected, image_manifest = archive(path)
            result = module.verify(path, COMMIT, 'exchange-worker')
            self.assertEqual(result['manifestDigest'], expected)
            self.assertEqual(result['imageManifestDigest'], image_manifest)
            self.assertEqual(result['platform'], 'linux/amd64')
            self.assertEqual(result['component'], 'exchange-worker')
            with self.assertRaisesRegex(ValueError, 'Invalid candidate identity'):
                module.verify(path, COMMIT, 'api')

    def test_rejects_wrong_revision_platform_and_unsafe_member(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'worker.tar.gz'
            archive(path, revision='b' * 40)
            with self.assertRaisesRegex(ValueError, 'Wrong source revision'):
                module.verify(path, COMMIT, 'exchange-worker')
            archive(path, platform='arm64')
            with self.assertRaisesRegex(ValueError, 'Wrong manifest platform'):
                module.verify(path, COMMIT, 'exchange-worker')
            archive(path, extra_name='../escape')
            with self.assertRaisesRegex(ValueError, 'Unsafe or duplicate archive member'):
                module.verify(path, COMMIT, 'exchange-worker')

    def test_nested_index_with_attestation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'worker.tar.gz'
            expected, image_manifest = archive(path, nested=True)
            result = module.verify(path, COMMIT, 'exchange-worker')
            self.assertEqual(result['manifestDigest'], expected)
            self.assertEqual(result['imageManifestDigest'], image_manifest)


if __name__ == '__main__':
    unittest.main()
