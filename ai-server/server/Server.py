r"""Local AI detection server for the Origin client.

This module is the missing piece referenced by ``AI Server/server/pipe_server.py``.
It loads the two ONNX models and exposes a small synchronous API:

    detector.detect_all(image, armor_conf, car_conf, iou, max_size)
    detector.detect_armor(image, conf)
    detector.detect_car(image, conf)

Models are YOLOv5-style exports:
    armor: [1, 25200, 17] = 4 bbox + 1 objectness + 12 classes (B1..R7)
    car:   [1, 25200, 10] = 4 bbox + 1 objectness + 5 classes
Boxes are xywh in 640x640 letterbox coordinates.
"""

from __future__ import annotations

import ast
import os
import time
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

try:
    import onnxruntime as ort
except ImportError as exc:  # pragma: no cover - clear runtime error
    raise RuntimeError(
        "onnxruntime is required. Install it into AI Server/.venv: "
        "python -m pip install onnxruntime"
    ) from exc


def _read_names(session: "ort.InferenceSession", fallback: dict[int, str]) -> dict[int, str]:
    try:
        raw = session.get_modelmeta().custom_metadata_map.get("names")
        if raw:
            parsed = ast.literal_eval(raw)
            if isinstance(parsed, dict):
                return {int(k): str(v) for k, v in parsed.items()}
    except Exception:
        pass
    return fallback


def _letterbox(image: Image.Image, size: int = 640, max_size: int = 1280) -> tuple[np.ndarray, float, float, float]:
    image = image.convert("RGB")
    width, height = image.size
    if max(width, height) > max_size:
        ratio = max_size / max(width, height)
        image = image.resize((max(1, int(width * ratio)), max(1, int(height * ratio))), Image.BILINEAR)
        width, height = image.size

    scale = min(size / width, size / height)
    new_w, new_h = max(1, int(round(width * scale))), max(1, int(round(height * scale)))
    resized = image.resize((new_w, new_h), Image.BILINEAR)
    canvas = Image.new("RGB", (size, size), (114, 114, 114))
    pad_x = (size - new_w) // 2
    pad_y = (size - new_h) // 2
    canvas.paste(resized, (pad_x, pad_y))
    array = np.asarray(canvas, dtype=np.float32) / 255.0
    array = np.transpose(array, (2, 0, 1))[None, ...]
    return array.astype(np.float16), scale, float(pad_x), float(pad_y)


def _nms(boxes: np.ndarray, scores: np.ndarray, iou_threshold: float) -> list[int]:
    if len(boxes) == 0:
        return []
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = np.maximum(0.0, x2 - x1) * np.maximum(0.0, y2 - y1)
    order = scores.argsort()[::-1]
    keep: list[int] = []
    while order.size:
        i = int(order[0])
        keep.append(i)
        if order.size == 1:
            break
        rest = order[1:]
        xx1 = np.maximum(x1[i], x1[rest])
        yy1 = np.maximum(y1[i], y1[rest])
        xx2 = np.minimum(x2[i], x2[rest])
        yy2 = np.minimum(y2[i], y2[rest])
        inter = np.maximum(0.0, xx2 - xx1) * np.maximum(0.0, yy2 - yy1)
        union = areas[i] + areas[rest] - inter
        iou = np.divide(inter, union, out=np.zeros_like(inter), where=union > 0)
        order = rest[iou <= iou_threshold]
    return keep


