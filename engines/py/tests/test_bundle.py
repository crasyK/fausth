"""Bundle v0.1 / v0.2 load, unpack, integrity, and pack tests."""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from fausth.bundle import (
    BUNDLE_FORMAT_V01,
    BUNDLE_FORMAT_V02,
    BundleError,
    is_harness_bundle_v2,
    load_bundle_file,
    resolve_harness_ref,
    unpack_bundle,
    validate_bundle,
)
from fausth.bundle_signature import generate_ed25519_seed_hex
from fausth.connectors import resolve_harness, resolved_harness_hash
from fausth.packaging import pack_harness
from fausth.packaging import test_harness as run_harness_test

ROOT = Path(__file__).resolve().parents[3]
CODING = ROOT / "examples" / "coding-counterbalance"
CONNECTORS = ROOT / "examples" / "primitives" / "inline-file-connectors"


class BundleV01Tests(unittest.TestCase):
    def test_rejects_traversal_and_unknown(self) -> None:
        with self.assertRaises(BundleError):
            validate_bundle(
                {
                    "format": BUNDLE_FORMAT_V01,
                    "name": "evil",
                    "files": {"../etc/passwd": "x", "agent.yml": "name: x\n"},
                }
            )
        with self.assertRaises(BundleError) as ctx:
            validate_bundle(
                {
                    "format": BUNDLE_FORMAT_V01,
                    "name": "evil",
                    "files": {"connectors.yml": "x", "agent.yml": "name: x\n"},
                }
            )
        self.assertEqual(ctx.exception.code, "bundle_unknown_entry")

    def test_pack_validate_unpack_test(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="fausth-py-v01-"))
        try:
            r = pack_harness(str(CODING), str(tmp / "coding.fausth.json"))
            self.assertEqual(r["format"], BUNDLE_FORMAT_V01)
            bundle = load_bundle_file(r["out"])
            self.assertEqual(bundle["format"], BUNDLE_FORMAT_V01)
            unpack = tmp / "out"
            unpack_bundle(r["out"], unpack)
            self.assertTrue((unpack / "agent.yml").is_file())
            ref = resolve_harness_ref(r["out"])
            try:
                self.assertEqual(ref.bundle_format, BUNDLE_FORMAT_V01)
                self.assertIsNone(ref.embedded_resolved)
                result = run_harness_test(str(ref.harness_dir), skip_fixtures=False)
                self.assertTrue(result["ok"])
            finally:
                ref.cleanup()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class BundleV02Tests(unittest.TestCase):
    def test_pack_connector_harness(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="fausth-py-v02-"))
        try:
            r = pack_harness(str(CONNECTORS), str(tmp / "c.fausth.json"))
            self.assertEqual(r["format"], BUNDLE_FORMAT_V02)
            bundle = load_bundle_file(r["out"])
            self.assertTrue(is_harness_bundle_v2(bundle))
            self.assertIn("connectors.yml", bundle["files"])
            self.assertIn("connectors/wait.yml", bundle["files"])
            self.assertEqual(
                bundle["resolved_sha256"],
                resolved_harness_hash(bundle["resolved"]),
            )
            unpack = tmp / "out"
            unpack_bundle(r["out"], unpack)
            self.assertTrue((unpack / "connectors" / "wait.yml").is_file())
            self.assertFalse((unpack / "resolved.json").exists())
            ref = resolve_harness_ref(r["out"])
            try:
                self.assertEqual(ref.bundle_format, BUNDLE_FORMAT_V02)
                self.assertIsNotNone(ref.embedded_resolved)
                result = run_harness_test(
                    str(ref.harness_dir),
                    skip_fixtures=True,
                    embedded_resolved=ref.embedded_resolved,
                    bundle_format=ref.bundle_format,
                )
                self.assertTrue(result["ok"])
                self.assertTrue(
                    any("embedded resolved OK" in d for d in result["details"])
                )
            finally:
                ref.cleanup()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_tampered_resolved_hash_no_write(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="fausth-py-tamper-"))
        try:
            r = pack_harness(str(CONNECTORS), str(tmp / "c.fausth.json"))
            raw = json.loads(Path(r["out"]).read_text(encoding="utf-8"))
            raw["resolved_sha256"] = "0" * 64
            dest = tmp / "out"
            with self.assertRaises(BundleError) as ctx:
                unpack_bundle(raw, dest)
            self.assertEqual(ctx.exception.code, "bundle_resolved_hash_mismatch")
            self.assertFalse(dest.exists())
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_tampered_connector_source_no_write(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="fausth-py-tamper-src-"))
        try:
            r = pack_harness(str(CONNECTORS), str(tmp / "c.fausth.json"))
            raw = json.loads(Path(r["out"]).read_text(encoding="utf-8"))
            raw["files"]["connectors/wait.yml"] += "\n# tampered\n"
            dest = tmp / "out"
            with self.assertRaises(BundleError) as ctx:
                unpack_bundle(raw, dest)
            self.assertEqual(ctx.exception.code, "bundle_lock_hash_mismatch")
            self.assertFalse(dest.exists())
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_rejects_unsafe_nested_paths(self) -> None:
        resolved = resolve_harness(CONNECTORS)
        digest = resolved_harness_hash(resolved)
        agent = (CONNECTORS / "agent.yml").read_text(encoding="utf-8")
        for files in (
            {"agent.yml": agent, "connectors/../secret.yml": "x"},
            {"agent.yml": agent, "connectors\\wait.yml": "x"},
            {"agent.yml": agent, "connectors/.git/config": "x"},
            {"agent.yml": agent, "connectors/wait.bin": "x"},
        ):
            with self.assertRaises(BundleError):
                validate_bundle(
                    {
                        "format": BUNDLE_FORMAT_V02,
                        "name": "evil",
                        "files": files,
                        "resolved": resolved,
                        "resolved_sha256": digest,
                    }
                )

    def test_embedded_authoritative_after_source_mutation(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="fausth-py-auth-"))
        try:
            r = pack_harness(str(CONNECTORS), str(tmp / "c.fausth.json"))
            ref = resolve_harness_ref(r["out"])
            try:
                embedded_hash = resolved_harness_hash(ref.embedded_resolved)
                wait = Path(ref.harness_dir) / "connectors" / "wait.yml"
                wait.write_text(
                    wait.read_text(encoding="utf-8").replace(
                        "deterministic wait", "MUTATED wait"
                    ),
                    encoding="utf-8",
                )
                self.assertEqual(resolved_harness_hash(ref.embedded_resolved), embedded_hash)
                reresolved = resolve_harness(ref.harness_dir)
                self.assertNotEqual(resolved_harness_hash(reresolved), embedded_hash)
            finally:
                ref.cleanup()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class BundleSignatureTests(unittest.TestCase):
    def test_unsigned_coding_pack_size(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="fausth-py-unsigned-"))
        try:
            r = pack_harness(str(CODING), str(tmp / "coding.fausth.json"))
            self.assertFalse(r["signed"])
            data = Path(r["out"]).read_bytes()
            self.assertEqual(len(data), 15650)
            self.assertNotIn("signature", json.loads(data.decode("utf-8")))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_sign_verify_and_tamper(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="fausth-py-sig-"))
        try:
            seed = tmp / "seed.hex"
            seed.write_text(generate_ed25519_seed_hex()["seed_hex"] + "\n", encoding="utf-8")
            r = pack_harness(str(CONNECTORS), str(tmp / "signed.fausth.json"), sign_key=str(seed))
            self.assertTrue(r["signed"])
            bundle = load_bundle_file(r["out"])
            self.assertIn("signature", bundle)
            self.assertEqual(bundle["signature"]["alg"], "ed25519")
            unpack_bundle(r["out"], tmp / "ok")

            raw = json.loads(Path(r["out"]).read_text(encoding="utf-8"))
            raw["files"]["agent.yml"] += "\n# tampered\n"
            dest = tmp / "tamper-files"
            with self.assertRaises(BundleError) as ctx:
                unpack_bundle(raw, dest)
            self.assertEqual(ctx.exception.code, "bundle_signature_invalid")
            self.assertFalse(dest.exists())

            raw2 = json.loads(Path(r["out"]).read_text(encoding="utf-8"))
            raw2["signature"]["sig"] = "ab" * 64
            dest2 = tmp / "tamper-sig"
            with self.assertRaises(BundleError) as ctx2:
                unpack_bundle(raw2, dest2)
            self.assertEqual(ctx2.exception.code, "bundle_signature_invalid")
            self.assertFalse(dest2.exists())

            raw3 = json.loads(Path(r["out"]).read_text(encoding="utf-8"))
            raw3["signature"]["alg"] = "rsa-pss"
            dest3 = tmp / "tamper-alg"
            with self.assertRaises(BundleError) as ctx3:
                unpack_bundle(raw3, dest3)
            self.assertEqual(ctx3.exception.code, "bundle_signature_unsupported")
            self.assertFalse(dest3.exists())
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
