/**
 * First-run welcome: a seven-beat slideshow that explains what Ceb is for before the board
 * behind it has anything on it.
 *
 * It is a full-window takeover (the same shape as SettingsSheet) shown while
 * `settings.tourSeen` is false, and it writes that flag on its way out — finish or skip, both
 * count. Because it renders above the cold-start cover, a first launch spends the engine's
 * warm-up reading the tour instead of watching a spinner.
 *
 * The illustrations are built out of the app's OWN surfaces rather than generic mockups: the
 * omnibar keeps `.write-composer.omnibar`'s geometry (30px squircle, hairline border, 16px
 * text, 32px round tools with the accent send), a card keeps `.card`'s 20px squircle and
 * snippet with `.snippet-entity` marks, and the popup panel keeps ask.html's answer sheet
 * over a 17px input. Everything is hand-built CSS/SVG on the shared tokens — no images
 * to ship, no animation library — and each slide's visual is keyed so React remounts it and
 * its animations replay from the top on every visit.
 *
 * Reduced motion: every animated element's *static* CSS is its finished state and the
 * keyframes only supply the `from`, so `animation: none` under
 * `prefers-reduced-motion: reduce` leaves a complete, readable illustration.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";

/** The white mark from assets/icon.svg on its blue plate — the app's own icon, drawn inline. */
function CebMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="98 98 828 828" aria-hidden="true">
      <rect className="onb-mark-plate" x="98" y="98" width="828" height="828" rx="186" />
      <path
        className="onb-mark-glyph"
        d="M286.37,364.98 A31,31 0 0 1 317.37,333.98 L358.87,333.98 A31,31 0 0 1 389.87,364.98 L389.87,398.48 A21,21 0 0 0 410.87,419.48 L444.37,419.48 A31,31 0 0 1 475.37,450.48 L475.37,491.98 A31,31 0 0 1 444.37,522.98 L402.87,522.98 A31,31 0 0 1 371.87,491.98 L371.87,458.48 A21,21 0 0 0 350.87,437.48 L325.37,437.48 A21,21 0 0 0 304.37,458.48 L304.37,491.98 A31,31 0 0 1 273.37,522.98 L231.87,522.98 A31,31 0 0 1 200.87,491.98 L200.87,450.48 A31,31 0 0 1 231.87,419.48 L265.37,419.48 A21,21 0 0 0 286.37,398.48 Z M634.13,364.98 A31,31 0 0 1 665.13,333.98 L706.63,333.98 A31,31 0 0 1 737.63,364.98 L737.63,398.48 A21,21 0 0 0 758.63,419.48 L792.13,419.48 A31,31 0 0 1 823.13,450.48 L823.13,491.98 A31,31 0 0 1 792.13,522.98 L750.63,522.98 A31,31 0 0 1 719.63,491.98 L719.63,458.48 A21,21 0 0 0 698.63,437.48 L673.13,437.48 A21,21 0 0 0 652.13,458.48 L652.13,491.98 A31,31 0 0 1 621.13,522.98 L579.63,522.98 A31,31 0 0 1 548.63,491.98 L548.63,450.48 A31,31 0 0 1 579.63,419.48 L613.13,419.48 A21,21 0 0 0 634.13,398.48 Z"
      />
    </svg>
  );
}

/* The glyphs the omnibar and the popup actually draw, copied from their sources so the mock
   and the app cannot drift: InputPage's SearchGlyph/MicrophoneGlyph and ask.html's mic. */

function SearchGlyph(): React.JSX.Element {
  return (
    <svg className="onb-glyph" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 4.5 4.5" />
    </svg>
  );
}

/** InputPage's ReturnGlyph: search mode's send means "set this as a filter". */
function ReturnGlyph(): React.JSX.Element {
  return (
    <svg className="onb-glyph" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M17.5 5.5v6a3 3 0 0 1-3 3H7" />
      <path d="m10.5 10.5-4 4 4 4" />
    </svg>
  );
}

