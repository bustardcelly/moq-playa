import { MoqtPlayer, type AudioOutputLike, type VideoRendererLike } from '@openmoq/player';
import { MoqtConnection } from '@openmoq/webtransport';
import { createWebTransport, WebCodecsAudioDecoder, WebCodecsVideoDecoder } from '@openmoq/browser';
import { log } from '../shared/log.js';
import { certHash, namespaceArg } from '../shared/cert.js';

  const relayUrl = 'https://playa.openmoq.akaleapi.net:4433';

function nowUs(): number {
  return performance.now() * 1000;
}

function requireApi(name: string, present: boolean): void {
  if (!present) throw new Error(`${name} is not available in this browser`);
}

interface GeneratedTrack<T> extends MediaStreamTrack {
  writable: WritableStream<T>;
}

class MediaStreamVideoRenderer implements VideoRendererLike {
  onFirstFrame: (() => void) | null = null;
  onFrameRendered: ((captureTimestampUs: bigint, actualRenderUs: number) => void) | null = null;
  onStall: ((durationMs: number) => void) | null = null;

  private readonly writer: WritableStreamDefaultWriter<VideoFrame>;
  private firstFrame = false;
  private destroyed = false;
  private lastRenderMs = performance.now();
  private stallArmed = false;
  private stallTimer: number;
  private baseTimestampUs: number | null = null;
  private firstRenderTimeUs: number | null = null;
  private lastWrittenTimestampUs: number | null = null;

  constructor(videoTrack: GeneratedTrack<VideoFrame>) {
    this.writer = videoTrack.writable.getWriter();
    this.stallTimer = window.setInterval(() => {
      const elapsed = performance.now() - this.lastRenderMs;
      if (!this.firstFrame || this.stallArmed || elapsed < 1000) return;
      this.stallArmed = true;
      this.onStall?.(elapsed);
    }, 250);
  }

  enqueue(frame: unknown, renderTimeUs: number): void {
    const input = frame as VideoFrame;

    if (this.destroyed) {
      input.close();
      return;
    }
    const sourceTsUs = typeof input.timestamp === 'number' && Number.isFinite(input.timestamp)
      ? input.timestamp
      : null;
    if (this.baseTimestampUs === null) {
      this.baseTimestampUs = sourceTsUs ?? 0;
    }
    if (this.firstRenderTimeUs === null) {
      this.firstRenderTimeUs = renderTimeUs;
    }
    let normalizedTimestampUs = sourceTsUs !== null
      ? sourceTsUs - this.baseTimestampUs
      : Math.max(0, renderTimeUs - this.firstRenderTimeUs);
    if (this.lastWrittenTimestampUs !== null && normalizedTimestampUs <= this.lastWrittenTimestampUs) {
      normalizedTimestampUs = this.lastWrittenTimestampUs + 1;
    }
    const normalizedDurationUs =
      (typeof input.duration === 'number' && input.duration > 0)
        ? input.duration
        : 33_333;
    const output = new VideoFrame(input, {
      timestamp: normalizedTimestampUs,
      duration: normalizedDurationUs,
    });
    this.lastWrittenTimestampUs = normalizedTimestampUs;
    const tsUs = BigInt(sourceTsUs ?? 0);
    input.close();
    if (!this.firstFrame) {
      this.firstFrame = true;
      this.onFirstFrame?.();
    }
    this.lastRenderMs = performance.now();
    this.stallArmed = false;
    this.onFrameRendered?.(tsUs, nowUs());
    void this.writer.write(output).catch(() => {
      output.close();
    });
  }

  flush(): void {
    // Writable stream does not support selective frame purge. No-op.
  }

  destroy(): void {
    this.destroyed = true;
    clearInterval(this.stallTimer);
    void this.writer.close().catch(() => {});
    this.onFirstFrame = null;
    this.onFrameRendered = null;
    this.onStall = null;
  }
}

class MediaStreamAudioOutput implements AudioOutputLike {
  private readonly writer: WritableStreamDefaultWriter<AudioData>;
  private destroyed = false;
  private _lastPlayoutUs = 0;

  constructor(audioTrack: GeneratedTrack<AudioData>) {
    this.writer = audioTrack.writable.getWriter();
  }

  schedule(data: unknown, _renderTimeUs: number): void {
    if (this.destroyed) return;
    const input = data as AudioData;
    const clone = input.clone();
    input.close();
    this._lastPlayoutUs = nowUs();
    void this.writer.write(clone).catch(() => {
      clone.close();
    });
  }

  flush(): void {
    // Writable stream does not expose flush/discard for queued chunks.
  }

  get currentPlayoutTimeUs(): number {
    return this._lastPlayoutUs;
  }

  destroy(): void {
    this.destroyed = true;
    void this.writer.close().catch(() => {});
  }
}

