import type { TabCoordinator, TabMessage } from './coordinator';

interface Member {
  onLeaderChange: (isLeader: boolean) => void;
  onMessage: (m: TabMessage) => void;
}

export interface MemoryTab extends TabCoordinator {
  /** The tab dies: like `close()` for the others (the lock is freed), but nothing is said or delivered again. */
  kill(): void;
}

/**
 * In-process twin of Web Locks + BroadcastChannel for tests and the simulator: the earliest started tab that is
 * still alive leads; messages are delivered asynchronously to every other live tab.
 */
export class MemoryTabHub {
  private readonly members: Member[] = [];
  private leader?: Member;

  join(): MemoryTab {
    let member: Member | undefined;
    const leave = () => {
      if (!member) return;
      const index = this.members.indexOf(member);
      if (index >= 0) this.members.splice(index, 1);
      member = undefined;
      this.elect();
    };
    return {
      start: (onLeaderChange, onMessage) => {
        if (member) return;
        member = { onLeaderChange, onMessage };
        this.members.push(member);
        this.elect();
      },
      post: (m) => {
        const sender = member;
        if (!sender) return;
        for (const other of this.members) {
          if (other !== sender) queueMicrotask(() => this.members.includes(other) && other.onMessage(m));
        }
      },
      close: leave,
      kill: leave,
    };
  }

  private elect(): void {
    const next = this.members[0];
    if (next === this.leader) return;
    this.leader = next;
    if (next) queueMicrotask(() => this.members.includes(next) && next.onLeaderChange(true));
  }
}