function FolderGlyph(): React.JSX.Element {
  return (
    <svg className="onb-glyph onb-folder-glyph" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 7.5a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function MicGlyph(): React.JSX.Element {
  return (
    <svg className="onb-glyph" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="8" y="3" width="8" height="12" rx="4" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
    </svg>
  );
}

/**
 * One typed line: a clip that widens in character-sized steps, so a caret placed after it
 * rides along with the last glyph.
 *
 * The end width is measured rather than guessed in `ch`: the shell font is proportional, so a
 * `ch`-based guess either clips the tail or leaves a gap. Measuring in a layout effect lands
 * before the first paint, which is also before the animation's first frame.
 */
function Typed({
  text,
  delay,
  duration,
  className,
}: {
  text: string;
  delay: number;
  duration: number;
  className?: string;
}): React.JSX.Element {
  const inner = useRef<HTMLSpanElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  React.useLayoutEffect(() => {
    if (inner.current) setWidth(inner.current.offsetWidth);
  }, [text]);

  return (
    <span
      className={`onb-typed${className ? ` ${className}` : ""}`}
      style={{
        // steps() on the character count is what makes it read as typing rather than a wipe.
        ["--onb-type-width" as string]: width === null ? "0px" : `${width}px`,
        animationDelay: `${delay}ms`,
        animationDuration: `${duration}ms`,
        animationTimingFunction: `steps(${Math.max(text.length, 1)}, end)`,
      }}
    >
      <span className="onb-typed-inner" ref={inner}>
        {text}
      </span>
    </span>
  );
}

/**
 * `.write-composer.omnibar` while you are typing in it: the text sits on top and the tools
 * rest in the 52px lane the bottom padding reserves — attach bottom-left, then magnifier, mic
 * and the accent send along the bottom-right (InputPage's own left-to-right order).
 */
function Omnibar({
  children,
  search = false,
  fileNote,
}: {
  children: React.ReactNode;
  search?: boolean;
  fileNote?: string;
}): React.JSX.Element {
  return (
    <div className={`onb-omnibar${search ? " is-search" : ""}${fileNote ? " is-filing" : ""}`}>
      {fileNote && (
        <span className="onb-file-note">
          <FolderGlyph />
          files to {fileNote}
        </span>
      )}
      <div className="onb-omnibar-field">{children}</div>
      <span className="onb-attach" aria-hidden="true" />
      <span className={`onb-tool onb-btn-search${search ? " is-active" : ""}`}>
        <SearchGlyph />
      </span>
      {!search && (
        <span className="onb-tool onb-btn-mic">
          <MicGlyph />
        </span>
      )}
      <span className="onb-tool onb-tool-send onb-btn-send" aria-hidden="true">
        {search ? <ReturnGlyph /> : "↑"}
      </span>
    </div>
  );
}

/* ---------- slide 1: the mark blooms out of nothing ---------- */

function IntroVisual(): React.JSX.Element {
  return (
    <div className="onb-vis onb-vis-intro">
      <span className="onb-bloom-ring" />
      <span className="onb-bloom-ring onb-bloom-ring-2" />
      <CebMark className="onb-bloom-mark" />
      {/* Faint satellites: the graph implied, not yet explained. */}
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={`onb-satellite onb-satellite-${i}`} />
      ))}
    </div>
  );
}

/* ---------- slide 2: a note goes in, and comes back marked up ---------- */

const CAPTURE_NOTE = "Dinner with Mira at Kiso. She's moving to Lisbon in March.";

/**
 * The card the note lands on, drawn the way the board draws one: snippet, extracted
 * names carrying `.snippet-entity`'s emphasis. The marks light one after another because
 * that is the order the engine hands them back.
 */
const CAPTURE_SNIPPET: { text: string; entity?: boolean }[] = [
  { text: "Dinner with " },
  { text: "Mira", entity: true },
  { text: " at " },
  { text: "Kiso", entity: true },
  { text: ". She's moving to " },
  { text: "Lisbon", entity: true },
  { text: " in " },
  { text: "March", entity: true },
  { text: "." },
];

function CaptureVisual(): React.JSX.Element {
  let entity = 0;
  return (
    <div className="onb-vis onb-vis-capture">
      <div className="onb-card onb-capture-card">
        <div className="onb-card-body">
          <div className="onb-snippet">
            {CAPTURE_SNIPPET.map((part, i) =>
              part.entity ? (
                <span
                  key={i}
                  className="onb-snippet-entity"
                  style={{ animationDelay: `${1950 + entity++ * 130}ms` }}
                >
                  {part.text}
                </span>
              ) : (
                <React.Fragment key={i}>{part.text}</React.Fragment>
              ),
            )}
          </div>
        </div>
      </div>
      <Omnibar>
        <span className="onb-typed-line">
          <Typed text={CAPTURE_NOTE} delay={220} duration={1220} />
          <span className="onb-caret" />
        </span>
      </Omnibar>
    </div>
  );
}

