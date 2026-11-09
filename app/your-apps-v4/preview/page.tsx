// A local sample destination for the approval prototype. No real hosted app is contacted.
export default async function SamplePreview({searchParams}: {searchParams: Promise<{view?: string; app?: string}>}) {
  const {view, app} = await searchParams;
  return <main className="flex min-h-screen flex-col gap-6 bg-paper px-8 py-8 font-sans text-ink" data-sample-preview>
    <span className="self-start rounded-full bg-desk px-3 py-1 text-[13px]">{view === "live" ? "Live website sample" : "Preview sample"}</span>
    <h1 className="text-[26px] font-bold leading-8">{app || "Four Corners"}</h1>
    <p className="text-[20px] leading-7">{view === "live" ? "Your next project starts here." : "Pick a project type on the left to get started."}</p>
  </main>;
}
