# Native macOS helper

`SeratoWindowCapture.swift` is a development-only, receive-only window-capture helper. It requires macOS 13 or later and Apple's Swift command-line compiler. The parent launcher compiles it locally. A distributed App Store companion would normally ship a built and signed executable instead.

The native source changed in 0.1.7; 0.1.13 reuses that source and its matching cached helper. Run without arguments for a 60 FPS target, or with `--fps 30` / `--fps 60`. Other arguments are rejected.

Example build command on a Mac:

```sh
xcrun swiftc -swift-version 5 -parse-as-library -O native/SeratoWindowCapture.swift -o SeratoWindowCapture -framework ScreenCaptureKit -framework AppKit -framework CoreGraphics -framework CoreImage -framework CoreMedia -framework CoreVideo -framework ImageIO -framework UniformTypeIdentifiers
```

No network socket, MIDI device, audio output, screen image file, or Serato control command is used. The helper emits full-window analysis JPEGs only through its parent-process stdout pipe. The parent must keep those local. Cropped frame JPEGs are emitted only after a valid crop command.

## Capture behavior

- Permission is checked with `CGPreflightScreenCaptureAccess`; `CGRequestScreenCaptureAccess` is requested at most once per helper run. A denied/unavailable permission produces `permission-required`. The helper does not bypass macOS permission checks.
- A running application must have the exact application name `Serato DJ Pro`, ignoring case and surrounding whitespace. No guessed bundle ID or window-title substring from another application is accepted.
- Normal app-owned windows must be at least 480 × 320 points. Exact Settings/Setup/Preferences titles are excluded. An exact `Serato DJ Pro` window title is prioritized; otherwise the largest suitable app-owned window is used. Near-equal candidates produce `multiple-windows` instead of an arbitrary selection. This heuristic still needs verification with real Serato 5 windows.
- Capture uses `SCContentFilter(desktopIndependentWindow:)`, not a rectangle on a display. Moving or covering the window does not change the normalized crop. The stream output is bounded to 4096 pixels per side and 8,000,000 pixels total, a requested maximum 60 fps (30 with --fps 30), and queue depth 3. This requests an upper frame rate; it does not prove the delivered rate or latency.
- Frame geometry and window size changes invalidate the crop. Stream `contentRect` metadata is used to detect source-geometry changes, not as the crop itself. Crop coordinates are normalized against the complete analysis JPEG's top-left origin, including any window-stream padding.
- One encoder job is allowed at a time. New samples are dropped while it is busy. Writes to the parent's pipe can block this one job, but cannot queue an unbounded number of retained frames.
- The newest complete image is cached in RAM so a static/paused Serato view can provide two consistent analysis images and an immediate first crop. Repeated analysis packets have `repeated: true`; `sourceAgeMs` continues to age from the actual cached source image. They are not newly captured source frames. No cropped-frame duplicates are sent merely to simulate motion.
- `.idle` means no changed image. `.blank`, `.suspended`, and `.stopped` pause cached analysis and frame output. The crop is retained over a plain suspension and can resume on the next complete frame if geometry is unchanged. Minimization is expected to pause the stream; actual Serato behavior must be checked on a Mac.
- EOF, `stop`, SIGINT and SIGTERM request shutdown. The parent should still impose a short forced-termination deadline if a pipe writer or OS capture operation does not complete.

## Binary stdout protocol

Each complete packet is:

| Field | Size |
| --- | --- |
| ASCII `SWC1` | 4 bytes |
| Header length, unsigned big-endian | 4 bytes |
| JPEG body length, unsigned big-endian | 4 bytes |
| UTF-8 JSON header | 1–4096 bytes |
| JPEG image, or empty for status | 0–2 MiB |

All headers have `type: "status"`, `"analysis"`, or `"frame"`. Status headers have `status`, `geometryRevision`, `cropRevision`, and `requestId`, plus an optional static `CAPTURE_*` error code. No window title, application path, track title, owner PID, or window ID is exported.

Image headers additionally have integer `width`, `height`, and `sequence`; `geometryRevision` and `cropRevision`; `requestId`; `repeated`; and nonnegative finite `sourceAgeMs` and `encodeMs`. Sequence numbers increase across both image types. `encodeMs` is local image-processing time, not end-to-end display latency. `sourceAgeMs` is age within the helper; it cannot establish synchronized Mac/iPhone timing.

