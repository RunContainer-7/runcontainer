// Reading the icon an executable actually carries.
//
// RunContainer used to ask .NET for the icon (`Icon.ExtractAssociatedIcon`),
// which only ever returns one 32x32 image and returns nothing at all for many
// real installers and tools. Windows Explorer does not work that way: it reads the
// PE resource directory itself and takes every size the file declares, including
// the 256x256 PNG-compressed frame Vista and later allow. That is the difference
// between "the list shows the app's icon" and "the list shows a letter".
//
// This module parses the resource directory directly, rebuilds a genuine .ico file
// (ICO is just a small index plus the images verbatim) and hands it to the renderer,
// whose CSP already allows data: images and which decodes image/x-icon natively.
//
// Nothing here executes anything or writes to the source executable: the file is
// opened read-only, and only the extracted icon is written.

const fs = require('fs');
const path = require('path');

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const RESOURCE_DIRECTORY_SIZE = 16;
const RESOURCE_ENTRY_SIZE = 8;
const GROUP_ICON_ENTRY_SIZE = 14;
const ICO_DIRECTORY_SIZE = 6;
const ICO_ENTRY_SIZE = 16;

function readUInt32(buffer, offset) {
  return offset + 4 <= buffer.length ? buffer.readUInt32LE(offset) : null;
}

function readUInt16(buffer, offset) {
  return offset + 2 <= buffer.length ? buffer.readUInt16LE(offset) : null;
}

// The PE headers, reduced to what a resource lookup needs: where the resource
// directory is in the file, and how to translate an RVA into a file offset.
function readPeHeaders(buffer) {
  if (!buffer || buffer.length < 0x40) return null;
  if (buffer.readUInt16LE(0) !== 0x5a4d) return null; // 'MZ'
  const peOffset = readUInt32(buffer, 0x3c);
  if (peOffset === null || peOffset + 24 > buffer.length) return null;
  if (buffer.readUInt32LE(peOffset) !== 0x00004550) return null; // 'PE\0\0'
  const sectionCount = readUInt16(buffer, peOffset + 6);
  const optionalHeaderSize = readUInt16(buffer, peOffset + 20);
  const optionalOffset = peOffset + 24;
  const magic = readUInt16(buffer, optionalOffset);
  if (magic !== 0x10b && magic !== 0x20b) return null;
  // The data directory sits at a different offset in PE32 and PE32+ images.
  const dataDirectoryOffset = optionalOffset + (magic === 0x20b ? 112 : 96);
  const resourceRva = readUInt32(buffer, dataDirectoryOffset + 8 * 2);
  const resourceSize = readUInt32(buffer, dataDirectoryOffset + 8 * 2 + 4);
  if (!resourceRva || !resourceSize) return null;
  const sectionsOffset = optionalOffset + optionalHeaderSize;
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const entry = sectionsOffset + index * 40;
    if (entry + 40 > buffer.length) break;
    sections.push({
      virtualAddress: readUInt32(buffer, entry + 12),
      virtualSize: readUInt32(buffer, entry + 8),
      rawSize: readUInt32(buffer, entry + 16),
      rawPointer: readUInt32(buffer, entry + 20),
    });
  }
  const toOffset = (rva) => {
    for (const section of sections) {
      const size = Math.max(section.virtualSize || 0, section.rawSize || 0);
      if (rva >= section.virtualAddress && rva < section.virtualAddress + size) {
        const offset = (section.rawPointer || 0) + (rva - section.virtualAddress);
        return offset < buffer.length ? offset : null;
      }
    }
    // An image whose sections do not cover its own resource RVA is malformed.
    return null;
  };
  return { resourceRva, resourceSize, toOffset };
}

function readResourceDirectoryEntries(buffer, base, directoryOffset) {
  const count = readUInt16(buffer, directoryOffset + 12);
  const named = readUInt16(buffer, directoryOffset + 14);
  const total = (count || 0) + (named || 0);
  const entries = [];
  for (let index = 0; index < total; index += 1) {
    const entryOffset = directoryOffset + RESOURCE_DIRECTORY_SIZE + index * RESOURCE_ENTRY_SIZE;
    const nameOrId = readUInt32(buffer, entryOffset);
    const target = readUInt32(buffer, entryOffset + 4);
    if (nameOrId === null || target === null) break;
    entries.push({
      // The high bit means "name string", which no icon resource uses: icon groups
      // and icon ids are always numeric.
      id: (nameOrId & 0x80000000) ? null : nameOrId,
      isDirectory: Boolean(target & 0x80000000),
      offset: target & 0x7fffffff,
      absolute: base + (target & 0x7fffffff),
    });
  }
  return entries;
}

