"""Minimal Chrome DevTools Protocol client over a raw WebSocket (text frames only)."""
import base64, json, secrets, socket, struct


class WS:
    def __init__(self, url):
        _, rest = url.split('://', 1)
        hostport, path = rest.split('/', 1)
        host, port = hostport.split(':')
        self.s = socket.create_connection((host, int(port)))
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        self.s.sendall((f'GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\n'
                        f'Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n'
                        f'Sec-WebSocket-Version: 13\r\n\r\n').encode())
        buf = b''
        while b'\r\n\r\n' not in buf:
            buf += self.s.recv(4096)
        self.rest = buf.split(b'\r\n\r\n', 1)[1]
        self.n = 0

    def send(self, method, params=None):
        self.n += 1
        data = json.dumps({'id': self.n, 'method': method, 'params': params or {}}).encode()
        mask = secrets.token_bytes(4)
        head = b'\x81'
        ln = len(data)
        if ln < 126:
            head += bytes([0x80 | ln])
        elif ln < 65536:
            head += b'\xfe' + struct.pack('>H', ln)
        else:
            head += b'\xff' + struct.pack('>Q', ln)
        self.s.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))
        return self.n

    def _read(self, n):
        while len(self.rest) < n:
            chunk = self.s.recv(65536)
            if not chunk:
                raise IOError('connection closed')
            self.rest += chunk
        out, self.rest = self.rest[:n], self.rest[n:]
        return out

    def recv(self):
        payload = b''
        while True:
            b1, b2 = self._read(2)
            ln = b2 & 0x7F
            if ln == 126:
                ln = struct.unpack('>H', self._read(2))[0]
            elif ln == 127:
                ln = struct.unpack('>Q', self._read(8))[0]
            payload += self._read(ln)
            if b1 & 0x80:
                return json.loads(payload)

    def call(self, method, params=None):
        i = self.send(method, params)
        while True:
            msg = self.recv()
            if msg.get('id') == i:
                if 'error' in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get('result', {})
