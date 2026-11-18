import { WholeStateStorage, type WholeState } from './whole-state-storage';

export class MemoryStorage extends WholeStateStorage {
  private state: WholeState | undefined;

  protected read(): WholeState | undefined {
    return this.state && structuredClone(this.state);
  }

  protected write(state: WholeState): void {
    this.state = structuredClone(state);
  }
}
