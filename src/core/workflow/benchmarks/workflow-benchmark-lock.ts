import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";

interface WorkflowLockOwner {
  version: 1;
  hostId: string;
  processId: number;
  token: string;
  acquiredAt: string;
}

/** Exclusive ownership of one Run's Workflow storage, shared by all benchmark chapters. */
export class WorkflowBenchmarkLock {
  private owner?: WorkflowLockOwner;
  private readonly reclaimPath: string;

  constructor(readonly path: string) {
    this.reclaimPath = `${path}.reclaim`;
  }

  acquire(): void {
    if (this.owner) {
      this.assertOwned();
      return;
    }
    const recoveryInProgress = (): never => {
      throw new Error(
        `Workflow stale-lock recovery guard already exists: ${this.reclaimPath}. `
        + "Another recovery may be active, or a prior recovery stopped before releasing it. "
        + "Retry after the active recovery finishes. If it remains, manually verify its "
        + "recorded host/process has stopped and no recovery is active before removing only this guard; "
        + `do not remove ${this.path} or any journal directory.`,
      );
    };
    try {
      lstatSync(this.reclaimPath);
      recoveryInProgress();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const owner: WorkflowLockOwner = {
      version: 1,
      hostId: hostname(),
      processId: process.pid,
      token: randomUUID(),
      acquiredAt: new Date().toISOString(),
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        this.publish(this.path, owner);
        this.owner = owner;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      let previous: WorkflowLockOwner;
      try {
        previous = this.readOwner(this.path);
      } catch (error) {
        // The owner may have released the lock after our exclusive link failed.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      this.assertDead(previous);

      // Serializing stale reclamation is essential: a second reclaimer must
      // never unlink the new owner installed by the first one. The guard itself
      // is never automatically reclaimed; uncertainty fails closed.
      try {
        this.publish(this.reclaimPath, owner);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        recoveryInProgress();
      }
      try {
        let current: WorkflowLockOwner | undefined;
        try {
          current = this.readOwner(this.path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (current) {
          if (current.token !== previous.token) {
            throw new Error(`Workflow root lock changed during stale recovery: ${this.path}; retry acquisition.`);
          }
          this.assertDead(current);
          unlinkSync(this.path);
        }
        try {
          this.publish(this.path, owner);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          throw new Error(`Another runtime acquired Workflow root ${this.path} during stale recovery; retry acquisition.`);
        }
        this.owner = owner;
      } finally {
        const guard = this.readOwner(this.reclaimPath);
        if (guard.token !== owner.token) {
          throw new Error(`Cannot release Workflow recovery guard owned by another runtime: ${this.reclaimPath}`);
        }
        unlinkSync(this.reclaimPath);
      }
      return;
    }
    throw new Error(`Workflow root ownership kept changing while acquiring ${this.path}; retry acquisition.`);
  }

  assertOwned(): void {
    if (!this.owner) throw new Error(`Workflow root lock must be acquired before mutation: ${this.path}`);
    const current = this.readOwner(this.path);
    if (current.token !== this.owner.token
      || current.hostId !== this.owner.hostId
      || current.processId !== this.owner.processId) {
      throw new Error(`Workflow root lock is no longer owned by this runtime: ${this.path}`);
    }
  }

  release(): void {
    if (!this.owner) return;
    this.assertOwned();
    unlinkSync(this.path);
    this.owner = undefined;
  }

  private assertDead(owner: WorkflowLockOwner): void {
    if (owner.hostId !== hostname()) {
      throw new Error(`Workflow root ${this.path} is locked by host ${owner.hostId} process ${owner.processId}; refusing remote-owner recovery.`);
    }
    try {
      process.kill(owner.processId, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      if ((error as NodeJS.ErrnoException).code !== "EPERM") {
        throw new Error(`Cannot establish whether Workflow root owner ${owner.processId} has stopped: ${this.path}`, { cause: error });
      }
    }
    throw new Error(`Workflow root ${this.path} is already attached to process ${owner.processId} on host ${owner.hostId}.`);
  }

  private readOwner(path: string): WorkflowLockOwner {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Workflow lock must be a regular file; refusing automatic recovery: ${path}`);
    }
    let owner: unknown;
    try {
      owner = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
      throw new Error(`Invalid Workflow lock owner; refusing automatic recovery: ${path}`, { cause: error });
    }
    if (typeof owner !== "object" || owner === null
      || !("version" in owner) || owner.version !== 1
      || !("hostId" in owner) || typeof owner.hostId !== "string" || owner.hostId.length === 0
      || !("processId" in owner) || !Number.isSafeInteger(owner.processId) || Number(owner.processId) <= 0
      || !("token" in owner) || typeof owner.token !== "string" || owner.token.length === 0
      || !("acquiredAt" in owner) || typeof owner.acquiredAt !== "string" || !Number.isFinite(Date.parse(owner.acquiredAt))) {
      throw new Error(`Invalid Workflow lock owner; refusing automatic recovery: ${path}`);
    }
    return owner as WorkflowLockOwner;
  }

  private publish(path: string, owner: WorkflowLockOwner): void {
    const temporaryPath = `${path}.${owner.token}.tmp`;
    try {
      const fd = openSync(temporaryPath, "wx", 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      // No reader can observe a partially written owner and no existing owner
      // can be replaced. A crash before publication leaves only an inert temp.
      linkSync(temporaryPath, path);
    } finally {
      try { unlinkSync(temporaryPath); } catch {
        // A stranded private temp is not a lock and cannot affect ownership.
      }
    }
  }
}
