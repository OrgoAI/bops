import { NextResponse, type NextRequest } from "next/server";
import { refused } from "./lib/api-guard";

/**
 * Who may call Bops' API: lib/api-guard.ts says, for every call under /api but the one that takes a file's bytes
 * as they arrive (/api/bots/files: Next would copy at most 10 MB of a body for this proxy, so it asks the guard
 * itself, first thing).
 */
export function proxy(request: NextRequest) {
  return refused(request) ?? NextResponse.next();
}

export const config = { matcher: "/api/((?!bots/files$).*)" };
