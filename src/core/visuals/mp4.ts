/**
 * Minimal MP4 writer for ONE H.264 video track (what WebCodecs' VideoEncoder gives us). No audio, no B-frames
 * (a sample's decode time is its presentation time), everything held in memory and written "fast start" (moov before mdat).
 * Small on purpose: this feature needs nothing else, so no muxer package is added to the app.
 */
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const u16 = (n: number) => new Uint8Array([(n >>> 8) & 255, n & 255]);
const fourcc = (s: string) => new Uint8Array([s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)]);
const zeros = (n: number) => new Uint8Array(n);

function cat(...parts: Uint8Array[]): Uint8Array {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
/** an MP4 box: 32-bit size, 4-letter type, payload */
const box = (type: string, ...payload: Uint8Array[]) => { const body = cat(...payload); return cat(u32(8 + body.length), fourcc(type), body); };
/** a "full box": version 0 + 24-bit flags before the payload */
const full = (type: string, flags: number, ...payload: Uint8Array[]) => box(type, u32(flags & 0xffffff), ...payload);

const MATRIX = cat(u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000));
export const MP4_TIMESCALE = 90000;

interface Sample { data: Uint8Array; ts: number; dur: number; key: boolean }

export class Mp4Writer {
  private samples: Sample[] = [];
  private description: Uint8Array | null = null;
  constructor(private width: number, private height: number) {}

  /** the avcC record (AVCDecoderConfigurationRecord) that WebCodecs hands over with the first chunk */
  setDescription(d: Uint8Array) { this.description = d.slice(); }
  get hasDescription() { return !!this.description; }
  get count() { return this.samples.length; }

  /** `tsUs` and `durUs` in microseconds, as in an EncodedVideoChunk. Timestamps must go up. */
  addSample(data: Uint8Array, tsUs: number, durUs: number, key: boolean) {
    const last = this.samples[this.samples.length - 1];
    const ts = Math.round((tsUs * MP4_TIMESCALE) / 1e6);
    if (last && ts <= last.ts) throw new Error('frames came out of order (the encoder reordered them)');
    if (last) last.dur = ts - last.ts; // exact: each sample lasts until the next one starts
    this.samples.push({ data: data.slice(), ts, dur: Math.max(1, Math.round((durUs * MP4_TIMESCALE) / 1e6)), key });
  }

  /** total length of the track in ms */
  get durationMs() { const l = this.samples[this.samples.length - 1]; return l ? Math.round(((l.ts + l.dur) * 1000) / MP4_TIMESCALE) : 0; }

  finish(): Blob {
    if (!this.description) throw new Error('no H.264 configuration from the encoder');
    if (!this.samples.length) throw new Error('no frames were encoded');
    const first = this.samples[0]!.ts; // start the track at 0
    for (const s of this.samples) s.ts -= first;
    const ftyp = box('ftyp', fourcc('isom'), u32(512), fourcc('isom'), fourcc('iso2'), fourcc('avc1'), fourcc('mp41'));
    const mdatSize = this.samples.reduce((n, s) => n + s.data.length, 0);
    const moovFor = (mdatStart: number) => this.moov(mdatStart);
    const probe = moovFor(0);
    const moov = moovFor(ftyp.length + probe.length + 8); // moov has fixed-size entries, so its length does not change with the offset
    const mdatHead = cat(u32(8 + mdatSize), fourcc('mdat'));
    return new Blob([ftyp, moov, mdatHead, ...this.samples.map(s => s.data)] as BlobPart[], { type: 'video/mp4' });
  }

  private moov(chunkOffset: number): Uint8Array {
    const S = this.samples, n = S.length, last = S[n - 1]!, trackDur = last.ts + last.dur, movieDur = Math.round((trackDur * 1000) / MP4_TIMESCALE);
    const now = Math.floor(Date.now() / 1000) + 2082844800 >>> 0;
    const mvhd = full('mvhd', 0, u32(now), u32(now), u32(1000), u32(movieDur), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(2));
    const tkhd = full('tkhd', 3, u32(now), u32(now), u32(1), zeros(4), u32(movieDur), zeros(8), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(this.width << 16), u32(this.height << 16));
    const mdhd = full('mdhd', 0, u32(now), u32(now), u32(MP4_TIMESCALE), u32(trackDur), u16(0x55c4), u16(0));
    const hdlr = full('hdlr', 0, zeros(4), fourcc('vide'), zeros(12), new TextEncoder().encode('VideoHandler\0'));
    const vmhd = full('vmhd', 1, u16(0), u16(0), u16(0), u16(0));
    const dinf = box('dinf', full('dref', 0, u32(1), full('url ', 1)));
    const avc1 = box('avc1', zeros(6), u16(1), zeros(16), u16(this.width), u16(this.height), u32(0x00480000), u32(0x00480000), zeros(4), u16(1), zeros(32), u16(0x0018), u16(0xffff), box('avcC', this.description!));
    const stsd = full('stsd', 0, u32(1), avc1);
    // stts: run-length of sample durations
    const runs: [number, number][] = [];
    for (const s of S) { const r = runs[runs.length - 1]; if (r && r[1] === s.dur) r[0]++; else runs.push([1, s.dur]); }
    const stts = full('stts', 0, u32(runs.length), ...runs.map(([c, d]) => cat(u32(c), u32(d))));
    const keys = S.map((s, i) => (s.key ? i + 1 : 0)).filter(Boolean);
    const stss = full('stss', 0, u32(keys.length), ...keys.map(u32));
    const stsc = full('stsc', 0, u32(1), u32(1), u32(n), u32(1)); // every sample in one chunk
    const stsz = full('stsz', 0, u32(0), u32(n), ...S.map(s => u32(s.data.length)));
    const stco = full('stco', 0, u32(1), u32(chunkOffset));
    const stbl = box('stbl', stsd, stts, stss, stsc, stsz, stco);
    const minf = box('minf', vmhd, dinf, stbl);
    const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
    return box('moov', mvhd, trak);
  }
}
