import { appWindows, listWindows, mainWindow, sharingMarker } from "@/lib/server/mac-windows";

export const dynamic = "force-dynamic";

/**
 * Which window each app has on the user's Mac (?apps=Notes,Calculator), so the Your Mac tab can stream
 * the windows bots use. Its window id is the one macOS (and Electron's screen capture) knows.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return Response.json({ error: "local only" }, { status: 403 });
  // Every window worth watching (?all=1), for the Watch picker.
  if (url.searchParams.get("all")) return Response.json({ windows: await listWindows().catch(() => []) });
  const apps = (url.searchParams.get("apps") ?? "").split(",").map((a) => a.trim()).filter(Boolean).slice(0, 8);
  const found = await Promise.all(
    apps.map(async (app) => {
      const [w, all] = await Promise.all([mainWindow(app).catch(() => undefined), appWindows(app).catch(() => [])]);
      return w
        ? {
            app,
            windowId: w.window_id,
            title: w.title ?? app,
            owner: w.app_name,
            // Each window's size and where macOS marks it as shared, so a watch's eye can sit on that mark.
            windows: await Promise.all(
              all.slice(0, 6).map(async (x) => ({ windowId: x.window_id, title: x.title || app, size: x.bounds && { w: x.bounds.width, h: x.bounds.height }, marker: await sharingMarker(x) })),
            ),
          }
        : { app };
    }),
  );
  return Response.json({ windows: found });
}
