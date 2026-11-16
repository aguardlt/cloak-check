"""Minimal Marionette client (Firefox remote protocol): length-prefixed JSON over TCP."""
import json, socket, time


class Marionette:
    def __init__(self, port=2828, timeout=60):
        deadline = time.time() + timeout
        while True:
            try:
                self.s = socket.create_connection(('127.0.0.1', port), timeout=5); break
            except OSError:
                if time.time() > deadline: raise
                time.sleep(0.3)
        self.s.settimeout(120); self.buf = b''; self.n = 0
        self._read()  # hello

    def _read(self):
        while b':' not in self.buf: self.buf += self.s.recv(65536)
        size, rest = self.buf.split(b':', 1); size = int(size)
        while len(rest) < size: rest += self.s.recv(65536)
        self.buf = rest[size:]
        return json.loads(rest[:size])

    def call(self, name, params=None):
        self.n += 1
        body = json.dumps([0, self.n, name, params or {}]).encode()
        self.s.sendall(str(len(body)).encode() + b':' + body)
        _, _, err, res = self._read()
        if err: raise RuntimeError(f"{name}: {err.get('error')}: {err.get('message')}")
        return res.get('value', res) if isinstance(res, dict) else res

    def chrome(self, script, args=()):
        self.call('Marionette:SetContext', {'value': 'chrome'})
        try: return self.call('WebDriver:ExecuteAsyncScript', {'script': script, 'args': list(args), 'sandbox': 'system'})
        finally: self.call('Marionette:SetContext', {'value': 'content'})

    def js(self, script, args=(), sandbox='default'):
        return self.call('WebDriver:ExecuteAsyncScript', {'script': script, 'args': list(args), 'sandbox': sandbox})
