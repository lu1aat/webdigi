/** Minimal WAV reader/writer: PCM 8/16/24/32-bit and IEEE float32, any channel count. */

export interface WavData {
  sampleRate: number;
  /** One Float32Array per channel, samples in -1..1. */
  channels: Float32Array[];
}

export function parseWav(buf: Uint8Array): WavData {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (buf.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let dataOff = -1;
  let dataLen = 0;
  for (let o = 12; o + 8 <= buf.byteLength; ) {
    const id = tag(o);
    const size = dv.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ') {
      let format = dv.getUint16(body, true);
      if (format === 0xfffe && size >= 26) format = dv.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE
      fmt = {
        format,
        channels: dv.getUint16(body + 2, true),
        rate: dv.getUint32(body + 4, true),
        bits: dv.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      dataOff = body;
      dataLen = Math.min(size, buf.byteLength - body);
      break;
    }
    o = body + size + (size & 1);
  }
  if (!fmt || dataOff < 0) throw new Error('WAV is missing fmt or data chunk');
  const bytes = fmt.bits / 8;
  const frames = Math.floor(dataLen / (bytes * fmt.channels));
  const channels = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.channels; c++) {
      const o = dataOff + (i * fmt.channels + c) * bytes;
      let v: number;
      if (fmt.format === 3 && fmt.bits === 32) v = dv.getFloat32(o, true);
      else if (fmt.format === 1 && fmt.bits === 16) v = dv.getInt16(o, true) / 32768;
      else if (fmt.format === 1 && fmt.bits === 8) v = (buf[o] - 128) / 128;
      else if (fmt.format === 1 && fmt.bits === 24) v = ((dv.getInt32(o - 1, true) >> 8)) / 8388608;
      else if (fmt.format === 1 && fmt.bits === 32) v = dv.getInt32(o, true) / 2147483648;
      else throw new Error(`unsupported WAV format ${fmt.format} / ${fmt.bits} bit`);
      channels[c][i] = v;
    }
  }
  return { sampleRate: fmt.rate, channels };
}

/** 16-bit PCM encoder. Clips at full scale. */
export function encodeWav16(wav: WavData): Uint8Array {
  const ch = wav.channels.length;
  const frames = wav.channels[0].length;
  const out = new Uint8Array(44 + frames * ch * 2);
  const dv = new DataView(out.buffer);
  const put = (o: number, s: string) => [...s].forEach((c, i) => (out[o + i] = c.charCodeAt(0)));
  put(0, 'RIFF'); dv.setUint32(4, out.length - 8, true); put(8, 'WAVE');
  put(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, ch, true); dv.setUint32(24, wav.sampleRate, true);
  dv.setUint32(28, wav.sampleRate * ch * 2, true); dv.setUint16(32, ch * 2, true);
  dv.setUint16(34, 16, true);
  put(36, 'data'); dv.setUint32(40, frames * ch * 2, true);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, wav.channels[c][i]));
      dv.setInt16(44 + (i * ch + c) * 2, Math.round(s * 32767), true);
    }
  }
  return out;
}
