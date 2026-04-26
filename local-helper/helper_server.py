from __future__ import annotations

import json
import os
import re
import threading
import uuid
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request
from flask_cors import CORS
from yt_dlp import YoutubeDL


APP_NAME = "Whisper 字幕助手"
HOST = "127.0.0.1"
PORT = 8765
ROOT_DIR = Path(__file__).resolve().parent
DOWNLOAD_DIR = ROOT_DIR / "downloads"
ALLOWED_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "youtu.be",
    "music.youtube.com",
}

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

jobs: dict[str, dict[str, Any]] = {}
jobs_lock = threading.Lock()


def is_youtube_url(url: str) -> bool:
    return bool(
        re.match(
            r"^https?://(www\.|m\.|music\.)?youtube\.com/|^https?://youtu\.be/",
            url.strip(),
            flags=re.IGNORECASE,
        )
    )


def update_job(job_id: str, **values: Any) -> None:
    with jobs_lock:
        jobs[job_id].update(values)


class ProgressHook:
    def __init__(self, job_id: str) -> None:
        self.job_id = job_id

    def __call__(self, data: dict[str, Any]) -> None:
        status = data.get("status")
        if status == "downloading":
            total = data.get("total_bytes") or data.get("total_bytes_estimate") or 0
            downloaded = data.get("downloaded_bytes") or 0
            percent = round(downloaded / total * 100, 1) if total else 0
            update_job(
                self.job_id,
                status="downloading",
                progress=percent,
                message=f"下載中 {percent}%",
            )
        elif status == "finished":
            update_job(
                self.job_id,
                status="processing",
                progress=95,
                message="正在整理檔案",
            )


def run_download(job_id: str, url: str) -> None:
    DOWNLOAD_DIR.mkdir(exist_ok=True)
    output_template = str(DOWNLOAD_DIR / "%(title).120B-%(id)s.%(ext)s")
    options = {
        "outtmpl": output_template,
        "format": "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best",
        "merge_output_format": "mp4",
        "noplaylist": True,
        "restrictfilenames": True,
        "windowsfilenames": True,
        "progress_hooks": [ProgressHook(job_id)],
        "quiet": True,
        "no_warnings": True,
    }

    try:
        update_job(job_id, status="starting", progress=3, message="正在連線到 YouTube")
        with YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=True)
            filename = Path(ydl.prepare_filename(info))
            if filename.suffix.lower() != ".mp4":
                filename = filename.with_suffix(".mp4")

        update_job(
            job_id,
            status="done",
            progress=100,
            message="下載完成",
            title=info.get("title") or filename.stem,
            file=str(filename),
        )
    except Exception as error:  # noqa: BLE001
        update_job(
            job_id,
            status="error",
            progress=0,
            message=str(error),
        )


@app.get("/health")
def health() -> Any:
    return jsonify(
        {
            "ok": True,
            "name": APP_NAME,
            "port": PORT,
            "download_dir": str(DOWNLOAD_DIR),
        }
    )


@app.post("/download")
def download() -> Any:
    payload = request.get_json(silent=True) or {}
    url = str(payload.get("url") or "").strip()
    confirmed = bool(payload.get("confirmed"))

    if not confirmed:
        return jsonify({"ok": False, "error": "請先確認影片為自己擁有或已取得授權。"}), 400
    if not is_youtube_url(url):
        return jsonify({"ok": False, "error": "請輸入有效的 YouTube 網址。"}), 400

    job_id = uuid.uuid4().hex
    with jobs_lock:
        jobs[job_id] = {
            "id": job_id,
            "status": "queued",
            "progress": 0,
            "message": "已加入下載佇列",
            "file": "",
            "title": "",
        }

    worker = threading.Thread(target=run_download, args=(job_id, url), daemon=True)
    worker.start()
    return jsonify({"ok": True, "job_id": job_id})


@app.get("/jobs/<job_id>")
def get_job(job_id: str) -> Any:
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        return jsonify({"ok": False, "error": "找不到這個下載工作。"}), 404
    return jsonify({"ok": True, "job": job})


if __name__ == "__main__":
    DOWNLOAD_DIR.mkdir(exist_ok=True)
    print(json.dumps({"name": APP_NAME, "url": f"http://{HOST}:{PORT}"}, ensure_ascii=False))
    app.run(host=HOST, port=PORT)
