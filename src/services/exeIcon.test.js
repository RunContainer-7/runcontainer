const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  extractIconFromBuffer,
  extractIconToFile,
  parseGroupIcon,
  buildIcoBytes,
  entryScore,
} = require('./exeIcon');

// Builds a real PE32 image whose resource directory holds one icon group and the
// icon frames it references. Written by hand so the test does not depend on a
// particular executable existing on the machine.
function buildPeWithIcon({ frames }) {
  const RVA_BASE = 0x1000;
  const SECTION_RVA = 0x1000;
  const SECTIONS = 1;
  const optionalSize = 224;
  const headersSize = 0x40 + 4 + 20 + optionalSize + SECTIONS * 40; // DOS + PE sig + COFF + optional + 1 section header
  const rawPointer = Math.ceil(headersSize / 0x200) * 0x200;

  // Resource tree layout inside the section:
  //   0x00 root directory          (type entries)
  //   0x20 group-icon type dir     (name entries)  -> 0x40 name dir
  //   0x40 group-icon name dir     (language)      -> 0x60 data entry
  //   0x80 icon type dir           (name entries)  -> 0xA0 name dir
  //   0xA0..0xC0 icon name/language dirs + data entries
  //   0xE0.. group image data, then each frame payload
  // Room for the group directory (6 + 14 per frame) must be left before the first
  // frame payload, or the payload copy overwrites the group's last entry.
  const groupDataOffset = 0x200;
  const frameDataOffset = 0x260;
  const groupEntries = frames.map((frame, index) => ({
    width: frame.width,
    height: frame.height,
    colorCount: 0,
    planes: 1,
    bitCount: frame.bitCount,
    bytesInRes: frame.data.length,
    id: index + 1,
  }));
  const groupData = Buffer.alloc(6 + groupEntries.length * 14);
  groupData.writeUInt16LE(0, 0);
  groupData.writeUInt16LE(1, 2);
  groupData.writeUInt16LE(groupEntries.length, 4);
  groupEntries.forEach((entry, index) => {
    const at = 6 + index * 14;
    // 256 is written as 0 in both the group entry and the ico directory.
    groupData.writeUInt8(entry.width === 256 ? 0 : entry.width, at);
    groupData.writeUInt8(entry.height === 256 ? 0 : entry.height, at + 1);
    groupData.writeUInt8(entry.colorCount, at + 2);
    groupData.writeUInt8(0, at + 3);
    groupData.writeUInt16LE(entry.planes, at + 4);
    groupData.writeUInt16LE(entry.bitCount, at + 6);
    groupData.writeUInt32LE(entry.bytesInRes, at + 8);
    groupData.writeUInt16LE(entry.id, at + 12);
  });

  const iconNameDir = (index) => 0xc0 + index * 0x30;
  const frameStride = 0x20;
  const section = Buffer.alloc(0x400);
  const writeDirectory = (at, entries) => {
    section.writeUInt16LE(0, at);
    section.writeUInt16LE(0, at + 2);
    section.writeUInt16LE(0, at + 4);
    section.writeUInt16LE(entries.length, at + 12);
    section.writeUInt16LE(0, at + 14);
    entries.forEach((entry, index) => {
      const entryAt = at + 16 + index * 8;
      section.writeUInt32LE(entry.id, entryAt);
      section.writeUInt32LE(entry.isDirectory ? (entry.offset | 0x80000000) >>> 0 : entry.offset, entryAt + 4);
    });
  };
  const writeDataEntry = (at, dataRva, size) => {
    section.writeUInt32LE(dataRva, at);
    section.writeUInt32LE(size, at + 4);
  };

  writeDirectory(0x00, [{ id: 14, isDirectory: true, offset: 0x20 }, { id: 3, isDirectory: true, offset: 0x80 }]);
  writeDirectory(0x20, [{ id: 1, isDirectory: true, offset: 0x40 }]);
  writeDirectory(0x40, [{ id: 0x409, isDirectory: false, offset: 0x60 }]);
  writeDataEntry(0x60, SECTION_RVA + groupDataOffset, groupData.length);
  // 0x30 per frame: a resource directory occupies 16 bytes plus 8 per entry, so
  // the data entry must not be written where the next directory's entry lives.
  writeDirectory(0x80, frames.map((_frame, index) => ({ id: index + 1, isDirectory: true, offset: iconNameDir(index) })));
  frames.forEach((frame, index) => {
    const nameDir = iconNameDir(index);
    writeDirectory(nameDir, [{ id: 0x409, isDirectory: false, offset: nameDir + 0x20 }]);
    writeDataEntry(nameDir + 0x20, SECTION_RVA + frameDataOffset + frameStride * index, frame.data.length);
  });
  groupData.copy(section, groupDataOffset);
  frames.forEach((frame, index) => frame.data.copy(section, frameDataOffset + frameStride * index));

  const image = Buffer.alloc(rawPointer + section.length);
  image.writeUInt16LE(0x5a4d, 0);
  image.writeUInt32LE(0x40, 0x3c);
  image.writeUInt32LE(0x00004550, 0x40);
  image.writeUInt16LE(0x14c, 0x44); // i386
  image.writeUInt16LE(SECTIONS, 0x46);
  image.writeUInt16LE(optionalSize, 0x54);
  const optional = 0x58;
  image.writeUInt16LE(0x10b, optional);
  image.writeUInt32LE(16, optional + 92); // numberOfRvaAndSizes
  image.writeUInt32LE(SECTION_RVA, optional + 96 + 2 * 8); // resource table RVA
  image.writeUInt32LE(section.length, optional + 96 + 2 * 8 + 4);
  const sectionHeader = optional + optionalSize;
  image.write('.rsrc\0\0\0', sectionHeader, 'ascii');
  image.writeUInt32LE(section.length, sectionHeader + 8); // virtual size
  image.writeUInt32LE(SECTION_RVA, sectionHeader + 12);
  image.writeUInt32LE(section.length, sectionHeader + 16); // raw size
  image.writeUInt32LE(rawPointer, sectionHeader + 20);
  section.copy(image, rawPointer);
  return image;
}

