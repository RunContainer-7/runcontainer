// A small RFB (VNC) client, so a virtual machine's screen is drawn inside RunContainer
// instead of in a window of QEMU's own.
//
// Why this exists: QEMU can show a guest in an SDL window it owns, which would sit
// outside RunContainer on the desktop. It can also serve the same guest over RFB on
// loopback, and this client turns that stream into rectangles a canvas can paint. Only
// loopback is ever used, and the socket itself lives in the main process — a renderer
// cannot open a TCP connection, and it should not.
//
// Deliberately free of DOM and Electron: it takes bytes and returns bytes, which is what
// makes it testable.
//
// Encodings: Raw and CopyRect are requested, plus the DesktopSize pseudo-encoding so a
// guest that changes resolution resizes the canvas. Raw is what QEMU sends for dirty
// rectangles; over loopback that is fast enough for an experimental console, and this is
// not presented as a compression win.
const SERVER_VERSION = /^RFB (\d{3})\.(\d{3})\n$/;

export const RFB_ENCODING = {
  raw: 0,
  copyRect: 1,
  desktopSize: -223,
  // Marks the end of a group of rectangles. It cannot be requested.
  lastRect: -224,
};

const SECURITY_NONE = 1;
const SECURITY_VNC_AUTH = 2;

// What the console asks the server to send.
//
// A server describes its own format in ServerInit, and for a guest that is sitting in VGA
// text mode — which is the BIOS screen and the first minutes of every operating system
// setup — that format is 8-bit with a colour table. Refusing those, as this client first
// did, meant no machine could ever draw its first screen: the handshake failed and the
// console stayed empty while the guest was running perfectly well. A real VNC client does
// not refuse them either; it sends SetPixelFormat and lets the server convert. 32-bit
// true colour is also the cheapest thing to paint into a canvas.
export const CLIENT_PIXEL_FORMAT = {
  bitsPerPixel: 32,
  depth: 24,
  bigEndian: false,
  trueColour: true,
  redMax: 255,
  greenMax: 255,
  blueMax: 255,
  redShift: 16,
  greenShift: 8,
  blueShift: 0,
};

// SetPixelFormat: type 0, three padding bytes, then the 16-byte format.
function setPixelFormatMessage(format = CLIENT_PIXEL_FORMAT) {
  const message = new Uint8Array(20);
  message[0] = 0;
  message[4] = format.bitsPerPixel;
  message[5] = format.depth;
  message[6] = format.bigEndian ? 1 : 0;
  message[7] = format.trueColour ? 1 : 0;
  message.set(new Uint8Array(u16(format.redMax)), 8);
  message.set(new Uint8Array(u16(format.greenMax)), 10);
  message.set(new Uint8Array(u16(format.blueMax)), 12);
  message[14] = format.redShift;
  message[15] = format.greenShift;
  message[16] = format.blueShift;
  return message;
}

const NAMED_KEYSYMS = {
  Enter: 0xff0d,
  Backspace: 0xff08,
  Tab: 0xff09,
  Escape: 0xff1b,
  Delete: 0xffff,
  Insert: 0xff63,
  Home: 0xff50,
  End: 0xff57,
  PageUp: 0xff55,
  PageDown: 0xff56,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  Shift: 0xffe1,
  Control: 0xffe3,
  Alt: 0xffe9,
  Meta: 0xffeb,
  CapsLock: 0xffe5,
  PrintScreen: 0xff61,
  Pause: 0xff13,
  ContextMenu: 0xff67,
  ' ': 0x0020,
};

