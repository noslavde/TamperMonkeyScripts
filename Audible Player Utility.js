// ==UserScript==
// @name         Audible Player Utility
// @namespace    local.audible.player-utility
// @version      4.2.0
// @author       Aaron Edvalson & Echo (ChatGPT)
// @description  Playback recovery, chapter progress, custom seeking, notes, and quality-of-life tools for Audible.
// @match        https://www.audible.com/webplayer*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";

  // ============================================================
  // Defaults
  // ============================================================

  const DEFAULT_SETTINGS = {
    minimized: false,

    pauseAfterChapter: false,

    autoRewindEnabled: true,
    autoRewindAfterMinutes: 10,
    autoRewindSeconds: 15,

    skipSeconds: 15,
  };

  const UPDATE_INTERVAL_MS = 500;

  // Ignore positions right at the beginning as recovery points.
  const MIN_VALID_TIME = 5;

  // A backwards jump larger than this may be an Audible glitch.
  const BACKWARD_JUMP_THRESHOLD = 15;

  // Tiny backwards differences may occur naturally.
  const SMALL_POSITION_TOLERANCE = 3;

  // A seek shortly after user input is assumed intentional.
  const USER_INTENT_WINDOW_MS = 2500;

  // ============================================================
  // Runtime State
  // ============================================================

  let settings = loadSettings();

  let media = null;

  let lastObservedTime = 0;
  let lastUserInteractionTime = 0;

  let intentionalSeekInProgress = false;
  let suspiciousJumpDetected = false;

  let pauseStartedAt = null;
  let pauseStartedPosition = null;

  let lastChapterCaption = null;
  let lastChapterProgress = null;

  let widget = null;
  let widgetBody = null;

  let recoveryButton = null;
  let recoveryLabel = null;

  let chapterProgressLabel = null;
  let finishTimeLabel = null;

  let settingsPopup = null;

  let recoveryFlashTimeout = null;

  // ============================================================
  // Tampermonkey Storage
  // ============================================================

  function loadSettings() {
    return {
      ...DEFAULT_SETTINGS,
      ...GM_getValue("apu:settings", {}),
    };
  }

  function saveSettings() {
    GM_setValue("apu:settings", settings);
  }

  function getBookId() {
    const url = new URL(location.href);

    /*
     * Use a recognizable book identifier when available.
     *
     * Fallback to the webplayer URL so books do not share
     * recovery positions.
     */
    return (
      url.searchParams.get("asin") ||
      url.searchParams.get("bookId") ||
      url.searchParams.get("titleId") ||
      url.pathname + url.search
    );
  }

  function getPositionKey() {
    return "apu:position:" + getBookId();
  }

  function loadSavedPosition() {
    const value = Number(GM_getValue(getPositionKey(), 0));

    return Number.isFinite(value) ? value : 0;
  }

  function savePosition(seconds) {
    if (!Number.isFinite(seconds) || seconds < MIN_VALID_TIME) {
      return;
    }

    GM_setValue(getPositionKey(), seconds);

    updateRecoveryLabel();
  }

  function clearSavedPosition() {
    GM_deleteValue(getPositionKey());

    suspiciousJumpDetected = false;

    updateWarningState();
    updateRecoveryLabel();
  }

  // ============================================================
  // Audible DOM Helpers
  // ============================================================

  function findMedia() {
    return document.querySelector("audio, video");
  }

  function findClassStartingWith(prefix) {
    return document.querySelector(
      `[class^="${prefix}"], [class*=" ${prefix}"]`,
    );
  }

  function getLeftTimeElement() {
    return findClassStartingWith("_leftTime_");
  }

  function getRightTimeElement() {
    return findClassStartingWith("_rightTime_");
  }

  function getCenterTimeElement() {
    return findClassStartingWith("_centerTime_");
  }

  function getCaptionElement() {
    return findClassStartingWith("_caption_");
  }

  function getLeftTimeText() {
    return getLeftTimeElement()?.textContent?.trim() || "";
  }

  function getRightTimeText() {
    return getRightTimeElement()?.textContent?.trim() || "";
  }

  function getCenterTimeText() {
    return getCenterTimeElement()?.textContent?.trim() || "";
  }

  function getCaptionText() {
    return getCaptionElement()?.textContent?.trim() || "";
  }

  // ============================================================
  // Time Parsing / Formatting
  // ============================================================

  function parseTimeString(text) {
    if (!text) {
      return null;
    }

    const clean = text
      .trim()
      .replace(/[−–—]/g, "-")
      .replace(/remaining/gi, "")
      .replace(/left/gi, "")
      .trim();

    /*
     * Supports:
     *
     * 1:22:33
     * -1:22:33
     * 22:33
     * -22:33
     */
    const colonMatch = clean.match(/-?(\d+):(\d{2})(?::(\d{2}))?/);

    if (colonMatch) {
      if (colonMatch[3] !== undefined) {
        return (
          Number(colonMatch[1]) * 3600 +
          Number(colonMatch[2]) * 60 +
          Number(colonMatch[3])
        );
      }

      return Number(colonMatch[1]) * 60 + Number(colonMatch[2]);
    }

    /*
     * Fallback for formats such as:
     *
     * 3 hrs 20 mins
     * 3h 20m
     * 42 min
     */
    const hours = clean.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)/i);

    const minutes = clean.match(
      /(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)/i,
    );

    const seconds = clean.match(
      /(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)/i,
    );

    if (hours || minutes || seconds) {
      return (
        Number(hours?.[1] || 0) * 3600 +
        Number(minutes?.[1] || 0) * 60 +
        Number(seconds?.[1] || 0)
      );
    }

    return null;
  }

  function formatTime(seconds) {
    seconds = Math.max(0, Math.floor(seconds));

    const hours = Math.floor(seconds / 3600);

    const minutes = Math.floor((seconds % 3600) / 60);

    const secs = seconds % 60;

    if (hours > 0) {
      return (
        `${hours}:` +
        `${String(minutes).padStart(2, "0")}:` +
        `${String(secs).padStart(2, "0")}`
      );
    }

    return `${minutes}:` + `${String(secs).padStart(2, "0")}`;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  // ============================================================
  // Chapter Progress
  // ============================================================

  function getChapterProgress() {
    const elapsed = parseTimeString(getLeftTimeText());

    const remaining = parseTimeString(getRightTimeText());

    if (elapsed === null || remaining === null) {
      return null;
    }

    const total = elapsed + remaining;

    if (total <= 0) {
      return null;
    }

    return clamp(elapsed / total, 0, 1);
  }

  function updateChapterProgress() {
    const progress = getChapterProgress();

    const text = progress !== null ? `${(progress * 100).toFixed(1)}%` : "—%";

    // Expanded display

    if (chapterProgressLabel) {
      chapterProgressLabel.textContent = `Chapter ${text}`;
    }

    // Condensed display

    if (widget?._apuCompactChapter) {
      widget._apuCompactChapter.textContent = `◔ ${text}`;
    }
  }

  // ============================================================
  // Real-World Finish Time
  // ============================================================

  function getRemainingListeningSeconds() {
    return parseTimeString(getCenterTimeText());
  }

  function getFinishTime() {
    const remaining = getRemainingListeningSeconds();

    if (remaining === null || remaining <= 0) {
      return null;
    }

    /*
     * Audible's center time already accounts for playback
     * speed, so no additional speed math is needed here.
     */
    return new Date(Date.now() + remaining * 1000);
  }

  function updateFinishTime() {
    const finish = getFinishTime();

    if (!finish) {
      if (finishTimeLabel) {
        finishTimeLabel.textContent = "Finish —";
      }

      if (widget?._apuCompactFinish) {
        widget._apuCompactFinish.textContent = "⏱ —";
      }

      return;
    }

    const time = finish.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });

    // Expanded

    if (finishTimeLabel) {
      finishTimeLabel.textContent = `Finish ${time}`;
    }

    // Condensed

    if (widget?._apuCompactFinish) {
      widget._apuCompactFinish.textContent = `⏱ ${time}`;
    }
  }

  // ============================================================
  // User Intent Tracking
  // ============================================================

  function markUserInteraction() {
    lastUserInteractionTime = Date.now();
  }

  function userRecentlyInteracted() {
    return Date.now() - lastUserInteractionTime <= USER_INTENT_WINDOW_MS;
  }

  function installInteractionTracking() {
    document.addEventListener("pointerdown", markUserInteraction, true);

    document.addEventListener(
      "keydown",
      (event) => {
        if (
          [
            "ArrowLeft",
            "ArrowRight",
            "Home",
            "End",
            "PageUp",
            "PageDown",
          ].includes(event.key)
        ) {
          markUserInteraction();
        }
      },
      true,
    );
  }

  // ============================================================
  // Media Binding
  // ============================================================

  function bindMedia(element) {
    if (media === element) {
      return;
    }

    media = element;

    lastObservedTime = Number.isFinite(media.currentTime)
      ? media.currentTime
      : 0;

    pauseStartedAt = null;
    pauseStartedPosition = null;

    // --------------------------------------------------------
    // Seeking
    // --------------------------------------------------------

    media.addEventListener("seeking", () => {
      intentionalSeekInProgress = userRecentlyInteracted();
    });

    media.addEventListener("seeked", () => {
      const current = media.currentTime;

      if (
        intentionalSeekInProgress &&
        Number.isFinite(current) &&
        current >= MIN_VALID_TIME
      ) {
        savePosition(current);

        lastObservedTime = current;
      }

      intentionalSeekInProgress = false;
    });

    // --------------------------------------------------------
    // Pause / resume
    // --------------------------------------------------------

    media.addEventListener("pause", onMediaPaused);

    media.addEventListener("play", onMediaPlayed);
  }

  // ============================================================
  // Auto-Rewind After Long Pause
  // ============================================================

  function onMediaPaused() {
    pauseStartedAt = Date.now();

    pauseStartedPosition = Number.isFinite(media?.currentTime)
      ? media.currentTime
      : null;
  }

  function onMediaPlayed() {
    if (
      !settings.autoRewindEnabled ||
      !pauseStartedAt ||
      pauseStartedPosition === null
    ) {
      pauseStartedAt = null;
      pauseStartedPosition = null;

      return;
    }

    const pausedFor = Date.now() - pauseStartedAt;

    const threshold = settings.autoRewindAfterMinutes * 60 * 1000;

    if (
      pausedFor >= threshold &&
      media.currentTime > settings.autoRewindSeconds
    ) {
      const target = Math.max(
        0,
        media.currentTime - settings.autoRewindSeconds,
      );

      seekTo(target);

      flashRecoveryLabel(`↶ ${settings.autoRewindSeconds}s`);
    }

    pauseStartedAt = null;
    pauseStartedPosition = null;
  }

  // ============================================================
  // Pause After Chapter
  // ============================================================

  function observeChapter() {
    const caption = getCaptionText();

    const progress = getChapterProgress();

    if (!caption) {
      return;
    }

    /*
     * First observation.
     */
    if (lastChapterCaption === null) {
      lastChapterCaption = caption;

      lastChapterProgress = progress;

      return;
    }

    /*
     * Caption changed, meaning Audible has moved into another
     * chapter/section.
     */
    if (caption !== lastChapterCaption) {
      /*
       * Only pause if the previous chapter was nearly
       * complete.
       *
       * This prevents manually selecting another chapter
       * from being treated as a natural chapter ending.
       */
      const naturallyFinished =
        lastChapterProgress !== null && lastChapterProgress >= 0.94;

      if (
        settings.pauseAfterChapter &&
        naturallyFinished &&
        media &&
        !media.paused
      ) {
        media.pause();

        flashRecoveryLabel("Paused after chapter");
      }

      lastChapterCaption = caption;

      lastChapterProgress = progress;

      return;
    }

    if (progress !== null) {
      lastChapterProgress = progress;
    }
  }

  // ============================================================
  // Playback Recovery / Jump Detection
  // ============================================================

  function observePlayback() {
    const found = findMedia();

    if (!found) {
      return;
    }

    bindMedia(found);

    const current = media.currentTime;

    if (!Number.isFinite(current)) {
      return;
    }

    // --------------------------------------------------------
    // Near-zero reset
    // --------------------------------------------------------

    if (current < MIN_VALID_TIME) {
      if (
        lastObservedTime > BACKWARD_JUMP_THRESHOLD &&
        !userRecentlyInteracted() &&
        !intentionalSeekInProgress
      ) {
        triggerSuspiciousJump();
      }

      lastObservedTime = current;

      return;
    }

    const delta = current - lastObservedTime;

    // --------------------------------------------------------
    // Normal playback
    // --------------------------------------------------------

    if (delta >= -SMALL_POSITION_TOLERANCE) {
      savePosition(current);

      lastObservedTime = current;

      return;
    }

    // --------------------------------------------------------
    // Backwards movement
    // --------------------------------------------------------

    const backwardsDistance = Math.abs(delta);

    /*
     * Small movements are assumed harmless.
     */
    if (backwardsDistance < BACKWARD_JUMP_THRESHOLD) {
      savePosition(current);

      lastObservedTime = current;

      return;
    }

    /*
     * Recent interaction means this was probably deliberate.
     */
    if (intentionalSeekInProgress || userRecentlyInteracted()) {
      savePosition(current);

      lastObservedTime = current;

      return;
    }

    /*
     * Otherwise assume Audible jumped unexpectedly.
     *
     * Preserve the previously saved recovery position.
     */
    triggerSuspiciousJump();

    lastObservedTime = current;
  }

  function triggerSuspiciousJump() {
    if (suspiciousJumpDetected) {
      return;
    }

    suspiciousJumpDetected = true;

    updateWarningState();
    updateRecoveryLabel();

    console.warn(
      "[Audible Player Utility]",
      "Unexpected playback jump detected.",
      "Recovery position:",
      formatTime(loadSavedPosition()),
    );
  }

  // ============================================================
  // Seeking
  // ============================================================

  function seekTo(seconds) {
    const found = findMedia();

    if (!found) {
      flashRecoveryLabel("Player unavailable");

      return;
    }

    bindMedia(found);

    intentionalSeekInProgress = true;

    const duration = Number.isFinite(media.duration)
      ? media.duration
      : Infinity;

    const target = clamp(seconds, 0, duration);

    media.currentTime = target;

    lastObservedTime = target;

    if (target >= MIN_VALID_TIME) {
      savePosition(target);
    }

    setTimeout(() => {
      intentionalSeekInProgress = false;
    }, 600);
  }

  function seekBy(seconds) {
    const found = findMedia();

    if (!found) {
      flashRecoveryLabel("Player unavailable");

      return;
    }

    bindMedia(found);

    markUserInteraction();

    seekTo(media.currentTime + seconds);
  }

  // ============================================================
  // Recovery
  // ============================================================

  function restorePosition() {
    const found = findMedia();

    if (!found) {
      flashRecoveryLabel("Player unavailable");

      return;
    }

    bindMedia(found);

    const saved = loadSavedPosition();

    if (!Number.isFinite(saved) || saved <= 0) {
      flashRecoveryLabel("No saved position");

      return;
    }

    seekTo(saved);

    suspiciousJumpDetected = false;

    updateWarningState();

    flashRecoveryLabel(`Restored ${formatTime(saved)}`);
  }

  function resetRecoveryState() {
    clearSavedPosition();

    if (media && Number.isFinite(media.currentTime)) {
      lastObservedTime = media.currentTime;
    }

    flashRecoveryLabel("Recovery reset");
  }

  // ============================================================
  // Note Reference
  // ============================================================

  function buildNoteReference() {
    const caption = getCaptionText();

    const timestamp = getLeftTimeText();

    if (!caption && !timestamp) {
      return "";
    }

    if (!caption) {
      return timestamp;
    }

    if (!timestamp) {
      return caption;
    }

    return `${caption} - ${timestamp}`;
  }

  function copyNoteReference() {
    const reference = buildNoteReference();

    if (!reference) {
      flashRecoveryLabel("Reference unavailable");

      return;
    }

    GM_setClipboard(reference, "text");

    flashRecoveryLabel("Reference copied");
  }

  // ============================================================
  // UI Helpers
  // ============================================================

  function makeButton(text, title = "") {
    const button = document.createElement("button");

    button.textContent = text;

    button.title = title;

    button.className = "apu-button";

    return button;
  }

  // ============================================================
  // Main Widget
  // ============================================================

  function createWidget() {
    widget = document.createElement("div");

    widget.id = "audible-player-utility";

    // ============================================================
    // Header / Main Row
    // ============================================================

    const header = document.createElement("div");

    header.className = "apu-header";

    // ------------------------------------------------------------
    // Collapse toggle -- ALWAYS FIRST
    // ------------------------------------------------------------

    const minimizeButton = makeButton("−", "Collapse utility");

    minimizeButton.classList.add("apu-icon", "apu-collapse");

    minimizeButton.addEventListener("click", toggleMinimized);

    // ------------------------------------------------------------
    // Recovery
    // ------------------------------------------------------------

    recoveryButton = makeButton(
      "",
      "Return to last known good playback position",
    );

    recoveryButton.classList.add("apu-recovery");

    recoveryLabel = document.createElement("span");

    recoveryButton.textContent = "";

    recoveryButton.append(recoveryLabel);

    recoveryButton.addEventListener("click", restorePosition);

    // ------------------------------------------------------------
    // Skip buttons
    // ------------------------------------------------------------

    const rewindButton = makeButton(
      "↶15",
      `Rewind ${settings.skipSeconds} seconds`,
    );

    rewindButton.classList.add("apu-compact-control");

    rewindButton.addEventListener("click", () => {
      seekBy(-settings.skipSeconds);
    });

    const forwardButton = makeButton(
      "15↷",
      `Skip forward ${settings.skipSeconds} seconds`,
    );

    forwardButton.classList.add("apu-compact-control");

    forwardButton.addEventListener("click", () => {
      seekBy(settings.skipSeconds);
    });

    // ------------------------------------------------------------
    // Note button
    // ------------------------------------------------------------

    const noteButton = makeButton("📋", "Copy chapter and timestamp");

    noteButton.classList.add("apu-icon");

    noteButton.addEventListener("click", copyNoteReference);

    // ------------------------------------------------------------
    // Compact finish time
    // ------------------------------------------------------------

    const compactFinish = document.createElement("div");

    compactFinish.className = "apu-compact-stat apu-compact-finish";

    compactFinish.title = "Estimated real-world finish time";

    // ------------------------------------------------------------
    // Compact chapter progress
    // ------------------------------------------------------------

    const compactChapter = document.createElement("div");

    compactChapter.className = "apu-compact-stat apu-compact-chapter";

    compactChapter.title = "Chapter progress";

    // ------------------------------------------------------------
    // Settings
    // ------------------------------------------------------------

    const settingsButton = makeButton("⚙", "Settings");

    settingsButton.classList.add("apu-icon", "apu-expanded-only");

    settingsButton.addEventListener("click", toggleSettings);

    header.append(
      minimizeButton,
      recoveryButton,
      rewindButton,
      forwardButton,
      noteButton,
      compactFinish,
      compactChapter,
      settingsButton,
    );

    // ============================================================
    // Expanded Body
    // ============================================================

    widgetBody = document.createElement("div");

    widgetBody.className = "apu-body";

    chapterProgressLabel = document.createElement("div");

    chapterProgressLabel.className = "apu-progress";

    finishTimeLabel = document.createElement("div");

    finishTimeLabel.className = "apu-finish";

    // ------------------------------------------------------------
    // Expanded controls
    // ------------------------------------------------------------

    const controls = document.createElement("div");

    controls.className = "apu-controls";

    const expandedRewind = makeButton(
      `↶ ${settings.skipSeconds}s`,
      `Rewind ${settings.skipSeconds} seconds`,
    );

    expandedRewind.addEventListener("click", () => {
      seekBy(-settings.skipSeconds);
    });

    const expandedForward = makeButton(
      `${settings.skipSeconds}s ↷`,
      `Skip forward ${settings.skipSeconds} seconds`,
    );

    expandedForward.addEventListener("click", () => {
      seekBy(settings.skipSeconds);
    });

    const expandedNote = makeButton("📋 Note", "Copy chapter and timestamp");

    expandedNote.addEventListener("click", copyNoteReference);

    const resetButton = makeButton("↺", "Reset recovery state");

    resetButton.classList.add("apu-icon");

    resetButton.addEventListener("click", resetRecoveryState);

    controls.append(expandedRewind, expandedForward, expandedNote, resetButton);

    widgetBody.append(chapterProgressLabel, finishTimeLabel, controls);

    // ============================================================
    // Settings Popup
    // ============================================================

    settingsPopup = createSettingsPopup();

    // ============================================================
    // Assemble
    // ============================================================

    widget.append(header, widgetBody, settingsPopup);

    document.body.append(widget);

    // ============================================================
    // Store compact display references
    // ============================================================

    widget._apuCompactFinish = compactFinish;

    widget._apuCompactChapter = compactChapter;

    widget._apuCollapseButton = minimizeButton;

    setMinimized(settings.minimized, false);

    updateRecoveryLabel();
    updateWarningState();
  }

  // ============================================================
  // Minimize
  // ============================================================

  function toggleMinimized() {
    setMinimized(!settings.minimized);
  }

  function setMinimized(value, persist = true) {
    settings.minimized = value;

    if (persist) {
      saveSettings();
    }

    widget?.classList.toggle("apu-minimized", value);

    /*
     * Keep the toggle in exactly the same position,
     * but change the symbol to communicate state.
     */
    if (widget?._apuCollapseButton) {
      widget._apuCollapseButton.textContent = value ? "▸" : "−";

      widget._apuCollapseButton.title = value
        ? "Expand utility"
        : "Collapse utility";
    }

    if (value && settingsPopup) {
      settingsPopup.classList.remove("open");
    }
  }

  // ============================================================
  // Settings
  // ============================================================

  function createSettingsPopup() {
    const popup = document.createElement("div");

    popup.className = "apu-settings";

    popup.innerHTML = `
            <div class="apu-settings-title">
                Settings
            </div>

            <label class="apu-checkbox-row">
                <input
                    id="apu-pause-after-chapter"
                    type="checkbox"
                >

                <span>
                    Pause after chapter
                </span>
            </label>

            <label class="apu-checkbox-row">
                <input
                    id="apu-auto-rewind"
                    type="checkbox"
                >

                <span>
                    Auto-rewind after long pause
                </span>
            </label>

            <div class="apu-setting-row">
                <span>
                    Long pause
                </span>

                <input
                    id="apu-rewind-minutes"
                    type="number"
                    min="1"
                    max="120"
                    step="1"
                >

                <span>
                    min
                </span>
            </div>

            <div class="apu-setting-row">
                <span>
                    Rewind
                </span>

                <input
                    id="apu-rewind-seconds"
                    type="number"
                    min="1"
                    max="120"
                    step="1"
                >

                <span>
                    sec
                </span>
            </div>

            <div class="apu-divider"></div>

            <div class="apu-settings-note">
                Note reference
            </div>

            <div class="apu-note-preview">
                —
            </div>
        `;

    /*
     * Bind after it has been returned and attached.
     */
    setTimeout(() => {
      bindSettingsPopup(popup);
    }, 0);

    return popup;
  }

  function bindSettingsPopup(popup) {
    const pauseAfterChapter = popup.querySelector("#apu-pause-after-chapter");

    const autoRewind = popup.querySelector("#apu-auto-rewind");

    const rewindMinutes = popup.querySelector("#apu-rewind-minutes");

    const rewindSeconds = popup.querySelector("#apu-rewind-seconds");

    pauseAfterChapter.checked = settings.pauseAfterChapter;

    autoRewind.checked = settings.autoRewindEnabled;

    rewindMinutes.value = settings.autoRewindAfterMinutes;

    rewindSeconds.value = settings.autoRewindSeconds;

    pauseAfterChapter.addEventListener("change", () => {
      settings.pauseAfterChapter = pauseAfterChapter.checked;

      saveSettings();
    });

    autoRewind.addEventListener("change", () => {
      settings.autoRewindEnabled = autoRewind.checked;

      saveSettings();
    });

    rewindMinutes.addEventListener("change", () => {
      settings.autoRewindAfterMinutes = clamp(
        Number(rewindMinutes.value) || 1,
        1,
        120,
      );

      rewindMinutes.value = settings.autoRewindAfterMinutes;

      saveSettings();
    });

    rewindSeconds.addEventListener("change", () => {
      settings.autoRewindSeconds = clamp(
        Number(rewindSeconds.value) || 1,
        1,
        120,
      );

      rewindSeconds.value = settings.autoRewindSeconds;

      saveSettings();
    });

    updateNotePreview();
  }

  function toggleSettings() {
    if (settings.minimized) {
      setMinimized(false);
    }

    settingsPopup.classList.toggle("open");

    updateNotePreview();
  }

  function updateNotePreview() {
    const preview = settingsPopup?.querySelector(".apu-note-preview");

    if (!preview) {
      return;
    }

    preview.textContent = buildNoteReference() || "Reference unavailable";
  }

  // ============================================================
  // Recovery UI
  // ============================================================

  function updateRecoveryLabel() {
    if (!recoveryLabel) {
      return;
    }

    const saved = loadSavedPosition();

    if (suspiciousJumpDetected) {
      recoveryLabel.textContent =
        saved > 0 ? `⚠ Return ${formatTime(saved)}` : "⚠ Jump detected";

      return;
    }

    recoveryLabel.textContent =
      saved > 0 ? `↩ ${formatTime(saved)}` : "↩ Position";
  }

  function updateWarningState() {
    widget?.classList.toggle("apu-warning", suspiciousJumpDetected);
  }

  function flashRecoveryLabel(text, duration = 1600) {
    if (!recoveryLabel) {
      return;
    }

    if (recoveryFlashTimeout) {
      clearTimeout(recoveryFlashTimeout);
    }

    recoveryLabel.textContent = text;

    recoveryFlashTimeout = setTimeout(() => {
      updateRecoveryLabel();
    }, duration);
  }

  // ============================================================
  // CSS
  // ============================================================

  function installStyles() {
    const style = document.createElement("style");

    style.textContent = `
            #audible-player-utility {
                position: fixed;

                top: 12px;
                left: 12px;

                width: 250px;

                z-index: 2147483647;

                box-sizing: border-box;

                padding: 7px;

                background:
                    rgba(22, 22, 22, 0.94);

                border:
                    1px solid rgba(255, 255, 255, 0.14);

                border-radius: 9px;

                box-shadow:
                    0 4px 18px rgba(0, 0, 0, 0.4);

                backdrop-filter:
                    blur(8px);

                color: #eee;

                font-family:
                    Arial,
                    sans-serif;

                font-size: 12px;

                transition:
                    width 160ms ease,
                    background 300ms ease,
                    box-shadow 300ms ease;
            }


            /* --------------------------------------------------
               Warning pulse
               -------------------------------------------------- */

            @keyframes apu-warning-pulse {
                0%,
                100% {
                    background:
                        rgba(62, 27, 27, 0.95);

                    box-shadow:
                        0 4px 18px
                        rgba(0, 0, 0, 0.4);
                }

                50% {
                    background:
                        rgba(105, 42, 42, 0.97);

                    box-shadow:
                        0 4px 18px
                        rgba(0, 0, 0, 0.4),

                        0 0 14px
                        rgba(140, 55, 55, 0.28);
                }
            }


            #audible-player-utility.apu-warning {
                animation:
                    apu-warning-pulse
                    2.6s
                    ease-in-out
                    infinite;
            }


            /* --------------------------------------------------
               Header
               -------------------------------------------------- */

            .apu-header {
                display: flex;
                align-items: center;

                gap: 5px;
            }


            /* --------------------------------------------------
               Buttons
               -------------------------------------------------- */

            .apu-button {
                min-width: 0;

                box-sizing: border-box;

                border:
                    1px solid rgba(255, 255, 255, 0.15);

                border-radius: 6px;

                padding:
                    6px 8px;

                background:
                    rgba(42, 42, 42, 0.96);

                color: #eee;

                font:
                    inherit;

                font-weight: 600;

                cursor: pointer;

                white-space: nowrap;

                transition:
                    background 100ms ease,
                    transform 80ms ease;
            }


            .apu-button:hover {
                background:
                    rgba(60, 60, 60, 0.98);
            }


            .apu-button:active {
                transform:
                    scale(0.97);
            }


            .apu-recovery {
                flex: 1;

                overflow: hidden;
                text-overflow: ellipsis;
            }


            .apu-icon {
                width: 30px;

                padding-left: 0;
                padding-right: 0;
            }


            /* --------------------------------------------------
               Body
               -------------------------------------------------- */

            .apu-body {
                display: flex;
                flex-direction: column;

                gap: 6px;

                margin-top: 6px;
            }


            .apu-progress {
                padding:
                    3px 4px;

                text-align: center;

                color:
                    rgba(
                        255,
                        255,
                        255,
                        0.78
                    );
            }


            .apu-finish {
                padding:
                    5px;

                text-align: center;

                background:
                    rgba(
                        255,
                        255,
                        255,
                        0.045
                    );

                border-radius: 5px;

                font-weight: 600;
            }


            .apu-controls {
                display: grid;

                grid-template-columns:
                    1fr
                    1fr
                    1fr
                    30px;

                gap: 5px;
            }


            /* --------------------------------------------------
               Settings
               -------------------------------------------------- */

            .apu-settings {
                display: none;

                position: absolute;

                top: 42px;
                left: 100%;

                width: 225px;

                box-sizing: border-box;

                margin-left: 7px;

                padding: 10px;

                background:
                    rgba(
                        25,
                        25,
                        25,
                        0.98
                    );

                border:
                    1px solid
                    rgba(
                        255,
                        255,
                        255,
                        0.15
                    );

                border-radius: 8px;

                box-shadow:
                    0 5px 20px
                    rgba(
                        0,
                        0,
                        0,
                        0.5
                    );
            }


            .apu-settings.open {
                display: flex;

                flex-direction: column;

                gap: 9px;
            }


            .apu-settings-title {
                margin-bottom: 2px;

                font-size: 13px;
                font-weight: 700;
            }


            .apu-checkbox-row {
                display: flex;
                align-items: center;

                gap: 7px;

                cursor: pointer;
            }


            .apu-setting-row {
                display: grid;

                grid-template-columns:
                    1fr
                    48px
                    25px;

                align-items: center;

                gap: 5px;
            }


            .apu-setting-row input {
                width: 44px;

                box-sizing: border-box;

                padding: 3px;

                border:
                    1px solid #555;

                border-radius: 4px;

                background: #222;

                color: #eee;
            }


            .apu-divider {
                margin:
                    3px 0;

                border-top:
                    1px solid
                    rgba(
                        255,
                        255,
                        255,
                        0.12
                    );
            }


            .apu-settings-note {
                font-weight: 700;
            }


            .apu-note-preview {
                padding: 6px;

                background:
                    rgba(
                        255,
                        255,
                        255,
                        0.05
                    );

                border-radius: 5px;

                color:
                    rgba(
                        255,
                        255,
                        255,
                        0.72
                    );

                font-size: 11px;

                overflow-wrap: anywhere;
            }


            /* ============================================================
            Compact / Expanded Modes
            ============================================================ */

            .apu-compact-control,
            .apu-compact-stat {
                display: none;
            }


            /* ------------------------------------------------------------
            Minimized utility becomes a single functional row
            ------------------------------------------------------------ */

            #audible-player-utility.apu-minimized {
                width: auto;

                padding: 5px;
            }


            /*
            * The header itself becomes the complete mini-player.
            */
            #audible-player-utility.apu-minimized
            .apu-header {
                display: flex;

                align-items: center;

                gap: 4px;
            }


            /*
            * Hide expanded-only content.
            */
            #audible-player-utility.apu-minimized
            .apu-body,

            #audible-player-utility.apu-minimized
            .apu-expanded-only {
                display: none;
            }


            /*
            * Recovery remains visible.
            */
            #audible-player-utility.apu-minimized
            .apu-recovery {
                display: block;

                flex: 0 1 auto;

                max-width: 115px;

                padding:
                    5px 7px;
            }


            /*
            * Show compact-only controls.
            */
            #audible-player-utility.apu-minimized
            .apu-compact-control,

            #audible-player-utility.apu-minimized
            .apu-compact-stat {
                display: block;
            }


            /*
            * Skip controls stay very compact.
            */
            #audible-player-utility.apu-minimized
            .apu-compact-control {
                padding:
                    5px 6px;
            }


            /*
            * Finish/chapter stats aren't buttons.
            */
            .apu-compact-stat {
                padding:
                    5px 6px;

                border:
                    1px solid
                    rgba(
                        255,
                        255,
                        255,
                        0.1
                    );

                border-radius: 5px;

                background:
                    rgba(
                        255,
                        255,
                        255,
                        0.035
                    );

                color:
                    rgba(
                        255,
                        255,
                        255,
                        0.78
                    );

                font-size: 11px;

                white-space: nowrap;
            }


            /*
            * The collapse toggle never changes position.
            */
            .apu-collapse {
                flex: 0 0 30px;
            }
        `;

    document.head.appendChild(style);
  }

  // ============================================================
  // Main Update Loop
  // ============================================================

  function update() {
    const found = findMedia();

    if (found) {
      bindMedia(found);
    }

    observePlayback();

    observeChapter();

    updateChapterProgress();

    updateFinishTime();

    /*
     * Keep the settings note preview current while open.
     */
    if (settingsPopup?.classList.contains("open")) {
      updateNotePreview();
    }
  }

  // ============================================================
  // Lifecycle
  // ============================================================

  function saveCurrentPositionSafely() {
    if (!media) {
      return;
    }

    const current = media.currentTime;

    if (!Number.isFinite(current) || current < MIN_VALID_TIME) {
      return;
    }

    /*
     * Do not overwrite the recovery point while we're actively
     * in the suspicious-reset state.
     */
    if (suspiciousJumpDetected) {
      return;
    }

    savePosition(current);
  }

  function init() {
    installStyles();

    createWidget();

    installInteractionTracking();

    setInterval(update, UPDATE_INTERVAL_MS);

    window.addEventListener("pagehide", saveCurrentPositionSafely);

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        saveCurrentPositionSafely();
      }
    });

    update();
  }

  init();
})();
