/**
 * Copyright 2026 The MOQtail Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { logger } from './logger';

export type MediaRole = 'video' | 'audio';

export interface MseTrackInit {
  codec: string;
  initData: Uint8Array;
}

export interface MseSourceOptions {
  /** Seconds of media that must be buffered before seeking to the live edge and playing. Default 1.0 */
  startupBufferSec?: number;
}

interface QueuedChunk {
  data: Uint8Array;
  trackName: string;
  groupId?: bigint;
}

/**
 * Transport-agnostic MSE sink for CMAF playback.
 *
 * Duck-types playa's MediaSourceLike: initialize() creates SourceBuffers and
 * appends init segments; appendChunk() queues moof+mdat into SourceBuffer.
 * Kick-starts playback once every attached track has buffered past
 * `startupBufferSec` (moqtail's original startMedia behavior).
 */
export class MseSource {
  readonly mediaElement: HTMLVideoElement;

  onFirstFrame: (() => void) | null = null;
  onError: ((error: Error) => void) | null = null;
  onStall: ((durationMs: number, cause?: 'media-gap') => void) | null = null;

  private ms: MediaSource;
  private objectUrl: string;
  private readonly startupBufferSec: number;

  private initialized = false;
  private destroyed = false;
  private playbackIntent = true;
  private kickStarted = false;
  private playTriggered = false;
  private firstFrameFired = false;

  private readonly buffers: Partial<Record<MediaRole, SourceBuffer>> = {};
  private readonly queues: Record<MediaRole, QueuedChunk[]> = { video: [], audio: [] };
  private readonly changingType: Record<MediaRole, boolean> = { video: false, audio: false };
  private readonly pendingIdle = new Map<MediaRole, Array<() => void>>();

  constructor(element: HTMLVideoElement, options: MseSourceOptions = {}) {
    this.mediaElement = element;
    this.startupBufferSec = options.startupBufferSec ?? 1.0;

    this.ms = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.ms);
    element.src = this.objectUrl;

