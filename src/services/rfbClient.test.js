import { RfbSession, toRgba, keyToKeysym } from './rfbClient';

// The console is the only way a virtual machine's screen appears inside RunContainer, so
// these tests are about the two things that must never be wrong: the handshake, and a
// rectangle that arrives split across two network chunks.

const bytes = (...values) => new Uint8Array(values);
const ascii = (text) => new Uint8Array([...text].map((character) => character.charCodeAt(0)));
const u16 = (value) => bytes((value >> 8) & 0xff, value & 0xff);
const u32 = (value) => bytes((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);

function pixelFormat({ bpp = 32, bigEndian = false, redMax = 255, greenMax = 255, blueMax = 255, redShift = 16, greenShift = 8, blueShift = 0 } = {}) {
  return bytes(
    bpp, 24, bigEndian ? 1 : 0, 1,
    ...u16(redMax), ...u16(greenMax), ...u16(blueMax),
    redShift, greenShift, blueShift, 0, 0, 0,
  );
}

function serverInit({ width = 640, height = 480, format = pixelFormat(), name = 'QEMU' } = {}) {
  return bytes(...u16(width), ...u16(height), ...format, ...u32(name.length), ...ascii(name));
}

function framebufferUpdate(rects) {
  // flatMap would not flatten a Uint8Array element (it is not an Array), which would
  // silently truncate every message, so the rectangles are joined explicitly.
  const body = rects.reduce((all, rect) => all.concat(Array.from(rect)), []);
  return bytes(0, 0, ...u16(rects.length), ...body);
}

function rawRect({ x = 0, y = 0, width = 1, height = 1, pixels }) {
  return bytes(...u16(x), ...u16(y), ...u16(width), ...u16(height), ...u32(0), ...pixels);
}

function copyRect({ x, y, width, height, sourceX, sourceY }) {
  return bytes(...u16(x), ...u16(y), ...u16(width), ...u16(height), 0, 0, 0, 1, ...u16(sourceX), ...u16(sourceY));
}

function desktopSizeRect({ width, height }) {
  // -223 as a signed 32-bit value.
  return bytes(...u16(0), ...u16(0), ...u16(width), ...u16(height), 0xff, 0xff, 0xff, 0x21);
}

function connect(session, { width = 640, height = 480, version = 'RFB 003.008\n', offered = [1], format = pixelFormat(), name = 'QEMU', securityResult = 'ok' } = {}) {
  session.receive(ascii(version));
  const versionReply = session.takeOutbox();
  void name;
  session.receive(bytes(offered.length, ...offered));
  const securityReply = session.takeOutbox();
  // A 3.8 server continues with SecurityResult even when the chosen security type is None
  // (RFC 6143 7.2.1), which is what QEMU does. 'skip' models a server that does not.
  if (securityResult === 'ok') session.receive(u32(0));
  if (securityResult === 'no') session.receive(u32(1));
  session.receive(serverInit({ width, height, format, name }));
  const initReply = session.takeOutbox();
  return { versionReply, securityReply, initReply };
}

describe('RFB handshake', () => {
  it('answers the version, picks no-auth and asks for raw frames', () => {
    const session = new RfbSession();
    const { versionReply, securityReply, initReply } = connect(session);

    expect(String.fromCharCode(...versionReply[0])).toBe('RFB 003.008\n');
    // None, then ClientInit asking for a shared session.
    expect(Array.from(securityReply[0])).toEqual([1]);
    expect(Array.from(securityReply[1])).toEqual([1]);

    // SetEncodings: type 2, then Raw, CopyRect and DesktopSize as signed 32-bit values.
    const setEncodings = initReply[1];
    expect(setEncodings).toHaveLength(16);
    expect(setEncodings[0]).toBe(2);
    expect(setEncodings[2]).toBe(0);
    expect(setEncodings[3]).toBe(3);
    expect(Array.from(setEncodings.slice(4, 8))).toEqual([0, 0, 0, 0]);       // raw
    expect(Array.from(setEncodings.slice(8, 12))).toEqual([0, 0, 0, 1]);      // copyRect
    expect(Array.from(setEncodings.slice(12, 16))).toEqual([0xff, 0xff, 0xff, 0x21]); // desktopSize (-223)
    // First request is a full (non-incremental) repaint of the whole screen.
    expect(initReply[2][0]).toBe(3);
    expect(initReply[2][1]).toBe(0);
    expect(session.phase).toBe('message');
  });

  it('asks the server to convert to true colour before anything is painted', () => {
    const session = new RfbSession();
    // A palette-mode display, which is what every BIOS screen and installer boot uses.
    const { initReply } = connect(session, {
      format: bytes(8, 8, 0, 0, ...u16(255), ...u16(255), ...u16(255), 0, 0, 0, 0, 0, 0),
    });
    const setPixelFormat = initReply[0];
    expect(setPixelFormat).toHaveLength(20);
    expect(setPixelFormat[0]).toBe(0);
    expect(Array.from(setPixelFormat.slice(4, 8))).toEqual([32, 24, 0, 1]);
    expect(Array.from(setPixelFormat.slice(8, 14))).toEqual([0, 255, 0, 255, 0, 255]);
    expect(Array.from(setPixelFormat.slice(14, 17))).toEqual([16, 8, 0]);
    // The screen is drawn, not refused: this is the machine's first visible pixels.
    expect(session.failed).toBe(false);
    expect(session.pixelFormat.bitsPerPixel).toBe(32);
    expect(session.pixelFormat.trueColour).toBe(true);
  });

  it('lowers its answer for a 3.3 server and accepts its 32-bit security type', () => {
    const session = new RfbSession();
    session.receive(ascii('RFB 003.003\n'));
    expect(String.fromCharCode(...session.takeOutbox()[0])).toBe('RFB 003.003\n');
    session.receive(u32(1));
    expect(Array.from(session.takeOutbox()[0])).toEqual([1]);
    session.receive(serverInit());
    const outbox = session.takeOutbox();
    expect(outbox[0][0]).toBe(0); // the format is requested for these servers too
    expect(outbox[1][0]).toBe(2);
    expect(session.phase).toBe('message');
  });

  it('says so plainly when the console wants a password it cannot give', () => {
    const errors = [];
    const session = new RfbSession({ onError: (message) => errors.push(message) });
    session.receive(ascii('RFB 003.008\n'));
    // One offered security type, and it is VNC password authentication.
    session.receive(bytes(1, 2));
    expect(errors.join(' ')).toContain('asked for a password');
    expect(session.failed).toBe(true);
    // A failed session stops processing rather than half-drawing a screen.
    session.receive(serverInit());
    expect(session.phase).toBe('security');
  });

  it('reports a refusal reason from the server', () => {
    const errors = [];
    const session = new RfbSession({ onError: (message) => errors.push(message) });
    session.receive(ascii('RFB 003.008\n'));
    session.takeOutbox();
    session.receive(bytes(0, ...u32(6), ...ascii('nope!!')));
    expect(errors[0]).toContain('nope!!');
  });

  it('reads the SecurityResult a 3.8 server sends even for None, so nothing drifts', () => {
    // The real QEMU message trace: "RFB 003.008\n", the security list, four zero bytes, then
    // a ServerInit of 720x400 in 32-bit true colour. Missing the four bytes left the client
    // reading a pixel format of two bits per pixel and then framing rectangles in the middle
    // of other messages — the console stayed empty while the guest ran.
    const ready = [];
    const session = new RfbSession({ onReady: (info) => ready.push(info) });
    session.receive(ascii('RFB 003.008\n'));
    session.takeOutbox();
    session.receive(bytes(1, 1));
    expect(session.phase).toBe('result');
    session.takeOutbox();
    session.receive(bytes(0, 0, 0, 0));
    expect(session.phase).toBe('result'); // not enough to decide yet
    session.receive(serverInit({ width: 720, height: 400 }));
    expect(session.phase).toBe('message');
    expect(ready[0]).toMatchObject({ width: 720, height: 400 });
    expect(session.pixelFormat.bitsPerPixel).toBe(32);
  });

  it('draws a server that leaves the SecurityResult out anyway', () => {
    // Nothing is perfect: a server that goes straight to ServerInit is recognised by the
    // header itself rather than having its pixels eaten as a status.
    const ready = [];
    const session = new RfbSession({ onReady: (info) => ready.push(info) });
    connect(session, { width: 800, height: 600, securityResult: 'skip' });
    expect(ready[0]).toMatchObject({ width: 800, height: 600 });
    expect(session.phase).toBe('message');
  });

  it('reports a SecurityResult that refuses the console', () => {
    const errors = [];
    const session = new RfbSession({ onError: (message) => errors.push(message) });
    session.receive(ascii('RFB 003.008\n'));
    session.takeOutbox();
    session.receive(bytes(1, 1));
    session.takeOutbox();
    session.receive(bytes(...u32(1), ...u32(6), ...ascii('nope!!')));
    expect(errors.join(' ')).toContain('nope!!');
  });

  it('handles a ServerInit desktop name split across multiple packets', () => {
    const ready = [];
    const session = new RfbSession({ onReady: (info) => ready.push(info) });
    session.receive(ascii('RFB 003.008\n'));
    session.takeOutbox();
    session.receive(bytes(1, 1));
    session.takeOutbox();
    const init = serverInit({ width: 720, height: 400, name: 'QEMU console' });
    session.receive(bytes(...u32(0), ...init.slice(0, 26)));
    expect(ready).toHaveLength(0);
    session.receive(init.slice(26, 29));
    expect(ready).toHaveLength(0);
    session.receive(init.slice(29));
    expect(ready[0]).toMatchObject({ width: 720, height: 400, name: 'QEMU console' });
    expect(session.phase).toBe('message');
  });

  it('still reports a handshake that is not RFB at all', () => {
    const errors = [];
    const session = new RfbSession({ onError: (message) => errors.push(message) });
    session.receive(ascii('HTTP/1.1 200\n'));
    expect(errors.join(' ')).toContain('did not answer with RFB');
  });

  it('reports the guest screen size and name once the session is up', () => {
    const ready = [];
    const names = [];
    const session = new RfbSession({ onReady: (info) => ready.push(info), onName: (name) => names.push(name) });
    connect(session, { width: 1024, height: 768, name: 'QEMU (windows)' });
    // onReady carries the starting size, name and pixel layout for the canvas.
    expect(ready[0]).toMatchObject({ width: 1024, height: 768, name: 'QEMU (windows)' });
    expect(ready[0].pixelFormat.bitsPerPixel).toBe(32);
    expect(names[0]).toBe('QEMU (windows)');
  });
});

describe('RFB screen updates', () => {
  it('paints a raw rectangle in the server’s pixel layout', () => {
    const rects = [];
    const session = new RfbSession({ onRect: (rect) => rects.push(rect) });
    connect(session, { format: pixelFormat({ redShift: 16, greenShift: 8, blueShift: 0 }) });
    session.takeOutbox();

    // One pixel of pure red, little-endian 32bpp.
    session.receive(framebufferUpdate([rawRect({ width: 1, height: 1, pixels: bytes(0x00, 0x00, 0xff, 0x00) })]));
    expect(rects).toHaveLength(1);
    expect(rects[0]).toMatchObject({ x: 0, y: 0, width: 1, height: 1, encoding: 'raw' });
    expect(Array.from(rects[0].rgba)).toEqual([255, 0, 0, 255]);
    // The console immediately asks for the next update.
    expect(session.takeOutbox()[0][0]).toBe(3);
  });

  it('holds a rectangle that arrives split across chunks until it is whole', () => {
    const rects = [];
    const session = new RfbSession({ onRect: (rect) => rects.push(rect) });
    connect(session);
    session.takeOutbox();

    // A 2x2 rectangle cut in the middle of its pixel data.
    const message = framebufferUpdate([rawRect({
      width: 2,
      height: 2,
      pixels: bytes(1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0, 10, 11, 12, 0),
    })]);
    session.receive(message.slice(0, 14));
    expect(rects).toHaveLength(0);
    session.receive(message.slice(14));
    expect(rects).toHaveLength(1);
    // Channel order is honoured: first byte is blue, last is red.
    expect(Array.from(rects[0].rgba.slice(0, 4))).toEqual([3, 2, 1, 255]);
    expect(Array.from(rects[0].rgba.slice(12, 16))).toEqual([12, 11, 10, 255]);
  });

  it('processes consecutive updates received in the same packet', () => {
    const rects = [];
    const session = new RfbSession({ onRect: (rect) => rects.push(rect) });
    connect(session);
    session.takeOutbox();
    const first = framebufferUpdate([rawRect({ pixels: bytes(0, 0, 255, 0) })]);
    const second = framebufferUpdate([rawRect({ pixels: bytes(0, 255, 0, 0) })]);
    session.receive(bytes(...first, ...second));
    expect(rects).toHaveLength(2);
    expect(Array.from(rects[1].rgba)).toEqual([0, 255, 0, 255]);
  });

  it('handles several rectangles in one update, including a scroll', () => {
    const rects = [];
    const session = new RfbSession({ onRect: (rect) => rects.push(rect) });
    connect(session);
    session.takeOutbox();

    session.receive(framebufferUpdate([
      copyRect({ x: 0, y: 0, width: 10, height: 10, sourceX: 0, sourceY: 4 }),
      rawRect({ x: 10, y: 4, width: 1, height: 1, pixels: bytes(0, 255, 0, 0) }),
    ]));
    expect(rects).toHaveLength(2);
    expect(rects[0]).toMatchObject({ encoding: 'copy', sourceX: 0, sourceY: 4 });
    expect(rects[1]).toMatchObject({ encoding: 'raw' });
    expect(Array.from(rects[1].rgba)).toEqual([0, 255, 0, 255]);
  });

  it('resizes the console when the guest changes resolution', () => {
    const ready = [];
    const sizes = [];
    const session = new RfbSession({ onReady: (info) => ready.push(info), onResize: (w, h) => sizes.push([w, h]) });
    connect(session, { width: 800, height: 600 });
    session.takeOutbox();
    expect(ready[0]).toMatchObject({ width: 800, height: 600 });
    expect(sizes).toHaveLength(0);

    session.receive(framebufferUpdate([desktopSizeRect({ width: 1280, height: 800 })]));
    expect(sizes).toEqual([[1280, 800]]);
    expect(session.width).toBe(1280);
    expect(session.height).toBe(800);
  });

  it('fails loudly on an encoding it never asked for', () => {
    const errors = [];
    const session = new RfbSession({ onError: (message) => errors.push(message) });
    connect(session);
    session.takeOutbox();
    // Hextile (5) was not requested, so nothing in it can be decoded safely.
    session.receive(framebufferUpdate([bytes(...u16(0), ...u16(0), ...u16(4), ...u16(4), 0, 0, 0, 5)]));
    expect(errors.join(' ')).toContain('encoding 5');
  });

  it('ignores a bell and cut text without losing framing', () => {
    const rects = [];
    const session = new RfbSession({ onRect: (rect) => rects.push(rect) });
    connect(session);
    session.takeOutbox();

    session.receive(bytes(2));
    session.receive(bytes(3, 0, 0, 0, ...u32(2), ...ascii('hi')));
    session.receive(framebufferUpdate([rawRect({ width: 1, height: 1, pixels: bytes(9, 9, 9, 0) })]));
    expect(rects).toHaveLength(1);
  });
});

describe('RFB input', () => {
  it('sends pointer position with the button mask', () => {
    const session = new RfbSession();
    connect(session);
    session.takeOutbox();
    const event = session.pointer(300, 200, 1);
    expect(Array.from(event)).toEqual([5, 1, 0x01, 0x2c, 0x00, 0xc8]);
    expect(session.pointer(0, 0, 0)).not.toBeNull();
  });

  it('sends key press and release with an X11 keysym', () => {
    const session = new RfbSession();
    connect(session);
    session.takeOutbox();
    expect(Array.from(session.key(0xff0d, true))).toEqual([4, 1, 0, 0, 0, 0, 0xff, 0x0d]);
    expect(session.key(0xff0d, false)[1]).toBe(0);
  });

  it('does not send input before the session is ready', () => {
    const session = new RfbSession();
    session.receive(ascii('RFB 003.008\n'));
    expect(session.pointer(1, 1, 0)).toBeNull();
    expect(session.key(65, true)).toBeNull();
  });
});

describe('keyboard mapping', () => {
  it('maps letters, shifted symbols and named keys', () => {
    expect(keyToKeysym({ key: 'a' })).toEqual({ keysym: 97, needsShift: false });
    expect(keyToKeysym({ key: 'A' })).toEqual({ keysym: 97, needsShift: true });
    expect(keyToKeysym({ key: '!' })).toEqual({ keysym: '1'.charCodeAt(0), needsShift: true });
    expect(keyToKeysym({ key: ':' })).toEqual({ keysym: ';'.charCodeAt(0), needsShift: true });
    expect(keyToKeysym({ key: 'Enter' })).toEqual({ keysym: 0xff0d, needsShift: false });
    expect(keyToKeysym({ key: 'ArrowLeft' })).toEqual({ keysym: 0xff51, needsShift: false });
    expect(keyToKeysym({ key: 'F5' })).toEqual({ keysym: 0xffbe + 4, needsShift: false });
    expect(keyToKeysym({ key: 'Control' })).toEqual({ keysym: 0xffe3, needsShift: false });
    expect(keyToKeysym({ key: 'Unidentified' })).toBeNull();
    expect(keyToKeysym({})).toBeNull();
  });
});

describe('pixel conversion', () => {
  it('scales 16-bit channels by their declared maxima', () => {
    const format = { bitsPerPixel: 16, bigEndian: false, redMax: 31, greenMax: 63, blueMax: 31, redShift: 11, greenShift: 5, blueShift: 0 };
    // 0b11111_111111_11111 -> white
    const rgba = toRgba(bytes(0xff, 0xff), 1, 1, format);
    expect(Array.from(rgba)).toEqual([255, 255, 255, 255]);
  });

  it('reads big-endian 32-bit pixels', () => {
    // Big-endian means the first byte is the most significant, so the red channel sits
    // at the top of the value.
    const format = { bitsPerPixel: 32, bigEndian: true, redMax: 255, greenMax: 255, blueMax: 255, redShift: 24, greenShift: 16, blueShift: 8 };
    const rgba = toRgba(bytes(0x11, 0x22, 0x33, 0x00), 1, 1, format);
    expect(Array.from(rgba.slice(0, 3))).toEqual([0x11, 0x22, 0x33]);
  });

  it('copes with a zero channel maximum instead of dividing by it', () => {
    const format = { bitsPerPixel: 8, bigEndian: false, redMax: 0, greenMax: 0, blueMax: 0, redShift: 0, greenShift: 0, blueShift: 0 };
    expect(Array.from(toRgba(bytes(7), 1, 1, format))).toEqual([0, 0, 0, 255]);
  });
});