describe('executable icon extraction', () => {
  it('takes every frame the executable declares, largest first', () => {
    const small = Buffer.from([1, 2, 3, 4]);
    const large = Buffer.from([9, 9, 9, 9, 9, 9]);
    const image = buildPeWithIcon({
      frames: [
        { width: 16, height: 16, bitCount: 32, data: small },
        { width: 256, height: 256, bitCount: 32, data: large },
      ],
    });
    const extracted = extractIconFromBuffer(image);
    expect(extracted).not.toBeNull();
    // 0 in a group entry means 256 pixels, and it stays 0 in the rebuilt ico.
    expect(extracted.entries.map((entry) => entry.width)).toEqual([0, 16]);
    // The ico is a real ICO file: reserved 0, type 1, then one entry per frame.
    expect(extracted.bytes.readUInt16LE(0)).toBe(0);
    expect(extracted.bytes.readUInt16LE(2)).toBe(1);
    expect(extracted.bytes.readUInt16LE(4)).toBe(2);
    // A 256-pixel frame is written as 0 in the directory, per the icon format.
    expect(extracted.bytes.readUInt8(6)).toBe(0);
    expect(extracted.bytes.readUInt32LE(6 + 8)).toBe(large.length);
    // Images follow the directory in entry order (largest first), verbatim.
    const directoryEnd = 6 + 16 * 2;
    expect(extracted.bytes.subarray(directoryEnd, directoryEnd + large.length).equals(large)).toBe(true);
    expect(extracted.bytes.subarray(directoryEnd + large.length).equals(small)).toBe(true);
  });

  it('gives up when a group entry references an icon frame that is not in the file', () => {
    const image = buildPeWithIcon({ frames: [{ width: 32, height: 32, bitCount: 32, data: Buffer.from([7, 7]) }] });
    expect(extractIconFromBuffer(image).entries).toHaveLength(1);
    const broken = Buffer.from(image);
    // The group's frame id is edited to one no icon resource carries: a truncated
    // ico with a missing frame would be worse than no icon at all.
    broken.writeUInt16LE(99, 0x200 + 6 + 12);
    expect(extractIconFromBuffer(broken)).toBeNull();
  });

  it('returns nothing for a file that is not a PE image', () => {
    expect(extractIconFromBuffer(Buffer.from('not an executable at all'))).toBeNull();
    expect(extractIconFromBuffer(Buffer.alloc(0))).toBeNull();
  });

  it('rejects a truncated image rather than reading past the end', () => {
    const image = buildPeWithIcon({ frames: [{ width: 32, height: 32, bitCount: 32, data: Buffer.from([1, 2, 3]) }] });
    expect(extractIconFromBuffer(image.subarray(0, 120))).toBeNull();
  });

  it('parses a group icon directory and scores larger frames higher', () => {
    const group = Buffer.alloc(6 + 14);
    group.writeUInt16LE(0, 0);
    group.writeUInt16LE(1, 2);
    group.writeUInt16LE(1, 4);
    group.writeUInt8(32, 6);
    group.writeUInt8(32, 7);
    group.writeUInt16LE(1, 10);
    group.writeUInt16LE(32, 12);
    group.writeUInt32LE(99, 14);
    group.writeUInt16LE(5, 18);
    const entries = parseGroupIcon(group);
    expect(entries).toEqual([{ width: 32, height: 32, colorCount: 0, planes: 1, bitCount: 32, bytesInRes: 99, id: 5 }]);
    expect(entryScore({ width: 256, height: 256, bitCount: 32 })).toBeGreaterThan(entryScore({ width: 32, height: 32, bitCount: 32 }));
  });

  it('writes an ico file and reports its sizes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-icon-'));
    const exe = path.join(dir, 'sample.exe');
    const out = path.join(dir, 'icon.ico');
    fs.writeFileSync(exe, buildPeWithIcon({ frames: [{ width: 48, height: 48, bitCount: 32, data: Buffer.from([1, 2, 3, 4, 5]) }] }));
    const result = extractIconToFile(exe, out);
    expect(result).not.toBeNull();
    expect(result.sizes).toEqual(['48x48']);
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.readFileSync(out).readUInt16LE(2)).toBe(1);
    expect(extractIconToFile(path.join(dir, 'missing.exe'), out)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads the real icon of Windows executables when they are present', () => {
    // A real file is the only way to check the parser against a compiler's output.
    const windows = process.env.SystemRoot || 'C:\\Windows';
    const candidates = [
      path.join(windows, 'explorer.exe'),
      path.join(windows, 'System32', 'shell32.dll'),
      path.join(windows, 'System32', 'notepad.exe'),
    ].filter((candidate) => fs.existsSync(candidate));
    if (candidates.length === 0) {
      console.warn('no Windows executable available to check the parser against');
      return;
    }
    // Not every executable carries an icon (Windows 11's notepad.exe is a packaged
    // app whose image has none), so the check runs against the first file that does.
    const withIcon = candidates
      .map((candidate) => ({ candidate, extracted: extractIconFromBuffer(fs.readFileSync(candidate)) }))
      .find((entry) => entry.extracted);
    expect(withIcon).toBeTruthy();
    expect(withIcon.extracted.entries.length).toBeGreaterThan(0);
    expect(withIcon.extracted.bytes.length).toBeGreaterThan(100);
    expect(withIcon.extracted.bytes.readUInt16LE(2)).toBe(1);
  });

  it('builds an ico even when only one frame exists', () => {
    const bytes = buildIcoBytes([{ width: 16, height: 16, colorCount: 0, planes: 1, bitCount: 32, data: Buffer.from([1, 2]) }]);
    expect(bytes.readUInt16LE(4)).toBe(1);
    expect(bytes.length).toBe(6 + 16 + 2);
  });
});
