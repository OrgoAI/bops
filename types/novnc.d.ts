declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    /** `urlOrChannel`: a websocket URL, or a WebSocket already opening (noVNC takes it over). */
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: { shared?: boolean; credentials?: { password?: string }; wsProtocols?: string[] });
    viewOnly: boolean;
    scaleViewport: boolean;
    clipViewport: boolean;
    resizeSession: boolean;
    focusOnClick: boolean;
    showDotCursor: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    focus(): void;
    disconnect(): void;
  }
}

// noVNC's keyboard (X11 keysyms from key events), for the WebRTC view's typing. The package exports
// only its RFB client, so components/app/rtc-desktop.tsx imports the file by its path.
declare module "@/node_modules/@novnc/novnc/core/input/keyboard.js" {
  export default class Keyboard {
    constructor(target: HTMLElement);
    onkeyevent: (keysym: number, code: string, down: boolean) => void;
    grab(): void;
    ungrab(): void;
  }
}
