/**
 * Media-timeline and SAP-timeline publication for the broadcast example.
 *
 * Each published video group contributes one entry. The mediatimeline object
 * is always a full index (object 0 of a new group), so a subscriber that
 * joins at the live edge still receives every group since the broadcast
 * started. The SAP track sends one record per video group, matching the
 * CMSF SAP timeline: `{ l: [groupId, objectId], data: [sapType, mediaPts] }`.
 *
 * Publication waits until a subscriber has been accepted. Entries recorded
 * before that are included in the first object.
 */
import type { DraftVersion } from '@openmoq/transport';
import { isRequestStreamDraft } from '@openmoq/transport';

/** The subset of MoqtConnection timeline publication uses. */
export interface TimelinePublishConnection {
  openSubgroup(
    alias: unknown,
    groupId: unknown,
    subgroupId: unknown,
    options: Record<string, unknown>,
  ): Promise<bigint>;
  sendObject(streamId: bigint, objectId: unknown, payload: Uint8Array): Promise<void>;
  closeSubgroup(streamId: bigint): Promise<void>;
}

/** One video group, as the timeline tracks describe it. */
export interface TimelineGroup {
  /** Video track group id. Object 0 of that group is the keyframe. */
  readonly groupId: bigint;
  /** Milliseconds since the first published video keyframe. */
  readonly mediaPtsMs: number;
  /** Rebased capture time, milliseconds since the Unix epoch. */
  readonly wallclockMs: number;
}

export interface TimelinePublisherOptions {
  wrapInt: (n: bigint) => unknown;
  draft: DraftVersion;
  onError?: (context: string, err: unknown) => void;
}

export class TimelinePublisher {
  private readonly connection: TimelinePublishConnection;
  private readonly wrapInt: (n: bigint) => unknown;
  private readonly draft: DraftVersion;
  private readonly onError: (context: string, err: unknown) => void;

  private mediaAlias: bigint | null = null;
  private sapAlias: bigint | null = null;
  private readonly entries: TimelineGroup[] = [];
  /** Video groups already emitted as their own SAP object. */
  private sapSent = 0;
  /** The mediatimeline subscriber still needs an object containing `entries`. */
  private mediaDirty = false;
  /** A send failed; wait for the next group instead of retrying immediately. */
  private hold = false;
  private stopped = false;

  private mediaGroupId = 0n;
  private sapGroupId = 0n;
  private pumping = false;
  private pump: Promise<void> = Promise.resolve();

  constructor(connection: TimelinePublishConnection, options: TimelinePublisherOptions) {
    this.connection = connection;
    this.wrapInt = options.wrapInt;
    this.draft = options.draft;
    this.onError = options.onError ?? (() => {});
  }

  setMediaAlias(alias: bigint | null): void {
    this.mediaAlias = alias;
    if (alias !== null && this.entries.length > 0) {
      this.hold = false;
      this.mediaDirty = true;
      this.kick();
    }
  }

  setSapAlias(alias: bigint | null): void {
    this.sapAlias = alias;
    if (alias !== null && this.sapSent < this.entries.length) {
      this.hold = false;
      this.kick();
    }
  }

  /** Record a video group and publish it to whichever timeline subscribers exist. */
  noteGroup(group: TimelineGroup): void {
    if (this.stopped) return;
    this.entries.push(group);
    this.mediaDirty = true;
    this.hold = false;
    this.kick();
  }

  retire(): void {
    this.stopped = true;
    this.mediaAlias = null;
    this.sapAlias = null;
  }

  /** Await publication already started. Never rejects. */
  async drain(): Promise<void> {
    await this.pump;
  }

  private hasPending(): boolean {
    if (this.hold || this.stopped) return false;
    if (this.mediaAlias !== null && this.mediaDirty) return true;
    return this.sapAlias !== null && this.sapSent < this.entries.length;
  }

  private kick(): void {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    this.pump = this.pump.then(() => this.flush()).finally(() => {
      this.pumping = false;
      if (this.hasPending()) this.kick();
    });
  }

  private async flush(): Promise<void> {
    while (this.hasPending()) {
      if (this.mediaAlias !== null && this.mediaDirty) {
        const alias = this.mediaAlias;
        const snapshot = this.entries.slice();
        this.mediaDirty = false;
        try {
          await this.sendGroup(alias, this.mediaGroupId++, mediaTimelinePayload(snapshot));
        } catch (err) {
          this.hold = true;
          this.report('mediatimeline publish', err);
          return;
        }
        if (this.entries.length !== snapshot.length) this.mediaDirty = true;
      }
      if (this.sapAlias !== null && this.sapSent < this.entries.length) {
        const alias = this.sapAlias;
        const entry = this.entries[this.sapSent]!;
        try {
          await this.sendGroup(alias, this.sapGroupId++, sapPayload(entry));
        } catch (err) {
          this.hold = true;
          this.report('sap timeline publish', err);
          return;
        }
        this.sapSent++;
      }
    }
  }

  private async sendGroup(alias: bigint, groupId: bigint, payload: Uint8Array): Promise<void> {
    const streamId = await this.connection.openSubgroup(
      this.wrapInt(alias), this.wrapInt(groupId), this.wrapInt(0n),
      {
        hasExtensions: false,
        endOfGroup: true,
        publisherPriority: 128,
        ...(isRequestStreamDraft(this.draft) ? { firstObject: true } : {}),
      },
    );
    try {
      await this.connection.sendObject(streamId, this.wrapInt(0n), payload);
    } catch (err) {
      await this.connection.closeSubgroup(streamId).then(() => {}, () => {});
      throw err;
    }
    await this.connection.closeSubgroup(streamId);
  }

  private report(context: string, err: unknown): void {
    try { this.onError(context, err); } catch { /* the sink cannot poison the pump */ }
  }
}

/** `[mediaPts, [groupId, objectId], wallclockTime]` for every video group so far. */
export function mediaTimelinePayload(entries: readonly TimelineGroup[]): Uint8Array {
  const records = entries.map((entry) => [entry.mediaPtsMs, [Number(entry.groupId), 0], entry.wallclockMs]);
  return new TextEncoder().encode(JSON.stringify(records));
}

/** One CMSF SAP record: type 1 (random access) at object 0 of the video group. */
export function sapPayload(entry: TimelineGroup): Uint8Array {
  const record = [{ l: [Number(entry.groupId), 0], data: [1, entry.mediaPtsMs] }];
  return new TextEncoder().encode(JSON.stringify(record));
}