const startBtn = document.getElementById('start') as HTMLButtonElement;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;
const statsEl = document.getElementById('stats') as HTMLDivElement;
const videoEl = document.getElementById('video') as HTMLVideoElement;

let player: MoqtPlayer | null = null;
let metricsTimer: number | null = null;
let processedVideoFrames = 0;
let processedAudioFrames = 0;

function attachProcessorCounters(stream: MediaStream): void {
  processedVideoFrames = 0;
  processedAudioFrames = 0;
  const MSP = (window as any).MediaStreamTrackProcessor;
  if (!MSP) return;

  const v = stream.getVideoTracks()[0];
  if (v) {
    // Read from a clone so playback still owns the primary track.
    const proc = new MSP({ track: v.clone() });
    const reader: ReadableStreamDefaultReader<VideoFrame> = proc.readable.getReader();
    (async () => {
      while (player) {
        const { value, done } = await reader.read();
        if (done) break;
        processedVideoFrames++;
        value?.close();
      }
      reader.releaseLock();
    })().catch(() => {});
  }

  const a = stream.getAudioTracks()[0];
  if (a) {
    const proc = new MSP({ track: a.clone() });
    const reader: ReadableStreamDefaultReader<AudioData> = proc.readable.getReader();
    (async () => {
      while (player) {
        const { value, done } = await reader.read();
        if (done) break;
        processedAudioFrames++;
        value?.close();
      }
      reader.releaseLock();
    })().catch(() => {});
  }
}

function updateStats(): void {
  if (!player) return;
  const s = player.stats;
  statsEl.textContent = `decoded=${s.framesDecoded} rendered=${s.framesRendered} dropped=${s.framesDropped} | processor video=${processedVideoFrames} audio=${processedAudioFrames}`;
}

async function start(): Promise<void> {
  requireApi('VideoDecoder', 'VideoDecoder' in window);
  requireApi('AudioDecoder', 'AudioDecoder' in window);
  requireApi('MediaStreamTrackGenerator', 'MediaStreamTrackGenerator' in window);

  const Generator = (window as any).MediaStreamTrackGenerator;
  const videoTrack = new Generator({ kind: 'video' }) as GeneratedTrack<VideoFrame>;
  const audioTrack = new Generator({ kind: 'audio' }) as GeneratedTrack<AudioData>;
  const outputStream = new MediaStream([videoTrack, audioTrack]);
  videoEl.srcObject = outputStream;
  await videoEl.play().catch(() => {});
  attachProcessorCounters(outputStream);


  const renderer = new MediaStreamVideoRenderer(videoTrack);
  const audioOutput = new MediaStreamAudioOutput(audioTrack);
  const moqt = new MoqtPlayer({
    url: relayUrl,
    namespace: 'night-loc', // namespaceArg,
    createTransport: createWebTransport({ ...(certHash ? { certHash } : {}) }),
    createConnection: () => new MoqtConnection(),
    createVideoDecoder: () => new WebCodecsVideoDecoder(),
    createAudioDecoder: () => new WebCodecsAudioDecoder(),
    createRenderer: () => renderer,
    createAudioOutput: () => audioOutput,
    autoQuality: true,
  });

  moqt.on('catalog_received', (e) => {
    const hasLocVideo = e.catalog.tracks.some((t) => t.role === 'video' && t.packaging === 'loc');
    if (!hasLocVideo) {
      log('Catalog has no LOC video track. This example is LOC-only.');
    }
    log(`Catalog loaded: ${e.catalog.tracks.length} tracks`);
  });
  moqt.on('first_frame', () => log('First frame rendered via MediaStreamTrackGenerator'));
  moqt.on('stall', (e) => log(`Stall ${e.durationMs.toFixed(0)}ms`));
  moqt.on('quality_switched', (e) => log(`Quality ${e.fromTrackName} -> ${e.toTrackName} (${e.reason})`));
  moqt.on('error', (e) => log(`Error(${e.error.severity}/${e.error.source}) ${e.error.message}`));

  await moqt.load();
  moqt.play();

  player = moqt;
  metricsTimer = window.setInterval(updateStats, 1000);
  updateStats();
  log(`Connected to ${relayUrl}`);
  log(`Namespace: ${Array.isArray(namespaceArg) ? namespaceArg.join('/') : namespaceArg}`);
}

async function stop(): Promise<void> {
  if (metricsTimer !== null) {
    clearInterval(metricsTimer);
    metricsTimer = null;
  }
  const p = player;
  player = null;
  if (p) await p.destroy().catch(() => {});
  videoEl.pause();
  videoEl.srcObject = null;
  statsEl.textContent = 'idle';
}

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  stopBtn.disabled = false;
  try {
    await start();
  } catch (err) {
    log(`Start failed: ${(err as Error).message}`);
    await stop();
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
});

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  await stop();
  startBtn.disabled = false;
});
