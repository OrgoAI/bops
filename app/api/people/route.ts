import { notReady } from "@/lib/server/ready";
import { changePeople, findPerson, knownPeople, sendAgain, startPeopleChat, typingInPeople } from "@/lib/server/people";

/**
 * Conversations with other people on Bops (lib/server/people.ts): who you've talked with (GET), and
 * (POST, by `action`) find someone by email, start a conversation, change who's in a group, say you're
 * typing, or send a message that didn't go again.
 */
export async function GET() {
  return Response.json({ people: knownPeople() });
}

export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    email?: string;
    emails?: string[];
    userIds?: string[];
    title?: string;
    chatId?: string;
    add?: string[];
    remove?: string;
    leave?: boolean;
    messageId?: string;
  };
  try {
    switch (body.action) {
      case "find":
        return Response.json({ person: await findPerson(String(body.email ?? "")) });
      case "start":
        return Response.json(await startPeopleChat({ emails: body.emails, userIds: body.userIds, title: body.title }));
      case "members":
        return Response.json(await changePeople(String(body.chatId ?? ""), { add: body.add, remove: body.remove, leave: body.leave, title: body.title }));
      case "typing":
        await typingInPeople(String(body.chatId ?? ""));
        return Response.json({ ok: true });
      case "retry":
        await sendAgain(String(body.messageId ?? ""));
        return Response.json({ ok: true });
      default:
        return Response.json({ error: "What should happen?" }, { status: 400 });
    }
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
