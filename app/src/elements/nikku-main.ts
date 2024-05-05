import { html, css, LitElement } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { AudioPlayer } from '../audio-player/audio-player';
import { Timer } from '../timer';
import { transfer } from 'comlink';

@customElement('nikku-main')
export class NikkuMain extends LitElement {
  /**
   * icon state "play" means audio is paused;
   * icon state "pause" means audio is playing;
   */
  @state()
  private playPauseIcon: 'play' | 'pause' = 'play';
  @state()
  private brstmLoop: 'on' | 'off' = 'on';
  @state()
  private filesLoop: 'on' | 'off' = 'on';
  @state()
  private volume: number = 0.1;
  @state()
  private muted: boolean = false;
  @state()
  private progressMax: number = 0;
  @state()
  private progressValue: number = 0;
  @state()
  private timeDisplayMax: number = 0;
  @state()
  private timeDisplayValue: number = 0;
  @state()
  private brstmTracks: { count: number; active: boolean[] } = { count: 1, active: [true] };
  @state()
  private disabled: boolean = true;
  @state()
  private fileDraggingOver: boolean = false;
  @state()
  private trackTitle: string = '';
  @state()
  private errorMessage: string = '';
  @state()
  private fileTracks = { count: 0, active: [] as boolean[], names: '[]', files: [] as File[] };

  private fadeOutTimeout: number = 0;

  private audioPlayer: AudioPlayer | null = null;

  private workerInstance = new ComlinkWorker(new URL('../audio-decoder/worker', import.meta.url))

  private timer = new Timer({
    renderCallback: () => {
      if (!this.audioPlayer) {
        return;
      }

      const currentTime = this.audioPlayer.getCurrrentPlaybackTime();
      this.progressValue = currentTime;
      this.timeDisplayValue = currentTime;
    },
  });

  render() {
    return html`
      <div
        id="error"
        class=${classMap({
          hidden: !this.errorMessage,
        })}
      >
        ${this.errorMessage}
      </div>
      <main id="main">
        <div id="track-title">${this.trackTitle}</div>
        <div id="controls-tracks">
          <controls-tracks
            ?disabled=${this.disabled}
            count=${this.brstmTracks.count}
            .active=${this.brstmTracks.active}
            @tracksActiveChange=${this.#handleTracksActiveChange}
          ></controls-tracks>
        </div>
        <div id="controls-time-display">
          <controls-time-display
            ?disabled=${this.disabled}
            value=${this.timeDisplayValue}
            max=${this.timeDisplayMax}
          ></controls-time-display>
        </div>
        <div id="controls-progress">
          <controls-progress
            ?disabled=${this.disabled}
            value=${this.progressValue}
            max=${this.progressMax}
            @progressValueChange=${this.#handleProgressValueChange}
          ></controls-progress>
        </div>
        <label id="controls-select-file-container">
          <input
            type="file"
            id="controls-select-file"
            accept=".brstm"
            multiple="multiple"
            @change=${this.#handleFileInputChange}
          />
          <span id="controls-select-file-custom"></span>
        </label>

        <div id="controls-play-pause">
          <controls-play-pause
            ?disabled=${this.disabled}
            mode=${this.playPauseIcon}
            @playPauseClick=${this.#handlePlayPauseClick}
          ></controls-play-pause>
        </div>
        <div id="controls-others">
          brstm:
          <controls-loop
            ?disabled=${this.disabled}
            mode=${this.brstmLoop}
            @loopClick=${this.#handleBrstmLoopClick}
          ></controls-loop>
          files:
          <controls-loop
            ?disabled=${this.disabled}
            mode=${this.filesLoop}
            @loopClick=${this.#handleFilesLoopClick}
          ></controls-loop>
          <controls-volume
            ?disabled=${this.disabled}
            ?muted=${this.muted}
            volume=${this.volume}
            @mutedChange=${this.#handleMutedChange}
            @volumeChange=${this.#handleVolumeChange}
          ></controls-volume>
        </div>
        <div id="controls-file-list">
          <controls-tracks
            ?disabled=${this.disabled}
            count=${this.fileTracks.count}
            names=${this.fileTracks.names}
            .active=${this.fileTracks.active}
            @tracksActiveChange=${this.#handleFileTracksActiveChange}
          ></controls-tracks>
        </div>
      </main>
      <div
        id="drag-and-drop-overlay"
        class=${classMap({
          hidden: !this.fileDraggingOver,
        })}
      >
        Drop BRSTM file to start playback
      </div>
    `;
  }

