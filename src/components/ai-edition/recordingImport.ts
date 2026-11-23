// Hand-off from the recorder to the editor.
//
// The HUD parks the recording it just finished in ONE main-process slot
// (`set/getCurrentRecordingSession`) and opens the editor, which imports it into
// a fresh project on mount. The slot has to be emptied once that project owns
// the file, because opening the editor destroys and recreates its window
// (`createEditorWindowWrapper` in electron/main.ts) — so a session left in place
// is imported AGAIN on the next open: a second project on the same recording,
// back at the default padding / roundness / wallpaper, while everything the user
// set and saved stays behind in the first project, which is no longer the one on
// screen. That reads exactly like "the editor forgot my settings" (#364).
//
// `setCurrentRecordingSession(null)` is the existing clear (it also drops the
// derived `currentVideoPath`); the only renderer that still needs the session
// after this point is the CLI runner, which lives in its own process.

import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { createId } from "@/lib/ai-edition/document/ids";
import { clipAwaitsProbedDuration } from "@/lib/ai-edition/document/timeline";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import {
	DOCUMENT_SAVES_WAIT_TIMEOUT_MS,
	saveWithDeadline,
	useProjectStore,
	waitForDocumentSaves,
} from "@/lib/ai-edition/store/projectStore";
import {
	appendAutoZoomSuggestions,
	collectAutoZoomSuggestionsForLatestDocument,
} from "@/lib/ai-edition/timeline/apply-auto-zooms";
import type { RecordingSession } from "@/lib/recordingSession";
import { nativeBridgeClient } from "@/native/client";

// Fresh recordings used to get cursor-dwell zooms on load (legacy editor
// `autoZoomEnabled`, default on). The ai-edition import only seeded a clip, so
// the wand still worked but a new take landed un-zoomed. This flag is the
// one-shot hand-off: set as soon as the asset is on the document, then taken on
// the first pass that can give a real answer -- zooms written, no click in the
// sidecar, or the toggle is off. What keeps it set is only ever "not enough of
// the document yet" (no clips, still the placeholder duration), and the
// `loadedmetadata` write is what comes back when that resolves.
//
// The recording path is what scopes it: `importPendingRecording` always has one,
// and it is what stops a flag left over from a take with nothing to zoom from
// decorating the next document loaded in the same window. A successful save
// records the project id so a later undo or delete cannot silently re-seed it.
let pendingFreshRecordingAutoZoom = false;
let pendingFreshRecordingAutoZoomPath: string | null = null;
/**
 * The take that has already been decorated, held by ASSET path rather than project id.
 *
 * A project can hold several takes, and a take imports into a document that already
 * carries the earlier takes' zooms — so "the project has zooms" says nothing about
 * whether THIS take does. Kept after the hand-off is spent so a later undo or delete
 * cannot silently re-seed the same take.
 */
let appliedFreshRecordingAutoZoomAssetPath: string | null = null;
let freshRecordingAutoZoomSaveChain: Promise<void> = Promise.resolve();

// Kept only for the HUD hand-off, never for ordinary media imports or reopened
// projects. Metadata may arrive after importPendingRecording has returned.
let pendingCompletion: { session: RecordingSession; projectId: string | null } | null = null;

async function reportReadyRecording(): Promise<void> {
	const pending = pendingCompletion;
	const api = window.electronAPI;
	if (!pending || !api?.reportRecordingOutcome) return;
	if ((await waitForDocumentSaves()) === "timeout") return;
	const state = useProjectStore.getState();
	const document = state.document;
	if (!document || state.dirty || document.project.id !== pending.projectId) return;
	const asset = document.assets.find(
		(asset) => asset.originalPath === pending.session.screenVideoPath,
	);
	if (
		!asset?.durationSec ||
		!document.timeline.clips.some((clip) => clip.assetId === asset.id) ||
		document.timeline.clips.some((clip) => clipAwaitsProbedDuration(clip, asset.id)) ||
		pendingFreshRecordingAutoZoom
	)
		return;
	try {
		await api.reportRecordingOutcome({
			recordingId: pending.session.createdAt,
			status: "ready",
			projectId: document.project.id,
		});
		if (pendingCompletion === pending) pendingCompletion = null;
	} catch (error) {
		console.warn("[recording] could not report saved project:", error);
	}
}

