const {
  KEYS,
  buildCompanionInputProgram,
  commandFor,
  pointerToClient,
} = require('../../public/companion-input');

const viewport = { width: 1000, height: 700 };
const parentHandle = 4242;

describe('companion pointer mapping', () => {
  it('maps a fraction of the picture back to the same pixel', () => {
    expect(pointerToClient({ x: 0, y: 0 }, viewport)).toEqual({ x: 0, y: 0 });
    expect(pointerToClient({ x: 0.5, y: 0.5 }, viewport)).toEqual({ x: 500, y: 350 });
    expect(pointerToClient({ x: 1, y: 1 }, viewport)).toEqual({ x: 999, y: 699 });
  });

  it('clamps a value that arrived outside the picture', () => {
    expect(pointerToClient({ x: -3, y: 9 }, viewport)).toEqual({ x: 0, y: 699 });
    expect(pointerToClient({ x: 'nonsense', y: null }, viewport)).toEqual({ x: 0, y: 0 });
  });
});

describe('companion input commands', () => {
  const options = { parentHandle, viewport, headerPx: 56 };

  it('turns a touch into a press and a release', () => {
    expect(commandFor({ action: 'pointer.down', x: 0.5, y: 0.5 }, options)).toBe('down\t4242\t500\t350');
    expect(commandFor({ action: 'pointer.up', x: 0.5, y: 0.5 }, options)).toBe('up\t4242\t500\t350');
    // 0.75 of 700 rows is row 524 (the last row is 699, not 700).
    expect(commandFor({ action: 'pointer.move', x: 0.25, y: 0.75 }, options)).toBe('move\t4242\t250\t524');
  });

  it('refuses a press on the RunContainer header but still delivers the release', () => {
    // y = 0.02 of a 700px window is 14px, inside the 56px header.
    expect(commandFor({ action: 'pointer.down', x: 0.5, y: 0.02 }, options)).toBeNull();
    expect(commandFor({ action: 'pointer.up', x: 0.5, y: 0.02 }, options)).toBe('up\t4242\t500\t14');
    expect(commandFor({ action: 'wheel', x: 0.5, y: 0.02, delta: 120 }, options)).toBeNull();
  });

  it('refuses input without a real window and for a non-left button', () => {
    expect(commandFor({ action: 'pointer.down', x: 0.5, y: 0.5 }, { ...options, parentHandle: 0 })).toBeNull();
    expect(commandFor({ action: 'pointer.down', x: 0.5, y: 0.5, button: 'right' }, options)).toBeNull();
  });

  it('sends a wheel delta and a bounded click count', () => {
    expect(commandFor({ action: 'wheel', x: 0.5, y: 0.5, delta: -240 }, options)).toBe('wheel\t4242\t500\t350\t-240');
    expect(commandFor({ action: 'wheel', x: 0.5, y: 0.5, delta: 0 }, options)).toBeNull();
    expect(commandFor({ action: 'pointer.click', x: 0.5, y: 0.5, count: 99 }, options)).toBe('click\t4242\t500\t350\t2');
  });

  it('maps named keys and never accepts a raw virtual-key number', () => {
    expect(KEYS.Enter.vk).toBe(0x0d);
    expect(commandFor({ action: 'key', key: 'Enter' }, options)).toBe('key\t13\t0\ttap');
    expect(commandFor({ action: 'key', key: 'ArrowLeft', phase: 'down' }, options)).toBe('key\t37\t1\tdown');
    expect(commandFor({ action: 'key', key: 'LaunchMissiles' }, options)).toBeNull();
    expect(commandFor({ action: 'key', key: '13' }, options)).toBeNull();
  });

  it('sends text as UTF-8 so the PC layout does not matter', () => {
    const command = commandFor({ action: 'text', text: 'héllo' }, options);
    expect(command.startsWith('text\t')).toBe(true);
    expect(Buffer.from(command.slice(5), 'base64').toString('utf8')).toBe('héllo');
    expect(commandFor({ action: 'text', text: '' }, options)).toBeNull();
    expect(commandFor({ action: 'text', text: 'x'.repeat(501) }, options)).toBeNull();
  });

  it('ignores anything it does not understand', () => {
    expect(commandFor(null, options)).toBeNull();
    expect(commandFor({ action: 'shell', cmd: 'calc' }, options)).toBeNull();
    expect(commandFor({ action: 'pointer.down' }, {})).toBeNull();
  });

  it('builds a helper that reads one command per line and supports unicode input', () => {
    const source = buildCompanionInputProgram();
    expect(source).toContain('class RunContainerRemoteInput');
    expect(source).toContain('KEYEVENTF_UNICODE');
    expect(source).toContain('Console.In.ReadLine()');
    expect(source).toContain('"quit"');
  });
});