/* ---------- slide 3: the notes become a graph ---------- */

const CONNECT_NOTES = [
  "Dinner with Mira at Kiso.",
  "Mira's flat in Lisbon, March.",
  "Kiso does the yuzu dish.",
];

/**
 * Two waves. The named things come out of the notes first, then the concepts — the engine's
 * short topical strings — arrive and hook into the same graph, which is the point: the ideas a
 * note is *about* are stored beside the people and places it names.
 *
 * Positions are shared by the edges and the labels, so the two can never drift apart, and the
 * hues are the app's own node colors (--graph-person/place/thing, and --graph-thought for a
 * concept, matching .history-graph-node.concept).
 */
const GRAPH_NODES = [
  { id: "mira", label: "Mira", kind: "person", x: 170, y: 74, wave: 1 },
  { id: "lisbon", label: "Lisbon", kind: "place", x: 330, y: 124, wave: 1 },
  { id: "kiso", label: "Kiso", kind: "thing", x: 142, y: 192, wave: 1 },
  { id: "moving", label: "moving", kind: "concept", x: 332, y: 36, wave: 2 },
  { id: "dinner", label: "dinner", kind: "concept", x: 48, y: 122, wave: 2 },
  { id: "citrus", label: "citrus", kind: "concept", x: 268, y: 214, wave: 2 },
  /* Wave three: the rest of the graph, unnamed and faded, carrying on past the frame. */
  { id: "g1", label: "", kind: "ghost", x: 408, y: 6, wave: 3 },
  { id: "g2", label: "", kind: "ghost", x: 400, y: 78, wave: 3 },
  { id: "g3", label: "", kind: "ghost", x: 8, y: 58, wave: 3 },
  { id: "g4", label: "", kind: "ghost", x: 16, y: 194, wave: 3 },
  { id: "g5", label: "", kind: "ghost", x: 340, y: 236, wave: 3 },
  { id: "g6", label: "", kind: "ghost", x: 210, y: 240, wave: 3 },
] as const;

const GRAPH_EDGES = [
  { from: "mira", to: "lisbon", wave: 1 },
  { from: "mira", to: "kiso", wave: 1 },
  { from: "lisbon", to: "moving", wave: 2 },
  { from: "mira", to: "moving", wave: 2 },
  { from: "kiso", to: "dinner", wave: 2 },
  { from: "mira", to: "dinner", wave: 2 },
  { from: "kiso", to: "citrus", wave: 2 },
  { from: "moving", to: "g1", wave: 3 },
  { from: "moving", to: "g2", wave: 3 },
  { from: "dinner", to: "g3", wave: 3 },
  { from: "dinner", to: "g4", wave: 3 },
  { from: "citrus", to: "g5", wave: 3 },
  { from: "citrus", to: "g6", wave: 3 },
] as const;

/* Wave one lands, the concepts draw in on top of it, and then those concepts trail off into
   everything else already in the graph. */
const WAVE_ONE_EDGE = 520;
const WAVE_ONE_NODE = 900;
const WAVE_TWO_EDGE = 1400;
const WAVE_TWO_NODE = 1750;
const WAVE_THREE_EDGE = 2200;
const WAVE_THREE_NODE = 2420;

const EDGE_DELAY = { 1: WAVE_ONE_EDGE, 2: WAVE_TWO_EDGE, 3: WAVE_THREE_EDGE } as const;
const NODE_DELAY = { 1: WAVE_ONE_NODE, 2: WAVE_TWO_NODE, 3: WAVE_THREE_NODE } as const;

