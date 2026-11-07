// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n";

const clusterState = vi.hoisted(() => ({ current: { enabled: false, clusterId: null as string | null, nodeId: "a", members: [] as unknown[] } }));
vi.mock("@/lib/apiClient", () => ({
  isNativeApp: () => true,
  apiFetch: vi.fn(async () => new Response(JSON.stringify(clusterState.current), { status: 200 })),
}));
const invite = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./clusterInvite", () => ({ inviteToCluster: invite }));
vi.mock("@/app/setup/AndroidSetupWizard", () => ({ default: () => null }));
vi.mock("@/lib/cluster", () => ({ refreshClusterMembers: vi.fn(async () => undefined) }));
vi.mock("@/app/setup/androidSetup", () => ({
  currentServerUrl: () => "https://10.0.0.5:8443",
  probeServerIdentity: vi.fn(async (url: string) => ({
    serverUrl: url, serverId: url.includes(".7") ? "b" : "c", pin: "sha256/" + "1".repeat(64), alreadyTrusted: false,
    status: { clusterInviteOpen: url.includes(".7") },
  })),
  discoverServers: vi.fn(async () => [
    { name: "Этот сервер", serverId: "a", serverUrl: "https://10.0.0.5:8443", host: "10.0.0.5", port: 8443, tls: true, apiVersion: 1, serverVersion: "" },
    { name: "Кабинет 12", serverId: "b", serverUrl: "https://10.0.0.7:8443", host: "10.0.0.7", port: 8443, tls: true, apiVersion: 1, serverVersion: "" },
    { name: "Учительская", serverId: "c", serverUrl: "https://10.0.0.8:8443", host: "10.0.0.8", port: 8443, tls: true, apiVersion: 1, serverVersion: "" },
    { name: "Уже в кластере", serverId: "d", serverUrl: "https://10.0.0.9:8443", host: "10.0.0.9", port: 8443, tls: true, apiVersion: 1, serverVersion: "" },
  ]),
}));

import ClusterSection from "./ClusterSection";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  clusterState.current = { enabled: false, clusterId: null, nodeId: "a", members: [] };
});

describe("cluster join", () => {
  it("lists servers on the network, without this one, and fills the address from a tap", async () => {
    render(<I18nProvider><ClusterSection /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /Присоединиться к кластеру/ }));

    const found = await screen.findByRole("button", { name: /Кабинет 12/ });
    expect(screen.queryByText("Этот сервер")).not.toBeInTheDocument();

    fireEvent.click(found);
    expect(screen.getByLabelText("Адрес сервера кластера")).toHaveValue("https://10.0.0.7:8443");
  });

  it("adds an empty server found on the network after its fingerprint is confirmed", async () => {
    clusterState.current = {
      enabled: true, clusterId: "k", nodeId: "a",
      members: [
        { nodeId: "a", name: "Этот", url: "https://10.0.0.5:8443", self: true, online: true },
        { nodeId: "d", name: "Уже в кластере", url: "https://10.0.0.9:8443", self: false, online: true },
      ],
    };
    render(<I18nProvider><ClusterSection /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /Добавить сервер/ }));

    fireEvent.click(await screen.findByRole("button", { name: /Кабинет 12/ }));
    expect(screen.queryByRole("button", { name: /Уже в кластере/ })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /Подтвердить и добавить/ }));
    await waitFor(() => expect(invite).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: "https://10.0.0.7:8443", serverId: "b" })));
    expect(await screen.findByText(/Кабинет 12.*добавлен/)).toBeInTheDocument();

    // A server with schools of its own is not added without a sign-in there.
    fireEvent.click(screen.getByRole("button", { name: /Учительская/ }));
    expect(await screen.findByText(/уже есть школы/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Подтвердить и добавить/ })).not.toBeInTheDocument();
  });
});
