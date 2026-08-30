"""Where frames come from: a webcam, a video file, a still image, or the demo."""

from __future__ import annotations

import time
from pathlib import Path

import cv2

from .synthetic import demo_frames


class FrameSource:
    """Iterate frames from `spec`.

    * ``"0"``, ``"1"`` ... - camera index (``0`` is the default webcam)
    * ``"demo"``          - the drawn table from `synthetic.py`, no hardware
    * a path              - a video file, or a still image repeated forever
    """

    def __init__(self, spec: str = "0", width: int | None = None, height: int | None = None, fps: float = 0.0):
        self.spec = str(spec)
        self.width = width
        self.height = height
        self.fps = fps
        self.capture = None
        self.still = None
        self.kind = "demo"

        if self.spec == "demo":
            return
        if self.spec.isdigit():
            self.kind = "camera"
            self.capture = cv2.VideoCapture(int(self.spec))
            if width:
                self.capture.set(cv2.CAP_PROP_FRAME_WIDTH, width)
            if height:
                self.capture.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
            if not self.capture.isOpened():
                raise RuntimeError(
                    f"לא הצלחתי לפתוח מצלמה {self.spec}. "
                    "בדוק שהמצלמה מחוברת ושהרשאת המצלמה ניתנה, או נסה --source demo."
                )
            return

        path = Path(self.spec)
        if not path.exists():
            raise RuntimeError(f"לא נמצא קובץ: {path}")
        image = cv2.imread(str(path))
        if image is not None:
            self.kind = "image"
            self.still = image
            return
        self.kind = "video"
        self.capture = cv2.VideoCapture(str(path))
        if not self.capture.isOpened():
            raise RuntimeError(f"לא הצלחתי לקרוא את {path} לא כתמונה ולא כווידאו")

    def frames(self, limit: int | None = None):
        interval = 1.0 / self.fps if self.fps else 0.0
        count = 0
        for frame in self._raw_frames():
            if frame is None:
                break
            if self.width and self.kind in ("image", "video", "demo"):
                scale = self.width / frame.shape[1]
                frame = cv2.resize(frame, (self.width, int(frame.shape[0] * scale)))
            yield frame
            count += 1
            if limit and count >= limit:
                break
            if interval:
                time.sleep(interval)

    def _raw_frames(self):
        if self.kind == "demo":
            while True:
                yield from demo_frames()
        if self.kind == "image":
            while True:
                yield self.still.copy()
        while True:
            ok, frame = self.capture.read()
            if not ok:
                if self.kind == "video":  # loop the clip
                    self.capture.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    ok, frame = self.capture.read()
                if not ok:
                    return
            yield frame

    def release(self) -> None:
        if self.capture is not None:
            self.capture.release()

    def __enter__(self) -> "FrameSource":
        return self

    def __exit__(self, *exc) -> None:
        self.release()


def has_display() -> bool:
    """True when OpenCV can actually open a window on this machine."""
    try:
        cv2.namedWindow("__probe__", cv2.WINDOW_AUTOSIZE)
        cv2.destroyWindow("__probe__")
        return True
    except cv2.error:
        return False