export function markFreshRecordingAutoZoomPending(assetPath: string): void {
	pendingFreshRecordingAutoZoom = true;
	pendingFreshRecordingAutoZoomPath = assetPath;
	appliedFreshRecordingAutoZoomAssetPath = null;
}

function clearFreshRecordingAutoZoomPending(): void {
	pendingFreshRecordingAutoZoom = false;
	pendingFreshRecordingAutoZoomPath = null;
}

export function consumeFreshRecordingAutoZoomPending(): boolean {
	const was = pendingFreshRecordingAutoZoom;
	clearFreshRecordingAutoZoomPending();
	appliedFreshRecordingAutoZoomAssetPath = null;
	freshRecordingAutoZoomSaveChain = Promise.resolve();
	return was;
}

export type ApplyFreshRecordingAutoZoomsDeps = {
	enabled?: boolean;
	getTelemetry?: (videoPath: string) => Promise<CursorTelemetryPoint[] | null | undefined>;
	createId?: (prefix: string) => string;
	/** Deadline for this path's own write. Tests use a short one. */
	saveTimeoutMs?: number;
	/** Deadline for waiting on writes somebody else started. Tests shorten it. */
	waitTimeoutMs?: number;
	/** Deadline for the auto-zoom preference read. Tests shorten it. */
	prefsTimeoutMs?: number;
};

/**
 * The user's standing answer, read fresh rather than cached: the toggle lives in the
 * editor's rec panel and the HUD publishes prefs changes across windows, so the value
 * can change between one take and the next within a single renderer.
 *
 * An unreachable or throwing bridge reads as ON, which is what every installation did
 * before the preference existed — a failed IPC call must not silently turn a feature off.
 *
 * Bounded for the same reason the write below is: this runs inside
 * `freshRecordingAutoZoomSaveChain`, which `runLoadedMetadataWrite` awaits, so a main
 * process that accepts the invoke and never answers would hold that queue slot — and
 * every metadata write behind it — for the life of the renderer. `invoke` rejects on a
 * throwing handler but never on a silent one, so the `catch` above cannot cover this.
 * A deadline that expires says only "no answer yet", which reads as ON like every other
 * unreadable answer.
 */
async function readAutoZoomPref(timeoutMs = DOCUMENT_SAVES_WAIT_TIMEOUT_MS): Promise<boolean> {
	try {
		const read = (async () => {
			const prefs = await window.electronAPI?.getRecordingPrefs?.();
			return prefs?.autoZoomEnabled !== false;
		})();
		const settled = await saveWithDeadline(read, timeoutMs);
		return settled === "timeout" ? true : settled;
	} catch {
		return true;
	}
}

function isPendingFreshRecordingAsset(asset: { originalPath?: string | null }): boolean {
	return asset.originalPath === pendingFreshRecordingAutoZoomPath;
}

function pendingFreshRecordingAsset(document: AxcutDocument) {
	return document.assets.find(isPendingFreshRecordingAsset);
}

/**
 * Whether this take has already been decorated: some zoom is anchored to one of its
 * clips.
 *
 * `clipId` is what makes the question answerable — `appendAutoZoomSuggestions` anchors
 * every suggestion through `anchorRegionsWithDerivedMs`, so a generated zoom always
 * names the clip it sits on. A legacy UNANCHORED region therefore does not read as
 * "this take already has zooms", which is the behaviour we want: it was not created
 * for any take in particular, and the wand remains the way to re-derive it.
 */
function hasZoomsForAsset(document: AxcutDocument, assetId: string): boolean {
	const clipIds = new Set(
		document.timeline.clips.filter((clip) => clip.assetId === assetId).map((clip) => clip.id),
	);
	if (clipIds.size === 0) return false;
	return (document.zoomRanges ?? []).some((range) => range.clipId && clipIds.has(range.clipId));
}

/**
 * Whether the pending take's real length has landed yet.
 *
 * Not just `asset.durationSec != null`. A recording whose container reports no
 * duration (MediaRecorder WebM, until the EBML fix) still gets the placeholder
 * written to that field, because the timeline layer clamps every interval it
 * builds against `primaryAssetDuration` and would otherwise drop every clip. So
 * the asset says "60" for a take nothing has measured, and the clips are what
 * distinguish the two: one still sitting at the placeholder length is waiting.
 *
 * The cost is a take of exactly 60.000 s never being auto-zoomed. That is the
 * same ambiguity `applyProbedDuration` already lives with, and it is a far
 * smaller price than suggesting zooms against a length nothing measured.
 */
