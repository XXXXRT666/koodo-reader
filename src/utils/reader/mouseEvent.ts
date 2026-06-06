import { ConfigService } from "../../assets/lib/kookit-extra-browser.min";
import { isElectron } from "react-device-detect";
import { getIframeDoc, getIframeWin } from "./docUtil";
import { handleExitFullScreen, handleFullScreen, sleep } from "../common";
import Hammer from "hammerjs";
import TTSUtil from "./ttsUtil";
declare var window: any;

let throttleTime =
  ConfigService.getReaderConfig("isSliding") === "yes" ? 1000 : 100;

export const getSelection = (format: string, bookKey?: string) => {
  let docs = getIframeDoc(format, bookKey);
  let text = "";
  for (let i = 0; i < docs.length; i++) {
    let doc = docs[i];
    if (!doc) continue;
    let sel = doc.getSelection();
    if (!sel) continue;
    text = sel.toString();
    text = text && text.trim();
    if (text) {
      break;
    }
  }

  return text;
};

export const getSelectionSentence = (
  format: string,
  bookKey?: string
): string => {
  let docs = getIframeDoc(format, bookKey);
  for (let i = 0; i < docs.length; i++) {
    let doc = docs[i];
    if (!doc) continue;
    let sel = doc.getSelection();
    if (!sel || !sel.toString().trim()) continue;
    try {
      let range = sel.getRangeAt(0);
      let container = range.commonAncestorContainer;
      // Walk up to a text-containing element
      let el: Node | null =
        container.nodeType === Node.TEXT_NODE
          ? container.parentElement
          : container;
      let fullText = (el as Element)?.textContent || "";
      let selectedText = sel.toString().trim();
      // Split on sentence-ending punctuation to find the sentence
      let sentences = fullText.split(/(?<=[.!?。！？])\s*/);
      for (let s of sentences) {
        if (s.includes(selectedText)) {
          return s.trim();
        }
      }
      // Fallback: return the whole text content of the container
      return fullText.trim();
    } catch {
      // ignore
    }
  }
  return "";
};
export const searchInTheBook = (
  keyword: string,
  format: string,
  isSearch: boolean
) => {
  let leftPanel = document.querySelector(".left-panel");
  const clickEvent = new MouseEvent("click", {
    view: window,
    bubbles: true,
    cancelable: true,
  });
  if (!leftPanel) return;
  leftPanel.dispatchEvent(clickEvent);
  const focusEvent = new MouseEvent("focus", {
    view: window,
    bubbles: true,
    cancelable: true,
  });
  let searchBox: any = document.querySelector(".header-search-box");
  searchBox.dispatchEvent(focusEvent);
  let searchIcon = document.querySelector(".header-search-icon");
  searchIcon?.dispatchEvent(clickEvent);
  if (isSearch) {
    searchBox.value = getSelection(format) || keyword;
  }
  const keyEvent: any = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    keyCode: 13,
  } as any);
  searchBox.dispatchEvent(keyEvent);
};
export const openTableOfContents = () => {
  let leftPanel = document.querySelector(".left-panel");
  const clickEvent = new MouseEvent("click", {
    view: window,
    bubbles: true,
    cancelable: true,
  });
  if (!leftPanel) return;
  leftPanel.dispatchEvent(clickEvent);
};
let lock = false; //prevent from clicking too fasts
const arrowKeys = async (
  rendition: any,
  keyCode: number,
  event: any,
  readerMode: string
) => {
  if (
    event.target.tagName.toLowerCase() === "textarea" ||
    event.target.tagName.toLowerCase() === "input"
  ) {
    return;
  }
  if (readerMode === "scroll" && (keyCode === 38 || keyCode === 40)) {
  } else if (keyCode === 33 || keyCode === 37 || keyCode === 38) {
    event.preventDefault();
    await rendition.prev();
  } else if (
    keyCode === 32 ||
    keyCode === 34 ||
    keyCode === 39 ||
    keyCode === 40
  ) {
    event.preventDefault();
    await rendition.next();
  }
  handleShortcut(event);
};

