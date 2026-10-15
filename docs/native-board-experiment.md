# Android native board renderer (experimental)

**Branch:** `experiment/native-board-web-overlays`. Do not merge into `main` until Android device tests pass.

## What is native and what remains in the WebView?

- `NativeBoardView.java` draws ink, grid, background, erasing, and line previews with Android Canvas.
- `MainActivity.dispatchTouchEvent` routes draw/erase gestures directly to Android. MotionEvent historical points are preserved and **do not cross the JS bridge per move**.
- Only completed strokes and throttled pinch/zoom updates are passed to React. React still owns board history, undo/redo, OCR, replay, graphs, solutions, toolbar, dialogs, and backend persistence.
- In pan, line, graph, or lasso modes input goes to the existing web event handlers. Android redraws their board state; React overlays remain in WebView.
- The native View is inserted **below** a transparent WebView. Interactive HTML elements are reported as protected hit rectangles every 250ms, so they receive touch events rather than being intercepted by native ink.
- On desktop web or on plugin failure, the original HTML Canvas remains available.

## Switch modes without reflashing

On Android open **Board → Canvas renderer** and choose **Android (native)** or **Web Canvas**. Switching reloads the page. The preference uses `localStorage["matrix.nativeBoard.enabled"]`:

- absent or `"1"`: try native Android (default in the experiment)
- `"0"`: force legacy web canvas

The Android renderer is never requested in a desktop browser.

## Local project and backup

- Main untouched workspace: `~/Developer/Matrix-smartboard`
- Experimental worktree: `~/Developer/Matrix-smartboard-native-board`
- Backup of uncommitted original files: `~/Developer/Matrix-smartboard-backups/pre-native-board-2026-10-15`
- Git checkpoint: `backup/web-board-before-native-20261015` at the old HEAD.

## Build

```sh
cd ~/Developer/Matrix-smartboard-native-board/frontend
npm ci
npm run android:sync
cd android
JAVA_HOME=/opt/homebrew/opt/openjdk@21 \
  ANDROID_HOME="$HOME/Library/Android/sdk" \
  ./gradlew assembleDebug
```

## Verification before merging

1. Test pen, eraser, single-point dot, rapid strokes, drawing after undo/redo, and history persistence.
2. Test two-finger zoom, locked zoom, lasso, graph controls, AI solution overlays, floating panels and dialogs.
3. Test on an actual older ZenPad / interactive board; compare Web vs Android under the **same document, resolution and stroke count**. Measure frame-time percentiles with Android Studio profiler / `adb shell dumpsys gfxinfo ru.matrixhost.smartboard framestats`. A successful build **does not establish an FPS improvement**.
4. Verify light/dark backgrounds, highlighter transparency, rotation, desktop/web fallback, OCR/export, and switching back to the old renderer.
5. For very large documents benchmark `saveLayer` cost and memory. If it becomes the bottleneck, use cached ink tiles or a GL renderer rather than redrawing all paths.

Known limitations: the Android underlay uses a solid theme background rather than the full custom site gradient/image; hit exclusion rects are periodically synchronized, so very fast-moving overlays should be checked on device. Native renderer only handles Android, not iOS.
