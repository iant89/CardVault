# vendored checkouts

Optional source code that CardVault can use when it is present here. Nothing in
this folder is required for CardVault to run, and nothing here is committed to
Git beyond this README.

## CardVault-Vision

[`CardVault-Vision`](https://github.com/iant89/CardVault-Vision) is the model
factory that trains CardVault's OCR heads and the whole-card game classifier and
exports them as versioned ONNX bundles.

CardVault **runs** those bundles with `onnxruntime-node` and never needs Python
to do it — an export dropped into `storage/ocr/vision/exports/<task>/<version>/`
(or a folder named in `VISION_MODELS_DIR`) is picked up by OCR Lab's *Look for
new models*, verified (checksum, contract, labels) and scored on the frozen exam
like any other model.

Python is only needed to **train** with it from OCR Lab:

```bash
git clone https://github.com/iant89/CardVault-Vision vendor/CardVault-Vision
bash scripts/ocr-python.sh          # installs it (editable) into the trainer venv
```

`scripts/ocr-python.sh` installs this checkout when it finds one, and the
worker's Vision training bridge looks for it here (`vendor/CardVault-Vision`)
or beside the repository (`../CardVault-Vision`). Set `CARDVAULT_VISION_DIR` to
point somewhere else. If it is absent, OCR Lab still trains with CardVault's own
`tools/ocr-trainer` — that path is unchanged.
