"""Zip helpers shared by the pipeline."""
from __future__ import annotations

import zipfile
from pathlib import Path


def rezip(spreadsheet_path: Path, out_zip: Path) -> Path:
    """Bundle the (edited) spreadsheet back into a zip for upload.

    Shopee expects a specific internal structure. Confirm the original zip's
    layout before finalising — for now we store the file at the archive root
    with its own name, which matches the common export shape.
    """
    out_zip.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(spreadsheet_path, arcname=spreadsheet_path.name)
    return out_zip
