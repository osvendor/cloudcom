import copy
import tempfile
import unittest
from pathlib import Path

from feature_compose import prepare, TARGETS, WORKER_TARGETS


class FeatureComposeTest(unittest.TestCase):
    def test_schema_mounts_and_preserves_previous_migrations(self):
        with tempfile.TemporaryDirectory() as temporary:
            allowed = Path(temporary).resolve()
            release = allowed / "release-schema"
            for member in TARGETS.values():
                (release / member).mkdir(parents=True)
            migration = "2026-09-25-microsoft-directory-layouts.sql"
            for member in ("packages/ext-cloud-command/manifest.json",
                           f"packages/ext-cloud-command/migrations/{migration}"):
                path = release / member
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(member)
            image = "cloudcom-candidate/api@sha256:" + "a" * 64
            old_migration = f"/app/packages/ext-cloud-command/migrations/{migration}"
            baseline = {"services": {"api": {"image": image}}}
            result = prepare(copy.deepcopy(baseline), release, image, allowed_root=allowed,
                             migration_files=(migration,))
            targets = {mount["target"] for mount in result["services"]["api"]["volumes"]}
            self.assertIn(old_migration, targets)
            self.assertIn("/app/packages/ext-cloud-command/manifest.json", targets)
            self.assertTrue(all(mount["read_only"] for mount in result["services"]["api"]["volumes"]))
            with self.assertRaisesRegex(ValueError, "remove a previously mounted"):
                prepare(copy.deepcopy(result), release, image, allowed_root=allowed)
            with self.assertRaisesRegex(ValueError, "invalid migration name"):
                prepare(copy.deepcopy(baseline), release, image, allowed_root=allowed,
                        migration_files=("../escape.sql",))
            self.assertEqual(prepare(copy.deepcopy(result), release, image, allowed_root=allowed,
                                     migration_files=(migration,))["services"]["api"]["image"], image)

    def test_worker_script_mounts_keep_the_exact_worker_image(self):
        with tempfile.TemporaryDirectory() as temporary:
            allowed = Path(temporary).resolve()
            release = allowed / "release-b"
            for member in TARGETS.values():
                (release / member).mkdir(parents=True)
            for member in WORKER_TARGETS.values():
                path = release / member
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("test")
            image = "cloudcom-candidate/api@sha256:" + "a" * 64
            worker_image = "cloudcom-candidate/exchange-worker@sha256:" + "b" * 64
            baseline = {"services": {"api": {"image": image}, "cloudcom-exchange-worker": {
                "image": worker_image, "volumes": [{"type": "bind", "source": "/private", "target": "/run/private"}]}}}
            result = prepare(copy.deepcopy(baseline), release, image, worker_image, allowed)
            mounts = result["services"]["cloudcom-exchange-worker"]["volumes"]
            self.assertEqual(mounts[0], baseline["services"]["cloudcom-exchange-worker"]["volumes"][0])
            self.assertEqual({mount["target"] for mount in mounts[1:]}, set(WORKER_TARGETS))
            self.assertTrue(all(mount["read_only"] for mount in mounts[1:]))
            with self.assertRaisesRegex(ValueError, "worker image differs"):
                prepare(copy.deepcopy(baseline), release, image, worker_image[:-1] + "c", allowed)
    def test_exact_image_and_read_only_mounts_with_other_volumes_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            allowed = Path(temporary).resolve()
            release = allowed / "release-a"
            for member in TARGETS.values():
                (release / member).mkdir(parents=True)
            image = "cloudcom-candidate/api@sha256:" + "a" * 64
            baseline = {"services": {"api": {"image": image, "volumes": [
                {"type": "volume", "source": "api_data", "target": "/data"}]}}}
            result = prepare(copy.deepcopy(baseline), release, image, allowed_root=allowed)
            mounts = result["services"]["api"]["volumes"]
            self.assertEqual(mounts[0], baseline["services"]["api"]["volumes"][0])
            self.assertEqual({mount["target"] for mount in mounts[1:]}, set(TARGETS))
            self.assertTrue(all(mount["read_only"] for mount in mounts[1:]))
            with self.assertRaisesRegex(ValueError, "image differs"):
                prepare(copy.deepcopy(baseline), release, image[:-1] + "b", allowed_root=allowed)
            with self.assertRaisesRegex(ValueError, "unexpected existing mount"):
                changed = copy.deepcopy(baseline)
                changed["services"]["api"]["volumes"].append(
                    {"type": "bind", "source": "/untrusted", "target": "/app/apps/api/dist"})
                prepare(changed, release, image, allowed_root=allowed)
            with self.assertRaisesRegex(ValueError, "outside"):
                prepare(copy.deepcopy(baseline), Path(temporary).parent, image, allowed_root=allowed)


if __name__ == "__main__":
    unittest.main()
