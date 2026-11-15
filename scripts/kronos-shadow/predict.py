"""Run pinned inference on a single completed-hour input snapshot."""
import argparse
from contextlib import redirect_stdout
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile

PINS = json.loads(Path(__file__).with_name("pins.json").read_text(encoding="utf-8"))


def check_weights(path, role):
    pinned = PINS[role]
    for name, expected in pinned["sha256"].items():
        with (path / name).open("rb") as file:
            if hashlib.file_digest(file, "sha256").hexdigest() != expected:
                raise ValueError(f"{role} weight or configuration hash mismatch")


def deny_network(*_args, **_kwargs):
    raise RuntimeError("Kronos inference uses local files only")


def predict(args, inputs, slot):
    source = args.source.resolve()
    revision = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    changes = subprocess.check_output(
        ["git", "-C", str(source), "status", "--porcelain", "--untracked-files=all"], text=True)
    if revision != PINS["revision"] or changes.strip():
        raise ValueError("Kronos source must be clean and match the pinned revision")
    check_weights(args.model, "model")
    check_weights(args.tokenizer, "tokenizer")
    sys.path.insert(0, str(source))
    socket.socket.connect = socket.socket.connect_ex = deny_network
    socket.create_connection = socket.getaddrinfo = deny_network

    import numpy as np
    import pandas as pd
    import torch
    from model import Kronos, KronosPredictor, KronosTokenizer

    torch.set_num_threads(2)
    torch.manual_seed(42)
    np.random.seed(42)
    frame = pd.DataFrame(inputs)
    frame["amount"] = (frame["vwap"].fillna(frame["close"]) * frame["volume"])
    timestamps = pd.to_datetime(frame["timestamp"], utc=True).dt.tz_localize(None)
    target = pd.Series([pd.Timestamp(slot, unit="ms", tz="UTC").tz_localize(None)])
    model = Kronos.from_pretrained(str(args.model.resolve()), local_files_only=True).eval()
    tokenizer = KronosTokenizer.from_pretrained(str(args.tokenizer.resolve()), local_files_only=True).eval()
    predictor = KronosPredictor(model, tokenizer, device="cpu", max_context=64)
    with torch.inference_mode():
        result = predictor.predict(
            df=frame[["open", "high", "low", "close", "volume", "amount"]],
            x_timestamp=timestamps, y_timestamp=target, pred_len=1,
            T=1.0, top_p=0.9, sample_count=1, verbose=False)
    close = float(result["close"].iloc[0])
    return {"predictedClose": close}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--tokenizer", required=True, type=Path)
    args = parser.parse_args()
    request = json.load(sys.stdin)
    with tempfile.TemporaryDirectory(prefix="kronos-shadow-") as isolated:
        os.environ.update(HF_HOME=isolated, HF_HUB_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1",
                          TOKENIZERS_PARALLELISM="false", PYTHON_DOTENV_DISABLED="1")
        with redirect_stdout(sys.stderr):
            result = predict(args, request["inputs"], request["slot"])
    print(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    main()
