/**
 * Typed pub/sub bus. Modules talk to each other (and to core) only through topics.
 * Add topics from a module with declaration merging:
 *
 *   declare module '../../core/bus' {
 *     interface BusTopics { 'mymod:event': { value: number } }
 *   }
 */
export interface BusTopics {
  'audio:state': { running: boolean }
  /** The user switched a module on or off in the Modules column. */
  'module:active': { id: string; active: boolean }
  /** User picked a frequency on a view (click). */
  'view:pick': { hz: number }
  /** Ask views to centre/highlight a frequency. */
  'view:focus': { hz: number }
  /** Add or update a labelled frequency marker on views. */
  'marker:set': { id: string; hz: number; label?: string; color?: string; /** band width in Hz, drawn as a shaded band */ bw?: number; /** draw emphasised (thicker line, stronger band): hover, selection */ strong?: boolean }
  'marker:clear': { id: string }
  /** The transmit lock changed hands: `owner` is the module id that is transmitting, or null when idle. */
  'tx:state': { owner: string | null }
  /** A decoder produced a message; log panes can show it. */
  'message:rx': { source: string; text: string; time: number; hz?: number }
}

type Handler<T> = (payload: T) => void

export class Bus {
  private handlers = new Map<string, Set<Handler<never>>>()

  on<K extends keyof BusTopics>(topic: K, fn: Handler<BusTopics[K]>): () => void {
    let set = this.handlers.get(topic)
    if (!set) this.handlers.set(topic, (set = new Set()))
    set.add(fn as Handler<never>)
    return () => set!.delete(fn as Handler<never>)
  }

  emit<K extends keyof BusTopics>(topic: K, payload: BusTopics[K]): void {
    this.handlers.get(topic)?.forEach((fn) => (fn as Handler<BusTopics[K]>)(payload))
  }
}