// Characters that need Shift held: a real keyboard produces these by holding Shift, and
// a guest with an unusual layout expects exactly that.
const SHIFTED_CHARACTERS = {
  '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8',
  '(': '9', ')': '0', _: '-', '+': '=', '{': '[', '}': ']', '|': '\\',
  ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`',
};

export function keyToKeysym({ key } = {}) {
  if (typeof key !== 'string' || key.length === 0) return null;
  if (Object.prototype.hasOwnProperty.call(NAMED_KEYSYMS, key)) {
    return { keysym: NAMED_KEYSYMS[key], needsShift: false };
  }
  const functionKey = /^F([1-9]|1[0-2])$/.exec(key);
  if (functionKey) return { keysym: 0xffbe + (Number(functionKey[1]) - 1), needsShift: false };
  if (key.length === 1) {
    if (Object.prototype.hasOwnProperty.call(SHIFTED_CHARACTERS, key)) {
      return { keysym: SHIFTED_CHARACTERS[key].charCodeAt(0), needsShift: true };
    }
    if (/[A-Za-z]/.test(key)) {
      // X11 keysyms are the unshifted character; a capital letter is Shift + that key.
      return { keysym: key.toLowerCase().charCodeAt(0), needsShift: /[A-Z]/.test(key) };
    }
    return { keysym: key.charCodeAt(0), needsShift: false };
  }
  return null;
}

function u16(value) {
  return [(value >> 8) & 0xff, value & 0xff];
}

function u32(value) {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function i32(value) {
  return u32(value < 0 ? value + 0x100000000 : value);
}

function readU16(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU32(bytes, offset) {
  return ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]);
}

export class RfbSession {
  constructor({ onRect, onResize, onName, onError, onReady } = {}) {
    this.onRect = onRect || (() => {});
    this.onResize = onResize || (() => {});
    this.onName = onName || (() => {});
    this.onError = onError || (() => {});
    this.onReady = onReady || (() => {});

    this.phase = 'version';
    this.serverVersion = null;
    this.pixelFormat = null;
    this.nameLength = null;
    this.pendingRects = 0;
    this.width = 0;
    this.height = 0;
    this.name = '';
    this.outbox = [];
    this.chunks = [];
    this.buffered = 0;
    this.failed = false;
    // Set when the guest changes resolution. The canvas is cleared at the new size, so the
    // next request must paint the whole of it rather than only what changed: a machine that
    // boots at 0x0 (QEMU does not know the mode yet) reports its real size this way, and an
    // incremental request after that would leave the screen empty.
    this.needsFullRepaint = false;
  }

  /** Messages to send, in order. Call after every receive(). */
  takeOutbox() {
    const messages = this.outbox;
    this.outbox = [];
    return messages;
  }

  fail(message) {
    if (this.failed) return;
    this.failed = true;
    this.onError(message);
  }

  /** Bytes as they arrive from the console socket. */
  push(bytes) {
    this.add(bytes, false);
  }

  /** Bytes that were consumed but belong to an incomplete message: put back in front. */
  restore(bytes) {
    this.add(bytes, true);
  }

  add(bytes, toFront) {
    if (!bytes || bytes.length === 0) return;
    const chunk = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (toFront) this.chunks.unshift(chunk);
    else this.chunks.push(chunk);
    this.buffered += chunk.length;
  }

  take(count) {
    if (count === 0) return new Uint8Array(0);
    const out = new Uint8Array(count);
    let written = 0;
    while (written < count) {
      const head = this.chunks[0];
      const needed = count - written;
      if (head.length <= needed) {
        out.set(head, written);
        written += head.length;
        this.chunks.shift();
      } else {
        out.set(head.subarray(0, needed), written);
        this.chunks[0] = head.subarray(needed);
        written += needed;
      }
    }
    this.buffered -= count;
    return out;
  }

  /** Read without consuming. Only ever used for small fixed headers. */
  peek(count) {
    if (this.buffered < count) return null;
    const bytes = this.take(count);
    this.restore(bytes);
    return bytes;
  }

  receive(bytes) {
    if (this.failed) return;
    this.push(bytes);
    try {
      let progressed = true;
      while (progressed && !this.failed) {
        progressed = this.step();
      }
    } catch (error) {
      this.fail(String(error?.message || error));
    }
  }

  step() {
    if (this.phase === 'version') return this.readVersion();
    if (this.phase === 'security') return this.readSecurity();
    if (this.phase === 'result') return this.readSecurityResult();
    if (this.phase === 'init') return this.readServerInit();
    if (this.phase === 'message') return this.readMessage();
    return false;
  }

  readVersion() {
    if (this.buffered < 12) return false;
    const version = String.fromCharCode(...this.take(12));
    const match = SERVER_VERSION.exec(version);
    if (!match) {
      throw new Error(`The VM console did not answer with RFB (got "${version.trim()}").`);
    }
    const major = Number(match[1]);
    const minor = Number(match[2]);
    this.serverVersion = { major, minor };
    // Answer with our own version: the server lowers it to the older of the two.
    const reply = major > 3 || (major === 3 && minor >= 8) ? 'RFB 003.008\n' : 'RFB 003.003\n';
    this.outbox.push(new Uint8Array([...reply].map((character) => character.charCodeAt(0))));
    this.phase = 'security';
    return true;
  }

  readSecurity() {
    const { major, minor } = this.serverVersion;
    const modern = major > 3 || (major === 3 && minor >= 7);

    if (modern) {
      if (this.buffered < 1) return false;
      const count = this.peek(1)[0];
      if (count === 0) {
        // 3.8 reports the reason as a length-prefixed string; 3.7 has no length field.
        if (minor >= 8) {
          if (this.buffered < 5) return false;
          const header = this.peek(5);
          const length = readU32(header, 1);
          if (this.buffered < 5 + length) return false;
          this.take(5);
          const reason = length > 0 ? String.fromCharCode(...this.take(length)) : '';
          throw new Error(reason ? `The VM console refused the connection: ${reason}` : 'The VM console refused the connection.');
        }
        this.take(1);
        throw new Error('The VM console refused the connection.');
      }
      if (this.buffered < 1 + count) return false;
      const offered = Array.from(this.take(1 + count).slice(1));
      if (!offered.includes(SECURITY_NONE)) {
        throw new Error(offered.includes(SECURITY_VNC_AUTH)
          ? 'This VM console asked for a password, which RunContainer does not support.'
          : `This VM console only offers security types RunContainer does not support (${offered.join(', ')}).`);
      }
      this.outbox.push(new Uint8Array([SECURITY_NONE]));
      this.outbox.push(new Uint8Array([1])); // ClientInit: shared
      // Choosing None does not skip the SecurityResult: the protocol says the handshake
      // continues with it (RFC 6143 §7.2.1). QEMU sends it as four zero bytes, and a client
      // that does not read it is four bytes out of step from then on — which is exactly how
      // this console spent its life refusing to draw a guest that was running fine.
      this.phase = 'result';
      return true;
    }

    // 3.3 sends the chosen security type as a 32-bit value.
    if (this.buffered < 4) return false;
    const type = readU32(this.peek(4), 0);
    if (type === 0) {
      if (this.buffered < 8) return false;
      const header = this.peek(8);
      const length = readU32(header, 4);
      if (this.buffered < 8 + length) return false;
      this.take(8);
      const reason = length > 0 ? String.fromCharCode(...this.take(length)) : '';
      throw new Error(reason ? `The VM console refused the connection: ${reason}` : 'The VM console refused the connection.');
    }
    if (type !== SECURITY_NONE) {
      throw new Error(type === SECURITY_VNC_AUTH
        ? 'This VM console asked for a password, which RunContainer does not support.'
        : `This VM console refuses the connection (security type ${type}).`);
    }
    this.take(4);
    this.outbox.push(new Uint8Array([1]));
    this.phase = 'init';
    return true;
  }

  // SecurityResult: a 32-bit status, and on failure a length-prefixed reason.
  //
  // The status is checked against the ServerInit that has to follow it, because not every
  // server obeys the protocol here: a server that omits the message would otherwise have
  // its ServerInit eaten as a status, and the console would fail with something unreadable
  // instead of drawing. A header that is plausible as a ServerInit is treated as one.
  readSecurityResult() {
    if (this.buffered < 4) return false;

    // A server that skips the message is recognised by the header itself, so its pixels are
    // not eaten as a status. Twenty-four bytes is a whole ServerInit header plus the length
    // of its name, which is as little as any server can send.
    if (this.buffered >= 24 && looksLikeServerInit(this.peek(24))) {
      this.phase = 'init';
      return true;
    }

    // A refusal says so on its own, and waiting for a ServerInit that is never coming would
    // leave the console silent instead of explaining why. The reason has to be complete: a
    // ServerInit arriving in pieces could otherwise have its pixel format read as a length.
    if (this.buffered >= 8) {
      const status = readU32(this.peek(4), 0);
      if (status !== 0) {
        const length = readU32(this.peek(8), 4);
        if (this.buffered >= 8 + length) {
          this.take(8);
          const reason = length > 0 ? String.fromCharCode(...this.take(length)) : '';
          throw new Error(reason ? `The VM console refused the connection: ${reason}` : 'The VM console refused the connection.');
        }
      }
    }

    // Nothing left to wait for but the whole header: these four bytes are a successful
    // SecurityResult and the ServerInit follows them.
    if (this.buffered < 24) return false;
    const status = readU32(this.take(4), 0);
    if (status !== 0) throw new Error('The VM console refused the connection.');
    this.phase = 'init';
    return true;
  }

  readServerInit() {
    // ServerInit is width (2), height (2) and the pixel format (16) — twenty bytes —
    // followed by the length-prefixed desktop name.
    if (this.buffered < 24) return false;
    const nameLength = readU32(this.peek(24), 20);
    if (nameLength > 4096) throw new Error('The VM console sent an invalid desktop name.');
    if (this.buffered < 24 + nameLength) return false;
    const header = this.take(20);
    this.width = readU16(header, 0);
    this.height = readU16(header, 2);
    this.pixelFormat = {
      bitsPerPixel: header[4],
      depth: header[5],
      bigEndian: header[6] === 1,
      trueColour: header[7] === 1,
      redMax: readU16(header, 8),
      greenMax: readU16(header, 10),
      blueMax: readU16(header, 12),
      redShift: header[14],
      greenShift: header[15],
      blueShift: header[16],
    };
    // Kept for the session's own reporting, not for decoding: what arrives is in the format
    // asked for below, whatever the server said it prefers.
    this.serverPixelFormat = this.pixelFormat;
    this.pixelFormat = CLIENT_PIXEL_FORMAT;
    this.nameLength = readU32(this.take(4), 0);
    this.name = this.nameLength > 0 ? String.fromCharCode(...this.take(this.nameLength)) : '';
    this.onName(this.name);

    // Asked for before anything is painted, so every rectangle that follows is in a format
    // this canvas can draw.
    this.outbox.push(setPixelFormatMessage());

    // Raw is listed first: a server may only use encodings the client named, so naming
    // Raw is what guarantees this client can always draw whatever arrives.
    const encodings = [RFB_ENCODING.raw, RFB_ENCODING.copyRect, RFB_ENCODING.desktopSize];
    const message = new Uint8Array(4 + (encodings.length * 4));
    message[0] = 2; // SetEncodings
    message[2] = (encodings.length >> 8) & 0xff;
    message[3] = encodings.length & 0xff;
    encodings.forEach((encoding, index) => {
      message.set(new Uint8Array(i32(encoding)), 4 + (index * 4));
    });
    this.outbox.push(message);
    this.outbox.push(this.framebufferUpdateRequest(false));
    this.phase = 'message';
    this.onReady({ width: this.width, height: this.height, pixelFormat: this.pixelFormat, name: this.name });
    return true;
  }

  readMessage() {
    if (this.phase !== 'message') return false;
    if (this.pendingRects > 0) return this.readRect();
    if (this.buffered < 1) return false;
    const type = this.peek(1)[0];
    if (type === 0) {
      if (this.buffered < 4) return false;
      const header = this.take(4);
      this.pendingRects = readU16(header, 2);
      if (this.pendingRects === 0) return this.finishUpdate();
      return true;
    }
    if (type === 2) {
      // Bell: nothing to draw, but it must be consumed.
      this.take(1);
      return true;
    }
    if (type === 3) {
      if (this.buffered < 8) return false;
      const header = this.peek(8);
      const length = readU32(header, 4);
      if (this.buffered < 8 + length) return false;
      this.take(8 + length);
      return true;
    }
    throw new Error(`The VM console sent an unsupported message (type ${type}).`);
  }

  readRect() {
    const header = this.peek(12);
    if (!header) return false;
    const x = readU16(header, 0);
    const y = readU16(header, 2);
    const width = readU16(header, 4);
    const height = readU16(header, 6);
    const encoding = (header[8] << 24) | (header[9] << 16) | (header[10] << 8) | header[11];

    if (encoding === RFB_ENCODING.desktopSize) {
      this.take(12);
      this.pendingRects -= 1;
      this.width = width;
      this.height = height;
      this.needsFullRepaint = true;
      this.onResize(width, height, this.pixelFormat);
      if (this.pendingRects === 0) return this.finishUpdate();
      return true;
    }
    if (encoding === RFB_ENCODING.lastRect) {
      this.take(12);
      this.pendingRects -= 1;
      if (this.pendingRects === 0) return this.finishUpdate();
      return true;
    }
    if (encoding === RFB_ENCODING.copyRect) {
      if (this.buffered < 16) return false;
      const source = this.take(16).slice(12);
      this.pendingRects -= 1;
      this.onRect({
        x, y, width, height, encoding: 'copy', sourceX: readU16(source, 0), sourceY: readU16(source, 2),
      });
      if (this.pendingRects === 0) return this.finishUpdate();
      return true;
    }
    if (encoding !== RFB_ENCODING.raw) {
      throw new Error(`The VM console used encoding ${encoding}, which RunContainer did not request.`);
    }
    const bytesPerPixel = this.pixelFormat.bitsPerPixel / 8;
    const payload = width * height * bytesPerPixel;
    if (this.buffered < 12 + payload) return false;
    const pixels = this.take(12 + payload).slice(12);
    this.pendingRects -= 1;
    this.onRect({
      x, y, width, height, encoding: 'raw', rgba: toRgba(pixels, width, height, this.pixelFormat),
    });
    if (this.pendingRects === 0) return this.finishUpdate();
    return true;
  }

  // Ask for the next update only once a whole message is drawn, so a slow paint never
  // queues requests the server would answer out of order.
  finishUpdate() {
    this.pendingRects = 0;
    const full = this.needsFullRepaint;
    this.needsFullRepaint = false;
    this.outbox.push(this.framebufferUpdateRequest(!full));
    return true;
  }

  framebufferUpdateRequest(incremental) {
    const message = new Uint8Array(10);
    message[0] = 3;
    message[1] = incremental ? 1 : 0;
    message.set(new Uint8Array(u16(0)), 2);
    message.set(new Uint8Array(u16(0)), 4);
    message.set(new Uint8Array(u16(this.width)), 6);
    message.set(new Uint8Array(u16(this.height)), 8);
    return message;
  }

  pointer(x, y, buttonMask) {
    if (this.phase !== 'message') return null;
    const message = new Uint8Array(6);
    message[0] = 5;
    message[1] = buttonMask & 0xff;
    message.set(new Uint8Array(u16(Math.max(0, Math.min(65535, Math.round(x))))), 2);
    message.set(new Uint8Array(u16(Math.max(0, Math.min(65535, Math.round(y))))), 4);
    return message;
  }

  key(keysym, down) {
    if (this.phase !== 'message') return null;
    const message = new Uint8Array(8);
    message[0] = 4;
    message[1] = down ? 1 : 0;
    message.set(new Uint8Array(u32(keysym)), 4);
    return message;
  }

  requestRepaint() {
    if (this.phase !== 'message') return null;
    return this.framebufferUpdateRequest(false);
  }
}

// Could these bytes be the start of a ServerInit? Used only to tell a SecurityResult apart
// from the ServerInit of a server that skips it: a pixel format that is not 8, 16 or 32 bits
// per pixel, a name that would be absurdly long, or a colour depth larger than a pixel are
// all things no real ServerInit does.
function looksLikeServerInit(bytes) {
  if (!bytes || bytes.length < 24) return false;
  const bitsPerPixel = bytes[4];
  const depth = bytes[5];
  const bigEndian = bytes[6];
  const trueColour = bytes[7];
  if (![8, 16, 32].includes(bitsPerPixel)) return false;
  if (depth === 0 || depth > bitsPerPixel) return false;
  if (bigEndian > 1 || trueColour > 1) return false;
  const nameLength = readU32(bytes, 20);
  return nameLength >= 0 && nameLength <= 4096;
}

// Server pixels to RGBA, honouring the channel maxima and shifts the server declared.
// Doing this here rather than with canvas tricks keeps one code path for 8-, 16- and
// 32-bit guests, and lets the conversion be tested without a browser.
export function toRgba(pixels, width, height, format) {
  const out = new Uint8ClampedArray(width * height * 4);
  const bytesPerPixel = format.bitsPerPixel / 8;
  const scale = (value, max) => (max > 0 ? Math.round((value / max) * 255) : 0);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * bytesPerPixel;
    let value;
    if (bytesPerPixel === 1) {
      value = pixels[offset];
    } else if (bytesPerPixel === 2) {
      value = format.bigEndian
        ? (pixels[offset] << 8) | pixels[offset + 1]
        : pixels[offset] | (pixels[offset + 1] << 8);
    } else {
      value = format.bigEndian
        ? ((pixels[offset] << 24) | (pixels[offset + 1] << 16) | (pixels[offset + 2] << 8) | pixels[offset + 3]) >>> 0
        : (pixels[offset] | (pixels[offset + 1] << 8) | (pixels[offset + 2] << 16) | (pixels[offset + 3] << 24)) >>> 0;
    }
    const target = index * 4;
    out[target] = scale((value >>> format.redShift) & format.redMax, format.redMax);
    out[target + 1] = scale((value >>> format.greenShift) & format.greenMax, format.greenMax);
    out[target + 2] = scale((value >>> format.blueShift) & format.blueMax, format.blueMax);
    out[target + 3] = 255;
  }
  return out;
}
