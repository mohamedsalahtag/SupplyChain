import { describe, expect, it } from 'vitest';
import { ALLOWED_TYPES, assertContentMatches } from './attachments.js';

const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0]);
const SAMPLES: Record<string, Buffer> = {
  '.pdf': Buffer.from('%PDF-1.7\n'),
  '.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]),
  '.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  '.jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
  '.gif': Buffer.from('GIF89a..'),
  '.webp': Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPVP8 ')]),
  '.xlsx': ZIP,
  '.docx': ZIP,
  '.xls': OLE,
  '.doc': OLE,
  '.msg': OLE,
  '.csv': Buffer.from('a;b\n1;2\n'),
  '.eml': Buffer.from('From: a@b.c\r\nSubject: x\r\n\r\nhi'),
};

describe('attachment content must match its type (F10)', () => {
  it('every allowed type has a check that accepts a real file', () => {
    for (const ext of Object.keys(ALLOWED_TYPES)) expect(() => assertContentMatches(`f${ext}`, SAMPLES[ext])).not.toThrow();
  });
  it('refuses a renamed executable, whatever it is called', () => {
    const exe = Buffer.from('MZ\x90\x00\x03\x00\x00\x00');
    for (const ext of Object.keys(ALLOWED_TYPES)) expect(() => assertContentMatches(`quote${ext}`, exe), ext).toThrow(/not a real/);
  });
  it('accepts UTF-16 text (Excel "Unicode text" CSV) but not other binary content as CSV', () => {
    expect(() => assertContentMatches('a.csv', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a,b', 'utf16le')]))).not.toThrow();
    expect(() => assertContentMatches('a.csv', ZIP)).toThrow();
  });
});
