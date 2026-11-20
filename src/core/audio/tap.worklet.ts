// Runs in the AudioWorkletGlobalScope. Streams raw mono sample blocks to the main thread
// (decoders subscribe via AudioEngine.onSamples). The audio thread delivers 128 samples per call;
// they are gathered into BATCH-sample blocks so the main thread gets ~47 messages/s instead of ~375.
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void

const BATCH = 1024

class Tap extends AudioWorkletProcessor {
  private buf = new Float32Array(BATCH)
  private fill = 0

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0]
    if (ch) {
      let i = 0
      while (i < ch.length) {
        const n = Math.min(ch.length - i, BATCH - this.fill)
        this.buf.set(ch.subarray(i, i + n), this.fill)
        this.fill += n
        i += n
        if (this.fill === BATCH) {
          // One allocation per posted block: the buffer is transferred, so a fresh one is needed.
          this.port.postMessage(this.buf, [this.buf.buffer])
          this.buf = new Float32Array(BATCH)
          this.fill = 0
        }
      }
    }
    return true
  }
}
registerProcessor('tap', Tap)
