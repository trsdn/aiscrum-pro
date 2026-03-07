// AiScrum Pro Dashboard — Client-side JavaScript

(function () {
  "use strict";

  // --- State ---
  let ws = null;
  let state = { phase: "init", sprintNumber: 0, startedAt: null };
  let issues = [];
  let activities = [];
  let elapsedTimer = null;
  let elapsedTimerStartedAt = null; // Track which startedAt the timer is running for
  let availableSprints = [];
  let activeSprintNumber = 0; // The sprint actually running
  let viewingSprintNumber = 0; // The sprint being displayed
  let isViewingActive = true; // Whether we're viewing the active sprint
  let repoUrl = null; // GitHub repo URL for linking

  // Per-sprint caches (survive navigation)
  const activityCache = new Map();  // sprintNumber -> activities[]
  const stateCache = new Map();     // sprintNumber -> { state, issues }

  // Chat state
  let chatSessions = []; // { id, role, model }
  let activeChatId = null;
  let chatMessages = {}; // chatId -> [{ role, content }]
  let chatStreaming = {}; // chatId -> current streaming text
  let pendingIdeaContext = null; // { number, title, body } — auto-sent after refiner session created
  let pendingMessages = []; // Queue for messages sent while disconnected

  // --- DOM refs ---
  const $ = (id) => document.getElementById(id);
  const sprintLabel = $("sprint-label");
  const phaseBadge = $("phase-badge");
  const issueCount = $("issue-count");
  const elapsedEl = $("elapsed");
  const btnStart = $("btn-start");
  const btnPrev = $("btn-prev");
  const btnNext = $("btn-next");
  const btnChat = $("btn-chat");
  const viewingIndicator = $("viewing-indicator");
  const issueList = $("issue-list");
  const activityList = $("activity-list");
  const logPanel = $("log-panel");
  const connStatus = $("connection-status");
  const connLabel = $("connection-label");
  const chatPanel = $("chat-panel");
  const chatRole = $("chat-role");
  const btnNewChat = $("btn-new-chat");
  const btnCloseChat = $("btn-close-chat");
  const chatSessionsBar = $("chat-sessions-bar");
  const chatMessagesEl = $("chat-messages");
  const chatInput = $("chat-input");
  const btnSend = $("btn-send");
  const sessionPanel = $("session-panel");
  const sessionListEl = $("session-list");
  const sessionViewer = $("session-viewer");
  const sessionOutput = $("session-output");
  const sessionViewerTitle = $("session-viewer-title");
  const btnBackSessions = $("btn-back-sessions");
  const btnStopSession = $("btn-stop-session");
  const sessionMessageInput = $("session-message-input");
  const btnSendSession = $("btn-send-session");
  const btnPause = $("btn-pause");
  const btnResume = $("btn-resume");
  const btnStop = $("btn-stop");
  const modeToggle = $("mode-toggle");

  // Session viewer state
  let acpSessions = [];
  let viewingSessionId = null;
  let executionMode = "autonomous"; // "autonomous" | "hitl"

  // --- WebSocket ---

  function connect() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${location.host}`);

    connStatus.className = "status-dot status-connecting";
    connLabel.textContent = "Connecting…";

    ws.onopen = () => {
      connStatus.className = "status-dot status-connected";
      connLabel.textContent = "Connected";

      // Flush pending messages
      while (pendingMessages.length > 0) {
        const msg = pendingMessages.shift();
        ws.send(JSON.stringify(msg));
      }

      // Hide disconnect banner if shown
      const banner = document.getElementById("disconnect-banner");
      if (banner) banner.remove();

      // Refresh decisions badge
      refreshDecisionsBadge();
    };

    ws.onclose = () => {
      connStatus.className = "status-dot status-disconnected";
      connLabel.textContent = "Disconnected — reconnecting…";

      // Show prominent disconnect banner
      if (!document.getElementById("disconnect-banner")) {
        const banner = document.createElement("div");
        banner.id = "disconnect-banner";
        banner.className = "disconnect-banner";
        banner.innerHTML = "⚠️ Connection lost — reconnecting…";
        document.body.insertBefore(banner, document.body.firstChild);
      }

      setTimeout(connect, 2000);
    };

    ws.onerror = () => {
      addLog("error", "WebSocket connection error");
      ws.close();
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
      } catch { /* ignore malformed */ }
    };
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    } else {
      pendingMessages.push(msg);
    }
  }

  // --- Message handling ---

  function handleMessage(msg) {
    switch (msg.type) {
      case "sprint:state":
        state = msg.payload;
        if (state.startedAt) state.startedAt = new Date(state.startedAt);
        activeSprintNumber = state.sprintNumber;
        if (viewingSprintNumber === 0) viewingSprintNumber = activeSprintNumber;
        isViewingActive = viewingSprintNumber === activeSprintNumber;
        // Update cache with fresh server state
        if (isViewingActive && state.sprintNumber) {
          stateCache.set(state.sprintNumber, { state: { ...state }, issues: [...issues] });
        }
        renderHeader();
        renderIssues();
        loadSprintList();
        break;

      case "sprint:issues":
        issues = msg.payload || [];
        // Update cache with fresh issues
        if (isViewingActive && viewingSprintNumber) {
          const cached = stateCache.get(viewingSprintNumber);
          if (cached) cached.issues = [...issues];
        }
        renderIssues();
        renderHeader();
        break;

      case "sprint:switched":
        if (msg.payload) {
          activeSprintNumber = msg.payload.activeSprintNumber || activeSprintNumber;
          isViewingActive = viewingSprintNumber === activeSprintNumber;
          renderHeader();
        }
        break;

      case "sprint:event":
        // Only process events if viewing the active sprint
        if (isViewingActive) {
          handleSprintEvent(msg.eventName, msg.payload);
        }
        break;

      case "chat:created":
        handleChatCreated(msg.payload);
        break;

      case "chat:chunk":
        handleChatChunk(msg.payload);
        break;

      case "chat:done":
        handleChatDone(msg.payload);
        break;

      case "chat:error":
        handleChatError(msg.payload);
        break;

      case "backlog:planned":
        handleBacklogPlanned(msg.payload);
        break;

      case "backlog:removed":
        handleBacklogRemoved(msg.payload);
        break;

      case "backlog:error":
        handleBacklogError(msg.payload);
        break;

      case "session:list":
        acpSessions = msg.payload || [];
        renderSessionList();
        // Auto-open newest active session if no session is being viewed
        if (!viewingSessionId) {
          const newest = acpSessions.find((s) => !s.endedAt);
          if (newest) {
            openSessionViewer(newest.sessionId, newest.role, newest.issueNumber);
          }
        }
        break;

      case "session:output":
        handleSessionOutput(msg.payload);
        break;

      case "session:status":
        handleSessionStatus(msg.payload);
        break;
    }
  }

  function handleSprintEvent(name, payload) {
    switch (name) {
      case "sprint:start":
        // Save old sprint's activities before clearing
        if (viewingSprintNumber > 0 && activities.length > 0) {
          activityCache.set(viewingSprintNumber, [...activities]);
        }
        activities = [];
        state.sprintNumber = payload.sprintNumber;
        state.phase = "plan";
        state.startedAt = new Date();
        activeSprintNumber = payload.sprintNumber;
        viewingSprintNumber = payload.sprintNumber;
        isViewingActive = true;
        renderHeader();
        addActivity("sprint", `Sprint ${payload.sprintNumber} started`, null, "active");
        break;

      case "phase:change":
        state.phase = payload.to;
        renderHeader();
        // Mark previous phase activities as done
        activities.forEach((a) => {
          if (a.type === "phase" && a.status === "active") a.status = "done";
        });
        const detail = payload.agent
          ? `${payload.agent}${payload.model ? ` (${payload.model})` : ""}`
          : payload.model || null;
        addActivity("phase", phaseLabel(payload.to), detail, "active");
        break;

      case "sprint:planned":
        // Planning completed — update issue list with planned issues
        if (payload.issues && Array.isArray(payload.issues)) {
          issues = payload.issues.map((i) => ({
            number: i.number,
            title: i.title,
            status: "planned",
          }));
          renderIssues();
          addActivity("phase", `${payload.issues.length} issues planned`, null, "done");
        }
        break;

      case "issue:start":
        updateIssueStatus(payload.issue.number, "in-progress");
        const issueLabel = `#${payload.issue.number} ${payload.issue.title}`;
        const model = payload.model ? `Worker Agent (${payload.model})` : "Worker Agent";
        addActivity("issue", issueLabel, model, "active");
        break;

      case "issue:progress":
        updateActivityDetail(payload.issueNumber, payload.step);
        break;

      case "issue:done":
        updateIssueStatus(payload.issueNumber, "done");
        updateActivityStatus(payload.issueNumber, "done", formatDuration(payload.duration_ms));
        break;

      case "issue:fail":
        updateIssueStatus(payload.issueNumber, "failed", payload.reason);
        updateActivityStatus(payload.issueNumber, "failed", payload.reason);
        break;

      case "sprint:complete":
        state.phase = "complete";
        // Freeze final elapsed time
        if (state.startedAt) {
          state.finalElapsed = Date.now() - new Date(state.startedAt).getTime();
        }
        renderHeader();
        addActivity("sprint", `Sprint ${payload.sprintNumber} complete`, null, "done");
        showNotification("Sprint Complete", `Sprint ${payload.sprintNumber} finished successfully`);
        break;

      case "sprint:error":
        state.phase = "failed";
        renderHeader();
        const errMsg = typeof payload.error === 'string' && payload.error.length > 200
          ? payload.error.substring(0, 200) + '…'
          : payload.error;
        addActivity("sprint", "Sprint error", errMsg, "failed");
        showNotification("Sprint Error", errMsg, true);
        break;

      case "log":
        addLog(payload.level, payload.message);
        break;

      case "mode:changed":
        if (payload.mode === "autonomous" || payload.mode === "hitl") {
          executionMode = payload.mode;
          modeToggle.value = payload.mode;
        }
        break;

      case "decisions:approved":
      case "decisions:rejected":
      case "decisions:commented":
        refreshDecisionsBadge();
        if (document.querySelector('[data-tab="decisions"]')?.classList.contains("active")) {
          loadDecisions();
        }
        break;
    }
  }

  // --- Rendering ---

  function renderHeader() {
    const displayNumber = viewingSprintNumber || state.sprintNumber || "—";
    if (repoUrl) {
      const milestoneUrl = `${repoUrl}/milestone/${displayNumber}`;
      sprintLabel.innerHTML = `<a href="${milestoneUrl}" target="_blank" rel="noopener" class="gh-link">Sprint ${displayNumber} ↗</a>`;
    } else {
      sprintLabel.textContent = `Sprint ${displayNumber}`;
    }

    // Show viewing indicator when not on active sprint
    if (!isViewingActive && activeSprintNumber > 0) {
      viewingIndicator.style.display = "inline";
      viewingIndicator.textContent = `👁 viewing — Sprint ${activeSprintNumber} running`;
    } else {
      viewingIndicator.style.display = "none";
    }

    phaseBadge.textContent = state.phase;
    phaseBadge.className = `phase-badge phase-${state.phase}`;

    const done = issues.filter((i) => i.status === "done").length;
    issueCount.textContent = `${done}/${issues.length} done`;

    // Update nav button states
    updateNavButtons();

    // Elapsed timer — only restart if startedAt changed
    const currentStartedAt = state.startedAt ? new Date(state.startedAt).getTime() : null;
    if (currentStartedAt !== elapsedTimerStartedAt) {
      if (elapsedTimer) clearInterval(elapsedTimer);
      elapsedTimer = null;
      elapsedTimerStartedAt = currentStartedAt;

      if (state.startedAt && state.phase !== "complete" && state.phase !== "failed" && state.phase !== "init" && state.phase !== "paused") {
        updateElapsed();
        elapsedTimer = setInterval(updateElapsed, 1000);
      } else if (state.finalElapsed) {
        // Show frozen final elapsed time
        const totalSec = Math.floor(state.finalElapsed / 1000);
        const min = Math.floor(totalSec / 60);
        const sec = totalSec % 60;
        elapsedEl.textContent = `${min}m ${String(sec).padStart(2, "0")}s ✓`;
      } else if (state.startedAt) {
        updateElapsed();
      } else {
        elapsedEl.textContent = "0m 00s";
      }
    }

    // Toggle sprint control buttons based on phase
    const running = state.phase !== "init" && state.phase !== "complete" && state.phase !== "failed" && state.phase !== "paused";
    const paused = state.phase === "paused";
    const idle = state.phase === "init" || state.phase === "complete" || state.phase === "failed";

    // Start button: only when idle and viewing active sprint
    btnStart.style.display = idle ? "" : "none";
    btnStart.disabled = !isViewingActive;
    if (!isViewingActive) btnStart.textContent = "▶ Start (switch to active)";
    else btnStart.textContent = "▶ Start";

    // Pause button: only when running
    btnPause.style.display = (running && isViewingActive) ? "" : "none";

    // Resume button: only when paused
    btnResume.style.display = (paused && isViewingActive) ? "" : "none";

    // Stop button: when running or paused
    btnStop.style.display = ((running || paused) && isViewingActive) ? "" : "none";

    // Update phase stepper
    updatePhaseStepper(state.phase);
  }

  const PHASE_ORDER = ["plan", "execute", "review", "retro", "complete"];

  function updatePhaseStepper(currentPhase) {
    const stepper = document.getElementById("phase-stepper");
    if (!stepper) return;
    const steps = stepper.querySelectorAll(".step");
    const currentIdx = PHASE_ORDER.indexOf(currentPhase);
    const isFailed = currentPhase === "failed";
    const isPaused = currentPhase === "paused";

    steps.forEach((step) => {
      const phase = step.dataset.phase;
      const idx = PHASE_ORDER.indexOf(phase);
      step.classList.remove("step-done", "step-active", "step-failed", "step-paused");
      if (isFailed) {
        if (idx < currentIdx || currentIdx === -1) step.classList.add("step-done");
        else step.classList.add("step-failed");
      } else if (isPaused) {
        // Use phaseBeforePause to show progress up to where we paused
        const pausedAt = PHASE_ORDER.indexOf(state.phaseBeforePause);
        if (pausedAt >= 0 && idx < pausedAt) step.classList.add("step-done");
        else if (pausedAt >= 0 && idx === pausedAt) step.classList.add("step-paused");
      } else if (currentPhase === "init") {
        // Nothing highlighted yet
      } else if (idx < currentIdx) {
        step.classList.add("step-done");
      } else if (idx === currentIdx) {
        step.classList.add("step-active");
      }
    });
  }

  function updateElapsed() {
    if (!state.startedAt) return;
    const ms = Date.now() - new Date(state.startedAt).getTime();
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    elapsedEl.textContent = `${min}m ${String(sec).padStart(2, "0")}s`;
  }

  const EXECUTION_STEPS = ["plan", "tdd", "implement", "quality gate", "code review"];

  function renderIssues() {
    issueList.innerHTML = "";
    if (!issues || !Array.isArray(issues)) return;
    for (const issue of issues) {
      if (!issue) continue;
      const li = document.createElement("li");
      li.className = `issue-${issue.status}`;
      const issueLink = repoUrl
        ? `<a href="${repoUrl}/issues/${issue.number}" target="_blank" rel="noopener" class="gh-link">#${issue.number}</a>`
        : `#${issue.number}`;

      let stepsHtml = "";
      if (issue.status === "in-progress" && issue.currentStep) {
        stepsHtml = '<div class="issue-steps">' + EXECUTION_STEPS.map((step) => {
          const isCurrent = issue.currentStep === step;
          const isPast = EXECUTION_STEPS.indexOf(step) < EXECUTION_STEPS.indexOf(issue.currentStep);
          const cls = isCurrent ? "step-current" : isPast ? "step-done" : "step-pending";
          return `<span class="issue-step ${cls}">${escapeHtml(step)}</span>`;
        }).join('<span class="step-sep">→</span>') + '</div>';
      }

      li.innerHTML = `
        <span class="issue-icon">${statusIcon(issue.status)}</span>
        <span class="issue-number">${issueLink}</span>
        <span class="issue-title">${escapeHtml(issue.title)}</span>
        ${issue.failReason ? `<span class="issue-fail-reason">${escapeHtml(issue.failReason)}</span>` : ""}
        ${stepsHtml}
      `;
      issueList.appendChild(li);
    }
  }

  function renderActivities() {
    activityList.innerHTML = "";
    for (const a of activities) {
      const li = document.createElement("li");
      li.className = `activity-${a.status}`;
      li.innerHTML = `
        <span class="activity-icon">${activityIcon(a.status)}</span>
        <div class="activity-content">
          <span class="activity-time">${a.time || ""}</span>
          <div class="activity-label">${escapeHtml(a.label)}</div>
          ${a.detail ? `<div class="activity-detail">${escapeHtml(a.detail)}</div>` : ""}
        </div>
        ${a.status === "active" && a.startedAt ? `<span class="activity-elapsed" data-started="${a.startedAt}"></span>` : ""}
      `;
      activityList.appendChild(li);
    }
    // Scroll to bottom
    activityList.scrollTop = activityList.scrollHeight;
  }

  // --- Activity helpers ---

  function addActivity(type, label, detail, status) {
    const time = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    activities.push({ type, label, detail, status, startedAt: status === "active" ? Date.now() : null, time });
    renderActivities();
  }

  function updateIssueStatus(issueNumber, status, failReason) {
    const issue = issues.find((i) => i.number === issueNumber);
    if (issue) {
      issue.status = status;
      if (failReason) issue.failReason = failReason;
      renderIssues();
      renderHeader();
    }
  }

  function updateActivityDetail(issueNumber, step) {
    // Update issue step indicator
    const issue = issues.find((i) => i.number === issueNumber);
    if (issue) {
      issue.currentStep = step;
      renderIssues();
    }
    // Update activity feed
    const prefix = `#${issueNumber}`;
    for (let i = activities.length - 1; i >= 0; i--) {
      if (activities[i].label.startsWith(prefix) && activities[i].status === "active") {
        activities[i].detail = step;
        renderActivities();
        return;
      }
    }
  }

  function updateActivityStatus(issueNumber, status, detail) {
    const prefix = `#${issueNumber}`;
    for (let i = activities.length - 1; i >= 0; i--) {
      if (activities[i].label.startsWith(prefix)) {
        activities[i].status = status;
        if (detail) activities[i].detail = detail;
        activities[i].startedAt = null;
        renderActivities();
        return;
      }
    }
  }

  function addLog(level, message) {
    const time = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const div = document.createElement("div");
    div.className = "log-entry";
    div.innerHTML = `
      <span class="log-time">${time}</span>
      <span class="log-level log-level-${level}">${level.toUpperCase()}</span>
      <span class="log-message">${escapeHtml(message)}</span>
    `;
    logPanel.appendChild(div);
    logPanel.scrollTop = logPanel.scrollHeight;
  }

  // --- Utility ---

  function statusIcon(status) {
    switch (status) {
      case "planned": return "○";
      case "in-progress": return "●";
      case "done": return "✓";
      case "failed": return "✗";
      default: return "○";
    }
  }

  function activityIcon(status) {
    switch (status) {
      case "active": return "▸";
      case "done": return "✓";
      case "failed": return "✗";
      default: return "·";
    }
  }

  function phaseLabel(phase) {
    const labels = {
      refine: "Refining backlog",
      plan: "Planning sprint",
      execute: "Executing issues",
      review: "Sprint review",
      retro: "Retrospective",
    };
    return labels[phase] || phase;
  }

  function formatDuration(ms) {
    if (!ms) return "";
    const sec = Math.floor(ms / 1000);
    const min = Math.floor(sec / 60);
    return min > 0 ? `${min}m ${sec % 60}s` : `${sec}s`;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Sprint navigation ---

  async function loadSprintList() {
    try {
      const res = await fetch("/api/sprints");
      if (res.ok) {
        availableSprints = await res.json();
        updateNavButtons();
      }
    } catch { /* ignore */ }
  }

  async function loadRepoInfo() {
    try {
      const res = await fetch("/api/repo");
      if (res.ok) {
        const data = await res.json();
        repoUrl = data.url || null;
        // Re-render to add links
        renderHeader();
        renderIssues();
      }
    } catch { /* ignore */ }
  }

  function updateNavButtons() {
    if (availableSprints.length === 0) {
      // Even without sprint list, allow navigating if we know the active sprint
      btnPrev.disabled = viewingSprintNumber <= 1;
      btnNext.disabled = false;
      return;
    }
    const numbers = availableSprints.map((s) => s.sprintNumber);
    const minSprint = Math.min(...numbers, 1); // Always allow sprint 1
    const maxSprint = Math.max(...numbers);
    btnPrev.disabled = viewingSprintNumber <= minSprint;
    btnNext.disabled = viewingSprintNumber > maxSprint;
  }

  async function switchToSprint(sprintNumber) {
    if (sprintNumber < 1) return;

    // Save current sprint's activities + state before switching away
    if (viewingSprintNumber > 0) {
      activityCache.set(viewingSprintNumber, [...activities]);
      stateCache.set(viewingSprintNumber, { state: { ...state }, issues: [...issues] });
    }

    viewingSprintNumber = sprintNumber;
    isViewingActive = sprintNumber === activeSprintNumber;

    if (isViewingActive) {
      // Restore cached state immediately to avoid "init" flash
      const cached = stateCache.get(sprintNumber);
      if (cached) {
        state = { ...cached.state };
        issues = [...cached.issues];
      }
      // Restore cached activities instead of clearing
      const cachedActivities = activityCache.get(sprintNumber);
      activities = cachedActivities ? [...cachedActivities] : [];
      renderIssues();
      renderHeader();
      renderActivities();
      // Request fresh state + issues from server (new events will append)
      send({ type: "sprint:switch", sprintNumber });
      return;
    }

    // Historical sprint — check cache first
    const cachedState = stateCache.get(sprintNumber);
    const cachedActivities = activityCache.get(sprintNumber);
    if (cachedState && cachedActivities) {
      state = { ...cachedState.state };
      issues = [...cachedState.issues];
      activities = [...cachedActivities];
      renderIssues();
      renderHeader();
      renderActivities();
      loadSprintList();
      return;
    }

    // Cache miss — load historical sprint from API
    try {
      const [stateRes, issuesRes] = await Promise.all([
        fetch(`/api/sprints/${sprintNumber}/state`),
        fetch(`/api/sprints/${sprintNumber}/issues`),
      ]);

      if (stateRes.ok) {
        state = await stateRes.json();
        if (state.startedAt) state.startedAt = new Date(state.startedAt);
      }

      if (issuesRes.ok) {
        issues = await issuesRes.json();
      } else {
        issues = [];
      }

      // Rebuild activities from saved state
      activities = [];
      if (state.phase && state.phase !== "init") {
        if (state.plan) addActivity("phase", "Planning sprint", "completed", "done");
        if (state.result) {
          addActivity("phase", "Executing issues", null, "done");
          for (const r of (state.result.results || [])) {
            const label = `#${r.issueNumber} ${r.title || ""}`.trim();
            addActivity("issue", label, null, r.status === "completed" ? "done" : "failed");
          }
        }
        if (state.review) addActivity("phase", "Sprint review", null, "done");
        if (state.retro) addActivity("phase", "Retrospective", null, "done");
      }

      // If no issues found, show empty state message
      if (issues.length === 0 && state.phase === "init") {
        addActivity("sprint", `Sprint ${sprintNumber}`, "No saved state available", "done");
      }

      // Cache for future navigation
      stateCache.set(sprintNumber, { state: { ...state }, issues: [...issues] });
      activityCache.set(sprintNumber, [...activities]);

      renderIssues();
      renderHeader();
      renderActivities();
    } catch {
      addLog("error", `Failed to load Sprint ${sprintNumber} state`);
    }
    // Refresh sprint list (might have changed)
    loadSprintList();
  }

  // --- Activity elapsed timer ---
  setInterval(() => {
    const spans = document.querySelectorAll(".activity-elapsed[data-started]");
    for (const span of spans) {
      const started = parseInt(span.dataset.started, 10);
      const ms = Date.now() - started;
      const sec = Math.floor(ms / 1000);
      const min = Math.floor(sec / 60);
      span.textContent = min > 0 ? `${min}m ${String(sec % 60).padStart(2, "0")}s` : `${sec}s`;
    }
  }, 1000);

  // --- Browser notifications ---

  function requestNotificationPermission() {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }

  function showNotification(title, body, isError) {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, {
        body: body,
        icon: isError ? "❌" : "✅",
        tag: "aiscrum",
      });
    }
  }

  // --- Chat functions ---

  function handleChatCreated(payload) {
    const session = { id: payload.sessionId, role: payload.role, model: payload.model };
    chatSessions.push(session);
    chatMessages[session.id] = [];
    chatStreaming[session.id] = "";
    activeChatId = session.id;
    renderChatTabs();
    renderChatMessages();
    btnSend.disabled = false;
    chatInput.focus();
    addChatSystemMessage(`Session started — ${session.role} agent (${session.model || "default"})`);

    // Auto-send idea/blocked-issue context if pending
    if (pendingIdeaContext) {
      const ctx = pendingIdeaContext;
      pendingIdeaContext = null;
      let contextMessage;
      if (ctx.isBlocked) {
        contextMessage = `I need help with blocked issue #${ctx.number}: "${ctx.title}"\n\n` +
          `Issue description:\n${ctx.body}\n\n` +
          `This issue failed quality gate checks and is currently blocked. ` +
          `Please help me understand what went wrong and suggest how to fix it.`;
      } else {
        contextMessage = `Refine issue #${ctx.number} ("${ctx.title}"). Start by reading the full issue with \`gh issue view ${ctx.number}\`, then ask me clarifying questions before drafting the refined version.`;
      }
      chatMessages[session.id].push({ role: "user", content: contextMessage });
      btnSend.disabled = true;
      chatInput.disabled = true;
      renderChatMessages();
      send({ type: "chat:send", sessionId: session.id, message: contextMessage });
    }
  }

  function handleChatChunk(payload) {
    const { sessionId, text } = payload;
    if (!chatStreaming[sessionId]) chatStreaming[sessionId] = "";
    chatStreaming[sessionId] += text;
    if (sessionId === activeChatId) {
      renderChatMessages();
    }
  }

  function handleChatDone(payload) {
    const { sessionId, response } = payload;
    chatStreaming[sessionId] = "";
    if (!chatMessages[sessionId]) chatMessages[sessionId] = [];
    chatMessages[sessionId].push({ role: "assistant", content: response });
    if (sessionId === activeChatId) {
      renderChatMessages();
    }
    btnSend.disabled = false;
    chatInput.disabled = false;
  }

  function handleChatError(payload) {
    const msg = payload.error || "Unknown error";
    if (payload.sessionId && payload.sessionId === activeChatId) {
      addChatSystemMessage(`Error: ${msg}`);
    } else {
      addChatSystemMessage(`Error: ${msg}`);
    }
    btnSend.disabled = false;
    chatInput.disabled = false;
  }

  function addChatSystemMessage(text) {
    if (!activeChatId) return;
    if (!chatMessages[activeChatId]) chatMessages[activeChatId] = [];
    chatMessages[activeChatId].push({ role: "system", content: text });
    renderChatMessages();
  }

  function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text || !activeChatId) return;

    chatMessages[activeChatId].push({ role: "user", content: text });
    chatInput.value = "";
    btnSend.disabled = true;
    chatInput.disabled = true;
    renderChatMessages();

    send({ type: "chat:send", sessionId: activeChatId, message: text });
  }

  function createChatSession() {
    const role = chatRole.value;
    send({ type: "chat:create", role });
    addLog("info", `Creating ${role} chat session…`);
  }

  function toggleChatPanel() {
    const visible = chatPanel.style.display !== "none";
    chatPanel.style.display = visible ? "none" : "flex";
    document.querySelector("main").classList.toggle("chat-open", !visible);
    btnChat.textContent = visible ? "💬 Chat" : "💬 Close";
    if (!visible && chatSessions.length === 0) {
      createChatSession();
    }
  }

  function renderChatTabs() {
    chatSessionsBar.innerHTML = "";
    for (const session of chatSessions) {
      const tab = document.createElement("button");
      tab.className = `chat-tab${session.id === activeChatId ? " active" : ""}`;
      tab.textContent = `${session.role}`;
      tab.onclick = () => {
        activeChatId = session.id;
        renderChatTabs();
        renderChatMessages();
      };
      chatSessionsBar.appendChild(tab);
    }
  }

  function renderChatMessages() {
    chatMessagesEl.innerHTML = "";
    if (!activeChatId) return;

    const msgs = chatMessages[activeChatId] || [];
    for (const msg of msgs) {
      const div = document.createElement("div");
      if (msg.role === "system") {
        div.className = "chat-msg chat-msg-system";
      } else {
        div.className = `chat-msg chat-msg-${msg.role}`;
      }
      div.textContent = msg.content;
      chatMessagesEl.appendChild(div);
    }

    // Show streaming text
    const streaming = chatStreaming[activeChatId];
    if (streaming) {
      const div = document.createElement("div");
      div.className = "chat-msg chat-msg-assistant chat-msg-streaming";
      div.textContent = streaming;
      chatMessagesEl.appendChild(div);
    }

    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }

  // --- Init ---

  btnStart.addEventListener("click", () => {
    if (!isViewingActive) {
      switchToSprint(activeSprintNumber);
      return;
    }
    send({ type: "sprint:start" });
    btnStart.disabled = true;
    btnStart.textContent = "⏳ Starting…";
  });

  btnPause.addEventListener("click", () => {
    send({ type: "sprint:pause" });
    addLog("info", "Pause requested…");
  });

  btnResume.addEventListener("click", () => {
    send({ type: "sprint:resume" });
    addLog("info", "Resuming sprint…");
  });

  btnStop.addEventListener("click", () => {
    if (!confirm("Stop this sprint? Execution will be halted.")) return;
    send({ type: "sprint:stop" });
    addLog("warn", "Sprint stop requested");
  });

  modeToggle.addEventListener("change", () => {
    executionMode = modeToggle.value;
    send({ type: "mode:set", mode: executionMode });
    addLog("info", `Switched to ${executionMode === "hitl" ? "Human-in-the-Loop" : "Autonomous"} mode`);
  });

  // --- Tab Navigation ---

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("tab-active"));
      btn.classList.add("tab-active");
      document.querySelectorAll(".tab-content").forEach((c) => {
        c.style.display = "none";
        c.classList.remove("tab-visible");
      });
      const target = $("tab-" + tab);
      if (target) {
        target.style.display = "";
        target.classList.add("tab-visible");
      }
      if (tab === "backlog") loadBacklog();
      if (tab === "blocked") loadBlocked();
      if (tab === "decisions") loadDecisions();
      if (tab === "ideas") loadIdeas();
    });
  });

  // --- Backlog & Ideas ---

  async function loadBacklog() {
    try {
      const [backlogRes, capRes] = await Promise.all([
        fetch("/api/backlog"),
        fetch("/api/sprint-capacity"),
      ]);
      if (!backlogRes.ok) return;
      const items = await backlogRes.json();
      const list = $("backlog-list");
      const empty = $("backlog-empty");
      const count = $("backlog-count");
      const capacityEl = $("sprint-capacity");

      // Show capacity
      if (capRes.ok) {
        const cap = await capRes.json();
        capacityEl.textContent = `Sprint ${cap.sprintNumber}: ${cap.plannedCount} / ${cap.maxIssues} slots`;
        capacityEl.className = cap.plannedCount >= cap.maxIssues
          ? "capacity-badge capacity-full" : "capacity-badge";
      }

      list.innerHTML = "";
      count.textContent = `${items.length} issue${items.length !== 1 ? "s" : ""}`;
      if (items.length === 0) {
        empty.style.display = "";
        return;
      }
      empty.style.display = "none";
      for (const item of items) {
        const li = document.createElement("li");
        li.className = "backlog-item";
        li.dataset.issueNumber = item.number;
        const issueLink = repoUrl
          ? `<a href="${repoUrl}/issues/${item.number}" target="_blank" rel="noopener" class="gh-link">#${item.number}</a>`
          : `#${item.number}`;
        const labels = (item.labels || [])
          .filter((l) => l !== "status:refined")
          .map((l) => `<span class="label-tag">${escapeHtml(l)}</span>`)
          .join("");
        li.innerHTML = `
          <span class="backlog-number">${issueLink}</span>
          <span class="backlog-title">${escapeHtml(item.title)}</span>
          <span class="backlog-labels">${labels}</span>
        `;
        // Action buttons
        const actions = document.createElement("span");
        actions.className = "backlog-actions";

        const planBtn = document.createElement("button");
        planBtn.className = "btn btn-small btn-plan";
        planBtn.textContent = "📋 + Sprint";
        planBtn.onclick = () => planIssue(item.number, li);
        actions.appendChild(planBtn);

        const refineBtn = document.createElement("button");
        refineBtn.className = "btn btn-small btn-refine";
        refineBtn.textContent = "💬 Re-refine";
        refineBtn.onclick = () => refineIdea(item);
        actions.appendChild(refineBtn);

        li.appendChild(actions);
        list.appendChild(li);
      }
    } catch {
      addLog("error", "Failed to load backlog");
    }
  }

  function planIssue(issueNumber, listItem) {
    listItem.classList.add("planning");
    const btn = listItem.querySelector(".btn-plan");
    if (btn) { btn.disabled = true; btn.textContent = "⏳ Planning…"; }
    send({ type: "backlog:plan-issue", issueNumber });
  }

  function handleBacklogPlanned(payload) {
    const { issueNumber, sprintNumber } = payload;
    // Remove from backlog list with animation
    const item = document.querySelector(`[data-issue-number="${issueNumber}"]`);
    if (item) {
      item.classList.add("planned-done");
      setTimeout(() => item.remove(), 400);
    }
    addLog("info", `#${issueNumber} added to Sprint ${sprintNumber}`);
    // Update capacity
    const capEl = $("sprint-capacity");
    if (capEl) fetch("/api/sprint-capacity").then(r => r.json()).then(cap => {
      capEl.textContent = `Sprint ${cap.sprintNumber}: ${cap.plannedCount} / ${cap.maxIssues} slots`;
      capEl.className = cap.plannedCount >= cap.maxIssues ? "capacity-badge capacity-full" : "capacity-badge";
    }).catch(() => {});
    // Update backlog count
    const remaining = document.querySelectorAll("#backlog-list .backlog-item:not(.planned-done)").length;
    const countEl = $("backlog-count");
    if (countEl) countEl.textContent = `${remaining} issue${remaining !== 1 ? "s" : ""}`;
  }

  function handleBacklogRemoved(payload) {
    addLog("info", `#${payload.issueNumber} removed from sprint`);
    loadBacklog();
  }

  function handleBacklogError(payload) {
    const { issueNumber, error } = payload;
    addLog("error", `Failed to plan #${issueNumber}: ${error}`);
    // Reset button state
    const item = document.querySelector(`[data-issue-number="${issueNumber}"]`);
    if (item) {
      item.classList.remove("planning");
      const btn = item.querySelector(".btn-plan");
      if (btn) { btn.disabled = false; btn.textContent = "📋 + Sprint"; }
    }
  }

  async function loadIdeas() {
    try {
      const res = await fetch("/api/ideas");
      if (!res.ok) return;
      const items = await res.json();
      const list = $("ideas-list");
      const empty = $("ideas-empty");
      const count = $("ideas-count");
      list.innerHTML = "";
      count.textContent = `${items.length} idea${items.length !== 1 ? "s" : ""}`;
      if (items.length === 0) {
        empty.style.display = "";
        return;
      }
      empty.style.display = "none";
      for (const item of items) {
        const li = document.createElement("li");
        li.className = "backlog-item idea-item";
        const issueLink = repoUrl
          ? `<a href="${repoUrl}/issues/${item.number}" target="_blank" rel="noopener" class="gh-link">#${item.number}</a>`
          : `#${item.number}`;
        li.innerHTML = `
          <span class="backlog-number">${issueLink}</span>
          <span class="backlog-title">${escapeHtml(item.title)}</span>
          ${item.body ? `<span class="idea-body">${escapeHtml(item.body)}</span>` : ""}
        `;
        const refineBtn = document.createElement("button");
        refineBtn.className = "btn btn-small btn-refine";
        refineBtn.textContent = "💬 Refine";
        refineBtn.onclick = () => refineIdea(item);
        li.appendChild(refineBtn);
        list.appendChild(li);
      }
    } catch {
      addLog("error", "Failed to load ideas");
    }
  }

  function refineIdea(idea) {
    pendingIdeaContext = idea;
    // Open chat panel if not visible
    if (chatPanel.style.display === "none") {
      chatPanel.style.display = "flex";
      document.querySelector("main").classList.add("chat-open");
      btnChat.textContent = "💬 Close";
    }
    // Set dropdown to refiner for consistency
    chatRole.value = "refiner";
    // Create refiner session directly
    send({ type: "chat:create", role: "refiner" });
    addLog("info", `Starting refinement chat for #${idea.number}…`);
  }

  function chatAboutIssue(issue) {
    pendingIdeaContext = {
      number: issue.number,
      title: issue.title,
      body: issue.body || "",
      isBlocked: true,
    };
    // Open chat panel if not visible
    if (chatPanel.style.display === "none") {
      chatPanel.style.display = "flex";
      document.querySelector("main").classList.add("chat-open");
      btnChat.textContent = "💬 Close";
    }
    chatRole.value = "reviewer";
    send({ type: "chat:create", role: "reviewer" });
    addLog("info", `Opening agent chat for blocked issue #${issue.number}…`);
  }

  $("btn-refresh-backlog")?.addEventListener("click", loadBacklog);
  $("btn-refresh-ideas")?.addEventListener("click", loadIdeas);
  $("btn-refresh-blocked")?.addEventListener("click", loadBlocked);
  $("btn-refresh-decisions")?.addEventListener("click", loadDecisions);

  async function loadBlocked() {
    try {
      const res = await fetch("/api/blocked");
      if (!res.ok) return;
      const items = await res.json();
      const list = $("blocked-list");
      const empty = $("blocked-empty");
      const count = $("blocked-count");
      list.innerHTML = "";
      count.textContent = `${items.length} blocked`;
      if (items.length === 0) {
        empty.style.display = "";
        return;
      }
      empty.style.display = "none";
      for (const item of items) {
        const li = document.createElement("li");
        li.className = "backlog-item blocked-item";
        const issueLink = repoUrl
          ? `<a href="${repoUrl}/issues/${item.number}" target="_blank" rel="noopener" class="gh-link">#${item.number}</a>`
          : `#${item.number}`;
        li.innerHTML = `
          <span class="backlog-number">${issueLink}</span>
          <span class="backlog-title">${escapeHtml(item.title)}</span>
          ${item.body ? `<span class="idea-body">${escapeHtml(item.body.slice(0, 200))}</span>` : ""}
        `;
        const commentBtn = document.createElement("button");
        commentBtn.className = "btn btn-small";
        commentBtn.textContent = "💬 Comment";
        commentBtn.onclick = () => {
          const text = prompt("Add comment to #" + item.number + ":");
          if (text) send({ type: "blocked:comment", issueNumber: item.number, body: text });
        };
        li.appendChild(commentBtn);

        const unblockBtn = document.createElement("button");
        unblockBtn.className = "btn btn-small btn-primary";
        unblockBtn.textContent = "🔓 Unblock";
        unblockBtn.onclick = () => {
          send({ type: "blocked:unblock", issueNumber: item.number });
          li.remove();
          const remaining = list.children.length;
          count.textContent = `${remaining} blocked`;
          if (remaining === 0) empty.style.display = "";
        };
        li.appendChild(unblockBtn);

        const askBtn = document.createElement("button");
        askBtn.className = "btn btn-small btn-primary";
        askBtn.textContent = "🤖 Ask Agent";
        askBtn.onclick = () => chatAboutIssue(item);
        li.appendChild(askBtn);

        list.appendChild(li);
      }
    } catch {
      addLog("error", "Failed to load blocked issues");
    }
  }

  async function loadDecisions() {
    try {
      const res = await fetch("/api/decisions");
      if (!res.ok) return;
      const items = await res.json();
      const list = $("decisions-list");
      const empty = $("decisions-empty");
      const count = $("decisions-count");
      const badge = $("decisions-badge");
      list.innerHTML = "";
      count.textContent = `${items.length} pending`;
      if (badge) {
        if (items.length > 0) {
          badge.textContent = items.length;
          badge.style.display = "";
        } else {
          badge.style.display = "none";
        }
      }
      if (items.length === 0) {
        empty.style.display = "";
        return;
      }
      empty.style.display = "none";
      for (const item of items) {
        const li = document.createElement("li");
        li.className = "backlog-item decision-item";
        const issueLink = repoUrl
          ? `<a href="${repoUrl}/issues/${item.number}" target="_blank" rel="noopener" class="gh-link">#${item.number}</a>`
          : `#${item.number}`;
        const labels = (item.labels || [])
          .filter((l) => l !== "human-decision-needed")
          .map((l) => `<span class="label-tag">${escapeHtml(l)}</span>`)
          .join(" ");
        li.innerHTML = `
          <span class="backlog-number">${issueLink}</span>
          <span class="backlog-title">${escapeHtml(item.title)}</span>
          ${labels ? `<span class="decision-labels">${labels}</span>` : ""}
          ${item.body ? `<span class="idea-body">${escapeHtml(item.body.slice(0, 300))}</span>` : ""}
        `;
        const approveBtn = document.createElement("button");
        approveBtn.className = "btn btn-small btn-primary";
        approveBtn.textContent = "✅ Approve";
        approveBtn.onclick = () => {
          send({ type: "decisions:approve", issueNumber: item.number });
          li.remove();
          updateDecisionCount(list, count, empty, badge);
        };
        li.appendChild(approveBtn);

        const rejectBtn = document.createElement("button");
        rejectBtn.className = "btn btn-small btn-danger";
        rejectBtn.textContent = "❌ Reject";
        rejectBtn.onclick = () => {
          if (confirm("Reject and close #" + item.number + "?")) {
            send({ type: "decisions:reject", issueNumber: item.number });
            li.remove();
            updateDecisionCount(list, count, empty, badge);
          }
        };
        li.appendChild(rejectBtn);

        const commentBtn = document.createElement("button");
        commentBtn.className = "btn btn-small";
        commentBtn.textContent = "💬 Comment";
        commentBtn.onclick = () => {
          const text = prompt("Add comment to #" + item.number + ":");
          if (text) send({ type: "decisions:comment", issueNumber: item.number, body: text });
        };
        li.appendChild(commentBtn);

        list.appendChild(li);
      }
    } catch {
      addLog("error", "Failed to load decisions");
    }
  }

  function updateDecisionCount(list, count, empty, badge) {
    const remaining = list.children.length;
    count.textContent = `${remaining} pending`;
    if (badge) {
      if (remaining > 0) {
        badge.textContent = remaining;
        badge.style.display = "";
      } else {
        badge.style.display = "none";
      }
    }
    if (remaining === 0) empty.style.display = "";
  }

  // Load decisions count on connect for badge
  async function refreshDecisionsBadge() {
    try {
      const res = await fetch("/api/decisions");
      if (!res.ok) return;
      const items = await res.json();
      const badge = $("decisions-badge");
      if (badge) {
        if (items.length > 0) {
          badge.textContent = items.length;
          badge.style.display = "";
        } else {
          badge.style.display = "none";
        }
      }
    } catch { /* ignore */ }
  }

  btnPrev.addEventListener("click", () => {
    if (viewingSprintNumber > 1) {
      switchToSprint(viewingSprintNumber - 1);
    }
  });

  btnNext.addEventListener("click", () => {
    switchToSprint(viewingSprintNumber + 1);
  });

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    // Don't capture arrow keys when typing in chat
    if (document.activeElement === chatInput) return;
    if (e.key === "ArrowLeft" && !btnPrev.disabled) btnPrev.click();
    if (e.key === "ArrowRight" && !btnNext.disabled) btnNext.click();
  });

  // Chat controls
  btnChat.addEventListener("click", toggleChatPanel);
  btnNewChat.addEventListener("click", createChatSession);
  btnCloseChat.addEventListener("click", toggleChatPanel);
  btnSend.addEventListener("click", sendChatMessage);
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  // --- Session viewer ---

  function renderSessionList() {
    sessionListEl.innerHTML = "";
    if (acpSessions.length === 0) {
      sessionListEl.innerHTML = '<li class="session-empty">No active ACP sessions</li>';
      return;
    }

    // Group sessions by issue number
    const byIssue = new Map(); // issueNumber -> sessions[]
    const noIssue = [];
    for (const s of acpSessions) {
      if (s.issueNumber) {
        if (!byIssue.has(s.issueNumber)) byIssue.set(s.issueNumber, []);
        byIssue.get(s.issueNumber).push(s);
      } else {
        noIssue.push(s);
      }
    }

    // Sort groups: active issues first
    const sortedGroups = [...byIssue.entries()].sort((a, b) => {
      const aActive = a[1].some((s) => !s.endedAt);
      const bActive = b[1].some((s) => !s.endedAt);
      if (aActive && !bActive) return -1;
      if (!aActive && bActive) return 1;
      return b[0] - a[0];
    });

    // Render ungrouped sessions first (ceremonies, etc.)
    for (const s of noIssue.sort((a, b) => b.startedAt - a.startedAt)) {
      sessionListEl.appendChild(createSessionItem(s));
    }

    // Render grouped sessions with issue header
    for (const [issueNum, sessions] of sortedGroups) {
      const header = document.createElement("li");
      header.className = "session-group-header";
      const hasActive = sessions.some((s) => !s.endedAt);
      header.innerHTML = `<span class="session-group-icon">${hasActive ? "⚡" : "✅"}</span> Issue #${issueNum}`;
      sessionListEl.appendChild(header);

      const sorted = sessions.sort((a, b) => a.startedAt - b.startedAt);
      for (const s of sorted) {
        const li = createSessionItem(s, true);
        sessionListEl.appendChild(li);
      }
    }
  }

  function createSessionItem(s, indented = false) {
    const li = document.createElement("li");
    li.className = `session-item ${s.endedAt ? "session-ended" : "session-active"}${indented ? " session-indented" : ""}`;
    const elapsed = formatElapsed(s.endedAt ? s.endedAt - s.startedAt : Date.now() - s.startedAt);
    const statusIcon = s.endedAt ? "✅" : "⚡";
    const issueLabel = !indented && s.issueNumber ? ` — #${s.issueNumber}` : "";
    li.innerHTML = `
      <span class="session-status">${statusIcon}</span>
      <div class="session-info">
        <span class="session-role">${escapeHtml(s.role)}${issueLabel}</span>
        <span class="session-meta">${s.model || "default"} · ${elapsed}</span>
      </div>
      <button class="btn btn-small session-view-btn" data-sid="${escapeHtml(s.sessionId)}">View</button>
    `;
    li.querySelector(".session-view-btn").addEventListener("click", () => {
      openSessionViewer(s.sessionId, s.role, s.issueNumber);
    });
    return li;
  }

  function openSessionViewer(sessionId, role, issueNumber) {
    viewingSessionId = sessionId;
    sessionListEl.style.display = "none";
    sessionViewer.style.display = "flex";
    const issueLabel = issueNumber ? ` — #${issueNumber}` : "";
    sessionViewerTitle.textContent = `${role}${issueLabel}`;
    sessionOutput.innerHTML = "";
    sessionOutput._rawText = "";
    // Subscribe to output stream
    send({ type: "session:subscribe", sessionId });
  }

  function closeSessionViewer() {
    if (viewingSessionId) {
      send({ type: "session:unsubscribe", sessionId: viewingSessionId });
      viewingSessionId = null;
    }
    sessionViewer.style.display = "none";
    sessionListEl.style.display = "";
  }

  /** Minimal markdown → HTML renderer for ACP session output. */
  function renderMarkdown(text) {
    // Split into blocks for table detection
    const lines = text.split('\n');
    const rendered = [];
    let i = 0;

    while (i < lines.length) {
      // Detect markdown tables (lines with |)
      if (lines[i].includes('|') && i + 1 < lines.length && /^\s*\|[\s:-]+\|/.test(lines[i + 1])) {
        const tableLines = [];
        while (i < lines.length && lines[i].includes('|')) {
          tableLines.push(lines[i]);
          i++;
        }
        rendered.push(renderTable(tableLines));
        continue;
      }
      rendered.push(lines[i]);
      i++;
    }

    return escapeHtml(rendered.join('\n'))
      // Code blocks: ```lang\n...\n```
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="md-code-block"><code>$2</code></pre>')
      // Inline code: `code`
      .replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>')
      // Bold: **text**
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      // Italic: *text* (but not **bold**)
      .replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>')
      // Headers: ### text
      .replace(/^### (.+)$/gm, '<div class="md-h3">$1</div>')
      .replace(/^## (.+)$/gm, '<div class="md-h2">$1</div>')
      .replace(/^# (.+)$/gm, '<div class="md-h1">$1</div>')
      // Horizontal rule
      .replace(/^---+$/gm, '<hr class="md-hr">')
      // Bullet lists: - item
      .replace(/^- (.+)$/gm, '<div class="md-li">• $1</div>')
      // Numbered lists: 1. item
      .replace(/^\d+\. (.+)$/gm, '<div class="md-li">$1</div>')
      // Checkboxes
      .replace(/^- \[x\] (.+)$/gm, '<div class="md-li">☑ $1</div>')
      .replace(/^- \[ \] (.+)$/gm, '<div class="md-li">☐ $1</div>')
      // Preserve line breaks
      .replace(/\n/g, '<br>');
  }

  function renderTable(lines) {
    if (lines.length < 2) return lines.join('\n');
    const parseRow = (line) => line.split('|').map(c => c.trim()).filter(c => c.length > 0);
    const headers = parseRow(lines[0]);
    // Skip separator line (index 1)
    const rows = lines.slice(2).map(parseRow);
    let html = '<table class="md-table"><thead><tr>';
    for (const h of headers) html += `<th>${escapeHtml(h)}</th>`;
    html += '</tr></thead><tbody>';
    for (const row of rows) {
      html += '<tr>';
      for (const cell of row) html += `<td>${escapeHtml(cell)}</td>`;
      html += '</tr>';
    }
    html += '</tbody></table>';
    return html;
  }

  function handleSessionOutput(payload) {
    if (payload.sessionId !== viewingSessionId) return;
    if (payload.isHistory) {
      // Replay buffered history with visual separator
      sessionOutput._rawText = payload.text;
      sessionOutput.innerHTML = renderMarkdown(payload.text)
        + '<hr class="md-hr"><div class="session-history-marker">▲ History — ▼ Live</div>';
    } else {
      // Append live output
      sessionOutput._rawText = (sessionOutput._rawText || "") + payload.text;
      sessionOutput.innerHTML = renderMarkdown(sessionOutput._rawText);
    }
    // Auto-scroll to bottom
    sessionOutput.scrollTop = sessionOutput.scrollHeight;
  }

  function formatElapsed(ms) {
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    const remaining = sec % 60;
    return `${min}m ${String(remaining).padStart(2, "0")}s`;
  }

  // Session viewer event listeners
  btnBackSessions.addEventListener("click", closeSessionViewer);

  // Interactive session controls
  function sendSessionMessage() {
    const msg = sessionMessageInput.value.trim();
    if (!msg || !viewingSessionId) return;
    send({ type: "session:send-message", sessionId: viewingSessionId, message: msg });
    // Show queued status but keep input until confirmed via session output
    sessionMessageInput.value = "";
    sessionMessageInput.placeholder = "Message queued — waiting for agent…";
    setTimeout(() => { sessionMessageInput.placeholder = "Send message to agent…"; }, 3000);
  }

  btnSendSession.addEventListener("click", sendSessionMessage);
  sessionMessageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendSessionMessage();
  });

  btnStopSession.addEventListener("click", () => {
    if (!viewingSessionId) return;
    if (!confirm("Stop this ACP session? The agent will finish its current action.")) return;
    send({ type: "session:stop", sessionId: viewingSessionId });
  });

  function handleSessionStatus(payload) {
    if (!payload || payload.sessionId !== viewingSessionId) return;
    if (payload.action === "message-queued") {
      // Show visual feedback that message was queued
      const status = document.createElement("div");
      status.className = "session-status-msg";
      status.textContent = `📨 Message queued: "${payload.message}"`;
      sessionOutput.parentNode.insertBefore(status, sessionOutput.nextSibling);
      setTimeout(() => status.remove(), 3000);
    } else if (payload.action === "stop-requested") {
      const status = document.createElement("div");
      status.className = "session-status-msg session-status-warn";
      status.textContent = "⏹ Stop signal sent — session will end after current action";
      sessionOutput.parentNode.insertBefore(status, sessionOutput.nextSibling);
    } else if (payload.action === "error") {
      const status = document.createElement("div");
      status.className = "session-status-msg session-status-err";
      status.textContent = `❌ ${payload.error}`;
      sessionOutput.parentNode.insertBefore(status, sessionOutput.nextSibling);
      setTimeout(() => status.remove(), 5000);
    }
  }

  // Refresh session list every 5 seconds for elapsed times
  setInterval(() => {
    if (!viewingSessionId) {
      renderSessionList();
    }
  }, 5000);

  connect();
  requestNotificationPermission();
  loadRepoInfo();
})();
