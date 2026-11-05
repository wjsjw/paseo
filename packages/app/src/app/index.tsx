import React from "react";
import { Redirect, usePathname } from "expo-router";
import { StartupSplashScreen } from "@/screens/startup-splash-screen";
import { useEarliestOnlineHostServerId, useHostRuntimeBootstrapState } from "@/app/_layout";
import {
  resolveStartupRoute,
  resolveWorkspaceSelectionStatus,
} from "@/navigation/host-runtime-bootstrap";
import {
  useHostRegistryStatus,
  useHostRuntimeConnectionStatus,
  useHosts,
} from "@/runtime/host-runtime";
import {
  useHasHydratedWorkspaces,
  useWorkspaceExists,
  useWorkspaceForProjectFolders,
} from "@/stores/session-store-hooks";
import {
  useIsLastWorkspaceSelectionHydrated,
  useLastWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { shouldUseDesktopDaemon } from "@/desktop/daemon/desktop-daemon";
import { getIntellijRuntimeConfig } from "@/desktop/host";
import { connectionFromListen } from "@/types/host-connection";

const isDesktop = shouldUseDesktopDaemon();
const EMPTY_WORKSPACE_FOLDERS: string[] = [];

function useIntellijProjectStartupState(input: {
  hosts: ReturnType<typeof useHosts>;
  anyOnlineHostServerId: string | null;
  hasGivenUpWaitingForHost: boolean;
}) {
  const config = getIntellijRuntimeConfig();
  const workspaceFolders = config?.workspaceFolders ?? EMPTY_WORKSPACE_FOLDERS;
  const connection = config ? connectionFromListen(config.endpoint) : null;
  const host = connection
    ? input.hosts.find((candidate) =>
        candidate.connections.some((saved) => saved.id === connection.id),
      )
    : undefined;
  const serverId = host?.serverId ?? null;
  const connectionStatus = useHostRuntimeConnectionStatus(serverId ?? "");
  const workspacesHydrated = useHasHydratedWorkspaces(serverId);
  const workspace = useWorkspaceForProjectFolders(serverId, workspaceFolders);
  const isLoading =
    workspaceFolders.length > 0 &&
    !input.hasGivenUpWaitingForHost &&
    (serverId === null
      ? input.anyOnlineHostServerId === null
      : !workspacesHydrated &&
        (connectionStatus === "connecting" || connectionStatus === "online"));

  return {
    isLoading,
    selection: serverId && workspace ? { serverId, workspaceId: workspace.id } : null,
  };
}

export default function Index() {
  const pathname = usePathname();
  const bootstrapState = useHostRuntimeBootstrapState();
  const anyOnlineHostServerId = useEarliestOnlineHostServerId();
  const hosts = useHosts();
  const hostRegistryStatus = useHostRegistryStatus();
  const intellijProjectStartup = useIntellijProjectStartupState({
    hosts,
    anyOnlineHostServerId,
    hasGivenUpWaitingForHost: bootstrapState.hasGivenUpWaitingForHost,
  });
  const workspaceSelection = useLastWorkspaceSelection();
  const isWorkspaceSelectionLoaded = useIsLastWorkspaceSelectionHydrated();
  const workspaceSelectionServerId = workspaceSelection?.serverId ?? null;
  const workspaceSelectionWorkspaceId = workspaceSelection?.workspaceId ?? null;
  const hasHydratedWorkspaceSelectionHost = useHasHydratedWorkspaces(workspaceSelectionServerId);
  const workspaceSelectionExists = useWorkspaceExists(
    workspaceSelectionServerId,
    workspaceSelectionWorkspaceId,
  );

  const startupRoute = resolveStartupRoute({
    route: { kind: "index", pathname },
    startupBlocker: bootstrapState.startupBlocker,
    hostRegistryStatus,
    hosts,
    anyOnlineHostServerId,
    workspaceSelection,
    intellijProjectSelection: intellijProjectStartup.selection,
    isIntellijProjectSelectionLoading: intellijProjectStartup.isLoading,
    workspaceSelectionStatus: resolveWorkspaceSelectionStatus({
      hasHydratedWorkspaces: hasHydratedWorkspaceSelectionHost,
      workspaceExists: workspaceSelectionExists,
    }),
    isWorkspaceSelectionLoaded,
    hasGivenUpWaitingForHost: bootstrapState.hasGivenUpWaitingForHost,
  });

  if (startupRoute.kind === "redirect") {
    return <Redirect href={startupRoute.href} />;
  }

  return <StartupSplashScreen bootstrapState={isDesktop ? bootstrapState : undefined} />;
}
