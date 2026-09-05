import concurrent.futures
import http.client
import io
import json
from pathlib import Path
import struct
import subprocess
import threading
import unittest
import urllib.parse
import zipfile
import zlib

import app


def png(width=48, height=32):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    pixels = b''.join(b'\0' + bytes([0, 0, 0, 0]) * width for _ in range(height))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b'')


class Integration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def request(self, path, body=None, token=app.TOKEN):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=180)
        conn.request('POST' if body is not None else 'GET', path, body, {'X-App-Token': token})
        response = conn.getresponse()
        status, data = response.status, response.read()
        conn.close()
        return status, data

    def encode(self, fmt='webp', keep='false', data=None, size=0):
        query = urllib.parse.urlencode({'name':'тест.png','format':fmt,'quality':80,'keep':keep,'size':size})
        status, data = self.request('/api/compress?' + query, data if data is not None else png())
        self.assertEqual(status, 200, data)
        return json.loads(data)

    def test_formats_and_white_jpeg_background(self):
        for fmt in ['webp','png','jpg']:
            result = self.encode(fmt)
            self.assertTrue(result['name'].endswith('.' + fmt))
            path = app.RESULTS[result['id']][0]
            raw = subprocess.check_output([app.ffmpeg(), '-v','error','-i',str(path),'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-'])
            self.assertEqual(len(raw), 48*32*3)
            if fmt == 'jpg':
                self.assertGreater(min(raw), 245)

    def test_resize(self):
        result = self.encode('png', data=png(2000, 1000), size=1280)
        data = app.RESULTS[result['id']][0].read_bytes()
        self.assertEqual(struct.unpack('>II', data[16:24]), (1280,640))

    def test_original_fallback(self):
        original = png()
        result = self.encode('jpg', keep='true', data=original)
        self.assertTrue(result['kept'])
        self.assertEqual(app.RESULTS[result['id']][0].read_bytes(), original)

    def test_batch_100_and_archive(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(lambda _: self.encode(), range(100)))
        status, data = self.request('/api/zip', json.dumps([r['id'] for r in results]))
        self.assertEqual(status,200)
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            self.assertEqual(len(z.namelist()),100)
            self.assertEqual(len(set(z.namelist())),100)
            self.assertIsNone(z.testzip())

    def test_bad_input_and_security(self):
        self.assertEqual(self.request('/api/compress?name=a.png', b'not an image')[0],422)
        self.assertEqual(self.request('/api/compress?name=a.png', png(), token='bad')[0],403)
        self.assertEqual(self.request('/api/compress?name=a.svg', png())[0],400)
        self.assertEqual(self.request('/api/zip', '["../../etc/passwd"]')[0],400)
        self.assertEqual(self.request('/../../etc/passwd')[0],404)


if __name__ == '__main__':
    unittest.main()
