#!/usr/bin/env python3
"""Offline learned palette refiner for Asset Studio PNG output.

The model is a deterministic competitive-learning vector quantizer. It learns a
compact RGB codebook from the pixels in each image, snaps colors to that learned
palette, hardens alpha, and removes isolated one-pixel color noise. No network,
downloaded weights, or GPU runtime is required.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image


def learn_palette(colors: np.ndarray, counts: np.ndarray, size: int) -> np.ndarray:
    size = max(2, min(size, len(colors)))
    samples = colors.astype(np.float32)
    weights = counts.astype(np.float64)
    centers = [samples[int(np.argmax(weights))]]
    nearest = np.sum((samples - centers[0]) ** 2, axis=1)

    for _ in range(1, size):
        index = int(np.argmax(nearest * np.sqrt(weights)))
        centers.append(samples[index])
        distance = np.sum((samples - samples[index]) ** 2, axis=1)
        nearest = np.minimum(nearest, distance)

    palette = np.stack(centers)
    for _ in range(14):
        distances = np.sum((samples[:, None, :] - palette[None, :, :]) ** 2, axis=2)
        labels = np.argmin(distances, axis=1)
        updated = palette.copy()
        for index in range(size):
            members = labels == index
            if np.any(members):
                updated[index] = np.average(samples[members], axis=0, weights=weights[members])
        if np.max(np.abs(updated - palette)) < 0.35:
            palette = updated
            break
        palette = updated
    return np.clip(np.rint(palette), 0, 255).astype(np.uint8)


def nearest_palette_labels(rgb: np.ndarray, palette: np.ndarray) -> np.ndarray:
    flat = rgb.reshape(-1, 3).astype(np.int32)
    labels = np.empty(len(flat), dtype=np.int32)
    for start in range(0, len(flat), 32_768):
        chunk = flat[start : start + 32_768]
        distances = np.sum((chunk[:, None, :] - palette[None, :, :].astype(np.int32)) ** 2, axis=2)
        labels[start : start + len(chunk)] = np.argmin(distances, axis=1)
    return labels.reshape(rgb.shape[:2])


def remove_isolated_pixels(labels: np.ndarray, opaque: np.ndarray) -> np.ndarray:
    if labels.shape[0] < 3 or labels.shape[1] < 3:
        return labels
    result = labels.copy()
    for _ in range(2):
        center = result[1:-1, 1:-1]
        up, down = result[:-2, 1:-1], result[2:, 1:-1]
        left, right = result[1:-1, :-2], result[1:-1, 2:]
        vertical_vote = (up == down) & ((up == left) | (up == right))
        horizontal_vote = (left == right) & ((left == up) | (left == down))
        replacement = np.where(vertical_vote, up, left)
        replace = (vertical_vote | horizontal_vote) & (center != replacement) & opaque[1:-1, 1:-1]
        center[replace] = replacement[replace]
    return result


def refine(source: Path, target: Path, palette_size: int) -> None:
    rgba = np.asarray(Image.open(source).convert("RGBA"), dtype=np.uint8).copy()
    opaque = rgba[..., 3] >= 128
    rgba[..., 3] = np.where(opaque, 255, 0).astype(np.uint8)
    rgba[~opaque, :3] = 0
    if not np.any(opaque):
        Image.fromarray(rgba, "RGBA").save(target, format="PNG")
        return

    visible = rgba[opaque, :3]
    colors, counts = np.unique(visible, axis=0, return_counts=True)
    palette = learn_palette(colors, counts, palette_size)
    labels = nearest_palette_labels(rgba[..., :3], palette)
    labels = remove_isolated_pixels(labels, opaque)
    rgba[..., :3] = palette[labels]
    rgba[~opaque, :3] = 0
    Image.fromarray(rgba, "RGBA").save(target, format="PNG", optimize=False)


def main() -> None:
    parser = argparse.ArgumentParser(description="Apply Asset Studio's offline learned pixel filter.")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--palette", type=int, default=16, choices=range(2, 65), metavar="2..64")
    args = parser.parse_args()
    refine(args.input, args.output, args.palette)


if __name__ == "__main__":
    main()