function hasProbedDurationForPendingAsset(document: AxcutDocument): boolean {
	const asset = pendingFreshRecordingAsset(document);
	if (
		asset == null ||
		asset.durationSec == null ||
		!Number.isFinite(asset.durationSec) ||
		asset.durationSec <= 0
	) {
		return false;
	}
	return !document.timeline.clips.some((clip) => clipAwaitsProbedDuration(clip, asset.id));
}

function canApplyFreshRecordingAutoZooms(document: AxcutDocument): boolean {
	if (!pendingFreshRecordingAutoZoom) return false;
	if (
		appliedFreshRecordingAutoZoomAssetPath !== null &&
		appliedFreshRecordingAutoZoomAssetPath === pendingFreshRecordingAutoZoomPath
	) {
		return false;
	}
	const asset = pendingFreshRecordingAsset(document);
	if (!asset) return false;
	if (hasZoomsForAsset(document, asset.id)) return false;
	if ((document.timeline?.clips?.length ?? 0) === 0) return false;
	if (!hasProbedDurationForPendingAsset(document)) return false;
	return true;
}

/** Zooms are on this take already -- the wand ran for it, or a redo brought them back.
 *  The take is decorated, so the hand-off is spent. */
function markDecoratedIfZoomed(document: AxcutDocument): boolean {
	const asset = pendingFreshRecordingAsset(document);
	if (!asset || !hasZoomsForAsset(document, asset.id)) return false;
	appliedFreshRecordingAutoZoomAssetPath = asset.originalPath;
	clearFreshRecordingAutoZoomPending();
	return true;
}

function liveDocument(fallback: AxcutDocument): AxcutDocument {
	return useProjectStore.getState().document ?? fallback;
}

export async function applyPendingFreshRecordingAutoZooms(
	document: AxcutDocument,
	deps: ApplyFreshRecordingAutoZoomsDeps = {},
): Promise<AxcutDocument> {
	if (!pendingFreshRecordingAutoZoom) return document;
	if (
		appliedFreshRecordingAutoZoomAssetPath !== null &&
		appliedFreshRecordingAutoZoomAssetPath === pendingFreshRecordingAutoZoomPath
	) {
		clearFreshRecordingAutoZoomPending();
		return document;
	}
	const enabled = deps.enabled ?? (await readAutoZoomPref(deps.prefsTimeoutMs));
	const start = liveDocument(document);
	// The read yields. A project opened meanwhile is not this take's to decorate, and
	// not the place to spend its hand-off either: the pass that comes back with it will.
	if (start.project.id !== document.project.id) return start;
	if (!enabled) {
		clearFreshRecordingAutoZoomPending();
		return start;
	}
	if (markDecoratedIfZoomed(start)) return start;
	if (!canApplyFreshRecordingAutoZooms(start)) return start;

	const inner =
		deps.getTelemetry ?? ((videoPath: string) => nativeBridgeClient.cursor.getTelemetry(videoPath));
	let telemetryFailed = false;
	const getTelemetry = async (videoPath: string) => {
		try {
			return await inner(videoPath);
		} catch {
			// An unreadable sidecar is NOT the same answer as an empty one: it says
			// nothing about whether this take has a click, so pending survives it and a
			// later `loadedmetadata` for the same take gets another go.
			telemetryFailed = true;
			return [];
		}
	};
	// The wand's own collect path, scoped to the take this hand-off is about: read the
	// document, collect, and collect again if the clips moved while the telemetry was
	// being read. Sharing it is the point -- the suggestions carry TIMELINE spans and
	// `appendAutoZoomSuggestions` anchors them against whatever the store holds at write
	// time, so the two callers must agree on when a collected set has gone stale.
	//
	// The reader re-runs every guard, so a project switch, a wand run or a delete
	// landing during the wait ends the pass exactly where the retry would have started.
	const collected = await collectAutoZoomSuggestionsForLatestDocument(
		() => {
			const live = liveDocument(start);
			if (live.project.id !== start.project.id) return null;
			if (markDecoratedIfZoomed(live)) return null;
			return canApplyFreshRecordingAutoZooms(live) ? live : null;
		},
		getTelemetry,
		isPendingFreshRecordingAsset,
	);
	if (!collected) return liveDocument(start);
	if (collected.suggestions.length === 0) {
		// A real answer, not a race: the stop handler awaits `writePendingCursorTelemetry`
		// BEFORE it publishes the session, so by the time the editor can import the take
		// its sidecar is on disk. An empty read therefore means this take has no click to
		// zoom, and no amount of retrying changes that -- consume the hand-off rather than
		// leaving it armed for the next document loaded in this window.
		if (!telemetryFailed) clearFreshRecordingAutoZoomPending();
		return collected.document;
	}
	return appendAutoZoomSuggestions(
		collected.document,
		collected.suggestions,
		deps.createId ?? createId,
	);
}

