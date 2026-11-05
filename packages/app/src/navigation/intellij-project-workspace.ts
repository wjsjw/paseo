import type { WorkspaceDescriptor } from "@/stores/session-store";
import { normalizeWorkspacePath } from "@/utils/workspace-identity";

export function selectIntellijProjectWorkspace(input: {
  workspaces: Iterable<WorkspaceDescriptor> | null | undefined;
  workspaceFolders: readonly string[];
}): WorkspaceDescriptor | null {
  const folders = new Set(
    input.workspaceFolders
      .map((folder) => normalizeWorkspacePath(folder))
      .filter((folder): folder is string => folder !== null),
  );
  if (folders.size === 0 || !input.workspaces) {
    return null;
  }

  const matches: Array<{ workspace: WorkspaceDescriptor; rank: number; activity: number }> = [];
  for (const workspace of input.workspaces) {
    if (workspace.background || workspace.archivingAt !== null) {
      continue;
    }

    const workspaceDirectory = normalizeWorkspacePath(workspace.workspaceDirectory);
    const projectRootPath = normalizeWorkspacePath(workspace.projectRootPath);
    let rank: number | null = null;
    if (workspaceDirectory && folders.has(workspaceDirectory)) {
      rank = 0;
    } else if (projectRootPath && folders.has(projectRootPath)) {
      rank = 1;
    }
    if (rank === null) {
      continue;
    }

    matches.push({
      workspace,
      rank,
      activity: workspace.lastUserMessageAt?.getTime() ?? workspace.createdAt?.getTime() ?? 0,
    });
  }

  matches.sort(
    (left, right) =>
      left.rank - right.rank ||
      right.activity - left.activity ||
      left.workspace.id.localeCompare(right.workspace.id),
  );
  return matches[0]?.workspace ?? null;
}
