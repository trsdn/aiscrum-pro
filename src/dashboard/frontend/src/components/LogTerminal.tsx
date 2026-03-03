import { useEffect, useRef, useState, useCallback } from "react";
import { useDashboardStore } from "../store";
import "./LogTerminal.css";

type LogLevel = "all" | "error" | "warn" | "info";
type LogMode = "live" | "files";

interface FileLogEntry {
  time: string;
  level: string;
  message: string;
  [key: string]: unknown;
}

interface LogFileInfo {
  name: string;
  size: number;
  modified: string;
}

export function LogTerminal() {
  const logs = useDashboardStore((s) => s.logs);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<LogLevel>("all");
  const [mode, setMode] = useState<LogMode>("files");

  // File-based log state
  const [logFiles, setLogFiles] = useState<LogFileInfo[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>("");
  const [fileEntries, setFileEntries] = useState<FileLogEntry[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);

  // Stable refs to avoid dependency loops in intervals
  const selectedFileRef = useRef(selectedFile);
  selectedFileRef.current = selectedFile;

  // Fetch available log files
  const fetchLogFiles = useCallback(async () => {
    try {
      const resp = await fetch("/api/logs");
      if (!resp.ok) return;
      const data = await resp.json();
      setLogFiles(data.files ?? []);
      // Auto-select today's file if none selected
      if (!selectedFileRef.current && data.files?.length > 0) {
        setSelectedFile(data.files[0].name);
      }
    } catch { /* network error */ }
  }, []);

  // Fetch entries for selected log file
  const fetchLogEntries = useCallback(async () => {
    const file = selectedFileRef.current;
    if (!file) return;
    setLoadingFiles(true);
    try {
      const resp = await fetch(`/api/logs?file=${encodeURIComponent(file)}&tail=500`);
      if (!resp.ok) return;
      const data = await resp.json();
      setFileEntries(data.entries ?? []);
    } catch { /* network error */ }
    setLoadingFiles(false);
  }, []);

  // Load files list on mount
  useEffect(() => { fetchLogFiles(); }, [fetchLogFiles]);

  // Load entries when file changes
  useEffect(() => { if (selectedFile) fetchLogEntries(); }, [selectedFile, fetchLogEntries]);

  // Auto-refresh: poll for new entries every 5s when viewing today's file
  useEffect(() => {
    if (mode !== "files" || !selectedFile) return;
    const today = new Date().toISOString().slice(0, 10) + ".log";
    if (selectedFile !== today) return;
    const timer = setInterval(() => { fetchLogEntries(); fetchLogFiles(); }, 5000);
    return () => clearInterval(timer);
  }, [mode, selectedFile, fetchLogEntries, fetchLogFiles]);

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs, filter, fileEntries, mode]);

  // Filter logic
  const liveErrorCount = logs.filter((l) => l.level === "error").length;
  const liveWarnCount = logs.filter((l) => l.level === "warn").length;
  const filteredLive = filter === "all" ? logs : logs.filter((l) => l.level === filter);

  const fileErrorCount = fileEntries.filter((e) => e.level === "error").length;
  const fileWarnCount = fileEntries.filter((e) => e.level === "warn").length;
  const filteredFile = filter === "all" ? fileEntries : fileEntries.filter((e) => e.level === filter);

  const errorCount = mode === "live" ? liveErrorCount : fileErrorCount;
  const warnCount = mode === "live" ? liveWarnCount : fileWarnCount;
  const totalCount = mode === "live" ? logs.length : fileEntries.length;

  return (
    <div className="log-terminal">
      <div className="log-terminal-header">
        <div className="log-terminal-left">
          <span className="log-terminal-title">⬤ Logs</span>
          <div className="log-mode-toggle">
            <button className={`log-mode-btn ${mode === "files" ? "active" : ""}`} onClick={() => setMode("files")}>
              📁 Error Log
            </button>
            <button className={`log-mode-btn ${mode === "live" ? "active" : ""}`} onClick={() => setMode("live")}>
              ⚡ Live
            </button>
          </div>
          {mode === "files" && logFiles.length > 0 && (
            <select
              className="log-file-select"
              value={selectedFile}
              onChange={(e) => setSelectedFile(e.target.value)}
            >
              {logFiles.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name.replace(".log", "")} ({(f.size / 1024).toFixed(1)} KB)
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="log-terminal-filters">
          <button className={`log-filter-btn ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>
            All ({totalCount})
          </button>
          <button className={`log-filter-btn log-filter-error ${filter === "error" ? "active" : ""}`} onClick={() => setFilter("error")}>
            {errorCount > 0 && <span className="log-error-badge">{errorCount}</span>}
            Errors
          </button>
          <button className={`log-filter-btn log-filter-warn ${filter === "warn" ? "active" : ""}`} onClick={() => setFilter("warn")}>
            {warnCount > 0 && <span className="log-warn-badge">{warnCount}</span>}
            Warnings
          </button>
          {mode === "files" && (
            <button className="log-filter-btn" onClick={fetchLogEntries} title="Refresh">
              🔄
            </button>
          )}
        </div>
      </div>
      <div className="log-terminal-body">
        {mode === "live" ? (
          <>
            {filteredLive.length === 0 && (
              <div className="log-terminal-empty">
                {filter === "all" ? "Waiting for log output..." : `No ${filter} entries`}
              </div>
            )}
            {filteredLive.map((l, i) => (
              <div key={i} className={`log-line log-${l.level}`}>
                <span className="log-ts">
                  {l.time?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) ?? "--:--:--"}
                </span>
                <span className={`log-level log-level-${l.level}`}>{l.level.toUpperCase()}</span>
                <span className="log-text">{l.message}</span>
              </div>
            ))}
          </>
        ) : (
          <>
            {loadingFiles && fileEntries.length === 0 && (
              <div className="log-terminal-empty">Loading log file...</div>
            )}
            {!loadingFiles && filteredFile.length === 0 && logFiles.length === 0 && (
              <div className="log-terminal-empty">No log files found. Logs are created when errors or warnings occur during sprint execution.</div>
            )}
            {!loadingFiles && filteredFile.length === 0 && logFiles.length > 0 && (
              <div className="log-terminal-empty">
                {filter === "all" ? "Log file is empty" : `No ${filter} entries in this file`}
              </div>
            )}
            {filteredFile.map((entry, i) => (
              <div key={i} className={`log-line log-${entry.level}`}>
                <span className="log-ts">
                  {entry.time ? new Date(entry.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--:--:--"}
                </span>
                <span className={`log-level log-level-${entry.level}`}>{(entry.level ?? "info").toUpperCase()}</span>
                <span className="log-text">
                  {entry.message}
                  {Object.keys(entry).filter((k) => !["time", "level", "message"].includes(k)).length > 0 && (
                    <span className="log-context">
                      {" "}
                      {JSON.stringify(
                        Object.fromEntries(Object.entries(entry).filter(([k]) => !["time", "level", "message"].includes(k))),
                      )}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