export async function maybeSaveFreshRecordingAutoZooms(
	document: AxcutDocument,
	deps: ApplyFreshRecordingAutoZoomsDeps = {},
): Promise<boolean> {
	/** `"contended"`: a user write landed on the snapshot this attempt built from, so
	 *  it decided nothing and is worth repeating against the settled document. */
	const writeFreshRecordingAutoZooms = async (): Promise<boolean | "contended"> => {
		try {
			// A wait that times out has told us nothing about what is on disk, so the
			// only safe move is to abandon this attempt with pending still set, and let
			// a later `loadedmetadata` for this take rebase onto whatever the stuck save
			// eventually leaves.
			if ((await waitForDocumentSaves(deps.waitTimeoutMs)) === "timeout") return false;
			const latest = liveDocument(document);
			const next = await applyPendingFreshRecordingAutoZooms(latest, deps);
			if ((await waitForDocumentSaves(deps.waitTimeoutMs)) === "timeout") return false;
			const current = liveDocument(document);
			if (current.project.id !== latest.project.id) return false;
			const decorated = pendingFreshRecordingAsset(current);
			if (decorated && hasZoomsForAsset(current, decorated.id)) {
				appliedFreshRecordingAutoZoomAssetPath = decorated.originalPath;
				clearFreshRecordingAutoZoomPending();
				return false;
			}
			// Contention means start over, not rebase. If the document moved while the
			// suggestion pass ran, this attempt is working from a snapshot that is
			// already history — writing `next` over the newer one would take the user's
			// edit with it. Drop it and let the repeat below re-collect from scratch,
			// after `waitForDocumentSaves` has seen that writer finish.
			if (current !== latest) return "contended";
			// Nothing to write: the pass returned the document it was given, because a
			// guard refused it or the take has no click.
			if (next === latest) return false;
			const saved = await saveWithDeadline(
				useProjectStore.getState().saveDocument(next, { history: true }),
				deps.saveTimeoutMs ?? DOCUMENT_SAVES_WAIT_TIMEOUT_MS,
			);
			// The write never answered. Keep pending and let go of the chain, so nothing
			// queues behind a promise that is not coming back.
			if (saved === "timeout") return false;
			// A trim (or any other edit) can start after this save was submitted and
			// still be in flight when it returns: `waitForDocumentSaves` before the
			// write only sees saves that have already begun. Wait again, then look at
			// the store — if that later write landed on the unzoomed snapshot, keep
			// pending. A timeout here says the same thing for a different reason: we
			// cannot tell what landed, so do not clear pending.
			if ((await waitForDocumentSaves(deps.waitTimeoutMs)) === "timeout") return saved;
			const stored = useProjectStore.getState().document;
			const storedTake = stored ? pendingFreshRecordingAsset(stored) : undefined;
			if (saved && stored && storedTake && hasZoomsForAsset(stored, storedTake.id)) {
				appliedFreshRecordingAutoZoomAssetPath = storedTake.originalPath;
				clearFreshRecordingAutoZoomPending();
			}
			return saved;
		} catch (error) {
			// `saveDocument` reports failure by returning false, so anything thrown
			// here came from the suggestion pass or a bridge call. Pending stays set and
			// the path goes quiet — log it, or it is invisible.
			console.warn("[recording] fresh-recording auto-zoom write failed:", error);
			return false;
		}
	};
	// One repeat, not a loop: a user who keeps editing through the telemetry wait keeps
	// invalidating the attempt, and the honest answer there is the wand, not spinning.
	const attemptFreshRecordingAutoZooms = async (): Promise<boolean> => {
		const first = await writeFreshRecordingAutoZooms();
		if (first !== "contended") return first;
		const second = await writeFreshRecordingAutoZooms();
		return second === "contended" ? false : second;
	};
	const done = freshRecordingAutoZoomSaveChain.then(
		attemptFreshRecordingAutoZooms,
		attemptFreshRecordingAutoZooms,
	);
	freshRecordingAutoZoomSaveChain = done.then(
		() => undefined,
		() => undefined,
	);
	return done.then(async (saved) => {
		await reportReadyRecording();
		return saved;
	});
}

