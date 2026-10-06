"use client";

import { useEffect, useState } from "react";

type Article = { url: string; title: string; site: string; blocks: { kind: string; text?: string; src?: string; alt?: string }[] };

/**
 * Whatever the bot is reading, as a clean page in Bops' own type: the article's headings,
 * paragraphs, lists, quotes and images, without the site's chrome. It follows the bot as it reads
 * (refreshing every few seconds), so you can skim along.
 */
export function ReaderView({ botId, display, className }: { botId: string; display: number; className?: string }) {
  const [article, setArticle] = useState<Article | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let gone = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const res = await fetch(`/api/reader?bot=${botId}&display=${display}`, { cache: "no-store" });
        const json = (await res.json()) as Article & { error?: string };
        if (gone) return;
        if (json.error) setError(true);
        else {
          setError(false);
          // Only re-render when the page actually changed, so the scroll position holds.
          setArticle((a) => (a && a.url === json.url && a.blocks.length === json.blocks.length ? a : json));
        }
      } catch {
        if (!gone) setError(true);
      }
      if (!gone) timer = setTimeout(() => void load(), 4000);
    };
    void load();
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [botId, display]);

  if (!article) return <div className={`flex items-center justify-center bg-white text-[12px] text-[#9A9A98] ${className ?? ""}`}>{error ? "Couldn't read this page" : "Reading the page…"}</div>;
  return (
    <div className={`overflow-y-auto bg-white ${className ?? ""}`}>
      <article className="mx-auto flex max-w-[620px] flex-col gap-3 px-8 pb-16 pt-9">
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-[#9A9A98]">{article.site}</span>
        <h1 className="text-[28px] font-semibold leading-[34px] tracking-[-0.02em] text-ink">{article.title}</h1>
        <div className="h-px bg-[#EFEFED]" />
        {article.blocks.length === 0 && <p className="text-[14px] text-[#6B6B6B]">There isn&apos;t much to read on this page.</p>}
        {article.blocks.map((b, i) => {
          if (b.kind === "img")
            // eslint-disable-next-line @next/next/no-img-element
            return <img key={i} src={b.src} alt={b.alt} className="my-1 max-h-[360px] w-full rounded-xl object-cover" />;
          if (b.kind === "h1" || b.kind === "h2") return <h2 key={i} className="pt-3 text-[19px] font-semibold leading-6 tracking-[-0.01em] text-ink">{b.text}</h2>;
          if (b.kind === "h3") return <h3 key={i} className="pt-2 text-[16px] font-semibold leading-[22px] text-ink">{b.text}</h3>;
          if (b.kind === "li") return <p key={i} className="pl-4 text-[15px] leading-[25px] text-[#2A2A28] before:-ml-4 before:mr-2 before:content-['•']">{b.text}</p>;
          if (b.kind === "blockquote") return <blockquote key={i} className="border-l-2 border-[#E2E2DF] pl-4 text-[15px] italic leading-[25px] text-[#3A3A38]">{b.text}</blockquote>;
          if (b.kind === "pre") return <pre key={i} className="overflow-x-auto rounded-xl bg-[#F7F7F6] p-3 font-mono text-[12.5px] leading-5">{b.text}</pre>;
          return <p key={i} className="text-[15px] leading-[25px] text-[#2A2A28]">{b.text}</p>;
        })}
      </article>
    </div>
  );
}
