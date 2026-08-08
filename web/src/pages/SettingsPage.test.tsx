// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAILY_BUDGET_ENFORCED } from "../shared/api";
import type { AppSettingsData, StatusSnapshot } from "../shared/api";
import { SettingsSheet } from "./SettingsPage";

describe("SettingsSheet", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const settings: AppSettingsData = {
      provider: "app-key",
      rerank: false,
      tourSeen: true,
      devCardView: false,
    };
    Object.defineProperty(window, "graph", {
      configurable: true,
      value: {
        settingsGet: vi.fn().mockResolvedValue({
          settings,
        }),
        settingsSet: vi.fn().mockImplementation((patch: Partial<AppSettingsData>) =>
          Promise.resolve({ ...settings, ...patch })),
        usageLimits: vi.fn().mockResolvedValue({
          limitUsd: 0.25,
          spentUsd: 0.0925,
          remainingUsd: 0.1575,
          remainingPercent: 63,
          resetsAt: Date.parse("2026-07-27T05:00:00.000Z"),
        }),
        onUsageLimits: vi.fn().mockReturnValue(() => undefined),
        storageUsage: vi.fn().mockResolvedValue({
          totalBytes: 2_621_440,
          documentBytes: 524_288,
          mediaBytes: 2_097_152,
        }),
        deletedList: vi.fn().mockResolvedValue([]),
        deletedRestore: vi.fn().mockResolvedValue({
          spoolId: "restore-spool",
          episodeId: null,
          text: "A recoverable note",
          createdAt: Date.parse("2026-07-01T12:00:00.000Z"),
          attachmentCount: 1,
        }),
        deletedDeleteNow: vi.fn().mockResolvedValue(undefined),
        authStatus: vi.fn().mockResolvedValue({ user: { id: "u1", email: "someone@example.com" } }),
        planStatus: vi.fn().mockResolvedValue({ plan: "free" }),
        planRefresh: vi.fn().mockResolvedValue({ plan: "free" }),
      },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  // The branch-marker badges ("next version ui" / "next version engine") were `new-approach`
  // scaffolding and shipped to users once that branch merged. They are gone; this asserts they
  // stay gone, since the engine still reports the fields they were built on.
  it("shows no build-provenance badges, whatever the engine reports", async () => {
    const snapshot = {
      engine: { state: "running", health: { engine_version: "0.1.17+new.approach", engine_branch: "new-approach" } },
      dataDir: "/tmp/x",
    } as unknown as StatusSnapshot;
    await act(async () => {
      root.render(<SettingsSheet snapshot={snapshot} onClose={vi.fn()} onSettingsChanged={vi.fn()} onSignedOut={vi.fn()} />);
    });

    expect(document.querySelector('[aria-label="next-version-markers"]')).toBeNull();
    expect(document.body.textContent).not.toContain("next version");
    expect(document.body.textContent).not.toContain("released engine");
    // A plain build is not the staging install either: no identity strip at all.
    expect(document.querySelector('[aria-label="build-identity"]')).toBeNull();
  });

  // Every Electron-only pane drove a local process a browser tab cannot reach. Asserting they
  // stay gone, since the ported markup still carries their styles.
  it("offers only the web categories, with no local-process panes", async () => {
    const snapshot = {
      engine: { state: "running", health: null },
      dataDir: "s3://ceb/u_1/",
    } as StatusSnapshot;
    await act(async () => {
      root.render(<SettingsSheet snapshot={snapshot} onClose={vi.fn()} onSettingsChanged={vi.fn()} onSignedOut={vi.fn()} />);
    });

    const categories = Array.from(
      document.querySelectorAll(".settings-nav button"),
      (button) => button.textContent,
    );
    expect(categories).toEqual(["General", "Usage", "Storage", "Account"]);
    for (const gone of ["Sources", "Upload", "Git repositories", "Permissions", "Local MCP Server", "Answer provider"]) {
      expect(document.body.textContent).not.toContain(gone);
    }
  });

  it("hides advanced controls and internal data details", async () => {
    const snapshot = {
      engine: { state: "running", health: null },
      dataDir: "/Users/example/Library/Application Support/Ceb",
    } as StatusSnapshot;
    await act(async () => {
      root.render(<SettingsSheet snapshot={snapshot} onClose={vi.fn()} onSettingsChanged={vi.fn()} onSignedOut={vi.fn()} />);
    });

    expect(document.body.textContent).not.toContain("Rerank results");
    expect(document.body.textContent).not.toContain("Local HTTP bridge");
    expect(document.body.textContent).not.toContain("Copy pairing token");
    expect(Array.from(document.querySelectorAll(".settings-section h3"), (heading) => heading.textContent))
      .not.toContain("Data");
    expect(document.body.textContent).not.toContain("Text & media location");
    expect(document.body.textContent).not.toContain("/Users/example/Library/Application Support/Ceb");
  });







  // The Agent section is grants-only now: the backend line, the how-to-command line, and the
  // dev "Try a typed command" box were all copy about the agent rather than controls.

  // A dev run's capture attributes to whatever launched Electron, so the app is simply not in
  // the Screen Recording list — a Grant button there sends the user somewhere useless.


  // devMode matters: Codex is only ever the live provider under dev mode (effectiveProvider),
  // so the Usage page reports the built-in provider without it no matter what is persisted.

  it("shows deleted-item retention at the bottom of General and opens the empty Deleted page", async () => {
    await act(async () => {
      root.render(<SettingsSheet snapshot={null} onClose={vi.fn()} onSettingsChanged={vi.fn()} onSignedOut={vi.fn()} />);
    });

    expect(document.querySelector(".settings-general-page")?.lastElementChild?.textContent)
      .toContain("View deleted");
    expect(document.body.textContent).toContain("Deleted items are kept for 30 days.");

    const viewDeleted = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("View deleted"));
    await act(async () => viewDeleted!.click());

    expect(document.querySelector(".settings-page-head h2")?.textContent).toBe("Deleted");
    expect(document.body.textContent).toContain(
      "Entries will be automatically deleted in 30 days if not retrieved.",
    );
    expect(document.body.textContent).toContain("No entries to be deleted");
    expect(window.graph.deletedList).toHaveBeenCalledOnce();
  });

  it("retrieves or permanently deletes entries from Deleted", async () => {
    (window.graph.deletedList as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "ep_note_0001",
        episodeId: "ep_note_0001",
        title: "Remember this",
        snippet: "A recoverable note",
        createdAt: "2026-07-01T12:00:00.000Z",
        deletedAt: "2026-07-22T12:00:00.000Z",
        purgeAt: "2026-08-21T12:00:00.000Z",
        attachmentCount: 1,
      },
      {
        id: "ep_note_0002",
        episodeId: "ep_note_0002",
        title: "Delete this",
        snippet: "",
        createdAt: "2026-07-02T12:00:00.000Z",
        deletedAt: "2026-07-22T12:00:00.000Z",
        purgeAt: "2026-08-21T12:00:00.000Z",
        attachmentCount: 0,
      },
    ]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onEntryRetrieved = vi.fn();
    await act(async () => {
      root.render(
        <SettingsSheet
          snapshot={null}
          onClose={vi.fn()}
          onSettingsChanged={vi.fn()}
          onEntryRetrieved={onEntryRetrieved}
          onSignedOut={vi.fn()}
        />,
      );
    });
    const viewDeleted = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("View deleted"))!;
    await act(async () => viewDeleted.click());

    const retrieve = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "Retrieve")!;
    await act(async () => retrieve.click());
    expect(window.graph.deletedRestore).toHaveBeenCalledWith("ep_note_0001");
    expect(onEntryRetrieved).toHaveBeenCalledWith(expect.objectContaining({
      spoolId: "restore-spool",
      text: "A recoverable note",
    }));

    const deleteNow = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "Delete now")!;
    await act(async () => deleteNow.click());
    expect(window.confirm).toHaveBeenCalled();
    expect(window.graph.deletedDeleteNow).toHaveBeenCalledWith("ep_note_0002");
    expect(document.body.textContent).toContain("No entries to be deleted");
  });

  it("closes from the upper-left close control", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<SettingsSheet snapshot={null} onClose={onClose} onSettingsChanged={vi.fn()} onSignedOut={vi.fn()} />);
    });

    await act(async () => {
      (document.querySelector('[aria-label="Close settings"]') as HTMLButtonElement).click();
    });

    expect(onClose).toHaveBeenCalledOnce();
  });

  // DEV_TOOLS is true under vitest (import.meta.env.DEV), so the Developer section renders here;
  // its absence from packaged builds is a vite-build tree-shaking property, not testable in jsdom.


});
