interface WakeEntry { requested: number; drained: number; drain: () => Promise<void>; work: Promise<void> }

/** In-memory wake coalescing only; durable wait/continuation records, not this map, remain the source of truth after restart. */
export class RunWakeCoordinator {
  private readonly entries = new Map<string, WakeEntry>();

  /** Every wake during a drain requests another pass. The caller must drain all eligible committed replies for this root run. */
  wake(runId: string, drain: () => Promise<void>): Promise<void> {
    const existing = this.entries.get(runId);
    if (existing) { existing.requested++; return existing.work; }
    const entry: WakeEntry = { requested: 1, drained: 0, drain, work: Promise.resolve() };
    this.entries.set(runId, entry);
    entry.work = Promise.resolve().then(async () => {
      try {
        while (entry.drained !== entry.requested) {
          const revision = entry.requested;
          await entry.drain();
          entry.drained = revision;
        }
      } finally {
        // There is no await between the last dirty check and unregistering: a later wake must create a new worker.
        // Failure does not automatically repeat a drain that may have dispatched a paid or externally visible operation.
        if (this.entries.get(runId) === entry) this.entries.delete(runId);
      }
    });
    return entry.work;
  }

  /** Used by orderly shutdown/tests; safe human waits must already have been persisted without a live worker. */
  async idle(): Promise<void> {
    while (this.entries.size) await Promise.allSettled([...this.entries.values()].map(entry => entry.work));
  }
}
