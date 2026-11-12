import { describe, it, expect } from 'vitest';
import { TimelinePublisher } from './timeline-publisher.js';
import type { TimelinePublishConnection } from './timeline-publisher.js';
import { parseMediaTimeline, parseSapTimeline } from '@openmoq/msf';

const wrapInt = (n: bigint) => n;

function recordingConnection() {
  const opened: Array<{ alias: bigint; groupId: bigint }> = [];
  const sends: Array<{ payload: Uint8Array }> = [];
  let nextStream = 1n;
  const conn: TimelinePublishConnection & { opened: typeof opened; sends: typeof sends } = {
    opened, sends,
    openSubgroup: async (alias, groupId) => {
      opened.push({ alias: alias as bigint, groupId: groupId as bigint });
      return nextStream++;
    },
    sendObject: async (_streamId, _objectId, payload) => { sends.push({ payload }); },
    closeSubgroup: async () => {},
  };
  return conn;
}

const group = (groupId: bigint, mediaPtsMs: number) => ({ groupId, mediaPtsMs, wallclockMs: 1_700_000_000_000 + mediaPtsMs });

async function settle() { await new Promise((r) => setTimeout(r, 0)); }

describe('TimelinePublisher', () => {
  it('sends a full media timeline and one SAP record per video group', async () => {
    const conn = recordingConnection();
    const publisher = new TimelinePublisher(conn, { wrapInt, draft: 16 });
    publisher.setMediaAlias(4n);
    publisher.setSapAlias(5n);
    publisher.noteGroup(group(10n, 0));
    publisher.noteGroup(group(11n, 2000));
    await settle();

    const media = conn.sends.filter((_, i) => conn.opened[i]!.alias === 4n).map((s) => parseMediaTimeline(s.payload));
    const sap = conn.sends.filter((_, i) => conn.opened[i]!.alias === 5n).map((s) => parseSapTimeline(s.payload));
    // The second media object restates both groups. Each SAP object is one record.
    expect(media.at(-1)).toEqual([
      { mediaPts: 0, location: [10, 0], wallclockTime: 1_700_000_000_000 },
      { mediaPts: 2000, location: [11, 0], wallclockTime: 1_700_000_000_000 + 2000 },
    ]);
    expect(sap.map((records) => records[0]!.location)).toEqual([[10, 0], [11, 0]]);
    expect(sap[1]![0]).toMatchObject({ sapType: 1, earliestPresentationTimeMs: 2000 });
  });

  it('includes groups that happened before the subscriber arrived', async () => {
    const conn = recordingConnection();
    const publisher = new TimelinePublisher(conn, { wrapInt, draft: 18 });
    publisher.noteGroup(group(10n, 0));
    publisher.noteGroup(group(11n, 2000));
    await settle();
    expect(conn.sends).toHaveLength(0);

    publisher.setMediaAlias(4n);
    await settle();
    const timeline = parseMediaTimeline(conn.sends[0]!.payload);
    expect(timeline.map((entry) => entry.location[0])).toEqual([10, 11]);
    expect(conn.opened[0]!.groupId).toBe(0n);
  });
});
