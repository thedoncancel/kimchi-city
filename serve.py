#!/usr/bin/env python3
"""Local server for Kimchi City.

Same as `python3 -m http.server`, but tells the browser to re-check every file,
so changes to the game show up on a normal reload instead of running stale cached code.
Usage: python3 serve.py [port]   (default 5173)
"""
import http.server
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
    print(f"Kimchi City running at http://localhost:{port}")
    http.server.ThreadingHTTPServer(("", port), NoCacheHandler).serve_forever()
