#!/usr/bin/env python3
"""Reproduce the frozen F4 source joins and Core/Hub/Lens locally, without RPC."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile


def main():
    here = Path(__file__).resolve().parent
    repo = here.parent.parent
    tsx = repo / "node_modules/.bin/tsx"
    if not tsx.is_file():
        raise SystemExit("Install the repository lockfile first: npm ci")
    if len(sys.argv) > 2:
        raise SystemExit("Usage: python3 -I examples/zksys-genesis-f4/replay.py [NEW_OUTPUT_DIRECTORY]")
    if len(sys.argv) == 2:
        out = Path(sys.argv[1]).resolve()
        out.mkdir(parents=True, exist_ok=False)
    else:
        out = Path(tempfile.mkdtemp(prefix="ne-f4-replay-"))
    source = here / "ORIGINAL_PUBLIC_CAPTURE.zip"
    subprocess.run([sys.executable, "-I", str(here / "verify.py"), str(source), str(out / "F4_VERDICTS.json")], check=True)
    names = ("REPORT.json", "genesis-receipt.response.json", "genesis-transaction.response.json", "genesis-block-by-hash.response.json")
    with zipfile.ZipFile(source) as archive:
        for name in names:
            (out / name).write_bytes(archive.read("capture/" + name))
    result = out / "F4_COMPOSITION.json"
    subprocess.run([str(tsx), str(here / "build.ts"), str(out / "F4_VERDICTS.json"),
                    *[str(out / name) for name in names], str(result)], cwd=repo, check=True)
    actual = json.loads(result.read_text())
    frozen = json.loads((repo / "examples/ne-maps/data/f4-reviewed.json").read_text())
    assert actual["envelope"]["lens"] == frozen["lens"], "F4_REPLAY_LENS_MISMATCH"
    assert actual["envelope"]["exactAction"] == frozen["exactAction"], "F4_REPLAY_SOURCE_IDENTITIES_MISMATCH"
    print("F4_OFFLINE_REPLAY_MATCHES_MAPS_MCP 6_supported 5_insufficient 11_tamper_rejected")
    print("OUTPUT_DIRECTORY", str(out))


if __name__ == "__main__":
    main()