/** What the editor says once the take is on a project. */
export type ImportedTake = {
	projectTitle: string;
	/** 1 for the first take in a project. */
	takeNumber: number;
	/** True when the clip was appended after an existing one. */
	appended: boolean;
};

export type ImportPendingRecordingDeps = {
	/** Called once the take is on the project, with what the editor should report. */
	onImported?: (take: ImportedTake) => void;
	/**
	 * Appends the take's clip after the last one, and kicks off the background
	 * duration probe — `useTimeline.appendTakeClip`, injected because this module has
	 * no hook access.
	 *
	 * The probe is not optional detail: `addAsset` never sets `durationSec` and
	 * `Preview` only loads the PRIMARY asset's metadata, so a later take's clip would
	 * otherwise stay at the 60s placeholder and fresh-recording auto-zoom would keep
	 * refusing to decorate it. So when this is absent there is no correct length to
	 * place a clip at and none is placed: the take's asset is on the project, unplaced,
	 * and the warning says so. One caller supplies it — the editor on mount.
	 */
	appendTakeClip?: (assetId: string, reason: string) => Promise<string | null>;
	/**
	 * The project this take was armed for could not be opened, so the take became a
	 * project of its own.
	 *
	 * A callback rather than a string for the same reason `appendTakeClip` is one: this
	 * module has no hook access, and the message is user-facing, so the caller says it in
	 * the user's language instead of this file carrying English into 17 locales.
	 */
	onTargetUnavailable?: () => void;
};

/** How many takes a project already holds. Audio is an import, never a take. */
function takeCount(document: AxcutDocument | null): number {
	return (document?.assets ?? []).filter((asset) => asset.kind !== "audio").length;
}

/**
 * Imports the recording the HUD handed over, and consumes the hand-off so it is
 * imported exactly once.
 *
 * With a target project (a take started from the editor's Rec tab) the recording is
 * appended to that project: one new asset, one new clip after the last one, auto-zoom
 * for this take only. Without one it builds a project around the take, as it always
 * did.
 *
 * Returns false when there is nothing pending — the caller then falls back to
 * reopening the most recent project. Throws if the import itself fails, leaving
 * the session in place so a later mount can retry it.
 */