const getScrollOffset = (offset: number) => Math.abs(Math.ceil(offset));

const isAtChapterBoundary = (rendition: any, direction: "prev" | "next") => {
  let doc = rendition.getDocument?.();
  let element = rendition.element || document.getElementById("page-area");
  if (!doc) return false;
  if (direction === "prev") {
    if (rendition.readerMode === "scroll") {
      return !element || getScrollOffset(element.scrollTop) === 0;
    }
    if (rendition.isVertical?.()) {
      return getScrollOffset(doc.body.scrollTop) === 0;
    }
    return getScrollOffset(doc.body.scrollLeft) === 0;
  }
  if (rendition.readerMode === "scroll") {
    if (!element) return false;
    return (
      Math.abs(
        element.scrollHeight -
          getScrollOffset(element.scrollTop) -
          element.clientHeight
      ) < 20
    );
  }
  if (rendition.isVertical?.()) {
    return (
      Math.abs(
        doc.body.scrollHeight -
          getScrollOffset(doc.body.scrollTop) -
          doc.body.clientHeight
      ) < 50
    );
  }
  return (
    Math.abs(
      doc.body.scrollWidth -
        getScrollOffset(doc.body.scrollLeft) -
        doc.body.clientWidth
    ) < 50
  );
};

const navigateWithinChapter = async (
  rendition: any,
  direction: "prev" | "next"
) => {
  if (isAtChapterBoundary(rendition, direction)) return;
  if (direction === "prev") {
    await rendition.prev();
  } else {
    await rendition.next();
  }
};

const mouseChrome = async (rendition: any, deltaY: number) => {
  if (deltaY < 0) {
    await navigateWithinChapter(rendition, "prev");
  }
  if (deltaY > 0) {
    await navigateWithinChapter(rendition, "next");
  }
};

const handleShortcut = (event: any) => {
  if (event.keyCode === 9) {
    if (isElectron) {
      event.preventDefault();
      window.require("electron").ipcRenderer.invoke("hide-reader", "ping");
    }
  }
  if (event.keyCode === 27) {
    if (ConfigService.getReaderConfig("isFullscreen") === "yes") {
      ConfigService.setReaderConfig("isFullscreen", "no");
      handleExitFullScreen();
    } else {
      ConfigService.setReaderConfig("isFullscreen", "no");
      window.speechSynthesis && window.speechSynthesis.cancel();
      TTSUtil.pauseAudio();
      if (isElectron) {
        if (ConfigService.getReaderConfig("isOpenInMain") === "yes") {
          window.require("electron").ipcRenderer.invoke("exit-tab", "ping");
        } else {
          window.close();
        }
      } else {
        ConfigService.setReaderConfig("isFinishWebReading", "yes");
        window.close();
      }
    }
  }
  if (event.keyCode === 122) {
    if (isElectron) {
      event.preventDefault();
      ConfigService.getReaderConfig("isFullscreen") !== "yes"
        ? handleFullScreen()
        : handleExitFullScreen();

      if (ConfigService.getReaderConfig("isFullscreen") === "yes") {
        ConfigService.setReaderConfig("isFullscreen", "no");
      } else {
        ConfigService.setReaderConfig("isFullscreen", "yes");
      }
    }
  }
  if (event.keyCode === 123) {
    if (isElectron && ConfigService.getReaderConfig("isMergeWord")) {
      event.preventDefault();
      ConfigService.setReaderConfig(
        "isMergeWord",
        ConfigService.getReaderConfig("isMergeWord") === "yes" ? "no" : "yes"
      );
      window.require("electron").ipcRenderer.invoke("switch-moyu", "ping");
    }
  }
  if (event.keyCode === 70 && event.ctrlKey) {
    event.preventDefault();
    searchInTheBook("", "", false);
  }
  if (event.keyCode === 66 && event.ctrlKey) {
    event.preventDefault();
    openTableOfContents();
  }
};

