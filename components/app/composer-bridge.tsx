"use client";

import { createContext, useContext, useLayoutEffect, useMemo, useRef } from "react";

/*
 * What the panel beside a chat puts in a chat's message box without sending it: the Preview tab's Select and Draw
 * (preview-tab.tsx) put a picture of the page, and for Select a line saying what was picked, in the composer of its
 * bot's chat, for the owner to add their words and send. Select's line comes with where that is in the page's code
 * (lib/app-preview.ts pickCode), which never shows in the box: it goes with the message for the bot (Message.picks). bops-app.tsx holds the bridge (useComposerBridgeHost) and
 * brings that chat up; chat-view.tsx's composer takes what's for it (listen) as soon as it shows. A message sent with
 * any of it is tagged appNote, as Bops' other words about an app are (a shared workspace's members without its apps
 * never see it).
 */

/** What a composer does with what's put in it: the pictures in its tray, the line at the top of its draft (and its `code`, kept out of sight). */
export type ComposerReceiver = (files: File[], line?: string, code?: string) => void;

export type ComposerBridgeHost = {
  /** Put `files` (and `line`, with its `code`) in chat `chatId`'s message box, unsent: that chat comes up, and they're in it once its box shows. */
  attach: (chatId: string, files: File[], line?: string, code?: string) => void;
  /** A composer showing chat `chatId` takes what's for it, now and from then on; what it answers stops that. */
  listen: (chatId: string, receive: ComposerReceiver) => () => void;
};

const Bridge = createContext<ComposerBridgeHost | null>(null);
export const ComposerBridgeProvider = Bridge.Provider;

/** The bridge, for what puts things in a composer: `attach(chatId, files, line?, code?)`. Null outside the app (no chat beside it). */
export function useComposerBridge(): Pick<ComposerBridgeHost, "attach"> | null {
  return useContext(Bridge);
}

/** For the composer: the bridge, to listen on. */
export const useComposerListen = () => useContext(Bridge)?.listen ?? null;

/**
 * The bridge itself (bops-app.tsx): `show(chatId)` brings that chat's message box up. What comes for a chat whose box
 * isn't showing waits, in order, until it shows (its lines one after another, its pictures after the ones before).
 */
export function useComposerBridgeHost(show: (chatId: string) => void): ComposerBridgeHost {
  const shown = useRef(show);
  useLayoutEffect(() => {
    shown.current = show;
  });
  const receivers = useRef(new Map<string, ComposerReceiver>());
  const waiting = useRef(new Map<string, { files: File[]; line?: string; code?: string }[]>());
  return useMemo<ComposerBridgeHost>(
    () => ({
      attach: (chatId, files, line, code) => {
        shown.current(chatId);
        const receive = receivers.current.get(chatId);
        if (receive) return receive(files, line, code);
        waiting.current.set(chatId, [...(waiting.current.get(chatId) ?? []), { files, line, code }]);
      },
      listen: (chatId, receive) => {
        receivers.current.set(chatId, receive);
        const held = waiting.current.get(chatId);
        waiting.current.delete(chatId);
        for (const x of held ?? []) receive(x.files, x.line, x.code);
        return () => {
          if (receivers.current.get(chatId) === receive) receivers.current.delete(chatId);
        };
      },
    }),
    [],
  );
}

/**
 * A draft with `line` put at its top, after the lines put there before it that are still there (`ours`), so picks
 * read in the order they were made; an empty draft gets a new line under it to type on.
 */
export function withLine(draft: string, line: string, ours: ReadonlySet<string>): string {
  if (!draft.trim()) return `${line}\n`;
  const lines = draft.split("\n");
  let i = 0;
  while (i < lines.length && ours.has(lines[i])) i++;
  lines.splice(i, 0, line);
  return lines.join("\n");
}