    element.addEventListener('playing', this.handlePlaying);
    element.addEventListener('waiting', this.handleWaiting);
    element.addEventListener('stalled', this.handleStalled);
  }

  initialize(config: { video?: MseTrackInit; audio?: MseTrackInit }): boolean {
    if (this.destroyed) return false;
    if (this.initialized) return true;

    const failures: Error[] = [];
    if (config.video) {
      const err = this.validateEntry('video', config.video);
      if (err) failures.push(err);
    }
    if (config.audio) {
      const err = this.validateEntry('audio', config.audio);
      if (err) failures.push(err);
    }
    if (failures.length > 0) {
      for (const e of failures) this.fail(e);
      return false;
    }

    this.initialized = true;

    const doInit = () => {
      try {
        if (config.video) this.createBuffer('video', config.video);
        if (config.audio) this.createBuffer('audio', config.audio);
        this.drain('video');
        this.drain('audio');
      } catch (err) {
        this.fail(err instanceof Error ? err : new Error(String(err)));
      }
    };

    if (this.ms.readyState === 'open') {
      doInit();
    } else {
      logger.info('mse', 'initialize: waiting for sourceopen');
      this.ms.addEventListener('sourceopen', doInit, { once: true });
    }
    return true;
  }

  appendChunk(mediaType: MediaRole, data: Uint8Array, trackName: string, groupId?: bigint): void {
    if (this.destroyed) return;
    this.queues[mediaType].push(
      groupId !== undefined ? { data, trackName, groupId } : { data, trackName },
    );
    this.drain(mediaType);
  }

  async changeType(mediaType: MediaRole, codec: string, initData: Uint8Array): Promise<void> {
    const buffer = this.buffers[mediaType];
    if (!buffer) throw new Error(`No SourceBuffer for ${mediaType}`);

    const mimeType = `${mediaType}/mp4; codecs="${codec}"`;
    if (!MediaSource.isTypeSupported(mimeType)) {
      throw new Error(`MIME type not supported: ${mimeType}`);
    }

    this.changingType[mediaType] = true;
    this.queues[mediaType].length = 0;
    await this.waitUntilIdle(mediaType);

    logger.info('mse', `changeType: ${mediaType} → ${mimeType}`);
    buffer.changeType(mimeType);
    await this.appendAndWait(mediaType, buffer, initData);

    this.changingType[mediaType] = false;
    this.drain(mediaType);
  }

  setPlaybackIntent(intent: boolean): void {
    if (this.playbackIntent === intent) return;
    this.playbackIntent = intent;
    if (!intent) {
      if (this.playTriggered && !this.mediaElement.paused) this.mediaElement.pause();
      return;
    }
    if (this.destroyed) return;
    if (this.playTriggered) {
      void this.mediaElement.play().catch(e => logger.error('mse', 'play() rejected', e));
      return;
    }
    this.maybeKickStart();
  }

  getBufferAheadUs(): number | null {
    const v = this.mediaElement;
    if (!v.buffered.length) return this.playTriggered ? 0 : null;

    for (let i = 0; i < v.buffered.length; i++) {
      if (v.currentTime >= v.buffered.start(i) && v.currentTime <= v.buffered.end(i)) {
        return Math.max(0, v.buffered.end(i) - v.currentTime) * 1_000_000;
      }
    }
    return this.playTriggered ? 0 : null;
  }

  endOfStream(): void {
    if (this.ms.readyState === 'open') {
      try {
        this.ms.endOfStream();
      } catch {
        /* already ended */
      }
    }
  }

  reset(): void {
    this.kickStarted = false;
    this.playTriggered = false;
    this.firstFrameFired = false;
    this.initialized = false;
    this.queues.video.length = 0;
    this.queues.audio.length = 0;
    this.changingType.video = false;
    this.changingType.audio = false;

    this.removeBuffer('video');
    this.removeBuffer('audio');

    if (this.ms.readyState !== 'open') {
      this.reattach();
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    this.mediaElement.removeEventListener('playing', this.handlePlaying);
    this.mediaElement.removeEventListener('waiting', this.handleWaiting);
    this.mediaElement.removeEventListener('stalled', this.handleStalled);

    this.queues.video.length = 0;
    this.queues.audio.length = 0;
    this.removeBuffer('video');
    this.removeBuffer('audio');

    if (this.ms.readyState === 'open') {
      try {
        this.ms.endOfStream();
      } catch {
        /* already ended */
      }
    }

    URL.revokeObjectURL(this.objectUrl);
    this.mediaElement.removeAttribute('src');
    this.mediaElement.load();
  }

  private validateEntry(role: MediaRole, entry: MseTrackInit): Error | null {
    const mimeType = `${role}/mp4; codecs="${entry.codec}"`;
    if (!MediaSource.isTypeSupported(mimeType)) {
      const err = new Error(`Codec not supported by this UA: ${mimeType}`);
      err.name = 'CodecUnsupportedError';
      return err;
    }
    if (entry.initData.byteLength === 0) {
      return new Error(`Empty ${role} init data (codec=${entry.codec})`);
    }
    return null;
  }

  private createBuffer(role: MediaRole, entry: MseTrackInit): void {
    const mimeType = `${role}/mp4; codecs="${entry.codec}"`;
    logger.info('mse', `createBuffer: ${mimeType} init=${entry.initData.byteLength}B`);
    const buffer = this.ms.addSourceBuffer(mimeType);
    buffer.mode = 'segments';
    buffer.addEventListener('updateend', () => {
      this.resolveIdle(role);
      this.drain(role);
      this.maybeKickStart();
    });
    buffer.addEventListener('error', () => {
      this.fail(new Error(`SourceBuffer error (${role})`));
    });
    this.buffers[role] = buffer;
    this.enqueueFront(role, entry.initData, `${role}-init`);
  }

  private enqueueFront(role: MediaRole, data: Uint8Array, trackName: string): void {
    this.queues[role].unshift({ data, trackName });
  }

  private drain(role: MediaRole): void {
    const buffer = this.buffers[role];
    if (!buffer || this.destroyed || this.changingType[role]) return;
    if (buffer.updating || this.queues[role].length === 0) return;

    const chunk = this.queues[role].shift();
    if (!chunk) return;

    try {
      buffer.appendBuffer(toArrayBuffer(chunk.data));
    } catch (err) {
      logger.error('mse', `[${role}] appendBuffer failed: ${(err as Error).message}`);
      this.queues[role].unshift(chunk);
    }
  }

  private maybeKickStart(): void {
    if (this.kickStarted || !this.playbackIntent || this.destroyed) return;

    const roles = (['video', 'audio'] as const).filter(r => this.buffers[r]);
    if (roles.length === 0) return;

    let target = 0;
    for (const role of roles) {
      const buffer = this.buffers[role];
      if (!buffer || buffer.buffered.length === 0) return;
      const start = buffer.buffered.start(0);
      const end = buffer.buffered.end(buffer.buffered.length - 1);
      if (end - start < this.startupBufferSec) return;
      target = Math.max(target, end);
    }

    this.kickStarted = true;
    this.playTriggered = true;
    const video = this.mediaElement;
    const alreadyPlaying = !video.paused && !video.ended && video.readyState > 2;
    if (alreadyPlaying) {
      logger.debug('mse', 'Already playing, skipping seek/play');
      return;
    }

    logger.info('mse', `kick-start — seeking to ${target.toFixed(3)}s and calling play()`);
    video.currentTime = target;
    video
      .play()
      .then(() => logger.info('mse', 'play() resolved'))
      .catch(e => logger.error('mse', 'play() rejected', e));
  }

  private waitUntilIdle(role: MediaRole): Promise<void> {
    const buffer = this.buffers[role];
    if (!buffer || !buffer.updating) return Promise.resolve();
    return new Promise(resolve => {
      const pending = this.pendingIdle.get(role) ?? [];
      pending.push(resolve);
      this.pendingIdle.set(role, pending);
    });
  }

  private resolveIdle(role: MediaRole): void {
    const pending = this.pendingIdle.get(role);
    if (!pending || pending.length === 0) return;
    this.pendingIdle.delete(role);
    for (const resolve of pending) resolve();
  }

  private appendAndWait(role: MediaRole, buffer: SourceBuffer, data: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      const onEnd = () => {
        buffer.removeEventListener('updateend', onEnd);
        buffer.removeEventListener('error', onErr);
        resolve();
      };
      const onErr = () => {
        buffer.removeEventListener('updateend', onEnd);
        buffer.removeEventListener('error', onErr);
        reject(new Error(`SourceBuffer error appending init for ${role}`));
      };
      buffer.addEventListener('updateend', onEnd, { once: true });
      buffer.addEventListener('error', onErr, { once: true });
      try {
        buffer.appendBuffer(toArrayBuffer(data));
      } catch (err) {
        buffer.removeEventListener('updateend', onEnd);
        buffer.removeEventListener('error', onErr);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private removeBuffer(role: MediaRole): void {
    const buffer = this.buffers[role];
    if (!buffer) return;
    try {
      if (this.ms.readyState === 'open') this.ms.removeSourceBuffer(buffer);
    } catch {
      /* already removed */
    }
    delete this.buffers[role];
  }

  private reattach(): void {
    URL.revokeObjectURL(this.objectUrl);
    this.ms = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.ms);
    this.mediaElement.src = this.objectUrl;
  }

  private fail(error: Error): void {
    logger.error('mse', error.message);
    this.onError?.(error);
  }

  private handlePlaying = (): void => {
    if (this.firstFrameFired) return;
    this.firstFrameFired = true;
    this.onFirstFrame?.();
  };

  private handleWaiting = (): void => {
    this.onStall?.(0);
  };

  private handleStalled = (): void => {
    this.onStall?.(0);
  };
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}
