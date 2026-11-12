/**
 * Interop example: playa session + moqtail MSE sink.
 *
 * @moqt/player handles WebTransport, CLIENT_SETUP, catalog, and subscribe.
 * CmafAssembler emits complete moof+mdat segments; moqtail's MseSource
 * (duck-typed MediaSourceLike) appends them to a <video> element.
 *
 * Requires a sibling checkout: ../moqtail (see vite alias @moqtail/*).
 */

import { MoqtPlayer } from '@openmoq/player';
import type { MediaSourceLike } from '@openmoq/player';
import { MoqtConnection } from '@openmoq/webtransport';
import { CmafAssembler, createWebTransport } from '@openmoq/browser';
import { MseSource } from './mse-source';
import MSEBuffer from './buffer';
import { log } from '../shared/log.js';
import { namespace, namespaceArg, authority, certHash, draftVersion } from '../shared/cert.js';
import { resolveRelayEndpoint } from '../shared/relay-endpoint.js';

const videoEl = document.getElementById('video') as HTMLVideoElement;
const startBtn = document.getElementById('start') as HTMLButtonElement;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;
const stateBadge = document.getElementById('state')!;

let player: MoqtPlayer | null = null;
let running = false;

function setState(state: string): void {
  stateBadge.textContent = state;
  stateBadge.className = `state-badge ${state}`;
}

/**
 * MediaSourceLike wrapper around moqtail's MSE sink + live-edge buffer.
 * Playa assigns onFirstFrame / onError / onStall after construction.
 */
class MoqtailMediaSource implements MediaSourceLike {
  private readonly sink: MseSource;
  private readonly liveBuffer: MSEBuffer;

  constructor(video: HTMLVideoElement) {
    this.sink = new MseSource(video);
    this.liveBuffer = new MSEBuffer(video);
  }

  get mediaElement(): HTMLVideoElement {
    return this.sink.mediaElement;
  }

  get onFirstFrame() { return this.sink.onFirstFrame; }
  set onFirstFrame(v) { this.sink.onFirstFrame = v; }
  get onError() { return this.sink.onError; }
  set onError(v) { this.sink.onError = v; }
  get onStall() { return this.sink.onStall; }
  set onStall(v) { this.sink.onStall = v; }

  initialize(config: {
    video?: { codec: string; initData: Uint8Array };
    audio?: { codec: string; initData: Uint8Array };
  }): boolean {
    return this.sink.initialize(config);
  }

  appendChunk(
    mediaType: 'video' | 'audio',
    data: Uint8Array,
    trackName: string,
    groupId?: bigint,
  ): void {
    if (groupId !== undefined) this.sink.appendChunk(mediaType, data, trackName, groupId);
    else this.sink.appendChunk(mediaType, data, trackName);
  }

  changeType(mediaType: 'video' | 'audio', codec: string, initData: Uint8Array): Promise<void> {
    return this.sink.changeType(mediaType, codec, initData);
  }

  setPlaybackIntent(intent: boolean): void {
    this.sink.setPlaybackIntent(intent);
  }

  getBufferAheadUs(): number | null {
    return this.sink.getBufferAheadUs();
  }

  endOfStream(): void {
    this.sink.endOfStream();
  }

  reset(): void {
    this.sink.reset();
  }

  destroy(): void {
    this.liveBuffer.dispose();
    this.sink.destroy();
  }
}

async function startPlayback(): Promise<void> {
  if (running) return;
  running = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  setState('loading');
  videoEl.muted = false;

  log('Discovering relay endpoint...');
  const relayUrl = 'https://todd-ord.ci.red5.net:4433/moq' // await resolveRelayEndpoint();
  log(`Relay: ${relayUrl}`);
  log(`Namespace: ${Array.isArray(namespaceArg) ? namespaceArg.join('/') : namespace}`);

  const p = new MoqtPlayer({
    url: relayUrl,
    namespace: namespaceArg,
    logLevel: 'debug',
    ...(authority ? { authority } : {}),
    ...(draftVersion ? { draftVersion } : {}),
    createTransport: createWebTransport({
      ...(certHash ? { certHash } : {}),
      ...(draftVersion ? { draftVersion } : {}),
    }),
    createConnection: () => new MoqtConnection(draftVersion),
    createMediaSource: () => new MoqtailMediaSource(videoEl),
    createCmafAssembler: (opts) => new CmafAssembler(opts),
  });
  player = p;

  p.on('session_connecting', (e) => log(`Connecting to ${e.url}...`));
  p.on('session_established', () => log('Session established.'));
  p.on('session_closed', (e) => log(`Closed: ${e.reason ?? 'clean'}`));
  p.on('catalog_received', (e) => {
    log(`Catalog: ${e.catalog.tracks.length} track(s)`);
    for (const t of e.catalog.tracks) {
      const parts = [t.name];
      if (t.codec) parts.push(t.codec);
      if (t.packaging) parts.push(t.packaging);
      log(`  ${parts.join(' | ')}`);
    }
  });
  p.on('track_subscribed', (e) => log(`Subscribed: ${e.trackName} (${e.mediaType})`));
  p.on('first_frame', () => {
    log('First frame');
    setState('playing');
  });
  p.on('stall', (e) => {
    log(`Stall: ${e.durationMs}ms`);
  });
  p.on('error', (e) => {
    log(`Error: ${e.error.message}`);
    setState('error');
  });
  p.on('state_changed', (e) => log(`State: ${e.from} -> ${e.to}`));

  await p.load();
  p.play();
}

async function stopPlayback(): Promise<void> {
  running = false;
  const p = player;
  player = null;
  try {
    await p?.destroy();
  } catch (err) {
    log(`destroy error (ignored): ${(err as Error).message}`);
  }
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setState('idle');
  log('Stopped.');
}

startBtn.addEventListener('click', () => {
  void startPlayback().catch((err: unknown) => {
    log(`Fatal: ${(err as Error).message}`);
    setState('error');
    running = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
  });
});

stopBtn.addEventListener('click', () => {
  void stopPlayback();
});
