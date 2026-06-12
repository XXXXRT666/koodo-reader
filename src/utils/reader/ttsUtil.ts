import PluginModel from "../../models/Plugin";
import { getAllVoices } from "../common";
import { getTTSAudio } from "../request/reader";
import { isElectron } from "react-device-detect";

declare var window: any;

class BoostAudioPlayer {
  private context: AudioContext;
  private buffer: AudioBuffer;
  private gainNode: GainNode;
  private source: AudioBufferSourceNode | null = null;
  private offset: number = 0;
  private startedAt: number = 0;
  private isStopping: boolean = false;
  private isClosed: boolean = false;
  private endHandlers: (() => void)[] = [];
  private volumeValue: number;
  private boostValue: number;

  constructor(
    context: AudioContext,
    buffer: AudioBuffer,
    volume: number,
    boost: number
  ) {
    this.context = context;
    this.buffer = buffer;
    this.gainNode = this.context.createGain();
    this.gainNode.connect(this.context.destination);
    this.volumeValue = volume;
    this.boostValue = boost;
    this.updateGain();
  }

  private updateGain() {
    this.gainNode.gain.value = this.volumeValue * this.boostValue;
  }

  private closeContext() {
    if (this.isClosed) return;
    this.isClosed = true;
    this.context.close();
  }

  setGain(volume: number, boost: number) {
    this.volumeValue = volume;
    this.boostValue = boost;
    this.updateGain();
  }

  volume(volume?: number) {
    if (typeof volume === "number") {
      this.volumeValue = volume;
      this.updateGain();
    }
    return this.volumeValue;
  }

  play() {
    if (this.source) return;
    if (this.context.state === "suspended") {
      this.context.resume();
    }
    this.source = this.context.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.connect(this.gainNode);
    this.startedAt = this.context.currentTime - this.offset;
    this.isStopping = false;
    this.source.onended = () => {
      this.source = null;
      if (this.isStopping) return;
      this.offset = 0;
      this.closeContext();
      this.endHandlers.forEach((handler) => handler());
    };
    this.source.start(0, this.offset);
  }

  pause() {
    if (!this.source) return;
    this.offset = this.context.currentTime - this.startedAt;
    this.isStopping = true;
    this.source.stop();
    this.source.disconnect();
    this.source = null;
  }

  stop() {
    this.offset = 0;
    this.isStopping = true;
    if (this.source) {
      this.source.stop();
      this.source.disconnect();
      this.source = null;
    }
    this.closeContext();
  }

  unload() {
    this.stop();
  }

  on(event: string, handler: () => void) {
    if (event === "end") {
      this.endHandlers.push(handler);
    }
  }
}

const base64ToArrayBuffer = (base64: string) => {
  const binary = window.atob(base64);
  const arrayBuffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(arrayBuffer);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return arrayBuffer;
};

const isLocalFilePath = (audioPath: string) => {
  return (
    audioPath.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/.test(audioPath) ||
    audioPath.startsWith("\\\\")
  );
};

const loadAudioBuffer = async (audioPath: string, context: AudioContext) => {
  let arrayBuffer: ArrayBuffer;
  if (audioPath.startsWith("data:")) {
    const base64 = audioPath.split(",")[1];
    arrayBuffer = base64ToArrayBuffer(base64);
  } else if (audioPath.startsWith("http") || audioPath.startsWith("blob:")) {
    arrayBuffer = await fetch(audioPath).then((res) => res.arrayBuffer());
  } else if (isElectron && isLocalFilePath(audioPath)) {
    const fs = window.require("fs");
    if (fs.existsSync(audioPath)) {
      const buffer = fs.readFileSync(audioPath);
      arrayBuffer = buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength
      );
    } else {
      arrayBuffer = base64ToArrayBuffer(audioPath);
    }
  } else {
    arrayBuffer = base64ToArrayBuffer(audioPath);
  }
  return context.decodeAudioData(arrayBuffer);
};

