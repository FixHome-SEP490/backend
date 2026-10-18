import { describe, expect, it } from 'vitest';
import { stripVideoLocation } from './video-location';

const box = (type: string, payload: Buffer) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
};

/** A minimal MP4: ftyp, a moov with an iPhone-style location key and a ©xyz atom, then media data. */
function phoneVideo(mediaData: Buffer) {
  const xyz = box('©xyz', Buffer.concat([Buffer.from([0, 18, 0x15, 0xc7]), Buffer.from('+10.7769+106.7009/', 'latin1')]));
  const keys = box('keys', Buffer.from('com.apple.quicktime.location.ISO6709', 'latin1'));
  const ilst = box('ilst', Buffer.from('data....+10.7769+106.7009+005.123/', 'latin1'));
  const moov = box('moov', Buffer.concat([box('mvhd', Buffer.alloc(20)), box('udta', Buffer.concat([xyz, box('meta', Buffer.concat([keys, ilst]))]))]));
  return Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0', 'latin1')), moov, box('mdat', mediaData)]);
}

describe('stripVideoLocation', () => {
  it('blanks every location stamp in the metadata, keeping the length of the file and of every box', () => {
    // Media data that happens to contain the same text must not be touched.
    const mediaData = Buffer.from('frames +10.7769+106.7009/ frames', 'latin1');
    const file = phoneVideo(mediaData);
    const before = Buffer.from(file);
    expect(stripVideoLocation(file)).toBe(2);
    expect(file.length).toBe(before.length);
    const text = file.toString('latin1');
    const metadata = text.slice(0, text.indexOf('mdat'));
    expect(metadata).not.toContain('+10.7769+106.7009/');
    expect(metadata).not.toContain('+10.7769+106.7009+005.123/');
    expect(text).toContain('+00.0000+000.0000/');
    expect(text).toContain('+00.0000+000.0000+000.000/');
    // Everything but the digits of the two stamps is unchanged, including the media data.
    const beforeText = before.toString('latin1');
    const cut = beforeText.indexOf('mdat');
    const expected = beforeText.slice(0, cut).replace('+10.7769+106.7009/', '+00.0000+000.0000/').replace('+10.7769+106.7009+005.123/', '+00.0000+000.0000+000.000/') + beforeText.slice(cut);
    expect(text).toBe(expected);
    expect(file.subarray(file.length - mediaData.length).toString('latin1')).toBe(mediaData.toString('latin1'));
  });

  it('leaves a video without a stamp, a WebM file and a broken file alone', () => {
    const plain = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0', 'latin1')), box('moov', box('mvhd', Buffer.alloc(20)))]);
    const copy = Buffer.from(plain);
    expect(stripVideoLocation(plain)).toBe(0);
    expect(plain.equals(copy)).toBe(true);
    const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(stripVideoLocation(webm)).toBe(0);
    const truncated = phoneVideo(Buffer.from('x')).subarray(0, 30);
    expect(() => stripVideoLocation(Buffer.from(truncated))).not.toThrow();
  });

  // Review 18/10/2026: XMP beside moov, and a moov after a box the parser cannot read.
  it('blanks XMP GPS values beside the metadata, and still finds a stamp after a broken box', () => {
    const xmp = '<x:xmpmeta><rdf:Description exif:GPSLatitude="10,46.614N" exif:GPSLongitude="106,42.054E"><exif:GPSAltitude>5/1</exif:GPSAltitude></rdf:Description></x:xmpmeta>';
    const file = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0', 'latin1')), box('uuid', Buffer.from('BE7ACFCB97A942E89C71999491E3AFAC' + xmp, 'latin1')), box('mdat', Buffer.alloc(32, 1))]);
    const length = file.length;
    expect(stripVideoLocation(file)).toBe(3);
    const text = file.toString('latin1');
    expect(file.length).toBe(length);
    expect(text).toContain('exif:GPSLatitude="00,00.000N"');
    expect(text).toContain('exif:GPSLongitude="000,00.000E"');
    expect(text).toContain('<exif:GPSAltitude>0/0<');

    const broken = Buffer.concat([
      box('ftyp', Buffer.from('isom\0\0\0\0', 'latin1')),
      Buffer.from([0, 0, 0, 3]), Buffer.from('junk', 'latin1'),
      box('moov', box('udta', box('©xyz', Buffer.from('+10.7769+106.7009/', 'latin1')))),
    ]);
    expect(stripVideoLocation(broken)).toBe(1);
    expect(broken.toString('latin1')).not.toContain('+10.7769+106.7009/');
  });

  it('finds the metadata after the media data too (files not prepared for streaming)', () => {
    const moov = box('moov', box('udta', box('©xyz', Buffer.from('-33.8688+151.2093/', 'latin1'))));
    const file = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0', 'latin1')), box('mdat', Buffer.alloc(64, 7)), moov]);
    expect(stripVideoLocation(file)).toBe(1);
    expect(file.toString('latin1')).toContain('-00.0000+000.0000/');
  });
});
