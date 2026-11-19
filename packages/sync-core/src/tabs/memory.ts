import type { TabCoordinator, TabMessage } from './coordinator';

interface Member {
  onLeaderChange: (isLeader: boolean) => void;
  onMessage: (m: TabMessage) => void;
  candidate: boolean;
}

export interface MemoryTab extends TabCoordinator {
  kill(): void;
}

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
        member = { onLeaderChange, onMessage, candidate: true };
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
      resign: () => {
        if (!member) return;
        member.candidate = false;
        this.elect();
      },
      close: leave,
      kill: leave,
    };
  }

  private elect(): void {
    const next = this.members.find((m) => m.candidate);
    if (next === this.leader) return;
    this.leader = next;
    if (next) queueMicrotask(() => this.members.includes(next) && next.onLeaderChange(true));
  }
}