`frame` packets require a currently accepted crop and include its positive `requestId`. The parent must only publish frames matching the active `geometryRevision`, `cropRevision`, and `requestId`. Status/image packet ordering can interleave under asynchronous capture; the parent must reject stale identifiers rather than infer identity from arrival order alone.

Status values:

`permission-required`, `waiting-for-serato`, `multiple-windows`, `window-found`, `capture-ready`, `geometry-changed`, `crop-applied`, `crop-cleared`, `crop-rejected`, `source-idle`, `source-paused`, `capture-error`, `stopped`.

## NDJSON stdin commands

Every command ends with a newline. Lines are bounded by an 8192-byte input buffer.

```json
{"command":"setCrop","requestId":1,"geometryRevision":1,"crop":{"x":0.2,"y":0.2,"width":0.5,"height":0.5}}
{"command":"clearCrop"}
{"command":"stop"}
```

`setCrop` requires a positive safe-integer request ID, the exact current geometry revision, normalized finite bounds entirely inside the analysis frame, and an output at least 16 × 16 pixels. Success emits `crop-applied` with the newly increased `cropRevision` and matching request ID. A stale or paused source is rejected. `clearCrop` increments the crop revision and prevents further cropped frames. Invalid JSON is ignored; oversized input closes the helper.

## Verification limit and references

This source was reviewed in a Linux environment without Swift, macOS frameworks or Serato. **It has not been compiled or run inside this Linux workspace.** The user report for 0.1.7 confirms a successful Mac build and capture; 0.1.13 uses identical Swift source. The permission prompt, main-window selection, stream output, crop orientation and delivery rate were exercised in the user tests through 0.1.7; new layout behavior still needs its own Mac test. Node-side protocol tests and synthetic browser images do not establish those native behaviors.

The implementation follows these Apple APIs and examples:

- [Capturing screen content in macOS](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos.md)
- [Single independent window filter](https://developer.apple.com/documentation/screencapturekit/sccontentfilter/init(desktopindependentwindow:).md)
- [ScreenCaptureKit window behavior, including occlusion and minimization](https://developer.apple.com/videos/play/wwdc2022/10155/)
- [Frame statuses](https://developer.apple.com/documentation/screencapturekit/scframestatus.md)
- [Preserving aspect ratio](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/preservesaspectratio.md) and [single-window shadows](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/ignoreshadowssinglewindow.md), available from macOS 14 and compiled only with Swift 5.9 or later.

## Resolution pipeline in 0.1.2

On macOS 14+, SCContentFilter.pointPixelScale supplies the backing scale. The capture size is bounded to 4096 pixels per side and 8,000,000 pixels total. On macOS 13 the scale falls back to 1. Analysis JPEGs are reduced to a maximum side of 1280, with `captureWidth`/`captureHeight` identifying the original capture dimensions. Preview and capture share normalized coordinates. Phone frames are cropped from the original capture, with JPEG quality 0.94 (0.88/0.78 only if the byte limit requires it). The parent validates crop dimensions against capture dimensions, not preview dimensions. A backing-size change requires a geometry revision. The last observed sizes are retained as numeric report counters.

Apple documents pointPixelScale as a Float available from macOS 14.0. The resolution and crop pipeline was verified by the user through 0.1.6. The user subsequently compiled and ran 0.1.7 successfully (Swift 6.4.2, SDK 27.2). The 0.1.13 helper source is byte-identical to 0.1.7; its changes are in Node/browser layout handling.

## Performance diagnostics in 0.1.7

Analysis headers include an optional bounded `performance` object: targetFps, captureSamples, busyDrops, cropFrames, previewFrames, elapsedMs, captureFps, encodeFps, peakCaptureFps and peakEncodeFps. These contain numeric counters/rates only. Full capture samples are counted before the single-job encoder gate; busyDrops counts samples discarded at that gate. Rates are updated at analysis emission after at least one second. These counters do not establish the frame rate of Serato's waveform content, a physical phone display refresh rate, or end-to-end latency. Analysis cadence, geometry invalidation and bounded single-job encoding remain unchanged.