class TTSUtil {
  static player: any;
  static audioPaths: { index: number; audioPath: string }[] = [];
  static isPaused: boolean = false;
  static pausedMidSentence: boolean = false;
  static processingIndexes: Set<number> = new Set();
  static async createPlayer(
    audioPath: string,
    volume: number = 1,
    boost: number = 1
  ) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const context = new AudioContextClass();
    const buffer = await loadAudioBuffer(audioPath, context);
    return new BoostAudioPlayer(context, buffer, volume, boost);
  }
  static async readAloud(
    currentIndex: number,
    volume: number = 1,
    boost: number = 1
  ) {
    // 清理比当前 index 小 10 的已朗读缓存
    this.audioPaths = this.audioPaths.filter(
      (item) => item.index >= currentIndex - 10
    );
    return new Promise<string>(async (resolve) => {
      let audioPath = this.audioPaths.find(
        (item) => item.index === currentIndex
      )?.audioPath;
      if (!audioPath) {
        resolve("loaderror");
        return;
      }
      try {
        if (this.player && this.player.stop) {
          this.player.stop();
        }
        this.player = await this.createPlayer(audioPath, volume, boost);
        this.player.play();
        resolve("load");
      } catch (error) {
        console.error(error);
        resolve("loaderror");
      }
    });
  }
  static async cacheAudio(
    startIndex: number,
    speed: number,
    plugins: PluginModel[],
    audioNodeList: {
      text: string;
      voiceName: string;
      voiceEngine: string;
    }[],
    targetCacheCount: number,
    isFirst: boolean,
    isOfficialAIVoice: boolean
  ) {
    this.isPaused = false;

    if (isOfficialAIVoice) {
      const cacheCount = Math.min(
        targetCacheCount,
        audioNodeList.length - startIndex
      );
      // 并发执行，并发数量为3，但保证添加顺序
      const CONCURRENT_LIMIT = 5;
      //删除index小于startIndex的缓存
      this.audioPaths = this.audioPaths.filter(
        (item) => item.index >= startIndex - 5
      );

      for (let i = 0; i < cacheCount; i += CONCURRENT_LIMIT) {
        const batch: any[] = [];

        for (let j = 0; j < CONCURRENT_LIMIT && i + j < cacheCount; j++) {
          const index = startIndex + i + j;
          if (index >= audioNodeList.length) break;

          // 如果已经缓存过或正在处理中，跳过
          if (
            this.audioPaths.find((item) => item.index === index) ||
            this.processingIndexes.has(index)
          ) {
            continue;
          }

          // 标记为正在处理
          this.processingIndexes.add(index);

          const audioNode = audioNodeList[index];
          let plugin = plugins.find(
            (item) => item.key === audioNode.voiceEngine
          );
          if (!plugin) {
            return "error";
          }
          let voice = (plugin.voiceList as any[]).find(
            (voice) => voice.name === audioNode.voiceName
          );
          if (!voice) {
            return "error";
          }
          // 创建异步任务
          const task = this.getAudioPath(
            audioNode.text,
            speed,
            audioNode.voiceEngine,
            plugin,
            voice,
            isFirst
          )
            .then(async (res) => {
              // 处理完成后，从处理集合中移除
              this.processingIndexes.delete(index);
              if (res) {
                return { index, audioPath: res };
              } else {
                this.isPaused = true;
                return null;
              }
            })
            .catch((error) => {
              // 出错时也要从处理集合中移除
              this.processingIndexes.delete(index);
              console.error(`Error caching audio for index ${index}:`, error);
              return null;
            });
          batch.push(task);
        }

        // 等待当前批次完成
        const batchResults = await Promise.all(batch);

        // 将结果存储到 Map 中
        for (const result of batchResults) {
          if (result) {
            if (this.audioPaths.find((item) => item.index === result.index)) {
              this.audioPaths = this.audioPaths.map((item) => {
                if (item.index === result.index) {
                  return result;
                } else {
                  return item;
                }
              });
            } else {
              this.audioPaths.push(result);
            }
          } else {
            this.isPaused = true;
            return "error";
          }
        }
      }
    } else {
      let maxCacheIndex = Math.min(
        startIndex + targetCacheCount,
        audioNodeList.length
      );
      for (let index = startIndex; index < maxCacheIndex; index++) {
        if (this.isPaused) {
          break;
        }
        // 如果已经缓存过或正在处理中，跳过
        if (
          this.audioPaths.find((item) => item.index === index) ||
          this.processingIndexes.has(index)
        ) {
          continue;
        }
        // 标记为正在处理
        this.processingIndexes.add(index);
        const audioNode = audioNodeList[index];
        let plugin = plugins.find((item) => item.key === audioNode.voiceEngine);
        if (!plugin) {
          return "error";
        }
        let voice = (plugin.voiceList as any[]).find(
          (voice) => voice.name === audioNode.voiceName
        );
        if (!voice) {
          return "error";
        }
        let audioPath = await this.getAudioPath(
          audioNode.text,
          speed,
          audioNode.voiceEngine,
          plugin,
          voice,
          isFirst
        );
        // 处理完成后，从处理集合中移除
        this.processingIndexes.delete(index);
        if (audioPath) {
          this.audioPaths.push({ index: index, audioPath: audioPath });
        } else {
          this.isPaused = true;
          break;
        }
      }
    }
  }
  static async pauseAudio() {
    if (this.player) {
      this.player.pause();
      this.isPaused = true;
      this.pausedMidSentence = true;
    }
  }
  static resumeAudio(): boolean {
    if (this.player && this.pausedMidSentence) {
      this.player.play();
      this.isPaused = false;
      this.pausedMidSentence = false;
      return true;
    }
    return false;
  }
  static async stopAudio() {
    if (this.player && this.player.stop) {
      this.player.stop();
      this.isPaused = true;
      this.pausedMidSentence = false;
      setTimeout(() => {
        this.clearAudioPaths();
        this.audioPaths = [];
        this.processingIndexes.clear();
      }, 1000);
    }
  }
  static async clearAudioPaths() {
    if (!isElectron) return;
    window.require("electron").ipcRenderer.invoke("clear-tts");
  }
  static getAudioPaths() {
    return this.audioPaths;
  }
  static async getAudioPath(
    text: string,
    speed: number,
    voiceEngine: string,
    plugin,
    voice,
    isFirst: boolean
  ) {
    if (voiceEngine === "official-ai-voice-plugin") {
      let res = await getTTSAudio(
        text,
        voice.language,
        voice.name,
        (speed + 100) / 100,
        1.0,
        isFirst
      );
      if (res && res.data && res.data.audio_base64) {
        return res.data.audio_base64;
      }
      return "";
    } else {
      let audioPath = await window
        .require("electron")
        .ipcRenderer.invoke("generate-tts", {
          text: text,
          speed,
          plugin: plugin,
          config: voice.config,
        });
      return audioPath;
    }
  }
  static setAudioPaths() {
    this.audioPaths = [];
    this.processingIndexes.clear();
    this.pausedMidSentence = false;
  }
  static getPlayer() {
    return this.player;
  }
  static getVoiceList(plugins: PluginModel[]) {
    let voices = getAllVoices(plugins);

    return voices;
  }
}
export default TTSUtil;
