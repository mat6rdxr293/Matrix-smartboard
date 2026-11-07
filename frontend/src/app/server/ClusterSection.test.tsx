// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/i18n";

vi.mock("@/lib/apiClient", () => ({
  isNativeApp: () => true,
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ enabled: false, clusterId: null, nodeId: "self", members: [] }), { status: 200 })),
}));
vi.mock("@/lib/cluster", () => ({ refreshClusterMembers: vi.fn(async () => undefined) }));
vi.mock("@/app/setup/androidSetup", () => ({
  currentServerUrl: () => "https://10.0.0.5:8443",
  discoverServers: vi.fn(async () => [
    { name: "Этот сервер", serverId: "a", serverUrl: "https://10.0.0.5:8443", host: "10.0.0.5", port: 8443, tls: true, apiVersion: 1, serverVersion: "" },
    { name: "Кабинет 12", serverId: "b", serverUrl: "https://10.0.0.7:8443", host: "10.0.0.7", port: 8443, tls: true, apiVersion: 1, serverVersion: "" },
  ]),
}));

import ClusterSection from "./ClusterSection";

afterEach(() => vi.clearAllMocks());

describe("cluster join", () => {
  it("lists servers on the network, without this one, and fills the address from a tap", async () => {
    render(<I18nProvider><ClusterSection /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /Присоединиться к кластеру/ }));

    const found = await screen.findByRole("button", { name: /Кабинет 12/ });
    expect(screen.queryByText("Этот сервер")).not.toBeInTheDocument();

    fireEvent.click(found);
    expect(screen.getByLabelText("Адрес сервера кластера")).toHaveValue("https://10.0.0.7:8443");
  });
});
