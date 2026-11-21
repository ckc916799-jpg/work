"""Private loopback service for the independent Douyin Video Sheet extension."""
from __future__ import annotations

import base64
import binascii
import hmac
import importlib.util
import json
from pathlib import Path
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from workbook_export import MAX_WORKBOOK_BYTES, WorkbookExportError, pending_links, sheet_names, write_video

BASE = Path(__file__).resolve().parent
PORT = 18766
APP = "douyin-video-sheet"
VERSION = "1.2.0"
TOKEN = ""


def read_token() -> str:
    path = BASE / "connection-token.txt"
    if not path.exists():
        path.write_text(secrets.token_urlsafe(32), encoding="utf-8")
    token = path.read_text(encoding="utf-8").strip()
    if len(token) < 24:
        raise RuntimeError("连接码无效，请删除 connection-token.txt 后重新运行安装程序。")
    return token


class Handler(BaseHTTPRequestHandler):
    server_version = "DouyinVideoSheet/1.2.0"

    def log_message(self, _format, *_args):
        pass

    def origin_allowed(self) -> bool:
        origin = self.headers.get("Origin", "")
        return not origin or origin.startswith("chrome-extension://") or origin.startswith("extension://")

    def response_headers(self):
        origin = self.headers.get("Origin", "")
        if origin and self.origin_allowed():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Sheet-Token")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")

    def send_json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.response_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def validate(self, *, auth: bool = True) -> bool:
        if self.headers.get("Host") != f"127.0.0.1:{PORT}" or not self.origin_allowed():
            self.send_json(403, {"error": "仅允许本机浏览器插件连接。"})
            return False
        if auth and not hmac.compare_digest(self.headers.get("X-Sheet-Token", ""), TOKEN):
            self.send_json(401, {"error": "连接码不匹配，请复制本插件 connection-token.txt 中的连接码。"})
            return False
        return True

    def do_OPTIONS(self):
        if not self.validate(auth=False):
            return
        self.send_response(204)
        self.response_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        route = urlparse(self.path).path
        if not self.validate(auth=route != "/health"):
            return
        if route == "/health":
            self.send_json(200, {"app": APP, "version": VERSION,
                                 "excel_ready": importlib.util.find_spec("openpyxl") is not None and importlib.util.find_spec("PIL") is not None})
        elif route == "/session/check":
            self.send_json(200, {"ok": True})
        else:
            self.send_json(404, {"error": "接口不存在。"})

    def do_POST(self):
        if not self.validate():
            return
        route = urlparse(self.path).path
        if route == "/shutdown":
            self.send_json(200, {"ok": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if route not in {"/workbooks/inspect", "/workbooks/write", "/workbooks/pending"}:
            self.send_json(404, {"error": "接口不存在。"})
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 36 * 1024 * 1024:
                raise WorkbookExportError("Excel 请求过大或为空。")
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict) or not isinstance(payload.get("workbook"), str):
                raise WorkbookExportError("Excel 内容格式无效。")
            data = base64.b64decode(payload["workbook"], validate=True)
            if len(data) > MAX_WORKBOOK_BYTES:
                raise WorkbookExportError("Excel 文件超过 25MB。")
            if route == "/workbooks/inspect":
                self.send_json(200, {"sheets": sheet_names(data)})
            elif route == "/workbooks/pending":
                self.send_json(200, pending_links(data, payload.get("sheet", ""), limit=20))
            else:
                if not isinstance(payload.get("record"), dict):
                    raise WorkbookExportError("视频数据格式无效。")
                output, result = write_video(data, payload.get("sheet", ""), payload["record"])
                self.send_json(200, {**result, "workbook": base64.b64encode(output).decode("ascii")})
        except (ValueError, TypeError, AttributeError, binascii.Error) as error:
            self.send_json(400, {"error": str(error)})
        except Exception:
            self.send_json(500, {"error": "Excel 处理失败，原文件没有改动。请换一个工作簿重试。"})


def main():
    global TOKEN
    TOKEN = read_token()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"抖音视频入表服务已启动：http://127.0.0.1:{PORT}", flush=True)
    print(f"连接码：{BASE / 'connection-token.txt'}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
