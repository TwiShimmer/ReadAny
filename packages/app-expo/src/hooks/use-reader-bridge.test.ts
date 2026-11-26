import { describe, expect, it, vi } from "vitest";
import { useReaderBridge } from "./use-reader-bridge";

vi.mock("react", () => ({
  useRef: (current: unknown) => ({ current }),
  useCallback: (callback: unknown) => callback,
  useMemo: (create: () => unknown) => create(),
}));
vi.mock("@/stores", () => ({
  useSettingsStore: { getState: () => ({ readSettings: {} }) },
}));
vi.mock("@/stores/webview-info-store", () => ({ useWebviewInfoStore: {} }));

describe("reader bridge PDF retry", () => {
  it("does not send a rejected location back to the WebView, but preserves other locations", () => {
    const onError = vi.fn();
    const bridge = useReaderBridge({ onError });
    const inject = vi.fn();
    const attachWebView = () =>
      Object.defineProperty(bridge.webViewRef, "current", {
        configurable: true,
        value: { injectJavaScript: inject },
      });
    const uri = "http://localhost/book.pdf";
    const cfi = "epubcfi(/6/6)";
    const receive = (message: object) =>
      bridge.handleMessage({ nativeEvent: { data: JSON.stringify(message) } });

    attachWebView();
    receive({ type: "ready" });
    bridge.openBook({ uri, lastLocation: cfi });
    receive({ type: "invalidLastLocation", uri, cfi });
    attachWebView();
    bridge.openBook({ uri, lastLocation: cfi });
    expect(inject).toHaveBeenCalledOnce();
    receive({ type: "ready" });
    bridge.openBook({ uri, lastLocation: "epubcfi(/6/2)" });
    bridge.openBook({ uri: "http://localhost/other.pdf", lastLocation: cfi });

    const prefix = "handleCommand(";
    const suffix = "); true;";
    const commands = inject.mock.calls.map(([script]) =>
      JSON.parse(script.slice(prefix.length, -suffix.length)),
    );
    expect(commands).toEqual([
      expect.objectContaining({ uri, lastLocation: cfi }),
      expect.not.objectContaining({ lastLocation: expect.anything() }),
      expect.objectContaining({ uri, lastLocation: "epubcfi(/6/2)" }),
      expect.objectContaining({ uri: "http://localhost/other.pdf", lastLocation: cfi }),
    ]);
    expect(onError).not.toHaveBeenCalled();
  });
});
