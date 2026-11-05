import { describe, expect, it } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { selectIntellijProjectWorkspace } from "./intellij-project-workspace";

function workspace(input: {
  id: string;
  workspaceDirectory: string;
  projectRootPath: string;
  activity?: number;
  background?: boolean;
  archivingAt?: string | null;
}): WorkspaceDescriptor {
  const activity = input.activity === undefined ? null : new Date(input.activity);
  return {
    id: input.id,
    workspaceDirectory: input.workspaceDirectory,
    projectRootPath: input.projectRootPath,
    lastUserMessageAt: activity,
    createdAt: activity,
    background: input.background ?? false,
    archivingAt: input.archivingAt ?? null,
  } as WorkspaceDescriptor;
}

describe("selectIntellijProjectWorkspace", () => {
  it("prefers an exact workspace directory over a more recently used project match", () => {
    const exact = workspace({
      id: "exact",
      workspaceDirectory: "/repo/.worktrees/feature",
      projectRootPath: "/repo",
      activity: 1,
    });
    const recentProjectWorkspace = workspace({
      id: "recent",
      workspaceDirectory: "/repo/.worktrees/other",
      projectRootPath: "/repo",
      activity: 10,
    });

    expect(
      selectIntellijProjectWorkspace({
        workspaces: [recentProjectWorkspace, exact],
        workspaceFolders: ["/repo/.worktrees/feature/"],
      }),
    ).toBe(exact);
  });

  it("uses the most recently active workspace when only its project root matches", () => {
    const older = workspace({
      id: "older",
      workspaceDirectory: "/repo/.worktrees/older",
      projectRootPath: "/repo",
      activity: 1,
    });
    const recent = workspace({
      id: "recent",
      workspaceDirectory: "/repo/.worktrees/recent",
      projectRootPath: "/repo",
      activity: 2,
    });

    expect(
      selectIntellijProjectWorkspace({
        workspaces: [older, recent],
        workspaceFolders: ["/repo"],
      }),
    ).toBe(recent);
  });

  it("ignores archiving and background workspaces", () => {
    const archiving = workspace({
      id: "archiving",
      workspaceDirectory: "/repo",
      projectRootPath: "/repo",
      activity: 20,
      archivingAt: "2026-01-01T00:00:00.000Z",
    });
    const background = workspace({
      id: "background",
      workspaceDirectory: "/repo",
      projectRootPath: "/repo",
      activity: 10,
      background: true,
    });
    const visible = workspace({
      id: "visible",
      workspaceDirectory: "/repo",
      projectRootPath: "/repo",
      activity: 1,
    });

    expect(
      selectIntellijProjectWorkspace({
        workspaces: [archiving, background, visible],
        workspaceFolders: ["/repo"],
      }),
    ).toBe(visible);
  });

  it("does not match partial paths and returns null when there is no folder match", () => {
    const candidate = workspace({
      id: "candidate",
      workspaceDirectory: "/repo-old",
      projectRootPath: "/repo-old",
    });

    expect(
      selectIntellijProjectWorkspace({
        workspaces: [candidate],
        workspaceFolders: ["/repo"],
      }),
    ).toBeNull();
    expect(
      selectIntellijProjectWorkspace({
        workspaces: [candidate],
        workspaceFolders: [],
      }),
    ).toBeNull();
  });
});
