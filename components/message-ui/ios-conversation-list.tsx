"use client";

import { useState, type ComponentProps, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { cn } from "@/lib/utils";
import { IosLargeTitle } from "@/components/message-ui/ios-nav-bar";
import { IosMicIcon } from "@/components/message-ui/ios-composer";
import { GroupAvatar, groupAvatarMetrics, type GroupParticipant } from "@/components/message-ui/group-avatar";

/**
 * iOS 26 Messages list screen, measured from `references/ios/captures/list-light.png` and
 * `list-dark.png` (402×874). Large title 34pt bold at x 16 (baseline 152); rows 86.67 tall from
 * y 168: avatar Ø45 at x 26 (top +20) with 21pt semibold initials, name 17pt semibold at x 83 with
 * its cap height centered 22.33 below the row top, time 15pt secondary whose ink right edge sits at
 * x 364.0 (native formats it with a narrow no-break space, "1:48 AM"), chevron 7×12 at x 378.33,
 * preview 15pt secondary on a 20pt line (up to two lines), 1pt separator from x 83 to 386 at the
 * row bottom. Rows are placed with transforms so their third-point pitch is not snapped to whole pixels. Floating bottom bar: glass search pill x 28–314, y 798–846 (magnifier, "Search"
 * 17pt medium, mic) and a Ø48 glass compose button centered (350, 822). Glass shadows are painted
 * on a layer beneath both surfaces.
 *
 * Both bottom-bar surfaces are plain circular capsules: fitting the pill's left cap to
 * |u|^n + |v|^n = 1 over r 24 gives n = 2.045 (rmse 0.058 pt) and the compose circle n = 2.015, so
 * neither uses a continuous corner. Magnifier: ring outer diameter 13.49 centered (54.75, 820.22),
 * stroke 1.73; handle a 45deg stroke 2.47 wide ending at (63.17, 828.77). Its SVG box is placed on
 * a whole pixel (top 14) because Chrome snaps an SVG layer's origin down to the nearest CSS pixel,
 * so the ring and handle carry the sub-pixel offsets instead. Compose glyph: a rounded square
 * whose outer box is exactly 19x19 at (340, 813.33), stroke 1.83, outer corner radius 4.05;
 * pencil a 45deg stroke 2.10 wide. Avatar gradient endpoints are a least-squares fit down the
 * avatar's center column.
 *
 * Neither capture shows these, so they are not measured against pixels: a preview long enough to
 * wrap to two lines, a name or preview long enough to truncate, an unread row, and a row with a
 * finger on it. The last two are read out of ChatKit instead; see `UNREAD` and the note above
 * `--ios-list-highlight`.
 *
 * Nor the glass fill's alpha. Both captures have the last row ending 400pt above the bottom bar, so
 * every point of both surfaces sits over the flat page: sampling their glass-only interiors (the pill
 * left of the magnifier, its mid span, right of the mic, and the compose circle either side of its
 * glyph) gives 255 in light and 25 in dark in the capture and in our render alike, mean signed error
 * 0.00 per channel on all five. That pins the light fill to white at any alpha and the dark fill only
 * to alpha × colour = 25. The 90% is carried over from the nav bar, where the same is true; see the
 * note there. It decides how much of a row scrolled under the bar shows through, which nothing here
 * measures.
 */
export type IosConversation = {
  id: string;
  name: string;
  initials?: string;
  /** Contact photo, cropped to the existing circular avatar. */
  photo?: string;
  preview: string;
  time: string;
  unread?: boolean;
  /**
   * The people in a group conversation. Two or more draws `group-avatar.tsx`'s Snowglobe stack on
   * the framework's `conversationListContactImageDiameter` (45 on the phone) instead of the monogram
   * circle; one, or none, keeps the monogram, because native skips `SnowglobeUIView` entirely for a
   * single contact and a lone face must not get a plate.
   */
  members?: readonly GroupParticipant[];
};

export type IosConversationListProps = Omit<ComponentProps<"div">, "onSelect"> & {
  conversations: IosConversation[];
  onSelect?: (conversation: IosConversation) => void;
  onCompose?: () => void;
  onSearch?: () => void;
  title?: string;
  /** Space reserved above the title for the status bar. */
  topInset?: number;
  /**
   * The row drawn as though a finger were on it. Controlled; leave it out and the list follows the
   * real pointer, which is what a product wants. It exists so a scenario can hold the highlight
   * still for a screenshot — the state itself is a live pointer's, and a seeked frame has no pointer
   * in it. `null` forces no row, the same as a lifted finger.
   */
  pressedId?: string | null;
};

const font = "-apple-system, BlinkMacSystemFont, sans-serif";
const ROW = 86.6667;
/**
 * The name is laid out on its ink, not on a line box: `top: 14` with `lineHeight: 1` puts its cap
 * line where the capture's is (ours 183.33 device-pt against the capture's 183.67, one device pixel
 * at 3x). A 17 px line box around a 17 px font is smaller than the font's own ascent + descent
 * though - SF Pro Text asks for about 20.3 - so `truncate`'s `overflow: hidden` was cutting the flat
 * bottom off every descender, which is what the row reads as when the name is crowded by the
 * preview under it. The clip box has to grow without the text moving, so the bleed is added as
 * padding and taken back off `top`: `overflow: hidden` clips at the padding box, padding-block does
 * not touch a left/right-anchored element's width, and the content box stays at 14. 3 covers SF's
 * descender (0.156 em = 2.65 at 17) and its accent room with a little to spare; the row is 86.67
 * tall so nothing else is near enough to collide.
 */
const NAME_BLEED = 3;
/**
 * The unread dot, read out of ChatKit 26.5 rather than a capture: neither list capture contains an
 * unread row, so nothing here is measured against pixels. `-[CKUIBehaviorPhone unreadIndicatorImageViewSize]`
 * is {11, 11}, and `_calculateIndicatorFrameForSize:trailing:displayScale:insets:` puts it at
 * (`conversationListCellLeftMargin` 26 - 11) / 2 horizontally and centred on the row vertically.
 * `shouldUnreadIndicatorChangeOnSelection` is NO on iOS, so unlike macOS the dot never turns white.
 */
const UNREAD = 11;
const UNREAD_LEFT = 7.5;

/**
 * The touch highlight: what a row fills with while a finger is on it.
 *
 * **No capture holds one** — scanning the row gutter (device column 30) down the whole list of both
 * `list-light.png` and `list-dark.png` returns one flat run, #ffffff for 1900 px and #000000 for
 * 1920 px, so neither capture has a pressed row in it. The colour is read out of ChatKit 26.5
 * instead, and two independent readings agree on it:
 *
 * - `-[CKUITheme conversationListSelectedCellColor]` (the phone theme; there is no `CKUIThemePhone`,
 *   the base class *is* it) resolves to **#dcdcdc opaque light / #464646 opaque dark**. The same
 *   selector is `#0088ff / #0091ff` on `CKUIThemePad` — iPadOS's persistent blue list selection —
 *   and **null** on `CKUIThemeMac`, which is why the Mac's own row fill comes from a capture and not
 *   from here. `-[CKUITheme detailsSelectedCellColor]` is the same #dcdcdc / #464646 pair, and a
 *   details row has no persistent selection at all, so on the phone this colour is a *tap*
 *   highlight, not a selection.
 * - `+[UIBackgroundConfiguration listPlainCellConfiguration]` resolved for a `selected`
 *   `UICellConfigurationState` returns the same #dcdcdc / #464646 at both idiom 0 and idiom 5. So
 *   the value is UIKit's own plain-list fill and ChatKit is restating it, not overriding it.
 *
 * `CKConversationListCell` is a **`UITableViewCell`** (not a collection-view cell), and its
 * `selectionStyle` is `Default`. A `UITableViewCell` shows its `selectedBackgroundView` for
 * `highlighted` as well as `selected`, which on a phone — where a row is never left selected — is
 * only ever the moment a finger is down. Hence: on at touch-down, off at lift, no fade.
 *
 * The labels do **not** change. `-[CKUIBehaviorPhone useSelectedAppearanceForConversationCellState:
 * traitCollection:]` returns YES for `selected` and **NO for `highlighted` alone** (probed over all
 * four state combinations in both appearances), so nothing in the row goes white under the finger —
 * and the unread dot stays blue for the separate reason already noted above
 * (`shouldUnreadIndicatorChangeOnSelection` is NO on the phone).
 *
 * **UNMEASURED: the separators.** `UITableView` hides the separator at a highlighted row's own
 * bottom edge and the one above it, so the fill reads as one unbroken band; that is the same rule
 * `macos-sidebar.tsx` already records for its selected row. No capture holds it here, because no
 * capture holds a pressed row at all.
 *
 * The two values live in `--ios-list-highlight` in `vars` below.
 */
const vars =
  "[--ios-list-bg:#ffffff] [--ios-list-label:#000000] [--ios-list-secondary:#8a8a8e] [--ios-list-chevron:#c5c5c7] [--ios-list-separator:#e8e8e8] " +
  "[--ios-list-glass:rgba(255,255,255,0.9)] [--ios-list-rim:none] [--ios-list-shadow:0_6px_36px_4px_rgba(0,0,0,0.065)] [--ios-list-shadow-round:0_5px_20px_6px_rgba(0,0,0,0.055)] [--ios-list-glyph:#1a1919] [--ios-list-field:#8a8a8e] " +
  // `--ios-list-highlight` is `conversationListSelectedCellColor` above; the literals stay spelled out
  // here because Tailwind reads these class names out of the source text and cannot see through a
  // template hole.
  "[--ios-list-avatar-top:#a9c2e1] [--ios-list-avatar-bottom:#747fb9] [--ios-list-unread:#0088ff] [--ios-list-highlight:#dcdcdc] " +
  "dark:[--ios-list-bg:#000000] dark:[--ios-list-label:#ffffff] dark:[--ios-list-secondary:#8d8d93] dark:[--ios-list-chevron:#464649] dark:[--ios-list-separator:#2a2a2c] dark:[--ios-list-unread:#0091ff] " +
  "dark:[--ios-list-glass:rgba(28,28,28,0.9)] dark:[--ios-list-rim:inset_0_0_0_1px_rgba(255,255,255,0.09)] dark:[--ios-list-shadow:none] dark:[--ios-list-shadow-round:none] dark:[--ios-list-glyph:#f4f3f4] dark:[--ios-list-field:#97979d] " +
  "dark:[--ios-list-avatar-top:#575368] dark:[--ios-list-avatar-bottom:#302649] dark:[--ios-list-highlight:#464646]";

/** `clip` stops the shadow at the midpoint of the 12pt gap toward a neighboring glass element, so the two shadows read as one (they never add up on the device). */
function GlassLayers({ round = false, clip }: { round?: boolean; clip?: "left" | "right" }) {
  return (
    <>
      <span aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 rounded-[inherit] [corner-shape:inherit]" style={{ boxShadow: round ? "var(--ios-list-shadow-round)" : "var(--ios-list-shadow)", clipPath: clip ? `inset(-60px ${clip === "right" ? "-6px" : "-60px"} -60px ${clip === "left" ? "-6px" : "-60px"})` : undefined }} />
      <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[inherit] [corner-shape:inherit]" style={{ background: "var(--ios-list-glass)", boxShadow: "var(--ios-list-rim)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)" }} />
    </>
  );
}

