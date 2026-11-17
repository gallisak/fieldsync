import { WholeStateStorage, type WholeState } from './whole-state-storage';

/** In-memory storage. State is deep-copied in and out, so callers cannot change it through shared references. */
export class MemoryStorage extends WholeStateStorage {
  private state: WholeState | undefined;

  protected read(): WholeState | undefined {
    return this.state && structuredClone(this.state);
  }

  protected write(state: WholeState): void {
    this.state = structuredClone(state);
  }
}