function ConnectVisual(): React.JSX.Element {
  const at = (id: string) => GRAPH_NODES.find((node) => node.id === id) as (typeof GRAPH_NODES)[number];
  /* Stagger within each wave, not across the whole list — otherwise wave three's last nodes
     inherit every earlier item's offset and arrive long after the wave is meant to be over. */
  const edgeSeen: Record<number, number> = {};
  const nodeSeen: Record<number, number> = {};
  return (
    <div className="onb-vis onb-vis-connect">
      <div className="onb-connect-notes">
        {CONNECT_NOTES.map((note, i) => (
          <div key={note} className={`onb-card onb-connect-note onb-connect-note-${i}`}>
            <div className="onb-card-body">
              <div className="onb-snippet">{note}</div>
            </div>
          </div>
        ))}
      </div>
      {/* Padded viewBox: wave three deliberately runs to the edges, and this keeps those nodes
            and their edges from clipping against the frame. */}
      <svg className="onb-connect-graph" viewBox="0 -12 420 264" aria-hidden="true">
        {GRAPH_EDGES.map((edge, i) => {
          const a = at(edge.from);
          const b = at(edge.to);
          const base = EDGE_DELAY[edge.wave];
          const step = edgeSeen[edge.wave] = (edgeSeen[edge.wave] ?? -1) + 1;
          return (
            <line
              key={`${edge.from}-${edge.to}`}
              className={`onb-edge${edge.wave === 2 ? " is-concept" : ""}${edge.wave === 3 ? " is-ghost" : ""}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              style={{ animationDelay: `${base + step * 80}ms` }}
            />
          );
        })}
        {GRAPH_NODES.map((node) => (
          <g
            key={node.id}
            className={`onb-node${node.kind === "ghost" ? " is-ghost" : ""}`}
            style={{
              animationDelay: `${
                NODE_DELAY[node.wave] + (nodeSeen[node.wave] = (nodeSeen[node.wave] ?? -1) + 1) * 80
              }ms`,
            }}
          >
            <circle
              className={`onb-node-dot onb-node-${node.kind}`}
              cx={node.x}
              cy={node.y}
              r={node.kind === "concept" ? 5.5 : node.kind === "ghost" ? 4 : 7}
            />
            {node.label && (
              <text
                className={`onb-node-label${node.kind === "concept" ? " is-concept" : ""}`}
                x={node.x}
                y={node.y - 14}
              >
                {node.label}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}

/* ---------- slide 4: search narrows the board as you type ---------- */

const SEARCH_CARDS = [
  { text: "Kiso does the yuzu dish.", hit: false },
  { text: "Mira's flat in Lisbon, March.", hit: true },
  { text: "Bike needs a new chain.", hit: false },
  { text: "Lisbon: tram 28 is a tourist trap.", hit: true },
  { text: "Dad's birthday, the 9th.", hit: false },
  { text: "Renew the passport.", hit: false },
];

function SearchVisual(): React.JSX.Element {
  return (
    <div className="onb-vis onb-vis-search">
      {/* Search mode, as the bar really renders it: the border takes the accent, the
          magnifier lights up, and the send becomes "set this as a filter". */}
      <Omnibar search>
        <span className="onb-typed-line">
          <Typed className="onb-search-text" text="lisbon" delay={280} duration={450} />
          <span className="onb-caret" />
        </span>
      </Omnibar>
      <div className="onb-board">
        {SEARCH_CARDS.map((card, i) => (
          <div
            key={card.text}
            className={`onb-card onb-board-card${card.hit ? " is-hit" : " is-miss"}`}
            style={{ animationDelay: `${990 + (i % 3) * 40}ms` }}
          >
            <div className="onb-card-body">
              <div className="onb-snippet">{card.text}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- slide 5: /travel files a note into a folder ---------- */

const FOLDERS = [
  { name: "travel", count: 12 },
  { name: "people", count: 34 },
  { name: "recipes", count: 8 },
  { name: "reading", count: 21 },
] as const;

function FoldersVisual(): React.JSX.Element {
  return (
    <div className="onb-vis onb-vis-folders">
      <div className="onb-rail">
        <div className="onb-rail-head">Folders</div>
        {FOLDERS.map((folder, i) => (
          <div
            key={folder.name}
            className={`onb-rail-row${folder.name === "travel" ? " is-target" : ""}`}
            style={{ animationDelay: `${100 + i * 60}ms` }}
          >
            <FolderGlyph />
            <span className="onb-rail-name">{folder.name}</span>
            <span className="onb-rail-count">
              {folder.name === "travel" ? (
                <>
                  <span className="onb-count-out">12</span>
                  <span className="onb-count-in">13</span>
                </>
              ) : (
                folder.count
              )}
            </span>
          </div>
        ))}
      </div>
      <div className="onb-folders-right">
        {/* The card wears the folder as the accent chip the board really gives it. */}
        <div className="onb-card onb-filing-card">
          <div className="onb-card-body">
            <div className="onb-snippet">Mira's flat in Lisbon, March.</div>
          </div>
          <div className="onb-card-tags">
            <span className="onb-card-tag">
              <FolderGlyph />
              travel
            </span>
          </div>
        </div>
        <Omnibar fileNote="travel">
          <span className="onb-typed-line">
            <Typed text="/travel" delay={580} duration={380} className="onb-slash-text" />
            <span className="onb-caret" />
          </span>
        </Omnibar>
      </div>
    </div>
  );
}

/* ---------- slide 6: double-tap control, then two things it does with it ---------- */

/** The `control` keycap, drawn as it sits on the keyboard: caret top-right, word along the bottom. */
function Keycap({ hold = false }: { hold?: boolean }): React.JSX.Element {
  return (
    <div className="onb-keycap-wrap">
      <span className="onb-tap-ring" />
      <span className="onb-tap-ring onb-tap-ring-2" />
      <span className={`onb-keycap${hold ? " is-holding" : ""}`}>
        <span className="onb-keycap-caret" aria-hidden="true">
          ^
        </span>
        <span className="onb-keycap-label">control</span>
      </span>
      <span className="onb-beat onb-beat-tap">tap, tap</span>
      {hold && <span className="onb-beat onb-beat-hold">keep holding</span>}
    </div>
  );
}

/** Scene one: hold the second tap and Ceb takes dictation. */
function HotkeyVoiceScene(): React.JSX.Element {
  return (
    <>
      <Keycap hold />
      {/* The panel unfolds out of the mark. Once the hold lands, the mic takes ask.html's
          real recording state — danger tint, the stop square in place of the glyph, a
          pulsing ring — and the words arrive. */}
      <div className="onb-ask">
        <div className="onb-ask-bar">
          <div className="onb-ask-field">
            <Typed className="onb-ask-text" text="Mira's moving to Lisbon in March" delay={2440} duration={1060} />
            <span className="onb-ask-placeholder">add anything...</span>
          </div>
          <span className="onb-tool onb-ask-mic is-arming">
            <MicGlyph />
            <span className="onb-stop-glyph" aria-hidden="true" />
          </span>
          <span className="onb-tool onb-tool-send onb-ask-send" aria-hidden="true">
            ↑
          </span>
        </div>
      </div>
    </>
  );
}

/** Scene two: same two taps, a typed note, straight into the library. */
function HotkeyAddScene(): React.JSX.Element {
  return (
    <>
      <Keycap />
      <div className="onb-ask onb-ask-agent">
        <div className="onb-ask-bar">
          <div className="onb-ask-field">
            <span className="onb-typed-line">
              <Typed
                className="onb-ask-text"
                text="The tapas place on Rua do Norte — take Mira."
                delay={900}
                duration={1700}
              />
              <span className="onb-caret onb-caret-ask" />
            </span>
            <span className="onb-ask-placeholder is-brief">add anything...</span>
          </div>
          <span className="onb-tool onb-ask-mic">
            <MicGlyph />
          </span>
          <span className="onb-tool onb-tool-send onb-ask-send" aria-hidden="true">
            ↑
          </span>
        </div>
      </div>
    </>
  );
}

/** The typed add first, then the hold-to-talk beat; the class carries each scene's life span. */
const HOTKEY_SCENES = [
  { id: "agent", Scene: HotkeyAddScene },
  { id: "voice", Scene: HotkeyVoiceScene },
] as const;

/**
 * The slide alternates between the two things the gesture leads to, forever.
 *
 * The hand-off rides the scene wrapper's own fade animation rather than a timer: `animationend`
 * fires off the same clock the artwork runs on, so the two can never drift apart — and while
 * the animations are paused (the capture harness, reduced motion) the scene simply holds
 * instead of flipping underneath a still frame.
 */
function HotkeyVisual(): React.JSX.Element {
  const [scene, setScene] = useState(0);
  const { id, Scene } = HOTKEY_SCENES[scene] as (typeof HOTKEY_SCENES)[number];
  return (
    <div className="onb-vis onb-vis-hotkey">
      <div
        key={id}
        className={`onb-hotkey-scene onb-hotkey-scene-${id}`}
        onAnimationEnd={(event) => {
          // Children animate too; only the wrapper's own life cycle advances the scene.
          if (event.animationName === "onb-scene-life") {
            setScene((current) => (current + 1) % HOTKEY_SCENES.length);
          }
        }}
      >
        <Scene />
      </div>
    </div>
  );
}

interface Slide {
  id: string;
  title: string;
  body: React.ReactNode;
  Visual: () => React.JSX.Element;
}

const SLIDES: Slide[] = [
  {
    id: "intro",
    title: "This is Ceb.",
    body: "A memory system that belongs to you. Tell it what you want it to know, and it keeps hold of the thread so you don't have to.",
    Visual: IntroVisual,
  },
  {
    id: "capture",
    title: "Add anything you want Ceb to know.",
    body: "Notes, links, images: type or drop them into the bar at the bottom to add them to Ceb's notes. Your words are kept exactly as you wrote them, with the important stuff picked out.",
    Visual: CaptureVisual,
  },
  {
    id: "connect",
    title: "Ceb connects the ideas in its head.",
    body: "Every entry is read for the people, places, and things inside it, then for the ideas connected to them, and all of it is tied back to everything you've already told Ceb.",
    Visual: ConnectVisual,
  },
  {
    id: "search",
    title: "Search everything you've told Ceb.",
    body: "Hit the magnifier in the bar and the board narrows as you type. Press Enter to keep a word as a filter and stack another on top.",
    Visual: SearchVisual,
  },
  {
    id: "folders",
    title: "Keep things in folders.",
    body: "Use / in your notes to file your ideas. Folders live in the sidebar: click one to see what's filed there, shift-click to combine multiple.",
    Visual: FoldersVisual,
  },
  {
    id: "hotkey",
    title: "Double-tap control from anywhere.",
    body: "Two taps opens the add panel wherever you are. Type or paste a thought, or drop files onto Ceb — they orbit until you send, and everything goes in as one entry. Keep control held down to dictate instead.",
    Visual: HotkeyVisual,
  },
];

export interface OnboardingProps {
  /** Fires once the tour is finished or skipped; App persists `tourSeen` from here. */
  onDone: () => void;
}

export function Onboarding({ onDone }: OnboardingProps): React.JSX.Element {
  const [index, setIndex] = useState(0);
  /** Drives the enter/exit direction of the slide transition. */
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const done = useRef(false);

  /** `index` is clamped to the deck in `go`, so this is a total lookup. */
  const slide = SLIDES[index] as Slide;
  const last = index === SLIDES.length - 1;

  const finish = useCallback(() => {
    if (done.current) return;
    done.current = true;
    onDone();
  }, [onDone]);

  const go = useCallback((delta: number) => {
    setDirection(delta > 0 ? "forward" : "back");
    setIndex((current) => Math.min(SLIDES.length - 1, Math.max(0, current + delta)));
  }, []);

  const advance = useCallback(() => {
    if (last) finish();
    else go(1);
  }, [last, finish, go]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") {
        event.preventDefault();
        advance();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        go(-1);
      } else if (event.key === "Enter") {
        // Enter only: a stray Space after tabbing back to the window should not skip a slide.
        event.preventDefault();
        advance();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [advance, go]);

  return (
    <div className="onb-root" role="dialog" aria-modal="true" aria-label="Welcome to Ceb">
      <button className="onb-skip" onClick={finish}>
        Skip
      </button>

      <div className="onb-stage">
        {/* Keyed on the slide: React remounts the subtree, so every animation replays. */}
        <div key={slide.id} className={`onb-slide onb-slide-${direction}`}>
          <slide.Visual />
          <div className="onb-copy">
            <h2 className="onb-title">{slide.title}</h2>
            <p className="onb-body">{slide.body}</p>
          </div>
        </div>
      </div>

      <div className="onb-foot">
        <button
          className="onb-back"
          onClick={() => go(-1)}
          disabled={index === 0}
          aria-label="Previous"
        >
          Back
        </button>
        <div className="onb-dots" role="tablist" aria-label="Slides">
          {SLIDES.map((candidate, i) => (
            <button
              key={candidate.id}
              className={`onb-dot${i === index ? " is-active" : ""}`}
              role="tab"
              aria-selected={i === index}
              aria-label={candidate.title}
              onClick={() => {
                setDirection(i >= index ? "forward" : "back");
                setIndex(i);
              }}
            />
          ))}
        </div>
        <button className="onb-next" onClick={advance}>
          {last ? "Start using Ceb" : "Next"}
        </button>
      </div>
    </div>
  );
}
