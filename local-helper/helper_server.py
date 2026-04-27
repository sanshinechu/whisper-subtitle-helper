from __future__ import annotations

import json
import re
import shutil
import subprocess
import threading
import uuid
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from yt_dlp import YoutubeDL


APP_NAME = "Whisper Local Helper"
HOST = "127.0.0.1"
PORT = 8765
ROOT_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = ROOT_DIR.parent
DOWNLOAD_DIR = ROOT_DIR / "downloads"
TOOLS_DIR = ROOT_DIR / "tools"

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

jobs: dict[str, dict[str, Any]] = {}
jobs_lock = threading.Lock()


@app.get("/")
def index() -> Any:
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.get("/app.js")
def app_js() -> Any:
    return send_from_directory(FRONTEND_DIR, "app.js")


@app.get("/styles.css")
def styles_css() -> Any:
    return send_from_directory(FRONTEND_DIR, "styles.css")


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


def find_ffmpeg() -> str | None:
    system_ffmpeg = shutil.which("ffmpeg")
    if system_ffmpeg:
        return system_ffmpeg

    for candidate in TOOLS_DIR.glob("**/ffmpeg.exe"):
        return str(candidate)

    return None


def transcode_to_h264(source: Path, ffmpeg_path: str) -> Path:
    if not source.exists():
        raise FileNotFoundError(f"Downloaded file was not found: {source}")

    temp_output = source.with_name(f"{source.stem}.h264.tmp.mp4")
    backup_input = source.with_name(f"{source.stem}.source{source.suffix}")

    command = [
        ffmpeg_path,
        "-y",
        "-i",
        str(source),
        "-vf",
        "scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30",
        "-map",
        "0:v:0?",
        "-map",
        "0:a:0?",
        "-c:v",
        "libx264",
        "-profile:v",
        "main",
        "-level",
        "4.0",
        "-preset",
        "medium",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        str(temp_output),
    ]

    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        message = completed.stderr.strip() or completed.stdout.strip() or "FFmpeg transcode failed."
        raise RuntimeError(message[-1200:])

    if backup_input.exists():
        backup_input.unlink()
    source.replace(backup_input)
    temp_output.replace(source)
    backup_input.unlink(missing_ok=True)
    return source


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
                message=f"Downloading {percent}%",
            )
        elif status == "finished":
            update_job(
                self.job_id,
                status="processing",
                progress=90,
                message="Merging downloaded media",
            )


def run_download(job_id: str, url: str) -> None:
    DOWNLOAD_DIR.mkdir(exist_ok=True)
    output_template = str(DOWNLOAD_DIR / "%(title).120B-%(id)s.%(ext)s")
    ffmpeg_path = find_ffmpeg()

    options = {
        "outtmpl": output_template,
        "format": "bv*[vcodec^=avc1][ext=mp4]+ba[ext=m4a]/b[vcodec^=avc1][ext=mp4]/best[vcodec^=avc1][ext=mp4]/bestvideo*+bestaudio/best",
        "merge_output_format": "mp4",
        "noplaylist": True,
        "restrictfilenames": True,
        "windowsfilenames": True,
        "progress_hooks": [ProgressHook(job_id)],
        "quiet": True,
        "no_warnings": True,
    }
    if ffmpeg_path:
        options["ffmpeg_location"] = ffmpeg_path

    try:
        if not ffmpeg_path:
            raise RuntimeError("FFmpeg is required for Windows-compatible MP4 downloads. Please install FFmpeg and restart the helper.")

        update_job(job_id, status="starting", progress=3, message="Connecting to YouTube")
        with YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=True)
            filename = Path(ydl.prepare_filename(info))
            if filename.suffix.lower() != ".mp4":
                filename = filename.with_suffix(".mp4")

        update_job(job_id, status="processing", progress=96, message="Converting video to Windows-compatible H.264 MP4")
        filename = transcode_to_h264(filename, ffmpeg_path)

        update_job(
            job_id,
            status="done",
            progress=100,
            message="Download completed as H.264 MP4",
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
    ffmpeg_path = find_ffmpeg()
    return jsonify(
        {
            "ok": True,
            "name": APP_NAME,
            "port": PORT,
            "download_dir": str(DOWNLOAD_DIR),
            "ffmpeg": ffmpeg_path or "",
        }
    )


@app.post("/download")
def download() -> Any:
    payload = request.get_json(silent=True) or {}
    url = str(payload.get("url") or "").strip()
    confirmed = bool(payload.get("confirmed"))

    if not confirmed:
        return jsonify({"ok": False, "error": "Please confirm that you own or have permission to download this video."}), 400
    if not is_youtube_url(url):
        return jsonify({"ok": False, "error": "Please enter a valid YouTube URL."}), 400

    job_id = uuid.uuid4().hex
    with jobs_lock:
        jobs[job_id] = {
            "id": job_id,
            "status": "queued",
            "progress": 0,
            "message": "Queued",
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
        return jsonify({"ok": False, "error": "Download job was not found."}), 404
    return jsonify({"ok": True, "job": job})


if __name__ == "__main__":
    DOWNLOAD_DIR.mkdir(exist_ok=True)
    print(json.dumps({"name": APP_NAME, "url": f"http://{HOST}:{PORT}"}, ensure_ascii=False))
    app.run(host=HOST, port=PORT)