const gesture = async (rendition: any, type: string) => {
  if (type === "panleft" || type === "panup") {
    await navigateWithinChapter(rendition, "next");
  }
  if (type === "panright" || type === "pandown") {
    await navigateWithinChapter(rendition, "prev");
  }
};

const handleLocation = (key: string, rendition: any) => {
  let position = rendition.getPosition();
  ConfigService.setObjectConfig(key, position, "recordLocation");
};
let lastScaleTime = 0;
export const bindHtmlEvent = (
  rendition: any,
  doc: any,
  key: string = "",
  readerMode: string = "",
  handleScale: (scale: string) => void,
  renderBookFunc: () => void
) => {
  doc.addEventListener(
    "keydown",
    async (event) => {
      if (lock) return;
      lock = true;
      await arrowKeys(rendition, event.keyCode, event, readerMode);
      handleLocation(key, rendition);
      setTimeout(() => (lock = false), throttleTime);
    },
    { passive: false }
  );

  doc.addEventListener(
    "wheel",
    async (event) => {
      if (event.ctrlKey && readerMode !== "double") {
        const currentTime = Date.now();
        if (currentTime - lastScaleTime < 1500) {
          return;
        }
        lastScaleTime = currentTime;
        event.preventDefault();
        let scale = parseFloat(ConfigService.getReaderConfig("scale") || "1");
        if (event.deltaY < 0) {
          ConfigService.setReaderConfig("scale", scale + 0.1 + "");
        } else {
          ConfigService.setReaderConfig("scale", scale - 0.1 + "");
        }
        handleScale(ConfigService.getReaderConfig("scale") || "1");
        renderBookFunc();
        return;
      }
      if (lock) return;
      lock = true;
      if (readerMode === "scroll") {
        await sleep(200);
        await rendition.record();
      } else {
        if (Math.abs(event.deltaX) === 0) {
          await mouseChrome(rendition, event.deltaY);
        }
      }
      handleLocation(key, rendition);
      setTimeout(() => (lock = false), throttleTime);
    },
    { passive: false }
  );

  window.addEventListener(
    "keydown",
    async (event) => {
      if (lock) return;
      lock = true;
      await arrowKeys(rendition, event.keyCode, event, readerMode);
      handleLocation(key, rendition);
      setTimeout(() => (lock = false), throttleTime);
    },
    { passive: false }
  );

  if (ConfigService.getReaderConfig("isTouch") === "yes") {
    const mc = new Hammer(doc);
    mc.on("panleft panright panup pandown", async (event: any) => {
      if (readerMode === "scroll") {
        return;
      }
      if (lock || event.pointerType === "mouse") return;
      lock = true;
      await gesture(rendition, event.type);
      handleLocation(key, rendition);
      setTimeout(() => (lock = false), throttleTime);
    });
  }

  doc.addEventListener(
    "touchend",
    async () => {
      if (lock) return;
      lock = true;
      if (readerMode === "scroll") {
        await sleep(200);
        await rendition.record();
      }
      handleLocation(key, rendition);
      setTimeout(() => (lock = false), throttleTime);
    },
    { passive: false }
  );
};
export const htmlMouseEvent = (
  rendition: any,
  key: string,
  readerMode: string,
  format: string,
  handleScale: (scale: string) => void,
  renderBookFunc: () => void
) => {
  rendition.on("rendered", () => {
    let iframe = getIframeWin();
    if (!iframe) return;
    iframe?.focus();
    let docs = getIframeDoc(format, key);
    for (let i = 0; i < docs.length; i++) {
      let doc = docs[i];
      if (!doc) continue;
      bindHtmlEvent(
        rendition,
        doc,
        key,
        readerMode,
        handleScale,
        renderBookFunc
      );
    }
    lock = false;
  });
};
