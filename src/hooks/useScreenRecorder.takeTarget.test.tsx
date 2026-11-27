// @vitest-environment jsdom
//
// The project target an editor-started take is armed with must survive exactly one
// thing: a Restart, whose discarded take is followed by another for the same project.
// Every other way a take ends without becoming a project retires it — including the
// ways that never reach a recording at all, which main cannot see and the HUD must say
// out loud (`clear-take-target`).
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { useScreenRecorder } from "./useScreenRecorder";

type ElectronAPI = Window["electronAPI"];

const SOURCE = { id: "screen:0:0", name: "Screen 1", display_id: "1", thumbnail: "" };

let api: Record<string, ReturnType<typeof vi.fn>>;

function stubElectronAPI(overrides: Record<string, unknown> = {}) {
	api = {
		reportRecordingOutcome: vi.fn(async () => ({ success: true })),
		clearTakeTarget: vi.fn(async () => ({ success: true })),
		getRecordingPrefs: vi.fn(async () => null),
		getPlatform: vi.fn(() => "win32"),
		getSelectedSource: vi.fn(async () => SOURCE),
		isNativeWindowsCaptureAvailable: vi.fn(async () => ({ success: true, available: true })),
		startNativeWindowsRecording: vi.fn(async () => ({ success: true, recordingId: 7 })),
		stopNativeWindowsRecording: vi.fn(async () => ({ success: true, discarded: true })),
		showCountdownOverlay: vi.fn(async () => true),
		setCountdownOverlayValue: vi.fn(async () => true),
		hideCountdownOverlay: vi.fn(async () => true),
		setCurrentRecordingSession: vi.fn(async () => undefined),
		setCurrentVideoPath: vi.fn(async () => undefined),
		switchToEditor: vi.fn(async () => undefined),
	};
	window.electronAPI = { ...api, ...overrides } as unknown as ElectronAPI;
}

type RecorderView = { result: { current: ReturnType<typeof useScreenRecorder> } };

async function settle(ms = 0) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

async function startNativeRecording(view: RecorderView) {
	await act(async () => {
		view.result.current.toggleRecording();
	});
	await settle(3_500);
	expect(view.result.current.recording).toBe(true);
}

function reportedOutcomes() {
	return api.reportRecordingOutcome.mock.calls.map(
		([outcome]) => outcome as Record<string, unknown>,
	);
}

beforeEach(() => {
	vi.useFakeTimers();
	window.alert = vi.fn();
	stubElectronAPI();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("useScreenRecorder take target retirement", () => {
	it("keeps the target when Restart discards the take", async () => {
		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);

		await act(async () => {
			await view.result.current.restartRecording();
		});
		await settle();

		const discarded = reportedOutcomes().find((outcome) => outcome.recordingId === 7);
		expect(discarded).toMatchObject({ status: "cancelled" });
		// The take that follows the Restart is still for the same project.
		expect(discarded?.keepTarget).toBe(true);
		// And it did start.
		expect(api.startNativeWindowsRecording).toHaveBeenCalledTimes(2);
		expect(api.clearTakeTarget).not.toHaveBeenCalled();
	});

	it("retires the target when Cancel discards the take", async () => {
		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);

		await act(async () => {
			view.result.current.cancelRecording();
		});
		await settle();

		const discarded = reportedOutcomes().find((outcome) => outcome.recordingId === 7);
		expect(discarded).toMatchObject({ status: "cancelled" });
		expect(discarded?.keepTarget).toBeUndefined();
		// Main retires it from the outcome itself; no second signal is needed.
		expect(api.clearTakeTarget).not.toHaveBeenCalled();
	});

	it("retires the target when the countdown is cancelled", async () => {
		const view = renderHook(() => useScreenRecorder());
		await act(async () => {
			view.result.current.toggleRecording();
		});
		await settle();
		expect(view.result.current.recording).toBe(false);

		await act(async () => {
			view.result.current.toggleRecording();
		});
		await settle();

		expect(api.startNativeWindowsRecording).not.toHaveBeenCalled();
		expect(api.clearTakeTarget).toHaveBeenCalledTimes(1);
	});

	it("retires the target when the start is refused for want of a source", async () => {
		api.getSelectedSource.mockResolvedValue(null);
		const view = renderHook(() => useScreenRecorder());

		await act(async () => {
			view.result.current.toggleRecording();
		});
		await settle(3_500);

		expect(view.result.current.recording).toBe(false);
		expect(api.startNativeWindowsRecording).not.toHaveBeenCalled();
		expect(api.clearTakeTarget).toHaveBeenCalled();
	});

	it("retires the target when the take a Restart started fails to start", async () => {
		api.startNativeWindowsRecording.mockResolvedValueOnce({ success: true, recordingId: 7 });
		api.startNativeWindowsRecording.mockResolvedValueOnce({
			success: false,
			error: "Not enough free space",
		});
		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);

		await act(async () => {
			await view.result.current.restartRecording();
		});
		await settle();

		// The first take kept the target for the one that never came, so it is retired here.
		expect(api.clearTakeTarget).toHaveBeenCalled();
	});
});
