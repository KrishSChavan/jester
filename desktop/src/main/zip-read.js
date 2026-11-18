/**
 * Reading files out of a .zip, as Claude and ChatGPT give their exports: the list of what's in it, and any one file
 * whole. Only the parts asked for are read off the disk, so a ChatGPT export of a few gigabytes of pictures costs no
 * more than its conversations. Stored and deflated files (all that zip tools make today), and zip64's large sizes.
 */

import nodeFs from 'node:fs';
import zlib from 'node:zlib';

const END = 0x06054b50;
const END64 = 0x06064b50;
const END64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** The end record and the longest comment it can have. */
const TAIL = 22 + 0xffff;

const bad = (why) => Object.assign(new Error(`That isn’t a zip Jester can read: ${why}.`), { code: 'bad_zip' });

/** `length` bytes at `at`: all of them, or it throws. */
function readAt(fs, fd, at, length) {
  const buffer = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buffer, got, length - got, at + got);
    if (!n) throw bad('it ends early');
    got += n;
  }
  return buffer;
}

/** A 64-bit size or offset, which is a safe JavaScript number in any zip that fits on a disk. */
const big = (buffer, at) => Number(buffer.readBigUInt64LE(at));

/**
 * The zip at `file`, opened: its files' names, and a way to read each.
 * @param {string} file
 * @param {{fs?: typeof nodeFs}} [options]
 * @returns {{names: string[], size: (name:string) => number, read: (name:string) => Buffer, close: () => void}}
 */
export function openZip(file, { fs = nodeFs } = {}) {
  const fd = fs.openSync(file, 'r');
  try {
    const length = fs.fstatSync(fd).size;
    const tailAt = Math.max(0, length - TAIL);
    const tail = readAt(fs, fd, tailAt, length - tailAt);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === END) {
        end = i;
        break;
      }
    }
    if (end < 0) throw bad('its list of files is missing');
    let count = tail.readUInt16LE(end + 10);
    let listSize = tail.readUInt32LE(end + 12);
    let listAt = tail.readUInt32LE(end + 16);
    // Zip64: the real figures are in a record of their own, which a locator just before the end record points to.
    if (end >= 20 && tail.readUInt32LE(end - 20) === END64_LOCATOR) {
      const recordAt = big(tail, end - 20 + 8);
      const record = readAt(fs, fd, recordAt, 56);
      if (record.readUInt32LE(0) !== END64) throw bad('its zip64 record is missing');
      count = big(record, 32);
      listSize = big(record, 40);
      listAt = big(record, 48);
    }
    if (listAt + listSize > length) throw bad('its list of files points past its end');
    const list = readAt(fs, fd, listAt, listSize);
    const entries = new Map();
    let at = 0;
    for (let i = 0; i < count; i++) {
      if (list.readUInt32LE(at) !== CENTRAL) throw bad('its list of files is damaged');
      const flags = list.readUInt16LE(at + 8);
      const method = list.readUInt16LE(at + 10);
      let packed = list.readUInt32LE(at + 20);
      let size = list.readUInt32LE(at + 24);
      const nameLength = list.readUInt16LE(at + 28);
      const extraLength = list.readUInt16LE(at + 30);
      const commentLength = list.readUInt16LE(at + 32);
      let localAt = list.readUInt32LE(at + 42);
      const nameBytes = list.subarray(at + 46, at + 46 + nameLength);
      // Bit 11: the name is UTF-8. Without it, it's the old DOS code page, which for the ASCII names exports use is the same.
      const name = nameBytes.toString(flags & 0x800 ? 'utf8' : 'latin1');
      // Zip64's extra field holds whichever of the three figures didn't fit, in this order.
      let extra = at + 46 + nameLength;
      const extraEnd = extra + extraLength;
      while (extra + 4 <= extraEnd) {
        const id = list.readUInt16LE(extra);
        const fieldLength = list.readUInt16LE(extra + 2);
        if (id === 0x0001) {
          let field = extra + 4;
          if (size === 0xffffffff) {
            size = big(list, field);
            field += 8;
          }
          if (packed === 0xffffffff) {
            packed = big(list, field);
            field += 8;
          }
          if (localAt === 0xffffffff) localAt = big(list, field);
        }
        extra += 4 + fieldLength;
      }
      if (!name.endsWith('/')) entries.set(name, { flags, method, packed, size, localAt });
      at += 46 + nameLength + extraLength + commentLength;
    }
    const entryOf = (name) => {
      const entry = entries.get(name);
      if (!entry) throw Object.assign(new Error(`There’s no “${name}” in that zip.`), { code: 'ENOENT' });
      return entry;
    };
    return {
      names: [...entries.keys()],
      size: (name) => entryOf(name).size,
      read(name) {
        const entry = entryOf(name);
        if (entry.flags & 0x1) throw bad(`“${name}” in it is locked with a password`);
        // The local header's own name and extra lengths can differ from the list's: the data starts after its own.
        const local = readAt(fs, fd, entry.localAt, 30);
        if (local.readUInt32LE(0) !== LOCAL) throw bad(`“${name}” in it is damaged`);
        const dataAt = entry.localAt + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
        const packed = readAt(fs, fd, dataAt, entry.packed);
        if (entry.method === 0) return packed;
        if (entry.method === 8) return zlib.inflateRawSync(packed, { maxOutputLength: Math.max(entry.size, 1) });
        throw bad(`“${name}” in it is packed a way Jester doesn’t know (method ${entry.method})`);
      },
      close: () => fs.closeSync(fd)
    };
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
}