function initialsOf(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map(part => part[0] ?? "").join("").toUpperCase();
}

export type IosConversationRowProps = Omit<ComponentProps<"button">, "onSelect"> & {
  conversation: IosConversation;
  onSelect?: (conversation: IosConversation) => void;
  pressed?: boolean;
  separator?: boolean;
};

/** One native-sized row, also usable in a custom list. Inherits the surrounding light/dark theme. */
export function IosConversationRow({ conversation, onSelect, pressed, separator = true, className, style,
  onClick, onPointerDown, onPointerUp, onPointerCancel, onPointerLeave, ...props }: IosConversationRowProps) {
  const [held, setHeld] = useState(false);
  const highlighted = pressed ?? held;
  const letters = conversation.initials ?? initialsOf(conversation.name);
  return (
    <button type="button" data-slot="ios-conversation-row" data-pressed={highlighted || undefined} onClick={event => { onClick?.(event); if (!event.defaultPrevented) onSelect?.(conversation); }} aria-label={`${conversation.unread ? "Unread. " : ""}${conversation.name}, ${conversation.time}, ${conversation.preview}`}
      onPointerDown={event => { if (event.button === 0) setHeld(true); onPointerDown?.(event); }}
      onPointerUp={event => { setHeld(false); onPointerUp?.(event); }}
      onPointerCancel={event => { setHeld(false); onPointerCancel?.(event); }}
      onPointerLeave={event => { setHeld(false); onPointerLeave?.(event); }}
      className={cn("relative block w-full text-left select-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-500", vars, className)}
      style={{ height: ROW, fontFamily: font, background: highlighted ? "var(--ios-list-highlight)" : "transparent", ...style }} {...props}>
      {conversation.unread && <span aria-hidden="true" data-slot="unread" className="absolute rounded-full bg-[var(--ios-list-unread)]" style={{ left: UNREAD_LEFT, top: (ROW - UNREAD) / 2, width: UNREAD, height: UNREAD }} />}
      {conversation.members && conversation.members.length > 1 ? (
        <GroupAvatar aria-hidden="true" data-slot="avatar" participants={conversation.members} role={undefined}
          size={groupAvatarMetrics.phone.conversationList} className="absolute" style={{ left: 26, top: 20 }} />
      ) : (
        <span aria-hidden="true" data-slot="avatar" className="absolute flex items-center justify-center overflow-hidden rounded-full text-white"
          style={{ left: 26, top: 20, width: 45, height: 45, fontSize: 21, lineHeight: 1, fontWeight: 600, background: "linear-gradient(var(--ios-list-avatar-top), var(--ios-list-avatar-bottom))" }}>
          {conversation.photo ? (
            // eslint-disable-next-line @next/next/no-img-element -- framework-neutral registry component
            <img src={conversation.photo} alt="" className="size-full object-cover" draggable={false} />
          ) : letters}
        </span>
      )}
      <span aria-hidden="true" data-slot="name" className="absolute truncate" style={{ left: 83, right: 96, top: 14 - NAME_BLEED, paddingBlock: NAME_BLEED, transform: "translateY(0.3333px)", fontSize: 17, lineHeight: 1, fontWeight: 600, letterSpacing: 0, color: "var(--ios-list-label)" }}>
        {conversation.name}
      </span>
      <span aria-hidden="true" data-slot="time" className="absolute whitespace-nowrap" style={{ right: 37.1167, top: 15, transform: "translateY(0.3333px)", fontSize: 15, lineHeight: 1, letterSpacing: 0, color: "var(--ios-list-secondary)" }}>
        {conversation.time}
      </span>
      <svg aria-hidden="true" data-slot="chevron" className="absolute" style={{ right: 15, top: 15, transform: "translateX(0.3333px)" }} width="11" height="16" viewBox="-2 -2 11 16" fill="none" stroke="var(--ios-list-chevron)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 1 6 6 1 11" />
      </svg>
      <span aria-hidden="true" data-slot="preview" className="absolute overflow-hidden" style={{ left: 83, right: 34, top: 33, transform: "translateY(-0.3333px)", fontSize: 15, lineHeight: "20px", letterSpacing: 0, color: "var(--ios-list-secondary)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" } as CSSProperties}>
        {conversation.preview}
      </span>
      {separator && <span aria-hidden="true" data-slot="separator" className="absolute" style={{ left: 83, right: 16, bottom: 0, height: 1, transform: "translateY(-0.3333px)", background: "var(--ios-list-separator)" }} />}
    </button>
  );
}

