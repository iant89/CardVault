"""Line reader: a small CNN turns the 32-px line into a sequence of column
features, a few residual 1-D convolutions give each column context from its
neighbours, and CTC aligns the per-column character guesses to the text.
~2M parameters; fast on a CPU.

(A bidirectional LSTM in place of the 1-D convolutions trained far slower on
small datasets. Asked to memorise 64 exported lines, the LSTM version read
none of them after 400 steps; this version read 61.)"""
from __future__ import annotations

import torch
from torch import nn


def block(cin: int, cout: int) -> nn.Sequential:
    return nn.Sequential(nn.Conv2d(cin, cout, 3, padding=1, bias=False), nn.BatchNorm2d(cout), nn.ReLU(inplace=True))


class Context(nn.Module):
    """Residual 1-D convolution over the column sequence."""

    def __init__(self, ch: int, k: int = 5, dilation: int = 1):
        super().__init__()
        self.conv = nn.Conv1d(ch, ch, k, padding=dilation * (k // 2), dilation=dilation, bias=False)
        self.norm = nn.BatchNorm1d(ch)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return x + torch.relu(self.norm(self.conv(x)))


class CRNN(nn.Module):
    def __init__(self, num_classes: int, width: int = 256):
        super().__init__()
        self.cnn = nn.Sequential(
            block(1, 32), nn.MaxPool2d(2, 2),  # 16 × W/2
            block(32, 64), nn.MaxPool2d(2, 2),  # 8 × W/4
            block(64, 128), block(128, 128), nn.MaxPool2d((2, 1), (2, 1)),  # 4 × W/4
            block(128, width), block(width, width), nn.MaxPool2d((2, 1), (2, 1)),  # 2 × W/4
            nn.Conv2d(width, width, (2, 1), bias=False), nn.BatchNorm2d(width), nn.ReLU(inplace=True),  # 1 × W/4
        )
        self.context = nn.Sequential(Context(width, 5, 1), Context(width, 5, 2), Context(width, 5, 4))
        self.head = nn.Sequential(nn.Dropout(0.1), nn.Conv1d(width, num_classes, 1))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """[B, 1, 32, W] → log-probabilities [B, T, C] with T = W // 4."""
        f = self.cnn(x).squeeze(2)  # [B, ch, T]
        f = self.context(f)
        return self.head(f).permute(0, 2, 1).log_softmax(-1)


def greedy_decode(logp: torch.Tensor, charset: str, allowed: set[str] | None = None) -> list[tuple[str, float]]:
    """Same decoding as CardVault's engines.ts: best class per column (disallowed
    characters skipped), collapse repeats, drop blanks; confidence = geometric
    mean of each emitted character's best probability."""
    chars = [""] + list(charset)
    out = []
    lp = logp.detach().cpu()
    if allowed is not None:
        mask = torch.tensor([c == 0 or chars[c] in allowed for c in range(len(chars))])
        lp = lp.masked_fill(~mask, float("-inf"))
    best_v, best = lp.max(-1)
    for b in range(lp.shape[0]):
        text, prev, logs, run = "", 0, [], None
        blank = []
        for t in range(lp.shape[1]):
            c, v = int(best[b, t]), float(best_v[b, t])
            if c == 0:
                blank.append(v)
            if c != 0 and c != prev:
                if run is not None:
                    logs.append(run)
                text += chars[c]
                run = v
            elif c != 0 and c == prev:
                run = max(run, v)
            prev = c
        if run is not None:
            logs.append(run)
        conf = float(torch.tensor(logs).mean().exp()) if logs else float(torch.tensor(blank or [0.0]).mean().exp())
        out.append((text.strip(), conf))
    return out
