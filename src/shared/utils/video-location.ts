/**
 * Phones write where a video was shot into its metadata (QuickTime `©xyz`, the
 * `com.apple.quicktime.location.ISO6709` key, Android's `©xyz`), as an ISO 6709
 * string such as `+10.7769+106.7009+005.000/`, and cameras or editors may add an
 * XMP packet with `exif:GPSLatitude`/`exif:GPSLongitude`. A technician sees the
 * video before accepting the job, when the address must stay hidden (PO
 * 18/10/2026), so the coordinates are blanked before the file is stored.
 *
 * Every top-level box except the media data (`mdat`) is searched: `moov`, and
 * also `uuid` (XMP), `meta`, `free` or `skip` that sit beside it. If the box
 * layout breaks off, the rest of the file is searched as well rather than
 * assumed clean. Each coordinate is overwritten with zeros of the same length,
 * so every box size and offset stays valid and the file plays exactly as before.
 *
 * Not covered: location recorded as a timed track inside the media data
 * (action cameras' GPMF, dashcams, drones); phones do not do that.
 */

/** ISO 6709 point: latitude, longitude, optional altitude, optional CRS, ending in a slash. */
const ISO6709 = /[+-]\d{2}(?:\.\d+)?[+-]\d{3}(?:\.\d+)?(?:[+-]\d+(?:\.\d+)?)?(?:CRS[A-Za-z0-9_:]*)?\//g;
/** An XMP GPS value, as an attribute (`exif:GPSLatitude="10,46.614N"`) or an element (`<exif:GPSLatitude>…<`). */
const XMP_GPS = /GPS(?:Dest)?(?:Latitude|Longitude|Altitude)\s*(?:=\s*["']|>)([^"'<]{1,64})/g;

/** Top-level boxes of an ISO-BMFF (MP4, MOV) file, and where the layout broke off if it did. */
function topLevelBoxes(buffer: Buffer): { boxes: Array<[string, number, number]>; brokenAt: number | null } {
  const boxes: Array<[string, number, number]> = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > buffer.length) return { boxes, brokenAt: offset };
      const large = buffer.readBigUInt64BE(offset + 8);
      if (large > BigInt(buffer.length - offset)) return { boxes, brokenAt: offset };
      size = Number(large);
      header = 16;
    } else if (size === 0) {
      size = buffer.length - offset;
    }
    if (size < header || offset + size > buffer.length) return { boxes, brokenAt: offset };
    boxes.push([type, offset, offset + size]);
    offset += size;
  }
  return { boxes, brokenAt: offset < buffer.length ? offset : null };
}

/** Blanks the digits of every location found in buffer[start, end), in place. */
function blank(buffer: Buffer, start: number, end: number): number {
  const text = buffer.toString('latin1', start, end);
  let replaced = 0;
  for (const match of text.matchAll(ISO6709)) {
    buffer.write(match[0].replace(/\d/g, '0'), start + (match.index ?? 0), 'latin1');
    replaced += 1;
  }
  for (const match of text.matchAll(XMP_GPS)) {
    const value = match[1];
    if (!/\d/.test(value)) continue;
    const at = start + (match.index ?? 0) + match[0].length - value.length;
    buffer.write(value.replace(/\d/g, '0'), at, 'latin1');
    replaced += 1;
  }
  return replaced;
}

/** Blanks every location stamp in the metadata of an MP4 or MOV file, in place. Returns how many were found. */
export function stripVideoLocation(buffer: Buffer): number {
  const { boxes, brokenAt } = topLevelBoxes(buffer);
  // A WebM or other non-box file has no top-level boxes to trust: it is left as it is.
  if (!boxes.length) return 0;
  let replaced = 0;
  for (const [type, start, end] of boxes) {
    if (type !== 'mdat') replaced += blank(buffer, start, end);
  }
  if (brokenAt !== null) replaced += blank(buffer, brokenAt, buffer.length);
  return replaced;
}