// Walks type -> name -> language and returns the leaves for one resource type.
function collectResourceLeaves(buffer, headers, type) {
  const base = headers.toOffset(headers.resourceRva);
  if (base === null) return [];
  const leaves = [];
  for (const typeEntry of readResourceDirectoryEntries(buffer, base, base)) {
    if (typeEntry.id !== type) continue;
    if (!typeEntry.isDirectory) continue;
    for (const nameEntry of readResourceDirectoryEntries(buffer, base, typeEntry.absolute)) {
      if (!nameEntry.isDirectory) continue;
      for (const languageEntry of readResourceDirectoryEntries(buffer, base, nameEntry.absolute)) {
        if (languageEntry.isDirectory) continue;
        const dataEntryOffset = languageEntry.absolute;
        const dataRva = readUInt32(buffer, dataEntryOffset);
        const dataSize = readUInt32(buffer, dataEntryOffset + 4);
        if (!dataRva || !dataSize) continue;
        const fileOffset = headers.toOffset(dataRva);
        if (fileOffset === null || fileOffset + dataSize > buffer.length) continue;
        leaves.push({
          name: nameEntry.id,
          language: languageEntry.id,
          size: dataSize,
          data: buffer.subarray(fileOffset, fileOffset + dataSize),
        });
      }
    }
  }
  return leaves;
}

function parseGroupIcon(data) {
  const count = readUInt16(data, 4);
  if (!count) return null;
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const offset = ICO_DIRECTORY_SIZE + index * GROUP_ICON_ENTRY_SIZE;
    if (offset + GROUP_ICON_ENTRY_SIZE > data.length) break;
    entries.push({
      width: data.readUInt8(offset),
      height: data.readUInt8(offset + 1),
      colorCount: data.readUInt8(offset + 2),
      planes: readUInt16(data, offset + 4),
      bitCount: readUInt16(data, offset + 6),
      bytesInRes: readUInt32(data, offset + 8),
      id: readUInt16(data, offset + 12),
    });
  }
  return entries.length > 0 ? entries : null;
}

// The largest declared size wins, because that is the frame Explorer prefers. A
// width or height of 0 means 256 in the icon format.
function entryScore(entry) {
  const side = (entry.width === 0 ? 256 : entry.width) * (entry.height === 0 ? 256 : entry.height);
  return side * 1000 + (entry.bitCount || 0);
}

function buildIcoBytes(entries) {
  const header = Buffer.alloc(ICO_DIRECTORY_SIZE);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const directory = Buffer.alloc(ICO_ENTRY_SIZE * entries.length);
  let offset = ICO_DIRECTORY_SIZE + ICO_ENTRY_SIZE * entries.length;
  const images = [];
  entries.forEach((entry, index) => {
    const at = index * ICO_ENTRY_SIZE;
    directory.writeUInt8(entry.width === 256 ? 0 : entry.width, at);
    directory.writeUInt8(entry.height === 256 ? 0 : entry.height, at + 1);
    directory.writeUInt8(entry.colorCount || 0, at + 2);
    directory.writeUInt8(0, at + 3);
    directory.writeUInt16LE(entry.planes || 1, at + 4);
    directory.writeUInt16LE(entry.bitCount || 32, at + 6);
    directory.writeUInt32LE(entry.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
    images.push(entry.data);
  });
  return Buffer.concat([header, directory, ...images]);
}

function extractIconFromBuffer(buffer, { maxImages = 6 } = {}) {
  const headers = readPeHeaders(buffer);
  if (!headers) return null;
  const groups = collectResourceLeaves(buffer, headers, RT_GROUP_ICON);
  if (groups.length === 0) return null;
  const icons = collectResourceLeaves(buffer, headers, RT_ICON);
  if (icons.length === 0) return null;
  const iconById = new Map(icons.map((icon) => [icon.name, icon]));

  let best = null;
  for (const group of groups) {
    const entries = parseGroupIcon(group.data);
    if (!entries) continue;
    const resolved = entries
      .map((entry) => {
        const image = iconById.get(entry.id);
        if (!image) return null;
        // The image length in the group entry is a claim; the resource is the truth.
        return { ...entry, data: image.data };
      })
      .filter(Boolean)
      .sort((a, b) => entryScore(b) - entryScore(a));
    if (resolved.length === 0) continue;
    if (!best || entryScore(resolved[0]) > entryScore(best[0])) best = resolved;
  }
  if (!best) return null;
  // Duplicate frames (identical payload) waste space and add nothing.
  const unique = [];
  const seen = new Set();
  for (const entry of best) {
    const key = `${entry.width}x${entry.height}@${entry.bitCount}:${entry.data.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
    if (unique.length >= maxImages) break;
  }
  return { entries: unique, bytes: buildIcoBytes(unique) };
}

// Writes the executable's own icon next to the app and returns what it wrote.
function extractIconToFile(exePath, outputPath) {
  try {
    if (!exePath || !fs.existsSync(exePath)) return null;
    const buffer = fs.readFileSync(exePath);
    const extracted = extractIconFromBuffer(buffer);
    if (!extracted) return null;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, extracted.bytes);
    return {
      path: outputPath,
      sizes: extracted.entries.map((entry) => `${entry.width === 0 ? 256 : entry.width}x${entry.height === 0 ? 256 : entry.height}`),
      bytes: extracted.bytes.length,
    };
  } catch (error) {
    return null;
  }
}

module.exports = {
  RT_ICON,
  RT_GROUP_ICON,
  readPeHeaders,
  collectResourceLeaves,
  parseGroupIcon,
  entryScore,
  buildIcoBytes,
  extractIconFromBuffer,
  extractIconToFile,
};