  firstUpdated() {
    window.addEventListener('dragover', (ev: DragEvent) => {
      // Prevent opening file
      ev.preventDefault();

      // Display drag & drop overlay
      this.fileDraggingOver = true;
    });
    window.addEventListener('dragend', (_ev: DragEvent) => {
      this.fileDraggingOver = false;
    });
    window.addEventListener('dragleave', (_ev: DragEvent) => {
      this.fileDraggingOver = false;
    });

    window.addEventListener('drop', (ev) => {
      // Prevent opening file
      ev.preventDefault();
      this.fileDraggingOver = false;
      if (
        !ev.dataTransfer ||
        !ev.dataTransfer.items ||
        !ev.dataTransfer.items[0] ||
        ev.dataTransfer.items[0].kind !== 'file'
      ) {
        this.#showError(new Error('No file read'));
        return;
      }

      const file = ev.dataTransfer.items[0].getAsFile();
      if (!file) {
        this.#showError(new Error('No file read'));
        return;
      }

      readFile(file).then(this.#playSingle.bind(this));
      this.#handleFilesSelected([file])
    });
  }

  #showError(error: Error) {
    this.errorMessage = error.message + error.stack;
  }
  #clearError() {
    this.errorMessage = '';
  }

  #handleFileInputChange(e: InputEvent) {
    const files = (e.target as HTMLInputElement).files;
    if (!files || !files.length) {
      this.#showError(new Error('No file read'));
      return;
    }

   this.#handleFilesSelected(Array.from(files));
  }

  async #handleFilesSelected(files: File[]) {
    this.fileTracks = {
      count: files.length,
      active: new Array(files.length).fill(true),
      names: JSON.stringify(files.map((file) => file.name)),
      files: files,
    }

    let counter = 0;
    const loop = () => {
      if (this.filesLoop === 'off' && counter === files.length) {
        return;
      }
      if (this.fileTracks.active.every(a => a === false)) {
        // Prevent infinite loop
        return;
      }
      const i = counter++ % files.length
      if (!this.fileTracks.active[i]) {
        loop();
        return;
      }
      readFile(files[i]).then(fb => {
        this.#playSingle({ ...fb, onEnded: loop });
      })
    };
    loop();
  }

  async #playSingle({
    buffer,
    file,
    onEnded,
  }: {
    buffer: string | ArrayBuffer | null;
    file: File;
    onEnded?: () => void;
  }) {
    this.#clearError();

    if (!buffer || !(buffer instanceof ArrayBuffer)) {
      return;
    }
    if (file.name) {
      this.trackTitle = file.name;
    }

    try {
      await this.workerInstance.init(transfer(buffer, [buffer]));
      const metadata = await this.workerInstance.getMetadata();

      if (this.fadeOutTimeout) {
        clearTimeout(this.fadeOutTimeout)
        this.fadeOutTimeout = 0;
      }
      let loopCount = 0;
      const maxLoopCount = this.brstmLoop === 'on' ? 4 : 1;
      if (this.audioPlayer) {
        await this.audioPlayer.destroy();
        this.audioPlayer = null;
      }
      this.audioPlayer = new AudioPlayer({
        onPlay: () => {
          this.playPauseIcon = 'pause';
          this.timer.start();
        },
        onPause: () => {
          this.playPauseIcon = 'play';
          this.timer.stop();
        },
        onLoop: () => {
          if (++loopCount === maxLoopCount) {
            let volume = this.volume;
            let delta = volume / 70;
            const reduceVolume = () => {
              volume -= delta;
              if (volume <= 0) {
                onEnded?.()
                return
              }
              this.audioPlayer?.setVolume(volume);
              this.fadeOutTimeout = setTimeout(reduceVolume, 100)
            };
            reduceVolume();
          }
        },
        onEnd: () => {
          onEnded?.();
        },
        decodeSamples: async (offset: number, size: number) => {
          const samples =
            (await this.workerInstance.getSamples(offset, size)) || [];
          return samples;
        },
      });

      if (!metadata) {
        throw new Error('metadata is undefined');
      }
      await this.audioPlayer.init(metadata);
      await this.audioPlayer.start();

      const amountTimeInS = metadata.totalSamples / metadata.sampleRate;
      const numberTracks = metadata.numberTracks;

      if (this.muted) {
        this.audioPlayer.setVolume(0);
      } else {
        this.audioPlayer.setVolume(this.volume);
      }

      this.playPauseIcon = 'pause';
      this.progressMax = amountTimeInS;
      this.timeDisplayMax = amountTimeInS;

      this.brstmTracks = {
        count: numberTracks,
        active: new Array(numberTracks)
          .fill(true)
          .map((_, i) => (i === 0 ? true : false)),
      }
      this.disabled = false;
      this.audioPlayer?.play();
    } catch (e) {
      this.#showError(e as Error);
    }
  }

  #handleTracksActiveChange(e: CustomEvent) {
    const newActive: Array<boolean> = e.detail.active;
    this.brstmTracks = {
      ...this.brstmTracks,
      active: newActive,
    };
    this.audioPlayer?.setTrackStates(newActive);
  }

  #handleFileTracksActiveChange(e: CustomEvent) {
    const newActive: Array<boolean> = e.detail.active;
    this.fileTracks = {
      ...this.fileTracks,
      active: newActive,
    };
  }

  #handlePlayPauseClick(e: CustomEvent) {
    const newMode = e.detail.mode as 'play' | 'pause';
    this.playPauseIcon = newMode;
    if (newMode === 'play') {
      this.audioPlayer?.pause();
    } else if (newMode === 'pause') {
      this.audioPlayer?.play();
    }
  }

  #handleProgressValueChange(e: CustomEvent) {
    const newProgressValue: number = e.detail.value;
    this.progressValue = newProgressValue;
    this.timeDisplayValue = newProgressValue;
    this.audioPlayer?.seek(newProgressValue);
  }

  #handleBrstmLoopClick(e: CustomEvent) {
    const newLoopMode = e.detail.mode as 'on' | 'off';
    this.brstmLoop = newLoopMode;
    if (newLoopMode === 'on') {
      this.audioPlayer?.setLoop(true);
    } else if (newLoopMode === 'off') {
      this.audioPlayer?.setLoop(false);
    }
  }

  #handleFilesLoopClick(e: CustomEvent) {
    const newLoopMode = e.detail.mode as 'on' | 'off';
    this.filesLoop = newLoopMode;
  }

  #handleMutedChange(e: CustomEvent) {
    const newMuted = e.detail.muted as boolean;
    this.muted = newMuted;
    if (newMuted) {
      this.audioPlayer?.setVolume(0);
    } else {
      this.audioPlayer?.setVolume(this.volume);
    }
  }
  #handleVolumeChange(e: CustomEvent) {
    const newVolume = e.detail.volume as number;
    this.volume = newVolume;
    this.muted = false;
    this.audioPlayer?.setVolume(newVolume);
  }

  static styles = css`
    #error {
      padding: 0.6rem;
      margin-top: 0.6rem;
      margin-bottom: 0.6rem;
      color: #ff4136;
      border: 1px solid currentColor;
      padding: 0.6rem;
    }
    #error.hidden {
      display: none;
    }
    #drag-and-drop-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      display: flex;
      justify-content: center;
      align-items: center;
      color: var(--primary);
      font-size: 2rem;
      background: var(--white-lighter);
      z-index: 100;
      user-select: none;
    }
    #drag-and-drop-overlay:before {
      content: ' ';
      position: absolute;
      left: 1rem;
      right: 1rem;
      top: 1rem;
      bottom: 1rem;
      border: 1rem dashed currentColor;
    }
    #drag-and-drop-overlay.hidden {
      display: none;
    }

    #main {
      margin-top: 100px;
      display: grid;
      grid-template-columns: 1fr 80px 1fr;
      grid-template-rows: 20px 15px 24px 80px auto;
      row-gap: 10px;
      column-gap: 2rem;
      margin-bottom: 10px;
    }
    #track-title {
      grid-column: 1 / span 2;
      grid-row: 1;
      text-overflow: ellipsis;
      overflow: hidden;
    }
    #controls-time-display {
      grid-column: 3;
      grid-row: 1;
    }
    #controls-progress {
      grid-column: 1 / span 3;
      grid-row: 2;
    }
    #controls-select-file-container {
      grid-column: 1 / span 3;
      grid-row: 3;
    }
    #controls-tracks {
      grid-column: 1;
      grid-row: 4 / span 2;
    }
    #controls-play-pause {
      grid-column: 2;
      grid-row: 4;
    }
    #controls-others {
      grid-column: 3;
      grid-row: 4;

      display: flex;
      flex-direction: row;
      justify-content: flex-end;
      align-items: center;
    }
    controls-loop {
      height: 40px;
    }
    controls-volume {
      margin-inline-start: 10px;
      height: 40px;
    }
    #controls-file-list {
      grid-column: 1 / span 3;
      grid-row: 5;
    }

    @media (max-width: 640px) {
      #main {
        margin-top: 50px;
        grid-template-rows: 20px 20px 15px 24px 80px auto;
      }
      #track-title {
        grid-column: 1 / span 3;
        grid-row: 1;
      }
      #controls-time-display {
        grid-column: 1 / span 3;
        grid-row: 2;
      }
      #controls-progress {
        grid-column: 1 / span 3;
        grid-row: 3;
      }
      #controls-select-file-container {
        grid-column: 1 / span 3;
        grid-row: 4;
      }
      #controls-play-pause {
        grid-column: 2;
        grid-row: 5;
      }
      #controls-others {
        grid-column: 1 / span 3;
        grid-row: 6;
        justify-content: center;
      }
      #controls-tracks {
        grid-column: 1 / span 3;
        grid-row: 7;
      }
    }

    /* Modified from "file" from https://github.com/mdo/wtf-forms/blob/master/wtf-forms.css */
    #controls-select-file-container {
      position: relative;
      display: inline-block;
      cursor: pointer;
      width: 80px;
    }
    #controls-select-file-container > input {
      margin: 0;
      opacity: 0;
      height: 24px;
      width: 100%;
    }
    #controls-select-file-custom {
      position: absolute;
      top: 0;
      right: 0;
      left: 0;

      z-index: 5;

      box-sizing: border-box;
      border-radius: 5px;
      color: var(--primary);
      background-color: var(--primary-lightest-2);
      user-select: none;
      font-size: 12px;
      line-height: 16px;
      height: 24px;
      display: inline-flex;
      align-items: center;
      padding: 2px 4px;
      text-align: center;
    }
    #controls-select-file-custom:after {
      content: 'Select file...';
    }
    #controls-select-file-custom:hover {
      background-color: var(--primary-lightest-1);
    }

    #controls-select-fileinput:focus ~ #controls-select-file-custom {
      box-shadow: 0 0 0 0.075rem #fff, 0 0 0 0.2rem var(--primary-dark);
    }

    @media (prefers-color-scheme: dark) {
      #controls-select-file-custom {
        color: var(--main-text-color);
      }
    }
  `;
}

function readFile(
  file: File
): Promise<{ buffer: string | ArrayBuffer | null; file: File }> {
  return new Promise((resolve) => {
    const fileReader = new FileReader();
    fileReader.addEventListener('loadend', (_ev) => {
      const buffer = fileReader.result;
      resolve({
        buffer,
        file,
      });
    });
    fileReader.readAsArrayBuffer(file);
  });
}

declare global {
  interface HTMLElementTagNameMap {
    'nikku-main': NikkuMain;
  }
}
