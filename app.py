"""Local image compression. Run: python app.py."""
import argparse
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.parse
import webbrowser
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).parent
TOKEN = secrets.token_urlsafe(32)
WORK = tempfile.TemporaryDirectory(prefix="imagepress-")
RESULTS = {}
LOCK = threading.Lock()
SLOTS = threading.BoundedSemaphore(3)
MAX_FILE = 50 * 1024 * 1024
EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif"}


def ffmpeg():
    if os.environ.get("FFMPEG_BINARY"):
        return os.environ["FFMPEG_BINARY"]
    if shutil.which("ffmpeg"):
        return shutil.which("ffmpeg")
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def compress(source, target, fmt, quality, size, rotation=0, flip="none", lossless=False, background="ffffff"):
    if source.suffix.lower() in {".heic", ".heif"}:
        decoded = source.with_name("decoded.png")
        try:
            subprocess.run([sys.executable, str(ROOT / "decode_heic.py"), str(source), str(decoded)],
                           check=True, capture_output=True, timeout=120)
            return compress(decoded, target, fmt, quality, size, rotation, flip, lossless, background)
        finally:
            decoded.unlink(missing_ok=True)
    args = [ffmpeg(), "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
            "-max_alloc", "268435456", "-protocol_whitelist", "file,pipe",
            "-threads", "1", "-i", str(source), "-frames:v", "1", "-map_metadata", "-1",
            "-filter_threads", "1", "-threads", "1"]
    filters = []
    if rotation:
        filters += {90: ["transpose=1"], 180: ["hflip", "vflip"], 270: ["transpose=2"]}[rotation]
    if flip != "none":
        filters.append({"horizontal": "hflip", "vertical": "vflip"}[flip])
    if size:
        filters.append(f"scale=w='min(iw,{size})':h='min(ih,{size})':force_original_aspect_ratio=decrease")
    if fmt == "jpg":
        # Flatten transparency onto white before JPEG encoding.
        r, g, b = (int(background[i:i+2], 16) for i in (0, 2, 4))
        filters += ["format=rgba", f"split[a][b];[a]lutrgb=r={r}:g={g}:b={b},colorchannelmixer=aa=1[bg];[bg][b]overlay=format=auto", "format=yuvj444p"]
    if filters:
        args += ["-vf", ",".join(filters)]
    if fmt == "webp":
        args += ["-c:v", "libwebp", "-quality", str(quality), "-compression_level", "6"]
        if lossless:
            args += ["-lossless", "1"]
    elif fmt == "jpg":
        args += ["-c:v", "mjpeg", "-q:v", str(round(31 - quality * 29 / 100))]
    else:
        args += ["-c:v", "png", "-compression_level", "9"]
    args += ["-update", "1", str(target)]
    subprocess.run(args, check=True, capture_output=True, timeout=120)


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, data, content_type="application/json", headers=None):
        if isinstance(data, dict):
            data = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def trusted(self):
        return self.headers.get("Host") in {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}

    def do_GET(self):
        if not self.trusted():
            return self.reply(403, {"error": "Недопустимый адрес"})
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/config":
            return self.reply(200, {"token": TOKEN})
        if path.startswith("/api/file/"):
            item = RESULTS.get(path.rsplit("/", 1)[-1])
            if not item:
                return self.reply(404, {"error": "Файл не найден"})
            return self.reply(200, item[0].read_bytes(), mimetypes.guess_type(item[1])[0] or "application/octet-stream",
                              {"Content-Disposition": "attachment; filename*=UTF-8''" + urllib.parse.quote(item[1])})
        files = {"/": "index.html", "/style.css": "style.css", "/app.js": "app.js"}
        if path not in files:
            return self.reply(404, {"error": "Не найдено"})
        file = ROOT / "static" / files[path]
        self.reply(200, file.read_bytes(), mimetypes.guess_type(file.name)[0] + "; charset=utf-8")

    def do_POST(self):
        if not self.trusted() or self.headers.get("X-App-Token") != TOKEN:
            return self.reply(403, {"error": "Обновите страницу"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_FILE:
                return self.reply(413, {"error": "Максимальный размер файла — 50 МБ"})
            url = urllib.parse.urlsplit(self.path)
            if url.path == "/api/zip":
                ids = json.loads(self.rfile.read(length))
                if not isinstance(ids, list) or not ids or len(ids) > 2000 or any(not isinstance(i, str) or i not in RESULTS for i in ids):
                    raise ValueError("Некорректный список файлов")
                with tempfile.TemporaryFile() as archive:
                    with zipfile.ZipFile(archive, "w", zipfile.ZIP_STORED) as z:
                        for index, ident in enumerate(ids, 1):
                            file, name = RESULTS[ident]
                            z.write(file, f"{index:03d}_{name}")
                    length = archive.tell()
                    archive.seek(0)
                    self.send_response(200)
                    self.send_header("Content-Type", "application/zip")
                    self.send_header("Content-Length", str(length))
                    self.send_header("Content-Disposition", 'attachment; filename="imagepress.zip"')
                    self.end_headers()
                    shutil.copyfileobj(archive, self.wfile)
                return
            if url.path not in {"/api/compress", "/api/preview"}:
                return self.reply(404, {"error": "Не найдено"})
            params = urllib.parse.parse_qs(url.query)
            name = Path(params.get("name", ["image.png"])[0].replace("\\", "/")).name
            ext = Path(name).suffix.lower()
            if ext not in EXTENSIONS:
                raise ValueError("Поддерживаются JPG, PNG, WebP, BMP, HEIC/HEIF и TIF/TIFF")
            fmt = params.get("format", ["webp"])[0]
            quality = int(params.get("quality", ["80"])[0])
            size = int(params.get("size", ["0"])[0])
            rotation = int(params.get("rotation", ["0"])[0])
            flip = params.get("flip", ["none"])[0]
            lossless = params.get("lossless", ["false"])[0] == "true"
            background = params.get("background", ["ffffff"])[0].lstrip("#")
            if rotation not in {0, 90, 180, 270} or flip not in {"none", "horizontal", "vertical"} or not re.fullmatch(r"[0-9a-fA-F]{6}", background):
                raise ValueError("Некорректные расширенные настройки")
            if fmt not in {"webp", "jpg", "png"} or not 1 <= quality <= 100 or size not in {0, 1280, 1920, 2560, 3840}:
                raise ValueError("Некорректные настройки")
            ident = secrets.token_hex(16)
            directory = Path(WORK.name) / ident
            directory.mkdir()
            source, target = directory / ("input" + ext), directory / ("output." + fmt)
            try:
                with source.open("wb") as out:
                    remaining = length
                    while remaining:
                        chunk = self.rfile.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise ValueError("Загрузка прервана")
                        out.write(chunk)
                        remaining -= len(chunk)
                with SLOTS:
                    if url.path == "/api/preview":
                        target = directory / "preview.png"
                        compress(source, target, "png", 80, 1280)
                        preview = target.read_bytes()
                        shutil.rmtree(directory)
                        return self.reply(200, preview, "image/png")
                    compress(source, target, fmt, quality, size, rotation, flip, lossless, background)
                kept = params.get("keep", ["true"])[0] == "true" and not size and not rotation and flip == "none" and not lossless and (fmt != "jpg" or background.lower() == "ffffff") and target.stat().st_size >= length
                result = source if kept else target
                safe_stem = re.sub(r'[\x00-\x1f/:\\]', "_", Path(name).stem)[:160] or "image"
                output_name = safe_stem + (ext if kept else "." + fmt)
                result_size = result.stat().st_size
                with LOCK:
                    RESULTS[ident] = (result, output_name)
                (target if kept else source).unlink()
                self.reply(200, {"id": ident, "name": output_name, "size": result_size, "original": length, "kept": kept})
            except Exception:
                shutil.rmtree(directory)
                raise
        except (ValueError, json.JSONDecodeError) as exc:
            self.reply(400, {"error": str(exc)})
        except subprocess.TimeoutExpired:
            self.reply(422, {"error": "Обработка превысила 120 секунд"})
        except subprocess.CalledProcessError:
            self.reply(422, {"error": "Не удалось прочитать изображение. Проверьте формат и целостность файла."})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            print(f"Error: {exc}")
            self.reply(500, {"error": "Ошибка обработки на сервере"})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    subprocess.run([ffmpeg(), "-version"], check=True, stdout=subprocess.DEVNULL)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    url = f"http://127.0.0.1:{server.server_port}"
    print(f"Imagepress → {url}\nCtrl+C — остановить", flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        WORK.cleanup()


if __name__ == "__main__":
    main()