class DetectionServer:
    def __init__(
        self,
        armor_model: str,
        car_model: str,
        force_provider: str | None = None,
        logger: Any = None,
    ) -> None:
        self.logger = logger
        self.armor_path = str(Path(armor_model))
        self.car_path = str(Path(car_model))
        if not Path(self.armor_path).is_file():
            raise FileNotFoundError(self.armor_path)
        if not Path(self.car_path).is_file():
            raise FileNotFoundError(self.car_path)

        available = ort.get_available_providers()
        if force_provider and force_provider in available:
            providers = [force_provider, "CPUExecutionProvider"]
        elif "CUDAExecutionProvider" in available:
            providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        else:
            providers = ["CPUExecutionProvider"]
        providers = list(dict.fromkeys(providers))

        self.armor_session = ort.InferenceSession(self.armor_path, providers=providers)
        self.car_session = ort.InferenceSession(self.car_path, providers=providers)
        self.active_provider = self.armor_session.get_providers()[0]
        self.armor_names = _read_names(
            self.armor_session,
            {i: name for i, name in enumerate(["B1", "B2", "B3", "B4", "B5", "B7", "R1", "R2", "R3", "R4", "R5", "R7"])},
        )
        self.car_names = _read_names(
            self.car_session, {i: name for i, name in enumerate(["car", "armor", "ignore", "watcher", "base"])}
        )
        if self.logger:
            self.logger.info("DetectionServer ready provider=%s armor=%s car=%s", self.active_provider, self.armor_names, self.car_names)

    @staticmethod
    def _class_name(names: dict[int, str], class_id: int) -> str:
        return names.get(int(class_id), str(class_id))

    def _infer(
        self,
        session: "ort.InferenceSession",
        names: dict[int, str],
        image: Image.Image,
        conf_threshold: float,
        iou_threshold: float,
        max_size: int,
        model_kind: str,
    ) -> tuple[list[dict[str, Any]], dict[str, float]]:
        t0 = time.perf_counter()
        tensor, scale, pad_x, pad_y = _letterbox(image, 640, max_size)
        t1 = time.perf_counter()
        output = session.run(None, {session.get_inputs()[0].name: tensor})[0]
        t2 = time.perf_counter()
        predictions = np.asarray(output, dtype=np.float32)[0]
        class_count = len(names)
        class_scores = predictions[:, 5 : 5 + class_count]
        objectness = predictions[:, 4]
        class_ids = class_scores.argmax(axis=1)
        scores = objectness * class_scores[np.arange(class_scores.shape[0]), class_ids]
        candidates = np.where(scores >= conf_threshold)[0]
        detections: list[dict[str, Any]] = []
        boxes: list[list[float]] = []
        keep_scores: list[float] = []
        keep_classes: list[int] = []
        orig_w, orig_h = image.size
        for index in candidates:
            cx, cy, bw, bh = predictions[index, :4]
            x1 = (cx - bw / 2.0 - pad_x) / scale
            y1 = (cy - bh / 2.0 - pad_y) / scale
            x2 = (cx + bw / 2.0 - pad_x) / scale
            y2 = (cy + bh / 2.0 - pad_y) / scale
            x1 = max(0.0, min(float(orig_w - 1), float(x1)))
            y1 = max(0.0, min(float(orig_h - 1), float(y1)))
            x2 = max(0.0, min(float(orig_w - 1), float(x2)))
            y2 = max(0.0, min(float(orig_h - 1), float(y2)))
            if x2 <= x1 or y2 <= y1:
                continue
            boxes.append([x1, y1, x2, y2])
            keep_scores.append(float(scores[index]))
            keep_classes.append(int(class_ids[index]))

        # class-aware NMS
        final: list[int] = []
        for class_id in sorted(set(keep_classes)):
            indices = [i for i, value in enumerate(keep_classes) if value == class_id]
            local_boxes = np.asarray([boxes[i] for i in indices], dtype=np.float32)
            local_scores = np.asarray([keep_scores[i] for i in indices], dtype=np.float32)
            for local_index in _nms(local_boxes, local_scores, iou_threshold):
                final.append(indices[local_index])
        final.sort(key=lambda idx: keep_scores[idx], reverse=True)

        # 2026 地面阵容只保留 1/3/4/7；模型里的 2/5 类不参与 HUD。
        allowed_armor = {"R1", "R3", "R4", "R7", "B1", "B3", "B4", "B7"}
        for index in final:
            class_id = keep_classes[index]
            class_name = self._class_name(names, class_id)
            if model_kind == "armor" and class_name not in allowed_armor:
                continue
            team = "red" if class_name.startswith("R") else "blue" if class_name.startswith("B") else "neutral"
            detections.append(
                {
                    "bbox": [round(float(v), 2) for v in boxes[index]],
                    "class_id": class_id,
                    "class_name": class_name,
                    "confidence": round(float(keep_scores[index]), 4),
                    "team": team,
                    "model": model_kind,
                }
            )
        t3 = time.perf_counter()
        timing = {
            "preprocess_ms": (t1 - t0) * 1000.0,
            "infer_ms": (t2 - t1) * 1000.0,
            "post_ms": (t3 - t2) * 1000.0,
            "inference_time": t3 - t1,
            "inference_time_ms": (t3 - t1) * 1000.0,
        }
        return detections, timing

    def detect_armor(self, image: Image.Image, conf: float = 0.25, iou: float = 0.45, max_size: int = 1280) -> list[dict[str, Any]]:
        detections, _ = self._infer(self.armor_session, self.armor_names, image, conf, iou, max_size, "armor")
        return detections

    def detect_car(self, image: Image.Image, conf: float = 0.25, iou: float = 0.45, max_size: int = 1280) -> list[dict[str, Any]]:
        detections, _ = self._infer(self.car_session, self.car_names, image, conf, iou, max_size, "car")
        return detections

    def detect_all(
        self,
        image: Image.Image,
        armor_conf: float = 0.25,
        car_conf: float = 0.25,
        iou_threshold: float = 0.45,
        max_size: int = 1280,
    ) -> dict[str, Any]:
        armor, armor_timing = self._infer(
            self.armor_session, self.armor_names, image, armor_conf, iou_threshold, max_size, "armor"
        )
        car, car_timing = self._infer(
            self.car_session, self.car_names, image, car_conf, iou_threshold, max_size, "car"
        )
        detections = armor + car
        return {
            "success": True,
            "detections": detections,
            "count": len(detections),
            "image_size": {"width": image.width, "height": image.height},
            "active_provider": self.active_provider,
            "inference_time": armor_timing["inference_time"] + car_timing["inference_time"],
            "inference_time_ms": armor_timing["inference_time_ms"] + car_timing["inference_time_ms"],
            "preprocess_ms": armor_timing["preprocess_ms"] + car_timing["preprocess_ms"],
            "infer_ms": armor_timing["infer_ms"] + car_timing["infer_ms"],
            "post_ms": armor_timing["post_ms"] + car_timing["post_ms"],
            "timestamp": time.time(),
        }