export function IosConversationList({ conversations, onSelect, onCompose, onSearch, title = "Messages", topInset = 54, pressedId, className, style, ...props }: IosConversationListProps) {
  /**
   * The row a finger is on. One id rather than a boolean per row so a second pointer cannot leave a
   * stale highlight behind, and so the row above the pressed one can drop its separator.
   */
  const [pressed, setPressed] = useState<string | null>(null);
  const holding = pressedId !== undefined ? pressedId : pressed;
  const pressedIndex = holding === null ? -1 : conversations.findIndex(item => item.id === holding);
  const release = () => setPressed(current => (current === null ? current : null));
  /**
   * Touch-down lights the row; lift, a cancel and leaving the row all put it out. A drag that turns
   * into a scroll arrives as `pointercancel` — the browser fires it the moment the gesture is taken
   * over for panning — which is `UITableView`'s own rule: a touch that becomes a scroll never
   * highlights. `onScroll` on the scroller is the belt to that brace, for a scroll started by the
   * wheel or the keyboard while a pointer happens to be down.
   *
   * `event.button === 0` keeps a right click from lighting the row. Touch reports button 0.
   *
   * Nothing here focuses anything: a programmatic `focus()` while a touch is still held matches
   * `:focus-visible` in both engines and would paint a ring iOS does not have (see `tapback-bar.tsx`
   * and `audio-recorder.tsx`, which have to work around exactly that). The button keeps its
   * `focus-visible` ring for the keyboard, where it belongs.
   */
  const press = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (event.button === 0) setPressed(id);
  };
  return (
    <div data-slot="ios-conversation-list" className={cn("relative isolate h-full w-full overflow-hidden select-none", vars, className)}
      style={{ fontFamily: font, background: "var(--ios-list-bg)", ...style }} {...props}>
      <div data-slot="scroll" className="absolute inset-0 overflow-y-auto" style={{ paddingTop: topInset, paddingBottom: 90 }} onScroll={release}>
        <IosLargeTitle>{title}</IosLargeTitle>
        <ul data-slot="rows" aria-label={title} className="relative m-0 list-none p-0" style={{ height: conversations.length * ROW }}>
          {conversations.map((conversation, index) => {
            const held = index === pressedIndex;
            // The pressed row's own separator and the one above it go with the fill, so the highlight
            // is one unbroken band. See the note on `--ios-list-highlight`.
            const separated = !held && index !== pressedIndex - 1;
            return (
              <li key={conversation.id} data-slot="row" data-pressed={held ? "true" : undefined} className="absolute left-0 right-0 top-0" style={{ height: ROW, transform: `translateY(${index * ROW}px)` }}>
                <IosConversationRow conversation={conversation} onSelect={onSelect} pressed={held} separator={separated}
                  onPointerDown={event => press(event, conversation.id)} onPointerUp={release} onPointerCancel={release} onPointerLeave={release} />
              </li>
            );
          })}
        </ul>
      </div>
      <div data-slot="bottom-bar" className="absolute flex items-end" style={{ left: 28, right: 28, bottom: 28, height: 48 }}>
        <button type="button" data-slot="search" aria-label="Search" onClick={onSearch}
          className="relative h-full min-w-0 flex-1 rounded-full text-left focus-visible:outline-2 focus-visible:outline-blue-500">
          <GlassLayers clip="right" />
          <svg aria-hidden="true" className="absolute" style={{ left: 19, top: 14 }} width="18.3333" height="18.6667" viewBox="-1 -1 18.3333 18.6667" fill="none" stroke="var(--ios-list-field)" strokeLinecap="round">
            <circle cx="6.745" cy="7.219" r="5.883" strokeWidth="1.725" />
            <path d="M11.4 12.01 15.17 15.78" strokeWidth="2.467" />
          </svg>
          <span className="absolute" style={{ left: 46.8, top: 15.5, transform: "translateY(0.3333px)", fontSize: 17, lineHeight: 1, fontWeight: 500, letterSpacing: 0, color: "var(--ios-list-field)" }}>Search</span>
          <span aria-hidden="true" className="absolute" style={{ right: 23.3333, top: 14.6667, color: "var(--ios-list-field)", display: "flex" }}>
            <IosMicIcon width={12.6667} height={18.3333} />
          </span>
        </button>
        <button type="button" data-slot="compose" aria-label="New message" onClick={onCompose}
          className="relative shrink-0 rounded-full focus-visible:outline-2 focus-visible:outline-blue-500" style={{ marginLeft: 12, width: 48, height: 48 }}>
          <GlassLayers round clip="left" />
          <svg aria-hidden="true" className="absolute" style={{ left: 14, top: 13 }} width="21.3333" height="24" viewBox="0 -2.3333 21.3333 24" fill="none" stroke="var(--ios-list-glyph)" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 0.9167H4.1167A3.2 3.2 0 0 0 0.9167 4.1167V14.8833A3.2 3.2 0 0 0 4.1167 18.0833H14.8833A3.2 3.2 0 0 0 18.0833 14.8833V4" strokeWidth="1.8333" />
            <path d="M8.427 10.623 17.45 1.6" strokeWidth="2.1" />
            <circle cx="20" cy="-1" r="0.6" strokeWidth="1.4" />
          </svg>
        </button>
      </div>
    </div>
  );
}
