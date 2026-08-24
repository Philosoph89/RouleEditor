// Serial-port manager.
//
// Wraps `serialport` if it is installed and a real port is available, and
// otherwise runs a built-in MOCK port so the whole app is usable without
// hardware (loopback + a simple periodic HomeBus-like heartbeat).
//
// Extends the original RouleEditor, which only offered a fixed list
// COM1..COM8: here the available ports are auto-detected and every DCB
// parameter (baud rate, parity, data bits, stop bits) is freely configurable.

import { EventEmitter } from 'node:events';

let SerialPortLib = null;
try {
  ({ SerialPort: SerialPortLib } = await import('serialport'));
} catch {
  SerialPortLib = null; // optional dependency not built; mock mode only
}

// macOS: /dev/tty.* (dial-in) blockiert beim Öffnen auf DCD; für USB-Adapter
// existiert immer ein /dev/cu.* (call-out) Pendant, das sofort öffnet.
function macPreferCallout(path) {
  if (process.platform !== 'darwin' || typeof path !== 'string') return path;
  if (path.startsWith('/dev/tty.')) return '/dev/cu.' + path.slice('/dev/tty.'.length);
  return path;
}

export const DEFAULT_CONFIG = {
  path: 'MOCK',
  baudRate: 115200,     // original default (DFM BaudRateSpinEdit)
  dataBits: 8,          // DFM '4'..'8'
  stopBits: 1,          // DFM '1','1.5','2'
  parity: 'none',       // none/odd/even/mark/space
  rtscts: false,
};

export const CHOICES = {
  baudRate: [110, 300, 600, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800],
  dataBits: [5, 6, 7, 8],
  stopBits: [1, 1.5, 2],
  parity: ['none', 'odd', 'even', 'mark', 'space'],
};

export class SerialManager extends EventEmitter {
  constructor() {
    super();
    this.port = null;
    this.config = { ...DEFAULT_CONFIG };
    this.mock = null;
    this.stats = { rxBytes: 0, txBytes: 0, openedAt: null };
  }

  get isOpen() {
    return Boolean((this.port && this.port.isOpen) || this.mock);
  }

  status() {
    return {
      open: this.isOpen,
      mock: Boolean(this.mock),
      serialportAvailable: Boolean(SerialPortLib),
      config: this.config,
      stats: this.stats,
    };
  }

  static async list() {
    const ports = [];
    if (SerialPortLib) {
      try {
        const found = await SerialPortLib.list();
        for (const p of found) {
          const isUsb = /\/(tty|cu)\.(usbserial|usbmodem)/i.test(p.path);
          ports.push({
            path: isUsb ? macPreferCallout(p.path) : p.path,
            manufacturer: p.manufacturer || null,
            serialNumber: p.serialNumber || null,
            vendorId: p.vendorId || null,
            productId: p.productId || null,
          });
        }
      } catch (e) {
        // ignore enumeration errors; still offer the mock
      }
    }
    ports.push({ path: 'MOCK', manufacturer: 'Built-in loopback simulator', mock: true });
    return ports;
  }

  async open(cfg = {}) {
    await this.close();
    this.config = { ...DEFAULT_CONFIG, ...this.config, ...cfg };
    this.stats = { rxBytes: 0, txBytes: 0, openedAt: Date.now() };

    if (this.config.path === 'MOCK' || !SerialPortLib) {
      this._openMock();
      this.emit('open', this.status());
      return this.status();
    }

    await new Promise((resolve, reject) => {
      this.port = new SerialPortLib(
        {
          path: macPreferCallout(this.config.path),
          baudRate: Number(this.config.baudRate),
          dataBits: Number(this.config.dataBits),
          stopBits: Number(this.config.stopBits),
          parity: this.config.parity,
          rtscts: Boolean(this.config.rtscts),
          autoOpen: false,
        },
        (err) => { /* constructor error handled by open cb below */ }
      );
      this.port.open((err) => (err ? reject(err) : resolve()));
    });

    this.port.on('data', (buf) => {
      this.stats.rxBytes += buf.length;
      this.emit('rx', buf);
    });
    this.port.on('error', (err) => this.emit('serial-error', err.message));
    this.port.on('close', () => this.emit('close'));
    this.emit('open', this.status());
    return this.status();
  }

  _openMock() {
    // Loopback: echo TX back as RX, plus a periodic heartbeat frame so the
    // monitor shows life without hardware.
    let hb = 0;
    const timer = setInterval(() => {
      const frame = Buffer.from([0xaa, 0x01, hb & 0xff, (hb >> 8) & 0xff, 0x55]);
      hb++;
      this.stats.rxBytes += frame.length;
      this.emit('rx', frame);
    }, 2000);
    this.mock = { timer, echo: true };
  }

  async write(buf) {
    if (!this.isOpen) throw new Error('port not open');
    this.stats.txBytes += buf.length;
    this.emit('tx', buf);
    if (this.mock) {
      if (this.mock.echo) {
        setTimeout(() => {
          this.stats.rxBytes += buf.length;
          this.emit('rx', buf); // loopback
        }, 30);
      }
      return;
    }
    await new Promise((resolve, reject) =>
      this.port.write(buf, (err) => (err ? reject(err) : this.port.drain(resolve)))
    );
  }

  async close() {
    if (this.mock) {
      clearInterval(this.mock.timer);
      this.mock = null;
      this.emit('close');
    }
    if (this.port) {
      const p = this.port;
      this.port = null;
      await new Promise((resolve) => {
        if (p.isOpen) p.close(() => resolve());
        else resolve();
      });
    }
  }
}
