// Runs in the AudioWorkletGlobalScope. Streams raw mono sample blocks to the main thread
// (decoders subscribe via AudioEngine.onSamples). No allocation beyond the transferred copy.
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void

class Tap extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0]
    if (ch) {
      const copy = ch.slice()
      this.port.postMessage(copy, [copy.buffer])
    }
    return true
  }
}
registerProcessor('tap', Tap)