export async function importPendingRecording(
	/**
	 * Called once the import succeeded, with why the take ended before it was
	 * stopped when it did. The HUD that ran the stop closes as the editor opens, so
	 * the editor is the only window left to say it.
	 */
	onWarning?: (message: string) => void,
	deps: ImportPendingRecordingDeps = {},
): Promise<boolean> {
	const api = window.electronAPI;
	if (!api) return false;

	const result = await api.getCurrentRecordingSession();
	const screenPath = result.success ? result.session?.screenVideoPath : undefined;
	if (!screenPath) return false;
	const targetProjectId = result.success ? result.targetProjectId : undefined;
	const pending: typeof pendingCompletion = result.session
		? { session: result.session, projectId: null }
		: null;
	pendingCompletion = pending;
	try {
		const cursorCaptureMode = result.success ? result.session?.cursorCaptureMode : undefined;
		const warning = result.success ? result.warning : undefined;
		const store = () => useProjectStore.getState();

		// Did this take start from an open project? Only then is it a take rather than
		// the recording the project gets built around. Asked of the store AFTER the load,
		// not of the returned promise: `loadProject` reports failure by setting `status`
		// and RETURNING, so a target that was deleted since the editor closed leaves
		// `projectId` empty here and falls through to a new project below.
		let joinsOpenProject = false;
		if (targetProjectId) {
			// Normally the window was destroyed for the take, so the project has to be read
			// back from disk. If it is somehow still loaded, keep the live document: reloading
			// it would throw away edits made after the take was started.
			const alreadyOpen = store().projectId === targetProjectId && store().document != null;
			if (!alreadyOpen) await store().loadProject(targetProjectId);
			joinsOpenProject = store().projectId === targetProjectId && store().document != null;
			if (!joinsOpenProject) {
				deps.onTargetUnavailable?.();
			}
		}
		if (!store().projectId) {
			const created = await store().createProject(`Recording ${new Date().toLocaleString()}`);
			if (pending) pending.projectId = created.project.id;
		}
		if (pending && !pending.projectId) pending.projectId = store().projectId;
		// A project that already holds clips also appends: an editor that was never torn
		// down (so no target was armed) must not have its timeline replaced.
		const hadClips = (store().document?.timeline.clips.length ?? 0) > 0;
		joinsOpenProject = joinsOpenProject || hadClips;

		const takeNumber = takeCount(store().document) + 1;
		// A take added to an existing project names itself; a first take keeps the file
		// name, which is what the media panel showed before this feature existed.
		const label = joinsOpenProject
			? `Take ${takeNumber} — ${new Date().toLocaleTimeString()}`
			: screenPath.split(/[\\/]/).pop() || "Recording";
		const added = await store().addAsset(screenPath, label);
		// Mark before the video element can fire `loadedmetadata`. The asset path is
		// already on the document; waiting until the 60s seed finished let the first
		// metadata pass consume nothing and the second never arrive.
		//
		// Except for a system-cursor take, which writes no `.cursor.json` at all: the
		// toggle stays on in prefs (it is only disabled in the UI while that mode is
		// picked), so without this the flag is set for a recording that can never produce
		// a click. What governs is the mode THIS take was recorded in, not the current
		// preference.
		if (cursorCaptureMode !== "system") {
			markFreshRecordingAutoZoomPending(screenPath);
		}
		// Consumed: the recording now lives in a project. Cleared here rather than
		// after the timeline placement below so a failure down there can't hand the same
		// recording to the next editor window. It also retires the target in main.
		await api.setCurrentRecordingSession(null);

		let appended = false;
		if (added && joinsOpenProject) {
			// A take joins the timeline at the end. With no `appendTakeClip` there is no
			// correct length to place it at (see the deps doc above), so the take stays an
			// asset in the media panel rather than becoming a clip nothing can correct.
			if (!deps.appendTakeClip) {
				console.warn("[recording] take added without a clip: no appendTakeClip supplied");
			} else {
				const clipId = await deps.appendTakeClip(added.id, `Take ${takeNumber}`);
				const placed = clipId
					? store().document?.timeline.clips.find((clip) => clip.id === clipId)
					: undefined;
				if (placed) store().setCurrentTime(placed.timelineStartSec);
				appended = placed != null;
			}
		} else {
			// ponytail: MediaRecorder WebMs ship with duration = NaN until
			// fix-webm-duration patches the EBML header; until that flows through the
			// asset, drop a default 60s clip into the timeline so the editor isn't stuck
			// on "No clips yet" the moment the user lands in the project. Real duration
			// overwrites this when handleLoadedMetadata fires with a finite value.
			const doc = store().document;
			if (doc && doc.timeline.clips.length === 0 && doc.assets.length > 0) {
				// `history: false`. Nothing here is an edit: the user finished a recording and the
				// editor built them a project around it, unattended, on mount. Recording it left a
				// brand-new project sitting at `past.length === 1` before the user had touched
				// anything, so their FIRST Ctrl+Z restored the state before the seed -- an empty
				// timeline -- and the persist that follows an undo wrote that empty timeline to disk.
				await store().replaceTimeline([{ startSec: 0, endSec: 60 }], "Auto-imported recording", {
					history: false,
				});
			}
		}
		const latest = store().document;
		if (latest) {
			await maybeSaveFreshRecordingAutoZooms(latest);
			deps.onImported?.({
				projectTitle: latest.project.title,
				takeNumber,
				appended,
			});
		}
		if (warning) {
			onWarning?.(warning);
		}
		return true;
	} catch (error) {
		if (pendingCompletion === pending) pendingCompletion = null;
		if (pending) {
			await api
				.reportRecordingOutcome?.({
					recordingId: pending.session.createdAt,
					status: "failed",
					message: `The recording's project could not be prepared: ${String(error)}`,
				})
				.catch(() => undefined);
		}
		throw error;
	}
}
